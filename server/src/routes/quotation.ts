/**
 * 报价任务路由 —— 创建、查询、取消任务及 SSE 实时进度
 *
 * 全部端点使用 authenticateToken 保护（由 index.ts 在挂载点统一施加）。
 *
 * POST   /api/quotation-tasks          —— 创建报价任务
 * GET    /api/quotation-tasks          —— 当前用户任务列表
 * GET    /api/quotation-tasks/active   —— 当前活跃任务摘要（公开可读，需登录）
 * GET    /api/quotation-tasks/:id      —— 任务详情（含逐行结果）
 * POST   /api/quotation-tasks/:id/cancel —— 取消 queued 任务
 * GET    /api/quotation-tasks/:id/events —— SSE 逐行进度推送
 *
 * 任务详情、SSE 订阅、取消操作仅限任务创建者和管理员。
 */

import { Router, type Request, type Response } from 'express';
import { validate } from '../middleware/validate.js';
import { SSEConnection } from '../middleware/sse.js';
import { createQuotationTaskSchema } from '../validation/schemas.js';
import {
  createTask,
  getTasksByUser,
  getTaskByIdRaw,
  getTaskByIdForUser,
  cancelTask,
  getPendingConfirmation,
  clearPendingConfirmation,
  type QuotationTaskSummary,
  type QuotationTaskDetail,
} from '../db/quotation.js';
import { canAccessTask } from '../services/quotation.js';
import {
  sendConfirmResponse,
} from '../services/ws-handler.js';
import {
  subscribe,
  broadcast,
  type SSEEvent,
} from '../services/sse-broadcast.js';
import { getAutoOnlineState } from '../services/ws-state.js';

export const quotationRouter = Router();

// ==================================================================
//  GET /api/quotation-tasks/active
//  公开摘要：auto 是否在线 + 当前正在执行的任务（仅摘要，不含行详情）
//  注意：必须放在 /:id 之前注册，否则会被 :id 匹配
// ==================================================================

quotationRouter.get('/quotation-tasks/active', (_req, res) => {
  res.json(getActiveTaskSummary());
});

