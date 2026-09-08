/**
 * 仓库扫码数据层 —— sku.sqlite 中的两张仓库业务表
 *
 * model_seri_num_mappings  型号序列号 ↔ SKU 全局一对一映射，
 *                          sku === model_seri_num 表示「待确认 SKU」占位映射
 * product_seri_num_records 产品序列号扫描记录，产品序列号全局唯一
 *
 * DDL 与 PRAGMA foreign_keys = ON 由 initSkuDB()（db/sku.ts）负责；
 * 时间一律为服务端 UTC ISO-8601 字符串（new Date().toISOString()）。
 *
 * 编辑语义：
 *  - updateScanRecord 只修改单条扫描记录；改到未知型号时在同一事务内
 *    创建「型号 -> 型号」占位映射，绝不批量修改其他记录或全局映射。
 *  - renameMappingModel 是全局重命名，借外键 ON UPDATE CASCADE 级联
 *    更新所有关联扫描记录，调用方须在 UI 层确认影响数量。
 */

import Database from 'better-sqlite3';
import { getSkuDb } from './sku.js';
import { normalizeSerial } from '../validation/warehouse.js';

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) db = getSkuDb();
  return db;
}

/** 型号序列号映射行 */
export interface ModelSeriNumMappingRow {
  model_seri_num: string;
  sku: string;
  created_at: string;
  updated_at: string;
}

/** 扫描记录（联表含映射 SKU） */
export interface ScanRecordWithSku {
  product_seri_num: string;
  model_seri_num: string;
  sku: string;
  scanned_at: string;
}

/** 汇总行：按 SKU（或型号占位）聚合的扫描数量 */
export interface ScanSummaryItem {
  model_seri_num: string;
  sku: string;
  count: number;
}

/** 占位映射：sku 与型号序列号相同，表示 SKU 待确认 */
export function isPlaceholderMapping(row: { model_seri_num: string; sku: string }): boolean {
  return row.sku.toUpperCase() === row.model_seri_num.toUpperCase();
}

/** 产品序列号重复冲突：携带已有记录摘要供 409 响应使用 */
export class DuplicateProductSeriNumError extends Error {
  constructor(public readonly existing: ScanRecordWithSku) {
    super('产品序列号已存在');
    this.name = 'DuplicateProductSeriNumError';
  }
}

/** 目标序列号已存在等唯一性冲突 */
export class WarehouseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarehouseConflictError';
  }
}

// ==================================================================
//  model_seri_num_mappings —— 全局映射 CRUD
// ==================================================================

/** 按型号序列号精确查找映射 */
export function getMappingByModel(modelSeriNum: string): ModelSeriNumMappingRow | undefined {
  return getDb()
    .prepare('SELECT model_seri_num, sku, created_at, updated_at FROM model_seri_num_mappings WHERE model_seri_num = ?')
    .get(normalizeSerial(modelSeriNum)) as ModelSeriNumMappingRow | undefined;
}

/** 按 SKU 大小写不敏感精确查找映射（一对一关系校验用） */
export function getMappingBySku(sku: string): ModelSeriNumMappingRow | undefined {
  return getDb()
    .prepare('SELECT model_seri_num, sku, created_at, updated_at FROM model_seri_num_mappings WHERE sku = ? COLLATE NOCASE')
    .get(normalizeSerial(sku)) as ModelSeriNumMappingRow | undefined;
}

/** 全量映射列表（按型号序列号排序） */
export function listMappings(): ModelSeriNumMappingRow[] {
  return getDb()
    .prepare('SELECT model_seri_num, sku, created_at, updated_at FROM model_seri_num_mappings ORDER BY model_seri_num ASC')
    .all() as ModelSeriNumMappingRow[];
}

/** 某型号序列号关联的扫描记录数（全局重命名前供 UI 显示影响数量） */
export function countScanRecordsByModel(modelSeriNum: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM product_seri_num_records WHERE model_seri_num = ?')
    .get(normalizeSerial(modelSeriNum)) as { cnt: number };
  return row.cnt;
}

/** 更新映射的 SKU（全局一对一；大小写不敏感唯一冲突由 SQLite 抛错） */
export function updateMappingSku(modelSeriNum: string, sku: string): ModelSeriNumMappingRow | undefined {
  const model = normalizeSerial(modelSeriNum);
  const result = getDb()
    .prepare('UPDATE model_seri_num_mappings SET sku = ?, updated_at = ? WHERE model_seri_num = ?')
    .run(normalizeSerial(sku), new Date().toISOString(), model);
  if (result.changes === 0) return undefined;
  return getMappingByModel(model);
}

