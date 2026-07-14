/**
 * WebSocket Worker 处理程序 —— auto 服务连接、鉴权、任务派发与断线回收
 *
 * 端点：/api/auto/connect（WebSocket upgrade）
 *
 * 流程：
 *  1. auto 连接 → 发送 hello(token) → server 比对 AUTO_WORKER_TOKEN
 *  2. 鉴权通过后，auto 发送 ready → server 派发队头 queued 任务（若有）
 *  3. auto 发送 accepted → server 将任务标记 running
 *  4. auto 逐行发送 line-result → server 持久化 + SSE 广播
 *  5. auto 发送 task-completed/task-failed → server 写入最终状态 + SSE 广播
 *  6. auto 再次发送 ready → 回到步骤 2
 *
 * 首版仅支持单个 worker（单 token），用全局变量跟踪当前连接。
 */

import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config/env.js';
import {
  inboundMessageSchema,
  PROTOCOL_VERSION,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_CHECK_INTERVAL_MS,
  type InboundMessage,
  type OutboundMessage,
  type TaskAssignedMessage,
} from './ws-protocol.js';
import {
  getNextQueuedTask,
  markTaskRunning,
  updateLineResult,
  updateTaskStatus,
  computeFinalStatus,
  getLastAckedAttempt,
  ackAttempt,
  getRunningTaskIds,
  reclaimTaskOnDisconnect,
  getTaskByIdRaw,
  setPendingConfirmation,
  getPendingConfirmation,
  clearPendingConfirmation,
  setFinalLinesSnapshot,
} from '../db/quotation.js';
import { setNotifyTaskQueued } from '../routes/quotation.js';
import { broadcastQuotationEvent } from '../routes/quotation.js';
import { setAutoOnline, setActiveTask } from './ws-state.js';
import {
  broadcastAgentStatus,
  broadcastQueueUpdate,
  broadcastTaskUpdateToOwner,
} from './global-sse-broadcast.js';

// ==================================================================
//  Worker 连接状态
// ==================================================================

interface WorkerConnection {
  ws: WebSocket;
  authenticated: boolean;
  ready: boolean;
  lastHeartbeat: number;
}

let wss: WebSocketServer | null = null;
let worker: WorkerConnection | null = null;
let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;

/** 心跳超时阈值（毫秒）—— 超过此时间未收到心跳视为断线 */
const HEARTBEAT_TIMEOUT = HEARTBEAT_TIMEOUT_MS;

// ==================================================================
//  出站消息发送
// ==================================================================

function sendMessage(ws: WebSocket, msg: OutboundMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws: WebSocket, message: string): void {
  sendMessage(ws, { type: 'error', message });
}

function sendAck(ws: WebSocket, taskId: number, attempt: number): void {
  sendMessage(ws, { type: 'ack', taskId, attempt });
}

// ==================================================================
//  任务派发
// ==================================================================

/** 尝试向空闲 worker 派发队头任务 */
function tryDispatch(): void {
  if (!worker || !worker.authenticated || !worker.ready) return;
  if (worker.ws.readyState !== WebSocket.OPEN) return;

  const task = getNextQueuedTask();
  if (!task) return; // 无排队任务，保持 worker ready 等待

  // 标记 worker 忙碌，避免重复派发
  worker.ready = false;

  const assigned: TaskAssignedMessage = {
    type: 'task-assigned',
    taskId: task.id,
    quotationNumber: task.quotationNumber,
    writeMode: task.writeMode,
    lines: task.lines.map((l) => ({
      lineNo: l.lineNo,
      partModel: l.partModel,
      quantity: l.quantity,
    })),
  };
  sendMessage(worker.ws, assigned);
}

// ==================================================================
//  幂等检查
// ==================================================================

/**
 * 检查消息是否为重复（attempt <= last_acked_attempt）。
 * 返回 true 表示是重复消息，应丢弃（仅回复 ack）。
 */
function isDuplicate(taskId: number, attempt: number): boolean {
  return attempt <= getLastAckedAttempt(taskId);
}

// ==================================================================
//  入站消息处理
// ==================================================================

