/**
 * BM25 文本检索服务
 *
 * 基于 minisearch 对 SQLite 中 Exposed-Items 全量记录的描述字段构建内存 BM25 倒排索引。
 * 索引字段：mainDescription、mainAlias、sizeDescription、otherDescription。
 * 支持颜色代码过滤（* 为通配符，匹配所有颜色）。
 *
 * 供 searchSkuDescription 与 searchSkuOverlap 工具共用。
 */

import MiniSearch from 'minisearch';
import { getAllRecords } from '../db/sku.js';
import type { SkuRecord } from '../types/sku.js';
import { EUROPEAN_STYLE_CODES, NONE_EURO_STYLE_CODES } from '../constants.js';

const SEARCHABLE_FIELDS = ['text'] as const;

let miniSearch: MiniSearch | null = null;

/** 记录的内联缓存副本，用于颜色过滤后快速映射 id → SkuRecord */
let recordCache: Map<string, SkuRecord> = new Map();

/**
 * 判断某条记录是否匹配给定的颜色限定。
 * 逻辑与 searchSku 中的颜色过滤一致：
 *   - "*" 匹配所有
 *   - 否则匹配 colorCode 等于入参的记录
 *   - RD（Roll Drawer）特殊处理：欧洲风格匹配 colorCode "30"，非欧洲风格匹配 "02"
 */
function colorMatches(record: SkuRecord, colorCode: string): boolean {
  if (colorCode === '*') return true;
  if (record.colorCode === colorCode) return true;
  const isRollDrawer =
    (EUROPEAN_STYLE_CODES.includes(colorCode) && record.colorCode === '30' && record.shapeTypeCode === 'RD') ||
    (NONE_EURO_STYLE_CODES.includes(colorCode) && record.colorCode === '02' && record.shapeTypeCode === 'RD');
  return isRollDrawer;
}

/**
 * 拼接记录的描述字段为一个索引文档。
 */
function buildDocText(record: SkuRecord): string {
  return [record.mainDescription, record.mainAlias, record.sizeDescription, record.otherDescription]
    .filter((s) => s && s.trim())
    .join(' ');
}

/**
 * 初始化（或重建）BM25 倒排索引。
 *
 * 每次调用都会用当前 SQLite 中 getAllRecords() 的全量数据重建索引。
 * 在 Exposed-Items 数据变更后需重新调用。
 */
export function initBm25Index(): void {
  const all = getAllRecords();

  recordCache = new Map();
  const docs: Array<{ id: string; text: string }> = [];

  for (const record of all) {
    recordCache.set(record.id, record);
    docs.push({ id: record.id, text: buildDocText(record) });
  }

  miniSearch = new MiniSearch({
    idField: 'id',
    fields: ['text'],
    storeFields: ['id'],
    searchOptions: {
      boost: { text: 1 },
    },
  });

  miniSearch.addAll(docs);
}

/**
 * 懒加载：首次调用时自动初始化索引。
 */
function ensureIndex(): MiniSearch {
  if (!miniSearch) {
    initBm25Index();
  }
  return miniSearch!;
}

/**
 * 执行 BM25 搜索。
 *
 * @param query     - 英文搜索词（空格分隔），如 "wall cabinet"、"filler"
 * @param colorCode - 颜色代码限定，"*" 表示不过滤颜色
 * @param topK      - 返回结果数上限
 * @returns 按 BM25 得分降序排列的检索结果，仅包含通过颜色过滤的记录
 */
export function searchBm25(
  query: string,
  colorCode: string,
  topK: number,
): Array<{ record: SkuRecord; score: number }> {
  const ms = ensureIndex();
  const raw = ms.search(query, { prefix: true });

  const results: Array<{ record: SkuRecord; score: number }> = [];

  for (const hit of raw) {
    const record = recordCache.get(hit.id);
    if (!record) continue;
    if (!colorMatches(record, colorCode)) continue;
    results.push({ record, score: hit.score });
    if (results.length >= topK) break;
  }

  return results;
}

/**
 * 返回 BM25 命中的全部记录 ID → 得分映射。
 *
 * 不做颜色过滤和 topK 截断，供 searchSkuStructured 的 descriptionFilter
 * 集合运算使用（颜色过滤由外层统一处理）。
 *
 * @param query - 英文搜索词
 * @returns 所有命中记录的 id → score 映射
 */
export function searchBm25All(query: string): Map<string, number> {
  const ms = ensureIndex();
  const raw = ms.search(query, { prefix: true });
  const map = new Map<string, number>();
  for (const hit of raw) {
    map.set(hit.id, hit.score);
  }
  return map;
}
