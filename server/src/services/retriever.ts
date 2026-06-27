/**
 * 子产品解析器 —— resolveSubItems
 *
 * 解析 subItemsName 字段（逗号分隔的 itemName 列表），
 * 在 SQLite 中按 itemName 批量精确匹配。
 */

import { getRecordsByItemNames } from '../db/sku.js';
import type { SkuRecord } from '../types/sku.js';

/**
 * 递归解析 subItems：解析 subItemsName 字段（逗号分隔的 itemName 列表），
 * 在 SQLite 中按 itemName 批量精确匹配，挂载到结果的 subItems 字段。
 *
 * 递归深度限制为 1：只解析直接子项，不解析子项的子项。
 *
 * @param records - 待解析的检索结果
 * @returns 挂载了 subItems 的检索结果（在原对象上原地追加）
 */
export function resolveSubItems(
  records: Array<{ item: SkuRecord; vectorDist?: number; editDist?: number; combined?: number }>,
): Array<{ item: SkuRecord; vectorDist?: number; editDist?: number; combined?: number; subItems: SkuRecord[] }> {
  // 收集所有需要解析的 subItem 名称
  const allNames = new Set<string>();
  for (const rec of records) {
    const raw = rec.item.subItemsName;
    if (raw && raw.trim()) {
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of names) {
        allNames.add(name);
      }
    }
  }

  // 批量从 SQLite 查询
  const itemMap = allNames.size > 0 ? getRecordsByItemNames([...allNames]) : new Map<string, SkuRecord>();

  return records.map((rec) => {
    const subItems: SkuRecord[] = [];
    const raw = rec.item.subItemsName;
    if (raw && raw.trim()) {
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of names) {
        const found = itemMap.get(name);
        if (found) {
          subItems.push(found);
        }
      }
    }
    return { ...rec, subItems };
  });
}
