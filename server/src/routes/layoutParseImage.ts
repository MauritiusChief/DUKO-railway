/**
 * Layout 图片解析路由 —— 厨房布局识别（SSE 流式）
 *
 * POST /api/layout/parse-image
 *   接收 base64 图片 + 当前布局，交由 LayoutAgent（OpenRouter 多模态模型）处理。
 *   LLM 通过 function calling 自主调用布局工具（readLayout, createWall,
 *   insertItem, deleteItem 等）和搜索工具（searchSkuShape, searchSkuDescription）
 *   对布局进行增量修改。
 *
 *   流程：
 *     1. 构建系统提示词（含布局上下文 + 数据模型说明 + 工具使用指导）
 *     2. 将图片以多模态格式 + 当前布局摘要发给视觉模型
 *     3. 对话循环：LLM 调用布局工具 + 搜索工具
 *     4. 返回 { updatedLayout } —— 布局已在工具执行中原地修改
 *
 * SSE 事件：
 *   tool_call   → { tool: string }    — Agent 调用了工具
 *   done        → {}                  — 流程结束
 *   error       → { message: string } — 错误
 */

import { Router, type Request, type Response } from 'express';
import { createOpenRouterProvider } from '../llm/index.js';
import { config } from '../config/env.js';
import { LayoutAgent } from '../agents/layout-agent.js';
import { SSEConnection } from '../middleware/sse.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { layoutParseSchema } from '../validation/schemas.js';

export const layoutParseImageRouter = Router();

layoutParseImageRouter.post('/', requireAdmin, validate(layoutParseSchema), async (req: Request, res: Response) => {
  const body = req.body as {
    image?: string;
    viewType?: string;
    associatedWallIds?: string[];
    layout?: import('../types/layout').LayoutDocument;
  };

  if (!body.image || typeof body.image !== 'string') {
    res.status(400).json({ error: 'image (base64 data URL) is required' });
    return;
  }
  if (!body.layout || typeof body.layout !== 'object') {
    res.status(400).json({ error: 'layout is required' });
    return;
  }

  if (!config.openrouterApiKey) {
    res.status(500).json({
      error: '多模态 LLM 未配置',
      detail: '请设置环境变量 OPENROUTER_API_KEY',
    });
    return;
  }

  const sse = new SSEConnection(res);

  const llm = createOpenRouterProvider({
    apiKey: config.openrouterApiKey,
  });

  const agent = new LayoutAgent(llm, {
    searchBudgetLimit: 5,
    maxRounds: 30,
    langHint: '中文',
    onStep: (event) => {
      if (event.type === 'tool_call') {
        sse.send('tool_call', { tool: event.tool });
      }
    },
  });

  try {
    const updatedLayout = await agent.parse({
      image: body.image,
      viewType: body.viewType,
      associatedWallIds: body.associatedWallIds,
      layout: body.layout,
    });

    sse.send('done', {});
  } catch (err) {
    console.error('[layout-parse] error:', err);
    sse.send('error', {
      message: err instanceof Error ? err.message : '布局识别失败',
    });
  } finally {
    sse.close();
  }
});
