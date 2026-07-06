/**
 * Exposed-Items 匹配状态检查
 *
 * 比对 ParsedItem 与 SQLite 中的 Exposed-Items 记录，写入 status / colorIgnored / shapeSizeIgnored。
 * colorIgnored 和 shapeSizeIgnored 仅由 shapeType 决定（不依赖 color/size 是否为空）：
 * 只要形状型号在 SHAPE_TYPES_COLOR_NA 中，该行就完全忽略颜色比对；
 * 只要形状型号在 SHAPE_TYPES_SIZE_NA 中，该行就完全忽略尺寸比对。
 *
 * 供 table-parse-agent 和 chat-agent 共享使用。
 */

import { findComboExists } from '../db/sku.js';
import { SHAPE_TYPES_COLOR_NA, SHAPE_TYPES_SIZE_NA } from '../constants.js';
import type { ParsedItem } from '../types/manifest.js';

export function computeExposedStatus(items: ParsedItem[]): void {
  for (const item of items) {
    const shapeTypeCode = item.shapeType.values.length > 0
      ? item.shapeType.values[0].toUpperCase()
      : '';

    // 忽略标记：仅由形状型号决定，与字段是否为空无关
    const colorIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_COLOR_NA.has(shapeTypeCode);
    const sizeIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_SIZE_NA.has(shapeTypeCode);

    item.colorIgnored = colorIgnored || undefined;
    item.shapeSizeIgnored = sizeIgnored || undefined;

    // 形状型号为空 → 无法比对
    if (!shapeTypeCode) {
      item.status = 'missing';
      continue;
    }

    // 提取有效值（trim 后为空字符串等同于缺失，防止用户清空输入框后误判为 found）
    const colorVal = item.color.values.length > 0 ? item.color.values[0].trim() : '';
    const sizeVal = item.shapeSize.values.length > 0 ? item.shapeSize.values[0].trim() : '';

    // 非忽略字段为空 → 不完整，无法比对
    if (!colorIgnored && !colorVal) {
      item.status = 'missing';
      continue;
    }
    if (!sizeIgnored && !sizeVal) {
      item.status = 'missing';
      continue;
    }

    // 使用 SQLite 索引查询（不区分大小写）
    const typeCode = item.shapeType.values[0].toLowerCase();
    const found = findComboExists(
      colorIgnored ? '' : colorVal,
      typeCode,
      sizeIgnored ? '' : sizeVal,
    );
    item.status = found ? 'found' : 'missing';
  }
}
