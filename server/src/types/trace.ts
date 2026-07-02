/**
 * Trace 类型定义 —— LLM 对话追踪数据库
 *
 * 三张表：
 *  - trace_sessions：每轮完整对话一个会话
 *  - client_sent：发给 LLM 的消息（system / user / tool / tool_schema）
 *  - client_received：LLM 返回的消息（assistant 回复 + reasoning + tool_calls）
 *
 * TraceContext 在路由 → Agent → 子 Agent 之间传播。
 */

// ==================================================================
//  TraceContext —— 在 Agent 调用链中传播的上下文
// ==================================================================

export interface TraceContext {
  /** 当前会话 ID */
  conversationId: string;
  /** 触发用户 ID */
  userId: number;
  /** 用户名快照 */
  username: string;
  /** 顶层入口 Agent（如 MainAgent / ChatAgent / ImageParseAgent / LayoutAgent） */
  mainAgent: string;
  /** 实际执行的 Agent 类名 */
  agentName: string;
  /** 父级 dispatch tool call ID（子 agent 会话用） */
  parentToolCallId?: string;
  /** 顶层 API 路由（如 /api/table-parse） */
  route: string;
  /** LLM provider 名称 */
  provider: string;
  /** LLM 模型名称 */
  model: string;
  /** 是否启用 trace 记录 */
  enabled: boolean;
}

// ==================================================================
//  trace_sessions 行类型
// ==================================================================

export interface TraceSessionRow {
  id: number;
  conversation_id: string;
  user_id: number;
  username: string;
  main_agent: string;
  agent_name: string;
  parent_tool_call_id: string | null;
  route: string;
  provider: string;
  model: string;
  status: 'running' | 'completed' | 'error';
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

// ==================================================================
//  client_sent 行类型
// ==================================================================

export type ClientSentRole = 'system' | 'user' | 'tool' | 'tool_schema';
export type ContentFormat = 'text' | 'markdown' | 'json' | 'multimodal_placeholder';

export interface ClientSentRow {
  id: number;
  conversation_id: string;
  message_index: number;
  role: ClientSentRole;
  name: string | null;
  tool_call_id: string | null;
  parent_tool_call_id: string | null;
  content_text: string | null;
  content_json: string | null;
  content_format: ContentFormat;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

// ==================================================================
//  client_received 行类型
// ==================================================================

export type ClientReceivedSource = 'llm' | 'injected';

export interface ClientReceivedRow {
  id: number;
  conversation_id: string;
  message_index: number;
  finish_reason: string | null;
  reply: string | null;
  reasoning: string | null;
  tool_calls_json: string | null;
  tool_call_ids_json: string | null;
  source: ClientReceivedSource;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

// ==================================================================
//  API 响应类型
// ==================================================================

/** GET /api/trace 列表项 */
export interface TraceSessionSummary {
  conversation_id: string;
  username: string;
  user_id: number;
  main_agent: string;
  agent_name: string;
  parent_tool_call_id: string | null;
  route: string;
  provider: string;
  model: string;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

/** GET /api/trace/:conversationId 详情 */
export interface TraceSessionDetail {
  session: TraceSessionRow;
  messages: (ClientSentRow | ClientReceivedRow)[];
}
