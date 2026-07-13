/**
 * QuotationTasksPage —— 报价任务管理页面
 *
 * 左侧：任务摘要列表（状态徽标 + 单号 + 行数 + 时间）
 * 右侧主体：
 *   上部分（左右分栏）：表单（单号、URL占位、CSV文本区、覆写模式）+ 产品预览
 *   中部分：确认卡片 / 公司+已有行信息（只读）
 *   下部分：实时执行日志 + 最终快照表格 + 复制失败行
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuotationStore, type QuotationLogEntry } from '../stores/quotationStore'
import type { QuotationTaskSummary, QuotationSnapshotLine } from '../types'
import './QuotationTasksPage.css'

const STATUS_LABELS: Record<string, { zh: string; cls: string }> = {
  queued: { zh: '排队', cls: 'qt-badge-gray' },
  running: { zh: '执行中', cls: 'qt-badge-blue' },
  completed: { zh: '完成', cls: 'qt-badge-green' },
  partial_failed: { zh: '部分失败', cls: 'qt-badge-orange' },
  failed: { zh: '失败', cls: 'qt-badge-red' },
  cancelled: { zh: '已取消', cls: 'qt-badge-gray' },
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + 'Z')
    if (isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return iso }
}

function parseCSV(csv: string): { partModel: string; quantity: number }[] {
  const lines = csv.trim().split('\n').filter(Boolean)
  if (lines.length === 0) return []
  const hasHeader = lines[0] && /partModel|SKU|型号/i.test(lines[0])
  const start = hasHeader ? 1 : 0
  const result: { partModel: string; quantity: number }[] = []
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',')
    const model = (cols[0] ?? '').trim()
    const qty = parseInt((cols[1] ?? '').trim(), 10)
    if (model && !isNaN(qty) && qty > 0) {
      result.push({ partModel: model, quantity: qty })
    }
  }
  return result
}

export default function QuotationTasksPage() {
  const navigate = useNavigate()
  const store = useQuotationStore()

  // 本地表单状态
  const [quotationNumber, setQuotationNumber] = useState('')
  const [csvText, setCsvText] = useState('')
  const [writeMode, setWriteMode] = useState<'overwrite' | 'append'>('append')

  const [statusMsg, setStatusMsg] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const sseAbortRef = useRef<AbortController | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // 初始化
  useEffect(() => {
    store.fetchTasks()
    store.fetchActiveStatus()
    store.loadDraft()
  }, [])

  // 恢复草稿
  useEffect(() => {
    if (store.draft) {
      setQuotationNumber(store.draft.quotationNumber || '')
      setCsvText(store.draft.csvText || '')
      setWriteMode(store.draft.writeMode || 'append')
    }
  }, [store.draft])

  // SSE 管理
  useEffect(() => {
    // 当选中任务且状态为 running 时建立 SSE
    if (store.selectedTaskId && store.selectedTaskDetail?.status === 'running') {
      sseAbortRef.current?.abort()
      sseAbortRef.current = store.subscribeSSE(store.selectedTaskId)
    }
    return () => {
      sseAbortRef.current?.abort()
    }
  }, [store.selectedTaskId, store.selectedTaskDetail?.status])

  // 日志自动滚动
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [store.sseLog])

  // 解析 CSV 预览
  const previewLines = parseCSV(csvText)

  // 清空草稿
  const handleClearDraft = () => {
    setQuotationNumber('')
    setCsvText('')
    setWriteMode('append')
    store.clearDraft()
  }

  // 提交任务
  const handleSubmit = async () => {
    const lines = parseCSV(csvText)
    if (lines.length === 0) {
      setStatusMsg('请在文本区输入有效的 CSV 数据')
      return
    }
    if (!quotationNumber.trim()) {
      setStatusMsg('请输入报价单号')
      return
    }

    setStatusMsg('')
    const taskId = await store.createTask(quotationNumber.trim(), writeMode, lines)
    if (taskId !== null) {
      store.saveDraft({ quotationNumber: quotationNumber.trim(), writeMode, csvText })
      await store.selectTask(taskId)
      setStatusMsg('任务已创建')
    } else {
      setStatusMsg('任务创建失败')
    }
  }

  // 确认/拒绝
  const handleConfirm = async (decision: 'confirmed' | 'rejected') => {
    if (!store.confirmRequest) return
    const ok = await store.confirmTask(store.confirmRequest.taskId, decision)
    if (ok && decision === 'confirmed') {
      setConfirmed(true)
    }
    if (ok && decision === 'rejected') {
      store.setConfirmRequest(null)
      setConfirmed(false)
    }
  }

  // 选中不同任务时重置 confirmed
  useEffect(() => {
    setConfirmed(false)
  }, [store.selectedTaskId])

  // 复制失败行 CSV
  const handleCopyFailed = useCallback(() => {
    const detail = store.selectedTaskDetail
    if (!detail) return
    const failed = detail.lines.filter((l) => l.status === 'failed')
    if (failed.length === 0) return
    const csv = failed.map((l) => `${l.partModel},${l.quantity}`).join('\n')
    navigator.clipboard.writeText(csv).then(() => {
      setStatusMsg('失败行已复制到剪贴板')
    }).catch(() => {
      setStatusMsg('复制失败')
    })
  }, [store.selectedTaskDetail])

  // 判断是否显示确认卡片（待操作）
  const showConfirm = store.confirmRequest && store.selectedTaskDetail?.status === 'running' && !confirmed

  // 已确认的只读信息
  const showConfirmedInfo = confirmed && store.confirmRequest
  const confirmInfo = store.confirmRequest

  return (
    <div className="qt-container">
      {/* 标题栏 */}
      <div className="qt-header">
        <div className="qt-header-left">
          <div className="qt-header-title">报价任务</div>
          {store.activeSummary && (
            <span className={`qt-auto-status ${store.activeSummary.autoOnline ? 'qt-auto-online' : 'qt-auto-offline'}`}>
              Auto: {store.activeSummary.autoOnline ? '在线' : '离线'}
            </span>
          )}
          {store.activeSummary?.activeTask && (
            <span className="qt-active-task">
              当前: {store.activeSummary.activeTask.quotationNumber} ({store.activeSummary.activeTask.username})
            </span>
          )}
        </div>
        <button className="tp-submit-btn" onClick={() => navigate('/')}>回到主页</button>
      </div>

      {/* 主区域 */}
      <div className="qt-main">
        {/* 左侧：任务列表 */}
        <div className="qt-left">
          <div className="qt-left-header">任务列表</div>
          <div className="qt-list">
            {store.loading && <div className="qt-list-empty">加载中...</div>}
            {!store.loading && store.tasks.length === 0 && (
              <div className="qt-list-empty">暂无任务</div>
            )}
            {store.tasks.map((task) => (
              <div
                key={task.id}
                className={`qt-list-item${store.selectedTaskId === task.id ? ' qt-list-item-active' : ''}`}
                onClick={() => store.selectTask(task.id)}
              >
                <div className="qt-item-main">
                  <div className="qt-item-top">
                    <span className={`qt-badge ${STATUS_LABELS[task.status]?.cls ?? 'qt-badge-gray'}`}>
                      {STATUS_LABELS[task.status]?.zh ?? task.status}
                    </span>
                    <span className="qt-item-number">{task.quotationNumber}</span>
                  </div>
                  <div className="qt-item-meta">
                    <span>{task.lineCount} 行</span>
                    {task.successCount > 0 && <span className="qt-meta-ok">{task.successCount} 成功</span>}
                    {task.failedCount > 0 && <span className="qt-meta-err">{task.failedCount} 失败</span>}
                    <span className="qt-item-time">{formatTime(task.createdAt)}</span>
                  </div>
                </div>
                {task.status === 'queued' && (
                  <button
                    className="qt-item-cancel"
                    onClick={(e) => { e.stopPropagation(); store.cancelTask(task.id) }}
                  >
                    取消
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 右侧：主体 */}
        <div className="qt-right">
          {!store.selectedTaskId && (
            <div className="qt-empty-msg">创建新任务或选择左侧任务查看详情</div>
          )}

          {/* ====== 上部分：表单 + 预览 ====== */}
          <div className="qt-top-section">
            <div className="qt-form">
              <div className="qt-field">
                <label className="qt-label">报价单号</label>
                <input
                  className="qt-input"
                  value={quotationNumber}
                  onChange={(e) => setQuotationNumber(e.target.value)}
                  placeholder="例如 S0159713"
                />
              </div>
              <div className="qt-field">
                <label className="qt-label">自定义 Odoo 地址</label>
                <input
                  className="qt-input qt-input-disabled"
                  value="https://dukouserp.com/odoo/"
                  disabled
                  title="自定义 Odoo 地址（暂未开放）"
                />
              </div>
              <div className="qt-field qt-field-grow">
                <label className="qt-label">CSV 数据 (partModel, quantity)</label>
                <textarea
                  className="qt-textarea"
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={'02B09F,3\n02B12,1\nB15,2'}
                  rows={8}
                />
              </div>
              <div className="qt-field">
                <label className="qt-label-inline">
                  <input
                    type="checkbox"
                    checked={writeMode === 'overwrite'}
                    onChange={(e) => setWriteMode(e.target.checked ? 'overwrite' : 'append')}
                  />
                  清空原有行后重建（覆写模式）
                </label>
              </div>
              <div className="qt-actions">
                <button className="tp-submit-btn" onClick={handleSubmit} disabled={store.submitting}>
                  {store.submitting ? '提交中...' : '提交任务'}
                </button>
                <button className="qt-clear-btn" onClick={handleClearDraft}>清空</button>
              </div>
              {statusMsg && <div className="qt-status-msg">{statusMsg}</div>}
            </div>

            <div className="qt-preview">
              <div className="qt-section-label">预览 ({previewLines.length} 行)</div>
              <div className="qt-table-wrap">
                <table className="qt-table">
                  <thead>
                    <tr>
                      <th className="qt-th-sku">SKU</th>
                      <th className="qt-th-qty">数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLines.length === 0 && (
                      <tr><td colSpan={2} className="qt-td-empty">—</td></tr>
                    )}
                    {previewLines.map((l, i) => (
                      <tr key={i}>
                        <td className="qt-td-sku">{l.partModel}</td>
                        <td className="qt-td-qty">{l.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ====== 中部分：确认卡片 / 公司 + 已有行信息 ====== */}
          {(showConfirm || showConfirmedInfo) && (
            <div className={`qt-mid-section ${showConfirm ? 'qt-confirm-pending' : ''}`}>
              <div className="qt-section-label">
                {showConfirm ? '等待确认' : '已确认'} — 公司: {confirmInfo?.company || '—'}
              </div>
              <div className="qt-mid-grid">
                <div className="qt-mid-col">
                  <div className="qt-sub-label">Odoo 已有行</div>
                  <div className="qt-table-wrap qt-table-sm">
                    <table className="qt-table">
                      <thead>
                        <tr><th>型号</th><th>数量</th></tr>
                      </thead>
                      <tbody>
                        {(!confirmInfo?.existingLines || confirmInfo.existingLines.length === 0) && (
                          <tr><td colSpan={2} className="qt-td-empty">无已有行</td></tr>
                        )}
                        {confirmInfo?.existingLines?.map((l, i) => (
                          <tr key={i}>
                            <td>{l.productModel}</td>
                            <td>{l.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="qt-mid-col">
                  <div className="qt-sub-label">即将写入行</div>
                  <div className="qt-table-wrap qt-table-sm">
                    <table className="qt-table">
                      <thead>
                        <tr><th>型号</th><th>数量</th></tr>
                      </thead>
                      <tbody>
                        {confirmInfo?.inputLines?.map((l, i) => (
                          <tr key={i}>
                            <td>{l.partModel}</td>
                            <td>{l.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              {showConfirm && (
                <div className="qt-confirm-actions">
                  <button className="tp-submit-btn" onClick={() => handleConfirm('confirmed')}>确认</button>
                  <button className="qt-reject-btn" onClick={() => handleConfirm('rejected')}>拒绝</button>
                </div>
              )}
            </div>
          )}

          {/* ====== 下部分：执行日志 + 最终快照 ====== */}
          {store.sseLog.length > 0 && (
            <div className="qt-bot-section">
              <div className="qt-section-label">执行日志</div>
              <div className="qt-log-list">
                {store.sseLog.map((entry: QuotationLogEntry) => (
                  <div key={entry.id} className={`qt-log-entry qt-log-${entry.kind}`}>
                    <span className="qt-log-icon">
                      {entry.kind === 'line-success' ? '\u2713' : entry.kind === 'line-failed' ? '\u2717' : entry.kind === 'task-done' ? '\u25CF' : '\u2139'}
                    </span>
                    <span className="qt-log-msg">{entry.message}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>

              {/* 最终快照表格 */}
              {store.finalSnapshot && store.finalSnapshot.length > 0 && (
                <div className="qt-snapshot-section">
                  <div className="qt-section-label">Odoo 页面最终行（以页面为准）</div>
                  <div className="qt-table-wrap">
                    <table className="qt-table">
                      <thead>
                        <tr><th>型号</th><th>数量</th></tr>
                      </thead>
                      <tbody>
                        {store.finalSnapshot.map((l: QuotationSnapshotLine, i: number) => (
                          <tr key={i}>
                            <td>{l.productModel}</td>
                            <td>{l.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 复制失败行 */}
              {store.selectedTaskDetail && store.selectedTaskDetail.lines.some((l) => l.status === 'failed') && (
                <div className="qt-copy-failed-row">
                  <button className="tp-submit-btn qt-copy-failed-btn" onClick={handleCopyFailed}>
                    复制失败行 CSV
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 选中任务的详情（非 running 状态，从 REST 加载） */}
          {store.selectedTaskDetail && store.selectedTaskDetail.status !== 'running' && store.sseLog.length === 0 && (
            <div className="qt-bot-section">
              <div className="qt-section-label">任务结果</div>
              {store.selectedTaskDetail.lines && store.selectedTaskDetail.lines.length > 0 && (
                <div className="qt-table-wrap">
                  <table className="qt-table">
                    <thead>
                      <tr><th>#</th><th>SKU</th><th>数量</th><th>状态</th><th>错误</th></tr>
                    </thead>
                    <tbody>
                      {store.selectedTaskDetail.lines.map((l) => (
                        <tr key={l.lineNo} className={l.status === 'failed' ? 'qt-row-failed' : l.status === 'success' ? 'qt-row-ok' : ''}>
                          <td>{l.lineNo}</td>
                          <td>{l.partModel}</td>
                          <td>{l.quantity}</td>
                          <td>{l.status}</td>
                          <td className="qt-td-err">{l.error || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {store.selectedTaskDetail.finalLinesSnapshot && (
                <div className="qt-snapshot-section">
                  <div className="qt-section-label">Odoo 页面最终行</div>
                  <div className="qt-table-wrap">
                    <table className="qt-table">
                      <thead>
                        <tr><th>型号</th><th>数量</th></tr>
                      </thead>
                      <tbody>
                        {(() => {
                          try {
                            const snap: QuotationSnapshotLine[] = JSON.parse(store.selectedTaskDetail.finalLinesSnapshot)
                            return snap.map((l, i) => (
                              <tr key={i}>
                                <td>{l.productModel}</td>
                                <td>{l.quantity}</td>
                              </tr>
                            ))
                          } catch { return null }
                        })()}
                        {/* fallback if parse failed */}
                        {(() => { try { JSON.parse(store.selectedTaskDetail.finalLinesSnapshot || ''); return false } catch { return true } })() && (
                          <tr><td colSpan={2} className="qt-td-empty">无法解析快照数据</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {store.selectedTaskDetail.taskError && (
                <div className="qt-task-error">错误: {store.selectedTaskDetail.taskError}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
