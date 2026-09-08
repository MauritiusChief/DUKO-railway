/**
 * Odoo 库存报表（/odoo/action-809）趋势查验流程
 *
 * 对每个低库存项目：
 *   1. 导航到 /odoo/action-809 并搜索项目名
 *   2. 在结果中点击 "ATL/Stock" 行的 History 按钮 → 跳转到库存移动页
 *   3. 提取配置月份内的库存移动（按日期倒序读到截止日期即停）
 *      location_id === ATL/Stock → 出库(out)；location_dest_id === ATL/Stock → 入库(in)
 *
 * 等待策略：搜索后等 facet + 数据行稳定；History 后等移动表渲染；不盲点、不翻页。
 */

import type { Page } from 'playwright'
import { appConfig } from '../config.js'
import type { TrendMove } from '../protocol.js'
import {
  INVENTORY_SEARCH_INPUT,
  INVENTORY_DATA_ROW,
  INVENTORY_LOCATION_CELL,
  INVENTORY_HISTORY_BUTTON,
  STOCK_MOVE_DATA_ROW,
  STOCK_MOVE_DATE_CELL,
  STOCK_MOVE_LOCATION_CELL,
  STOCK_MOVE_DEST_CELL,
  STOCK_MOVE_QTY_CELL,
  INVENTORY_FACET_VALUE,
} from './selectors.js'

const TIMEOUT = 30_000
const SETTLE_POLL_MS = 200

/** 主仓库（仅查验该库位的出入库趋势） */
const WAREHOUSE = 'ATL/Stock'

// ==================================================================
//  导航与搜索
// ==================================================================

/** 导航到 /odoo/action-809 并等待搜索框就绪 */
async function navigateToInventoryReport(page: Page): Promise<void> {
  const url = `${appConfig.odooBaseUrl.replace(/\/$/, '')}/action-809`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT * 2 })

  try {
    await page.waitForSelector(INVENTORY_SEARCH_INPUT, { state: 'visible', timeout: TIMEOUT })
  } catch {
    throw new Error('导航到库存报表失败：搜索框未渲染')
  }
}

/**
 * 搜索项目名并等待结果稳定。
 * 等待 facet 出现 + 数据行数量连续两次不变（避免捕捉刷新中途状态）。
 */
async function searchItem(page: Page, itemName: string): Promise<void> {
  const input = page.locator(INVENTORY_SEARCH_INPUT).first()
  await input.waitFor({ state: 'visible', timeout: TIMEOUT })
  await input.fill(itemName)
  await input.press('Enter')

  // 等 facet 出现（Odoo 即使无结果也会加上搜索词 facet）
  await page
    .locator(INVENTORY_FACET_VALUE)
    .filter({ hasText: itemName.trim() })
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT })
    .catch(() => {
      // facet 未出现也继续（某些情况下可能仅刷新表格）
    })

  // 等数据行稳定
  await waitForRowsStable(page)
}

/** 轮询直到数据行数量稳定（连续两次相同）或超时 */
async function waitForRowsStable(page: Page): Promise<void> {
  const deadline = Date.now() + TIMEOUT
  let prev = -1
  let stableCount = 0
  while (Date.now() < deadline) {
    const count = await page.locator(INVENTORY_DATA_ROW).count()
    if (count === prev) {
      stableCount += 1
      if (stableCount >= 2) return
    } else {
      stableCount = 0
    }
    prev = count
    await page.waitForTimeout(SETTLE_POLL_MS)
  }
}

// ==================================================================
//  点击 History
// ==================================================================

/**
 * 找到 ATL/Stock 行并点击其 History 按钮。
 * @returns 是否成功点击（无 ATL/Stock 行则返回 false）
 */
