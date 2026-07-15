/**
 * Inventory 浏览器任务 —— 下载 CSV 与 趋势查验
 *
 * 与 browser.ts 的 runQuotationTask 结构一致：
 *   - 每任务启动 launchPersistentContext（复用 AUTO_PROFILE_DIR 登录态）
 *   - checkOdooLogin 检测登录
 *   - AbortSignal 触发时立即关闭 context（worker 断线/用户取消）
 *   - finally 中关闭 context
 */

import { chromium, type BrowserContext } from 'playwright'
import { appConfig } from './config.js'
import { checkOdooLogin } from './browser.js'
import { downloadProductsCsv } from './odoo/inventory-download.js'
import { extractTrendForItem } from './odoo/inventory-trend.js'
import type { TrendItemResult } from './protocol.js'

export interface InventoryCallbacks {
  onProgress: (message: string) => Promise<void>
  onTrendResult?: (result: TrendItemResult) => Promise<void>
}

export interface InventoryDownloadOutcome {
  status: 'completed' | 'failed'
  csv?: string
  error?: string
}

export interface InventoryTrendOutcome {
  status: 'completed' | 'failed'
  items?: TrendItemResult[]
  error?: string
}

/** 共享：启动 context + 登录检测 + abort 装配。返回 page 与 cleanup */
async function prepare(
  abortSignal?: AbortSignal,
): Promise<{ page: import('playwright').Page; cleanup: () => Promise<void> } | { error: string }> {
  let context: BrowserContext | null = null
  let aborted = false

  const onAbort = () => {
    aborted = true
    if (context) context.close().catch(() => {})
  }
  abortSignal?.addEventListener('abort', onAbort)

  const cleanup = async () => {
    abortSignal?.removeEventListener('abort', onAbort)
    if (context) {
      try { await context.close() } catch {}
    }
  }

  try {
    if (abortSignal?.aborted) {
      aborted = true
      return { error: '任务中止' }
    }

    context = await chromium.launchPersistentContext(appConfig.profileDir, {
      headless: appConfig.headless,
      viewport: null,
    })
    const page = await context.newPage()

    const loginCheck = await checkOdooLogin(page)
    if (!loginCheck.loggedIn) {
      return { error: 'Odoo 登录状态失效，请联系技术部门' }
    }

    return { page, cleanup }
  } catch (err) {
    await cleanup()
    const message = aborted ? '任务中止' : `浏览器异常：${err instanceof Error ? err.message : String(err)}`
    return { error: message }
  }
}

/**
 * 执行 inventory-download 任务：从 /odoo/products 导出 CSV 并返回文本。
 */
export async function runInventoryDownloadTask(
  callbacks: InventoryCallbacks,
  abortSignal?: AbortSignal,
): Promise<InventoryDownloadOutcome> {
  const prep = await prepare(abortSignal)
  if ('error' in prep) {
    return { status: 'failed', error: prep.error }
  }
  const { page, cleanup } = prep
  try {
    const csv = await downloadProductsCsv(page, callbacks.onProgress)
    return { status: 'completed', csv }
  } catch (err) {
    const message = `下载失败：${err instanceof Error ? err.message : String(err)}`
    return { status: 'failed', error: message }
  } finally {
    await cleanup()
  }
}

/**
 * 执行 inventory-trend 任务：逐项在 /odoo/action-809 查验趋势。
 * 单项失败不影响整体（记录空 moves 继续）；中止时返回已收集的部分结果。
 */
export async function runInventoryTrendTask(
  items: string[],
  callbacks: InventoryCallbacks,
  abortSignal?: AbortSignal,
): Promise<InventoryTrendOutcome> {
  const prep = await prepare(abortSignal)
  if ('error' in prep) {
    return { status: 'failed', error: prep.error }
  }
  const { page, cleanup } = prep

  const results: TrendItemResult[] = []
  try {
    for (let i = 0; i < items.length; i++) {
      const name = items[i]
      await callbacks.onProgress(`TREND: (${i + 1}/${items.length}) 开始查验 ${name}`)
      let result: TrendItemResult
      try {
        const moves = await extractTrendForItem(page, name, callbacks.onProgress)
        result = { name, moves }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await callbacks.onProgress(`TREND: ${name} 查验异常：${msg}`)
        result = { name, moves: [] }
      }
      results.push(result)
      await callbacks.onTrendResult?.(result)
    }
    return { status: 'completed', items: results }
  } finally {
    await cleanup()
  }
}
