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
import { pauseAfterDebugLog, pauseForInspection } from './debug.js'

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
  console.log(`[quotation-debug] 新增产品：操作前 data-row 数量=${beforeCount}`)
  await pauseAfterDebugLog()

  const addLink = page.locator(`${QUOTATION_TABLE} ${ADD_PRODUCT_LINK}`).first()
  await addLink.click()
  console.log('[quotation-debug] 新增产品：已点击链接')
  await pauseAfterDebugLog()

  // 等待新行出现（o_data_row 数量增长）
  await rows.nth(beforeCount).waitFor({ state: 'attached', timeout: TIMEOUT })
  console.log(`[quotation-debug] 新增产品：新行已挂载，data-row 数量=${await rows.count()}`)
  await pauseForInspection('新的编辑行已可见')

  return getSelectedEditableRow(page)
}

/** 在当前编辑行中填入产品型号并选择 autocomplete 匹配项 */
export async function fillProductAndChooseFromMenu(
  rowLocator: Locator,
  targetPartModel: string,
): Promise<boolean> {
  const editableInput = rowLocator.locator(PRODUCT_AUTOCOMPLETE_INPUT).first()
  await editableInput.waitFor({ state: 'visible', timeout: TIMEOUT })
  console.log(`[quotation-debug] 产品：输入框可见，型号=${targetPartModel}`)
  await pauseAfterDebugLog()

  await editableInput.fill(targetPartModel)
  console.log(`[quotation-debug] 产品：输入框当前值=${await editableInput.inputValue()}`)
  await pauseAfterDebugLog()

  const dropdownMenu = rowLocator.locator(PRODUCT_AUTOCOMPLETE_MENU).first()
  try {
    await dropdownMenu.waitFor({ state: 'visible', timeout: TIMEOUT })
  } catch (e) {
    if (e instanceof errors.TimeoutError) {
      return false
    }
    throw e
  }
  console.log('[quotation-debug] 产品：自动补全菜单可见')
  await pauseForInspection('产品自动补全菜单，选择前')

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

  console.log(`[quotation-debug] 产品：正在点击自动补全选项，文本=${(await matchedItem.textContent())?.trim() ?? ''}`)
  await pauseAfterDebugLog()
  await matchedItem.click()
  console.log('[quotation-debug] 产品：已点击自动补全选项')
  await pauseForInspection('产品已选择；观察 Odoo onchange')
  // Selecting a product triggers Odoo onchange and may rebuild the editing row.
  // Wait for that work to settle before callers locate its other field inputs.
  // await dropdownMenu.waitFor({ state: 'hidden', timeout: TIMEOUT })
  return true
}

/** 在当前编辑行中填入折扣百分比 */
export async function fillDiscount(rowLocator: Locator, discount: number): Promise<void> {
  const editableInput = rowLocator.locator(EDITABLE_DISCOUNT_INPUT).first()
  await editableInput.waitFor({ state: 'visible', timeout: TIMEOUT })
  console.log(`[quotation-debug] 折扣：输入框可见，当前值=${await editableInput.inputValue()}，目标值=${discount}`)
  await pauseAfterDebugLog()
  await editableInput.click()
  // await editableInput.press('ControlOrMeta+A')
  // await editableInput.pressSequentially(String(discount))
  // // Odoo's float field records the change on blur; quantity Enter then commits the row.
  await editableInput.fill(String(discount))
  console.log(`[quotation-debug] 折扣：填入后当前值=${await editableInput.inputValue()}`)
  await pauseForInspection('折扣值已填入，Tab 失焦前')
  await editableInput.press('Tab')
  console.log('[quotation-debug] 折扣：已按 Tab')
  await pauseForInspection('折扣字段已失焦；观察 Odoo onchange')
}

/** 在当前编辑行中填入数量 */
export async function fillQuantity(rowLocator: Locator, quantity: number): Promise<void> {
  const editableInput = rowLocator.locator(EDITABLE_QUANTITY_INPUT).first()
  await editableInput.waitFor({ state: 'visible', timeout: TIMEOUT })
  console.log(`[quotation-debug] 数量：输入框可见，当前值=${await editableInput.inputValue()}，目标值=${quantity}`)
  await pauseAfterDebugLog()
  await editableInput.fill(String(quantity))
  console.log(`[quotation-debug] 数量：填入后当前值=${await editableInput.inputValue()}`)
  await pauseForInspection('数量值已填入，Enter 提交前')
  await editableInput.press('Enter')
  console.log('[quotation-debug] 数量：已按 Enter')
  await pauseForInspection('数量已提交；观察行提交状态')
}

/** 点击标题区域取消当前行的选中状态 */
export async function deselectCurrentRow(page: Page): Promise<void> {
  const canceller = page.locator(SELECT_CANCELLING).first()
  console.log(`[quotation-debug] 取消选中：点击前 selected-row 数量=${await page.locator(`${QUOTATION_TABLE} ${QUOTATION_SELECTED_ROW}`).count()}`)
  await pauseAfterDebugLog()
  await canceller.click()
  console.log('[quotation-debug] 取消选中：已点击标题区域')
  await pauseAfterDebugLog()
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
  console.log(`[quotation-debug] 取消选中：等待后 selected-row 数量=${await page.locator(`${QUOTATION_TABLE} ${QUOTATION_SELECTED_ROW}`).count()}`)
  await pauseForInspection('行已取消选中；校验前查看保存值')
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
