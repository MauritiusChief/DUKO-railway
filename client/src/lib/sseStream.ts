/**
 * 受控重连的 SSE 客户端
 *
 * 浏览器原生 EventSource 不支持自定义请求头（无法带 Authorization），
 * 故沿用 fetch + ReadableStream 方式消费 text/event-stream。
 *
 * 本封装提供：有限指数退避重连、AbortController 取消、连接状态回调、
 * 事件解析。全局 SSE 与 per-task SSE 共用此逻辑。
 */

import { fetchWithAuth } from './fetchWithAuth'

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

export interface SSEStreamHandlers {
  /** 收到一个已解析的事件 */
  onEvent: (type: string, data: any) => void
  /** 是否应重连；返回 false 则停止（如终态、鉴权失败）。status 为 HTTP 状态码（流正常结束时为 undefined） */
  shouldReconnect?: (status: number | undefined, error: unknown) => boolean
  /** 连接状态变化（诊断用） */
  onStatus?: (status: 'connecting' | 'open' | 'reconnecting' | 'stopped') => void
}

export class ReconnectingSSE {
  private controller: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = false
  private backoff: number[]

  constructor(
    private url: string,
    private handlers: SSEStreamHandlers,
    backoff?: number[],
  ) {
    this.backoff = backoff ?? DEFAULT_BACKOFF_MS
  }

  /** 启动连接（若已停止则忽略） */
  start(): void {
    if (this.stopped) return
    this.connect()
  }

  /** 停止连接并中止当前请求；不再重连 */
  stop(): void {
    this.stopped = true
    this.controller?.abort()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.handlers.onStatus?.('stopped')
  }

  private connect(): void {
    if (this.stopped) return
    this.handlers.onStatus?.(this.attempt === 0 ? 'connecting' : 'reconnecting')
    this.controller = new AbortController()

    fetchWithAuth(this.url, { signal: this.controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          this.maybeReconnect(res.status, new Error(`HTTP ${res.status}`))
          return
        }

        this.attempt = 0
        this.handlers.onStatus?.('open')

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
            const parsed = parseSSEPart(part)
            if (parsed) this.handlers.onEvent(parsed.type, parsed.data)
          }
        }

        // 流正常结束（服务端关闭）—— 非终态场景下重连
        this.maybeReconnect(undefined, new Error('stream ended'))
      })
      .catch((err) => {
        if (this.stopped || this.controller?.signal.aborted) return
        this.maybeReconnect(undefined, err)
      })
  }

  private maybeReconnect(status: number | undefined, error: unknown): void {
    if (this.stopped) return
    const should = this.handlers.shouldReconnect?.(status, error) ?? true
    if (!should) {
      this.handlers.onStatus?.('stopped')
      this.stopped = true
      return
    }
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)]
    this.attempt += 1
    this.handlers.onStatus?.('reconnecting')
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}

/** 解析单个 SSE 事件块（event: ... + data: ...） */
function parseSSEPart(part: string): { type: string; data: any } | null {
  if (!part.trim()) return null
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
  if (!eventType || !dataStr) return null
  try {
    return { type: eventType, data: JSON.parse(dataStr) }
  } catch {
    return null
  }
}
