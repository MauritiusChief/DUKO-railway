/**
 * Inventory 库存看板路由 —— 创建查询、SSE 进度、取消、快照
 *
 * 全部端点使用 authenticateToken 保护（由 index.ts 在挂载点统一施加）。
 *
 * POST   /api/inventory/jobs              —— auto 下载模式创建查询
 * POST   /api/inventory/upload            —— upload 模式（附带 CSV）
 * GET    /api/inventory/jobs/:jobId       —— 当前快照（刷新兜底）
 * GET    /api/inventory/jobs/:jobId/events—— SSE 实时进度
 * POST   /api/inventory/jobs/:jobId/cancel—— 取消在途查询
 */

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { SSEConnection } from '../middleware/sse.js';
import { subscribeInventory } from '../services/inventory-sse.js';
import {
  createDownloadJob,
  createUploadJob,
  getJobSnapshot,
  cancelJob,
} from '../services/inventory.js';

export const inventoryRouter = Router();

// ==================================================================
//  校验 schema
// ==================================================================

const downloadJobSchema = z.object({
  threshold: z.number().min(0).default(5),
  trendThreshold: z.number().default(10),
  recentMonths: z.number().int().min(1).default(3),
});

const uploadJobSchema = z.object({
  csv: z.string().min(1),
  threshold: z.number().min(0).default(5),
  trendThreshold: z.number().default(10),
  recentMonths: z.number().int().min(1).default(3),
});

// ==================================================================
//  POST /api/inventory/jobs —— auto 下载模式
// ==================================================================

inventoryRouter.post('/inventory/jobs', validate(downloadJobSchema), (req, res) => {
  const { userId, username } = req.user!;
  const { threshold, trendThreshold, recentMonths } = req.body as {
    threshold: number;
    trendThreshold: number;
    recentMonths: number;
  };
  const jobId = createDownloadJob(userId, username, threshold, trendThreshold, recentMonths);
  res.status(201).json({ jobId });
});

// ==================================================================
//  POST /api/inventory/upload —— upload 模式（CSV 在 body 中）
// ==================================================================

inventoryRouter.post('/inventory/upload', validate(uploadJobSchema), (req, res) => {
  const { userId, username } = req.user!;
  const { csv, threshold, trendThreshold, recentMonths } = req.body as {
    csv: string;
    threshold: number;
    trendThreshold: number;
    recentMonths: number;
  };
  const jobId = createUploadJob(userId, username, csv, threshold, trendThreshold, recentMonths);
  res.status(201).json({ jobId });
});

// ==================================================================
//  GET /api/inventory/jobs/:jobId —— 当前快照
// ==================================================================

inventoryRouter.get('/inventory/jobs/:jobId', (req, res) => {
  const snapshot = getJobSnapshot(req.params.jobId);
  if (!snapshot) {
    res.status(404).json({ error: '查询不存在或已过期' });
    return;
  }
  res.json(snapshot);
});

// ==================================================================
//  GET /api/inventory/jobs/:jobId/events —— SSE 实时进度
// ==================================================================

inventoryRouter.get('/inventory/jobs/:jobId/events', (req, res) => {
  const snapshot = getJobSnapshot(req.params.jobId);
  if (!snapshot) {
    res.status(404).json({ error: '查询不存在或已过期' });
    return;
  }

  const sse = new SSEConnection(res);
  const unsubscribe = subscribeInventory(req.params.jobId, sse);

  // 推送初始快照（当前 phase、已累积的低库存列表等）
  sse.send('snapshot', snapshot);
  // 若已终态，补发 complete/error
  if (snapshot.status === 'completed' && snapshot.classification) {
    sse.send('complete', { classification: snapshot.classification });
  } else if (snapshot.status === 'failed' && snapshot.error) {
    sse.send('error', { error: snapshot.error });
  }

  res.on('close', () => {
    unsubscribe();
  });
});

// ==================================================================
//  POST /api/inventory/jobs/:jobId/cancel —— 取消
// ==================================================================

inventoryRouter.post('/inventory/jobs/:jobId/cancel', (req, res) => {
  const ok = cancelJob(req.params.jobId, req.user!.userId);
  if (!ok) {
    res.status(404).json({ error: '查询不存在、无权访问或已结束' });
    return;
  }
  res.json({ message: '已取消' });
});
