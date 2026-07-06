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
 *   round_start → { round: number }          — 对话轮次开始
 *   tool_call   → { tool: string }           — Agent 调用了工具
 *   reply_chunk → { text: string }           — LLM 流式回复片段
 *   layout_update → { layout, tool, message } — 布局被修改后的快照
 *   result      → { updatedLayout, reply }   — 最终结果
 *   done        → {}                         — 流程结束
 *   error       → { message: string }        — 错误
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { createOpenRouterProvider } from '../llm/index.js';
import { config } from '../config/env.js';
import { LayoutAgent, type LayoutAgentExtendedConfig } from '../agents/layout-agent.js';
import { SSEConnection } from '../middleware/sse.js';
import { validate } from '../middleware/validate.js';
import { layoutParseSchema } from '../validation/schemas.js';
import { insertTraceSession, markSessionCompleted, markSessionError } from '../services/trace.js';
import type { TraceContext } from '../types/trace.js';

export const layoutParseImageRouter = Router();

layoutParseImageRouter.post('/', validate(layoutParseSchema), async (req: Request, res: Response) => {
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

  // ---- Trace：创建 session ----
  const traceEnabled = config.traceLog;
  let traceContext: TraceContext | undefined;
  if (traceEnabled) {
    const conversationId = randomUUID();
    traceContext = {
      conversationId,
      userId: req.user!.userId,
      username: req.user!.username,
      mainAgent: 'LayoutAgent',
      agentName: 'LayoutAgent',
      route: '/api/layout/parse-image',
      provider: llm.providerName,
      model: llm.model,
      enabled: true,
    };
    insertTraceSession(
      conversationId,
      traceContext.userId,
      traceContext.username,
      traceContext.mainAgent,
      traceContext.agentName,
      null,
      traceContext.route,
      traceContext.provider,
      traceContext.model,
    );
  }

  const agentConfig: LayoutAgentExtendedConfig = {
    searchBudgetLimit: 5,
    maxRounds: 30,
    langHint: '中文',
    onStep: (event) => {
      // 透传 BaseAgent 的所有步进事件给前端
      if (event.type === 'round_start') {
        sse.send('round_start', { round: event.round });
      } else if (event.type === 'tool_call') {
        sse.send('tool_call', { tool: event.tool });
      } else if (event.type === 'reply_chunk') {
        sse.send('reply_chunk', { text: event.text });
      } else if (event.type === 'error') {
        sse.send('error', { message: event.message });
      }
      // 'reply' 事件忽略 —— reply_chunk 已覆盖流式输出
    },
    /** 布局被 LLM 工具修改后，立即推送新快照给前端 */
    onLayoutUpdated: (update) => {
      sse.send('layout_update', {
        layout: update.layout,
        tool: update.tool,
        message: update.message,
      });
    },
  };

  const agent = new LayoutAgent(llm, agentConfig);

  if (traceContext) {
    agent.trace = traceContext;
  }

  try {
    const { layout: updatedLayout, reply } = await agent.parse({
      image: body.image,
      viewType: body.viewType,
      associatedWallIds: body.associatedWallIds,
      layout: body.layout,
    });

    if (traceContext) {
      markSessionCompleted(traceContext.conversationId);
    }

    sse.send('result', { updatedLayout, reply });
    sse.send('done', {});
  } catch (err) {
    console.error('[layout-parse] error:', err);
    if (traceContext) {
      markSessionError(traceContext.conversationId, err instanceof Error ? err.message : '布局识别失败');
    }
    sse.send('error', {
      message: err instanceof Error ? err.message : '布局识别失败',
    });
  } finally {
    sse.close();
  }
});
