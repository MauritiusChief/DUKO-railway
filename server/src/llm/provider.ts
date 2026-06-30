/**
 * LLM Provider 统一接口与工厂
 *
 * 设计原则：
 *  - 每个 Agent 可以独立指定使用的 LLM provider（DeepSeek / OpenRouter）
 *  - 每个 Agent 可以独立指定模型（model）— 甚至同一 provider 的不同实例可用不同模型
 *  - 为 Multi agent 做准备：多种 provider/模型组合可以并存
 *
 * 工厂函数 createDeepSeekProvider / createOpenRouterProvider 返回
 * 绑定了特定模型和 API key 的 sendChat 函数。
 */

import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage, MultimodalChatMessage } from '../types/message.js';

// ==================================================================
//  StreamChunk —— LLM 流式响应的单个增量块
// ==================================================================

/**
 * LLM 流式响应中的单个增量块。
 * content 和 reasoning_content 为追加文本；
 * tool_calls 按 index 累积拼接（OpenAI streaming 会将一个 tool_call
 * 拆成多个 chunk 分批发来）。
 */
export interface StreamChunk {
  delta: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  /** 仅在最后一个 chunk 中出现 */
  finish_reason?: string;
}

// ==================================================================
//  LlmProviderConfig —— 创建 provider 实例时的配置
// ==================================================================

export interface LlmProviderConfig {
  /** API key */
  apiKey: string;
  /** 模型名称 */
  model: string;
  /** API base URL（默认指向各服务商的官方地址） */
  baseURL: string;
  /** 是否启用思索模式（thinking） */
  enableThinking?: boolean;
}

/** DeepSeek 默认配置 */
export const DEEPSEEK_DEFAULTS: Omit<LlmProviderConfig, 'apiKey'> = {
  model: 'deepseek-v4-flash',
  baseURL: 'https://api.deepseek.com',
  enableThinking: true,
};

/** OpenRouter 默认配置 */
export const OPENROUTER_DEFAULTS: Omit<LlmProviderConfig, 'apiKey'> = {
  model: 'qwen/qwen3.7-plus',
  baseURL: 'https://openrouter.ai/api/v1',
  enableThinking: true,
};

// ==================================================================
//  ResponseFormat —— 强制 JSON 输出
// ==================================================================

export interface ResponseFormat {
  type: 'json_object';
}

// ==================================================================
//  LlmProvider —— 绑定了 model 的 LLM 调用接口
// ==================================================================

export interface LlmProvider<
  TMessage extends ChatMessage | MultimodalChatMessage = ChatMessage,
> {
  /** 此实例使用的模型名称（只读） */
  readonly model: string;

  /** Provider 名称标识（如 'deepseek' / 'openrouter'），用于 trace 记录 */
  readonly providerName: string;

  /** 发送多轮对话到 LLM，支持 function calling（非流式） */
  sendChat(
    messages: TMessage[],
    tools?: ToolDefinition[],
    responseFormat?: ResponseFormat,
  ): Promise<TMessage>;

  /**
   * 流式发送对话到 LLM，支持 function calling。
   *
   * @returns stream — 实时迭代的增量块，消费完毕时 message promise resolve 为完整的 ChatMessage
   */
  sendChatStream(
    messages: TMessage[],
    tools?: ToolDefinition[],
    responseFormat?: ResponseFormat,
  ): Promise<{
    stream: AsyncIterable<StreamChunk>;
    message: Promise<TMessage>;
  }>;
}

// ==================================================================
//  工厂函数
// ==================================================================

import OpenAI from 'openai';
import { ToolName } from '../tools/index.js';

function maskApiKey(key: string): string {
  if (!key) return 'not configured';
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '***';
}

/**
 * 创建 DeepSeek provider 实例（文本对话）
 *
 * @param overrides - 覆盖默认配置，apiKey 为必填
 * @returns 绑定到指定模型的 LlmProvider<ChatMessage>
 *
 * @example
 *   const chatProvider = createDeepSeekProvider({
 *     apiKey: config.deepseekApiKey,
 *     model: 'deepseek-v4-flash',
 *   });
 *
 *   const parseProvider = createDeepSeekProvider({
 *     apiKey: config.deepseekApiKey,
 *     model: 'deepseek-v4-flash', // 可以用不同的模型
 *   });
 */
