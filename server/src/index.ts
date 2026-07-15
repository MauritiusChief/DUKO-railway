/**
 * 应用入口 —— Express 服务器启动
 *
 * 架构：单端口服务
 *  - /api/*  → 后端 API 路由（JSON 响应）
 *  - /*      → 前端静态文件（Vite 构建产出 client/dist/）
 *
 * 启动时自动初始化数据库：
 *  - SQLite（users.sqlite）：用户账号
 *  - SQLite（sku.sqlite）：Exposed-Items 结构化字段（CRUD / 过滤查询）
 *  - LanceDB（sku.lance/）：384 维向量语义嵌入搜索
 *
 * 生产模式下只需暴露 3001 端口，前端由后端 serve。
 */

import 'dotenv/config'; // 从 .env 加载环境变量（DEEPSEEK_API_KEY, PORT）
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { chatRouter } from './routes/chat.js';
import { tableParseRouter, tableParseLlmRouter } from './routes/tableParse.js';
import { imageParseRouter } from './routes/imageParse.js';
import { layoutParseImageRouter } from './routes/layoutParseImage.js';
import { debugRouter } from './routes/debug.js';
import { authRouter, meHandler } from './routes/auth.js';
import { historyRouter, adminHistoryRouter } from './routes/history.js';
import { notesRouter } from './routes/notes.js';
import { layoutGenerateListRouter } from './routes/layoutGenerateList.js';
import { traceRouter } from './routes/trace.js';
import { quotationRouter } from './routes/quotation.js';
import { inventoryRouter } from './routes/inventory.js';
import { authenticateToken } from './middleware/auth.js';
import { apiLimiter, llmLimiter } from './middleware/rateLimit.js';
import { config, validateSecrets } from './config/env.js';
import { initDB } from './db/lance.js';
import { initSkuDB, getRecordCount } from './db/sku.js';
import { initUserDB, seedAdminUser, getUserDb } from './db/users.js';
import { initQuotationDB } from './db/quotation.js';
import { initTraceDB, cleanupOldTraces } from './services/trace.js';
import { ingestFromFile, loadAllReferenceData } from './services/sku-ingest.js';
import { initBm25Index } from './services/bm25.js';
import { runAllSteps } from './process-cli.js';
import { initWebSocketServer } from './services/ws-handler.js';

// ESM 模式下自行推导 __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.port || 3001;

// 信任首个反向代理，使 req.ip 正确反映客户端 IP（配合 rate-limit 使用）
// 因为 Railway 会在此应用前运行一个边缘代理
app.set('trust proxy', 1);

// ---- 全局中间件 ----
app.use(cors());          // 允许跨域（开发时前端 :5273 请求后端 :3022
app.use(express.json({ limit: '20mb' }));  // 自动解析请求体中的 JSON

// 安全响应头（CSP、HSTS、X-Frame-Options 等）
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
    // useDefaults: false,  // ← 同 wifi 网络下测试时，阻止 Helmet 合并默认值（含 upgrade-insecure-requests）
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  frameguard: { action: 'deny' },
}));

// ---- API 路由 ----

// 认证路由：不施加 authenticateToken（自身有独立限流与校验）
app.use('/api/auth', authRouter);

// 当前用户查询：已受 authenticateToken 保护，使用较为宽松的 apiLimiter
app.get('/api/me', apiLimiter, authenticateToken, meHandler);

// ---- LLM 路由（全路径 + llmLimiter，先注册避免被后续 /api 前缀的 apiLimiter 捕获）----
app.use('/api/chat', llmLimiter, authenticateToken, chatRouter);                          // POST /api/chat
app.use('/api/table-parse', llmLimiter, authenticateToken, tableParseLlmRouter);           // POST /api/table-parse
app.use('/api/image-parse', llmLimiter, authenticateToken, imageParseRouter);              // POST /api/image-parse
app.use('/api/layout/parse-image', llmLimiter, authenticateToken, layoutParseImageRouter); // POST /api/layout/parse-image

// ---- Trace 路由（管理员只读，使用 apiLimiter）----
app.use('/api/trace', apiLimiter, authenticateToken, traceRouter);                          // GET /api/trace[/:conversationId]

// ---- 管理员历史路由（管理员只读浏览所有用户历史）----
app.use('/api/admin', apiLimiter, authenticateToken, adminHistoryRouter);                    // GET /api/admin/history[/:id]

