/**
 * 报价写入后的整表校验（纯函数）。
 *
 * 把期望输入行与最终从 Odoo 读取的整表做整体对比，
 * 逐条输出"少了 / 不一致 / 多了"issue。结果只作为 progress 日志呈现，
 * 不改变逐行 line-result 状态。
 *
 * 匹配语义：
 *   - 带折扣的输入行要求 (型号, 数量, 折扣) 一致；
 *   - 无折扣的输入行只要求 (型号, 数量) 一致；
 *   - 每行消耗一条匹配。
 * append 模式下，"多了"先扣除确认阶段读到的基准（预置）行，避免误报。
 */

export interface ExpectedLine {
  partModel: string
  quantity: number
  /** 折扣百分比（%）—— undefined 表示不要求折扣一致 */
  discount?: number
}

export interface ActualRow {
  productModel: string
  quantity: string
  /** 折扣百分比（%）—— 表中无折扣字段/无法解析时省略 */
  discount?: number
}

export type VerificationIssueKind = 'missing' | 'mismatch' | 'extra'

export interface VerificationIssue {
  kind: VerificationIssueKind
  message: string
}

interface NormRow {
  model: string
  qty: number
  discount?: number
}

function normalizeRow(r: ActualRow): NormRow | null {
  if (!r.productModel) return null
  const qty = Number.parseFloat(r.quantity)
  return { model: r.productModel, qty: Number.isFinite(qty) ? qty : NaN, discount: r.discount }
}

function sameRow(a: NormRow, b: NormRow): boolean {
  return a.model === b.model && a.qty === b.qty && a.discount === b.discount
}

export function verifyFinalLines(
  expected: ExpectedLine[],
  actual: ActualRow[],
  baseline: ActualRow[],
  mode: 'overwrite' | 'append',
): VerificationIssue[] {
  const remaining = actual
    .map(normalizeRow)
    .filter((r): r is NormRow => r !== null)
  const issues: VerificationIssue[] = []

  for (const line of expected) {
    let matchedIndex = -1
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i]
      if (
        r.model === line.partModel &&
        r.qty === line.quantity &&
        (line.discount === undefined || r.discount === line.discount)
      ) {
        matchedIndex = i
        break
      }
    }

    if (matchedIndex >= 0) {
      remaining.splice(matchedIndex, 1)
      continue
    }

    // 未匹配：区分"少了"（表中无该型号）与"不一致"（有型号但数量/折扣不符）
    const sameModel = remaining.find((r) => r.model === line.partModel)
    if (!sameModel) {
      issues.push({
        kind: 'missing',
        message: `FINAL CHECK: MISSING ${line.partModel} x${line.quantity} (NOT FOUND IN TABLE)`,
      })
    } else {
      const wantDiscount = line.discount !== undefined ? ` DISCOUNT ${line.discount}` : ''
      const gotDiscount = sameModel.discount !== undefined ? ` DISCOUNT ${sameModel.discount}` : ''
      issues.push({
        kind: 'mismatch',
        message: `FINAL CHECK: MISMATCH ${line.partModel} x${line.quantity}${wantDiscount} (TABLE HAS x${sameModel.qty}${gotDiscount})`,
      })
    }
  }

  // 剩余的实际行 = "多了"候选；append 模式先扣除基准（预置）行
  if (mode === 'append') {
    const baselineRows = baseline
      .map(normalizeRow)
      .filter((r): r is NormRow => r !== null)
    for (const b of baselineRows) {
      const idx = remaining.findIndex((r) => sameRow(r, b))
      if (idx >= 0) remaining.splice(idx, 1)
    }
  }

  for (const r of remaining) {
    const discount = r.discount !== undefined ? ` DISCOUNT ${r.discount}` : ''
    issues.push({
      kind: 'extra',
      message: `FINAL CHECK: EXTRA ${r.model} x${r.qty}${discount} (NOT IN INPUT)`,
    })
  }

  return issues
}