export function createDeepSeekProvider(
  overrides: Pick<LlmProviderConfig, 'apiKey'> & Partial<Omit<LlmProviderConfig, 'apiKey'>>,
): LlmProvider<ChatMessage> {
  const cfg: LlmProviderConfig = {
    ...DEEPSEEK_DEFAULTS,
    ...overrides,
  };

  if (!cfg.apiKey) {
    console.warn('[DeepSeek] API key not configured — LLM calls will fail.');
  }

  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
  });

  console.log(`[DeepSeek] Provider created — model=${cfg.model} key=${maskApiKey(cfg.apiKey)}`);

  return {
    model: cfg.model,
    providerName: 'deepseek',

    async sendChat(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      responseFormat?: ResponseFormat,
    ): Promise<ChatMessage> {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: cfg.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      };

      if (cfg.enableThinking) {
        (params as unknown as Record<string, unknown>).thinking = { type: 'enabled' };
      }

      if (tools && tools.length > 0) {
        params.tools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
        (params as unknown as Record<string, unknown>).tool_choice = 'auto';
      }

      if (responseFormat) {
        (params as unknown as Record<string, unknown>).response_format = responseFormat;
      }

      const response = await client.chat.completions.create(params);

      const choice = response.choices[0];
      if (!choice?.message) {
        return {
          role: 'assistant',
          content: '[警告] choices[0].message 为空',
          finish_reason: choice?.finish_reason,
        };
      }

      const finishReason = choice.finish_reason;
      const reasoning = (choice.message as unknown as Record<string, unknown>).reasoning_content as string | undefined;

      return {
        role: choice.message.role as ChatMessage['role'],
        content: choice.message.content,
        finish_reason: finishReason,
        reasoning_content: reasoning,
        tool_calls: choice.message.tool_calls?.length
          ? choice.message.tool_calls.map((tc) => ({
              id: tc.id,
              type: tc.type as 'function',
              function: {
                name: tc.function.name as ToolName,
                arguments: tc.function.arguments,
              },
            }))
          : undefined,
      };
    },

    async sendChatStream(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      responseFormat?: ResponseFormat,
    ) {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: cfg.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        stream: true,
        stream_options: { include_usage: false },
      };

      if (cfg.enableThinking) {
        (params as unknown as Record<string, unknown>).thinking = { type: 'enabled' };
      }

      if (tools && tools.length > 0) {
        params.tools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
        (params as unknown as Record<string, unknown>).tool_choice = 'auto';
      }

      if (responseFormat) {
        (params as unknown as Record<string, unknown>).response_format = responseFormat;
      }

      const stream = await client.chat.completions.create(params);

      let finish_reason: string | undefined;
      let resolveMessage!: (msg: ChatMessage) => void;
      const messagePromise = new Promise<ChatMessage>((resolve) => {
        resolveMessage = resolve;
      });

      const contentParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCallAccumulator = new Map<number, ToolCall>();

      async function* generate(): AsyncGenerator<StreamChunk> {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const chunkFinishReason = chunk.choices[0]?.finish_reason;
          if (chunkFinishReason) {
            finish_reason = chunkFinishReason;
          }

          const deltaContent = delta?.content;
          const deltaReasoning = (delta as unknown as Record<string, unknown>)
            ?.reasoning_content as string | undefined;
          const deltaToolCalls = delta?.tool_calls;

          if (deltaContent) contentParts.push(deltaContent);
          if (deltaReasoning) reasoningParts.push(deltaReasoning);

          const toolCallDeltas: StreamChunk['delta']['tool_calls'] = [];
          if (deltaToolCalls) {
            for (const tcDelta of deltaToolCalls) {
              const idx = tcDelta.index;
              const existing = toolCallAccumulator.get(idx);
              if (!existing) {
                // 首个 delta：id 和 function.name 保证在场，直接凭实值建条目
                if (tcDelta.id && tcDelta.function?.name) {
                  const newTc: ToolCall = {
                    id: tcDelta.id,
                    type: 'function',
                    function: {
                      name: tcDelta.function.name as ToolName,
                      arguments: tcDelta.function.arguments || '',
                    },
                  };
                  toolCallAccumulator.set(idx, newTc);
                  toolCallDeltas.push({
                    index: tcDelta.index,
                    id: tcDelta.id,
                    function: { name: tcDelta.function.name, arguments: tcDelta.function.arguments || '' },
                  });
                }
                continue;
              }
              if (tcDelta.id) existing.id = tcDelta.id;
              if (tcDelta.function?.name) existing.function.name += tcDelta.function.name;
              if (tcDelta.function?.arguments) existing.function.arguments += tcDelta.function.arguments;
              toolCallAccumulator.set(idx, existing);

              toolCallDeltas.push({
                index: tcDelta.index,
                id: tcDelta.id,
                function: tcDelta.function
                  ? {
                      name: tcDelta.function.name,
                      arguments: tcDelta.function.arguments,
                    }
                  : undefined,
              });
            }
          }

          const streamChunk: StreamChunk = {
            delta: {},
          };
          if (deltaContent) streamChunk.delta.content = deltaContent;
          if (deltaReasoning) streamChunk.delta.reasoning_content = deltaReasoning;
          if (toolCallDeltas.length > 0) streamChunk.delta.tool_calls = toolCallDeltas;

          yield streamChunk;
        }

        // stream 完全消费后，组装完整 ChatMessage
        const finalContent = contentParts.length > 0 ? contentParts.join('') : null;
        const finalReasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;

        const finalToolCalls = toolCallAccumulator.size > 0
          ? Array.from(toolCallAccumulator.entries())
              .sort(([a], [b]) => a - b)
              .map(([, tc]) => tc)
          : undefined;

        resolveMessage({
          role: 'assistant',
          content: finalContent,
          finish_reason,
          reasoning_content: finalReasoning,
          tool_calls: finalToolCalls,
        });
      }

      const iterator = generate();

      return {
        stream: {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        },
        message: messagePromise,
      };
    },
  };
}

