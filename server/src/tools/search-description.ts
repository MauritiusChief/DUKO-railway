/**
 * searchSkuDescription 工具 —— 基于 BM25 的描述文本检索
 *
 * 对 DUKO 产品数据库的描述字段（mainDescription、mainAlias、sizeDescription、
 * otherDescription）构建 BM25 倒排索引，支持英文单词/短语的文本检索。
 *
 * 适用场景：用户输入 "wall cabinet"、"full high door"、"filler" 等描述性词语，
 * 需要查找对应产品条目时。
 *
 * 索引由 server/src/services/bm25.ts 管理，在服务启动时初始化。
 *
 * 供 BatchSearchAgent 使用。
 */

import { markdownTable } from 'markdown-table';
import type { ToolDefinition } from '../types/tool.js';
import { getAllRecords } from '../db/sku.js';
import { resolveSubItems } from '../services/retriever.js';
import { searchBm25 } from '../services/bm25.js';
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

export const SEARCH_SKU_DESCRIPTION_TOOL = {
  type: 'function',
  function: {
    name: 'searchSkuDescription',
    description:
      '搜索 DUKO 产品数据库中描述字段包含指定词语的产品。使用 BM25 文本检索，' +
      '在 mainDescription、mainAlias、sizeDescription、otherDescription 字段中搜索。' +
      '适用于用户提供英文描述性词语（如 "wall cabinet"、"full high door"、"filler"）' +
      '来查找对应产品条目的场景。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '英文搜索词，多个词语用空格分隔。例如 "wall cabinet"、"full high door"、"filler"。',
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
      required: ['query', 'colorCode'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  EXECUTOR
// ==================================================================

export function executeSearchSkuDescription(args: Record<string, unknown>): string {
  const query = String(args.query ?? '');
  const colorCode = typeof args.colorCode === 'string' && args.colorCode.trim()
    ? args.colorCode.trim()
    : '*';
  const topK = typeof args.topK === 'number' && args.topK > 0 ? args.topK : 10;

  if (!query) {
    return '## searchSkuDescription 结果\n\n**错误**: `query` 为必填项。';
  }

  const bm25Results = searchBm25(query, colorCode, topK);
  const resolved = resolveSubItems(bm25Results.map((r) => ({ item: r.record })));
  const serialized = resolved.map((r) => serializeResult(r));

  const totalRecords = getAllRecords().length;

  const header = [
    '#', '产品代码', '描述', '别名', '形状类型', '尺寸', '附加描述', '子产品',
  ];

  const rows = flattenResultsToRows(serialized);

  const table = markdownTable([header, ...rows]);

  return `## searchSkuDescription 搜索结果
- **查询**: "${query}"
- **颜色限定**: ${colorCode}
- **数据库总量**: ${totalRecords} | **匹配结果**: ${serialized.length}

${table}`;
}