// ---- ScriptCat 脚本下载端点（无需登录）----
// 供前端小按钮下载，文件名带构建时间戳以便用户确认是否为最新版本
app.get('/api/script/download', apiLimiter, (_req, res) => {
  const scriptPath = path.resolve(__dirname, '../public/script/duko-filler.user.js');

  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: '脚本尚未构建，请先运行 npm run build（在 script/ 目录）' });
    return;
  }

  // 从 build-meta.json 读取构建时间戳（由 rspack 构建时写入）
  let ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const metaPath = path.resolve(__dirname, '../public/script/build-meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      ts = meta.buildTs || ts;
    } catch {}
  }
  const downloadName = `duko-filler-${ts}.user.js`;

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.sendFile(scriptPath);
});

// ---- 非 LLM 路由（/api 前缀 + apiLimiter）----
app.use('/api', apiLimiter, authenticateToken);

app.use('/api', tableParseRouter);    // GET /api/colors / POST /api/check-exposed / POST /api/generate-products
app.use('/api', debugRouter);         // POST /api/debug/tool —— 工具测试接口（debug 用）
app.use('/api', historyRouter);       // GET/POST/DELETE /api/history[/:id] —— 历史记录
app.use('/api', notesRouter);         // GET/POST /api/notes —— 用户笔记
app.use('/api', layoutGenerateListRouter); // POST /api/layout/generate-list —— 物料清单
app.use('/api', quotationRouter);     // GET/POST /api/quotation-tasks[/:id[/cancel|/events]] —— 报价任务
app.use('/api', inventoryRouter);     // POST /api/inventory/jobs|/upload, GET /api/inventory/jobs/:id[/events|/cancel] —— 库存看板

// ---- 前端静态文件（生产模式） ----
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// SPA fallback：所有非 API 请求返回 index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
  return;
});

// ---- 启动流程 ----
(async () => {
  // 最先校验 JWT 密钥，不满足则阻止启动
  validateSecrets();

  // 初始化用户数据库并播种管理员账号
  const dbDir = config.dbDir;
  initUserDB(dbDir);
  initTraceDB(getUserDb());
  initQuotationDB(getUserDb());
  cleanupOldTraces();
  const adminHash = bcrypt.hashSync(config.adminPassword, 12);
  seedAdminUser(config.adminUsername, adminHash);
  console.log(`用户数据库已就绪 (管理员: ${config.adminUsername})`);

  // 初始化 Exposed-Items SQLite 数据库
  initSkuDB(dbDir);

  // 初始化 LanceDB 连接/建表（向量索引）
  await initDB(dbDir);

  // AUTO_PROCESS：dev 模式下自动执行清洗数据库 → 生成 exposed 表
  if (process.env.AUTO_PROCESS === 'true') {
    runAllSteps(dbDir);
  }

  if (process.env.AUTO_INGEST === 'true') {
    // AUTO_INGEST=true：SQLite 为空时自动导入 CSV 到 SQLite + LanceDB + 引用表
    if (getRecordCount() === 0) {
      const csvPath = path.join(dbDir, 'Exposed-Items.csv');
      try {
        console.log(`自动解析 odoo 数据: ${csvPath}`);
        console.warn('[警告] 数据库连接失败！请检查 odoo 数据连接');
        const start = performance.now();
        const result = await ingestFromFile(csvPath);
        const end = performance.now();
        console.warn(`[警告] 执行耗时 ${((end - start) / 1000).toFixed(2)} 秒，请确保 odoo 数据链接通畅`);
        console.log(`已录入 ${result.count} 项.`);
        loadAllReferenceData(dbDir);
      } catch (err) {
        console.warn('自动解析失败, odoo 数据库为空！', err);
      }
    } else {
      console.log(`${getRecordCount()} 项数据已存入数据库.`);
    }
  }

  // 预热 BM25 描述文本索引（从 SQLite 读取全量数据）
  initBm25Index();
  console.log('BM25 描述文本索引已就绪.');

  // 启动 HTTP 监听
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器正在监听 ${PORT} 端口`);
  });

  // 在 HTTP server 上挂载 WebSocket（auto worker 连接）
  initWebSocketServer(httpServer, '/api/auto/connect');
})();
