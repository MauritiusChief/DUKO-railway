/**
 * 报价单写入流程 —— 追加 / 覆写模式
 *
 * 逐行通过 quotation-table.ts 填入产品与数量，每行结果即时回调。
 * 行级失败不中断后续行；覆写模式保留型号与数量均匹配的行，
 * 删除不在输入中的行以及数量不一致的行，再按输入重新写入。
 */

import type { Locator, Page } from 'playwright'
import {
  addNewEditableRow,
  fillProductAndChooseFromMenu,
  fillQuantity,
  deselectCurrentRow,
  removeRow,
  getDataRows,
  ensureTableReady,
  getDataRowCount,
} from './quotation-table.js'
import {
  DETAIL_PRODUCT_CELL,
  DETAIL_QUANTITY_CELL,
  QUOTATION_TABLE,
  QUOTATION_DATA_ROW,
} from './selectors.js'

export interface WriteLineResult {
  lineNo: number
  status: 'success' | 'failed'
  error?: string
}

export interface WriteInput {
  mode: 'overwrite' | 'append'
  lines: { lineNo: number; partModel: string; quantity: number }[]
  onLineResult: (result: WriteLineResult) => Promise<void>
}

/**
 * 主入口：按 mode 写入报价单行。
 * 每行完成即调用 onLineResult，失败行继续后续行。
 */
export async function writeLines(
  page: Page,
  input: WriteInput,
): Promise<void> {
  await ensureTableReady(page)

  if (input.mode === 'overwrite') {
    await overwriteLines(page, input)
  } else {
    await appendLines(page, input)
  }
}

/** 追加模式：逐行新增到表格末尾 */
async function appendLines(
  page: Page,
  input: WriteInput,
): Promise<void> {
  for (const line of input.lines) {
    try {
      const newRow = await addNewEditableRow(page)

      const productFilled = await fillProductAndChooseFromMenu(newRow, line.partModel)

      if (!productFilled) {
        await removeRow(newRow)
        await input.onLineResult({
          lineNo: line.lineNo,
          status: 'failed',
          error: '产品未匹配',
        })
        continue
      }

      // autocomplete 选定后可能需要短暂等待 Odoo 重建选中行
      // 如果当前所在行的 product cell 已被填充且不再 editable，说明产品已成功写入
      await fillQuantity(newRow, line.quantity)
      await deselectCurrentRow(page)

      await input.onLineResult({
        lineNo: line.lineNo,
        status: 'success',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await input.onLineResult({
        lineNo: line.lineNo,
        status: 'failed',
        error: `写入异常：${message}`,
      })
      // 尝试恢复：按 Escape 取消编辑并点击标题失焦
      try { await page.keyboard.press('Escape') } catch { /* ignore */ }
      try { await deselectCurrentRow(page) } catch { /* ignore */ }
    }
  }
}

/** 覆写模式：保留型号与数量均匹配的行，删除其余行后按输入重新写入 */
async function overwriteLines(
  page: Page,
  input: WriteInput,
): Promise<void> {
  // 1. 目标型号 -> 期望数量
  const targetQty = new Map<string, number>()
  for (const line of input.lines) targetQty.set(line.partModel, line.quantity)

  // 2. 循环删除：型号不在目标集合，或数量与目标不一致的行。
  //    每轮重查当前行、删最靠前的待删行后从头再扫，
  //    避免删除导致后续行索引上移而漏删。
  const dataRowSel = `${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`
  let guard = 0
  while (guard++ < 200) {
    const rows = await getDataRows(page)
    let target: Locator | null = null
    for (const row of rows) {
      const { name, quantity } = await readProductAndQuantityFromRow(row)
      if (!name) continue
      const want = targetQty.get(name)
      if (want === undefined || !sameQuantity(quantity, want)) {
        target = row
        break
      }
    }
    if (!target) break

    const beforeCount = await getDataRowCount(page)
    await removeRow(target)
    // 等待行数减少
    try {
      await page.waitForFunction(
        ({ sel, expected }: { sel: string; expected: number }) =>
          document.querySelectorAll(sel).length <= expected - 1,
        { sel: dataRowSel, expected: beforeCount },
        { timeout: 10_000 },
      )
    } catch { /* 行数未在超时内减少，下一轮重查 */ }
  }

  // 3. 重读存活行得到保留集合；不在集合中的输入行按 append 模式重写
  //    （数量不一致的行已在第 2 步删除，此处会以新数量重新写入）
  const keptProducts = new Set<string>()
  for (const row of await getDataRows(page)) {
    const { name } = await readProductAndQuantityFromRow(row)
    if (name) keptProducts.add(name)
  }

  const linesToAdd = input.lines.filter((l) => !keptProducts.has(l.partModel))
  if (linesToAdd.length > 0) {
    await appendLines(page, { ...input, lines: linesToAdd })
  }

  // 4. 保留行（型号与数量均匹配）按输入序报成功
  for (const line of input.lines) {
    if (keptProducts.has(line.partModel)) {
      await input.onLineResult({
        lineNo: line.lineNo,
        status: 'success',
      })
    }
  }
}

/** 从已保存行读取 {产品型号, 数量文本} */
async function readProductAndQuantityFromRow(
  row: Locator,
): Promise<{ name: string; quantity: string }> {
  const productCell = row.locator(DETAIL_PRODUCT_CELL)
  if ((await productCell.count()) === 0) return { name: '', quantity: '' }
  const name = ((await productCell.textContent()) ?? '').trim()

  const qtyCell = row.locator(DETAIL_QUANTITY_CELL)
  const quantity = (await qtyCell.count()) > 0
    ? ((await qtyCell.textContent()) ?? '').trim()
    : ''

  return { name, quantity }
}

/** 比较已保存行数量文本与期望数值是否一致（"1.00" 与 1 视为相等） */
function sameQuantity(domText: string, want: number): boolean {
  const parsed = Number.parseFloat(domText)
  return Number.isFinite(parsed) && parsed === want
}
