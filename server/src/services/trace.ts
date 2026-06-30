/**
 * Trace 数据库服务 —— LLM 对话追踪的持久化读写
 *
 * 管理 trace_sessions / client_sent / client_received 三张表的 CRUD，
 * 以及 30 天自动清理策略。
 *
 * 所有写入函数均为 fire-and-forget 风格：内部 try/catch 静默处理错误，
 * 确保 trace 记录失败不会影响 Agent 主流程。
 */

import type {
  TraceSessionRow,
  TraceSessionSummary,
  TraceSessionDetail,
  ClientSentRow,
  ClientReceivedRow,
  ClientSentRole,
  ContentFormat,
  ClientReceivedSource,
} from '../types/trace.js';
import type Database from 'better-sqlite3';

// ==================================================================
//  模块级状态 —— 由 initTraceDB 注入
// ==================================================================

let db: Database.Database | null = null;

/** 初始化：保存数据库连接引用（由 users.ts 的 initUserDB 之后调用） */
export function initTraceDB(database: Database.Database): void {
  db = database;
}

// ==================================================================
//  Session 生命周期
// ==================================================================

/** 插入一个新的 trace session，返回 conversation_id 供后续引用 */
export function insertTraceSession(
  conversationId: string,
  userId: number,
  username: string,
  mainAgent: string,
  agentName: string,
  parentToolCallId: string | null,
  route: string,
  provider: string,
  model: string,
): void {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO trace_sessions (conversation_id, user_id, username, main_agent, agent_name, parent_tool_call_id, route, provider, model, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `).run(conversationId, userId, username, mainAgent, agentName, parentToolCallId, route, provider, model);
  } catch {
    // 静默：trace 记录失败不影响主流程
  }
}

/** 标记 session 为 completed */
export function markSessionCompleted(conversationId: string): void {
  if (!db) return;
  try {
    db.prepare(`
      UPDATE trace_sessions SET status = 'completed', completed_at = datetime('now')
      WHERE conversation_id = ?
    `).run(conversationId);
  } catch {
    // 静默
  }
}

/** 标记 session 为 error */
export function markSessionError(conversationId: string, errorMessage: string): void {
  if (!db) return;
  try {
    db.prepare(`
      UPDATE trace_sessions SET status = 'error', error = ?, completed_at = datetime('now')
      WHERE conversation_id = ?
    `).run(errorMessage, conversationId);
  } catch {
    // 静默
  }
}

// ==================================================================
//  client_sent 写入
// ==================================================================

interface InsertClientSentParams {
  conversationId: string;
  messageIndex: number;
  role: ClientSentRole;
  name?: string | null;
  toolCallId?: string | null;
  parentToolCallId?: string | null;
  contentText?: string | null;
  contentJson?: string | null;
  contentFormat?: ContentFormat;
  error?: string | null;
}

/** 插入一条 client_sent 记录 */
export function insertClientSent(params: InsertClientSentParams): void {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO client_sent (conversation_id, message_index, role, name, tool_call_id, parent_tool_call_id, content_text, content_json, content_format, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.conversationId,
      params.messageIndex,
      params.role,
      params.name ?? null,
      params.toolCallId ?? null,
      params.parentToolCallId ?? null,
      params.contentText ?? null,
      params.contentJson ?? null,
      params.contentFormat ?? 'text',
      params.error ?? null,
    );
  } catch {
    // 静默
  }
}

// ==================================================================
//  client_received 写入
// ==================================================================

interface InsertClientReceivedParams {
  conversationId: string;
  messageIndex: number;
  finishReason?: string | null;
  reply?: string | null;
  reasoning?: string | null;
  toolCallsJson?: string | null;
  toolCallIdsJson?: string | null;
  source?: ClientReceivedSource;
  error?: string | null;
}

/** 插入一条 client_received 记录 */
export function insertClientReceived(params: InsertClientReceivedParams): void {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO client_received (conversation_id, message_index, finish_reason, reply, reasoning, tool_calls_json, tool_call_ids_json, source, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.conversationId,
      params.messageIndex,
      params.finishReason ?? null,
      params.reply ?? null,
      params.reasoning ?? null,
      params.toolCallsJson ?? null,
      params.toolCallIdsJson ?? null,
      params.source ?? 'llm',
      params.error ?? null,
    );
  } catch {
    // 静默
  }
}

// ==================================================================
//  30 天清理
// ==================================================================

/** 删除 30 天前的 trace 数据（cascade 自动清理子表） */
export function cleanupOldTraces(): void {
  if (!db) return;
  try {
    const result = db.prepare(`
      DELETE FROM trace_sessions WHERE created_at < datetime('now', '-30 days')
    `).run();
    if (result.changes > 0) {
      console.log(`[Trace] 已清理 ${result.changes} 条过期 trace session`);
    }
  } catch {
    // 静默
  }
}

// ==================================================================
//  API 查询
// ==================================================================

/** 列出最近 30 天的 trace session 摘要 */
export function getTraceSessions(): TraceSessionSummary[] {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT conversation_id, username, user_id, main_agent, agent_name,
             parent_tool_call_id, route, provider, model, status, error,
             created_at, completed_at
      FROM trace_sessions
      WHERE created_at >= datetime('now', '-30 days')
      ORDER BY created_at DESC
    `).all() as TraceSessionSummary[];
  } catch {
    return [];
  }
}

/** 获取单个 session 的完整详情（含消息列表） */
export function getTraceDetail(conversationId: string): TraceSessionDetail | null {
  if (!db) return null;
  try {
    const session = db.prepare(`
      SELECT * FROM trace_sessions WHERE conversation_id = ?
    `).get(conversationId) as TraceSessionRow | undefined;

    if (!session) return null;

    // 合并 sent + received，按 message_index / id 排序
    const sentRows = db.prepare(`
      SELECT *, 'sent' AS _type FROM client_sent WHERE conversation_id = ?
    `).all(conversationId) as (ClientSentRow & { _type: string })[];

    const receivedRows = db.prepare(`
      SELECT *, 'received' AS _type FROM client_received WHERE conversation_id = ?
    `).all(conversationId) as (ClientReceivedRow & { _type: string })[];

    // 合并并按 message_index, id 排序
    const messages = [...sentRows, ...receivedRows]
      .sort((a, b) => {
        const idxDiff = (a as unknown as { message_index: number }).message_index -
          (b as unknown as { message_index: number }).message_index;
        if (idxDiff !== 0) return idxDiff;
        return a.id - b.id;
      })
      .map(({ _type, ...rest }) => rest) as (ClientSentRow | ClientReceivedRow)[];

    return { session, messages };
  } catch {
    return null;
  }
}
