/**
 * 仓库扫码路由
 *
 * warehouseScanRouter —— POST /api/warehouse/scans（提交一组扫码）
 *   挂载点施加 warehouseScanLimiter（2000 次/15 分钟，现场盘点量高于通用限制）。
 *
 * warehouseRouter —— 管理端点，仅 manager / admin：
 *   GET    /api/warehouse/mappings                  —— 映射列表（含占位标记与关联记录数）
 *   PATCH  /api/warehouse/mappings/:modelSeriNum    —— 修改 SKU 或全局重命名型号（二选一）
 *   GET    /api/warehouse/scans                     —— 扫描记录三列交集筛选 + UTC 范围 + 分页
 *   PATCH  /api/warehouse/scans/:productSeriNum     —— 编辑单条记录（不传播到其他记录）
 *   DELETE /api/warehouse/scans/:productSeriNum     —— 删除单条记录（保留映射）
 *   GET    /api/warehouse/summary                   —— 按时间范围汇总 SKU/型号占位与数量
 *
 * 所有输入经 Zod 校验与服务端规范化；时间一律 UTC ISO-8601。
 */

import { Router, type Request, type Response } from 'express';
import { validate } from '../middleware/validate.js';
import { requireAnyRole } from '../middleware/auth.js';
import {
  isModelSeriNum,
  isProductSeriNum,
  normalizeSerial,
  warehouseScanSchema,
  warehouseScansQuerySchema,
  warehouseSummaryQuerySchema,
  warehouseUpdateMappingSchema,
  warehouseUpdateScanSchema,
} from '../validation/warehouse.js';
import {
  createScanRecord,
  deleteScanRecord,
  getScanSummary,
  isPlaceholderMapping,
  listMappingsWithCounts,
  listScanRecords,
  renameMappingModel,
  updateMappingSku,
  updateScanRecord,
  DuplicateProductSeriNumError,
  WarehouseConflictError,
} from '../db/warehouse.js';

export const warehouseScanRouter = Router();

/** PATCH /mappings/:modelSeriNum 与记录编辑响应体公共结构 */
interface MappingPayload {
  model_seri_num: string;
  sku: string;
  is_placeholder: boolean;
  record_count: number;
  created_at: string;
  updated_at: string;
}