function handleHello(conn: WorkerConnection, ws: WebSocket, msg: Extract<InboundMessage, { type: 'hello' }>): void {
  if (conn.authenticated) return; // 已认证，忽略重复 hello

  if (msg.version !== PROTOCOL_VERSION) {
    sendError(ws, `协议版本不兼容（server 期望 ${PROTOCOL_VERSION}，收到 ${msg.version}）`);
    ws.close(4001, 'protocol version mismatch');
    return;
  }

  if (!config.autoWorkerToken || msg.token !== config.autoWorkerToken) {
    sendError(ws, 'worker token 无效');
    ws.close(4003, 'invalid token');
    return;
  }

  conn.authenticated = true;
  conn.lastHeartbeat = Date.now();
  setAutoOnline(true);
  console.log('[ws] auto worker 已认证并连接');

  // 通知全局 SSE 订阅者 Agent 已上线
  broadcastAgentStatus();

  // 注意：不在此处派发任务。等 auto 主动发送 ready 后再派发。
  // auto 发送 ready 的时机：连接后立即发送，以及每个任务结束后发送。
}

function handleReady(conn: WorkerConnection): void {
  if (!conn.authenticated) return;
  conn.ready = true;
  tryDispatch();
}

function handleAccepted(conn: WorkerConnection, ws: WebSocket, msg: Extract<InboundMessage, { type: 'accepted' }>): void {
  if (!conn.authenticated) return;

  const { taskId, attempt } = msg;
  if (isDuplicate(taskId, attempt)) {
    sendAck(ws, taskId, attempt);
    return;
  }

  // 标记任务为 running（幂等：仅 queued/running 可更新）
  markTaskRunning(taskId);
  setActiveTask(taskId);
  ackAttempt(taskId, attempt);
  sendAck(ws, taskId, attempt);

  broadcastQuotationEvent(taskId, {
    type: 'task-status',
    data: { taskId, status: 'running' },
  });

  // 全局 SSE：Agent 状态变化（activeTask 改变）+ 任务 owner 列表更新
  broadcastAgentStatus();
  broadcastTaskUpdateToOwner(taskId);
  broadcastQueueUpdate();
}

function handleLineResult(ws: WebSocket, msg: Extract<InboundMessage, { type: 'line-result' }>): void {
  if (!worker?.authenticated) return;
  const { taskId, lineNo, status, error, attempt } = msg;

  if (isDuplicate(taskId, attempt)) {
    sendAck(ws, taskId, attempt);
    return;
  }

  updateLineResult(taskId, lineNo, status, error ?? null);
  ackAttempt(taskId, attempt);
  sendAck(ws, taskId, attempt);

  broadcastQuotationEvent(taskId, {
    type: 'line-result',
    data: { taskId, lineNo, status, error },
  });
}

function handleTaskCompleted(ws: WebSocket, msg: Extract<InboundMessage, { type: 'task-completed' }>): void {
  if (!worker?.authenticated) return;
  const { taskId, status, attempt, finalSnapshot } = msg;

  if (isDuplicate(taskId, attempt)) {
    sendAck(ws, taskId, attempt);
    return;
  }

  // 若任务已被回收（断线后回退为 queued 或标记 failed），丢弃陈旧结果
  const task = getTaskByIdRaw(taskId);
  if (!task || task.status !== 'running') {
    ackAttempt(taskId, attempt);
    sendAck(ws, taskId, attempt);
    console.log(`[ws] 任务 #${taskId} 当前状态为 ${task?.status ?? 'null'}，丢弃陈旧 task-completed`);
    return;
  }

  // 根据 auto 上报的行结果已是最终；server 用 DB 行结果复核最终状态
  const finalStatus = computeFinalStatus(taskId);
  // 若 auto 报告 completed 但 DB 复核为 partial_failed/failed，以 DB 为准（更可信）
  const resolvedStatus = finalStatus === 'completed' ? status : finalStatus;
  updateTaskStatus(taskId, resolvedStatus);
  ackAttempt(taskId, attempt);
  sendAck(ws, taskId, attempt);
  setActiveTask(null);

  // 保存最终快照
  if (finalSnapshot && finalSnapshot.length > 0) {
    setFinalLinesSnapshot(taskId, finalSnapshot);
  }

  broadcastQuotationEvent(taskId, {
    type: 'task-completed',
    data: { taskId, status: resolvedStatus, finalSnapshot },
  });

  // 任务结束后 worker 会发送 ready，这里不主动派发

  // 全局 SSE：Agent activeTask 清空 + 任务 owner 列表更新
  broadcastAgentStatus();
  broadcastTaskUpdateToOwner(taskId);
  broadcastQueueUpdate();
}

