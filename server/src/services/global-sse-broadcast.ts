/**
 * 全局 SSE 广播 —— Agent 在线状态、任务列表、排队队列
 *
 * 与 sse-broadcast.ts（按 taskId 分组的 per-task SSE）互补：
 * 本模块维护"全局订阅者"集合（每条连接关联一个 userId），用于向所有已登录用户
 * 推送 Agent 在线状态变化和跨用户排队队列摘要，并向特定用户推送其私有任务列表更新。
 *
 * 事件类型：
 *   agent-status   → 全员：{ autoOnline, activeTask? }
 *   queue-update   → 全员：{ queuedCount, tasks: [{ taskId, quotationNumber, username, createdAt }] }
 *   my-tasks       → 仅该用户（连接建立时的快照）：{ tasks: QuotationTaskSummary[] }
 *   task-update    → 仅任务 owner：{ task: QuotationTaskSummary }
 *
 * 依赖关系：本模块仅从 ws-state（读 Agent 状态）和 db/quotation（读任务数据）导入，
 * 不依赖 routes 或 ws-handler，避免循环依赖。
 */

import type { SSEConnection } from '../middleware/sse.js';
import { getAutoOnlineState } from './ws-state.js';
import {
  getTasksByUser,
  getTaskByIdRaw,
  getQueuedTaskSummaries,
  type QuotationTaskSummary,
} from '../db/quotation.js';

// ==================================================================
//  订阅者管理
// ==================================================================

interface GlobalSubscriber {
  userId: number;
  conn: SSEConnection;
}

const subscribers = new Set<GlobalSubscriber>();

/** 订阅全局事件流；返回取消订阅函数 */
export function subscribeGlobal(userId: number, conn: SSEConnection): () => void {
  const sub: GlobalSubscriber = { userId, conn };
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/** 向单个订阅者安全发送（自动清理已关闭连接） */
function sendTo(sub: GlobalSubscriber, type: string, data: unknown): void {
  if (sub.conn.isClosed) {
    subscribers.delete(sub);
    return;
  }
  sub.conn.send(type, data);
}

/** 向所有订阅者广播 */
function broadcastGlobal(type: string, data: unknown): void {
  for (const sub of subscribers) {
    sendTo(sub, type, data);
  }
}

/** 仅向指定 userId 的所有订阅连接广播 */
function broadcastToUser(userId: number, type: string, data: unknown): void {
  for (const sub of subscribers) {
    if (sub.userId === userId) sendTo(sub, type, data);
  }
}

// ==================================================================
//  快照构建
// ==================================================================

/** 构建 Agent 在线状态 + 当前活跃任务摘要 */
function buildAgentStatus(): {
  autoOnline: boolean;
  activeTask?: {
    taskId: number;
    quotationNumber: string;
    username: string;
    startedAt: string;
    status: string;
  };
} {
  const { online, activeTaskId } = getAutoOnlineState();
  if (!online || activeTaskId == null) {
    return { autoOnline: online };
  }
  const task = getTaskByIdRaw(activeTaskId);
  if (!task || task.status !== 'running') {
    return { autoOnline: online };
  }
  return {
    autoOnline: online,
    activeTask: {
      taskId: task.id,
      quotationNumber: task.quotationNumber,
      username: task.username,
      startedAt: task.startedAt ?? task.createdAt,
      status: task.status,
    },
  };
}

/** 构建跨用户排队队列摘要 */
function buildQueueSummary(): {
  queuedCount: number;
  tasks: {
    taskId: number;
    quotationNumber: string;
    username: string;
    createdAt: string;
  }[];
} {
  const rows = getQueuedTaskSummaries();
  return {
    queuedCount: rows.length,
    tasks: rows.map((r) => ({
      taskId: r.id,
      quotationNumber: r.quotationNumber,
      username: r.username,
      createdAt: r.createdAt,
    })),
  };
}

/** 从任务详情（含 lines）提取摘要（不含 lines 等敏感/大字段） */
function toSummary(
  task: NonNullable<ReturnType<typeof getTaskByIdRaw>>,
): QuotationTaskSummary {
  // 复用 getTasksByUser 的映射会更重（一次全表查），这里直接从 detail 裁剪
  const { lines: _lines, pendingConfirmation: _pc, finalLinesSnapshot: _fs, ...summary } = task;
  return summary;
}

// ==================================================================
//  对外广播 API（供 ws-handler / quotation 路由调用）
// ==================================================================

/** 广播 Agent 在线状态变化 → 全员 */
export function broadcastAgentStatus(): void {
  broadcastGlobal('agent-status', buildAgentStatus());
}

/** 广播排队队列变化 → 全员 */
export function broadcastQueueUpdate(): void {
  broadcastGlobal('queue-update', buildQueueSummary());
}

/** 向某任务 owner 推送其任务摘要更新（状态/计数变化） */
export function broadcastTaskUpdateToOwner(taskId: number): void {
  const task = getTaskByIdRaw(taskId);
  if (!task) return;
  broadcastToUser(task.userId, 'task-update', { task: toSummary(task) });
}

/** 连接建立时推送该用户的完整初始快照 */
export function sendInitialSnapshot(userId: number, conn: SSEConnection): void {
  if (conn.isClosed) return;
  conn.send('agent-status', buildAgentStatus());
  conn.send('queue-update', buildQueueSummary());
  const tasks = getTasksByUser(userId);
  conn.send('my-tasks', { tasks });
}

/** 返回当前全局订阅者数量（调试用） */
export function globalSubscriberCount(): number {
  return subscribers.size;
}
