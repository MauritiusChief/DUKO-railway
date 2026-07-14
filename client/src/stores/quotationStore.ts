/**
 * 报价任务 Zustand Store
 *
 * 管理任务列表、当前选中任务详情、active 状态、排队队列、草稿、SSE 实时日志。
 *
 * SSE 分两路：
 *  - 全局 SSE（/api/quotation-tasks/events）：Agent 在线状态、任务列表、排队队列
 *  - per-task SSE（/api/quotation-tasks/:id/events）：选中任务的逐行日志、确认握手、完成
 *
 * 两路均使用 ReconnectingSSE（受控重连 + 指数退避）。
 */

import { create } from 'zustand'
import { fetchWithAuth } from '../lib/fetchWithAuth'
import { ReconnectingSSE } from '../lib/sseStream'
import { tOutside } from '../i18n/context'
import type {
  QuotationTaskSummary,
  QuotationTaskDetail,
  ActiveTaskSummaryResponse,
  QuotationDraft,
  QuotationSnapshotLine,
  QueueSummary,
} from '../types'

const DRAFT_KEY = 'duko_quotation_draft'

const TERMINAL_STATUSES = ['completed', 'partial_failed', 'failed', 'cancelled']

/**
 * 构造行结果日志消息（SSE 实时推送与 REST mergeDetail 共用）。
 * 统一格式为 "#N MODEL xQTY <status>" 或 "#N MODEL xQTY <status> — <error>"。
 */
function buildLineResultMessage(
  lineNo: number,
  partModel: string,
  quantity: number,
  status: 'success' | 'failed',
  error?: string | null,
): string {
  const desc = `${partModel} x${quantity}`
  if (status === 'success') {
    return tOutside('logLineSuccess', { line: String(lineNo), desc })
  }
  return tOutside('logLineFailed', {
    line: String(lineNo),
    desc,
    error: error || tOutside('未知错误'),
  })
}

/**
 * 构造任务完成/终态日志消息（SSE 实时推送与 REST mergeDetail 共用）。
 * 返回 undefined 表示当前状态无需生成完成提示。
 */
function buildTaskDoneMessage(status: string, taskError?: string | null): string | undefined {
  switch (status) {
    case 'completed':
      return tOutside('全部完成')
    case 'partial_failed':
      return tOutside('部分行失败')
    case 'failed':
      return tOutside('logTaskFailed', { error: taskError ? `：${taskError}` : '' })
    case 'cancelled':
      return tOutside('任务已取消')
    default:
      return undefined
  }
}

// 模块级 SSE 实例（非响应式，避免触发不必要的渲染）
let globalSSE: ReconnectingSSE | null = null
let taskSSE: ReconnectingSSE | null = null

/** SSE 日志条目 */
export interface QuotationLogEntry {
  id: string
  lineNo?: number
  kind: 'line-success' | 'line-failed' | 'info' | 'task-done'
  message: string
  timestamp: number
}

/** Zustand set 的完整签名（支持对象与函数两种形式） */
type StoreSet = (
  partial: Partial<QuotationStore> | ((state: QuotationStore) => Partial<QuotationStore>),
) => void

interface QuotationStore {
  tasks: QuotationTaskSummary[]
  selectedTaskId: number | null
  selectedTaskDetail: QuotationTaskDetail | null
  activeSummary: ActiveTaskSummaryResponse | null
  queueSummary: QueueSummary | null
  draft: QuotationDraft | null

  /** SSE 实时日志（当前观看任务） */
  sseLog: QuotationLogEntry[]

  /** 确认请求 */
  confirmRequest: {
    taskId: number
    company: string
    quotationNumber: string
    existingLines: QuotationSnapshotLine[]
    inputLines: { partModel: string; quantity: number }[]
  } | null

  /** 最终快照 */
  finalSnapshot: QuotationSnapshotLine[] | null

  loading: boolean
  detailLoading: boolean
  submitting: boolean

  fetchTasks: () => Promise<void>
  fetchActiveStatus: () => Promise<void>
  selectTask: (taskId: number) => Promise<void>
  refreshSelectedDetail: () => Promise<QuotationTaskDetail | null>
  createTask: (quotationNumber: string, odooUrl: string, writeMode: 'overwrite' | 'append', lines: { partModel: string; quantity: number }[]) => Promise<number | null>
  cancelTask: (taskId: number) => Promise<boolean>
  confirmTask: (taskId: number, decision: 'confirmed' | 'rejected') => Promise<boolean>