async function clickHistoryForWarehouse(page: Page): Promise<boolean> {
  const rows = page.locator(INVENTORY_DATA_ROW)
  const count = await rows.count()

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i)
    const locCell = row.locator(INVENTORY_LOCATION_CELL).first()
    const locText = ((await locCell.textContent()) ?? '').trim()
    if (locText !== WAREHOUSE) continue

    // 命中目标库位行 → 点击其 History 按钮
    const historyBtn = row.locator(INVENTORY_HISTORY_BUTTON).first()
    await historyBtn.waitFor({ state: 'visible', timeout: TIMEOUT })
    await historyBtn.click()
    return true
  }
  return false
}

// ==================================================================
//  提取库存移动
// ==================================================================

/** 解析 Odoo 日期文本 "MM/DD/YYYY HH:mm:ss" → Date；失败返回 null */
function parseOdooDate(text: string): Date | null {
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6])
}

/** 等待库存移动表渲染（出现 date cell 即确认已跳转到移动页且至少有一行） */
async function waitForMoveTable(page: Page): Promise<void> {
  // date cell 仅存在于库存移动表，可区分旧报表表
  await page
    .waitForSelector(STOCK_MOVE_DATE_CELL, { state: 'visible', timeout: 15_000 })
    .catch(() => {
      // 超时说明该项目无库存移动（空表），extractMoves 将返回空数组
    })
}

/**
 * 从当前库存移动表提取指定月份内的出入库记录。
 * 假设列表按日期倒序：遇到截止日期前的行即停止。
 */
async function extractMoves(page: Page, recentMonths: number): Promise<TrendMove[]> {
  const raw = await page.evaluate(
    ({ rowSel, dateSel, locSel, destSel, qtySel }) => {
      const rows = Array.from(document.querySelectorAll(rowSel))
      return rows.map((tr) => ({
        date: (tr.querySelector(dateSel)?.textContent ?? '').trim(),
        location: (tr.querySelector(locSel)?.textContent ?? '').trim(),
        dest: (tr.querySelector(destSel)?.textContent ?? '').trim(),
        qty: (tr.querySelector(qtySel)?.textContent ?? '').trim(),
      }))
    },
    {
      rowSel: STOCK_MOVE_DATA_ROW,
      dateSel: STOCK_MOVE_DATE_CELL,
      locSel: STOCK_MOVE_LOCATION_CELL,
      destSel: STOCK_MOVE_DEST_CELL,
      qtySel: STOCK_MOVE_QTY_CELL,
    },
  )

  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - recentMonths)

  const moves: TrendMove[] = []
  for (const r of raw) {
    const d = parseOdooDate(r.date)
    if (!d) continue
    // 按倒序假设：遇到早于截止的行即停止
    if (d < cutoff) break

    const qty = parseFloat(r.qty)
    if (isNaN(qty)) continue

    let dir: 'in' | 'out' | null = null
    if (r.dest === WAREHOUSE) dir = 'in'
    else if (r.location === WAREHOUSE) dir = 'out'
    if (dir === null) continue // 与目标库位无关的移动，忽略

    moves.push({ date: r.date, qty, dir })
  }
  return moves
}

// ==================================================================
//  单项查验
// ==================================================================

/**
 * 查验单个项目的库存移动趋势。
 * @returns 该项目指定月份内的出入库记录（无 ATL/Stock 行或无移动则返回空数组）
 */
export async function extractTrendForItem(
  page: Page,
  itemName: string,
  recentMonths: number,
  onProgress: (m: string) => Promise<void>,
): Promise<TrendMove[]> {
  await navigateToInventoryReport(page)

  await onProgress(`TREND: 搜索 ${itemName}`)
  await searchItem(page, itemName)

  const rowsCount = await page.locator(INVENTORY_DATA_ROW).count()
  if (rowsCount === 0) {
    await onProgress(`TREND: ${itemName} 无库存报表数据`)
    return []
  }

  const clicked = await clickHistoryForWarehouse(page)
  if (!clicked) {
    await onProgress(`TREND: ${itemName} 无 ${WAREHOUSE} 库位`)
    return []
  }

  await waitForMoveTable(page)
  const moves = await extractMoves(page, recentMonths)
  await onProgress(`TREND: ${itemName} 提取到 ${moves.length} 条移动`)
  return moves
}
