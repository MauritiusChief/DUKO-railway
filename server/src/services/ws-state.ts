/**
 * WebSocket worker 状态 —— auto 在线状态与当前任务
 *
 * ws-handler 在 auto 连接/断开/接受任务时维护此状态；
 * quotation 路由（GET /active）读取此状态返回公开摘要。
 *
 * 首版仅支持单个 worker，因此用全局变量即可。
 */

/** auto worker 是否在线 */
let autoOnline = false;

/** 当前 worker 正在执行的任务 id（无则 null） */
let activeTaskId: number | null = null;

/** 返回当前状态快照 */
export function getAutoOnlineState(): {
  online: boolean;
  activeTaskId: number | null;
} {
  return { online: autoOnline, activeTaskId };
}

/** 设置 auto 在线状态（由 ws-handler 调用） */
export function setAutoOnline(online: boolean): void {
  autoOnline = online;
  if (!online) {
    activeTaskId = null;
  }
}

/** 设置当前正在执行的任务 id（由 ws-handler 在收到 accepted 时调用） */
export function setActiveTask(taskId: number | null): void {
  activeTaskId = taskId;
}
