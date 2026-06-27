/**
 * searchSkuShape 工具 —— 按形状类型/尺寸的编辑距离模糊检索
 *
 * 与旧有的精确匹配逻辑不同，本工具使用 Levenshtein 编辑距离
 * 进行模糊匹配，并对 shapeTypeCode 和 shapeSizeCode 分别计算距离。
 *
 * 排序规则：shapeTypeCode 编辑距离为主键（升序），shapeSizeCode 编辑距离为次键（升序）。
 * 即 typeDist 总是优先于 sizeDist —— typeDist=0 且 sizeDist=5 的记录
 * 排在 typeDist=1 且 sizeDist=0 的记录之前。
 *
 * 供 BatchSearchAgent 与 GlassDoorAgent 使用。
 */

import { markdownTable } from 'markdown-table';
import { distance as levenshtein } from 'fastest-levenshtein';
import type { ToolDefinition } from '../types/tool.js';
import { getAllRecords } from '../db/sku.js';
import type { SkuRecord } from '../types/sku.js';
import { resolveSubItems } from '../services/retriever.js';
import { serializeRecord, serializeResult } from './serializers.js';
import { EUROPEAN_STYLE_CODES, NONE_EURO_STYLE_CODES } from '../constants.js';

type SerializedResult = ReturnType<typeof serializeResult>;

// ==================================================================
//  辅助函数
// ==================================================================

/**
 * 计算输入形状代码与某条记录 shapeTypeCode/shapeTypeAlias 变体的最小编辑距离。
 *
 * 变体集合 = { record.shapeTypeCode } ∪ shapeTypeAlias 逗号拆分后的各段（去空去重）。
 * 返回 query 与所有变体的最小 Levenshtein 距离。
 */
export function shapeTypeEditDistance(query: string, record: SkuRecord): number {
  const q = query.toLowerCase().trim();
  const variants = new Set<string>();
  variants.add(record.shapeTypeCode.toLowerCase().trim());
  if (record.shapeTypeAlias) {
    for (const seg of record.shapeTypeAlias.split(',')) {
      const s = seg.trim().toLowerCase();
      if (s) variants.add(s);
    }
  }
  let min = Infinity;
  for (const v of variants) {
    const d = levenshtein(q, v);
    if (d < min) min = d;
  }
  return min;
}

/**
 * 计算输入尺寸代码与某条记录 shapeSizeCode/shapeSizeAlias 变体的最小编辑距离。
 * 变体逻辑同 shapeTypeEditDistance。
 */
export function shapeSizeEditDistance(query: string, record: SkuRecord): number {
  const q = query.toLowerCase().trim();
  const variants = new Set<string>();
  variants.add(record.shapeSizeCode.toLowerCase().trim());
  if (record.shapeSizeAlias) {
    for (const seg of record.shapeSizeAlias.split(',')) {
      const s = seg.trim().toLowerCase();
      if (s) variants.add(s);
    }
  }
  let min = Infinity;
  for (const v of variants) {
    const d = levenshtein(q, v);
    if (d < min) min = d;
  }
  return min;
}

/**
 * 颜色过滤逻辑，与 searchSku 保持一致：
 *   - "*" 匹配所有
 *   - 否则匹配 colorCode === 入参 的记录
 *   - RD 特殊处理
 */
export function colorMatches(record: SkuRecord, colorCode: string): boolean {
  if (colorCode === '*') return true;
  if (record.colorCode === colorCode) return true;
  const isRollDrawer =
    (EUROPEAN_STYLE_CODES.includes(colorCode) && record.colorCode === '30' && record.shapeTypeCode === 'RD') ||
    (NONE_EURO_STYLE_CODES.includes(colorCode) && record.colorCode === '02' && record.shapeTypeCode === 'RD');
  return isRollDrawer;
}

function mergedDescription(r: ReturnType<typeof serializeRecord>): string {
  const parts = [r.sizeDescription, r.otherDescription].filter((s) => s?.trim());
  return parts.length > 0 ? parts.join('; ') : '-';
}

function flattenResultsToRows(
  serialized: SerializedResult[],
): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < serialized.length; i++) {
    const r = serialized[i];
    const parentNum = String(i + 1);

    const parentSubItemsText = r.subItems.length > 0
      ? r.subItems.map((s) => s.itemName).join(', ')
      : '-';

    rows.push([
      parentNum,
      r.item.itemName,
      r.item.mainDescription || '-',
      r.item.mainAlias || '-',
      r.item.shapeTypeCode,
      r.item.shapeSizeCode,
      mergedDescription(r.item),
      parentSubItemsText,
    ]);

    for (let j = 0; j < r.subItems.length; j++) {
      const sub = r.subItems[j];
      const subNum = `${parentNum}.${j + 1}`;
      rows.push([
        subNum,
        sub.itemName,
        sub.mainDescription || '-',
        sub.mainAlias || '-',
        sub.shapeTypeCode || '-',
        sub.shapeSizeCode || '-',
        mergedDescription(sub),
        '-',
      ]);
    }
  }
  return rows;
}