/**
 * 全局重命名映射型号：外键 ON UPDATE CASCADE 同步更新所有关联扫描记录。
 * 目标型号已存在其他映射时抛 WarehouseConflictError；原映射不存在返回 undefined。
 */
export function renameMappingModel(
  oldModelSeriNum: string,
  newModelSeriNum: string,
): { mapping: ModelSeriNumMappingRow; affectedRecords: number } | undefined {
  const oldModel = normalizeSerial(oldModelSeriNum);
  const newModel = normalizeSerial(newModelSeriNum);
  if (oldModel === newModel) {
    const mapping = getMappingByModel(oldModel);
    return mapping ? { mapping, affectedRecords: 0 } : undefined;
  }

  const database = getDb();
  const tx = database.transaction(() => {
    const existing = getMappingByModel(newModel);
    if (existing) {
      throw new WarehouseConflictError('目标型号序列号已存在映射');
    }
    const affected = countScanRecordsByModel(oldModel);
    const result = database
      .prepare('UPDATE model_seri_num_mappings SET model_seri_num = ?, updated_at = ? WHERE model_seri_num = ?')
      .run(newModel, new Date().toISOString(), oldModel);
    if (result.changes === 0) return undefined;
    return { affectedRecords: affected };
  });

  const affected = tx();
  if (!affected) return undefined;
  return { mapping: getMappingByModel(newModel)!, affectedRecords: affected.affectedRecords };
}

// ==================================================================
//  product_seri_num_records —— 扫描记录 CRUD
// ==================================================================

const SCAN_RECORD_SELECT = `
  SELECT r.product_seri_num, r.model_seri_num, m.sku, r.scanned_at
  FROM product_seri_num_records r
  JOIN model_seri_num_mappings m ON m.model_seri_num = r.model_seri_num
`;

function getScanRecordStmt(): Database.Statement {
  return getDb().prepare(`${SCAN_RECORD_SELECT} WHERE r.product_seri_num = ?`);
}

/** 按产品序列号精确查找扫描记录（含映射 SKU） */
export function getScanRecord(productSeriNum: string): ScanRecordWithSku | undefined {
  return getScanRecordStmt().get(normalizeSerial(productSeriNum)) as ScanRecordWithSku | undefined;
}

/**
 * 写入一条扫描记录；映射不存在时在同一事务内创建「型号 -> 型号」占位映射。
 * 产品序列号重复时抛 DuplicateProductSeriNumError（携带原记录摘要），不改变任何数据。
 */
export function createScanRecord(productSeriNum: string, modelSeriNum: string): ScanRecordWithSku {
  const product = normalizeSerial(productSeriNum);
  const model = normalizeSerial(modelSeriNum);
  const now = new Date().toISOString();
  const database = getDb();

  const ensurePlaceholder = database.prepare(`
    INSERT OR IGNORE INTO model_seri_num_mappings (model_seri_num, sku, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const tx = database.transaction((): ScanRecordWithSku => {
    const existing = getScanRecordStmt().get(product) as ScanRecordWithSku | undefined;
    if (existing) throw new DuplicateProductSeriNumError(existing);

    ensurePlaceholder.run(model, model, now, now);
    database
      .prepare('INSERT INTO product_seri_num_records (product_seri_num, model_seri_num, scanned_at) VALUES (?, ?, ?)')
      .run(product, model, now);

    return getScanRecordStmt().get(product) as ScanRecordWithSku;
  });

  return tx();
}

/** LIKE 通配符转义（筛选按不区分大小写子串匹配，SQLite LIKE 对 ASCII 默认不区分大小写） */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ScanRecordFilters {
  /** SKU 子串筛选（大小写不敏感） */
  sku?: string;
  /** 型号序列号子串筛选 */
  modelSeriNum?: string;
  /** 产品序列号子串筛选 */
  productSeriNum?: string;
  /** UTC ISO-8601 起始（含） */
  scannedFrom?: string;
  /** UTC ISO-8601 截止（含） */
  scannedTo?: string;
  limit: number;
  offset: number;
}

/** 分页查询扫描记录：三列文本筛选按交集处理，时间按 UTC 边界比较 */
export function listScanRecords(filters: ScanRecordFilters): { total: number; items: ScanRecordWithSku[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.sku) {
    where.push('m.sku LIKE ? ESCAPE \'\\\'');
    params.push(`%${escapeLike(normalizeSerial(filters.sku))}%`);
  }
  if (filters.modelSeriNum) {
    where.push('r.model_seri_num LIKE ? ESCAPE \'\\\'');
    params.push(`%${escapeLike(normalizeSerial(filters.modelSeriNum))}%`);
  }
  if (filters.productSeriNum) {
    where.push('r.product_seri_num LIKE ? ESCAPE \'\\\'');
    params.push(`%${escapeLike(normalizeSerial(filters.productSeriNum))}%`);
  }
  if (filters.scannedFrom) {
    where.push('r.scanned_at >= ?');
    params.push(filters.scannedFrom);
  }
  if (filters.scannedTo) {
    where.push('r.scanned_at <= ?');
    params.push(filters.scannedTo);
  }

  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const database = getDb();

  const totalRow = database
    .prepare(`
      SELECT COUNT(*) AS cnt
      FROM product_seri_num_records r
      JOIN model_seri_num_mappings m ON m.model_seri_num = r.model_seri_num
     ${whereSql}
    `)
    .get(...params) as { cnt: number };

  const items = database
    .prepare(`
      ${SCAN_RECORD_SELECT}
     ${whereSql}
      ORDER BY r.scanned_at DESC, r.product_seri_num DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, filters.limit, filters.offset) as ScanRecordWithSku[];

  return { total: totalRow.cnt, items };
}

