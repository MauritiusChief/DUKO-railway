/**
 * Odoo 报价单表格操作 —— Playwright Locator API 版
 *
 * 从 experiment/playwright/quotationTable.ts 迁移而来，全部使用 Locator API。
 * 不再依赖 document.execCommand/MutationObserver。
 */

import { errors, type Locator, type Page } from 'playwright'
import {
  QUOTATION_TABLE,
  QUOTATION_DATA_ROW,
  QUOTATION_SELECTED_ROW,
  PRODUCT_AUTOCOMPLETE_INPUT,
  PRODUCT_AUTOCOMPLETE_MENU,
  PRODUCT_AUTOCOMPLETE_ITEM,
  EDITABLE_QUANTITY_INPUT,
  EDITABLE_DISCOUNT_INPUT,
  ADD_PRODUCT_LINK,
  REMOVE_ROW_BUTTON,
  SELECT_CANCELLING,
} from './selectors.js'

const TIMEOUT = 15_000

/** 确保报价单表格已在页面上渲染 */
export async function ensureTableReady(page: Page): Promise<void> {
  const table = page.locator(QUOTATION_TABLE).first()
  await table.waitFor({ state: 'visible', timeout: TIMEOUT })
}

/** 获取当前表格中的所有业务数据行（排除操作行、空白行） */
export async function getDataRows(page: Page): Promise<Locator[]> {
  await ensureTableReady(page)
  const rows = page.locator(`${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`)
  const count = await rows.count()
  const result: Locator[] = []
  for (let i = 0; i < count; i++) {
    result.push(rows.nth(i))
  }
  return result
}

/** 获取数据行数量 */
export async function getDataRowCount(page: Page): Promise<number> {
  return page.locator(`${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`).count()
}

/** 获取当前被选中的编辑行 */
export async function getSelectedEditableRow(page: Page): Promise<Locator> {
  const selectedRow = page.locator(`${QUOTATION_TABLE} ${QUOTATION_SELECTED_ROW}`).first()
  await selectedRow.waitFor({ state: 'visible', timeout: TIMEOUT })
  return selectedRow
}

/** 点击 "Add a product" 新增一行，返回编辑行 */
export async function addNewEditableRow(page: Page): Promise<Locator> {
  const rows = page.locator(`${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`)
  const beforeCount = await rows.count()

  const addLink = page.locator(`${QUOTATION_TABLE} ${ADD_PRODUCT_LINK}`).first()
  await addLink.click()

  // 等待新行出现（o_data_row 数量增长）
  await rows.nth(beforeCount).waitFor({ state: 'attached', timeout: TIMEOUT })

  return getSelectedEditableRow(page)
}

/** 在当前编辑行中填入产品型号并选择 autocomplete 匹配项 */
export async function fillProductAndChooseFromMenu(
  rowLocator: Locator,
  targetPartModel: string,
): Promise<boolean> {
  const editableInput = rowLocator.locator(PRODUCT_AUTOCOMPLETE_INPUT).first()
  await editableInput.waitFor({ state: 'visible', timeout: TIMEOUT })

  await editableInput.fill(targetPartModel)

  const dropdownMenu = rowLocator.locator(PRODUCT_AUTOCOMPLETE_MENU).first()
  try {
    await dropdownMenu.waitFor({ state: 'visible', timeout: TIMEOUT })
  } catch (e) {
    if (e instanceof errors.TimeoutError) {
      return false
    }
    throw e
  }

  const matchedItem = rowLocator
    .locator(PRODUCT_AUTOCOMPLETE_ITEM)
    .filter({ hasText: targetPartModel })
    .first()

  try {
    await matchedItem.waitFor({ state: 'visible', timeout: TIMEOUT })
  } catch (e) {
    if (e instanceof errors.TimeoutError) {
      return false
    }
    throw e
  }

  await matchedItem.click()
  return true
}

/** 在当前编辑行中填入折扣百分比（只填值，不提交；由 submitEditableRow 统一提交）。须在数量之后填写 */
export async function fillDiscount(rowLocator: Locator, discount: number): Promise<void> {
  const editableInput = rowLocator.locator(EDITABLE_DISCOUNT_INPUT).first()
  await editableInput.waitFor({ state: 'visible', timeout: TIMEOUT })
  await editableInput.click()
  await editableInput.fill(String(discount))
}

/** 在当前编辑行中填入数量（只填值，不提交；由 submitEditableRow 统一提交）。
 *  Odoo 每次修改 qty 都会清空已填折扣，因此折扣必须晚于数量填写。 */
export async function fillQuantity(rowLocator: Locator, quantity: number): Promise<void> {
  const editableInput = rowLocator.locator(EDITABLE_QUANTITY_INPUT).first()
  await editableInput.waitFor({ state: 'visible', timeout: TIMEOUT })
  await editableInput.fill(String(quantity))
}

/** 统一提交步骤：在数量输入框按 Enter 提交整行（Tab 与 Enter 效果一致，只保留 Enter）。
 *  注意：提交后 Odoo 会附带自动新增一行（等效于自动点击 "Add a product"），
 *  因此调用方仍需用 deselectCurrentRow 取消选中。 */
export async function submitEditableRow(rowLocator: Locator): Promise<void> {
  const editableInput = rowLocator.locator(EDITABLE_QUANTITY_INPUT).first()
  await editableInput.press('Enter')
}

/** 点击标题区域取消当前行的选中状态 */
export async function deselectCurrentRow(page: Page): Promise<void> {
  const canceller = page.locator(SELECT_CANCELLING).first()
  await canceller.click()
  // 等待 selected row 消失
  try {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length === 0,
      `${QUOTATION_TABLE} ${QUOTATION_SELECTED_ROW}`,
      { timeout: 5_000 },
    )
  } catch {
    // 即使未完全消失也无大碍，下一轮 fillProduct 会等待新 selected row
  }
}

/** 删除指定行（用于 autocomplete 失败后清理） */
export async function removeRow(rowLocator: Locator): Promise<void> {
  const removeBtn = rowLocator.locator(REMOVE_ROW_BUTTON).first()
  await removeBtn.click()
}

/** 清空表格中所有数据行 */
export async function removeAllRows(page: Page): Promise<void> {
  while (true) {
    const rows = page.locator(`${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`)
    const count = await rows.count()
    if (count === 0) return

    const firstRow = rows.first()
    const removeBtn = firstRow.locator(REMOVE_ROW_BUTTON).first()
    await removeBtn.click()

    // 等待行数减少
    await page.waitForFunction(
      ({ sel, expected }: { sel: string; expected: number }) =>
        document.querySelectorAll(sel).length === expected,
      { sel: `${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`, expected: count - 1 },
      { timeout: TIMEOUT },
    )
  }
}
