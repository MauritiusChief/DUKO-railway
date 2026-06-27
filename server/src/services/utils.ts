/**
 * SKU 数据加载工具模块
 *
 * 供 chat 路由和 table-parse 路由共用。
 * 包含：
 *  - getColorEntries  —— 加载 Exposed-Color 颜色代码对照表（SQLite）
 *  - getColorTable     —— 加载 Exposed-Color 转为 Markdown 表格（系统提示词用）
 *  - getShapeTypeTable —— 加载 Exposed-Types 转为 Markdown 表格（系统提示词用）
 *  - getItemsMap       —— 加载 Items 产品映射（SQLite）
 *  - getPartsMap       —— 加载 Parts 部件映射（SQLite）
 *  - getProductMap     —— 加载 Product 库存映射（SQLite）
 */

import {
  getAllColorEntries,
  getAllShapeTypeEntries,
  getAllItemRows,
  getAllPartRows,
  getAllProductRows,
} from '../db/sku.js';
import type { ColorEntry } from '../db/sku.js';

// ---- 颜色对照表加载（系统提示词用） ----

let colorEntriesCache: ColorEntry[] | null = null;

/** 从 SQLite exposed_colors 表读取颜色代码列表（带缓存） */
export function getColorEntries(): ColorEntry[] {
  if (colorEntriesCache) return colorEntriesCache;
  try {
    colorEntriesCache = getAllColorEntries();
    return colorEntriesCache;
  } catch (err) {
    console.error('getColorEntries error:', err);
    return [];
  }
}

/** 从 SQLite exposed_colors 表读取颜色代码对照表并格式化为 Markdown 表格 */
export function getColorTable(): string {
  const entries = getColorEntries();
  if (entries.length === 0) throw new Error('Exposed-Color 对照表为空');
  return entries.map((e) => `| ${e.code} | ${e.name} |`).join('\n');
}

// ---- 形状代码对照表加载（系统提示词用） ----

let shapeTypeTableCache: string | null = null;

/** 从 SQLite exposed_types 表读取形状代码对照表并格式化为 Markdown 表格 */
export function getShapeTypeTable(): string {
  if (shapeTypeTableCache) return shapeTypeTableCache;
  try {
    const entries = getAllShapeTypeEntries();
    const rows = entries.map((e) => `| ${e.code} | ${e.description} |`);
    shapeTypeTableCache = rows.join('\n');
    return shapeTypeTableCache;
  } catch (err) {
    console.error('getShapeTypeTable error:', err);
    return '';
  }
}

// ---- Items 懒加载缓存（itemName → shapeTypeCode / doorPart / cabinetPart / extraPart） ----

interface ItemRow {
  shapeTypeCode: string;
  doorPart: string;
  cabinetPart: string;
  extraPart: string;
}

let itemsMapCache: Map<string, ItemRow> | null = null;

/**
 * 从 SQLite items 表读取全量数据，构建 itemName → { shapeTypeCode, doorPart, cabinetPart, extraPart } 映射。
 * 用于产品生成时将用户确认的 itemName 解析为 DUKO 部件名。
 * 数据约 3000 行，全部缓存在内存中。
 */
export function getItemsMap(): Map<string, ItemRow> {
  if (itemsMapCache) return itemsMapCache;

  const map = new Map<string, ItemRow>();
  try {
    const rows = getAllItemRows();
    for (const r of rows) {
      map.set(r.itemName, {
        shapeTypeCode: r.shapeTypeCode,
        doorPart: r.doorPart,
        cabinetPart: r.cabinetPart,
        extraPart: r.extraPart,
      });
    }
  } catch (err) {
    console.error('getItemsMap error:', err);
  }

  itemsMapCache = map;
  return map;
}

// ---- Parts 懒加载缓存（singlePartName → sharedPartName / description） ----

interface PartRow {
  sharedPartName: string;
  description: string;
}

let partsMapCache: Map<string, PartRow> | null = null;

/**
 * 从 SQLite parts 表读取全量数据，构建 singlePartName → { sharedPartName, description } 映射。
 * sharedPartName 即为 Product 表中的 Name（原始 DUKO 产品编码）。
 * 数据约 6900 行，全部缓存在内存中。
 */
export function getPartsMap(): Map<string, PartRow> {
  if (partsMapCache) return partsMapCache;

  const map = new Map<string, PartRow>();
  try {
    const rows = getAllPartRows();
    for (const r of rows) {
      map.set(r.singlePartName, {
        sharedPartName: r.sharedPartName,
        description: r.description,
      });
    }
  } catch (err) {
    console.error('getPartsMap error:', err);
  }

  partsMapCache = map;
  return map;
}

// ---- Product 懒加载缓存（Name → Forecasted Quantity / Free to use Quantity / Quantity On Hand） ----

interface ProductRow {
  forecastedQty: number;
  freeToUseQty: number;
  qtyOnHand: number;
}

let productMapCache: Map<string, ProductRow> | null = null;

/**
 * 从 SQLite products 表读取全量数据，构建 Name → { forecastedQty, freeToUseQty, qtyOnHand } 映射。
 * 用于对话工具根据产品名查询库存信息。
 * 数据约 5800 行，全部缓存在内存中。
 */
export function getProductMap(): Map<string, ProductRow> {
  if (productMapCache) return productMapCache;

  const map = new Map<string, ProductRow>();
  try {
    const rows = getAllProductRows();
    for (const r of rows) {
      map.set(r.name, {
        forecastedQty: r.forecastedQty,
        freeToUseQty: r.freeToUseQty,
        qtyOnHand: r.qtyOnHand,
      });
    }
  } catch (err) {
    console.error('getProductMap error:', err);
  }

  productMapCache = map;
  return map;
}
