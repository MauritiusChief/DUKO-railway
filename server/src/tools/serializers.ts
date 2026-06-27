/**
 * 搜索结果序列化工具 —— 被 search-shape / search-description / search-overlap / search-structured 等新搜索工具共用。
 *
 * 从旧 tools/search.ts 中提取，供新工具模块 import。
 */

import type { SkuRecord } from '../types/sku.js';
import { resolveSubItems } from '../services/retriever.js';

export function serializeRecord(item: SkuRecord) {
  return {
    itemName: item.itemName,
    colorCode: item.colorCode,
    shapeTypeCode: item.shapeTypeCode,
    shapeTypeAlias: item.shapeTypeAlias,
    shapeSizeCode: item.shapeSizeCode,
    shapeSizeAlias: item.shapeSizeAlias,
    subItemsName: item.subItemsName,
    mainDescription: item.mainDescription,
    mainAlias: item.mainAlias,
    sizeDescription: item.sizeDescription,
    otherDescription: item.otherDescription,
  };
}

export function serializeResult(
  r: ReturnType<typeof resolveSubItems>[number],
) {
  return {
    item: serializeRecord(r.item),
    vectorDist: r.vectorDist,
    editDist: r.editDist,
    combined: r.combined,
    subItems: r.subItems.map((s) => serializeRecord(s)),
  };
}