/** 计算当前活跃任务的公开摘要 */
function getActiveTaskSummary() {
  // 通过 ws-state 查询 auto 是否在线 + 当前正在执行的任务 id
  const { online, activeTaskId } = getAutoOnlineState();

  if (!online || activeTaskId == null) {
    return { autoOnline: online, activeTask: undefined };
  }

  const task = getTaskByIdRaw(activeTaskId);
  if (!task || task.status !== 'running') {
    return { autoOnline: online, activeTask: undefined };
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

// ==================================================================
//  GET /api/quotation-tasks —— 当前用户任务列表
// ==================================================================

quotationRouter.get('/quotation-tasks', (req, res) => {
  const userId = req.user!.userId;
  const tasks = getTasksByUser(userId);
  res.json(tasks);
});

// ==================================================================
//  POST /api/quotation-tasks —— 创建任务
// ==================================================================

quotationRouter.post(
  '/quotation-tasks',
  validate(createQuotationTaskSchema),
  (req, res) => {
    const { userId, username } = req.user!;
    const { quotationNumber, writeMode, lines } = req.body as {
      quotationNumber: string;
      writeMode: 'overwrite' | 'append';
      lines: { partModel: string; quantity: number }[];
    };

    const taskId = createTask(userId, username, quotationNumber, writeMode, lines);

    // 创建后通知 ws-handler 尝试派发（若有 auto worker 在线）
    // ws-handler 通过 notifyTaskQueued 主动查询 queued 任务
    notifyTaskQueued();

    const created = getTaskByIdRaw(taskId) as QuotationTaskDetail;
    res.status(201).json(summaryOf(created));
  },
);

// ==================================================================
//  GET /api/quotation-tasks/:id —— 任务详情（含逐行结果）
// ==================================================================

quotationRouter.get('/quotation-tasks/:id', (req, res) => {
  const taskId = Number(req.params.id);
  if (Number.isNaN(taskId)) {
    res.status(400).json({ error: '无效的任务 ID' });
    return;
  }

  const task = getTaskByIdRaw(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  if (!canAccessTask(task.userId, req.user!.userId, req.user!.role)) {
    res.status(403).json({ error: '无权访问此报价任务' });
    return;
  }

  res.json(task);
});

// ==================================================================
//  POST /api/quotation-tasks/:id/cancel —— 取消 queued 任务
// ==================================================================

quotationRouter.post('/quotation-tasks/:id/cancel', (req, res) => {
  const taskId = Number(req.params.id);
  if (Number.isNaN(taskId)) {
    res.status(400).json({ error: '无效的任务 ID' });
    return;
  }

  const task = getTaskByIdRaw(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  if (!canAccessTask(task.userId, req.user!.userId, req.user!.role)) {
    res.status(403).json({ error: '无权取消此报价任务' });
    return;
  }

  const result = cancelTask(req.user!.userId, taskId);
  if (result === 'not_found') {
    res.status(404).json({ error: '任务不存在或无权访问' });
    return;
  }
  if (result === 'not_cancellable') {
    res.status(409).json({
      error: '任务正在执行或已完成，无法取消',
      status: task.status,
    });
    return;
  }

  // 广播取消事件给订阅者
  broadcast(taskId, { type: 'task-status', data: { taskId, status: 'cancelled' } });

  res.json({ message: '已取消', taskId });
});

// ==================================================================
//  POST /api/quotation-tasks/:id/confirm —— 用户确认/拒绝目标报价单
// ==================================================================

quotationRouter.post('/quotation-tasks/:id/confirm', (req, res) => {
  const taskId = Number(req.params.id);
  if (Number.isNaN(taskId)) {
    res.status(400).json({ error: '无效的任务 ID' });
    return;
  }

  const { decision } = req.body as { decision?: string };
  if (decision !== 'confirmed' && decision !== 'rejected') {
    res.status(400).json({ error: 'decision 必须为 confirmed 或 rejected' });
    return;
  }

  const task = getTaskByIdRaw(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  if (!canAccessTask(task.userId, req.user!.userId, req.user!.role)) {
    res.status(403).json({ error: '无权操作此报价任务' });
    return;
  }

  if (task.status !== 'running') {
    res.status(409).json({ error: '任务未在执行中，无法确认', status: task.status });
    return;
  }

  const pending = getPendingConfirmation(taskId);
  if (!pending) {
    res.status(409).json({ error: '没有待处理的确认请求' });
    return;
  }

  clearPendingConfirmation(taskId);

  const sent = sendConfirmResponse(taskId, decision);
  if (!sent) {
    res.status(503).json({ error: 'auto worker 离线或不可达，请稍后重试' });
    return;
  }

  broadcastQuotationEvent(taskId, {
    type: 'confirm-response',
    data: { taskId, decision },
  });

  res.json({ message: '已提交确认', taskId, decision });
});

// ==================================================================
//  GET /api/quotation-tasks/:id/events —— SSE 逐行进度
//  通过 Authorization 请求头鉴权（复用 fetch + ReadableStream 方式）
// ==================================================================

quotationRouter.get('/quotation-tasks/:id/events', (req, res) => {
  const taskId = Number(req.params.id);
  if (Number.isNaN(taskId)) {
    res.status(400).json({ error: '无效的任务 ID' });
    return;
  }

  const task = getTaskByIdRaw(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  if (!canAccessTask(task.userId, req.user!.userId, req.user!.role)) {
    res.status(403).json({ error: '无权订阅此报价任务' });
    return;
  }

  const sse = new SSEConnection(res);
  const unsubscribe = subscribe(taskId, sse);

  // 立即推送一次当前快照状态，便于客户端确认订阅成功
  sse.send('snapshot', {
    taskId: task.id,
    status: task.status,
    lines: task.lines.map((l) => ({
      lineNo: l.line_no,
      status: l.status,
      error: l.error,
    })),
  });

  // 若任务 running 且有 pending_confirmation，补发 confirm-request（用户刷新页面后卡片复现）
  if (task.status === 'running' && task.pendingConfirmation) {
    try {
      const pending = JSON.parse(task.pendingConfirmation);
      sse.send('confirm-request', {
        taskId: task.id,
        ...pending,
      });
    } catch {
      // JSON 解析失败，忽略（不应发生）
    }
  }

  // 若任务已是终态，推送最终状态后保持连接（客户端可自行关闭）
  if (
    task.status === 'completed' ||
    task.status === 'partial_failed' ||
    task.status === 'failed' ||
    task.status === 'cancelled'
  ) {
    sse.send('task-status', { taskId: task.id, status: task.status });
  }

  res.on('close', () => {
    unsubscribe();
  });
});

// ==================================================================
//  辅助
// ==================================================================

/** 仅返回任务摘要（不含 lines） */
function summaryOf(task: QuotationTaskDetail): QuotationTaskSummary {
  const { lines: _lines, ...summary } = task;
  return summary;
}

// ==================================================================
//  ws-handler 注入接口
// ==================================================================
//
//  routes 模块先于 ws-handler 加载，但 ws-handler 需要响应“新任务已入队”
//  信号以触发派发。通过可注入的回调解耦两者加载顺序。
//
//  导出 broadcastQuotationEvent 供 ws-handler 之外的路径（如本路由的取消）
//  使用，同时 ws-handler 在收到 auto 上报时也调用此函数。

/** 由 ws-handler 注入：通知有新任务进入 queued 状态 */
let notifyTaskQueuedFn: (() => void) | null = null;

/** 注入新任务通知回调（由 ws-handler 初始化时调用） */
export function setNotifyTaskQueued(fn: (() => void) | null): void {
  notifyTaskQueuedFn = fn;
}

function notifyTaskQueued(): void {
  if (notifyTaskQueuedFn) notifyTaskQueuedFn();
}

/** 供 ws-handler 使用：向某 taskId 的订阅者广播 SSE 事件 */
export function broadcastQuotationEvent(taskId: number, event: SSEEvent): void {
  broadcast(taskId, event);
}
