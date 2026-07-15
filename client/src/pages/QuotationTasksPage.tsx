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
import type { QuotationSnapshotLine } from '../types'
import './QuotationTasksPage.css'
import { useI18n } from '../i18n/context'
import { SegSwitch } from '../components/SegSwitch'

/* 状态徽标的 CSS 类名映射 */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + 'Z')
    if (isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return iso }
}

function formatLogTime(ts: number): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '--:--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate()
  const store = useQuotationStore()

  /* 状态徽标 CSS 类名映射 */
  const statusCls = (status: string): string => {
    const map: Record<string, string> = {
      queued: 'qt-badge-gray',
      running: 'qt-badge-blue',
      completed: 'qt-badge-green',
      partial_failed: 'qt-badge-orange',
      failed: 'qt-badge-red',
      cancelled: 'qt-badge-gray',
    }
    return map[status] ?? 'qt-badge-gray'
  }

  /* 状态 → i18n 翻译文字的映射 */
  const statusLabel = (status: string): string => {
    const map: Record<string, string> = {
      queued: t('排队'),
      running: t('执行中'),
      completed: t('完成'),
      partial_failed: t('部分失败'),
      failed: t('失败'),
      cancelled: t('已取消'),
    }
    return map[status] ?? status
  }

  // 本地表单状态
  const DEFAULT_ODOO_PREFIX = 'https://dukouserp.com/odoo/sales/'
  const [quotationNumber, setQuotationNumber] = useState('')
  const [odooUrl, setOdooUrl] = useState(DEFAULT_ODOO_PREFIX)
  const [csvText, setCsvText] = useState('')
  const [writeMode, setWriteMode] = useState<'overwrite' | 'append'>('append')

  const [statusMsg, setStatusMsg] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  // 初始化：启动全局 SSE + 加载草稿；卸载时清理
  useEffect(() => {
    store.initGlobalSSE()
    store.loadDraft()
    return () => store.cleanupSSE()
  }, [])

  // 恢复草稿
  useEffect(() => {
    if (store.draft) {
      setQuotationNumber(store.draft.quotationNumber || '')
      setOdooUrl(store.draft.odooUrl ?? DEFAULT_ODOO_PREFIX)
      setCsvText(store.draft.csvText || '')
      setWriteMode(store.draft.writeMode || 'append')
    }
  }, [store.draft])

  // 日志自动滚动
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [store.sseLog])

  // 解析 CSV 预览
  const previewLines = parseCSV(csvText)

  // 清空草稿
  const handleClearDraft = () => {
    setQuotationNumber('')
    setOdooUrl(DEFAULT_ODOO_PREFIX)
    setCsvText('')
    setWriteMode('append')
    store.clearDraft()
  }

  // 提交任务
  const handleSubmit = async () => {
    const lines = parseCSV(csvText)
    if (lines.length === 0) {
      setStatusMsg(t('CSV提示'))
      return
    }
    const hasQuotation = quotationNumber.trim() !== ''
    const hasOdooUrl = odooUrl.trim() !== ''
    if (!hasQuotation && !hasOdooUrl) {
      setStatusMsg(t('报价或地址缺一提示'))
      return
    }

    setStatusMsg('')
    const taskId = await store.createTask(quotationNumber.trim(), odooUrl.trim(), writeMode, lines)
    if (taskId !== null) {
      store.saveDraft({ quotationNumber: quotationNumber.trim(), odooUrl: odooUrl.trim(), writeMode, csvText })
      await store.selectTask(taskId)
      setStatusMsg(t('任务创建成功'))
    } else {
      setStatusMsg(t('任务创建失败'))
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
  // 提取失败行 CSV 文本
  const failedLinesCsv = store.selectedTaskDetail
    ? store.selectedTaskDetail.lines
        .filter((l) => l.status === 'failed')
        .map((l) => `${l.partModel},${l.quantity}`)
        .join('\n')
    : ''

  // 当前选中任务是否为终态
  const selectedIsTerminal = !!store.selectedTaskDetail
    && store.selectedTaskDetail.status !== 'running'
    && store.selectedTaskDetail.status !== 'queued'

  // 复制失败行到剪贴板
  const handleCopyFailed = useCallback(() => {
    if (!failedLinesCsv) return
    navigator.clipboard.writeText(failedLinesCsv).then(() => {
      setStatusMsg(t('复制失败行成功'))
    }).catch(() => {
      setStatusMsg(t('复制失败'))
    })
  }, [failedLinesCsv])

  // 将失败行填入 CSV 输入区（覆盖）
  const handleFillFailed = useCallback(() => {
    if (!failedLinesCsv) return
    setCsvText(failedLinesCsv)
    setStatusMsg(t('失败行已填入输入框'))
  }, [failedLinesCsv])

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
          <div className="qt-header-title">{t('报价任务页标题')}</div>
          <span className={`qt-auto-status ${store.workerOnline ? 'qt-auto-online' : 'qt-auto-offline'}`}>
            {store.workerOnline ? t('Auto在线') : t('Auto离线')}
          </span>
          {store.activeSummary?.activeTask && (
            <span className="qt-active-task">
              {t('当前执行')}: {store.activeSummary.activeTask.quotationNumber} ({store.activeSummary.activeTask.username})
            </span>
          )}
          {store.queueSummary && store.queueSummary.queuedCount > 0 && (
            <span className="qt-queue-status" title={store.queueSummary.tasks.map((t) => `${t.quotationNumber} (${t.username})`).join(', ')}>
              {t('队列排队', { n: store.queueSummary.queuedCount })}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <SegSwitch
            options={[
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            value={lang}
            onChange={setLang}
          />
          <button className="qt-submit-btn" onClick={() => navigate('/')}>{t('回到主页')}</button>
          <button className="qt-submit-btn" onClick={() => navigate('/inventory')}>库存看板</button>
        </div>
      </div>

      {/* 主区域 */}
      <div className="qt-main">
         {/* 左侧：任务列表 */}
        <div className="qt-left">
          <div className="qt-left-header">{t('任务列表')}</div>
          <div className="qt-list">
            {store.loading && <div className="qt-list-empty">{t('加载中')}</div>}
            {!store.loading && store.tasks.length === 0 && (
              <div className="qt-list-empty">{t('暂无任务')}</div>
            )}
            {store.tasks.map((task) => (
              <div
                key={task.id}
                className={`qt-list-item${store.selectedTaskId === task.id ? ' qt-list-item-active' : ''}`}
                onClick={() => store.selectTask(task.id)}
              >
                <div className="qt-item-main">
                  <div className="qt-item-top">
                    <span className={`qt-badge ${statusCls(task.status)}`}>
                      {statusLabel(task.status)}
                    </span>
                    <span className="qt-item-number">{task.quotationNumber}</span>
                  </div>
                  <div className="qt-item-meta">
                    <span>{task.lineCount} {t('行')}</span>
                    {task.successCount > 0 && <span className="qt-meta-ok">{task.successCount} {t('成功')}</span>}
                    {task.failedCount > 0 && <span className="qt-meta-err">{task.failedCount} {t('失败')}</span>}
                    <span className="qt-item-time">{formatTime(task.createdAt)}</span>
                  </div>
                </div>
                {task.status === 'queued' && (
                  <button
                    className="qt-item-cancel"
                    onClick={(e) => { e.stopPropagation(); store.cancelTask(task.id) }}
                  >
                    {t('取消任务')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 右侧：主体 */}
        <div className="qt-right">
          {/* 未选中任务时显示空态提示 */}
          {!store.selectedTaskId && (
            <div className="qt-empty-msg">{t('选择任务提示')}</div>
          )}

          {/* 已选中任务时显示返回按钮 */}
          {store.selectedTaskId && (
            <div style={{ marginBottom: '12px' }}>
              <button className="qt-submit-btn" onClick={() => store.deselectTask()}>
                &larr; {t('返回未选中')}
              </button>
            </div>
          )}

          {/* ====== 上部分：表单 + 预览（仅未选中任务时可见） ====== */}
          {!store.selectedTaskId && (
            <div className="qt-top-section">
              <div className="qt-form">
                <div className="qt-field">
                  <label className="qt-label">{t('报价单号')}</label>
                  <input
                    className="qt-input"
                    value={quotationNumber}
                    onChange={(e) => setQuotationNumber(e.target.value)}
                    placeholder="e.g. S0159713"
                  />
                </div>
                <div className="qt-field">
                  <label className="qt-label">{t('精准Odoo地址')}</label>
                  <input
                    className="qt-input"
                    value={odooUrl}
                    onChange={(e) => setOdooUrl(e.target.value)}
                  />
                </div>
                <div className="qt-field qt-field-grow">
                  <label className="qt-label">{t('CSV数据')}</label>
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
                    {t('覆写模式')}
                  </label>
                </div>
                <div className="qt-actions">
                  <button className="qt-submit-btn" onClick={handleSubmit} disabled={store.submitting}>
                    {store.submitting ? t('提交中') : t('提交任务')}
                  </button>
                  <button className="qt-clear-btn" onClick={handleClearDraft}>{t('清空')}</button>
                </div>
                {statusMsg && <div className="qt-status-msg">{statusMsg}</div>}
              </div>

              <div className="qt-preview">
                <div className="qt-section-label">{t('预览')} ({previewLines.length} {t('行')})</div>
                <div className="qt-table-wrap">
                  <table className="qt-table">
                    <thead>
                      <tr>
                        <th className="qt-th-sku">{t('型号')}</th>
                        <th className="qt-th-qty">{t('数量')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewLines.length === 0 && (
                        <tr><td colSpan={2} className="qt-td-empty">&mdash;</td></tr>
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
          )}

          {/* ====== 中部分：确认卡片 / 公司 + 已有行信息 ====== */}
          {(showConfirm || showConfirmedInfo) && (
            <div className={`qt-mid-section`}>
              <div className="qt-section-label">
                {showConfirm ? t('等待确认') : t('已确认')} &mdash; 公司: {confirmInfo?.company || '\u2014'}
              </div>
              <div className="qt-mid-grid">
                <div className="qt-mid-col">
                  <div className="qt-sub-label">{t('Odoo已有行')}</div>
                  <div className="qt-table-wrap qt-table-sm">
                    <table className="qt-table">
                      <thead>
                        <tr><th>{t('型号')}</th><th>{t('数量')}</th></tr>
                      </thead>
                      <tbody>
                        {(!confirmInfo?.existingLines || confirmInfo.existingLines.length === 0) && (
                          <tr><td colSpan={2} className="qt-td-empty">{t('无已有行')}</td></tr>
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
                  <div className="qt-sub-label">{t('即将写入行')}</div>
                  <div className="qt-table-wrap qt-table-sm">
                    <table className="qt-table">
                      <thead>
                        <tr><th>{t('型号')}</th><th>{t('数量')}</th></tr>
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
                  <button className="qt-submit-btn" onClick={() => handleConfirm('confirmed')}>{t('确认')}</button>
                  <button className="qt-reject-btn" onClick={() => handleConfirm('rejected')}>{t('拒绝')}</button>
                </div>
              )}
            </div>
          )}

          {/* ====== 下部分：执行日志 + 最终快照 ====== */}
          {store.sseLog.length > 0 && (
            <div className="qt-bot-section">
              <div className="qt-section-label">{t('执行日志')}</div>
              <div className="qt-log-list">
                {store.sseLog.map((entry: QuotationLogEntry) => (
                  <div key={entry.id} className={`qt-log-entry qt-log-${entry.kind}`}>
                    <span className="qt-log-time">{formatLogTime(entry.timestamp)}</span>
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
                  <div className="qt-section-label">{t('Odoo最终行')}</div>
                  <div className="qt-table-wrap">
                    <table className="qt-table">
                      <thead>
                        <tr><th>{t('型号')}</th><th>{t('数量')}</th></tr>
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

              {/* 失败行 CSV（终态 + 有失败行时显示，供复制回输入框补写） */}
              {selectedIsTerminal && failedLinesCsv && (
                <div className="qt-failed-csv-section">
                  <div className="qt-section-label">{t('失败行标题')}</div>
                  <pre className="qt-failed-csv-text">{failedLinesCsv}</pre>
                  <div className="qt-failed-csv-actions">
                    <button className="qt-submit-btn" onClick={handleCopyFailed}>{t('复制到剪贴板')}</button>
                    <button className="qt-clear-btn" onClick={handleFillFailed}>{t('填入输入框')}</button>
                  </div>
                </div>
              )}

              {/* 任务错误（终态 + 有错误时显示） */}
              {selectedIsTerminal && store.selectedTaskDetail?.taskError && (
                <div className="qt-task-error">{t('错误')}: {store.selectedTaskDetail.taskError}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
