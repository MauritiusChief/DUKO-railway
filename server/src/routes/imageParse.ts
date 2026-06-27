/**
 * ImageParse 路由 —— 图片清单解析（视觉多模态，SSE 流式）
 *
 * POST /api/image-parse
 *   接收 base64 编码的图片，调用 ImageParseAgent（OpenRouter 视觉模型）
 *   解析图片中的橱柜清单，使用 searchSkuShape / searchSkuDescription 工具验证产品。
 *   返回纯文本（每行一项物品），前端将其预填入文本输入框，
 *   供后续 MainAgent 解析为结构化 JSON 表格。
 *
 *   与 table-parse 的分工：
 *     - 图片 agent 负责视觉识别 + 检索验证 → 输出文本
 *     - 文本 agent 负责解析文本 → 输出结构化 JSON 表格
 *     两个步骤由用户手动触发，中间可人工审核修改预填文本。
 *
 * SSE 事件（reply_chunk 来自 LLM 原生流式）：
 *   round_start → { round: number }    — 新一轮 LLM 调用开始（非首轮时客户端清空前轮暂存回复）
 *   tool_call   → { tool: string }     — Agent 调用了搜索工具
 *   reply_chunk → { text: string }     — LLM 实时生成的回复片段
 *   reply_done  → {}                   — 回复推送完毕
 *   done        → {}                   — 流程结束
 *   error       → { message: string }  — 错误
 */

import { Router, type Request, type Response } from 'express';
import { createOpenRouterProvider } from '../llm/index.js';
import { config } from '../config/env.js';
import { ImageParseAgent } from '../agents/image-parse-agent.js';
import { SSEConnection } from '../middleware/sse.js';
import { validate } from '../middleware/validate.js';
import { imageParseSchema } from '../validation/schemas.js';

export const imageParseRouter = Router();

imageParseRouter.post('/', validate(imageParseSchema), async (req: Request, res: Response) => {
  const { image, images, colorHints, lang, notes } = req.body as {
    image?: string;
    images?: string[];
    colorHints?: string[];
    lang?: string;
    notes?: Array<{ originalName: string; content: string }>;
  };

  // 支持单个 image（向后兼容）或多个 images
  const imageList: string[] = images && images.length > 0 ? images : (image ? [image] : []);

  if (imageList.length === 0) {
    res.status(400).json({ error: 'images (base64 data URL array) or image (base64 data URL) is required' });
    return;
  }

  for (const img of imageList) {
    if (!img.startsWith('data:image/')) {
      res.status(400).json({ error: 'each image must be a valid base64 data URL (data:image/...;base64,...)' });
      return;
    }
  }

  if (!config.openrouterApiKey) {
    res.status(500).json({
      error: '多模态 LLM 未配置',
      detail: '请设置环境变量 OPENROUTER_API_KEY 以启用图片解析功能',
    });
    return;
  }

  const sse = new SSEConnection(res);

  const llm = createOpenRouterProvider({
    apiKey: config.openrouterApiKey,
  });

  const agent = new ImageParseAgent(llm, {
    searchBudgetLimit: 16,
    maxRounds: 24,
    langHint: lang ?? '英文',
    onStep: (event) => {
      if (event.type === 'tool_call') {
        sse.send('tool_call', { tool: event.tool });
      } else if (event.type === 'reply_chunk') {
        sse.send('reply_chunk', { text: event.text });
      } else if (event.type === 'round_start') {
        sse.send('round_start', { round: event.round });
      }
    },
  });

  try {
    const text = await agent.parse({ images: imageList, colorHints, lang, notes });

    sse.send('reply_done', {});

    // 将视觉模型解析的文本结果发回前端，供预填入文本框
    sse.send('result', { text });

    sse.send('done', {});
  } catch (err) {
    console.error('[image-parse] error:', err);
    sse.send('error', {
      message: err instanceof Error ? err.message : '图片解析失败',
    });
  } finally {
    sse.close();
  }
});
