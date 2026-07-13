/**
 * Odoo 销售列表页导航与搜索
 *
 * 负责从 Odoo 首页导航到 /odoo/sales、移除"My Quotations"过滤条件、
 * 搜索目标报价单并打开搜索结果。
 */

import type { Page } from 'playwright'
import { appConfig } from '../config.js'
import {
  SALES_SEARCH_INPUT,
  FACET_REMOVE_BUTTON,
  SALES_LIST_TABLE,
  SALES_DATA_ROW,
  SALES_NAME_CELL,
  DETAIL_QUOTATION_NUMBER,
} from './selectors.js'

const TIMEOUT = 30_000

/** 导航到 /odoo/sales 并等待列表渲染 */
export async function navigateToSales(page: Page): Promise<void> {
  const salesUrl = `${appConfig.odooBaseUrl.replace(/\/$/, '')}/sales`
  await page.goto(salesUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT * 2 })

  try {
    await page.waitForSelector(SALES_LIST_TABLE, { state: 'visible', timeout: TIMEOUT })
  } catch {
    throw new Error('导航到销售列表页失败：表格未渲染')
  }
}

/** 移除"My Quotations"过滤条件（否则搜不到他人创建的报价单） */
export async function removeMyQuotationsFacet(page: Page): Promise<void> {
  // 检查是否存在该 facet（如果不存在则直接返回，避免等待超时）
  const facetRemoves = page.locator(FACET_REMOVE_BUTTON)
  const count = await facetRemoves.count()

  for (let i = 0; i < count; i++) {
    await facetRemoves.nth(0).click()
    // 等待该 facet 从 DOM 中消失
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      FACET_REMOVE_BUTTON,
      { timeout: TIMEOUT / 2 },
    ).catch(() => {
      // 如果等待超时但 facet 已经移除了，不算错误
    })
  }
}

/** 在搜索栏输入报价单号并执行搜索 */
export async function searchQuotation(page: Page, quotationNumber: string): Promise<void> {
  const searchInput = page.locator(SALES_SEARCH_INPUT).first()

  await searchInput.waitFor({ state: 'visible', timeout: TIMEOUT })
  await searchInput.fill(quotationNumber)
  await searchInput.press('Enter')

  // 等待搜索结果出现（首行数据行渲染即表示搜索完成）
  const firstRow = page.locator(`${SALES_LIST_TABLE} ${SALES_DATA_ROW}`).first()
  await firstRow.waitFor({ state: 'visible', timeout: TIMEOUT })
}

/** 获取搜索结果行数 */
export async function getSearchResultCount(page: Page): Promise<number> {
  return page.locator(`${SALES_LIST_TABLE} ${SALES_DATA_ROW}`).count()
}

/** 点击首行报价单号，打开详情页 */
export async function openFirstResult(page: Page): Promise<void> {
  const firstNameCell = page.locator(`${SALES_LIST_TABLE} ${SALES_NAME_CELL}`).first()

  await firstNameCell.click()

  // 等待详情页标题渲染（确认页面已切换到表单视图）
  await page.waitForSelector(DETAIL_QUOTATION_NUMBER, {
    state: 'visible',
    timeout: TIMEOUT,
  })

  // 等待表单完全加载
  try {
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT / 2 })
  } catch {
    // networkidle 超时不影响后续操作
  }
}