function mappingPayload(row: {
  model_seri_num: string;
  sku: string;
  created_at: string;
  updated_at: string;
  record_count?: number;
}): MappingPayload {
  return {
    model_seri_num: row.model_seri_num,
    sku: row.sku,
    is_placeholder: isPlaceholderMapping(row),
    record_count: row.record_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 将 ZodError 转为人类可读字符串（query 参数不走 validate 中间件，就地格式化） */
function formatZodError(errors: { path: (string | number)[]; message: string }[]): string {
  return errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
}

/** 校验并规范化路径参数中的序列号，非法返回 null */
function parseSerialParam(
  value: string,
  isValid: (v: string) => boolean,
): string | null {
  const normalized = normalizeSerial(value);
  return isValid(normalized) ? normalized : null;
}

/** POST /api/warehouse/scans —— 提交型号 + 产品序列号；重复返回 409 与原记录摘要 */
warehouseScanRouter.post(
  '/',
  requireAnyRole('warehouse', 'manager', 'admin'),
  validate(warehouseScanSchema),
  (req: Request, res: Response) => {
    const { modelSeriNum, productSeriNum } = req.body as {
      modelSeriNum: string;
      productSeriNum: string;
    };

    try {
      const record = createScanRecord(productSeriNum, modelSeriNum);
      res.status(201).json({ record });
    } catch (err) {
      if (err instanceof DuplicateProductSeriNumError) {
        res.status(409).json({ error: '产品序列号已存在', existing: err.existing });
        return;
      }
      res.status(500).json({ error: '写入扫码记录失败' });
    }
  },
);

// ==================================================================
//  管理端点（manager / admin）
// ==================================================================

export const warehouseRouter = Router();
warehouseRouter.use(requireAnyRole('manager', 'admin'));

/** GET /api/warehouse/mappings —— 映射列表，含占位标记与关联记录数 */
warehouseRouter.get('/mappings', (_req: Request, res: Response) => {
  const mappings = listMappingsWithCounts().map(mappingPayload);
  res.json({ mappings });
});

/** PATCH /api/warehouse/mappings/:modelSeriNum —— 修改 SKU 或全局重命名型号 */
warehouseRouter.patch(
  '/mappings/:modelSeriNum',
  validate(warehouseUpdateMappingSchema),
  (req: Request, res: Response) => {
    const model = parseSerialParam(req.params.modelSeriNum, isModelSeriNum);
    if (!model) {
      res.status(400).json({ error: '无效的型号序列号' });
      return;
    }

    const { sku, newModelSeriNum } = req.body as {
      sku?: string;
      newModelSeriNum?: string;
    };

    try {
      if (newModelSeriNum !== undefined) {
        // 全局重命名：外键级联更新关联扫描记录
        const renamed = renameMappingModel(model, newModelSeriNum);
        if (!renamed) {
          res.status(404).json({ error: '映射不存在' });
          return;
        }
        res.json({
          mapping: mappingPayload(renamed.mapping),
          affected_records: renamed.affectedRecords,
        });
        return;
      }

      const updated = updateMappingSku(model, sku!);
      if (!updated) {
        res.status(404).json({ error: '映射不存在' });
        return;
      }
      res.json({ mapping: mappingPayload(updated), affected_records: 0 });
    } catch (err) {
      if (err instanceof WarehouseConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (isUniqueConstraintError(err)) {
        res.status(409).json({ error: 'SKU 已被其他型号序列号占用' });
        return;
      }
      res.status(500).json({ error: '更新映射失败' });
    }
  },
);

/** GET /api/warehouse/scans —— 三列交集筛选、UTC 时间范围与分页 */
warehouseRouter.get('/scans', (req: Request, res: Response) => {
  const parsed = warehouseScansQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: '查询参数校验失败', detail: formatZodError(parsed.error.errors) });
    return;
  }

  const { sku, modelSeriNum, productSeriNum, from, to, limit, offset } = parsed.data;
  const { total, items } = listScanRecords({
    sku,
    modelSeriNum,
    productSeriNum,
    scannedFrom: from,
    scannedTo: to,
    limit,
    offset,
  });
  res.json({ total, records: items });
});

/** PATCH /api/warehouse/scans/:productSeriNum —— 仅修改该记录的型号或产品序列号 */
warehouseRouter.patch(
  '/scans/:productSeriNum',
  validate(warehouseUpdateScanSchema),
  (req: Request, res: Response) => {
    const product = parseSerialParam(req.params.productSeriNum, isProductSeriNum);
    if (!product) {
      res.status(400).json({ error: '无效的产品序列号' });
      return;
    }

    const { modelSeriNum, newProductSeriNum } = req.body as {
      modelSeriNum?: string;
      newProductSeriNum?: string;
    };

    try {
      const updated = updateScanRecord(product, { modelSeriNum, newProductSeriNum });
      if (!updated) {
        res.status(404).json({ error: '扫描记录不存在' });
        return;
      }
      res.json({ record: updated });
    } catch (err) {
      if (err instanceof WarehouseConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: '更新扫描记录失败' });
    }
  },
);

/** DELETE /api/warehouse/scans/:productSeriNum —— 删除指定扫描记录（保留映射） */
warehouseRouter.delete('/scans/:productSeriNum', (req: Request, res: Response) => {
  const product = parseSerialParam(req.params.productSeriNum, isProductSeriNum);
  if (!product) {
    res.status(400).json({ error: '无效的产品序列号' });
    return;
  }

  if (!deleteScanRecord(product)) {
    res.status(404).json({ error: '扫描记录不存在' });
    return;
  }
  res.json({ message: '已删除' });
});

/** GET /api/warehouse/summary —— 按时间范围汇总 SKU（或型号占位）与数量 */
warehouseRouter.get('/summary', (req: Request, res: Response) => {
  const parsed = warehouseSummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: '查询参数校验失败', detail: formatZodError(parsed.error.errors) });
    return;
  }

  const { from, to } = parsed.data;
  const summary = getScanSummary(from, to).map((item) => ({
    model_seri_num: item.model_seri_num,
    sku: item.sku,
    is_placeholder: isPlaceholderMapping(item),
    count: item.count,
  }));
  res.json({ summary });
});

/** 判断是否为 SQLite 唯一约束冲突（如 SKU 大小写不敏感唯一） */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT');
}