function handleTaskFailed(ws: WebSocket, msg: Extract<InboundMessage, { type: 'task-failed' }>): void {
  if (!worker?.authenticated) return;
  const { taskId, error, attempt } = msg;

  if (isDuplicate(taskId, attempt)) {
    sendAck(ws, taskId, attempt);
    return;
  }

  // 若任务已被回收，丢弃陈旧失败结果
  const task = getTaskByIdRaw(taskId);
  if (!task || task.status !== 'running') {
    ackAttempt(taskId, attempt);
    sendAck(ws, taskId, attempt);
    console.log(`[ws] 任务 #${taskId} 当前状态为 ${task?.status ?? 'null'}，丢弃陈旧 task-failed`);
    return;
  }

  updateTaskStatus(taskId, 'failed', error);
  ackAttempt(taskId, attempt);
  sendAck(ws, taskId, attempt);
  setActiveTask(null);

  broadcastQuotationEvent(taskId, {
    type: 'task-completed',
    data: { taskId, status: 'failed', error },
  });

  // 全局 SSE：Agent activeTask 清空 + 任务 owner 列表更新
  broadcastAgentStatus();
  broadcastTaskUpdateToOwner(taskId);
  broadcastQueueUpdate();
}

function handleHeartbeat(conn: WorkerConnection, ws: WebSocket): void {
  conn.lastHeartbeat = Date.now();
  sendMessage(ws, { type: 'heartbeat-ack' });
}

function handleConfirmRequest(ws: WebSocket, msg: Extract<InboundMessage, { type: 'confirm-request' }>): void {
  if (!worker?.authenticated) return;
  const { taskId, company, quotationNumber, existingLines, inputLines, attempt } = msg;

  if (isDuplicate(taskId, attempt)) {
    sendAck(ws, taskId, attempt);
    return;
  }

  const task = getTaskByIdRaw(taskId);
  if (!task || task.status !== 'running') {
    ackAttempt(taskId, attempt);
    sendAck(ws, taskId, attempt);
    return;
  }

  const payload = { company, quotationNumber, existingLines, inputLines };
  setPendingConfirmation(taskId, payload);
  ackAttempt(taskId, attempt);
  sendAck(ws, taskId, attempt);

  broadcastQuotationEvent(taskId, {
    type: 'confirm-request',
    data: { taskId, company, quotationNumber, existingLines, inputLines },
  });
}

function handleProgress(ws: WebSocket, msg: Extract<InboundMessage, { type: 'progress' }>): void {
  if (!worker?.authenticated) return;
  const { taskId, message, attempt } = msg;

  if (isDuplicate(taskId, attempt)) {
    sendAck(ws, taskId, attempt);
    return;
  }

  ackAttempt(taskId, attempt);
  sendAck(ws, taskId, attempt);

  broadcastQuotationEvent(taskId, {
    type: 'progress',
    data: { taskId, message },
  });
}

// ==================================================================
//  消息路由
// ==================================================================

function handleMessage(conn: WorkerConnection, ws: WebSocket, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendError(ws, '消息不是合法 JSON');
    return;
  }

  const result = inboundMessageSchema.safeParse(parsed);
  if (!result.success) {
    sendError(ws, `消息格式校验失败：${result.error.issues[0]?.message ?? '未知错误'}`);
    return;
  }

  const msg = result.data;

  // hello 是唯一的未鉴权消息
  if (msg.type === 'hello') {
    handleHello(conn, ws, msg);
    return;
  }

  // 其余消息均需先鉴权
  if (!conn.authenticated) {
    sendError(ws, '未认证：请先发送 hello');
    return;
  }

  switch (msg.type) {
    case 'ready':
      handleReady(conn);
      break;
    case 'accepted':
      handleAccepted(conn, ws, msg);
      break;
    case 'line-result':
      handleLineResult(ws, msg);
      break;
    case 'task-completed':
      handleTaskCompleted(ws, msg);
      break;
    case 'task-failed':
      handleTaskFailed(ws, msg);
      break;
    case 'heartbeat':
      handleHeartbeat(conn, ws);
      break;
    case 'confirm-request':
      handleConfirmRequest(ws, msg);
      break;
    case 'progress':
      handleProgress(ws, msg);
      break;
  }
}

// ==================================================================
//  断线处理与回收
// ==================================================================

