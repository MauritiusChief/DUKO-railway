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
import fs from 'fs';
import type { SkuRecord } from '../types/sku.js';

let db: Database.Database;

/** 初始化 Exposed-Items 数据库：打开/创建 SQLite 文件并建表建索引 */
export function initSkuDB(dbDir: string): void {
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'sku.sqlite');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    -- 主物品查询表（Exposed-Items.csv）
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
    CREATE INDEX IF NOT EXISTS idx_sku_itemName      ON exposed_items(itemName);
    CREATE INDEX IF NOT EXISTS idx_sku_colorCode     ON exposed_items(colorCode);
    CREATE INDEX IF NOT EXISTS idx_sku_shapeTypeCode ON exposed_items(shapeTypeCode);
    CREATE INDEX IF NOT EXISTS idx_sku_shapeSizeCode ON exposed_items(shapeSizeCode);

    -- 颜色代码对照表（Exposed-Color.csv）
    CREATE TABLE IF NOT EXISTS exposed_colors (
      colorCode TEXT PRIMARY KEY,
      colorText TEXT NOT NULL
    );

    -- 形状代码对照表（Exposed-Types.csv）
    CREATE TABLE IF NOT EXISTS exposed_types (
      shapeTypeCode TEXT PRIMARY KEY,
      description   TEXT NOT NULL
    );

    -- 物品映射表（Items.csv）
    CREATE TABLE IF NOT EXISTS items (
      itemName      TEXT PRIMARY KEY,
      colorCode     TEXT NOT NULL DEFAULT '',
      shapeTypeCode TEXT NOT NULL DEFAULT '',
      shapeSizeCode TEXT NOT NULL DEFAULT '',
      doorPart      TEXT NOT NULL DEFAULT '',
      cabinetPart   TEXT NOT NULL DEFAULT '',
      extraPart     TEXT NOT NULL DEFAULT ''
    );

    -- 部件映射表（Parts.csv）
    CREATE TABLE IF NOT EXISTS parts (
      singlePartName TEXT PRIMARY KEY,
      sharedPartName TEXT NOT NULL DEFAULT '',
      description    TEXT NOT NULL DEFAULT ''
    );

    -- 产品库存表（Product.csv）
    CREATE TABLE IF NOT EXISTS products (
      name          TEXT PRIMARY KEY,
      forecastedQty REAL NOT NULL DEFAULT 0,
      freeToUseQty  REAL NOT NULL DEFAULT 0,
      qtyOnHand     REAL NOT NULL DEFAULT 0
    );

    -- 库存识别历史（最近 20 次成功识别的全局共享记录）
    CREATE TABLE IF NOT EXISTS inventory_results (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id              TEXT NOT NULL UNIQUE,
      triggered_by_id     INTEGER NOT NULL,
      triggered_by_name   TEXT NOT NULL,
      source              TEXT NOT NULL CHECK(source IN ('auto','upload')),
      threshold           REAL NOT NULL,
      trend_threshold     REAL NOT NULL,
      recent_months       INTEGER NOT NULL,
      total_cleaned       INTEGER NOT NULL,
      low_stock_count     INTEGER NOT NULL,
      warning_count       INTEGER NOT NULL DEFAULT 0,
      reminder_count      INTEGER NOT NULL DEFAULT 0,
      info_count          INTEGER NOT NULL DEFAULT 0,
      no_attention_count  INTEGER NOT NULL DEFAULT 0,
      classification_json TEXT NOT NULL,
      completed_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_results_completed
      ON inventory_results(completed_at DESC, id DESC);

    -- SKU 数据刷新元数据（单例，id 恒为 1）
    CREATE TABLE IF NOT EXISTS sku_refresh_metadata (
      id                         INTEGER PRIMARY KEY CHECK(id = 1),
      active_generation          TEXT,
      last_successful_refresh_at TEXT,
      source                     TEXT
    );
  `);
}

// ==================================================================
// #region 单条查询
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
// #region 批量查询
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
// #region 全量查询
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
// #region 条件过滤查询
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
// #region 数据写入
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

// ==================================================================
// #region 引用数据表接口
// ==================================================================

/** Exposed-Color.csv 单行记录 */
export interface ColorEntry {
  code: string;
  name: string;
}

/** Exposed-Types.csv 单行记录 */
export interface ShapeTypeEntry {
  code: string;
  description: string;
}

/** Items.csv 单行记录 — itemName → 部件组成映射 */
export interface ItemRow {
  itemName: string;
  colorCode: string;
  shapeTypeCode: string;
  shapeSizeCode: string;
  doorPart: string;
  cabinetPart: string;
  extraPart: string;
}

/** Parts.csv 单行记录 — singlePartName → sharedPartName / description */
export interface PartRow {
  singlePartName: string;
  sharedPartName: string;
  description: string;
}

/** Product.csv 单行记录 — Name → 库存三大字段 */
export interface ProductRow {
  name: string;
  forecastedQty: number;
  freeToUseQty: number;
  qtyOnHand: number;
}

// ==================================================================
// #region 引用数据表 — 查询
// ==================================================================

// -- exposed_colors ----------------------------------------------------------

/** 返回 Exposed-Color 全量颜色代码对照表 */
export function getAllColorEntries(): ColorEntry[] {
  const rows = db.prepare(`
    SELECT colorCode, colorText
    FROM exposed_colors
    ORDER BY colorCode
  `).all() as { colorCode: string; colorText: string }[];

  return rows.map((r) => ({ code: r.colorCode, name: r.colorText }));
}

// -- exposed_types -----------------------------------------------------------

/** 返回 Exposed-Types 全量形状代码对照表 */
export function getAllShapeTypeEntries(): ShapeTypeEntry[] {
  const rows = db.prepare(`
    SELECT shapeTypeCode, description
    FROM exposed_types
    ORDER BY shapeTypeCode
  `).all() as { shapeTypeCode: string; description: string }[];

  return rows.map((r) => ({ code: r.shapeTypeCode, description: r.description }));
}

// -- items -------------------------------------------------------------------

/** 按 itemName 精确查找单条物品记录 */
export function getItemRow(itemName: string): ItemRow | undefined {
  const row = db.prepare(`
    SELECT itemName, colorCode, shapeTypeCode, shapeSizeCode,
           doorPart, cabinetPart, extraPart
    FROM items
    WHERE itemName = ?
  `).get(itemName) as ItemRow | undefined;

  return row || undefined;
}

/** 返回 Items 全量记录（用于构建 Map 或批量处理） */
export function getAllItemRows(): ItemRow[] {
  return db.prepare(`
    SELECT itemName, colorCode, shapeTypeCode, shapeSizeCode,
           doorPart, cabinetPart, extraPart
    FROM items
    ORDER BY itemName
  `).all() as ItemRow[];
}

// -- parts -------------------------------------------------------------------

/** 按 singlePartName 精确查找单条部件记录 */
export function getPartRow(singlePartName: string): PartRow | undefined {
  const row = db.prepare(`
    SELECT singlePartName, sharedPartName, description
    FROM parts
    WHERE singlePartName = ?
  `).get(singlePartName) as PartRow | undefined;

  return row || undefined;
}

/** 返回 Parts 全量记录（用于构建 Map 或批量处理） */
export function getAllPartRows(): PartRow[] {
  return db.prepare(`
    SELECT singlePartName, sharedPartName, description
    FROM parts
    ORDER BY singlePartName
  `).all() as PartRow[];
}

// -- products ----------------------------------------------------------------

/** 按 Name 精确查找单条产品库存记录 */
export function getProductRow(name: string): ProductRow | undefined {
  const row = db.prepare(`
    SELECT name, forecastedQty, freeToUseQty, qtyOnHand
    FROM products
    WHERE name = ?
  `).get(name) as ProductRow | undefined;

  return row || undefined;
}

/** 返回 Product 全量记录（用于构建 Map 或批量处理） */
export function getAllProductRows(): ProductRow[] {
  return db.prepare(`
    SELECT name, forecastedQty, freeToUseQty, qtyOnHand
    FROM products
    ORDER BY name
  `).all() as ProductRow[];
}

// ==================================================================
// #region 引用数据表 — 记录数检查
// ==================================================================

/** 返回 exposed_colors 记录数 */
export function getColorRecordCount(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM exposed_colors').get() as { cnt: number };
  return row.cnt;
}

/** 返回 exposed_types 记录数 */
export function getTypeRecordCount(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM exposed_types').get() as { cnt: number };
  return row.cnt;
}

/** 返回 items 记录数 */
export function getItemRecordCount(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM items').get() as { cnt: number };
  return row.cnt;
}

/** 返回 parts 记录数 */
export function getPartRecordCount(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM parts').get() as { cnt: number };
  return row.cnt;
}

/** 返回 products 记录数 */
export function getProductRecordCount(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM products').get() as { cnt: number };
  return row.cnt;
}

// ==================================================================
// #region 引用数据表 — 写入（事务性全量替换）
// ==================================================================

// -- exposed_colors ----------------------------------------------------------

/** 事务性全量替换 exposed_colors 表 */
export function replaceAllColors(entries: ColorEntry[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO exposed_colors (colorCode, colorText)
    VALUES (?, ?)
  `);

  db.transaction(() => {
    db.exec('DELETE FROM exposed_colors');
    for (const e of entries) {
      insert.run(e.code, e.name);
    }
  })();
}

