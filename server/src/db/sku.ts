/**
 * Exposed-Items SQLite 数据库层
 *
 * 持久化存储 Exposed-Items 的结构化字段（不含嵌入向量）。
 * 向量检索仍由 LanceDB 负责，但所有非向量的 CRUD、过滤、查询操作
 * 均通过此处的 SQLite 执行，不再依赖内存缓存。
 *
 * 表结构：exposed_items (id, itemName, colorCode, shapeTypeCode,
 *   shapeTypeAlias, shapeSizeCode, shapeSizeAlias, subItemsName,
 *   mainDescription, mainAlias, sizeDescription, otherDescription, text)
 *
 * 索引覆盖 itemName、colorCode、shapeTypeCode、shapeSizeCode，
 * 支持常见查询模式的高效查找。
 */

import Database from 'better-sqlite3';
import path from 'path';
import type { SkuRecord } from '../types/sku.js';

let db: Database.Database;

/** 初始化 Exposed-Items 数据库：打开/创建 SQLite 文件并建表建索引 */
export function initSkuDB(dbDir: string): void {
  const dbPath = path.join(dbDir, 'sku.sqlite');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS exposed_items (
      id               TEXT PRIMARY KEY,
      itemName         TEXT NOT NULL,
      colorCode        TEXT NOT NULL DEFAULT '',
      shapeTypeCode    TEXT NOT NULL,
      shapeTypeAlias   TEXT NOT NULL DEFAULT '',
      shapeSizeCode    TEXT NOT NULL DEFAULT '',
      shapeSizeAlias   TEXT NOT NULL DEFAULT '',
      subItemsName     TEXT NOT NULL DEFAULT '',
      mainDescription  TEXT NOT NULL DEFAULT '',
      mainAlias        TEXT NOT NULL DEFAULT '',
      sizeDescription  TEXT NOT NULL DEFAULT '',
      otherDescription TEXT NOT NULL DEFAULT '',
      text             TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sku_itemName ON exposed_items(itemName);
    CREATE INDEX IF NOT EXISTS idx_sku_colorCode ON exposed_items(colorCode);
    CREATE INDEX IF NOT EXISTS idx_sku_shapeTypeCode ON exposed_items(shapeTypeCode);
    CREATE INDEX IF NOT EXISTS idx_sku_shapeSizeCode ON exposed_items(shapeSizeCode);
  `);
}

// ==================================================================
//  单条查询
// ==================================================================

/** 按 itemName 不区分大小写精确查找单条记录 */
export function findRecordByItemNameCI(itemName: string): SkuRecord | undefined {
  const row = db.prepare(`
    SELECT id, itemName, colorCode, shapeTypeCode, shapeTypeAlias,
           shapeSizeCode, shapeSizeAlias, subItemsName,
           mainDescription, mainAlias, sizeDescription, otherDescription, text
    FROM exposed_items
    WHERE itemName = ? COLLATE NOCASE
  `).get(itemName) as SkuRecord | undefined;

  if (!row) return undefined;
  return { ...row, vector: [] };
}

// ==================================================================
//  批量查询
// ==================================================================

/** 按 itemName 列表批量查找（不区分大小写），返回 itemName → SkuRecord 的映射 */
export function getRecordsByItemNames(itemNames: string[]): Map<string, SkuRecord> {
  const map = new Map<string, SkuRecord>();
  if (itemNames.length === 0) return map;

  // 构建 IN (...) 查询，SQLite COLLATE NOCASE 处理大小写
  const placeholders = itemNames.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id, itemName, colorCode, shapeTypeCode, shapeTypeAlias,
           shapeSizeCode, shapeSizeAlias, subItemsName,
           mainDescription, mainAlias, sizeDescription, otherDescription, text
    FROM exposed_items
    WHERE itemName IN (${placeholders}) COLLATE NOCASE
  `).all(itemNames) as SkuRecord[];

  // 构建原始大小写的 itemName 索引，便于调用方按原始名称查找
  const originalCase = new Map<string, string>(); // lowercase → original
  for (const name of itemNames) {
    if (!originalCase.has(name.toLowerCase())) {
      originalCase.set(name.toLowerCase(), name);
    }
  }

  for (const row of rows) {
    const original = originalCase.get(row.itemName.toLowerCase()) ?? row.itemName;
    map.set(original, { ...row, vector: [] });
  }
  return map;
}

