/**
 * RAG 混合检索器 —— 向量语义检索 + 编辑距离融合
 *
 * 三种检索模式：
 *  1. searchSimilar          —— 纯向量余弦距离（由 LanceDB 提供）
 *  2. searchByEditDistance   —— 纯编辑距离全表扫描
 *  3. searchHybrid           —— 向量预筛 + 全表编辑距离重评分（60%语义 + 40%编辑）
 *      向量检索扩大候选集 → 全表计算编辑距离 → 候选集内记录有向量分数加成
 *
 * 编辑距离策略（笛卡尔积变体）：
 *  对每条记录生成 itemName 的变体集合：
 *    types = [shapeTypeCode] + shapeTypeAlias 逗号拆分
 *    sizes = [shapeSizeCode] + shapeSizeAlias 逗号拆分
 *    variants = { itemName } ∪ { colorCode + t + s | t ∈ types, s ∈ sizes }
 *  取 query 与所有变体的最小 Levenshtein 距离。
 *
 *  无 alias 时 types / sizes 只有原始值各一个，variants 退化为 itemName 本身。
 *  80 条数据量开销可忽略，目的是避免向量搜索主导排序，
 *  确保精确或近似的代码输入不会被向量语义淹没。
 *
 * 数据来源：
 *  - 全量记录、按条件过滤 → SQLite（db/sku.ts）
 *  - 向量语义检索 → LanceDB（db/lance.ts）
 */

import { getEmbedding } from './embeddings.js';
import { searchSimilar } from '../db/lance.js';
import {
  getAllRecords,
  getRecordsByItemNames,
} from '../db/sku.js';
import type { SkuRecord } from '../types/sku.js';
import { distance as levenshtein } from 'fastest-levenshtein';
import { EUROPEAN_STYLE_CODES, NONE_EURO_STYLE_CODES } from '../constants.js';

/**
 * 归一化距离为 [0, 1] 相似度分数。
 * dist 越小表示越相似 → score 越接近 1。
 * maxDist 为 0 时（所有记录距离相同）直接返回满分。
 */
function normalizeDistance(dist: number, maxDist: number): number {
  if (maxDist === 0) return 1;
  return Math.max(0, 1 - dist / maxDist);
}

/**
 * 清洗文本用于编辑距离比较：
 * 小写 + 去除空格、短横线、斜杠 → "G635-C#68" → "g635c#68"
 */
function clean(s: string): string {
  return s.toLowerCase().replace(/[\s\/\-]/g, '');
}

/**
 * 计算 query 与某条记录的最小编辑距离。
 *
 * 匹配目标通过笛卡尔积生成 itemName 的拟似变体：
 *   1. 记录原始 itemName
 *   2. shapeTypeAlias 拆分段 × shapeSizeAlias 拆分段 的笛卡尔积，
 *      拼成 {colorCode}{type变体}{size变体} 的形式
 *
 * 例如：itemName="02B12", colorCode="02", shapeTypeCode="B",
 *       shapeTypeAlias="C,D", shapeSizeCode="12", shapeSizeAlias="13,14"
 *   types = [B, C, D]
 *   sizes = [12, 13, 14]
 *   笛卡尔积 → 9 个变体: 02B12, 02B13, 02B14, 02C12, 02C13, 02C14, 02D12, 02D13, 02D14
 *
 * 返回所有变体中的最小编辑距离。
 */
function minEditDistance(query: string, record: SkuRecord): number {
  const q = clean(query);

  // 收集 shape type 变体：原始 code + alias 各段
  const typeVariants: string[] = [
    clean(record.shapeTypeCode),
    ...(record.shapeTypeAlias
      ? record.shapeTypeAlias.split(',').map((s) => clean(s.trim())).filter(Boolean)
      : []),
  ];

  // 收集 shape size 变体：原始 code + alias 各段
  const sizeVariants: string[] = [
    clean(record.shapeSizeCode),
    ...(record.shapeSizeAlias
      ? record.shapeSizeAlias.split(',').map((s) => clean(s.trim())).filter(Boolean)
      : []),
  ];

  // 去重
  const types = [...new Set(typeVariants)];
  const sizes = [...new Set(sizeVariants)];

  const cleanColor = clean(record.colorCode);

  // 笛卡尔积生成拟-itemName 集合 + 原始 itemName
  const targets = new Set<string>();
  targets.add(clean(record.itemName));
  for (const t of types) {
    for (const s of sizes) {
      targets.add((cleanColor === '' ? '' : cleanColor) + (t === '' ? '' : t) + (s === '' ? '' : s));
    }
  }

  // 取所有变体中的最小编辑距离
  let min = Infinity;
  for (const tgt of targets) {
    const d = levenshtein(q, tgt);
    if (d < min) min = d;
  }
  return min;
}