// -- exposed_types -----------------------------------------------------------

/** 事务性全量替换 exposed_types 表 */
export function replaceAllTypes(entries: ShapeTypeEntry[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO exposed_types (shapeTypeCode, description)
    VALUES (?, ?)
  `);

  db.transaction(() => {
    db.exec('DELETE FROM exposed_types');
    for (const e of entries) {
      insert.run(e.code, e.description);
    }
  })();
}

// -- items -------------------------------------------------------------------

/** 事务性全量替换 items 表 */
export function replaceAllItems(rows: ItemRow[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO items
      (itemName, colorCode, shapeTypeCode, shapeSizeCode,
       doorPart, cabinetPart, extraPart)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.exec('DELETE FROM items');
    for (const r of rows) {
      insert.run(
        r.itemName, r.colorCode, r.shapeTypeCode, r.shapeSizeCode,
        r.doorPart, r.cabinetPart, r.extraPart,
      );
    }
  })();
}

// -- parts -------------------------------------------------------------------

/** 事务性全量替换 parts 表 */
export function replaceAllParts(rows: PartRow[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO parts (singlePartName, sharedPartName, description)
    VALUES (?, ?, ?)
  `);

  db.transaction(() => {
    db.exec('DELETE FROM parts');
    for (const r of rows) {
      insert.run(r.singlePartName, r.sharedPartName, r.description);
    }
  })();
}

