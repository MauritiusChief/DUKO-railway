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

/** 映射行 + 关联扫描记录数（全局重命名前供 UI 显示影响数量） */
export interface ModelSeriNumMappingWithCount extends ModelSeriNumMappingRow {
  record_count: number;
}

/** 全量映射列表（含关联扫描记录数，按型号序列号排序） */
export function listMappingsWithCounts(): ModelSeriNumMappingWithCount[] {
  return getDb()
    .prepare(`
      SELECT m.model_seri_num, m.sku, m.created_at, m.updated_at,
             COUNT(r.product_seri_num) AS record_count
      FROM model_seri_num_mappings m
      LEFT JOIN product_seri_num_records r ON r.model_seri_num = m.model_seri_num
      GROUP BY m.model_seri_num
      ORDER BY m.model_seri_num ASC
    `)
    .all() as ModelSeriNumMappingWithCount[];
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

// ==================================================================
//  JSON 导入 —— 原型 warehouse-count-helper 导出文件
// ==================================================================

/** 导入记录（schema 层已规范化并转换时间为 UTC ISO） */
export interface ImportRecordInput {
  sku?: string;
  model: string;
  product: string;
  createdAt: string;
}

/** 产品序列号内容冲突（库中已有同号但型号/时间不同） */
export interface ImportProductConflict {
  product: string;
  existingModel: string;
  existingScannedAt: string;
  importedModel: string;
  importedScannedAt: string;
}

/** 映射 SKU 冲突（库中已有该型号的非占位映射且 SKU 不同） */
export interface ImportMappingConflict {
  model: string;
  existingSku: string;
  importedSku: string;
}

/** 按「全部采用导入映射」假设推演后仍存在的 SKU 一对一冲突（硬错误） */
export interface ImportSkuCollision {
  sku: string;
  models: string[];
}

/** 导入预检分析结果 */
export interface ImportAnalysis {
  existingRecordCount: number;
  existingMappingCount: number;
  recordCount: number;
  newCount: number;
  identicalCount: number;
  upgrades: number;
  productConflicts: ImportProductConflict[];
  mappingConflicts: ImportMappingConflict[];
  skuCollisions: ImportSkuCollision[];
}

/** 从导入记录推导 型号 → SKU 映射；SKU 为空视为 model -> model 占位 */
function deriveImportMappings(records: ImportRecordInput[]): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const r of records) {
    const sku = r.sku && r.sku.trim() ? normalizeSerial(r.sku) : r.model;
    mappings.set(r.model, sku);
  }
  return mappings;
}

/** 校验导入文件内部一致性，返回错误列表（空数组 = 通过） */
export function checkImportInternal(records: ImportRecordInput[]): string[] {
  const errors: string[] = [];
  const products = new Set<string>();
  const modelSkus = new Map<string, Set<string>>();
  const skuModels = new Map<string, Set<string>>();

  for (const r of records) {
    if (products.has(r.product)) {
      errors.push(`产品序列号在文件中重复: ${r.product}`);
    }
    products.add(r.product);

    const sku = r.sku && r.sku.trim() ? normalizeSerial(r.sku) : r.model;
    if (!modelSkus.has(r.model)) modelSkus.set(r.model, new Set());
    modelSkus.get(r.model)!.add(sku);
    if (!skuModels.has(sku)) skuModels.set(sku, new Set());
    skuModels.get(sku)!.add(r.model);
  }

  for (const [model, skus] of modelSkus) {
    if (skus.size > 1) errors.push(`型号 ${model} 在文件中对应多个 SKU: ${[...skus].join(', ')}`);
  }
  for (const [sku, models] of skuModels) {
    if (models.size > 1) errors.push(`SKU ${sku} 在文件中对应多个型号: ${[...models].join(', ')}`);
  }
  return errors;
}

/** 导入预检：对比导入数据与现有库内容，产出预览与冲突清单 */
export function analyzeImport(records: ImportRecordInput[]): ImportAnalysis {
  const database = getDb();
  const derived = deriveImportMappings(records);

  const existingRecordCount = (
    database.prepare('SELECT COUNT(*) AS cnt FROM product_seri_num_records').get() as { cnt: number }
  ).cnt;
  const existingMappingCount = (
    database.prepare('SELECT COUNT(*) AS cnt FROM model_seri_num_mappings').get() as { cnt: number }
  ).cnt;

  let newCount = 0;
  let identicalCount = 0;
  const productConflicts: ImportProductConflict[] = [];
  for (const r of records) {
    const existing = getScanRecord(r.product);
    if (!existing) {
      newCount++;
    } else if (existing.model_seri_num === r.model && existing.scanned_at === r.createdAt) {
      identicalCount++;
    } else {
      productConflicts.push({
        product: r.product,
        existingModel: existing.model_seri_num,
        existingScannedAt: existing.scanned_at,
        importedModel: r.model,
        importedScannedAt: r.createdAt,
      });
    }
  }

  let upgrades = 0;
  const mappingConflicts: ImportMappingConflict[] = [];
  for (const [model, sku] of derived) {
    const existing = getMappingByModel(model);
    if (!existing || existing.sku.toUpperCase() === sku) continue;
    if (isPlaceholderMapping(existing)) {
      upgrades++;
    } else {
      mappingConflicts.push({ model, existingSku: existing.sku, importedSku: sku });
    }
  }

  // 按「全部采用导入映射」推演最终映射状态，找出仍会破坏一对一的 SKU
  const finalModelSku = new Map<string, string>();
  for (const m of listMappings()) finalModelSku.set(m.model_seri_num, m.sku.toUpperCase());
  for (const [model, sku] of derived) {
    finalModelSku.set(model, sku);
  }
  const bySku = new Map<string, string[]>();
  for (const [model, sku] of finalModelSku) {
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku)!.push(model);
  }
  const skuCollisions: ImportSkuCollision[] = [];
  for (const [sku, models] of bySku) {
    if (models.length > 1) skuCollisions.push({ sku, models });
  }

  return {
    existingRecordCount,
    existingMappingCount,
    recordCount: records.length,
    newCount,
    identicalCount,
    upgrades,
    productConflicts,
    mappingConflicts,
    skuCollisions,
  };
}

