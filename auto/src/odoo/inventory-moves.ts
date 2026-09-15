/**
 * Odoo 库存调动历史（stock.move.line 全局列表）同步流程
 *
 * 直达 URL：{ODOO_BASE_URL}/action-809/197381/action-393（维护者已验证可直达）。
 * 动作默认自带 "Status: Done" facet——这是数据语义的一部分（只同步已完成调动），
 * 不做任何 facet 清理。
 * 流程：
 *   1. 搜索 "ATL/Stock" → 选 autocomplete "Search Location for:"（同时覆盖 From 与 To），
 *      与默认 Done facet 叠加为 Done + ATL/Stock
 *   2. Date 列降序排序（最多点两次，以页面首尾行日期校验为准，不依赖 caret class）
 *   3. 逐页提取 → onBatch 回调；整页早于 cutoffTs 且确为降序时停止，
 *      否则翻页；末页（next 不可点）停止
 *
 * 等待策略：不盲点，等待 pager 值变化 + 数据行稳定（沿用 trend 流程约定）。
 */

import type { Page } from 'playwright'
import { appConfig } from '../config.js'
import type { MoveRow } from '../protocol.js'
import {
  INVENTORY_SEARCH_INPUT,
  INVENTORY_FACET_VALUE,
  STOCK_MOVE_DATA_ROW,
  STOCK_MOVE_DATE_CELL,
  STOCK_MOVE_LOCATION_CELL,
  STOCK_MOVE_DEST_CELL,
  STOCK_MOVE_QTY_CELL,
  MOVES_AUTOCOMPLETE_ITEM,
  MOVES_DATE_HEADER,
  MOVES_PAGER_VALUE,
  MOVES_PAGER_NEXT,
} from './selectors.js'

const TIMEOUT = 30_000
const SETTLE_POLL_MS = 200

/** 主仓库（仅同步该库位相关的调动） */
const WAREHOUSE = 'ATL/Stock'

/** stock.move.line 全局列表直达路径（含动作与记录 id） */
const MOVES_LIST_PATH = '/action-809/197381/action-393'

// ==================================================================
//  导航与筛选
// ==================================================================

