/**
 * Layout 图片解析路由 —— 厨房布局识别（SSE 流式）
 *
 * POST /api/layout/parse-image
 *   接收 base64 图片 + 当前布局，分两阶段处理：
 *     1. LayoutOcrAgent（OpenRouter 视觉模型）→ 图片 OCR 转文本双轨列表
 *     2. LayoutAgent（DeepSeek 文本模型）→ 根据 OCR 结果编排布局修改
 *
 *   LayoutAgent 通过 function calling 自主调用布局工具（readLayout, createWall,
 *   insertItem, deleteItem 等）、搜索工具（searchSkuShape, searchSkuDescription）
 *   和委派工具（dispatchLayoutOcr, dispatchBatchSearch, dispatchPreciseSearch）
 *   对布局进行增量修改。
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
import { createDeepSeekProvider, createOpenRouterProvider } from '../llm/index.js';
import { config } from '../config/env.js';
import { LayoutAgent, type LayoutAgentExtendedConfig } from '../agents/layout-agent.js';
import { LayoutOcrAgent } from '../agents/layout-ocr-agent.js';
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

  // 检查两个 API key 均配置完成
  if (!config.openrouterApiKey) {
    res.status(500).json({
      error: '多模态 LLM 未配置',
      detail: '请设置环境变量 OPENROUTER_API_KEY',
    });
    return;
  }
  if (!config.deepseekApiKey) {
    res.status(500).json({
      error: '文本 LLM 未配置',
      detail: '请设置环境变量 DEEPSEEK_API_KEY',
    });
    return;
  }

  const sse = new SSEConnection(res);

  // 创建两个 provider：视觉 OCR 走 OpenRouter，文本编排走 DeepSeek
  const visionLlm = createOpenRouterProvider({
    apiKey: config.openrouterApiKey,
  });
  const textLlm = createDeepSeekProvider({
    apiKey: config.deepseekApiKey,
  });

  // ---- Trace：创建顶层 session（LayoutAgent = DeepSeek） ----
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
      provider: textLlm.providerName,
      model: textLlm.model,
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
    budgetLimit: 30,
    maxRounds: 40,
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

  try {
    // 阶段 1：OCR 预处理 —— OpenRouter 视觉模型识别图片中的橱柜结构
    const ocrAgent = new LayoutOcrAgent(visionLlm, {
      budgetLimit: 0,
      maxRounds: 2,
      langHint: '中文',
    });

    // 可选：发送 OCR 开始事件供前端调试
    sse.send('tool_call', { tool: 'layout-ocr-preprocess' });

    const associatedWallIds: string[] = Array.isArray(body.associatedWallIds)
      ? body.associatedWallIds
      : [];
    const associatedNames: string[] = [];
    for (const id of associatedWallIds) {
      const w = body.layout!.walls.find((w) => w.id === id);
      if (w) associatedNames.push(w.name);
    }

    const initialOcrText = await ocrAgent.runOcr({
      image: body.image,
      viewType: body.viewType || 'top',
      associatedWallNames: associatedNames,
    });

    // 阶段 2：Layout 编排 —— DeepSeek 文本模型根据 OCR 结果修改布局
    const agent = new LayoutAgent(textLlm, visionLlm, agentConfig);

    if (traceContext) {
      agent.trace = traceContext;
    }

    const { layout: updatedLayout, reply } = await agent.parse({
      initialOcrText,
      viewType: body.viewType,
      associatedWallIds: body.associatedWallIds,
      layout: body.layout!,
      image: body.image,
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
