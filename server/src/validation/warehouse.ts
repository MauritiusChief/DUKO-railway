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
