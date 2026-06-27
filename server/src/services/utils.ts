/**
 * SKU 数据加载工具模块
 *
 * 供 chat 路由和 table-parse 路由共用。
 * 包含：
 *  - getColorEntries  —— 加载 Exposed-Color.csv 颜色代码对照表
 *  - getColorTable     —— 加载 Exposed-Color.csv 转为 Markdown 表格（系统提示词用）
 *  - getItemsMap       —— 加载 Items.csv 产品映射
 *  - getPartsMap       —— 加载 Parts.csv 部件映射
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import Papa from 'papaparse';

// ---- CSV 路径工具 ----

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveDataPath(relativeCsv: string): string {
  return resolve(__dirname, '..', 'data', relativeCsv);
}

// ---- 颜色对照表加载（系统提示词用） ----

export interface ColorEntry {
  code: string;
  name: string;
}

let colorEntriesCache: ColorEntry[] | null = null;

/** 从 Exposed-Color.csv 读取颜色代码列表（带缓存，PapaParse 解析） */
export function getColorEntries(): ColorEntry[] {
  if (colorEntriesCache) return colorEntriesCache;
  try {
    const csvPath = resolveDataPath('Exposed-Color.csv');
    const raw = readFileSync(csvPath, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
    });
    const entries: ColorEntry[] = [];
    for (const row of parsed.data) {
      const code = (row['colorCode'] ?? '').trim();
      const name = (row['colorText'] ?? '').trim();
      if (code && name) entries.push({ code, name });
    }
    colorEntriesCache = entries;
    return entries;
  } catch (err) {
    console.error('getColorEntries error:', err);
    return [];
  }
}

/** 从 Exposed-Color.csv 读取颜色代码对照表并格式化为 Markdown 表格 */
export function getColorTable(): string {
  const entries = getColorEntries();
  if (entries.length === 0) throw new Error('Exposed-Color.csv 内容为空');
  return entries.map((e) => `| ${e.code} | ${e.name} |`).join('\n');
}

// ---- 形状代码对照表加载（系统提示词用） ----

export interface ShapeTypeEntry {
  code: string;
  description: string;
}

let shapeTypeTableCache: string | null = null;

/** 从 Exposed-Types.csv 读取形状代码对照表并格式化为 Markdown 表格 */
export function getShapeTypeTable(): string {
  if (shapeTypeTableCache) return shapeTypeTableCache;
  try {
    const csvPath = resolveDataPath('Exposed-Types.csv');
    const raw = readFileSync(csvPath, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
    });
    const rows: string[] = [];
    for (const row of parsed.data) {
      const code = (row['shapeTypeCode'] ?? '').trim();
      const desc = (row['description'] ?? '').trim();
      if (code && desc) rows.push(`| ${code} | ${desc} |`);
    }
    shapeTypeTableCache = rows.join('\n');
    return shapeTypeTableCache;
  } catch (err) {
    console.error('getShapeTypeTable error:', err);
    return '';
  }
}

// ---- Items.csv 懒加载缓存（itemName → shapeTypeCode / doorPart / cabinetPart / extraPart） ----

interface ItemRow {
  shapeTypeCode: string;
  doorPart: string;
  cabinetPart: string;
  extraPart: string;
}

let itemsMapCache: Map<string, ItemRow> | null = null;

/**
 * 从 Items.csv 读取全量数据，构建 itemName → { shapeTypeCode, doorPart, cabinetPart, extraPart } 映射。
 * 用于产品生成时将用户确认的 itemName 解析为 DUKO 部件名。
 * 数据约 3000 行，全部缓存在内存中。
 */
export function getItemsMap(): Map<string, ItemRow> {
  if (itemsMapCache) return itemsMapCache;

  const map = new Map<string, ItemRow>();
  try {
    const csvPath = resolveDataPath('Items.csv');
    const raw = readFileSync(csvPath, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
    });

    for (const row of parsed.data) {
      const itemName = (row['itemName'] ?? '').trim();
      if (!itemName) continue;
      map.set(itemName, {
        shapeTypeCode: (row['shapeTypeCode'] ?? '').trim(),
        doorPart: (row['doorPart'] ?? '').trim(),
        cabinetPart: (row['cabinetPart'] ?? '').trim(),
        extraPart: (row['extraPart'] ?? '').trim(),
      });
    }
  } catch (err) {
    console.error('getItemsMap error:', err);
  }

  itemsMapCache = map;
  return map;
}

// ---- Parts.csv 懒加载缓存（singlePartName → sharedPartName / description） ----

interface PartRow {
  sharedPartName: string;
  description: string;
}

let partsMapCache: Map<string, PartRow> | null = null;

/**
 * 从 Parts.csv 读取全量数据，构建 singlePartName → { sharedPartName, description } 映射。
 * sharedPartName 即为 Product.csv 中的 NAME（原始 DUKO 产品编码）。
 * 数据约 6900 行，全部缓存在内存中。
 */
export function getPartsMap(): Map<string, PartRow> {
  if (partsMapCache) return partsMapCache;

  const map = new Map<string, PartRow>();
  try {
    const csvPath = resolveDataPath('Parts.csv');
    const raw = readFileSync(csvPath, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
    });

    for (const row of parsed.data) {
      const singlePartName = (row['singlePartName'] ?? '').trim();
      if (!singlePartName) continue;
      map.set(singlePartName, {
        sharedPartName: (row['sharedPartName'] ?? '').trim(),
        description: (row['description'] ?? '').trim(),
      });
    }
  } catch (err) {
    console.error('getPartsMap error:', err);
  }

  partsMapCache = map;
  return map;
}

// ---- Product.csv 懒加载缓存（Name → Forecasted Quantity / Free to use Quantity / Quantity On Hand） ----

export interface ProductRow {
  forecastedQty: number;
  freeToUseQty: number;
  qtyOnHand: number;
}

let productMapCache: Map<string, ProductRow> | null = null;

/**
 * 从 Product.csv 读取全量数据，构建 Name（sharedPartName）→ { forecastedQty, freeToUseQty, qtyOnHand } 映射。
 * 用于对话工具根据产品名查询库存信息。
 * 数据约 5800 行，全部缓存在内存中。
 *
 * Product.csv 对应列：
 *   ⑦ Forecasted Quantity
 *   ⑧ Free to use Quantity
 *   ⑩ Name（= sharedPartName）
 *   ⑪ Quantity On Hand
 */
export function getProductMap(): Map<string, ProductRow> {
  if (productMapCache) return productMapCache;

  const map = new Map<string, ProductRow>();
  try {
    const csvPath = resolveDataPath('Product.csv');
    const raw = readFileSync(csvPath, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
    });

    for (const row of parsed.data) {
      const name = (row['Name'] ?? '').trim();
      if (!name) continue;

      const forecastedQty = parseFloat(row['Forecasted Quantity'] ?? '0') || 0;
      const freeToUseQty = parseFloat(row['Free to use Quantity'] ?? '0') || 0;
      const qtyOnHand = parseFloat(row['Quantity On Hand'] ?? '0') || 0;

      // 若有同名多行（OL 后缀变体），保留先遇到的（标准行在前）
      if (!map.has(name)) {
        map.set(name, { forecastedQty, freeToUseQty, qtyOnHand });
      }
    }
  } catch (err) {
    console.error('getProductMap error:', err);
  }

  productMapCache = map;
  return map;
}