// ==================================================================
//  全量查询
// ==================================================================

/** 返回全部 Exposed-Items 记录（供编辑距离全表扫描、BM25 索引构建等场景） */
export function getAllRecords(): SkuRecord[] {
  const rows = db.prepare(`
    SELECT id, itemName, colorCode, shapeTypeCode, shapeTypeAlias,
           shapeSizeCode, shapeSizeAlias, subItemsName,
           mainDescription, mainAlias, sizeDescription, otherDescription, text
    FROM exposed_items
    ORDER BY itemName
  `).all() as SkuRecord[];

  return rows.map((row) => ({ ...row, vector: [] }));
}

// ==================================================================
//  条件过滤查询
// ==================================================================

/**
 * 检查单条 (colorCode, shapeTypeCode, shapeSizeCode) 组合是否在库中存在。
 *
 * 空 colorCode 或空 shapeSizeCode 表示该维度无限制（跳过比对）。
 * 比对均为 COLLATE NOCASE 不区分大小写。
 */
export function findComboExists(
  colorCode: string,
  shapeTypeCode: string,
  shapeSizeCode: string,
): boolean {
  const conditions: string[] = [];
  const params: string[] = [];

  conditions.push('shapeTypeCode = ? COLLATE NOCASE');
  params.push(shapeTypeCode);

  if (colorCode) {
    conditions.push('colorCode = ? COLLATE NOCASE');
    params.push(colorCode);
  }
  if (shapeSizeCode) {
    conditions.push('shapeSizeCode = ? COLLATE NOCASE');
    params.push(shapeSizeCode);
  }

  const row = db.prepare(`
    SELECT 1 as found FROM exposed_items
    WHERE ${conditions.join(' AND ')}
    LIMIT 1
  `).get(params) as { found: number } | undefined;

  return !!row;
}

// ==================================================================
//  数据写入
// ==================================================================

/** 事务性全量替换 —— 先清空现有数据再批量插入 */
export function replaceAllRecords(records: SkuRecord[]): void {
  const insert = db.prepare(`
    INSERT INTO exposed_items
      (id, itemName, colorCode, shapeTypeCode, shapeTypeAlias,
       shapeSizeCode, shapeSizeAlias, subItemsName,
       mainDescription, mainAlias, sizeDescription, otherDescription, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.exec('DELETE FROM exposed_items');
    for (const r of records) {
      insert.run(
        r.id, r.itemName, r.colorCode, r.shapeTypeCode, r.shapeTypeAlias,
        r.shapeSizeCode, r.shapeSizeAlias, r.subItemsName,
        r.mainDescription, r.mainAlias, r.sizeDescription, r.otherDescription,
        r.text,
      );
    }
  })();
}

/** 事务性追加记录（已存在同 id 则替换） */
export function insertRecords(records: SkuRecord[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO exposed_items
      (id, itemName, colorCode, shapeTypeCode, shapeTypeAlias,
       shapeSizeCode, shapeSizeAlias, subItemsName,
       mainDescription, mainAlias, sizeDescription, otherDescription, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const r of records) {
      insert.run(
        r.id, r.itemName, r.colorCode, r.shapeTypeCode, r.shapeTypeAlias,
        r.shapeSizeCode, r.shapeSizeAlias, r.subItemsName,
        r.mainDescription, r.mainAlias, r.sizeDescription, r.otherDescription,
        r.text,
      );
    }
  })();
}

/** 返回已存记录总数 */
export function getRecordCount(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM exposed_items').get() as { cnt: number };
  return row.cnt;
}
