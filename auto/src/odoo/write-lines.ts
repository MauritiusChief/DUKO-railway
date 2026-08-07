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
  fillDiscount,
  fillQuantity,
  submitEditableRow,
  deselectCurrentRow,
  removeRow,
  getDataRows,
  ensureTableReady,
  getDataRowCount,
} from './quotation-table.js'
import {
  DETAIL_PRODUCT_CELL,
  DETAIL_QUANTITY_CELL,
  DETAIL_DISCOUNT_CELL,
  QUOTATION_TABLE,
  QUOTATION_DATA_ROW,
} from './selectors.js'

export interface WriteLineResult {
  lineNo: number
  status: 'success' | 'failed'
  error?: string
}

export interface WriteInputLine {
  lineNo: number
  partModel: string
  quantity: number
  /** 折扣百分比（%）—— undefined 表示不指定，不读取也不写入 Odoo 折扣 */
  discount?: number
}

export interface WriteInput {
  mode: 'overwrite' | 'append'
  lines: WriteInputLine[]
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

      // 填写步骤只负责填值：先数量、后折扣（Odoo 每次修改 qty 都会清空已填折扣）。
      // 提交统一由 submitEditableRow 按 Enter 完成；提交会附带自动新增一行，
      // 因此随后用 deselectCurrentRow 取消选中。
      await fillQuantity(newRow, line.quantity)
      if (line.discount !== undefined) {
        await fillDiscount(newRow, line.discount)
      }
      await submitEditableRow(newRow)
      await deselectCurrentRow(page)

      // 不再逐行校验折扣：写入结果由最终整表校验统一判定（见 browser.ts）
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

/** 覆写模式：保留型号与数量均匹配的行；指定折扣时折扣也必须一致，
 *  其余行删除后按输入重新写入。CSV 未指定折扣的输入行不检查 Odoo 现有折扣。 */
async function overwriteLines(
  page: Page,
  input: WriteInput,
): Promise<void> {
  // 1. 目标型号 -> 期望 {数量, 折扣?}
  const target = new Map<string, { quantity: number; discount?: number }>()
  for (const line of input.lines) target.set(line.partModel, { quantity: line.quantity, discount: line.discount })

  // 2. 循环删除：型号不在目标集合、数量不一致，或指定折扣但现有折扣不一致的行。
  //    每轮重查当前行、删最靠前的待删行后从头再扫，
  //    避免删除导致后续行索引上移而漏删。
  const dataRowSel = `${QUOTATION_TABLE} ${QUOTATION_DATA_ROW}`
  let guard = 0
  while (guard++ < 200) {
    const rows = await getDataRows(page)
    let targetRow: Locator | null = null
    for (const row of rows) {
      const { name, quantity, discount } = await readRowState(row)
      if (!name) continue
      const want = target.get(name)
      if (
        want === undefined ||
        !sameQuantity(quantity, want.quantity) ||
        (want.discount !== undefined && !sameDiscount(discount, want.discount))
      ) {
        targetRow = row
        break
      }
    }
    if (!targetRow) break

    const beforeCount = await getDataRowCount(page)
    await removeRow(targetRow)
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
  //    （数量或折扣不一致的行已在第 2 步删除，此处会按新值重新写入）
  const keptProducts = new Set<string>()
  for (const row of await getDataRows(page)) {
    const { name } = await readRowState(row)
    if (name) keptProducts.add(name)
  }

  const linesToAdd = input.lines.filter((l) => !keptProducts.has(l.partModel))
  if (linesToAdd.length > 0) {
    await appendLines(page, { ...input, lines: linesToAdd })
  }

  // 4. 保留行（型号、数量、指定折扣均匹配）按输入序报成功
  for (const line of input.lines) {
    if (keptProducts.has(line.partModel)) {
      await input.onLineResult({
        lineNo: line.lineNo,
        status: 'success',
      })
    }
  }
}

/** 从已保存行读取 {产品型号, 数量文本, 折扣} */
async function readRowState(
  row: Locator,
): Promise<{ name: string; quantity: string; discount?: number }> {
  const productCell = row.locator(DETAIL_PRODUCT_CELL)
  if ((await productCell.count()) === 0) return { name: '', quantity: '', discount: undefined }
  const name = ((await productCell.textContent()) ?? '').trim()

  const qtyCell = row.locator(DETAIL_QUANTITY_CELL)
  const quantity = (await qtyCell.count()) > 0
    ? ((await qtyCell.textContent()) ?? '').trim()
    : ''

  return { name, quantity, discount: await readDiscountFromRow(row) }
}

/** 从已保存行读取折扣百分比（单元格不存在或无法解析时返回 undefined） */
async function readDiscountFromRow(row: Locator): Promise<number | undefined> {
  const cell = row.locator(DETAIL_DISCOUNT_CELL)
  if ((await cell.count()) === 0) return undefined
  const text = ((await cell.textContent()) ?? '').trim()
  const parsed = Number.parseFloat(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 比较已保存行数量文本与期望数值是否一致（"1.00" 与 1 视为相等） */
function sameQuantity(domText: string, want: number): boolean {
  const parsed = Number.parseFloat(domText)
  return Number.isFinite(parsed) && parsed === want
}

/** 比较已保存折扣与期望数值是否一致（"10.00" 与 10 视为相等） */
function sameDiscount(saved: number | undefined, want: number): boolean {
  return saved !== undefined && Number.isFinite(saved) && saved === want
}
