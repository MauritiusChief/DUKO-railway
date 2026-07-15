/**
 * SSE 订阅广播 —— 按 taskId 分组管理订阅者
 *
 * WebSocket handler 在收到 auto 上报的状态或行结果后，
 * 调用 broadcast() 向对应 taskId 的所有 SSE 订阅者推送事件。
 *
 * 事件格式遵循 SSEConnection.send(type, data) 的约定：
 *   event: <type>
 *   data: <JSON payload>
 */

import type { SSEConnection } from '../middleware/sse.js';

/** 单个 SSE 事件（type + payload） */
export interface SSEEvent {
  type: string;
  data: unknown;
}

/** taskId → 该任务的所有 SSE 订阅者 */
const subscribers = new Map<number, Set<SSEConnection>>();

/**
 * 订阅指定 taskId 的事件流。
 * 返回一个取消订阅函数，方便在连接关闭时调用。
 */
export function subscribe(taskId: number, conn: SSEConnection): () => void {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(conn);

  return () => unsubscribe(taskId, conn);
}

/** 取消订阅指定 taskId 上的某个连接 */
export function unsubscribe(taskId: number, conn: SSEConnection): void {
  const set = subscribers.get(taskId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) subscribers.delete(taskId);
}

/**
 * 向指定 taskId 的所有订阅者广播事件。
 * 自动清理已关闭的连接。
 */
export function broadcast(taskId: number, event: SSEEvent): void {
  const set = subscribers.get(taskId);
  if (!set || set.size === 0) return;

  for (const conn of set) {
    if (conn.isClosed) {
      set.delete(conn);
      continue;
    }
    conn.send(event.type, event.data);
  }

  if (set.size === 0) subscribers.delete(taskId);
}

/** 返回某 taskId 的当前订阅者数量（调试/测试用） */
export function subscriberCount(taskId: number): number {
  return subscribers.get(taskId)?.size ?? 0;
}