/** 替换导入：单一事务内清空并写入两表，任何错误整体回滚 */
export function applyImportReplace(records: ImportRecordInput[]): { mappings: number; records: number } {
  const database = getDb();
  const derived = deriveImportMappings(records);
  const now = new Date().toISOString();

  const insertMapping = database.prepare(`
    INSERT INTO model_seri_num_mappings (model_seri_num, sku, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertRecord = database.prepare(`
    INSERT INTO product_seri_num_records (product_seri_num, model_seri_num, scanned_at)
    VALUES (?, ?, ?)
  `);

  const tx = database.transaction(() => {
    database.prepare('DELETE FROM product_seri_num_records').run();
    database.prepare('DELETE FROM model_seri_num_mappings').run();
    for (const [model, sku] of derived) {
      insertMapping.run(model, sku, now, now);
    }
    for (const r of records) {
      insertRecord.run(r.product, r.model, r.createdAt);
    }
    return { mappings: derived.size, records: records.length };
  });

  return tx();
}

/** 合并导入的写入结果统计 */
export interface ImportMergeResult {
  mappingsAdded: number;
  mappingsUpdated: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * 合并导入：内容完全相同的记录跳过；产品内容不同或映射 SKU 冲突按决策处理
 * （'adopt' 覆盖，其余保留现有）；现有占位映射自动升级为导入 SKU。
 * 最终映射状态违反 SKU 一对一时抛 WarehouseConflictError 并整体回滚。
 */
export function applyImportMerge(
  records: ImportRecordInput[],
  productDecisions: Record<string, 'keep' | 'adopt'>,
  mappingDecisions: Record<string, 'keep' | 'adopt'>,
): ImportMergeResult {
  const database = getDb();
  const derived = deriveImportMappings(records);
  const now = new Date().toISOString();

  const insertMapping = database.prepare(`
    INSERT INTO model_seri_num_mappings (model_seri_num, sku, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const updateMappingSkuStmt = database.prepare(`
    UPDATE model_seri_num_mappings SET sku = ?, updated_at = ? WHERE model_seri_num = ?
  `);
  const insertRecord = database.prepare(`
    INSERT INTO product_seri_num_records (product_seri_num, model_seri_num, scanned_at)
    VALUES (?, ?, ?)
  `);
  const updateRecord = database.prepare(`
    UPDATE product_seri_num_records SET model_seri_num = ?, scanned_at = ? WHERE product_seri_num = ?
  `);

  const tx = database.transaction((): ImportMergeResult => {
    // sku → 持有该 SKU 的型号（决策落定后的最终占用状态）
    const finalSkus = new Map<string, string>();
    for (const m of listMappings()) finalSkus.set(m.sku.toUpperCase(), m.model_seri_num);

    const claimSku = (model: string, sku: string, release: string | undefined) => {
      const owner = finalSkus.get(sku);
      if (owner !== undefined && owner !== model) {
        throw new WarehouseConflictError(`SKU ${sku} 已被型号 ${owner} 占用，未写入任何数据`);
      }
      if (release !== undefined && release !== sku) finalSkus.delete(release);
      finalSkus.set(sku, model);
    };

    let mappingsAdded = 0;
    let mappingsUpdated = 0;
    for (const [model, sku] of derived) {
      const existing = getMappingByModel(model);
      if (!existing) {
        claimSku(model, sku, undefined);
        insertMapping.run(model, sku, now, now);
        mappingsAdded++;
      } else if (existing.sku.toUpperCase() !== sku) {
        if (isPlaceholderMapping(existing) || mappingDecisions[model] === 'adopt') {
          claimSku(model, sku, existing.sku.toUpperCase());
          updateMappingSkuStmt.run(sku, now, model);
          mappingsUpdated++;
        }
        // 其余情况保留现有映射
      }
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const r of records) {
      const existing = getScanRecord(r.product);
      if (!existing) {
        insertRecord.run(r.product, r.model, r.createdAt);
        inserted++;
      } else if (existing.model_seri_num === r.model && existing.scanned_at === r.createdAt) {
        skipped++;
      } else if (productDecisions[r.product] === 'adopt') {
        updateRecord.run(r.model, r.createdAt, r.product);
        updated++;
      } else {
        skipped++;
      }
    }

    return { mappingsAdded, mappingsUpdated, inserted, updated, skipped };
  });

  return tx();
}