/**
 * 编辑单条扫描记录（仅影响该记录）：
 *  - modelSeriNum：改到未知型号时先在同一事务创建占位映射再更新本记录；
 *  - newProductSeriNum：修改产品序列号，目标已存在时抛 WarehouseConflictError。
 * 原记录不存在返回 undefined。
 */
export function updateScanRecord(
  productSeriNum: string,
  changes: { modelSeriNum?: string; newProductSeriNum?: string },
): ScanRecordWithSku | undefined {
  const product = normalizeSerial(productSeriNum);
  const now = new Date().toISOString();
  const database = getDb();

  const ensurePlaceholder = database.prepare(`
    INSERT OR IGNORE INTO model_seri_num_mappings (model_seri_num, sku, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const tx = database.transaction((): ScanRecordWithSku | undefined => {
    const row = getScanRecordStmt().get(product) as ScanRecordWithSku | undefined;
    if (!row) return undefined;

    const model =
      changes.modelSeriNum !== undefined ? normalizeSerial(changes.modelSeriNum) : row.model_seri_num;
    if (model !== row.model_seri_num) {
      ensurePlaceholder.run(model, model, now, now);
    }

    const newProduct =
      changes.newProductSeriNum !== undefined ? normalizeSerial(changes.newProductSeriNum) : product;
    if (newProduct !== product) {
      const taken = getScanRecordStmt().get(newProduct) as ScanRecordWithSku | undefined;
      if (taken) throw new WarehouseConflictError('目标产品序列号已存在');
    }

    database
      .prepare('UPDATE product_seri_num_records SET product_seri_num = ?, model_seri_num = ? WHERE product_seri_num = ?')
      .run(newProduct, model, product);

    return getScanRecordStmt().get(newProduct) as ScanRecordWithSku;
  });

  return tx();
}

/** 删除指定扫描记录（不删除映射），返回是否删除 */
export function deleteScanRecord(productSeriNum: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM product_seri_num_records WHERE product_seri_num = ?')
    .run(normalizeSerial(productSeriNum));
  return result.changes > 0;
}

/** 按时间范围（UTC，可省略任一边界）汇总各 SKU/型号占位的扫描数量 */
export function getScanSummary(scannedFrom?: string, scannedTo?: string): ScanSummaryItem[] {
  const database = getDb();
  const params: string[] = [];

  let sql = `
    SELECT m.model_seri_num, m.sku, COUNT(*) AS count
    FROM product_seri_num_records r
    JOIN model_seri_num_mappings m ON m.model_seri_num = r.model_seri_num
  `;
  if (scannedFrom) {
    sql += ' WHERE r.scanned_at >= ?';
    params.push(scannedFrom);
  }
  if (scannedTo) {
    sql += params.length > 0 ? ' AND r.scanned_at <= ?' : ' WHERE r.scanned_at <= ?';
    params.push(scannedTo);
  }
  sql += ' GROUP BY m.model_seri_num ORDER BY count DESC, m.model_seri_num ASC';

  return database.prepare(sql).all(...params) as ScanSummaryItem[];
}
