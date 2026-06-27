/**
 * LanceDB 向量数据库连接层
 *
 * LanceDB 是一款嵌入式向量数据库，数据以文件形式存储在本地
 * （server/src/data/sku.lance/），无需额外服务进程。
 *
 * 功能：
 *  - 连接管理（首次建表时用占位记录推断 schema，随后 replaceAll 覆盖）
 *  - 数据写入（追加 append / 覆盖 overwrite)
 *  - 向量相似度检索（余弦距离，返回 _distance 字段）
 *
 * 注意：结构化字段的 CRUD、过滤、全量查询已迁移至 db/sku.ts（SQLite）。
 * 此模块仅负责 384 维向量的语义嵌入搜索。
 *
 * 数据模型（基于 Exposed-Items.csv，共 14 列）：
 *  itemName / colorCode / shapeTypeCode / shapeTypeAlias / shapeSizeCode / shapeSizeAlias
 *  / subItemsName / mainDescription / mainAlias / sizeDescription / otherDescription
 *  → text（供嵌入用）+ vector（384 维）
 *
 * 编辑距离策略：
 *  对每条记录生成 itemName 的笛卡尔积变体集合：
 *    types = [shapeTypeCode] + shapeTypeAlias 逗号拆分
 *    sizes = [shapeSizeCode] + shapeSizeAlias 逗号拆分
 *    variants = { itemName } ∪ { colorCode + t + s | t ∈ types, s ∈ sizes }
 *  取 query 与所有变体的最小 Levenshtein 距离。
 */

import * as lancedb from '@lancedb/lancedb';
import type { Connection, Table, Data } from '@lancedb/lancedb';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SkuRecord, SkuSearchResult } from '../types/sku.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../data/sku.lance');

// 全局缓存：Connection 和 Table 对象复用
let db: Connection | null = null;
let table: Table | null = null;

/**
 * 初始化数据库连接并确保 sku 表存在。
 *
 * 首次建表时写入一条占位记录（384 维零向量），
 * 让 LanceDB 据此推断各列的 schema（类型、维度）。
 * 后续 replaceAll 会覆盖这条占位记录，不影响实际数据。
 */
export async function initDB(): Promise<Table> {
  db = await lancedb.connect(DB_PATH);
  const tableNames = await db.tableNames();
  if (tableNames.includes('sku')) {
    table = await db.openTable('sku');
  } else {
    table = await db.createTable('sku', [{
      id: '_placeholder',
      itemName: '',
      colorCode: '',
      shapeTypeCode: '',
      shapeTypeAlias: '',
      shapeSizeCode: '',
      shapeSizeAlias: '',
      subItemsName: '',
      mainDescription: '',
      mainAlias: '',
      sizeDescription: '',
      otherDescription: '',
      text: '',
      vector: new Array(384).fill(0),
    }], { mode: 'create', existOk: true });
  }
  return table;
}

/** 懒加载：获取已缓存的 Table 实例，没有则先初始化 */
export async function getTable(): Promise<Table> {
  if (table) return table;
  return initDB();
}

/** 追加写入记录到 LanceDB（不含 SQLite 同步 —— 由上层协调） */
export async function insertRows(records: SkuRecord[]): Promise<void> {
  const tbl = await getTable();
  await tbl.add(records as unknown as Data, { mode: 'append' });
}

/**
 * 覆盖写入记录到 LanceDB（drop + create 彻底重建，避免 overwrite 残留旧版本文件）。
 * 不含 SQLite 同步 —— 由上层（sku-ingest）协调二者。
 */
export async function replaceAll(records: SkuRecord[]): Promise<void> {
  if (!db) {
    db = await lancedb.connect(DB_PATH);
  }
  try { await db.dropTable('sku'); } catch { /* 表可能不存在 */ }
  table = null;
  table = await db.createTable('sku', records as unknown as Data, { mode: 'create' });
}

/**
 * 向量相似度检索 —— 根据查询向量找到最接近的 K 条记录。
 * LanceDB 内部使用余弦距离排序（因 embedding 已 L2 归一化）。
 */
export async function searchSimilar(
  vector: number[],
  k: number = 10
): Promise<SkuSearchResult[]> {
  const tbl = await getTable();
  const results = await tbl
    .search(vector)
    .limit(k)
    .toArray();
  return results as SkuSearchResult[];
}

/** 返回 LanceDB 表中记录总数 */
export async function countRows(): Promise<number> {
  const tbl = await getTable();
  return tbl.countRows();
}