/** 导航到 stock.move.line 全局列表并等待搜索框就绪 */
async function navigateToMovesList(page: Page): Promise<void> {
  const url = `${appConfig.odooBaseUrl.replace(/\/$/, '')}${MOVES_LIST_PATH}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT * 2 })

  try {
    await page.waitForSelector(INVENTORY_SEARCH_INPUT, { state: 'visible', timeout: TIMEOUT })
  } catch {
    throw new Error('导航到库存调动列表失败：搜索框未渲染')
  }
}

/**
 * 搜索 "ATL/Stock" 并选中 "Search Location for:" 菜单项。
 * Location facet 同时覆盖 From（location_id）与 To（location_dest_id）；
 * 叠加在动作默认的 Done facet 之上，最终视图为 Done + ATL/Stock。
 */
async function applyWarehouseFilter(page: Page): Promise<void> {
  const input = page.locator(INVENTORY_SEARCH_INPUT).first()
  await input.waitFor({ state: 'visible', timeout: TIMEOUT })
  await input.fill(WAREHOUSE)

  const item = page
    .locator(MOVES_AUTOCOMPLETE_ITEM)
    .filter({ hasText: /Search\s+Location\s+for:/ })
    .first()
  await item.waitFor({ state: 'visible', timeout: TIMEOUT })
  await item.click()

  await page
    .locator(INVENTORY_FACET_VALUE)
    .filter({ hasText: WAREHOUSE })
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT })
}

/** 轮询直到数据行数量稳定（连续两次相同）或超时 */
async function waitForRowsStable(page: Page): Promise<void> {
  const deadline = Date.now() + TIMEOUT
  let prev = -1
  let stableCount = 0
  while (Date.now() < deadline) {
    const count = await page.locator(STOCK_MOVE_DATA_ROW).count()
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
//  排序与提取
// ==================================================================

/** 解析 Odoo 日期文本 "MM/DD/YYYY HH:mm:ss" → Date；失败返回 null */
function parseOdooDate(text: string): Date | null {
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6])
}

/** 提取当前页各行的日期时间戳（仅可解析的行） */
async function extractPageDates(page: Page): Promise<number[]> {
  const texts = await page.evaluate((dateSel) => {
    const cells = Array.from(document.querySelectorAll(`${dateSel}`))
    return cells.map((el) => (el.textContent ?? '').trim())
  }, STOCK_MOVE_DATE_CELL)
  return texts
    .map((t) => parseOdooDate(t)?.getTime())
    .filter((ts): ts is number => ts !== null)
}

/** 当前页是否按日期降序（首行 >= 尾行；不足两行视为有序） */
async function isSortedDesc(page: Page): Promise<boolean> {
  const list = await extractPageDates(page)
  if (list.length < 2) return true
  return list[0] >= list[list.length - 1]
}

/** 确保 Date 列为降序：先检查，再点击表头重试（最多两次点击） */
async function ensureDescendingSort(page: Page): Promise<void> {
  const header = page.locator(MOVES_DATE_HEADER).first()
  await header.waitFor({ state: 'visible', timeout: TIMEOUT })

  for (let click = 0; click <= 2; click++) {
    if (await isSortedDesc(page)) return
    if (click === 2) break
    await header.click()
    await waitForRowsStable(page)
  }
  throw new Error('日期列未能切换为降序排序')
}

/** evaluate 用：从当前页 DOM 提取全部行原始值 */
interface RawMoveRow {
  date: string
  reference: string
  product: string
  lot: string
  location: string
  dest: string
  qty: string
  uom: string
  state: string
}

/** 提取当前页全部行并解析为 MoveRow（无法解析日期/数量的行跳过） */
async function extractPage(page: Page): Promise<{ rows: MoveRow[]; dateTsList: number[] }> {
  const raw = await page.evaluate(
    ({ rowSel, dateSel, refSel, prodSel, lotSel, locSel, destSel, qtySel, uomSel, stateSel }) => {
      const rows = Array.from(document.querySelectorAll(rowSel))
      return rows.map<RawMoveRow>((tr) => ({
        date: (tr.querySelector(dateSel)?.textContent ?? '').trim(),
        reference: (tr.querySelector(refSel)?.textContent ?? '').trim(),
        product: (tr.querySelector(prodSel)?.textContent ?? '').trim(),
        lot: (tr.querySelector(lotSel)?.textContent ?? '').trim(),
        location: (tr.querySelector(locSel)?.textContent ?? '').trim(),
        dest: (tr.querySelector(destSel)?.textContent ?? '').trim(),
        qty: (tr.querySelector(qtySel)?.textContent ?? '').trim(),
        uom: (tr.querySelector(uomSel)?.textContent ?? '').trim(),
        state: (tr.querySelector(stateSel)?.textContent ?? '').trim(),
      }))
    },
    {
      rowSel: STOCK_MOVE_DATA_ROW,
      dateSel: STOCK_MOVE_DATE_CELL,
      refSel: 'td[name="reference"]',
      prodSel: 'td[name="product_id"]',
      lotSel: 'td[name="lot_id"]',
      locSel: STOCK_MOVE_LOCATION_CELL,
      destSel: STOCK_MOVE_DEST_CELL,
      qtySel: STOCK_MOVE_QTY_CELL,
      uomSel: 'td[name="product_uom_id"]',
      stateSel: 'td[name="state"]',
    },
  )

  const rows: MoveRow[] = []
  const dateTsList: number[] = []
  for (const r of raw) {
    const d = parseOdooDate(r.date)
    if (!d) continue
    const qty = parseFloat(r.qty)
    if (isNaN(qty)) continue

    dateTsList.push(d.getTime())
    rows.push({
      dateText: r.date,
      dateTs: d.getTime(),
      reference: r.reference,
      product: r.product,
      lot: r.lot,
      locationFrom: r.location,
      locationTo: r.dest,
      qty,
      uom: r.uom,
      state: r.state,
    })
  }
  return { rows, dateTsList }
}

// ==================================================================
//  主流程
// ==================================================================

/**
 * 同步 ATL/Stock 相关调动到截止时间（cutoffTs）为止的全部页面。
 * 每页通过 onBatch 上报一批 MoveRow；返回时同步结束（截止或末页）。
 */
export async function syncInventoryMoves(
  page: Page,
  cutoffTs: number,
  onBatch: (rows: MoveRow[], pageNo: number) => Promise<void>,
  onProgress: (m: string) => Promise<void>,
): Promise<void> {
  await navigateToMovesList(page)
  await onProgress(`MOVES: 已打开调动列表（保留默认 Done 过滤），应用库位筛选 ${WAREHOUSE}`)

  await applyWarehouseFilter(page)
  await waitForRowsStable(page)
  await ensureDescendingSort(page)

  let pageNo = 0
  while (true) {
    pageNo += 1
    const { rows, dateTsList } = await extractPage(page)
    await onProgress(`MOVES: 第 ${pageNo} 页提取 ${rows.length} 行`)
    if (rows.length > 0) {
      await onBatch(rows, pageNo)
    }

    // 停止条件：整页均早于截止时间，且当前页确为降序（防排序异常导致提前停）
    const sortedDesc =
      dateTsList.length < 2 || dateTsList[0] >= dateTsList[dateTsList.length - 1]
    const allBeforeCutoff =
      dateTsList.length > 0 && dateTsList.every((ts) => ts < cutoffTs)
    if (allBeforeCutoff && sortedDesc) {
      await onProgress(`MOVES: 第 ${pageNo} 页整页早于截止时间，停止`)
      return
    }

    // 翻页：无 pager 或 next 不可点视为末页
    const next = page.locator(MOVES_PAGER_NEXT).first()
    if ((await next.count()) === 0 || (await next.isDisabled())) {
      await onProgress(`MOVES: 已到末页（共 ${pageNo} 页），停止`)
      return
    }
    const before = (await page.locator(MOVES_PAGER_VALUE).first().textContent()) ?? ''
    await next.click()
    await page.waitForFunction(
      ({ sel, prev }) => {
        const el = document.querySelector(sel)
        return el !== null && (el.textContent ?? '').trim() !== prev
      },
      { sel: MOVES_PAGER_VALUE, prev: before.trim() },
      { timeout: TIMEOUT },
    )
    await waitForRowsStable(page)
  }
}
