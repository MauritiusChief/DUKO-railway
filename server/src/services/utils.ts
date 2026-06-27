/**
 * SKU 数据加载工具模块
 *
 * 供 chat 路由和 table-parse 路由共用。
 * 包含：
 *  - getColorEntries  —— 加载 Exposed-Color 颜色代码对照表（SQLite）
 *  - getColorTable     —— 加载 Exposed-Color 转为 Markdown 表格（系统提示词用）
 *  - getShapeTypeTable —— 加载 Exposed-Types 转为 Markdown 表格（系统提示词用）
 */

import {
  getAllColorEntries,
  getAllShapeTypeEntries,
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