/**
 * @deprecated
 * 纯编辑距离搜索 —— 全表扫描，按编辑距离升序排列。
 *
 * 适用于用户输入了（可能有误的）产品代码的场景。
 * 对每条记录生成 itemName 笛卡尔积变体，取最小编辑距离。
 *
 * @param query - 用户查询文本（产品代码或名称）
 * @param topK  - 返回结果数，默认 5
 */
export async function searchByEditDistance(
  query: string,
  topK: number = 5
): Promise<{ item: SkuRecord; dist: number }[]> {
  const all = getAllRecords();
  const scored: { item: SkuRecord; dist: number }[] = [];

  for (const item of all) {
    const dist = minEditDistance(query, item);
    scored.push({ item, dist });
  }

  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, topK);
}

/**
 * 统一加权搜索 —— 向量语义检索 + 编辑距离检索按给定权重融合。
 *
 * 参数 vectorWeight 与 editWeight 控制两种检索方式的贡献比例，
 * 当 LLM 不指定权重时默认均为 0.5（等权重）。
 *
 * 内部调用 searchSimilar（向量）和全表编辑距离计算，
 * 每条记录的综合分数 = vectorWeight × 归一化向量分数 + editWeight × 归一化编辑分数。
 *
 * @param query         - 用户查询文本（自然语言描述 或 产品代码）
 * @param topK          - 返回结果数，默认 5
 * @param vectorWeight  - 向量语义检索权重（0-1），默认 0.5
 * @param editWeight    - 编辑距离检索权重（0-1），默认 0.5
 * @param colorCode     - 颜色代码（如 "02"、"14"）或通配符 "*"。传入后仅在此颜色的产品
 *                        和不附带颜色代码的产品中搜索。
 */
export async function searchSku(
  query: string,
  topK: number = 5,
  vectorWeight: number = 0.5,
  editWeight: number = 0.5,
  colorCode: string,
): Promise<{ item: SkuRecord; vectorDist: number; editDist: number; combined: number }[]> {
  // 生成查询向量
  const queryVector = await getEmbedding(query);

  // 向量检索扩大召回（topK × 4，至少 20）
  const candidates = await searchSimilar(queryVector, Math.max(topK * 4, 20));
  let all = getAllRecords();

  if (all.length === 0) return [];

  // 如果指定了颜色代码，仅在匹配颜色的记录和无颜色的记录中搜索
  // RD 在此特殊处理匹配 30 或者 02，因为 RD 算作一种特殊的"无颜色"零件
  if (colorCode !== "*") {
    const isRollDrawer = (r: SkuRecord, c: string) => {
      return (EUROPEAN_STYLE_CODES.includes(c) && r.colorCode === '30' && r.shapeTypeCode === 'RD') || ((NONE_EURO_STYLE_CODES.includes(c)) && r.colorCode === '02' && r.shapeTypeCode === 'RD')
    }
    all = all.filter((r) => r.colorCode === colorCode || isRollDrawer(r, colorCode));
    if (all.length === 0) return [];
  }

  // 构建候选集索引
  const candidateIds = new Set(candidates.map((c) => c.id));
  const candidateMap = new Map(candidates.map((c) => [c.id, c._distance]));

  // 归一化用 —— 候选集中最大向量距离
  const maxVectorDist = Math.max(...candidates.map((c) => c._distance), 0.001);

  // 全表（或颜色过滤后）计算编辑距离
  const allEditDists: number[] = [];
  const editDistMap = new Map<string, number>();
  for (const item of all) {
    const d = minEditDistance(query, item);
    editDistMap.set(item.id, d);
    allEditDists.push(d);
  }
  const maxEdit = Math.max(...allEditDists, 1);

  // 逐条评分（仅评分过滤后的记录）
  const scored: { item: SkuRecord; vectorDist: number; editDist: number; combined: number }[] = [];

  for (const item of all) {
    const editDist = editDistMap.get(item.id)!;
    const editScore = normalizeDistance(editDist, maxEdit);

    let vectorDist = candidateMap.get(item.id) ?? maxVectorDist;
    let vectorScore = 0;
    if (candidateIds.has(item.id)) {
      vectorScore = normalizeDistance(vectorDist, maxVectorDist);
    }

    const combined = vectorScore * vectorWeight + editScore * editWeight;
    scored.push({ item, vectorDist, editDist, combined });
  }

  // 按综合分数降序，返回 topK
  scored.sort((a, b) => b.combined - a.combined);
  return scored.slice(0, topK);
}

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
