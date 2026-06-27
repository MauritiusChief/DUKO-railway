/**
 * 用户笔记路由
 *
 * GET  /api/notes —— 获取当前用户全部笔记
 * POST /api/notes —— 全量替换用户笔记
 */
import { Router } from 'express';
import { getNotesByUser, replaceNotesForUser } from '../db/users.js';
import { validate } from '../middleware/validate.js';
import { z } from 'zod';

export const notesRouter = Router();

const saveNotesSchema = z.object({
  notes: z.array(
    z.object({
      originalName: z.string(),
      content: z.string(),
    }),
  ),
});

// GET /api/notes —— 获取当前用户全部笔记
notesRouter.get('/notes', (req, res) => {
  const userId = req.user!.userId;
  const notes = getNotesByUser(userId);
  res.json(notes);
});

// POST /api/notes —— 全量替换当前用户笔记
notesRouter.post('/notes', validate(saveNotesSchema), (req, res) => {
  const userId = req.user!.userId;
  const { notes } = req.body as {
    notes: { originalName: string; content: string }[];
  };

  replaceNotesForUser(userId, notes);
  res.json({ message: '已保存' });
});
