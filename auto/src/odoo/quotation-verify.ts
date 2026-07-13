/**
 * 报价单核验与读取
 *
 * 核验：
 *  - 标题报价单号与任务单号一致
 *  - 客户/公司不为空
 *  - 搜索结果非空（在 sales-search.ts 中处理，此处不重复）
 *
 * 读取：
 *  - 公司名（从 partner_id input 读取）
 *  - 已有行（产品型号 + 数量，从已保存行 td 读取）
 */

import type { Page } from 'playwright'
import {
  DETAIL_QUOTATION_NUMBER,
  DETAIL_PARTNER_INPUT,
  QUOTATION_TABLE,
  QUOTATION_DATA_ROW,
  DETAIL_PRODUCT_CELL,
  DETAIL_QUANTITY_CELL,
} from './selectors.js'

const TIMEOUT = 20_000

export interface QuotationSnapshotLine {
  productModel: string
  quantity: string
}

export interface QuotationVerification {
  quotationNumber: string
  company: string
  existingLines: QuotationSnapshotLine[]
}

/** 读取报价单详情页标题中的报价单号 */
export async function readQuotationNumber(page: Page): Promise<string> {
  const el = page.locator(DETAIL_QUOTATION_NUMBER).first()
  const text = await el.textContent({ timeout: TIMEOUT })
  return (text ?? '').trim()
}

/** 读取 partner_id 字段的公司名称 */
export async function readCompany(page: Page): Promise<string> {
  const input = page.locator(DETAIL_PARTNER_INPUT).first()
  try {
    const value = await input.inputValue({ timeout: TIMEOUT })
    return value.trim()
  } catch {
    // inputValue 对只读字段可能失败，回退到 textContent
    const text = await input.textContent({ timeout: TIMEOUT })
    return (text ?? '').trim()
  }
}

/** 读取报价单表格中已有的产品行（型号 + 数量） */
export async function readExistingLines(page: Page): Promise<QuotationSnapshotLine[]> {
  const rows = page.locator(`${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`)
  const rowCount = await rows.count()

  const lines: QuotationSnapshotLine[] = []

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i)

    const productEl = row.locator(DETAIL_PRODUCT_CELL)
    const productCount = await productEl.count()

    if (productCount === 0) continue

    const productModel = ((await productEl.textContent()) ?? '').trim()
    if (!productModel) continue

    const quantityEl = row.locator(DETAIL_QUANTITY_CELL)
    const quantityCount = await quantityEl.count()
    const quantity = quantityCount > 0
      ? ((await quantityEl.textContent()) ?? '').trim()
      : '0'

    lines.push({ productModel, quantity })
  }

  return lines
}

/**
 * 核验报价单：检查单号一致 + 客户不为空
 * 任一命中即抛出错误（调用方 catch 后转为 task-failed）
 */
export async function verifyQuotation(
  page: Page,
  expectedQuotationNumber: string,
): Promise<QuotationVerification> {
  const quotationNumber = await readQuotationNumber(page)

  if (!quotationNumber) {
    throw new Error('报价单号读取失败：页面标题未包含单号')
  }

  if (quotationNumber !== expectedQuotationNumber) {
    throw new Error(
      `报价单号核验不一致：期望 ${expectedQuotationNumber}，实际打开 ${quotationNumber}`,
    )
  }

  const company = await readCompany(page)
  if (!company) {
    throw new Error('报价单未填写客户/公司，请先在 Odoo 中填写后再启动')
  }

  const existingLines = await readExistingLines(page)

  return { quotationNumber, company, existingLines }
}
