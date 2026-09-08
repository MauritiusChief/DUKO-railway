/**
 * auto 服务入口 —— WebSocket 客户端、重连、心跳与任务调度
 *
 * 启动流程：
 * 1. 加载环境变量并校验
 * 2. 建立 WebSocket 连接 → 发送 hello → 等待认证 → 发送 ready
 * 3. 进入事件循环：等待 task-assigned → 执行任务 → 发送 ready → 等待下一个
 *
 * 单任务约束：同一时刻最多执行一个任务（currentTaskId）。重复/并发派发被拒绝。
 *
 * 断线策略：onDisconnected 中止正在执行的浏览器任务（context.close），
 *           并将 confirm 等待 resolve 为 timeout；任务由其 finally 块上报失败结果。
 *           服务端照旧把 running 回收为 queued，重连后该任务会被重新派发执行。
 *           重连时若任务仍在清理中，不发 ready，由 finally 在清理完成后补发。
 *
 * 重连策略：指数退避 1s → 2s → 4s → ... → 60s，每次 ±25% jitter
 */

import { WebSocket } from 'ws';
import { appConfig } from './config.js';
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  inboundMessageSchema,
  type QuotationTask,
  type LineResult,
  type OutboundMessage,
  type InboundMessage,
  type TaskAssignedMessage,
  type AckMessage,
  type ConfirmRequestMessage,
} from './protocol.js';
import {
  runQuotationTask,
  type ConfirmationRequest,
  type ConfirmationResult,
} from './browser.js';
import {
  runInventoryDownloadTask,
  runInventoryTrendTask,
  type InventoryCallbacks,
} from './browser-inventory.js';