// -- products ----------------------------------------------------------------

/** 事务性全量替换 products 表 */
export function replaceAllProducts(rows: ProductRow[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO products (name, forecastedQty, freeToUseQty, qtyOnHand)
    VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.exec('DELETE FROM products');
    for (const r of rows) {
      insert.run(r.name, r.forecastedQty, r.freeToUseQty, r.qtyOnHand);
    }
  })();
}

// ==================================================================
// #region 库存识别历史 (inventory_results)
// ==================================================================

/** 全局保留的最近识别结果条数 */
export const MAX_INVENTORY_RESULTS = 20;

/** 库存识别结果列表摘要 */
export interface InventoryResultSummary {
  id: number;
  jobId: string;
  source: string;
  completedAt: string;
  triggeredByName: string;
  triggeredById: number;
  threshold: number;
  trendThreshold: number;
  recentMonths: number;
  totalCleaned: number;
  lowStockCount: number;
  warningCount: number;
  reminderCount: number;
  infoCount: number;
  noAttentionCount: number;
}

/** 库存识别结果详情（含完整分类） */
export interface InventoryResultDetail extends InventoryResultSummary {
  classification: unknown;
}

/** 写入一条库存识别结果并裁剪到最近 MAX_INVENTORY_RESULTS 条（同事务） */
export function insertInventoryResult(input: {
  jobId: string;
  triggeredById: number;
  triggeredByName: string;
  source: 'auto' | 'upload';
  threshold: number;
  trendThreshold: number;
  recentMonths: number;
  totalCleaned: number;
  lowStockCount: number;
  warningCount: number;
  reminderCount: number;
  infoCount: number;
  noAttentionCount: number;
  classificationJson: string;
}): void {
  const insert = db.prepare(`
    INSERT INTO inventory_results
      (job_id, triggered_by_id, triggered_by_name, source, threshold,
       trend_threshold, recent_months, total_cleaned, low_stock_count,
       warning_count, reminder_count, info_count, no_attention_count,
       classification_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const trim = db.prepare(`
    DELETE FROM inventory_results
    WHERE id NOT IN (
      SELECT id FROM inventory_results
      ORDER BY completed_at DESC, id DESC
      LIMIT ?
    )
  `);

  db.transaction(() => {
    insert.run(
      input.jobId,
      input.triggeredById,
      input.triggeredByName,
      input.source,
      input.threshold,
      input.trendThreshold,
      input.recentMonths,
      input.totalCleaned,
      input.lowStockCount,
      input.warningCount,
      input.reminderCount,
      input.infoCount,
      input.noAttentionCount,
      input.classificationJson,
    );
    trim.run(MAX_INVENTORY_RESULTS);
  })();
}

/** 返回最近 MAX_INVENTORY_RESULTS 条识别结果摘要（不含完整分类 JSON） */
export function listInventoryResults(): InventoryResultSummary[] {
  return db.prepare(`
    SELECT id, job_id AS jobId, source, completed_at AS completedAt,
           triggered_by_name AS triggeredByName, triggered_by_id AS triggeredById,
           threshold, trend_threshold AS trendThreshold, recent_months AS recentMonths,
           total_cleaned AS totalCleaned, low_stock_count AS lowStockCount,
           warning_count AS warningCount, reminder_count AS reminderCount,
           info_count AS infoCount, no_attention_count AS noAttentionCount
    FROM inventory_results
    ORDER BY completed_at DESC, id DESC
    LIMIT ?
  `).all(MAX_INVENTORY_RESULTS) as InventoryResultSummary[];
}

/** 按 ID 返回单条识别结果详情（含完整分类） */
export function getInventoryResult(id: number): InventoryResultDetail | undefined {
  const row = db.prepare(`
    SELECT id, job_id AS jobId, source, completed_at AS completedAt,
           triggered_by_name AS triggeredByName, triggered_by_id AS triggeredById,
           threshold, trend_threshold AS trendThreshold, recent_months AS recentMonths,
           total_cleaned AS totalCleaned, low_stock_count AS lowStockCount,
           warning_count AS warningCount, reminder_count AS reminderCount,
           info_count AS infoCount, no_attention_count AS noAttentionCount,
           classification_json AS classificationJson
    FROM inventory_results
    WHERE id = ?
  `).get(id) as (InventoryResultSummary & { classificationJson: string }) | undefined;

  if (!row) return undefined;
  const { classificationJson, ...summary } = row;
  let classification: unknown = null;
  try {
    classification = JSON.parse(classificationJson);
  } catch {
    classification = null;
  }
  return { ...summary, classification };
}

// ==================================================================
// #region SKU 刷新元数据 (sku_refresh_metadata)
// ==================================================================

/** SKU 数据刷新元数据（单例） */
export interface SkuRefreshMetadata {
  activeGeneration: string | null;
  lastSuccessfulRefreshAt: string | null;
  source: string | null;
}

/** 读取刷新元数据；尚未刷新过时返回 undefined（lastSuccessfulRefreshAt 为空） */
export function getSkuRefreshMetadata(): SkuRefreshMetadata | undefined {
  return db.prepare(`
    SELECT active_generation AS activeGeneration,
           last_successful_refresh_at AS lastSuccessfulRefreshAt,
           source
    FROM sku_refresh_metadata
    WHERE id = 1
  `).get() as SkuRefreshMetadata | undefined;
}

/**
 * 记录一次成功刷新。
 * 仅在完整 refresh 发布后调用；失败刷新不更新，保留上一次成功值。
 */
export function setSkuRefreshSuccess(lastSuccessfulRefreshAt: string, source: string): void {
  db.prepare(`
    INSERT INTO sku_refresh_metadata (id, active_generation, last_successful_refresh_at, source)
    VALUES (1, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_successful_refresh_at = excluded.last_successful_refresh_at,
      source = excluded.source
  `).run(lastSuccessfulRefreshAt, source);
}
