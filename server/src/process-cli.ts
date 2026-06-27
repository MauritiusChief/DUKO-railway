/**
 * CLI 数据处理工具 —— 清洗 + 衍生表格生成
 *
 * 用法：
 *   cd server
 *   npm run db:process              # 默认执行全部 (clean + color + parts + items + exposed)
 *   npm run db:process -- clean     # 仅清洗
 *   npm run db:process -- color     # 仅生成颜色表
 *   npm run db:process -- parts     # 仅生成单一零件表
 *   npm run db:process -- items     # 仅生成物品表
 *   npm run db:process -- exposed   # 仅生成暴露物品表
 *
 * 数据流：
 *   Product-raw.csv ──清洗──▶ Product.csv ──衍生──▶ Color.csv
 *                                                ─▶ Parts.csv
 *                                                ─▶ Items.csv
 *   Items.csv ─┐
 *              ├─▶ Exposed-Items.csv（面向下游文案）
 *   Parts.csv ─┘
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { cleanCSV } from './services/sku-clean.js';
import { deriveColorTable, deriveSinglePartTable } from './services/sku-derive.js';
import { generateItemsTable } from './services/sku-items.js';
import { generateExposedItemsTable, generateExposedColorTable, generateExposedTypesTable } from './services/sku-exposed.js';

// ============================================================
// ESM 路径解析 —— 确保无论 CLI 运行还是被 import 路径都正确
// ============================================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, 'data');

const PATH_RAW = path.join(dataDir, 'Product-raw.csv');
const PATH_CLEAN = path.join(dataDir, 'Product.csv');
const PATH_COLOR = path.join(dataDir, 'Color.csv');
const PATH_PARTS = path.join(dataDir, 'Parts.csv');
const PATH_ITEMS = path.join(dataDir, 'Items.csv');
const PATH_EXPOSED_ITEMS = path.join(dataDir, 'Exposed-Items.csv');
const PATH_EXPOSED_COLOR = path.join(dataDir, 'Exposed-Color.csv');
const PATH_EXPOSED_TYPES = path.join(dataDir, 'Exposed-Types.csv');

// ============================================================
// 步骤函数
// ============================================================

/** 步骤 1：清洗 Product-raw.csv → Product.csv */
function runClean(): void {
  const { count } = cleanCSV(PATH_RAW, PATH_CLEAN);
  console.log(`[警告] Product 数据可能不是最新! ${count} 行`);
}

/** 步骤 2：从 Product.csv 生成 Color.csv */
function runColor(): void {
  const { count } = deriveColorTable(PATH_CLEAN, PATH_COLOR);
  console.log(`[警告] Color 数据可能不是最新! ${count} 行`);
}

/** 步骤 3：从 Product.csv 生成 Parts.csv */
function runParts(): void {
  const { count } = deriveSinglePartTable(PATH_CLEAN, PATH_PARTS);
  console.log(`[警告] Parts 数据可能不是最新! ${count} 行`);
}

/** 步骤 4：从 Parts.csv 生成 Items.csv */
function runItems(): void {
  const { count } = generateItemsTable(PATH_PARTS, PATH_ITEMS);
  console.log(`[警告] Items 数据可能不是最新! ${count} 行`);
}

/** 步骤 5：从 Items.csv + Parts.csv 生成 Exposed-Items.csv，同时从 Color.csv 生成 Exposed-Color.csv */
function runExposed(): void {
  const { count } = generateExposedItemsTable(PATH_ITEMS, PATH_PARTS, PATH_EXPOSED_ITEMS);
  console.log(`[警告] DUKO Exported Items 数据可能不是最新! ${count} 行`);

  const { count: colorCount } = generateExposedColorTable(PATH_COLOR, PATH_EXPOSED_COLOR);
  console.log(`[警告] DUKO Exported Color 数据可能不是最新! ${colorCount} 行`);

  const { count: typesCount } = generateExposedTypesTable(PATH_ITEMS, PATH_PARTS, PATH_EXPOSED_TYPES);
  console.log(`[警告] DUKO Exported Types 数据可能不是最新! ${typesCount} 行`);
}

// ============================================================
// 对外导出 —— 供 server/index.ts 在 AUTO_PROCESS 时调用
// ============================================================

/** 按序执行全部处理步骤（clean → color → parts → items → exposed） */
export function runAllSteps(): void {
  runClean();
  runColor();
  runParts();
  runItems();
  runExposed();
}

// ============================================================
// CLI 入口 —— 仅在直接运行此文件时执行
// ============================================================
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const step = (process.argv[2] || 'all').toLowerCase();

  const validSteps = ['all', 'clean', 'color', 'parts', 'items', 'exposed'];
  if (!validSteps.includes(step)) {
    console.error(`未知步骤: ${step}`);
    console.error(`用法: npm run db:process [clean|color|parts|items|exposed]  (默认 all)`);
    process.exit(1);
  }

  try {
    if (step === 'clean' || step === 'all') runClean();
    if (step === 'color' || step === 'all') runColor();
    if (step === 'parts' || step === 'all') runParts();
    if (step === 'items' || step === 'all') runItems();
    if (step === 'exposed' || step === 'all') runExposed();
  } catch (err) {
    console.error('数据处理失败:', err);
    process.exit(1);
  }
}
