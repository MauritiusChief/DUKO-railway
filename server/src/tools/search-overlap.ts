/**
 * searchSkuOverlap 工具 —— searchSkuShape 与 searchSkuDescription 的交集检索
 *
 * 分别执行 searchSkuShape（形状编辑距离搜索）与 searchSkuDescription（BM25 描述文本搜索），
 * 取二者返回结果的交集（按记录 id 匹配），按 BM25 得分降序排列。
 *
 * 适用场景：用户希望同时限定形状类型和描述关键词，取两个维度的交集结果。
 * 例如查询 "形状为 B 且描述含 filler 的产品"。
 *
 * 供 BatchSearchAgent 使用。
 */

import { markdownTable } from 'markdown-table';
import type { ToolDefinition } from '../types/tool.js';
import { getAllRecords } from '../db/sku.js';
import { resolveSubItems } from '../services/retriever.js';
import { searchBm25 } from '../services/bm25.js';
import { searchSkuShapeInternal } from './search-shape.js';
import { serializeRecord, serializeResult } from './serializers.js';

type SerializedResult = ReturnType<typeof serializeResult>;

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

export const SEARCH_SKU_OVERLAP_TOOL = {
  type: 'function',
  function: {
    name: 'searchSkuOverlap',
    description:
      '综合形状与描述的双维度交集搜索。同时按形状类型（编辑距离模糊匹配）和描述文本（BM25 检索）' +
      '进行搜索，返回两个维度同时匹配的结果（交集）。' +
      '适用于需要同时限定形状代码和描述关键词的场景。',
    parameters: {
      type: 'object',
      properties: {
        shapeTypeCode: {
          type: 'string',
          description:
            '形状类型代码（必填）。例如 "B"、"W"、"UT"、"GD"、"BLS"。将按编辑距离模糊匹配。',
        },
        shapeSizeCode: {
          type: 'string',
          description:
            '形状尺寸代码（可选）。例如 "15"、"18"、"3696"。若提供，将按编辑距离进一步匹配。',
        },
        descriptionQuery: {
          type: 'string',
          description:
            '描述文本搜索词（必填）。英文单词/短语，如 "wall cabinet"、"filler"。在描述字段中进行 BM25 文本检索。',
        },
        colorCode: {
          type: 'string',
          description:
            '颜色代码（必填）。如 "02"、"30"、"14"。输入 "*" 匹配任意颜色。',
        },
        topK: {
          type: 'number',
          description: '交集结果返回数量的上限。默认 10。',
        },
      },
      required: ['shapeTypeCode', 'descriptionQuery', 'colorCode'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  EXECUTOR
// ==================================================================

export function executeSearchSkuOverlap(args: Record<string, unknown>): string {
  const shapeTypeCode = String(args.shapeTypeCode ?? '');
  const shapeSizeCode = typeof args.shapeSizeCode === 'string' && args.shapeSizeCode.trim()
    ? args.shapeSizeCode.trim()
    : undefined;
  const descriptionQuery = String(args.descriptionQuery ?? '');
  const colorCode = typeof args.colorCode === 'string' && args.colorCode.trim()
    ? args.colorCode.trim()
    : '*';
  const topK = typeof args.topK === 'number' && args.topK > 0 ? args.topK : 10;

  if (!shapeTypeCode) {
    return '## searchSkuOverlap 结果\n\n**错误**: `shapeTypeCode` 为必填项。';
  }
  if (!descriptionQuery) {
    return '## searchSkuOverlap 结果\n\n**错误**: `descriptionQuery` 为必填项。';
  }

  // 各自扩大召回以确保交集有足够候选
  const expandedTopK = topK * 3;

  // 形状编辑距离搜索
  const shapeResults = searchSkuShapeInternal(shapeTypeCode, shapeSizeCode, colorCode, expandedTopK);

  // BM25 描述文本搜索
  const descriptionResults = searchBm25(descriptionQuery, colorCode, expandedTopK);

  // 构建描述结果的 id → score 映射
  const descScoreMap = new Map<string, number>();
  for (const dr of descriptionResults) {
    descScoreMap.set(dr.record.id, dr.score);
  }

  // 取交集：形状结果中存在且描述结果中也存在的记录
  const intersection: Array<{ item: (typeof shapeResults)[number]; bm25Score: number }> = [];
  for (const sr of shapeResults) {
    const score = descScoreMap.get(sr.record.id);
    if (score !== undefined) {
      intersection.push({ item: sr, bm25Score: score });
    }
  }

  // 按 BM25 得分降序排列
  intersection.sort((a, b) => b.bm25Score - a.bm25Score);

  const top = intersection.slice(0, topK);

  const resolved = resolveSubItems(top.map((t) => ({ item: t.item.record })));
  const serialized = resolved.map((r) => serializeResult(r));

  const totalRecords = getAllRecords().length;

  const header = [
    '#', '产品代码', '描述', '别名', '形状类型', '尺寸', '附加描述', '子产品',
  ];

  const rows = flattenResultsToRows(serialized);

  const table = markdownTable([header, ...rows]);

  const sizeInfo = shapeSizeCode ? `**尺寸限定**: ${shapeSizeCode}` : '**尺寸限定**: 无';

  return `## searchSkuOverlap 搜索结果
- **形状类型**: ${shapeTypeCode}
- ${sizeInfo}
- **描述查询**: "${descriptionQuery}"
- **颜色限定**: ${colorCode}
- **数据库总量**: ${totalRecords} | **交集结果**: ${serialized.length}

${table}`;
}