// ==================================================================
//  TOOL DEFINITION
// ==================================================================

export const SEARCH_SKU_SHAPE_TOOL = {
  type: 'function',
  function: {
    name: 'searchSkuShape',
    description:
      '按形状类型代码模糊搜索 DUKO 产品数据库。使用编辑距离匹配 shapeTypeCode/shapeSizeCode 的近似值。' +
      '排序规则：shapeTypeCode 编辑距离优先，shapeSizeCode 编辑距离次之。' +
      '当用户查询的形状代码可能拼写有误、不完整或需要查看类似代码的产品时调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        shapeTypeCode: {
          type: 'string',
          description:
            '形状类型代码（必填）。例如 "B"、"W"、"UT"、"GD"、"BLS"。将按编辑距离在记录的 shapeTypeCode 和 shapeTypeAlias 中查找最接近的匹配。',
        },
        shapeSizeCode: {
          type: 'string',
          description:
            '形状尺寸代码（可选）。例如 "15"、"18"、"3696"。若提供，将按编辑距离进一步匹配记录的 shapeSizeCode 和 shapeSizeAlias。',
        },
        colorCode: {
          type: 'string',
          description:
            '颜色代码（必填）。如 "02"、"30"、"14"。输入 "*" 匹配任意颜色。',
        },
        topK: {
          type: 'number',
          description: '返回结果数量的上限。默认 10。',
        },
      },
      required: ['shapeTypeCode', 'colorCode'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  EXECUTOR
// ==================================================================

/**
 * 搜索形状的纯数据结果（不含 markdown 格式化），供 searchSkuOverlap 等组合工具复用。
 *
 * @returns 按 (typeDist ASC, sizeDist ASC) 排序的 topK 记录及编辑距离
 */
export function searchSkuShapeInternal(
  shapeTypeCode: string,
  shapeSizeCode: string | undefined,
  colorCode: string,
  topK: number,
): Array<{ record: SkuRecord; typeDist: number; sizeDist: number }> {
  const all = getAllRecords();
  const filtered = all.filter((r) => colorMatches(r, colorCode));

  const scored: Array<{ record: SkuRecord; typeDist: number; sizeDist: number }> = [];
  for (const record of filtered) {
    const typeDist = shapeTypeEditDistance(shapeTypeCode, record);
    const sizeDist = shapeSizeCode ? shapeSizeEditDistance(shapeSizeCode, record) : 0;
    scored.push({ record, typeDist, sizeDist });
  }

  scored.sort((a, b) => {
    if (a.typeDist !== b.typeDist) return a.typeDist - b.typeDist;
    return a.sizeDist - b.sizeDist;
  });

  return scored.slice(0, topK);
}

export function executeSearchSkuShape(args: Record<string, unknown>): string {
  const shapeTypeCode = String(args.shapeTypeCode ?? '');
  const shapeSizeCode = typeof args.shapeSizeCode === 'string' && args.shapeSizeCode.trim()
    ? args.shapeSizeCode.trim()
    : undefined;
  const colorCode = typeof args.colorCode === 'string' && args.colorCode.trim()
    ? args.colorCode.trim()
    : '*';
  const topK = typeof args.topK === 'number' && args.topK > 0 ? args.topK : 10;

  if (!shapeTypeCode) {
    return '## searchSkuShape 结果\n\n**错误**: `shapeTypeCode` 为必填项。';
  }

  const all = getAllRecords();

  // 按颜色过滤
  const filtered = all.filter((r) => colorMatches(r, colorCode));

  // 计算每条记录的编辑距离
  const scored: Array<{ record: SkuRecord; typeDist: number; sizeDist: number }> = [];
  for (const record of filtered) {
    const typeDist = shapeTypeEditDistance(shapeTypeCode, record);
    const sizeDist = shapeSizeCode ? shapeSizeEditDistance(shapeSizeCode, record) : 0;
    scored.push({ record, typeDist, sizeDist });
  }

  // 排序：typeDist ASC 为主键，sizeDist ASC 为次键
  scored.sort((a, b) => {
    if (a.typeDist !== b.typeDist) return a.typeDist - b.typeDist;
    return a.sizeDist - b.sizeDist;
  });

  const top = scored.slice(0, topK);

  // 解析子产品
  const resolved = resolveSubItems(top.map((s) => ({ item: s.record })));
  const serialized = resolved.map((r) => serializeResult(r));

  const totalRecords = all.length;

  const header = [
    '#', '产品代码', '描述', '别名', '形状类型', '尺寸', '附加描述', '子产品',
  ];

  const rows = flattenResultsToRows(serialized);

  const table = markdownTable([header, ...rows]);

  const sizeInfo = shapeSizeCode ? `**尺寸限定**: ${shapeSizeCode}` : '**尺寸限定**: 无';

  return `## searchSkuShape 搜索结果
- **形状类型**: ${shapeTypeCode}
- ${sizeInfo}
- **颜色限定**: ${colorCode}
- **数据库总量**: ${totalRecords} | **匹配结果**: ${serialized.length}

${table}`;
}
