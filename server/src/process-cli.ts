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

/** 根据 dataDir 计算所有输入/输出路径 */
function resolvePaths(dataDir: string) {
  return {
    raw: path.join(dataDir, 'Product-raw.csv'),
    clean: path.join(dataDir, 'Product.csv'),
    color: path.join(dataDir, 'Color.csv'),
    parts: path.join(dataDir, 'Parts.csv'),
    items: path.join(dataDir, 'Items.csv'),
    exposedItems: path.join(dataDir, 'Exposed-Items.csv'),
    exposedColor: path.join(dataDir, 'Exposed-Color.csv'),
    exposedTypes: path.join(dataDir, 'Exposed-Types.csv'),
  };
}

// ============================================================
// 步骤函数（均接受明确路径参数）
// ============================================================

/** 步骤 1：清洗 Product-raw.csv → Product.csv */
function runClean(rawPath: string, cleanPath: string): void {
  const { count } = cleanCSV(rawPath, cleanPath);
  console.log(`[警告] Product 数据可能不是最新! ${count} 行`);
}

/** 步骤 2：从 Product.csv 生成 Color.csv */
function runColor(cleanPath: string, colorPath: string): void {
  const { count } = deriveColorTable(cleanPath, colorPath);
  console.log(`[警告] Color 数据可能不是最新! ${count} 行`);
}

/** 步骤 3：从 Product.csv 生成 Parts.csv */
function runParts(cleanPath: string, partsPath: string): void {
  const { count } = deriveSinglePartTable(cleanPath, partsPath);
  console.log(`[警告] Parts 数据可能不是最新! ${count} 行`);
}

/** 步骤 4：从 Parts.csv 生成 Items.csv */
function runItems(partsPath: string, itemsPath: string): void {
  const { count } = generateItemsTable(partsPath, itemsPath);
  console.log(`[警告] Items 数据可能不是最新! ${count} 行`);
}

/** 步骤 5：从 Items.csv + Parts.csv 生成 Exposed-Items.csv，同时从 Color.csv 生成 Exposed-Color/Exposed-Types.csv */
function runExposed(
  itemsPath: string,
  partsPath: string,
  exposedItemsPath: string,
  colorPath: string,
  exposedColorPath: string,
  exposedTypesPath: string,
): void {
  const { count } = generateExposedItemsTable(itemsPath, partsPath, exposedItemsPath);
  console.log(`[警告] DUKO Exported Items 数据可能不是最新! ${count} 行`);

  const { count: colorCount } = generateExposedColorTable(colorPath, exposedColorPath);
  console.log(`[警告] DUKO Exported Color 数据可能不是最新! ${colorCount} 行`);

  const { count: typesCount } = generateExposedTypesTable(itemsPath, partsPath, exposedTypesPath);
  console.log(`[警告] DUKO Exported Types 数据可能不是最新! ${typesCount} 行`);
}

// ============================================================
// 对外导出 —— 供 server/index.ts 在 AUTO_PROCESS 时调用
// ============================================================

/** 按序执行全部处理步骤（clean → color → parts → items → exposed） */
export function runAllSteps(dataDir: string): void {
  const p = resolvePaths(dataDir);
  runClean(p.raw, p.clean);
  runColor(p.clean, p.color);
  runParts(p.clean, p.parts);
  runItems(p.parts, p.items);
  runExposed(p.items, p.parts, p.exposedItems, p.color, p.exposedColor, p.exposedTypes);
}

// ============================================================
// CLI 入口 —— 仅在直接运行此文件时执行
// ============================================================
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dir = path.resolve(process.env.DB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data'));
  const p = resolvePaths(dir);
  const step = (process.argv[2] || 'all').toLowerCase();

  const validSteps = ['all', 'clean', 'color', 'parts', 'items', 'exposed'];
  if (!validSteps.includes(step)) {
    console.error(`未知步骤: ${step}`);
    console.error(`用法: npm run db:process [clean|color|parts|items|exposed]  (默认 all)`);
    process.exit(1);
  }

  try {
    if (step === 'clean' || step === 'all') runClean(p.raw, p.clean);
    if (step === 'color' || step === 'all') runColor(p.clean, p.color);
    if (step === 'parts' || step === 'all') runParts(p.clean, p.parts);
    if (step === 'items' || step === 'all') runItems(p.parts, p.items);
    if (step === 'exposed' || step === 'all') runExposed(p.items, p.parts, p.exposedItems, p.color, p.exposedColor, p.exposedTypes);
  } catch (err) {
    console.error('数据处理失败:', err);
    process.exit(1);
  }
}
