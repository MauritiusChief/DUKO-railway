/**
 * 报价任务 Zustand Store
 *
 * 管理任务列表、当前选中任务详情、active 状态、草稿、SSE 实时日志。
 */

import { create } from 'zustand'
import { fetchWithAuth } from '../lib/fetchWithAuth'
import type {
  QuotationTaskSummary,
  QuotationTaskDetail,
  ActiveTaskSummaryResponse,
  QuotationDraft,
  QuotationSnapshotLine,
} from '../types'

const DRAFT_KEY = 'duko_quotation_draft'

/** SSE 日志条目 */
export interface QuotationLogEntry {
  id: string
  lineNo?: number
  kind: 'line-success' | 'line-failed' | 'info' | 'task-done'
  message: string
  timestamp: number
}

interface QuotationStore {
  tasks: QuotationTaskSummary[]
  selectedTaskId: number | null
  selectedTaskDetail: QuotationTaskDetail | null
  activeSummary: ActiveTaskSummaryResponse | null
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
  selectTask: (taskId: number) => Promise<void>
  createTask: (quotationNumber: string, writeMode: 'overwrite' | 'append', lines: { partModel: string; quantity: number }[]) => Promise<number | null>
  cancelTask: (taskId: number) => Promise<boolean>
  confirmTask: (taskId: number, decision: 'confirmed' | 'rejected') => Promise<boolean>
  fetchActiveStatus: () => Promise<void>
  subscribeSSE: (taskId: number) => AbortController
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

  selectTask: async (taskId: number) => {
    set({ selectedTaskId: taskId, detailLoading: true, selectedTaskDetail: null, sseLog: [], confirmRequest: null, finalSnapshot: null })
    try {
      const res = await fetchWithAuth(`/api/quotation-tasks/${taskId}`)
      if (res.ok) {
        const detail: QuotationTaskDetail = await res.json()
        set({ selectedTaskDetail: detail })
        // 如果任务是 running 且有 pendingConfirmation，恢复确认卡片
        if (detail.status === 'running' && detail.pendingConfirmation) {
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
        // 恢复最终快照
        if (detail.finalLinesSnapshot) {
          try {
            const snapshot = JSON.parse(detail.finalLinesSnapshot)
            set({ finalSnapshot: snapshot })
          } catch { /* ignore */ }
        }
        // 恢复已有行结果为日志
        if (detail.lines && detail.lines.length > 0) {
          const logEntries: QuotationLogEntry[] = detail.lines
            .filter((l) => l.status !== 'pending')
            .map((l) => ({
              id: `rest-${l.lineNo}`,
              lineNo: l.lineNo,
              kind: l.status === 'success' ? 'line-success' : 'line-failed',
              message: l.status === 'success'
                ? `#${l.lineNo} ${l.partModel} x${l.quantity}`
                : `#${l.lineNo} ${l.partModel} x${l.quantity} — ${l.error || '失败'}`,
              timestamp: Date.now(),
            }))
          if (logEntries.length > 0) {
            set({ sseLog: logEntries })
          }
        }
      }
    } finally {
      set({ detailLoading: false })
    }
  },

  createTask: async (quotationNumber, writeMode, lines) => {
    set({ submitting: true })
    try {
      const res = await fetchWithAuth('/api/quotation-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotationNumber, writeMode, lines }),
      })
      if (res.ok) {
        const data: QuotationTaskSummary = await res.json()
        get().fetchTasks()
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
        get().fetchTasks()
        const detail = get().selectedTaskDetail
        if (detail && detail.id === taskId) {
          get().selectTask(taskId)
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

  fetchActiveStatus: async () => {
    try {
      const res = await fetchWithAuth('/api/quotation-tasks/active')
      if (res.ok) {
        const data: ActiveTaskSummaryResponse = await res.json()
        set({ activeSummary: data })
      }
    } catch { /* ignore */ }
  },

  subscribeSSE: (taskId) => {
    const controller = new AbortController()
    const url = `/api/quotation-tasks/${taskId}/events`

    fetchWithAuth(url, { signal: controller.signal }).then(async (res) => {
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          if (!part.trim()) continue
          const lines = part.split('\n')
          let eventType = ''
          let dataStr = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              dataStr = line.slice(6)
            }
          }

          if (!eventType || !dataStr) continue

          try {
            const data = JSON.parse(dataStr)
            processSSEvent(get, set, eventType, data)
          } catch { /* ignore malformed event */ }
        }
      }
    }).catch(() => { /* connection lost */ })

    return controller
  },

