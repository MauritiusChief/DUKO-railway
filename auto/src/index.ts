/**
 * auto 服务入口 —— WebSocket 客户端、重连、心跳与任务调度
 *
 * 启动流程：
 * 1. 加载环境变量并校验
 * 2. 建立 WebSocket 连接 → 发送 hello → 等待认证 → 发送 ready
 * 3. 进入事件循环：等待 task-assigned → 执行任务 → 发送 ready → 等待下一个
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
} from './protocol.js';
import { runQuotationTask } from './browser.js';

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
      // hello 成功时 server 不回复，失败时会发 error 并关闭。
      // WebSocket 保证消息顺序：hello 先于 ready 被处理，因此可直接发送 ready。
      this.replayPending();
      this.sendReady();
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
      // close 事件会随后触发 onDisconnected
    });

    // ws 内置 ping/pong
    ws.on('pong', () => {
      this.missedAcks = 0;
    });
  }

  /** 连接断开后的清理 + 重连 */
  private onDisconnected(): void {
    this.ws = null;
    this.stopHeartbeat();

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

  /** 发送 ready，表示可接受任务 */
  private sendReady(): void {
    this.send({ type: 'ready' });
    this.startHeartbeat();
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
        await this.handleTaskAssigned(msg);
        break;
      case 'ack':
        this.handleAck(msg);
        break;
      case 'heartbeat-ack':
        this.missedAcks = 0;
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
          m.type === 'task-failed') &&
        m.taskId === msg.taskId &&
        m.attempt === msg.attempt,
    );
    if (idx >= 0) {
      this.pendingOutbound.splice(idx, 1);
    }
  }

  // ---------- 任务执行 ----------

  /** 收到任务后执行完整流程 */
  private async handleTaskAssigned(msg: TaskAssignedMessage): Promise<void> {
    const task: QuotationTask = {
      taskId: msg.taskId,
      quotationNumber: msg.quotationNumber,
      writeMode: msg.writeMode,
      lines: msg.lines,
    };

    this.currentTaskAttempt += 1;
    const attempt = this.currentTaskAttempt;

    // 1. 发送 accepted（加入待 ack 队列）
    this.sendTracked({
      type: 'accepted',
      taskId: task.taskId,
      attempt,
    });

    console.log(
      `[auto] 开始任务 #${task.taskId} (${task.quotationNumber}, ${task.lines.length} 行)`,
    );

    // 2. 执行浏览器任务
    const outcome = await runQuotationTask(task, async (lineResult: LineResult) => {
      // 每行完成时立即上报
      const lineAttempt = ++this.currentTaskAttempt;
      this.sendTracked({
        type: 'line-result',
        taskId: task.taskId,
        lineNo: lineResult.lineNo,
        status: lineResult.status,
        error: lineResult.error,
        attempt: lineAttempt,
      });
    });

    // 3. 上报最终结果
    const finalAttempt = ++this.currentTaskAttempt;
    if (outcome.status === 'failed' && outcome.lineResults.length === 0) {
      // 任务级失败（如登录失效、浏览器启动失败）
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
        status,
        lines: outcome.lineResults.map((r) => {
          const original = task.lines.find((l) => l.lineNo === r.lineNo)!;
          return {
            lineNo: r.lineNo,
            partModel: original.partModel,
            quantity: original.quantity,
            status: r.status === 'success' ? 'success' : 'failed',
            error: r.error,
          };
        }),
        attempt: finalAttempt,
      });
      console.log(`[auto] 任务 #${task.taskId} 完成: ${status}`);
    }

    // 4. 重置 attempt 计数，准备下一个任务
    this.currentTaskAttempt = 0;

    // 5. 发送 ready 等待下一个任务
    this.sendReady();
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
   * 在 server 确认连接稳定前调用。
   */
  private replayPending(): void {
    if (this.pendingOutbound.length === 0) return;
    console.log(`[auto] 重放 ${this.pendingOutbound.length} 条未确认消息`);
    // 复制后清空，因为 send 会重新加入队列
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