/**
 * 创建 OpenRouter provider 实例（多模态对话）
 *
 * @param overrides - 覆盖默认配置，apiKey 为必填
 * @returns 绑定到指定模型的 LlmProvider<MultimodalChatMessage>
 *
 * @example
 *   const visionProvider = createOpenRouterProvider({
 *     apiKey: config.openrouterApiKey,
 *     model: 'qwen/qwen3.7-plus',
 *   });
 */
export function createOpenRouterProvider(
  overrides: Pick<LlmProviderConfig, 'apiKey'> & Partial<Omit<LlmProviderConfig, 'apiKey'>>,
): LlmProvider<MultimodalChatMessage> {
  const cfg: LlmProviderConfig = {
    ...OPENROUTER_DEFAULTS,
    ...overrides,
  };

  if (!cfg.apiKey) {
    console.warn('[OpenRouter] API key not configured — LLM calls will fail.');
  }

  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
  });

  console.log(`[OpenRouter] Provider created — model=${cfg.model} key=${maskApiKey(cfg.apiKey)}`);

  return {
    model: cfg.model,
    providerName: 'openrouter',

    async sendChat(
      messages: MultimodalChatMessage[],
      tools?: ToolDefinition[],
      responseFormat?: ResponseFormat,
    ): Promise<MultimodalChatMessage> {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: cfg.model,
        messages: messages.map((m) => {
          const result: Record<string, unknown> = {
            role: m.role,
            content: m.content as OpenAI.Chat.Completions.ChatCompletionContentPart[] | string | null,
          };
          if (m.tool_calls) result.tool_calls = m.tool_calls;
          if (m.tool_call_id) result.tool_call_id = m.tool_call_id;
          if (m.name) result.name = m.name;
          return result as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;
        }),
      };

      if (cfg.enableThinking) {
        (params as unknown as Record<string, unknown>).thinking = { type: 'enabled' };
      }

      if (tools && tools.length > 0) {
        params.tools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
        (params as unknown as Record<string, unknown>).tool_choice = 'auto';
      }

      if (responseFormat) {
        (params as unknown as Record<string, unknown>).response_format = responseFormat;
      }

      const response = await client.chat.completions.create(params);

      const choice = response.choices[0];
      if (!choice?.message) {
        return {
          role: 'assistant',
          content: '[警告] choices[0].message 为空',
          finish_reason: choice?.finish_reason,
        };
      }

      const finishReason = choice.finish_reason;
      const reasoning = (choice.message as unknown as Record<string, unknown>).reasoning_content as string | undefined;

      return {
        role: choice.message.role as MultimodalChatMessage['role'],
        content: choice.message.content,
        finish_reason: finishReason,
        reasoning_content: reasoning,
        tool_calls: choice.message.tool_calls?.length
          ? choice.message.tool_calls.map((tc) => ({
              id: tc.id,
              type: tc.type as 'function',
              function: {
                name: tc.function.name as ToolName,
                arguments: tc.function.arguments,
              },
            }))
          : undefined,
      };
    },

    async sendChatStream(
      messages: MultimodalChatMessage[],
      tools?: ToolDefinition[],
      responseFormat?: ResponseFormat,
    ) {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: cfg.model,
        messages: messages.map((m) => {
          const result: Record<string, unknown> = {
            role: m.role,
            content: m.content as OpenAI.Chat.Completions.ChatCompletionContentPart[] | string | null,
          };
          if (m.tool_calls) result.tool_calls = m.tool_calls;
          if (m.tool_call_id) result.tool_call_id = m.tool_call_id;
          if (m.name) result.name = m.name;
          return result as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;
        }),
        stream: true,
        stream_options: { include_usage: false },
      };

      if (cfg.enableThinking) {
        (params as unknown as Record<string, unknown>).thinking = { type: 'enabled' };
      }

      if (tools && tools.length > 0) {
        params.tools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
        (params as unknown as Record<string, unknown>).tool_choice = 'auto';
      }

      if (responseFormat) {
        (params as unknown as Record<string, unknown>).response_format = responseFormat;
      }

      const stream = await client.chat.completions.create(params);

      let finish_reason: string | undefined;
      let resolveMessage!: (msg: MultimodalChatMessage) => void;
      const messagePromise = new Promise<MultimodalChatMessage>((resolve) => {
        resolveMessage = resolve;
      });

      const contentParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCallAccumulator = new Map<number, ToolCall>();

      async function* generate(): AsyncGenerator<StreamChunk> {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const chunkFinishReason = chunk.choices[0]?.finish_reason;
          if (chunkFinishReason) {
            finish_reason = chunkFinishReason;
          }

          const deltaContent = delta?.content;
          const deltaReasoning = (delta as unknown as Record<string, unknown>)
            ?.reasoning_content as string | undefined;
          const deltaToolCalls = delta?.tool_calls;

          if (deltaContent) contentParts.push(typeof deltaContent === 'string' ? deltaContent : '');
          if (deltaReasoning) reasoningParts.push(deltaReasoning);

          const toolCallDeltas: StreamChunk['delta']['tool_calls'] = [];
          if (deltaToolCalls) {
            for (const tcDelta of deltaToolCalls) {
              const idx = tcDelta.index;
              const existing = toolCallAccumulator.get(idx);
              if (!existing) {
                // 首个 delta：id 和 function.name 保证在场，直接凭实值建条目
                if (tcDelta.id && tcDelta.function?.name) {
                  const newTc: ToolCall = {
                    id: tcDelta.id,
                    type: 'function',
                    function: {
                      name: tcDelta.function.name as ToolName,
                      arguments: tcDelta.function.arguments || '',
                    },
                  };
                  toolCallAccumulator.set(idx, newTc);
                  toolCallDeltas.push({
                    index: tcDelta.index,
                    id: tcDelta.id,
                    function: { name: tcDelta.function.name, arguments: tcDelta.function.arguments || '' },
                  });
                }
                continue;
              }
              if (tcDelta.id) existing.id = tcDelta.id;
              if (tcDelta.function?.name) existing.function.name += tcDelta.function.name;
              if (tcDelta.function?.arguments) existing.function.arguments += tcDelta.function.arguments;
              toolCallAccumulator.set(idx, existing);

              toolCallDeltas.push({
                index: tcDelta.index,
                id: tcDelta.id,
                function: tcDelta.function
                  ? {
                      name: tcDelta.function.name,
                      arguments: tcDelta.function.arguments,
                    }
                  : undefined,
              });
            }
          }

          const streamChunk: StreamChunk = {
            delta: {},
          };
          if (deltaContent) streamChunk.delta.content = typeof deltaContent === 'string' ? deltaContent : '';
          if (deltaReasoning) streamChunk.delta.reasoning_content = deltaReasoning;
          if (toolCallDeltas.length > 0) streamChunk.delta.tool_calls = toolCallDeltas;

          yield streamChunk;
        }

        // 组装完整 MultimodalChatMessage
        const finalContent = contentParts.length > 0 ? contentParts.join('') : null;
        const finalReasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;

        const finalToolCalls = toolCallAccumulator.size > 0
          ? Array.from(toolCallAccumulator.entries())
              .sort(([a], [b]) => a - b)
              .map(([, tc]) => tc)
          : undefined;

        resolveMessage({
          role: 'assistant',
          content: finalContent,
          finish_reason,
          reasoning_content: finalReasoning,
          tool_calls: finalToolCalls,
        });
      }

      const iterator = generate();

      return {
        stream: {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        },
        message: messagePromise,
      };
    },
  };
}

export type { ToolDefinition, ToolCall };
