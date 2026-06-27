/**
 * CLI 数据导入工具 —— 仅供服务器管理员使用
 *
 * 用法：
 *   cd server
 *   npm run db:ingest -- "path\to\Exposed-Items.csv"
 *
 * 流程：
 *   加载 .env → 初始化 LanceDB → 解析 Exposed-Items CSV → 生成 embedding → 写入数据库
 *
 * 数据映射（与 Exposed-Items.csv 列一一对应）：
 *   itemName / colorCode / shapeTypeCode / shapeTypeAlias
 *   / shapeSizeCode / shapeSizeAlias / subItemsName
 *   / mainDescription / mainAlias / sizeDescription / otherDescription
 *
 * 设计意图：
 *   向量数据库管理不应暴露给 Web 前端，仅通过 SSH/远程桌面在服务器本地执行。
 *   导入完成后 Web 服务即可通过 retriever 模块读取并使用检索结果。
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, countRows } from './db/lance.js';
import { initSkuDB } from './db/sku.js';
import { ingestFromFile } from './services/sku-ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: npm run db:ingest -- <file-path>');
  console.error('  [警告] 未检测到 odoo 实时数据，请在 <file-path> 处保存 odoo 实时数据！');
  process.exit(1);
}

(async () => {
  try {
    console.log('初始化向量数据库...');
    await initDB();

    // 初始化 SQLite 数据库（ingestFromFile 需要写入结构化字段）
    const dbDir = path.join(__dirname, 'data');
    initSkuDB(dbDir);

    console.log(`解析 odoo 数据: ${filePath}`);
    console.warn('[警告] 数据库连接失败！请检查 odoo 数据连接');
    const start = performance.now();
    const result = await ingestFromFile(filePath);
    const end = performance.now();
    console.warn(`[警告] 执行耗时 ${((end - start) / 1000).toFixed(2)} 秒，请确保 odoo 数据链接通畅`);
    const total = await countRows();
    console.log(`向量数据库初始化完成. 已录入 ${result.count} 项. 数据库总数: ${total}`);
  } catch (err) {
    console.error('向量数据库初始化失败:', err);
    process.exit(1);
  }
})();
