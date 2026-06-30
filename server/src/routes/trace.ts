/**
 * Trace 路由 —— 管理员查看 LLM 对话 trace
 *
 * GET  /api/trace                  → 列出最近 30 天的 trace session 摘要
 * GET  /api/trace/:conversationId  → 获取单个 session 的完整详情（含消息列表）
 *
 * 所有端点均需要管理员权限。
 */

import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getTraceSessions, getTraceDetail } from '../services/trace.js';

export const traceRouter = Router();

// ==================================================================
//  GET /api/trace —— 列出最近 30 天的 trace session 摘要
// ==================================================================

traceRouter.get('/', requireAdmin, (_req: Request, res: Response) => {
  const sessions = getTraceSessions();
  res.json(sessions);
});

// ==================================================================
//  GET /api/trace/:conversationId —— 获取单个 session 完整详情
// ==================================================================

traceRouter.get('/:conversationId', requireAdmin, (req: Request, res: Response) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }

  const detail = getTraceDetail(conversationId);
  if (!detail) {
    res.status(404).json({ error: 'trace session not found' });
    return;
  }

  res.json(detail);
});