  handleSSEEvent: (type: string, data: any) => {
    const state = get()
    switch (type) {
      case 'task-status':
        if (state.selectedTaskDetail && data.taskId === state.selectedTaskDetail.id) {
          set({
            selectedTaskDetail: {
              ...state.selectedTaskDetail,
              status: data.status,
            },
          })
        }
        get().fetchTasks()
        break

      case 'confirm-request':
        if (data.taskId === state.selectedTaskId) {
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

      case 'confirm-response':
        // 用户操作后 server 回执，可用于 UI 反馈
        break

      case 'line-result':
        if (data.taskId === state.selectedTaskId) {
          const entry: QuotationLogEntry = {
            id: `sse-${data.lineNo}-${Date.now()}`,
            lineNo: data.lineNo,
            kind: data.status === 'success' ? 'line-success' : 'line-failed',
            message: data.status === 'success'
              ? `#${data.lineNo} 写入成功`
              : `#${data.lineNo} 写入失败 — ${data.error || '未知错误'}`,
            timestamp: Date.now(),
          }
          set({ sseLog: [...state.sseLog, entry] })
        }
        break

      case 'task-completed':
        if (data.taskId === state.selectedTaskId) {
          const doneEntry: QuotationLogEntry = {
            id: `done-${Date.now()}`,
            kind: 'task-done',
            message: data.status === 'completed'
              ? '全部完成'
              : data.status === 'partial_failed'
                ? '部分行写入失败'
                : `任务失败${data.error ? `：${data.error}` : ''}`,
            timestamp: Date.now(),
          }
          set({ sseLog: [...state.sseLog, doneEntry] })

          if (data.finalSnapshot) {
            set({ finalSnapshot: data.finalSnapshot })
          }

          // 刷新任务详情
          get().selectTask(data.taskId)
          get().fetchTasks()
        }
        break

      case 'snapshot':
        // 初始快照：不做额外处理（selectTask 已处理完）
        break
    }
  },

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
//  SSE 事件处理（独立函数，避免 Zustand create 闭包内的类型问题）
// ==================================================================

function processSSEvent(
  get: () => QuotationStore,
  set: (partial: Partial<QuotationStore>) => void,
  type: string,
  data: any,
): void {
  const state = get()
  switch (type) {
    case 'task-status':
      if (state.selectedTaskDetail && data.taskId === state.selectedTaskDetail.id) {
        set({
          selectedTaskDetail: {
            ...state.selectedTaskDetail,
            status: data.status,
          },
        })
      }
      get().fetchTasks()
      break

    case 'confirm-request':
      if (data.taskId === state.selectedTaskId) {
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

    case 'confirm-response':
      break

    case 'line-result':
      if (data.taskId === state.selectedTaskId) {
        const entry: QuotationLogEntry = {
          id: `sse-${data.lineNo}-${Date.now()}`,
          lineNo: data.lineNo,
          kind: data.status === 'success' ? 'line-success' : 'line-failed',
          message: data.status === 'success'
            ? `#${data.lineNo} 写入成功`
            : `#${data.lineNo} 写入失败 — ${data.error || '未知错误'}`,
          timestamp: Date.now(),
        }
        set({ sseLog: [...state.sseLog, entry] })
      }
      break

    case 'task-completed':
      if (data.taskId === state.selectedTaskId) {
        const doneEntry: QuotationLogEntry = {
          id: `done-${Date.now()}`,
          kind: 'task-done',
          message: data.status === 'completed'
            ? '全部完成'
            : data.status === 'partial_failed'
              ? '部分行写入失败'
              : `任务失败${data.error ? `：${data.error}` : ''}`,
          timestamp: Date.now(),
        }
        set({ sseLog: [...state.sseLog, doneEntry] })

        if (data.finalSnapshot) {
          set({ finalSnapshot: data.finalSnapshot })
        }

        get().selectTask(data.taskId)
        get().fetchTasks()
      }
      break

    case 'snapshot':
      break
  }
}