  initGlobalSSE: () => void
  cleanupSSE: () => void
  deselectTask: () => void
  subscribeTaskSSE: (taskId: number) => void
  unsubscribeTaskSSE: () => void

  loadDraft: () => void
  saveDraft: (partial: Partial<QuotationDraft>) => void
  clearDraft: () => void
  setConfirmRequest: (req: QuotationStore['confirmRequest']) => void
  setFinalSnapshot: (snapshot: QuotationSnapshotLine[] | null) => void
}

export const useQuotationStore = create<QuotationStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  selectedTaskDetail: null,
  activeSummary: null,
  queueSummary: null,
  draft: null,
  sseLog: [],
  confirmRequest: null,
  finalSnapshot: null,
  loading: false,
  detailLoading: false,
  submitting: false,

  fetchTasks: async () => {
    set({ loading: true })
    try {
      const res = await fetchWithAuth('/api/quotation-tasks')
      if (res.ok) {
        const data: QuotationTaskSummary[] = await res.json()
        set({ tasks: data })
      }
    } finally {
      set({ loading: false })
    }
  },

  fetchActiveStatus: async () => {
    try {
      const res = await fetchWithAuth('/api/quotation-tasks/active')
      if (res.ok) {
        const data: ActiveTaskSummaryResponse = await res.json()
        set({ activeSummary: data })
      }
    } catch { /* ignore */ }
  },

  selectTask: async (taskId: number) => {
    const isSwitch = get().selectedTaskId !== taskId
    // 仅在切换到不同任务时清空实时日志/确认/快照
    if (isSwitch) {
      set({
        sseLog: [],
        confirmRequest: null,
        finalSnapshot: null,
        selectedTaskDetail: null,
      })
    }
    set({ selectedTaskId: taskId, detailLoading: true })

    const detail = await get().refreshSelectedDetail()

    // 非终态任务（queued/running）订阅 per-task SSE；终态任务不维持 SSE
    if (detail && (detail.status === 'queued' || detail.status === 'running')) {
      get().subscribeTaskSSE(taskId)
    } else {
      get().unsubscribeTaskSSE()
    }

    set({ detailLoading: false })
  },

  /** 取消选中任务，回到未选中状态 */
  deselectTask: () => {
    get().unsubscribeTaskSSE()
    set({
      selectedTaskId: null,
      selectedTaskDetail: null,
      sseLog: [],
      confirmRequest: null,
      finalSnapshot: null,
      detailLoading: false,
    })
  },

  /** 刷新当前选中任务的详情，合并 sseLog（不清空） */
  refreshSelectedDetail: async () => {
    const taskId = get().selectedTaskId
    if (taskId == null) return null
    try {
      const res = await fetchWithAuth(`/api/quotation-tasks/${taskId}`)
      if (res.ok) {
        const detail: QuotationTaskDetail = await res.json()
        mergeDetail(detail, set, get)
        return detail
      }
    } catch { /* ignore */ }
    return null
  },

  createTask: async (quotationNumber, odooUrl, writeMode, lines) => {
    set({ submitting: true })
    try {
      const res = await fetchWithAuth('/api/quotation-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotationNumber, odooUrl, writeMode, lines }),
      })
      if (res.ok) {
        const data: QuotationTaskSummary = await res.json()
        // 全局 SSE 会推送 task-update + queue-update，这里无需手动 fetchTasks
        return data.id
      }
      return null
    } finally {
      set({ submitting: false })
    }
  },

  cancelTask: async (taskId) => {
    try {
      const res = await fetchWithAuth(`/api/quotation-tasks/${taskId}/cancel`, { method: 'POST' })
      if (res.ok) {
        // 全局 SSE 会推送更新；如选中该任务则刷新详情
        const detail = get().selectedTaskDetail
        if (detail && detail.id === taskId) {
          get().refreshSelectedDetail()
        }
        return true
      }
    } catch { /* ignore */ }
    return false
  },

  confirmTask: async (taskId, decision) => {
    try {
      const res = await fetchWithAuth(`/api/quotation-tasks/${taskId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      return res.ok
    } catch {
      return false
    }
  },

  // ---------- SSE 生命周期 ----------

  initGlobalSSE: () => {
    // 首次加载做一次轻量 REST 拉取，SSE 随后接管实时更新
    get().fetchTasks()
    get().fetchActiveStatus()

    if (globalSSE) return
    globalSSE = new ReconnectingSSE('/api/quotation-tasks/events', {
      onEvent: (type, data) => handleGlobalSSEEvent(type, data, set, get),
      shouldReconnect: (status) => status !== 401 && status !== 403,
      onStatus: (s) => console.log('[qt-global-sse]', s),
    })
    globalSSE.start()
  },

  cleanupSSE: () => {
    globalSSE?.stop()
    globalSSE = null
    taskSSE?.stop()
    taskSSE = null
  },

  subscribeTaskSSE: (taskId: number) => {
    // 切换任务时先停掉旧连接，避免旧任务事件污染新任务 store
    taskSSE?.stop()
    taskSSE = new ReconnectingSSE(`/api/quotation-tasks/${taskId}/events`, {
      onEvent: (type, data) => {
        // 丢弃旧任务残留事件
        if (data.taskId !== undefined && data.taskId !== get().selectedTaskId) return
        handleTaskSSEEvent(type, data, set, get)
      },
      shouldReconnect: (status) => {
        if (status === 401 || status === 403) return false
        // 终态任务不重连
        const d = get().selectedTaskDetail
        if (d && TERMINAL_STATUSES.includes(d.status)) return false
        return true
      },
      onStatus: (s) => console.log(`[qt-task-sse #${taskId}]`, s),
    })
    taskSSE.start()
  },

  unsubscribeTaskSSE: () => {
    taskSSE?.stop()
    taskSSE = null
  },

  // ---------- 草稿 ----------

  loadDraft: () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const draft: QuotationDraft = JSON.parse(raw)
        set({ draft })
      }
    } catch { /* ignore */ }
  },

  saveDraft: (partial) => {
    const current = get().draft ?? {
      quotationNumber: '',
      odooUrl: '',
      writeMode: 'append',
      csvText: '',
      savedAt: 0,
    }
    const next: QuotationDraft = { ...current, ...partial, savedAt: Date.now() }
    set({ draft: next })
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(next))
    } catch { /* ignore */ }
  },

  clearDraft: () => {
    set({ draft: null })
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch { /* ignore */ }
  },

  setConfirmRequest: (req) => {
    set({ confirmRequest: req })
  },

  setFinalSnapshot: (snapshot) => {
    set({ finalSnapshot: snapshot })
  },
}))

