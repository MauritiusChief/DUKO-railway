/**
 * Inventory SSE 订阅广播 —— 按 jobId（字符串）分组管理订阅者
 *
 * 与 sse-broadcast.ts（按 taskId 分组）平行的实现，供 inventory 路由的
 * GET /api/inventory/jobs/:jobId/events 使用。
 */

import type { SSEConnection } from '../middleware/sse.js';

export interface InventorySSEEvent {
  type: string;
  data: unknown;
}

/** jobId → 该任务的所有 SSE 订阅者 */
const subscribers = new Map<string, Set<SSEConnection>>();

/** 订阅指定 jobId 的事件流；返回取消订阅函数 */
export function subscribeInventory(jobId: string, conn: SSEConnection): () => void {
  let set = subscribers.get(jobId);
  if (!set) {
    set = new Set();
    subscribers.set(jobId, set);
  }
  set.add(conn);
  return () => unsubscribeInventory(jobId, conn);
}

/** 取消订阅 */
export function unsubscribeInventory(jobId: string, conn: SSEConnection): void {
  const set = subscribers.get(jobId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) subscribers.delete(jobId);
}

/** 向指定 jobId 的所有订阅者广播事件（自动清理已关闭连接） */
export function broadcastInventory(jobId: string, event: InventorySSEEvent): void {
  const set = subscribers.get(jobId);
  if (!set || set.size === 0) return;

  for (const conn of set) {
    if (conn.isClosed) {
      set.delete(conn);
      continue;
    }
    conn.send(event.type, event.data);
  }

  if (set.size === 0) subscribers.delete(jobId);
}

/** 返回某 jobId 的当前订阅者数量（调试用） */
export function inventorySubscriberCount(jobId: string): number {
  return subscribers.get(jobId)?.size ?? 0;
}