/** worker 断线：回收所有 running 任务，清理状态 */
function handleWorkerDisconnect(reason: string): void {
  if (!worker) return;

  console.log(`[ws] auto worker 断线：${reason}`);
  const ws = worker.ws;
  worker = null;
  setAutoOnline(false);
  setActiveTask(null);

  // 回收所有 running 任务
  const runningIds = getRunningTaskIds();
  for (const taskId of runningIds) {
    const { status } = reclaimTaskOnDisconnect(taskId);
    broadcastQuotationEvent(taskId, {
      type: 'task-status',
      data: { taskId, status },
    });
    console.log(`[ws] 任务 #${taskId} 回收为 ${status}`);
    // 全局 SSE：通知该任务 owner 其任务状态变化
    broadcastTaskUpdateToOwner(taskId);
  }

  // 全局 SSE：Agent 离线 + 队列可能因回收而变化
  broadcastAgentStatus();
  if (runningIds.length > 0) {
    broadcastQueueUpdate();
  }

  // 关闭底层连接（若尚未关闭）
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1001, 'server side cleanup');
  }
}

/** 心跳超时检测：周期性扫描，超时则触发断线回收 */
function startHeartbeatCheck(): void {
  if (heartbeatCheckTimer) return;
  heartbeatCheckTimer = setInterval(() => {
    if (!worker) return;
    const elapsed = Date.now() - worker.lastHeartbeat;
    if (elapsed > HEARTBEAT_TIMEOUT) {
      handleWorkerDisconnect(`心跳超时 (${Math.round(elapsed / 1000)}s 无心跳)`);
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

// ==================================================================
//  初始化
// ==================================================================

/**
 * 初始化 WebSocket server，挂载到指定 HTTP server 的 /api/auto/connect 路径。
 * 应在 HTTP server 启动后调用。
 */
export function initWebSocketServer(server: Server, path = '/api/auto/connect'): void {
  if (!config.autoWorkerToken) {
    console.warn('[ws] AUTO_WORKER_TOKEN 未设置，auto worker 将无法鉴权连接');
  }

  wss = new WebSocketServer({ noServer: true });

  // 拦截 HTTP upgrade，仅接受目标路径的连接
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    // 首版仅支持单个 worker：若已有连接，拒绝新连接
    if (worker) {
      sendError(ws, '已有 worker 连接，仅支持单个 worker');
      ws.close(4009, 'duplicate worker');
      return;
    }

    console.log('[ws] 收到 auto worker 连接，等待 hello 鉴权');
    const conn: WorkerConnection = {
      ws,
      authenticated: false,
      ready: false,
      lastHeartbeat: Date.now(),
    };
    worker = conn;

    ws.on('message', (data) => {
      handleMessage(conn, ws, data.toString());
    });

    ws.on('close', (code, reason) => {
      const reasonText = reason.toString() || `code=${code}`;
      // 仅当此 ws 仍是当前 worker 时才清理（防止旧连接 close 覆盖新连接）
      if (worker?.ws === ws) {
        handleWorkerDisconnect(`连接关闭 (${reasonText})`);
      }
    });

    ws.on('error', (err) => {
      console.error('[ws] 连接错误:', err.message);
      if (worker?.ws === ws) {
        handleWorkerDisconnect(`连接错误: ${err.message}`);
      }
    });

    // 配置 ws 内置 ping/pong 作为底层保障
    ws.on('pong', () => {
      if (worker?.ws === ws) {
        worker.lastHeartbeat = Date.now();
      }
    });
  });

  // 启动心跳检测
  startHeartbeatCheck();

  // 注入"新任务入队"回调，供 quotation 路由创建任务后触发派发
  setNotifyTaskQueued(tryDispatch);

  // 周期性 ping（ws 内置）
  const pingInterval = setInterval(() => {
    if (worker && worker.ws.readyState === WebSocket.OPEN) {
      worker.ws.ping();
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
  pingInterval.unref?.();
}

/** 供测试用：重置所有内部状态 */
export function resetWebSocketState(): void {
  worker = null;
  setAutoOnline(false);
  setActiveTask(null);
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }
  setNotifyTaskQueued(null);
}

/** 获取当前 worker 是否已连接且已认证 */
export function isWorkerConnected(): boolean {
  return worker?.authenticated ?? false;
}

/**
 * 向 worker 发送 confirm-response（由 REST /confirm 端点触发）。
 * 返回是否发送成功。
 */
export function sendConfirmResponse(
  taskId: number,
  decision: 'confirmed' | 'rejected',
): boolean {
  if (!worker || !worker.authenticated || worker.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  sendMessage(worker.ws, { type: 'confirm-response', taskId, decision });
  return true;
}