// ==================================================================
//  全局 SSE 事件处理
// ==================================================================

function handleGlobalSSEEvent(
  type: string,
  data: any,
  set: StoreSet,
  get: () => QuotationStore,
): void {
  switch (type) {
    case 'agent-status':
      set({ activeSummary: data as ActiveTaskSummaryResponse })
      break

    case 'my-tasks':
      set({ tasks: data.tasks as QuotationTaskSummary[] })
      break

    case 'task-update': {
      const updated: QuotationTaskSummary = data.task
      set((s) => {
        const idx = s.tasks.findIndex((t) => t.id === updated.id)
        if (idx >= 0) {
          const tasks = [...s.tasks]
          tasks[idx] = updated
          return { tasks }
        }
        // 新任务插入到列表头部（按 created_at DESC）
        return { tasks: [updated, ...s.tasks] }
      })
      break
    }

    case 'queue-update':
      set({ queueSummary: data as QueueSummary })
      break
  }
}

// ==================================================================
//  per-task SSE 事件处理
// ==================================================================

function handleTaskSSEEvent(
  type: string,
  data: any,
  set: StoreSet,
  get: () => QuotationStore,
): void {
  switch (type) {
    case 'snapshot': {
      // 更新状态，并通过 REST 刷新完整详情（含 partModel 等 snapshot 缺失的字段）
      const state = get()
      if (state.selectedTaskDetail) {
        set({
          selectedTaskDetail: { ...state.selectedTaskDetail, status: data.status },
        })
      }
      get().refreshSelectedDetail()
      break
    }

    case 'task-status': {
      const state = get()
      if (state.selectedTaskDetail && data.taskId === state.selectedTaskId) {
        set({
          selectedTaskDetail: { ...state.selectedTaskDetail, status: data.status },
        })
      }
      if (TERMINAL_STATUSES.includes(data.status)) {
        get().unsubscribeTaskSSE()
      }
      break
    }

    case 'confirm-request': {
      if (data.taskId === get().selectedTaskId) {
        set({
          confirmRequest: {
            taskId: data.taskId,
            company: data.company ?? '',
            quotationNumber: data.quotationNumber ?? '',
            existingLines: data.existingLines ?? [],
            inputLines: data.inputLines ?? [],
          },
        })
      }
      break
    }

    case 'line-result': {
      if (data.taskId !== get().selectedTaskId) break
      set((s) => {
        // 按 lineNo 去重
        if (s.sseLog.some((e) => e.lineNo === data.lineNo)) return {}
        const line = s.selectedTaskDetail?.lines.find((l) => l.lineNo === data.lineNo)
        const partModel = line?.partModel ?? ''
        const quantity = line?.quantity ?? 0
        const entry: QuotationLogEntry = {
          id: `sse-${data.lineNo}-${Date.now()}`,
          lineNo: data.lineNo,
          kind: data.status === 'success' ? 'line-success' : 'line-failed',
          message: buildLineResultMessage(data.lineNo, partModel, quantity, data.status, data.error),
          timestamp: Date.now(),
        }
        return { sseLog: [...s.sseLog, entry] }
      })
      break
    }

    case 'progress': {
      if (data.taskId !== get().selectedTaskId) break
      set((s) => ({
        sseLog: [...s.sseLog, {
          id: `progress-${Date.now()}`,
          kind: 'info',
          message: data.message,
          timestamp: Date.now(),
        }],
      }))
      break
    }

    case 'task-completed': {
      if (data.taskId !== get().selectedTaskId) break
      // 追加完成提示（按 kind 去重，避免重复）
      set((s) => {
        if (s.sseLog.some((e) => e.kind === 'task-done')) return {}
        const msg = buildTaskDoneMessage(data.status, data.error)
        if (!msg) return {}
        const doneEntry: QuotationLogEntry = {
          id: `done-${Date.now()}`,
          kind: 'task-done',
          message: msg,
          timestamp: Date.now(),
        }
        return { sseLog: [...s.sseLog, doneEntry] }
      })

      if (data.finalSnapshot) {
        set({ finalSnapshot: data.finalSnapshot })
      }

      // 刷新详情（merge 不清空日志），然后关闭终态 SSE
      get().refreshSelectedDetail()
      get().unsubscribeTaskSSE()
      break
    }
  }
}

