/**
 * 仓库扫码 —— 序列号格式与规范化
 *
 * 格式与 experiment/warehouse_count_helper_cn.html 原型保持一致（服务端固定规则，
 * 不以导入 JSON 中 formats 元数据替代）：
 *   型号序列号: DK-CA-002919        ^[A-Z]{2}-[A-Z]{2}-\d{6}$
 *   产品序列号: DK-P0016073-347836  ^[A-Z]{2}-[A-Z0-9]{8}-\d{6}$
 *
 * 所有序列号入库前先经 normalizeSerial 规范化（trim + 大写）。
 */

import { z } from 'zod';

/** 型号序列号格式，例如 DK-CA-002919 */
export const MODEL_SERI_NUM_RE = /^[A-Z]{2}-[A-Z]{2}-\d{6}$/;

/** 产品序列号格式，例如 DK-P0016073-347836 */
export const PRODUCT_SERI_NUM_RE = /^[A-Z]{2}-[A-Z0-9]{8}-\d{6}$/;

/** 序列号规范化：去除首尾空白并转为大写 */
export function normalizeSerial(value: string): string {
  return value.trim().toUpperCase();
}

/** 是否为合法型号序列号（假定已规范化） */
export function isModelSeriNum(value: string): boolean {
  return MODEL_SERI_NUM_RE.test(value);
}

/** 是否为合法产品序列号（假定已规范化） */
export function isProductSeriNum(value: string): boolean {
  return PRODUCT_SERI_NUM_RE.test(value);
}

/** Zod：型号序列号（规范化后校验格式） */
export const modelSeriNumSchema = z
  .string()
  .transform(normalizeSerial)
  .pipe(z.string().regex(MODEL_SERI_NUM_RE, '型号序列号格式不正确'));

/** Zod：产品序列号（规范化后校验格式） */
export const productSeriNumSchema = z
  .string()
  .transform(normalizeSerial)
  .pipe(z.string().regex(PRODUCT_SERI_NUM_RE, '产品序列号格式不正确'));

/**
 * 将任意时间输入规范化为 UTC ISO-8601 字符串，无效时返回 null。
 * 用于 JSON 导入等外部时间来源；合法示例 '2026-09-08T08:30:00.000Z'。
 */
export function toUtcIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ==================================================================
//  仓库 API 请求 schema（body 经 validate 中间件解析，query 在路由内 safeParse）
// ==================================================================

/** SKU 字符串：规范化后非空 */
export const warehouseSkuSchema = z
  .string()
  .transform(normalizeSerial)
  .pipe(z.string().min(1, 'SKU 不能为空'));

/** 可解析为时间的字符串，转换为 UTC ISO-8601 */
const utcIsoSchema = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), '无效的时间格式')
  .transform((v) => new Date(v).toISOString());

/** POST /api/warehouse/scans —— 提交一组扫码（型号 + 产品） */
export const warehouseScanSchema = z.object({
  modelSeriNum: modelSeriNumSchema,
  productSeriNum: productSeriNumSchema,
});

/** PATCH /api/warehouse/mappings/:modelSeriNum —— 修改 SKU 或全局重命名型号（二选一） */
export const warehouseUpdateMappingSchema = z
  .object({
    sku: warehouseSkuSchema.optional(),
    newModelSeriNum: modelSeriNumSchema.optional(),
  })
  .refine((v) => (v.sku !== undefined) !== (v.newModelSeriNum !== undefined), {
    message: '只能修改 SKU 或型号序列号之一',
  });

/** GET /api/warehouse/scans —— 筛选/分页查询参数 */
export const warehouseScansQuerySchema = z.object({
  sku: z.string().min(1).optional(),
  modelSeriNum: z.string().min(1).optional(),
  productSeriNum: z.string().min(1).optional(),
  from: utcIsoSchema.optional(),
  to: utcIsoSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /api/warehouse/summary —— 汇总时间范围参数 */
export const warehouseSummaryQuerySchema = z.object({
  from: utcIsoSchema.optional(),
  to: utcIsoSchema.optional(),
});

/** PATCH /api/warehouse/scans/:productSeriNum —— 编辑单条记录（至少提供一项） */
export const warehouseUpdateScanSchema = z
  .object({
    modelSeriNum: modelSeriNumSchema.optional(),
    newProductSeriNum: productSeriNumSchema.optional(),
  })
  .refine((v) => v.modelSeriNum !== undefined || v.newProductSeriNum !== undefined, {
    message: '至少提供型号序列号或产品序列号之一',
  });
