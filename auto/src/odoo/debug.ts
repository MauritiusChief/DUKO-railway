/**
 * 报价 DOM 调试辅助。
 *
 * 只用于人工观察 Odoo 页面行为：每个调用点记录终端日志，并按配置暂停。
 * 排查完成后将 AUTO_DEBUG_STEP_PAUSE_MS 和 AUTO_SLOW_MO_MS 设为 0 即可关闭。
 */

export async function pauseForInspection(checkpoint: string): Promise<void> {
  const pauseMs = 5_000
  console.log(`[quotation-debug] ${checkpoint}; pause=${pauseMs}ms`)
  if (pauseMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs))
  }
}