// ==================================================================
//  重连参数
// ==================================================================

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** 计算指数退避延迟（带 ±25% jitter） */
function backoffDelay(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

// ==================================================================
//  AutoClient —— WebSocket 客户端核心
// ==================================================================

class AutoClient {
  private ws: WebSocket | null = null;
  private backoffAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedAcks = 0;
  private shuttingDown = false;

  /** 当前任务相关的 attempt 跟踪（per task） */
  private currentTaskAttempt = 0;
  /** 未收到 ack 的出站消息队列（重连后重放） */
  private pendingOutbound: OutboundMessage[] = [];

  /** 当前正在执行的任务 id（null = 空闲） */
  private currentTaskId: number | null = null;
  /** 当前任务的中止控制器（断线时 abort 以尽快终止浏览器流程） */
  private currentAbort: AbortController | null = null;

  /** 确认握手的 pending promise resolver（按 taskId） */
  private confirmResolvers = new Map<number, {
    resolve: (result: ConfirmationResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor() {
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  // ---------- 连接生命周期 ----------

  /** 启动客户端：首次连接 */
  start(): void {
    this.connect();
  }

  /** 建立 WebSocket 连接 */
  private connect(): void {
    if (this.shuttingDown) return;

    console.log(`[auto] 连接 ${appConfig.serverUrl} ...`);
    const ws = new WebSocket(appConfig.serverUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[auto] WebSocket 已连接，发送 hello');
      this.backoffAttempt = 0;
      this.missedAcks = 0;
      this.sendHello();
      this.replayPending();
      this.startHeartbeat();
      // 仅在空闲时发送 ready；执行中的任务由其 finally 块在结束后发送
      if (this.currentTaskId === null) {
        this.sendReady();
      } else {
        console.log(`[auto] 重连时任务 #${this.currentTaskId} 仍在清理中，暂不发 ready`);
      }
    });

    ws.on('message', (data) => {
      this.handleRawMessage(data.toString()).catch((err) => {
        console.error('[auto] 处理消息异常:', err);
      });
    });

    ws.on('close', (code, reason) => {
      const text = reason.toString();
      console.log(`[auto] 连接关闭 (code=${code}${text ? `, reason=${text}` : ''})`);
      this.onDisconnected();
    });

    ws.on('error', (err) => {
      console.error('[auto] 连接错误:', err.message);
    });

    ws.on('pong', () => {
      this.missedAcks = 0;
    });
  }

  /** 连接断开后的清理 + 重连 */
  private onDisconnected(): void {
    this.ws = null;
    this.stopHeartbeat();

    // 断线时取消所有挂起的确认等待（resolve 为 timeout，配合"终止为失败结果"策略）
    for (const [, entry] of this.confirmResolvers) {
      clearTimeout(entry.timer);
      entry.resolve('timeout');
    }
    this.confirmResolvers.clear();

    // 中止正在执行的浏览器任务（触发 context.close，使 runQuotationTask 尽快失败返回）
    // currentTaskId 由 handleTaskAssigned 的 finally 块清理
    if (this.currentAbort) {
      console.log(`[auto] 断线：中止正在执行的任务 #${this.currentTaskId ?? '?'}`);
      this.currentAbort.abort();
    }

    if (this.shuttingDown) return;

    this.backoffAttempt += 1;
    const delay = backoffDelay(this.backoffAttempt);
    console.log(`[auto] ${delay}ms 后重连（第 ${this.backoffAttempt} 次）...`);
    setTimeout(() => this.connect(), delay);
  }

  // ---------- 消息收发 ----------

  /** 发送出站消息 */
  private send(msg: OutboundMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** 发送 hello 完成鉴权 */
  private sendHello(): void {
    this.send({
      type: 'hello',
      version: PROTOCOL_VERSION,
      token: appConfig.workerToken,
    });
  }

  /** 发送 ready，表示可接受任务（心跳在 open 时已启动，此处不重复） */
  private sendReady(): void {
    this.send({ type: 'ready' });
  }

  /** 处理收到的原始消息 */
  private async handleRawMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[auto] 收到非 JSON 消息，已忽略');
      return;
    }

    const result = inboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(
        '[auto] 收到格式无效的消息:',
        result.error.issues[0]?.message,
      );
      return;
    }

    const msg = result.data;
    switch (msg.type) {
      case 'task-assigned':
        await this.handleTaskAssigned(msg as TaskAssignedMessage);
        break;
      case 'ack':
        this.handleAck(msg);
        break;
      case 'heartbeat-ack':
        this.missedAcks = 0;
        break;
      case 'confirm-response':
        this.handleConfirmResponse(msg);
        break;
      case 'abort':
        this.handleAbort(msg);
        break;
      case 'error':
        console.warn('[auto] server 报错:', msg.message);
        break;
    }
  }

  /** 收到 ack 后从待重放队列移除对应消息 */
  private handleAck(msg: AckMessage): void {
    const idx = this.pendingOutbound.findIndex(
      (m) =>
        (m.type === 'accepted' ||
          m.type === 'line-result' ||
          m.type === 'task-completed' ||
          m.type === 'task-failed' ||
          m.type === 'confirm-request' ||
          m.type === 'progress' ||
          m.type === 'inventory-trend-result') &&
        m.taskId === msg.taskId &&
        m.attempt === msg.attempt,
    );
    if (idx >= 0) {
      this.pendingOutbound.splice(idx, 1);
    }
  }

  /** 处理来自 server 的用户确认回应 */
  private handleConfirmResponse(msg: { type: 'confirm-response'; taskId: number; decision: 'confirmed' | 'rejected' }): void {
    const entry = this.confirmResolvers.get(msg.taskId);
    if (!entry) return; // 迟到/重复响应，忽略

    clearTimeout(entry.timer);
    this.confirmResolvers.delete(msg.taskId);
    entry.resolve(msg.decision);
  }

  /** 处理来自 server 的中止指令（用户取消 inventory 任务） */
  private handleAbort(msg: Extract<InboundMessage, { type: 'abort' }>): void {
    if (this.currentTaskId === msg.taskId && this.currentAbort) {
      console.log(`[auto] 收到 abort，中止任务 #${msg.taskId}`);
      this.currentAbort.abort();
    }
  }

  // ---------- 确认握手 ----------

  // ---------- 任务执行 ----------

  /** 收到任务后执行完整流程 */
  private async handleTaskAssigned(msg: TaskAssignedMessage): Promise<void> {
    const taskId = msg.taskId;

    // 忙碌去重：已在执行任务时不启动第二个浏览器流程
    if (this.currentTaskId !== null) {
      if (this.currentTaskId === taskId) {
        console.warn(`[auto] 任务 #${taskId} 已在执行，忽略重复派发`);
      } else {
        console.error(
          `[auto] 任务 #${taskId} 到达时仍在执行 #${this.currentTaskId}，拒绝并发派发`,
        );
      }
      return;
    }

    this.currentTaskId = taskId;
    this.currentAbort = new AbortController();
    this.currentTaskAttempt = 0;

    try {
      // 1. 发送 accepted（加入待 ack 队列）
      this.currentTaskAttempt += 1;
      const attempt = this.currentTaskAttempt;
      this.sendTracked({ type: 'accepted', taskId, attempt });

      // 2. 按 kind 分派
      switch (msg.kind) {
        case 'quotation':
          await this.runQuotationFlow(msg);
          break;
        case 'inventory-download':
          await this.runInventoryDownloadFlow(taskId);
          break;
        case 'inventory-trend':
          await this.runInventoryTrendFlow(taskId, msg.items, msg.recentMonths);
          break;
      }
    } finally {
      // 3. 清理确认状态
      const confirmEntry = this.confirmResolvers.get(taskId);
      if (confirmEntry) {
        clearTimeout(confirmEntry.timer);
        this.confirmResolvers.delete(taskId);
      }
      // 4. 清除 busy 状态
      this.currentTaskId = null;
      this.currentAbort = null;

      // 5. 若连接可用，发送 ready 等待下一个任务
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendReady();
      }
    }
  }

  /** Inventory 回调工厂（download / trend 共用） */
  private makeInventoryCallbacks(taskId: number): InventoryCallbacks {
    return {
      onProgress: async (message: string) => {
        const progressAttempt = ++this.currentTaskAttempt;
        this.sendTracked({ type: 'progress', taskId, message, attempt: progressAttempt });
      },
      onTrendResult: async (result) => {
        const resultAttempt = ++this.currentTaskAttempt;
        this.sendTracked({
          type: 'inventory-trend-result',
          taskId,
          result,
          attempt: resultAttempt,
        });
      },
    };
  }

  // ---------- quotation 流程 ----------

  private async runQuotationFlow(
    msg: Extract<TaskAssignedMessage, { kind: 'quotation' }>,
  ): Promise<void> {
    const task: QuotationTask = {
      taskId: msg.taskId,
      quotationNumber: msg.quotationNumber,
      odooUrl: msg.odooUrl,
      writeMode: msg.writeMode,
      lines: msg.lines,
    };

    console.log(
      `[auto] 开始报价任务 #${task.taskId} (${task.quotationNumber}, ${task.lines.length} 行)`,
    );

    const outcome = await runQuotationTask(task, {
      onLineResult: async (lineResult: LineResult) => {
        const lineAttempt = ++this.currentTaskAttempt;
        this.sendTracked({
          type: 'line-result',
          taskId: task.taskId,
          lineNo: lineResult.lineNo,
          status: lineResult.status,
          error: lineResult.error,
          attempt: lineAttempt,
        });
      },
      requestConfirmation: async (req: ConfirmationRequest): Promise<ConfirmationResult> => {
        return new Promise((resolve) => {
          const confirmAttempt = ++this.currentTaskAttempt;
          const timer = setTimeout(() => {
            this.confirmResolvers.delete(task.taskId);
            resolve('timeout');
          }, appConfig.confirmTimeoutMs);

          this.confirmResolvers.set(task.taskId, { resolve, timer });

          const confirmMsg: ConfirmRequestMessage = {
            type: 'confirm-request',
            taskId: task.taskId,
            company: req.company,
            quotationNumber: req.quotationNumber,
            existingLines: req.existingLines,
            inputLines: req.inputLines,
            attempt: confirmAttempt,
          };
          this.sendTracked(confirmMsg);
        });
      },
      onProgress: async (message: string) => {
        const progressAttempt = ++this.currentTaskAttempt;
        this.sendTracked({
          type: 'progress',
          taskId: task.taskId,
          message,
          attempt: progressAttempt,
        });
      },
    }, this.currentAbort!.signal);

    const finalAttempt = ++this.currentTaskAttempt;
    if (outcome.status === 'failed' && outcome.lineResults.length === 0) {
      this.sendTracked({
        type: 'task-failed',
        taskId: task.taskId,
        error: outcome.error ?? '未知任务级错误',
        attempt: finalAttempt,
      });
      console.error(`[auto] 任务 #${task.taskId} 失败: ${outcome.error}`);
    } else {
      const status: 'completed' | 'partial_failed' =
        outcome.status === 'completed' ? 'completed' : 'partial_failed';
      this.sendTracked({
        type: 'task-completed',
        taskId: task.taskId,
        kind: 'quotation',
        status,
        lines: outcome.lineResults.map((r) => {
          const original = task.lines.find((l) => l.lineNo === r.lineNo)!;
          return {
            lineNo: r.lineNo,
            partModel: original.partModel,
            quantity: original.quantity,
            ...(original.discount !== undefined ? { discount: original.discount } : {}),
            status: r.status === 'success' ? 'success' : 'failed',
            error: r.error,
          };
        }),
        finalSnapshot: outcome.finalSnapshot,
        attempt: finalAttempt,
      });
      console.log(`[auto] 任务 #${task.taskId} 完成: ${status}`);
    }
  }

  // ---------- inventory-download 流程 ----------

  private async runInventoryDownloadFlow(taskId: number): Promise<void> {
    console.log(`[auto] 开始 inventory-download 任务 #${taskId}`);
    const outcome = await runInventoryDownloadTask(
      this.makeInventoryCallbacks(taskId),
      this.currentAbort!.signal,
    );

    const finalAttempt = ++this.currentTaskAttempt;
    if (outcome.status === 'failed') {
      this.sendTracked({
        type: 'task-failed',
        taskId,
        error: outcome.error ?? '下载失败',
        attempt: finalAttempt,
      });
      console.error(`[auto] inventory-download #${taskId} 失败: ${outcome.error}`);
    } else {
      this.sendTracked({
        type: 'task-completed',
        taskId,
        kind: 'inventory-download',
        status: 'completed',
        result: { csv: outcome.csv ?? '' },
        attempt: finalAttempt,
      });
      console.log(`[auto] inventory-download #${taskId} 完成`);
    }
  }

  // ---------- inventory-trend 流程 ----------

  private async runInventoryTrendFlow(taskId: number, items: string[], recentMonths: number): Promise<void> {
    console.log(`[auto] 开始 inventory-trend 任务 #${taskId} (${items.length} 项)`);
    const outcome = await runInventoryTrendTask(
      items,
      recentMonths,
      this.makeInventoryCallbacks(taskId),
      this.currentAbort!.signal,
    );

    const finalAttempt = ++this.currentTaskAttempt;
    if (outcome.status === 'failed') {
      this.sendTracked({
        type: 'task-failed',
        taskId,
        error: outcome.error ?? '趋势查验失败',
        attempt: finalAttempt,
      });
      console.error(`[auto] inventory-trend #${taskId} 失败: ${outcome.error}`);
    } else {
      this.sendTracked({
        type: 'task-completed',
        taskId,
        kind: 'inventory-trend',
        status: 'completed',
        result: { items: outcome.items ?? [] },
        attempt: finalAttempt,
      });
      console.log(`[auto] inventory-trend #${taskId} 完成`);
    }
  }

  /** 发送需要 ack 跟踪的消息（断线重连后重放） */
  private sendTracked(msg: OutboundMessage): void {
    this.pendingOutbound.push(msg);
    this.send(msg);
  }

  // ---------- 心跳 ----------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedAcks = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.missedAcks >= HEARTBEAT_MAX_MISSED) {
        console.warn(
          `[auto] 连续 ${this.missedAcks} 次未收到 heartbeat-ack，主动断开重连`,
        );
        this.ws?.terminate();
        return;
      }
      this.missedAcks += 1;
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------- 重放 ----------

  /**
   * 重连成功后（hello 已发送），重放所有未 ack 的消息。
   */
  private replayPending(): void {
    if (this.pendingOutbound.length === 0) return;
    console.log(`[auto] 重放 ${this.pendingOutbound.length} 条未确认消息`);
    const pending = [...this.pendingOutbound];
    this.pendingOutbound = [];
    for (const msg of pending) {
      this.sendTracked(msg);
    }
  }

  // ---------- 优雅关闭 ----------

  private async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log(`[auto] 收到 ${signal}，正在关闭...`);

    this.stopHeartbeat();

    for (const [, entry] of this.confirmResolvers) {
      clearTimeout(entry.timer);
    }
    this.confirmResolvers.clear();

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000, 'auto shutdown');
        }
      } catch {
        // 忽略关闭错误
      }
    }

    process.exit(0);
  }
}

// ==================================================================
//  启动
// ==================================================================

const client = new AutoClient();
client.start();
