/**
 * 数据刷新 CLI —— 一次性从 Product-raw.csv 重建全部数据管线
 *
 * 用法：
 *   node dist/refresh-data-cli.js
 *
 * 前置条件：
 *   - DB_DIR 环境变量已设置（默认 server/src/data）
 *   - <DB_DIR>/Product-raw.csv 已存在
 *
 * 执行流程：
 *   1. 校验 DB_DIR 与 Product-raw.csv 存在
 *   2. 执行数据处理（clean → color → parts → items → exposed）
 *   3. 初始化 SQLite（建表）
 *   4. 初始化 LanceDB（向量库连接 / 建表）
 *   5. 导入 Exposed-Items.csv → SQLite + LanceDB（含 embedding 生成）
 *   6. 加载全部引用表到 SQLite
 *   7. 输出处理结果和计数
 *
 * 退出码：成功 0，失败 1
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { config } from './config/env.js';
import { runAllSteps } from './process-cli.js';
import { initDB } from './db/lance.js';
import { initSkuDB, getRecordCount, getColorRecordCount, getTypeRecordCount, getItemRecordCount, getPartRecordCount, getProductRecordCount, setSkuRefreshSuccess } from './db/sku.js';
import { ingestFromFile, loadAllReferenceData } from './services/sku-ingest.js';
import { initBm25Index } from './services/bm25.js';

const dataDir = path.resolve(config.dbDir);

// ==================================================================
// 步骤 1：校验前置条件
// ==================================================================
if (!fs.existsSync(dataDir)) {
  console.error(`数据目录不存在: ${dataDir}`);
  console.error('请确保 DB_DIR 指向正确路径，或已挂载 Railway Volume 到 /data');
  process.exit(1);
}

// 优先使用库存看板自动下载暂存的 Product-raw-YYYY-MM-DD.csv（最终只保留一个）；
// 兼容回退到历史固定名 Product-raw.csv。
const datedRawCandidates = fs.readdirSync(dataDir)
  .filter((f) => /^Product-raw-\d{4}-\d{2}-\d{2}\.csv$/.test(f))
  .sort();

let rawCsvPath: string;
if (datedRawCandidates.length > 0) {
  rawCsvPath = path.join(dataDir, datedRawCandidates[datedRawCandidates.length - 1]);
  if (datedRawCandidates.length > 1) {
    console.warn(`发现多个 Product-raw-*.csv，将使用最新一份: ${rawCsvPath}（建议保留唯一最新文件）`);
  }
} else {
  const legacy = path.join(dataDir, 'Product-raw.csv');
  if (fs.existsSync(legacy)) {
    rawCsvPath = legacy;
  } else {
    console.error(`未在 ${dataDir} 找到 Product-raw-YYYY-MM-DD.csv 或 Product-raw.csv`);
    console.error('请先在库存看板执行一次自动下载查询以暂存最新 CSV，再运行此命令');
    process.exit(1);
  }
}

console.log(`数据目录: ${dataDir}`);
console.log(`原始 CSV: ${rawCsvPath}`);
const fileStats = fs.statSync(rawCsvPath);
console.log(`文件大小: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);

// ==================================================================
// 步骤 2：执行数据处理管线（clean → color → parts → items → exposed）
// ==================================================================
console.log('\n--- 步骤 2: 执行数据处理管线 ---');
try {
  runAllSteps(dataDir);
} catch (err) {
  console.error('数据处理管线失败:', err);
  process.exit(1);
}

// ==================================================================
// 步骤 3：初始化 SQLite（建表）
// ==================================================================
console.log('\n--- 步骤 3: 初始化 SQLite ---');
initSkuDB(dataDir);

// ==================================================================
// 步骤 4：初始化 LanceDB
// ==================================================================
console.log('\n--- 步骤 4: 初始化 LanceDB ---');
try {
  await initDB(dataDir);
} catch (err) {
  console.error('LanceDB 初始化失败:', err);
  process.exit(1);
}

// ==================================================================
// 步骤 5：导入 Exposed-Items.csv → SQLite + LanceDB
// ==================================================================
console.log('\n--- 步骤 5: 导入 Exposed-Items ---');
const exposedItemsPath = path.join(dataDir, 'Exposed-Items.csv');
if (!fs.existsSync(exposedItemsPath)) {
  console.error(`未找到 Exposed-Items.csv: ${exposedItemsPath}`);
  console.error('数据处理管线应已生成此文件，请检查步骤 2 的输出');
  process.exit(1);
}

try {
  const start = performance.now();
  const result = await ingestFromFile(exposedItemsPath);
  const end = performance.now();
  console.log(`已导入 ${result.count} 条记录 (耗时 ${((end - start) / 1000).toFixed(2)} 秒)`);
} catch (err) {
  console.error('数据导入失败:', err);
  process.exit(1);
}

// ==================================================================
// 步骤 6：加载引用数据表
// ==================================================================
console.log('\n--- 步骤 6: 加载引用数据表 ---');
const refCounts = loadAllReferenceData(dataDir);

// ==================================================================
// 步骤 7：初始化 BM25 索引（本进程内预热，Web Service 重启后会自行重建）
// ==================================================================
console.log('\n--- 步骤 7: 初始化 BM25 索引 ---');
initBm25Index();
console.log('BM25 描述文本索引已就绪（当前进程内）. 注意: Web Service 重启后将重新从 SQLite 读取数据并重建 BM25.');

// ==================================================================
// 步骤 8：记录刷新元数据（仅完整成功后写入，供 Chat Agent 提示数据新鲜度）
// ==================================================================
const refreshedAt = new Date().toISOString();
setSkuRefreshSuccess(refreshedAt, 'manual-cli');
console.log(`\n--- 步骤 8: 记录刷新元数据 ---`);
console.log(`最后成功刷新时间: ${refreshedAt} (UTC)`);

// ==================================================================
// 步骤 9：输出汇总
// ==================================================================
console.log('\n========== 数据刷新完成 ==========');
console.log(`数据目录:         ${dataDir}`);
console.log(`Exposed-Items:    ${getRecordCount()} 条`);
console.log(`Exposed-Colors:   ${getColorRecordCount()} 条`);
console.log(`Exposed-Types:    ${getTypeRecordCount()} 条`);
console.log(`Items:            ${getItemRecordCount()} 条`);
console.log(`Parts:            ${getPartRecordCount()} 条`);
console.log(`Products:         ${getProductRecordCount()} 条`);
console.log('===================================');
console.log('请重启 Railway Web Service 以使运行中的进程重新加载最新数据.');
