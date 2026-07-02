/**
 * searchSkuStructured 工具 —— 结构化多维度精确检索
 *
 * 通过三个独立参数实现顺序集合过滤：colorCode → shapeFilter → descriptionFilter，
 * 所有过滤均为集合交集运算，逐步缩窄候选集。最后按 vectorQuery 语义相似度
 * 对候选集排序（无 vectorQuery 时回退至 BM25 得分排序）。
 *
 * shapeFilter 等效 searchSkuShape（编辑距离模糊匹配），
 * descriptionFilter 等效 searchSkuDescription（BM25 文本检索），
 * 二者都支持递归 JSON 过滤树表达的并集/交集/补集操作。
 *
 * 四个参数：
 *   1. shapeFilter       —— 递归 JSON 过滤树，叶子用编辑距离模糊匹配（等效 searchSkuShape）
 *   2. descriptionFilter —— 递归 JSON 过滤树，叶子用 BM25 文本检索（等效 searchSkuDescription）
 *   3. vectorQuery       —— 向量语义检索内容，仅用于排序（非过滤），未命中记录排在末尾
 *   4. colorCode         —— 颜色限定（* 为通配符）
 *
 * 过滤流程：
 *   getAllRecords() → colorCode 过滤 → shapeFilter 集合运算 → descriptionFilter 集合运算
 *   → 向量排序（vectorQuery 距离排序，无则 BM25 得分降序）→ topK
 *
 * 任意参数为空/为 null 则跳过对应过滤/排序步骤。
 *
 * 供 PreciseSearchAgent 使用。
 */

import { markdownTable } from 'markdown-table';
import type { ToolDefinition } from '../types/tool.js';
import { getAllRecords } from '../db/sku.js';
import { searchSimilar } from '../db/lance.js';
import type { SkuRecord } from '../types/sku.js';
import { getEmbedding } from '../services/embeddings.js';
import { searchBm25All } from '../services/bm25.js';
import { resolveSubItems } from '../services/retriever.js';
import { serializeRecord, serializeResult } from './serializers.js';
import {
  colorMatches,
  shapeTypeEditDistance,
  shapeSizeEditDistance,
} from './search-shape.js';

type SerializedResult = ReturnType<typeof serializeResult>;

// ==================================================================
//  JSON 过滤树类型定义
// ==================================================================

/** 形状过滤树叶子节点：按 shapeTypeCode 和 shapeSizeCode 编辑距离匹配（* 通配） */
interface ShapeFilterLeaf {
  shapeTypeCode: string;
  shapeSizeCode?: string;
}

/** 描述过滤树叶子节点：按文本 BM25 检索匹配 */
interface DescriptionFilterLeaf {
  text: string;
}

/** 逻辑运算符节点 */
interface OrNode<T> {
  operator: 'or';
  conditions: FilterNode<T>[];
}

interface AndNode<T> {
  operator: 'and';
  conditions: FilterNode<T>[];
}

interface NotNode<T> {
  operator: 'not';
  condition: FilterNode<T>;
}

/** 递归过滤树节点：叶子 | 运算符 */
type FilterNode<T> = T | OrNode<T> | AndNode<T> | NotNode<T>;

/** 类型守卫：判断是否为运算符节点 */
function isOperatorNode<T>(node: FilterNode<T>): node is OrNode<T> | AndNode<T> | NotNode<T> {
  return typeof node === 'object' && node !== null && 'operator' in node;
}

// ==================================================================
//  叶子节点求值器（返回匹配的 ID 集合）
// ==================================================================

/**
 * 形状叶子求值：编辑距离模糊匹配，返回通过阈值的记录 ID 集合。
 *
 * 编辑距离阈值为 ceil(code.length / 2)（"GD"→1, "BLS"→2, "B"→1）。
 * "*" 表示该维度不做限制。
 */
function evaluateShapeLeaf(
  leaf: ShapeFilterLeaf,
  records: SkuRecord[],
): Set<string> {
  const typeThreshold =
    leaf.shapeTypeCode === '*'
      ? 0
      : Math.ceil(leaf.shapeTypeCode.length / 2);
  const sizeThreshold =
    leaf.shapeSizeCode === undefined ||
    leaf.shapeSizeCode === '*' ||
    leaf.shapeSizeCode === ''
      ? 0
      : Math.ceil(leaf.shapeSizeCode.length / 2);

  const result = new Set<string>();

  for (const record of records) {
    if (leaf.shapeTypeCode !== '*') {
      const td = shapeTypeEditDistance(leaf.shapeTypeCode, record);
      if (td > typeThreshold) continue;
    }
    if (
      leaf.shapeSizeCode !== undefined &&
      leaf.shapeSizeCode !== '*' &&
      leaf.shapeSizeCode !== ''
    ) {
      const sd = shapeSizeEditDistance(leaf.shapeSizeCode, record);
      if (sd > sizeThreshold) continue;
    }
    result.add(record.id);
  }

  return result;
}

