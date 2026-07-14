/**
 * 报价单写入流程 —— 追加 / 覆写模式
 *
 * 逐行通过 quotation-table.ts 填入产品与数量，每行结果即时回调。
 * 行级失败不中断后续行；覆写模式先精确删除多余行再追加新增项。
 */

import type { Page } from 'playwright'
import {
  addNewEditableRow,
  fillProductAndChooseFromMenu,
  fillQuantity,
  deselectCurrentRow,
  removeRow,
  removeAllRows,
  getDataRows,
  ensureTableReady,
  getDataRowCount,
} from './quotation-table.js'
import { DETAIL_PRODUCT_CELL } from './selectors.js'

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

/** 覆写模式：精确删除多余行后追加新增项 */
async function overwriteLines(
  page: Page,
  input: WriteInput,
): Promise<void> {
  // 1. 读取已有行的产品型号集合
  const existingProducts = await readExistingProductNames(page)
  const newProductSet = new Set(input.lines.map((l) => l.partModel))

  // 2. 删除不在新集合中的行
  const rows = await getDataRows(page)
  for (const row of rows) {
    const productName = await readProductFromRow(row)
    if (productName && !newProductSet.has(productName)) {
      const beforeCount = await getDataRowCount(page)
      await removeRow(row)
      // 等待行数减少
      try {
        await page.waitForFunction(
          ({ sel, expected }: { sel: string; expected: number }) =>
            document.querySelectorAll(sel).length <= expected - 1,
          { sel: `${await getTableSel(page)} ${'tbody tr.o_data_row'}`, expected: beforeCount },
          { timeout: 10_000 },
        )
      } catch { /* ignore */ }
    }
  }

  // 3. 找出需要新增的项（新输入中有、已有列表中无）
  const existingSet = new Set(existingProducts)
  const linesToAdd = input.lines.filter((l) => !existingSet.has(l.partModel))

  if (linesToAdd.length > 0) {
    await appendLines(page, { ...input, lines: linesToAdd })
  }

  // 4. 对已存在的行（未删除的），标记为成功
  for (const line of input.lines) {
    if (existingSet.has(line.partModel)) {
      await input.onLineResult({
        lineNo: line.lineNo,
        status: 'success',
      })
    }
  }
}

/** 从已保存行读取 product 名称 */
async function readProductFromRow(row: import('playwright').Locator): Promise<string> {
  const cell = row.locator(DETAIL_PRODUCT_CELL)
  const cnt = await cell.count()
  if (cnt === 0) return ''
  return ((await cell.textContent()) ?? '').trim()
}

/** 读取当前表格中所有已有行的产品型号 */
async function readExistingProductNames(page: Page): Promise<string[]> {
  const rows = await getDataRows(page)
  const names: string[] = []
  for (const row of rows) {
    const name = await readProductFromRow(row)
    if (name) names.push(name)
  }
  return names
}

async function getTableSel(page: Page): Promise<string> {
  // 使用 QUOTATION_TABLE 选择器
  return 'div.o_field_widget.o_field_section_and_note_one2many table.o_section_and_note_list_view'
}
