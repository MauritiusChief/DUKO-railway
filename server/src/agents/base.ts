/**
 * BaseAgent —— 工具调用 Agent 基类
 *
 * 封装通用的 LLM 对话循环、预算管理、工具调度、幻觉清理、预算注入逻辑。
 * 子类只需提供系统提示词、工具定义和工具执行器。
 *
 * 泛型 TMessage 支持：
 *  - ChatMessage           → DeepSeek 纯文本 Agent
 *  - MultimodalChatMessage → OpenRouter 多模态 Agent
 */

import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage, MultimodalChatMessage, MultimodalContent } from '../types/message.js';
import type { LlmProvider, ResponseFormat } from '../llm/provider.js';
import type { TraceContext } from '../types/trace.js';
import { injectBudgetInfo } from '../tools/budget.js';
import { ToolName } from '../tools/index.js';
import {
  insertClientSent,
  insertClientReceived,
  insertTraceSession,
  markSessionCompleted,
  markSessionError,
} from '../services/trace.js';
import { randomUUID } from 'crypto';

// ==================================================================
//  AgentStepEvent —— Agent 步进事件（SSE 推送用）
// ==================================================================

export type AgentStepEvent =
  | { type: 'round_start'; round: number }
  | { type: 'tool_call'; tool: string }
  | { type: 'reply'; text: string }
  | { type: 'reply_chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ==================================================================
//  AgentContext —— 工具执行时的上下文
// ==================================================================

/**
 * 工具执行上下文。子类可扩展此接口添加自定义字段。
 * BaseAgent 在执行每个 tool call 前将此对象传给子类的 executeTool。
 */
export interface AgentContext {
  [key: string]: unknown;
}

// ==================================================================
//  BaseAgentConfig —— 子类构造参数
// ==================================================================

export interface BaseAgentConfig {
  /** 受限工具预算上限（限制搜索和 dispatch 等耗时工具的总调用次数） */
  searchBudgetLimit: number;
  /** 最大总对话轮数（兜底） */
  maxRounds: number;
  /** 回复语言提示，如 '中文' 或 '英文' */
  langHint: string;
  /** SSE 步进回调，每轮循环/工具调用时触发 */
  onStep?: (event: AgentStepEvent) => void;
}

// ==================================================================
//  AgentResult —— run() 返回值
// ==================================================================

export interface AgentResult<TMessage extends ChatMessage | MultimodalChatMessage = ChatMessage> {
  /** 最终文本回复 */
  reply: string;
  /** 完整对话消息历史（含 system / user / assistant / tool） */
  messages: TMessage[];
}

// ==================================================================
//  BaseAgent
// ==================================================================

export abstract class BaseAgent<
  TMessage extends ChatMessage | MultimodalChatMessage = ChatMessage,
> {
  /** 此 Agent 声明的工具名列表（供 Orchestrator 查询工具所有权） */
  static ownedToolNames: string[] = [];

  protected llm: LlmProvider<TMessage>;
  protected config: BaseAgentConfig;
  /** 当前对话的 trace 上下文（仅 traceLog 启用时非空，由路由层设置） */
  trace?: TraceContext;

  constructor(llm: LlmProvider<TMessage>, config: BaseAgentConfig) {
    this.llm = llm;
    this.config = config;
  }

  /**
   * 为子 agent 创建并注册 trace session。
   * 从父级 trace 上下文克隆，生成新的 conversation_id，设置 agent_name 和 parent_tool_call_id。
   *
   * @param parentTrace 父级 trace 上下文
   * @param agentName 子 agent 类名（如 'BatchSearchAgent'）
   * @param parentToolCallId 触发此子 agent 的父级工具调用 ID
   * @param providerOverride 可选，覆盖父级 trace 的 provider/model（如 OCR 子 agent 使用 OpenRouter 而非 DeepSeek）
   */
  protected initSubTrace(
    parentTrace: TraceContext,
    agentName: string,
    parentToolCallId: string,
    providerOverride?: { provider: string; model: string },
  ): TraceContext | undefined {
    if (!parentTrace.enabled) return undefined;
    const conversationId = randomUUID();
    const trace: TraceContext = {
      conversationId,
      userId: parentTrace.userId,
      username: parentTrace.username,
      mainAgent: parentTrace.mainAgent,
      agentName,
      parentToolCallId,
      route: parentTrace.route,
      provider: providerOverride?.provider ?? parentTrace.provider,
      model: providerOverride?.model ?? parentTrace.model,
      enabled: true,
    };
    insertTraceSession(
      conversationId,
      trace.userId,
      trace.username,
      trace.mainAgent,
      trace.agentName,
      parentToolCallId,
      trace.route,
      trace.provider,
      trace.model,
    );
    return trace;
  }

  // ================================================================
  //  子类必须实现的抽象方法
  // ================================================================

  /** 构建系统提示词 */
  abstract getSystemPrompt(): string;

  /** 返回此 Agent 可用的全部工具定义 */
  abstract getTools(): ToolDefinition[];

  /**
   * 执行单个工具调用并返回结果文本。
   * 子类在此实现具体工具的分发逻辑。
   *
   * @param tc      - LLM 发起的工具调用
   * @param context - 工具执行上下文（子类可传入自定义字段）
   */
  protected abstract executeTool(
    tc: ToolCall,
    context: AgentContext,
  ): Promise<string>;

  // ================================================================
  //  子类可选覆盖的钩子
  // ================================================================

  /** 判断工具是否消耗搜索预算。默认从 getBudgetedToolNames() 推导，保持一致。 */
  protected isBudgetedTool(toolName: ToolName): boolean {
    return this.getBudgetedToolNames().has(toolName);
  }

  /** 只在搜索预算大于0时才提供的工具定义。默认全部工具都视作有限制。 */
  protected getBudgetedToolNames(): Set<ToolName> {
    return new Set<ToolName>();
  }

  /**
   * 自定义每轮 LLM 调用的额外参数。
   * 子类可覆盖此方法以强制 json_object 等特定输出模式。
   */
  protected getResponseFormat(): ResponseFormat | undefined {
    return undefined;
  }

  protected onBeforeToolRound(
    _messages: TMessage[],
    _context: AgentContext,
  ): void {}

  /**
   * 子类可覆盖此方法，返回 true 的工具可在同一轮 LLM 响应中与其他可并发工具并行执行。
   * 默认所有工具串行执行。典型用法：TableParseAgent 将 dispatchBatchSearch / dispatchPreciseSearch /
   * dispatchGlassDoorCalc 标记为可并发，使多个委派子 agent 的调用并行执行，显著缩短总耗时。
   * 
   * 注意：不要将存在共享可变状态依赖的工具标记为可并发（如 manifest 编辑工具）。
   */
  protected canExecuteInParallel(toolName: ToolName): boolean {
    return false;
  }

  /**
   * 覆盖此方法以在最终回复提取后做后处理（如 JSON 验证、code block 剥离）。
   */
  protected postprocessReply(reply: string): string {
    return reply;
  }

  /**
   * 在每轮工具执行后调用，返回 false 可提前终止循环。
   * 可用于输出格式强制（如 table-parse 预算耗尽后切换为 json_object 模式）。
   */
  protected shouldContinueAfterRound(
    _messages: TMessage[],
    _round: number,
  ): boolean {
    return true;
  }

  /**
   * 返回预算耗尽提示中"不得再调用"的工具名文字。
   * 从 getBudgetedToolNames() 自动拼接生成，无需子类覆盖。
   */
  protected getBudgetedToolListText(): string {
    const names = [...this.getBudgetedToolNames()];
    return names.length > 0 ? names.join(' / ') : '【出错】未获取到工具名单';
  }

  /**
   * 当对话循环结束后 reply 仍为空时，子类可在此做最后一次尝试。
   * 子类可覆盖此方法发送一次不带工具的特定格式请求。
   * 返回非 null 字符串将直接作为最终 reply。
   */
  protected async finalAttempt(
    _messages: TMessage[],
  ): Promise<string | null> {
    return null;
  }

  // ================================================================
  //  主对话循环
  // ================================================================

  async run(
    initialMessages: TMessage[],
    context: AgentContext = {},
  ): Promise<AgentResult<TMessage>> {
    const traceCtx = this.trace?.enabled ? this.trace : undefined;

    try {
      return await this.runInternal(initialMessages, context, traceCtx);
    } catch (err) {
      // ---- Trace：标记 session 错误（保留不完整 trace） ----
      if (traceCtx) {
        try {
          markSessionError(traceCtx.conversationId, err instanceof Error ? err.message : String(err));
        } catch {
          // 静默
        }
      }
      throw err;
    }
  }

  private async runInternal(
    initialMessages: TMessage[],
    context: AgentContext,
    traceCtx: TraceContext | undefined,
  ): Promise<AgentResult<TMessage>> {
    const messages: TMessage[] = [...initialMessages];
    let searchBudgetUsed = 0;
    let msgIdx = 0;
    let lastSchemaJson: string | null = null;

    // ---- Trace：记录 system / user 初始消息 ----
    if (traceCtx) {
      for (const m of initialMessages) {
        const contentText = extractTraceText(m.content);
        const isMarkdown = typeof contentText === 'string' && hasMarkdownHeadings(contentText);
        const fmt = isMarkdown ? 'markdown' : 'text';
        insertClientSent({
          conversationId: traceCtx.conversationId,
          messageIndex: msgIdx++,
          role: m.role as 'system' | 'user',
          contentText,
          contentFormat: fmt,
        });
      }
    }

    for (let round = 0; round < this.config.maxRounds; round++) {
      this.config.onStep?.({ type: 'round_start', round: round + 1 });

      const remainingBudget = this.config.searchBudgetLimit - searchBudgetUsed;
      const budgetedNames = this.getBudgetedToolNames();

      // 搜索预算 > 0 → 提供全部工具；预算耗尽 → 仅非搜索工具
      const availableTools = this.computeAvailableTools(remainingBudget, budgetedNames);

      // ---- Trace：记录 tool schema（首次或变化时） ----
      if (traceCtx && availableTools && availableTools.length > 0) {
        const schemaJson = JSON.stringify(availableTools);
        if (schemaJson !== lastSchemaJson) {
          lastSchemaJson = schemaJson;
          for (const toolDef of availableTools) {
            insertClientSent({
              conversationId: traceCtx.conversationId,
              messageIndex: msgIdx,
              role: 'tool_schema',
              name: toolDef.function.name,
              contentJson: JSON.stringify(toolDef),
              contentFormat: 'json',
            });
          }
          msgIdx++;
        }
      }

      // 流式调用 LLM：实时吐出 reply_chunk 事件，最终拿到完整 ChatMessage
      const { stream, message } = await this.llm.sendChatStream(
        messages,
        availableTools,
        this.getResponseFormat(),
      );

      for await (const chunk of stream) {
        if (chunk.delta.content) {
          this.config.onStep?.({ type: 'reply_chunk', text: chunk.delta.content });
        }
      }

      const response = await message;
      messages.push(response);

      // ---- Trace：记录 LLM 返回的 assistant 消息 ----
      if (traceCtx) {
        try {
          const assistantContent = extractTraceText(response.content);
          insertClientReceived({
            conversationId: traceCtx.conversationId,
            messageIndex: msgIdx++,
            finishReason: response.finish_reason,
            reply: assistantContent,
            reasoning: response.reasoning_content ?? null,
            toolCallsJson: response.tool_calls?.length ? JSON.stringify(response.tool_calls) : null,
            toolCallIdsJson: response.tool_calls?.length
              ? JSON.stringify(response.tool_calls.map((tc) => tc.id))
              : null,
            source: 'llm',
          });
        } catch {
          // trace 记录失败不影响主流程
        }
      }

      // 清理 LLM 幻觉生成的 _budget_info 工具调用（非本系统注入的）
      this.cleanHallucinatedBudgetInfo(response);

      // 清理空壳 assistant 消息（既无文本内容也无有效 tool_calls）
      if (this.isEmptyShellMessage(response)) {
        messages.pop();
        continue;
      }

      const finishReason = response.finish_reason;

      // stop / content_filter → 正常终止
      if (finishReason === 'stop' || finishReason === 'content_filter') {
        break;
      }
      if (finishReason === 'length') {
        console.warn(
          `[${this.constructor.name} Round ${round + 1}] LLM response truncated (length).`,
        );
      }

      // 工具调用分支
      if (
        finishReason === 'tool_calls' &&
        response.tool_calls &&
        response.tool_calls.length > 0
      ) {
        this.onBeforeToolRound(messages, context);

        // 本轮消耗预算的工具调用数（执行前一次性统计，无竞态）
        const budgetedCallCount = response.tool_calls.filter(
          (tc) => this.isBudgetedTool(tc.function.name),
        ).length;

        // 将工具调用按可并发标记分组：连续的可并发工具归入同一组，不可并发的独立成组。
        // 组间顺序串行执行，组内通过 Promise.all 并行执行。
        // 这样 dispatchBatchSearch / dispatchPreciseSearch / dispatchGlassDoorCalc
        // 等委派子 agent 的耗时工具可以并行，而 manifest 编辑等有共享状态的工具保持串行安全。
        const groups: ToolCall[][] = [];
        let currentGroup: ToolCall[] = [];

        for (const tc of response.tool_calls) {
          if (this.canExecuteInParallel(tc.function.name)) {
            currentGroup.push(tc);
          } else {
            if (currentGroup.length > 0) {
              groups.push(currentGroup);
              currentGroup = [];
            }
            groups.push([tc]);
          }
        }
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }

        for (const group of groups) {
          if (group.length === 1) {
            // 单个工具或不可并发工具 → 串行执行
            const tc = group[0];
            this.config.onStep?.({ type: 'tool_call', tool: tc.function.name });
            let result: string;
            let toolError: string | undefined;
            try {
              result = await this.executeTool(tc, context);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              result = `工具执行错误: ${msg}`;
              toolError = msg;
            }
            messages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
              name: tc.function.name,
            } as TMessage);
            // ---- Trace：记录 tool result ----
            if (traceCtx) {
              try {
                insertClientSent({
                  conversationId: traceCtx.conversationId,
                  messageIndex: msgIdx,
                  role: 'tool',
                  name: tc.function.name,
                  toolCallId: tc.id,
                  contentText: result,
                  contentFormat: isJsonString(result) ? 'json' : 'text',
                  error: toolError ?? null,
                });
                msgIdx++;
              } catch {
                // 静默
              }
            }
          } else {
            // 可并发工具组 → Promise.all 并行执行
            const toolResults = await Promise.all(
              group.map(async (tc) => {
                // 通知 SSE 前端正在调用此工具（ChatPanel 展示工具调用过程）
                this.config.onStep?.({ type: 'tool_call', tool: tc.function.name });
                let result: string;
                let toolError: string | undefined;
                try {
                  result = await this.executeTool(tc, context);
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  result = `工具执行错误: ${msg}`;
                  toolError = msg;
                }
                return { tc, result, toolError } as const;
              }),
            );
            for (const { tc, result, toolError } of toolResults) {
              messages.push({
                role: 'tool',
                content: result,
                tool_call_id: tc.id,
                name: tc.function.name,
              } as TMessage);
              // ---- Trace：记录 tool result ----
              if (traceCtx) {
                try {
                  insertClientSent({
                    conversationId: traceCtx.conversationId,
                    messageIndex: msgIdx,
                    role: 'tool',
                    name: tc.function.name,
                    toolCallId: tc.id,
                    contentText: result,
                    contentFormat: isJsonString(result) ? 'json' : 'text',
                    error: toolError ?? null,
                  });
                  msgIdx++;
                } catch {
                  // 静默
                }
              }
            }
          }
        }

        searchBudgetUsed += budgetedCallCount;

        // 注入搜索预算虚拟 tool pair（仅告知搜索预算，不在工具 schema 中注册）
        if (budgetedNames.size > 0) {
          const newRemaining = this.config.searchBudgetLimit - searchBudgetUsed;
          injectBudgetInfo(
            messages as (ChatMessage | MultimodalChatMessage)[],
            round,
            newRemaining,
            this.config.searchBudgetLimit,
            this.config.langHint,
            undefined,
            this.getBudgetedToolListText(),
          );
          // ---- Trace：记录 _budget_info 虚拟消息对 ----
          if (traceCtx) {
            try {
              insertClientReceived({
                conversationId: traceCtx.conversationId,
                messageIndex: msgIdx++,
                finishReason: 'tool_calls',
                toolCallsJson: JSON.stringify([{
                  id: `_budget_info_${round}`,
                  type: 'function',
                  function: { name: '_budget_info', arguments: '{}' },
                }]),
                toolCallIdsJson: JSON.stringify([`_budget_info_${round}`]),
                source: 'injected',
              });
              insertClientSent({
                conversationId: traceCtx.conversationId,
                messageIndex: msgIdx++,
                role: 'tool',
                name: '_budget_info',
                toolCallId: `_budget_info_${round}`,
                contentText: messages[messages.length - 1].content
                  ? String(messages[messages.length - 1].content)
                  : '',
                contentFormat: 'text',
              });
            } catch {
              // 静默
            }
          }
        }

        if (!this.shouldContinueAfterRound(messages, round)) {
          break;
        }
      } else {
        break;
      }
    }

    // 提取最终回复
    let reply = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.role === 'assistant' &&
        m.content &&
        String(m.content).trim()
      ) {
        reply = String(m.content).trim();
        break;
      }
    }

    if (!reply) {
      const fallback = await this.finalAttempt(messages);
      if (fallback) reply = fallback;
    }

    reply = this.postprocessReply(reply);

    // ---- Trace：标记 session 完成 ----
    if (traceCtx) {
      try {
        markSessionCompleted(traceCtx.conversationId);
      } catch {
        // 静默
      }
    }

    return { reply, messages };
  }

  // ================================================================
  //  内部工具方法
  // ================================================================

  private computeAvailableTools(
    remainingBudget: number,
    budgetedNames: Set<string>,
  ): ToolDefinition[] | undefined {
    if (budgetedNames.size > 0) {
      const tools =
        remainingBudget > 0
          ? this.getTools()
          : this.getTools().filter(
              (t) => !budgetedNames.has(t.function.name),
            );
      return tools.length > 0 ? tools : undefined;
    }

    const tools = this.getTools();
    return tools.length > 0 ? tools : undefined;
  }

    /**
   * 清理 LLM 幻觉生成的 _budget_info 工具调用。
   * 合法的 _budget_info 必须满足 id 格式 _budget_info_N。
   */
  private cleanHallucinatedBudgetInfo(response: TMessage): void {
    if (response.tool_calls && response.tool_calls.length > 0) {
      const validCalls = response.tool_calls.filter(
        (tc) =>
          tc.function.name !== '_budget_info' ||
          /^_budget_info_\d+$/.test(tc.id),
      );

      if (validCalls.length === 0) {
        // 全部是幻觉 → 清空让外层 pop + continue
        response.tool_calls = [];
        (response as unknown as Record<string, unknown>).content = null;
      } else {
        response.tool_calls = validCalls;
      }
    }
  }

  /** 检查是否为既无内容也无有效 tool_calls 的空壳 assistant 消息 */
  private isEmptyShellMessage(response: TMessage): boolean {
    return (
      response.role === 'assistant' &&
      (!response.content || !String(response.content).trim()) &&
      (!response.tool_calls || response.tool_calls.length === 0)
    );
  }
}

// ==================================================================
//  Trace 辅助函数
// ==================================================================

/**
 * 从消息 content 中提取纯文本（用于 trace 存储）。
 * 多模态消息中的 image_url 替换为 [image] 占位符。
 */
function extractTraceText(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'type' in part) {
          if (part.type === 'text' && 'text' in part) return String(part.text);
          if (part.type === 'image_url') return '[image]';
        }
        return String(part);
      })
      .join('');
  }
  return String(content);
}

function hasMarkdownHeadings(text: string): boolean {
  return /^#/m.test(text);
}

function isJsonString(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