// ==================================================================
//  详情合并（REST 重建日志与 SSE 实时日志按 lineNo 去重）
// ==================================================================

function mergeDetail(
  detail: QuotationTaskDetail,
  set: StoreSet,
  get: () => QuotationStore,
): void {
  const state = get()
  set({ selectedTaskDetail: detail })

  // 恢复确认卡片（仅在 store 尚无确认请求时）
  if (detail.status === 'running' && detail.pendingConfirmation && !state.confirmRequest) {
    try {
      const pending = JSON.parse(detail.pendingConfirmation)
      set({
        confirmRequest: {
          taskId: detail.id,
          company: pending.company ?? '',
          quotationNumber: pending.quotationNumber ?? '',
          existingLines: pending.existingLines ?? [],
          inputLines: pending.inputLines ?? [],
        },
      })
    } catch { /* ignore */ }
  }

  // 恢复最终快照（仅在 store 尚无快照时，避免覆盖 SSE 已推送的）
  if (!state.finalSnapshot && detail.finalLinesSnapshot) {
    try {
      set({ finalSnapshot: JSON.parse(detail.finalLinesSnapshot) })
    } catch { /* ignore */ }
  }

  // 合并行结果到 sseLog（按 lineNo 去重，只追加尚未显示的行）
  if (detail.lines && detail.lines.length > 0) {
    const restored: QuotationLogEntry[] = detail.lines
      .filter((l) => l.status !== 'pending')
      .map((l) => ({
        id: `rest-${l.lineNo}`,
        lineNo: l.lineNo,
        kind: l.status === 'success' ? 'line-success' : 'line-failed',
        message: buildLineResultMessage(
          l.lineNo,
          l.partModel,
          l.quantity,
          l.status as 'success' | 'failed',
          l.error,
        ),
        timestamp: Date.now(),
      }))

    if (restored.length > 0) {
      set((s) => {
        const existingLineNos = new Set(
          s.sseLog.filter((e) => e.lineNo != null).map((e) => e.lineNo),
        )
        const toAdd = restored.filter((e) => e.lineNo != null && !existingLineNos.has(e.lineNo))
        if (toAdd.length === 0) return {}
        return { sseLog: [...s.sseLog, ...toAdd] }
      })
    }
  }

  // 终态任务：若 sseLog 尚无完成提示，补一条（页面刷新终态任务时能看到结果摘要）
  if (TERMINAL_STATUSES.includes(detail.status) && !state.sseLog.some((e) => e.kind === 'task-done')) {
    const doneMessage = buildTaskDoneMessage(detail.status, detail.taskError)
    if (doneMessage) {
      set((s) => ({
        sseLog: [...s.sseLog, {
          id: `done-rest-${detail.id}`,
          kind: 'task-done',
          message: doneMessage,
          timestamp: Date.now(),
        }],
      }))
    }
  }
}
