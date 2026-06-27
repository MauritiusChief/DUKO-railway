/**
 * Chat 路由 —— LLM 对话入口（SSE 流式）
 *
 * POST /api/chat
 *   接收用户消息 + 当前已解析清单（可选）+ 对话历史（可选），
 *   交由 ChatAgent 处理。Agent 可自主调用搜索工具（受预算限制）
 *   和清单编辑/产品查询/笔记工具（不受预算限制）。
 *
 * 多轮对话：每次请求返回清理后的对话历史（仅 user / assistant 文本对，
 * 最多 8 对），前端在下轮请求中传回，实现上下文连贯。
 *
 * SSE 事件（reply_chunk 来自 LLM 原生流式）：
 *   round_start → { round: number }          — 新一轮 LLM 调用开始（非首轮时客户端清空前轮暂存回复）
 *   tool_call   → { tool: string }           — Agent 调用了工具
 *   reply_chunk → { text: string }           — LLM 实时生成的回复片段
 *   reply_done  → {}                         — 回复推送完毕
 *   result      → { items?, products?, history, notes? } — 结构化数据
 *   done        → {}                         — 流程结束
 *   error       → { message: string }        — 错误
 */

import { Router, type Request, type Response } from 'express';
import { createDeepSeekProvider } from '../llm/index.js';
import { config } from '../config/env.js';
import { ChatAgent } from '../agents/chat-agent.js';
import { SSEConnection } from '../middleware/sse.js';
import { validate } from '../middleware/validate.js';
import { chatSchema } from '../validation/schemas.js';
import type { ParsedItem, ProductEntry, ChatNote, ChatHistoryEntry } from '../types/manifest.js';

export const chatRouter = Router();

interface ChatRequest {
  message: string;
  lang?: string;
  items?: ParsedItem[];
  products?: ProductEntry[];
  history?: ChatHistoryEntry[];
  notes?: ChatNote[];
  mainAgentReply?: string;
  initialInput?: string;
  colorHints?: string[];
}

chatRouter.post('/', validate(chatSchema), async (req: Request, res: Response) => {
  const { message, lang, items, products, history, notes, mainAgentReply, initialInput, colorHints } = req.body as ChatRequest;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  if (!config.deepseekApiKey) {
    res.status(500).json({
      error: 'LLM 未配置',
      detail: '请设置环境变量 DEEPSEEK_API_KEY',
    });
    return;
  }

  const sse = new SSEConnection(res);

  const llm = createDeepSeekProvider({
    apiKey: config.deepseekApiKey,
  });

  const agent = new ChatAgent(llm, {
    searchBudgetLimit: 5,
    maxRounds: 20,
    maxHistoryPairs: 8,
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
    const result = await agent.chat({
      message,
      lang,
      items,
      products,
      history,
      notes,
      mainAgentReply,
      initialInput,
      colorHints,
    });

    sse.send('reply_done', {});

    sse.send('result', {
      items: result.items,
      products: result.products,
      history: result.history,
      notes: result.notes,
    });

    sse.send('done', {});
  } catch (err) {
    console.error('Chat error:', err);
    sse.send('error', { message: err instanceof Error ? err.message : 'LLM 请求失败' });
  } finally {
    sse.close();
  }
});