/**
 * 描述叶子求值：BM25 文本检索，返回命中的记录 ID 集合。
 *
 * 调用 searchBm25All 获取全部命中记录（不做颜色过滤和 topK 截断，
 * 颜色过滤由外层统一处理）。同时将得分写入外部累加器供最终排序使用。
 */
function evaluateDescriptionLeaf(
  leaf: DescriptionFilterLeaf,
  scoreAccumulator: Map<string, number>,
): Set<string> {
  const scores = searchBm25All(leaf.text);
  // 将得分写入累加器（取最大值，因为同一记录可能被多个叶子命中）
  for (const [id, score] of scores) {
    const current = scoreAccumulator.get(id) ?? 0;
    if (score > current) {
      scoreAccumulator.set(id, score);
    }
  }
  return new Set(scores.keys());
}

// ==================================================================
//  JSON 过滤树递归集合运算求值器
// ==================================================================

/**
 * 对过滤树递归求值，返回通过过滤的记录 ID 集合。
 *
 * @param node     - 过滤树根节点
 * @param leafEval - 叶子求值函数（返回叶子节点对应的 ID 集合）
 * @param allIds   - 全集 ID（用于 and 的起始集和 not 的补集运算）
 * @returns 通过过滤的记录 ID 集合
 */
function evaluateFilterTree<T>(
  node: FilterNode<T>,
  leafEval: (leaf: T) => Set<string>,
  allIds: Set<string>,
): Set<string> {
  if (!isOperatorNode(node)) {
    return leafEval(node as T);
  }

  switch (node.operator) {
    case 'or': {
      const result = new Set<string>();
      for (const cond of node.conditions) {
        const condResult = evaluateFilterTree(cond, leafEval, allIds);
        for (const id of condResult) result.add(id);
      }
      return result;
    }
    case 'and': {
      if (node.conditions.length === 0) return new Set(allIds);
      let result = new Set(allIds);
      for (const cond of node.conditions) {
        const condResult = evaluateFilterTree(cond, leafEval, allIds);
        result = new Set(
          [...result].filter((id) => condResult.has(id)),
        );
      }
      return result;
    }
    case 'not': {
      const condResult = evaluateFilterTree(node.condition, leafEval, allIds);
      return new Set([...allIds].filter((id) => !condResult.has(id)));
    }
    default:
      return new Set();
  }
}

// ==================================================================
//  JSON 解析
// ==================================================================

/**
 * 安全解析 JSON 字符串，失败时返回 undefined。
 */
