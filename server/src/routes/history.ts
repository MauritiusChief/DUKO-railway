/**
 * 历史记录路由 —— 用户解析记录的持久化
 *
 * GET    /api/history       —— 获取当前用户的记录摘要列表
 * GET    /api/history/:id   —— 获取单条记录完整详情
 * POST   /api/history       —— 保存新记录（auto-save 触发）
 * DELETE /api/history/:id   —— 删除记录
 *
 * 管理员路由（单独挂载在 /api/admin/history，需要 AdminGuard）
 * GET    /api/admin/history       —— 获取所有用户的记录摘要列表
 * GET    /api/admin/history/:id   —— 获取任意记录完整详情
 */
import { Router } from 'express';
import {
  insertRecord,
  getRecordsByUser,
  getRecordById,
  deleteRecord,
  getAllRecords,
  getRecordByIdForAdmin,
} from '../db/users.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { z } from 'zod';

export const historyRouter = Router();

const saveHistorySchema = z.object({
  input: z.string(),
  colorHints: z.array(z.string()),
  items: z.array(z.unknown()),
  conversation: z.array(z.unknown()),
  lang: z.string().optional(),
});

// GET /api/history —— 记录摘要列表
historyRouter.get('/history', (req, res) => {
  const userId = req.user!.userId;
  const records = getRecordsByUser(userId);
  res.json(records);
});

// GET /api/history/:id —— 单条完整详情
historyRouter.get('/history/:id', (req, res) => {
  const userId = req.user!.userId;
  const recordId = Number(req.params.id);
  if (Number.isNaN(recordId)) {
    res.status(400).json({ error: '无效的记录 ID' });
    return;
  }

  const row = getRecordById(userId, recordId);
  if (!row) {
    res.status(404).json({ error: '记录不存在或无权访问' });
    return;
  }

  res.json({
    id: row.id,
    input: row.input,
    colorHints: JSON.parse(row.color_hints),
    items: JSON.parse(row.items),
    conversation: JSON.parse(row.conversation),
    lang: row.lang,
    created_at: row.created_at,
  });
});

// POST /api/history —— 保存新记录
historyRouter.post('/history', validate(saveHistorySchema), (req, res) => {
  const userId = req.user!.userId;
  const { input, colorHints, items, conversation, lang } = req.body as {
    input: string;
    colorHints: string[];
    items: unknown[];
    conversation: unknown[];
    lang?: string;
  };

  const newId = insertRecord(
    userId,
    input,
    colorHints,
    JSON.stringify(items),
    JSON.stringify(conversation),
    lang ?? 'zh',
  );

  res.status(201).json({ id: newId });
});

// DELETE /api/history/:id —— 删除记录
historyRouter.delete('/history/:id', (req, res) => {
  const userId = req.user!.userId;
  const recordId = Number(req.params.id);
  if (Number.isNaN(recordId)) {
    res.status(400).json({ error: '无效的记录 ID' });
    return;
  }

  const deleted = deleteRecord(userId, recordId);
  if (!deleted) {
    res.status(404).json({ error: '记录不存在或无权删除' });
    return;
  }

  res.json({ message: '已删除' });
});

// ==================================================================
//  管理员路由：全量历史记录浏览
// ==================================================================

/** 管理员历史记录路由 —— 供 index.ts 单独挂载，施加 requireAdmin */
export const adminHistoryRouter = Router();

// GET /api/admin/history —— 所有用户的记录摘要列表（含归属用户信息）
adminHistoryRouter.get('/history', requireAdmin, (_req, res) => {
  const records = getAllRecords();
  res.json(records);
});

// GET /api/admin/history/:id —— 管理员查看任意记录完整详情
adminHistoryRouter.get('/history/:id', requireAdmin, (req, res) => {
  const recordId = Number(req.params.id);
  if (Number.isNaN(recordId)) {
    res.status(400).json({ error: '无效的记录 ID' });
    return;
  }

  const row = getRecordByIdForAdmin(recordId);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }

  res.json({
    id: row.id,
    input: row.input,
    colorHints: JSON.parse(row.color_hints),
    items: JSON.parse(row.items),
    conversation: JSON.parse(row.conversation),
    lang: row.lang,
    created_at: row.created_at,
  });
});
