/**
 * SKU 数据加载工具模块
 *
 * 供 chat 路由和 table-parse 路由共用。
 * 包含：
 *  - getColorEntries  —— 加载 Exposed-Color 颜色代码对照表（SQLite）
 *  - getColorTable     —— 加载 Exposed-Color 转为 Markdown 表格（系统提示词用）
 *  - getShapeTypeEntries —— 加载 Exposed-Types 结构化列表（SQLite）
 *  - getShapeTypeTable —— Exposed-Types 转 Markdown 表格（系统提示词用）
 *  - buildLayoutCategoryShapeTable —— 已分类 shapeType 的三列表（code/描述/分类）
 */

import {
  getAllColorEntries,
  getAllShapeTypeEntries,
} from '../db/sku.js';
import type { ColorEntry, ShapeTypeEntry } from '../db/sku.js';
import { LAYOUT_CATEGORY_BY_SHAPE_TYPE } from '../constants.js';

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

let shapeTypeEntriesCache: ShapeTypeEntry[] | null = null;

/** 从 SQLite exposed_types 表读取形状代码结构化列表（带缓存） */
export function getShapeTypeEntries(): ShapeTypeEntry[] {
  if (shapeTypeEntriesCache) return shapeTypeEntriesCache;
  try {
    shapeTypeEntriesCache = getAllShapeTypeEntries();
    return shapeTypeEntriesCache;
  } catch (err) {
    console.error('getShapeTypeEntries error:', err);
    return [];
  }
}

/** 从 SQLite exposed_types 表读取形状代码对照表并格式化为 Markdown 表格 */
export function getShapeTypeTable(): string {
  const entries = getShapeTypeEntries();
  return entries.map((e) => `| ${e.code} | ${e.description} |`).join('\n');
}

// ---- Layout 分类形状代码对照表（系统提示词用） ----

/**
 * 构建已分类 shapeType 的三列 Markdown 表格（仅含映射到 layout 分类的 code）。
 * 列：| shapeTypeCode | 描述 | 分类 |
 * 行按分类分组（顺序与 LAYOUT_CATEGORY_BY_SHAPE_TYPE 声明一致）。
 * 描述来自 exposed_types 表，分类来自 constants 的 LAYOUT_CATEGORY_BY_SHAPE_TYPE。
 */
export function buildLayoutCategoryShapeTable(): string {
  const entries = getShapeTypeEntries();
  // code(大写) -> description
  const descByCode = new Map<string, string>(
    entries.map((e) => [e.code.toUpperCase(), e.description]),
  );

  const rows: string[] = [];
  for (const [category, codes] of Object.entries(LAYOUT_CATEGORY_BY_SHAPE_TYPE)) {
    for (const code of codes) {
      const desc = descByCode.get(code.toUpperCase()) ?? '';
      rows.push(`| ${code} | ${desc} | ${category} |`);
    }
  }
  return rows.join('\n');
}