function safeParseJson<T>(json: string | null | undefined): T | undefined {
  if (!json || !json.trim()) return undefined;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

// ==================================================================
//  序列化辅助
// ==================================================================

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

export const SEARCH_SKU_STRUCTURED_TOOL = {
  type: 'function',
  function: {
    name: 'searchSkuStructured',
    description:
      '结构化多维度精确检索 DUKO 产品数据库。shapeFilter 等效 searchSkuShape（编辑距离模糊匹配），' +
      'descriptionFilter 等效 searchSkuDescription（BM25 文本检索），均支持递归 JSON 过滤树表达并/交/补集操作。' +
      '外加颜色限定与向量语义排序。过滤链：colorCode → shapeFilter → descriptionFilter（集合交集），' +
      '最后按 vectorQuery 语义相似度排序（未命中记录排在末尾，无 vectorQuery 时按 BM25 得分降序）。',
    parameters: {
      type: 'object',
      properties: {
        shapeFilter: {
          type: 'string',
          description:
            '形状过滤 JSON（可选）。递归过滤树，等效 searchSkuShape 的编辑距离匹配。' +
            '叶子节点：{"shapeTypeCode":"GD","shapeSizeCode":"*"}，"*" 不限制该维度。' +
            '运算符节点：{"operator":"or","conditions":[...]}（并集）、' +
            '{"operator":"and","conditions":[...]}（交集）、' +
            '{"operator":"not","condition":{...}}（补集）。' +
            '传入空字符串或 null 跳过此过滤。',
        },
        descriptionFilter: {
          type: 'string',
          description:
            '描述过滤 JSON（可选）。递归过滤树，等效 searchSkuDescription 的 BM25 检索。' +
            '叶子节点：{"text":"filler"} 对描述字段做 BM25 全文检索。' +
            '运算符节点同 shapeFilter。传入空字符串或 null 跳过此过滤。',
        },
        vectorQuery: {
          type: 'string',
          description:
            '向量语义查询文本（可选）。生成 embedding 后在 LanceDB 中做相似度搜索，' +
            '仅用于对过滤结果进行排序（距离近的排前面），不参与过滤——未命中的记录排在末尾。' +
            '传入空字符串跳过向量排序，回退至 BM25 得分降序。',
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
      required: ['colorCode'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  EXECUTOR
// ==================================================================

export async function executeSearchSkuStructured(args: Record<string, unknown>): Promise<string> {
  const shapeFilterJson = typeof args.shapeFilter === 'string' ? args.shapeFilter : null;
  const descriptionFilterJson = typeof args.descriptionFilter === 'string'
    ? args.descriptionFilter
    : null;
  const vectorQuery = typeof args.vectorQuery === 'string' && args.vectorQuery.trim()
    ? args.vectorQuery.trim()
    : null;
  const colorCode = typeof args.colorCode === 'string' && args.colorCode.trim()
    ? args.colorCode.trim()
    : '*';
  const topK = typeof args.topK === 'number' && args.topK > 0 ? args.topK : 10;

  const all = getAllRecords();
  const totalRecords = all.length;

  // [1] 颜色过滤 → 候选记录 + 候选 ID 全集
  const colorFiltered = all.filter((r) => colorMatches(r, colorCode));
  const colorFilteredById = new Map(colorFiltered.map((r) => [r.id, r]));
  const allIds = new Set(colorFiltered.map((r) => r.id));

  // 提前终止
  if (colorFiltered.length === 0) {
    return `## searchSkuStructured 搜索结果\n\n**颜色限定**: ${colorCode}\n**匹配结果**: 0\n\n无匹配记录。`;
  }

  // [2] 形状过滤（集合运算）
  let currentIds = new Set(allIds);
  const shapeFiltersUsed: string[] = [];

  const shapeNode = safeParseJson<FilterNode<ShapeFilterLeaf>>(shapeFilterJson);
  if (shapeNode) {
    const shapeResult = evaluateFilterTree(
      shapeNode,
      (leaf: ShapeFilterLeaf) => evaluateShapeLeaf(leaf, colorFiltered),
      allIds,
    );
    currentIds = new Set([...currentIds].filter((id) => shapeResult.has(id)));
    shapeFiltersUsed.push('形状过滤');
  }

  // [3] 描述过滤（集合运算，同时收集 BM25 得分用于最终排序）
  const descFiltersUsed: string[] = [];
  const bm25ScoreMap = new Map<string, number>(); // id → max BM25 score across all text leaves

  const descNode = safeParseJson<FilterNode<DescriptionFilterLeaf>>(descriptionFilterJson);
  if (descNode) {
    const descResult = evaluateFilterTree(
      descNode,
      (leaf: DescriptionFilterLeaf) => evaluateDescriptionLeaf(leaf, bm25ScoreMap),
      allIds,
    );
    currentIds = new Set([...currentIds].filter((id) => descResult.has(id)));
    descFiltersUsed.push('描述过滤');
  }

  // 将候选集缩减为 currentIds 对应的记录
  let candidates = [...currentIds]
    .map((id) => colorFilteredById.get(id)!)
    .filter(Boolean);

  // [4] 向量检索（软排序：匹配的排前面，未匹配的不丢弃）
  if (vectorQuery && candidates.length > 0) {
    const queryVector = await getEmbedding(vectorQuery);
    const searchK = Math.max(candidates.length, 20);
    const vectorResults = await searchSimilar(queryVector, searchK);
    const vectorDistMap = new Map(vectorResults.map((r) => [r.id, r._distance]));

    const maxDist = vectorResults.length > 0
      ? Math.max(...vectorResults.map((r) => r._distance))
      : 2;
    const fallbackDist = maxDist + 0.1;

    candidates.sort((a, b) => {
      const da = vectorDistMap.get(a.id) ?? fallbackDist;
      const db = vectorDistMap.get(b.id) ?? fallbackDist;
      return da - db;
    });
  } else if (bm25ScoreMap.size > 0 && candidates.length > 0) {
    // 无向量检索时，按 BM25 得分降序排列
    candidates.sort((a, b) => {
      const sa = bm25ScoreMap.get(a.id) ?? 0;
      const sb = bm25ScoreMap.get(b.id) ?? 0;
      return sb - sa;
    });
  }

  // 截断 topK
  const top = candidates.slice(0, topK);

  const resolved = resolveSubItems(top.map((r) => ({ item: r })));
  const serialized = resolved.map((r) => serializeResult(r));

  const header = [
    '#', '产品代码', '描述', '别名', '形状类型', '尺寸', '附加描述', '子产品',
  ];

  const rows = flattenResultsToRows(serialized);

  const table = markdownTable([header, ...rows]);

  const filtersUsed = [
    ...shapeFiltersUsed,
    ...descFiltersUsed,
    ...(vectorQuery ? [`向量检索: "${vectorQuery}"`] : []),
  ];
  const filterDesc = filtersUsed.length > 0 ? filtersUsed.join(' → ') : '无';

  return `## searchSkuStructured 搜索结果
- **颜色限定**: ${colorCode}
- **过滤链**: ${filterDesc}
- **数据库总量**: ${totalRecords} | **匹配结果**: ${serialized.length}

${table}`;
}
