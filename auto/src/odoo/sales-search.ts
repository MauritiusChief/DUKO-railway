/**
 * Odoo 销售列表页导航与搜索
 *
 * 负责从 Odoo 首页导航到 /odoo/sales、移除"My Quotations"过滤条件、
 * 搜索目标报价单并打开精确匹配的搜索结果。
 */

import type { Page } from 'playwright'
import { appConfig } from '../config.js'
import {
  SALES_SEARCH_INPUT,
  SALES_FACET,
  SALES_FACET_VALUE,
  FACET_REMOVE_BUTTON,
  SALES_LIST_TABLE,
  SALES_DATA_ROW,
  SALES_NAME_CELL,
  DETAIL_QUOTATION_NUMBER,
} from './selectors.js'

const TIMEOUT = 30_000

/** 搜索结果等待的轮询间隔 */
const SETTLE_POLL_INTERVAL_MS = 150

/** 转义字符串为正则的字面量 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 构建仅匹配某个单号（trim 后相等）的正则 */
function exactMatchRegex(value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegex(value.trim())}\\s*$`)
}

// ==================================================================
//  导航
// ==================================================================

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

// ==================================================================
//  移除 "My Quotations" facet
// ==================================================================

/** 仅移除"My Quotations"过滤条件，保留用户主动设置的其他筛选 */
export async function removeMyQuotationsFacet(page: Page): Promise<void> {
  const TARGET_LABEL = 'My Quotations'

  const facets = page.locator(SALES_FACET)
  const count = await facets.count()

  for (let i = 0; i < count; i++) {
    const facet = facets.nth(i)
    const valueEl = facet.locator(SALES_FACET_VALUE)
    if ((await valueEl.count()) === 0) continue

    const text = ((await valueEl.first().textContent()) ?? '').trim()
    if (text !== TARGET_LABEL) continue

    // 命中目标 facet：点击它的移除按钮，等待该容器 detached（不等待其他 facet）
    await facet.locator(FACET_REMOVE_BUTTON).first().click()
    await facet.waitFor({ state: 'detached', timeout: TIMEOUT / 2 }).catch(() => {
      // detach 检测失败时降级为检查其标签是否已消失
    })
    return
  }

  // 目标 facet 不存在，立即返回
}

// ==================================================================
//  搜索
// ==================================================================

/** 搜索前对当前列表做一次可识别快照，用于判断搜索后表格是否已刷新 */
async function captureTableSignature(page: Page): Promise<{
  rowCount: number
  firstRowName: string
}> {
  return page.evaluate(
    ({ tableSel, rowSel, nameCellSel }) => {
      const table = document.querySelector(tableSel)
      if (!table) return { rowCount: 0, firstRowName: '' }
      const rows = table.querySelectorAll(rowSel)
      const firstRowName =
        rows.length > 0
          ? ((rows[0].querySelector(nameCellSel)?.textContent ?? '') as string).trim()
          : ''
      return { rowCount: rows.length, firstRowName }
    },
    { tableSel: SALES_LIST_TABLE, rowSel: SALES_DATA_ROW, nameCellSel: SALES_NAME_CELL },
  )
}

/** 读取当前列表状态：行数、首行单号、是否存在精确匹配行 */
async function readTableState(
  page: Page,
  target: string,
): Promise<{ rowCount: number; firstRowName: string; exactMatch: boolean }> {
  return page.evaluate(
    ({ tableSel, rowSel, nameCellSel, target }) => {
      const table = document.querySelector(tableSel)
      if (!table) return { rowCount: 0, firstRowName: '', exactMatch: false }
      const rows = Array.from(table.querySelectorAll(rowSel))
      let exactMatch = false
      for (const tr of rows) {
        const cell = tr.querySelector(nameCellSel)
        if (cell && ((cell.textContent ?? '') as string).trim() === target) {
          exactMatch = true
          break
        }
      }
      const firstRowName =
        rows.length > 0
          ? ((rows[0].querySelector(nameCellSel)?.textContent ?? '') as string).trim()
          : ''
      return { rowCount: rows.length, firstRowName, exactMatch }
    },
    { tableSel: SALES_LIST_TABLE, rowSel: SALES_DATA_ROW, nameCellSel: SALES_NAME_CELL, target },
  )
}

/**
 * 等待搜索结果稳定：精确匹配行出现 OR 列表确认为空（相对搜索前快照已变化）。
 * 为避免捕捉刷新中途的瞬时空表，空状态需连续两次观察到才确认。
 */
async function waitForSearchSettled(
  page: Page,
  target: string,
  snapshot: { rowCount: number; firstRowName: string },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let emptyConfirmed = false

  while (Date.now() < deadline) {
    const state = await readTableState(page, target)

    if (state.exactMatch) return

    const stateChanged =
      state.rowCount !== snapshot.rowCount || state.firstRowName !== snapshot.firstRowName
    if (stateChanged && state.rowCount === 0) {
      if (emptyConfirmed) return // 连续两次空 → 确认无结果
      emptyConfirmed = true
    } else {
      emptyConfirmed = false
    }

    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS)
  }

  throw new Error(`搜索结果未在 ${Math.round(timeoutMs / 1000)}s 内稳定（目标单号 ${target}）`)
}

/** 在搜索栏输入报价单号并执行搜索，等待结果稳定 */
export async function searchQuotation(page: Page, quotationNumber: string): Promise<void> {
  const searchInput = page.locator(SALES_SEARCH_INPUT).first()
  await searchInput.waitFor({ state: 'visible', timeout: TIMEOUT })

  const snapshot = await captureTableSignature(page)

  await searchInput.fill(quotationNumber)
  await searchInput.press('Enter')

  await waitForSearchSettled(page, quotationNumber.trim(), snapshot, TIMEOUT / 2)
}

// ==================================================================
//  精确匹配定位与打开
// ==================================================================

/** 精确匹配目标单号的列表行单号 cell 定位器（trim 后严格相等） */
export function exactMatchCell(page: Page, quotationNumber: string) {
  return page
    .locator(`${SALES_LIST_TABLE} ${SALES_NAME_CELL}`)
    .filter({ hasText: exactMatchRegex(quotationNumber) })
}

/** 获取精确匹配目标单号的结果行数 */
export async function countExactMatches(page: Page, quotationNumber: string): Promise<number> {
  return exactMatchCell(page, quotationNumber).count()
}

/** 点击精确匹配目标单号的第一行，打开详情页 */
export async function openExactMatch(page: Page, quotationNumber: string): Promise<void> {
  const cell = exactMatchCell(page, quotationNumber).first()
  await cell.waitFor({ state: 'visible', timeout: TIMEOUT })
  await cell.click()

  // 等待详情页标题渲染（确认已切换到表单视图）；不使用 networkidle
  await page.waitForSelector(DETAIL_QUOTATION_NUMBER, { state: 'visible', timeout: TIMEOUT })
}
