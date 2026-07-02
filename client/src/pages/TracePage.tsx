/**
 * TracePage —— 管理员查看 LLM 对话 trace
 *
 * 左侧：按时间倒序的 trace session 列表
 * 右侧：选中 session 的详情，含消息分组渲染
 */

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';
import type {
  TraceSessionSummary,
  TraceSessionDetail,
  ClientSentMessage,
  ClientReceivedMessage,
  TraceGroup,
  TraceMessage,
} from '../types';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import './TracePage.css';

// ==================================================================
//  辅助函数
// ==================================================================

function isClientSent(msg: TraceMessage): msg is ClientSentMessage {
  return 'role' in msg;
}

function formatTime(iso: string | null): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso + 'Z');
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running': return '运行中';
    case 'completed': return '已完成';
    case 'error': return '错误';
    default: return status;
  }
}

function statusClass(status: string): string {
  return `trace-status-${status}`;
}

// ==================================================================
//  消息分组算法
// ==================================================================

function groupMessages(messages: TraceMessage[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];

    if (isClientSent(m)) {
      if (m.role === 'tool_schema') {
        // tool_schema 合并到各组的前面，这里先跳过，最后统一处理
        // 实际在渲染时，tool_schema 作为一个独立 group 显示
        groups.push({ kind: 'sent', sent: m, tools: [] });
        i++;
        continue;
      }
      if (m.role === 'tool' && m.name === '_budget_info') {
        // _budget_info virtual tool → 附加到前一个 assistant group
        const injectedId = m.tool_call_id;
        // 查找对应的 injected received
        let injectedReceived: ClientReceivedMessage | undefined;
        for (let j = i - 1; j >= 0; j--) {
          const prev = messages[j];
          if (!isClientSent(prev) && prev.source === 'injected') {
            if (prev.tool_call_ids_json && JSON.parse(prev.tool_call_ids_json).includes(injectedId)) {
              injectedReceived = prev;
              break;
            }
          }
        }
        if (injectedReceived && groups.length > 0) {
          const last = groups[groups.length - 1];
          if (last.kind === 'assistant') {
            last.budget = { received: injectedReceived, sent: m };
            i++;
            continue;
          }
        }
        // 找不到归属 → 作为独立 sent
        groups.push({ kind: 'sent', sent: m, tools: [] });
        i++;
        continue;
      }
      if (m.role === 'tool') {
        // 真实 tool 结果 → 附加到前面最近的 matching assistant
        let attached = false;
        for (let g = groups.length - 1; g >= 0; g--) {
          const grp = groups[g];
          if (grp.kind === 'assistant' && grp.assistant?.tool_call_ids_json) {
            try {
              const ids: string[] = JSON.parse(grp.assistant.tool_call_ids_json);
              if (m.tool_call_id && ids.includes(m.tool_call_id)) {
                grp.tools.push(m);
                attached = true;
                break;
              }
            } catch {
              // 解析失败
            }
          }
        }
        if (!attached) {
          groups.push({ kind: 'sent', sent: m, tools: [] });
        }
        i++;
        continue;
      }
      // system / user / other sent
      groups.push({ kind: 'sent', sent: m, tools: [] });
    } else {
      // client_received → assistant group
      groups.push({ kind: 'assistant', assistant: m, tools: [] });
    }
    i++;
  }

  return groups;
}

// ==================================================================
//  JSON 递归查看器（原生 <details> 实现）
// ==================================================================

function JsonViewer({ data }: { data: unknown }) {
  if (data === null || data === undefined) {
    return <span className="trace-json-null">null</span>;
  }
  if (typeof data === 'string') {
    return <span className="trace-json-string">"{data}"</span>;
  }
  if (typeof data === 'number') {
    return <span className="trace-json-number">{data}</span>;
  }
  if (typeof data === 'boolean') {
    return <span className="trace-json-boolean">{String(data)}</span>;
  }
  if (Array.isArray(data)) {
    return (
      <details open>
        <summary className="trace-json-summary">Array [{data.length}]</summary>
        <div className="trace-json-children">
          {data.map((item, idx) => (
            <div key={idx} className="trace-json-entry">
              <span className="trace-json-key">{idx}: </span>
              <JsonViewer data={item} />
            </div>
          ))}
        </div>
      </details>
    );
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    return (
      <details open>
        <summary className="trace-json-summary">Object {'{'}{entries.length}{'}'}</summary>
        <div className="trace-json-children">
          {entries.map(([key, value]) => (
            <div key={key} className="trace-json-entry">
              <span className="trace-json-key">{key}: </span>
              <JsonViewer data={value} />
            </div>
          ))}
        </div>
      </details>
    );
  }
  return <span>{String(data)}</span>;
}

// ==================================================================
//  TracePage 主组件
// ==================================================================

export default function TracePage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<TraceSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // 加载 session 列表
  useEffect(() => {
    fetchWithAuth('/api/trace')
      .then((r) => r.json())
      .then((data: TraceSessionSummary[]) => setSessions(data))
      .catch(() => {});
  }, []);

  // 选中 session → 加载详情
  const handleSelect = (conversationId: string) => {
    setSelectedId(conversationId);
    setDetailLoading(true);
    setDetail(null);
    fetchWithAuth(`/api/trace/${conversationId}`)
      .then((r) => r.json())
      .then((data: TraceSessionDetail) => setDetail(data))
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  };

  const groups = detail ? groupMessages(detail.messages) : [];

  return (
    <div className="trace-container">
      {/* 页头 */}
      <div className="trace-header">
        <div className="trace-header-left">
          <h1 className="trace-title">LLM Trace 查看</h1>
        </div>
        <button className="trace-home-btn" onClick={() => navigate('/')}>
          回到主页
        </button>
      </div>

      {/* 主体：左列表 + 右详情 */}
      <div className="trace-main">
        {/* 左列 */}
        <div className="trace-left">
          <div className="trace-left-header">
            <span>Session 列表（最近 30 天）</span>
            <span className="trace-count">{sessions.length}</span>
          </div>
          <div className="trace-list">
            {sessions.length === 0 && (
              <div className="trace-list-empty">暂无 trace 数据</div>
            )}
            {sessions.map((s) => (
              <div
                key={s.conversation_id}
                className={`trace-list-item ${s.conversation_id === selectedId ? 'trace-list-item-active' : ''}`}
                onClick={() => handleSelect(s.conversation_id)}
              >
                <div className="trace-item-time">{formatTime(s.created_at)}</div>
                <div className="trace-item-user">{s.username}</div>
                <div className="trace-item-agent">
                  {s.main_agent === s.agent_name
                    ? s.agent_name
                    : `${s.main_agent} > ${s.agent_name}`}
                </div>
                <div className="trace-item-meta">
                  <span className={statusClass(s.status)}>{statusLabel(s.status)}</span>
                  {s.parent_tool_call_id && <span className="trace-item-parent" title="子 agent">→</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右列 */}
        <div className="trace-right">
          {!selectedId && (
            <div className="trace-right-placeholder">选择左侧 session 查看详情</div>
          )}
          {selectedId && detailLoading && (
            <div className="trace-right-loading">加载中...</div>
          )}
          {selectedId && detail && (
            <div className="trace-detail">
              {/* 会话信息头 */}
              <div className="trace-detail-header">
                <div className="trace-dh-row">
                  <span className="trace-dh-label">用户</span>
                  <span>{detail.session.username} (ID: {detail.session.user_id})</span>
                </div>
                <div className="trace-dh-row">
                  <span className="trace-dh-label">Agent</span>
                  <span>
                    {detail.session.main_agent === detail.session.agent_name
                      ? detail.session.agent_name
                      : `${detail.session.main_agent} > ${detail.session.agent_name}`}
                  </span>
                </div>
                {detail.session.parent_tool_call_id && (
                  <div className="trace-dh-row">
                    <span className="trace-dh-label">Parent Tool Call</span>
                    <span className="trace-dh-mono">{detail.session.parent_tool_call_id}</span>
                  </div>
                )}
                <div className="trace-dh-row">
                  <span className="trace-dh-label">Route</span>
                  <span>{detail.session.route}</span>
                </div>
                <div className="trace-dh-row">
                  <span className="trace-dh-label">Provider / Model</span>
                  <span>{detail.session.provider} / {detail.session.model}</span>
                </div>
                <div className="trace-dh-row">
                  <span className="trace-dh-label">创建时间</span>
                  <span>{formatTime(detail.session.created_at)}</span>
                </div>
                <div className="trace-dh-row">
                  <span className="trace-dh-label">完成时间</span>
                  <span>{formatTime(detail.session.completed_at)}</span>
                </div>
                <div className="trace-dh-row">
                  <span className="trace-dh-label">状态</span>
                  <span className={statusClass(detail.session.status)}>
                    {statusLabel(detail.session.status)}
                  </span>
                </div>
                {detail.session.error && (
                  <div className="trace-dh-row trace-dh-error">
                    <span className="trace-dh-label">错误</span>
                    <span>{detail.session.error}</span>
                  </div>
                )}
              </div>

              {/* 消息列表 */}
              <div className="trace-messages">
                {groups.map((group, gi) => (
                  <TraceGroupBlock key={gi} group={group} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================================================================
//  TraceGroupBlock —— 渲染一个消息分组
// ==================================================================

function TraceGroupBlock({ group }: { group: TraceGroup }) {
  if (group.kind === 'sent' && group.sent) {
    const m = group.sent;
    const isToolSchema = m.role === 'tool_schema';
    return (
      <details className="trace-msg" open={!isToolSchema && m.role !== 'system'}>
        <summary className="trace-msg-summary">
          <span className={`trace-msg-role trace-role-${m.role}`}>{m.role}</span>
          {m.name && <span className="trace-msg-name">{m.name}</span>}
          {m.error && <span className="trace-msg-error-badge">error</span>}
        </summary>
        <div className="trace-msg-body">
          {m.error && (
            <div className="trace-msg-error">{m.error}</div>
          )}
          {isToolSchema && m.content_json ? (
            <JsonViewer data={JSON.parse(m.content_json)} />
          ) : m.content_format === 'json' && m.content_json ? (
            <JsonViewer data={JSON.parse(m.content_json)} />
          ) : m.content_format === 'markdown' && m.content_text ? (
            <MarkdownBlock text={m.content_text} />
          ) : (
            <pre className="trace-msg-text">{m.content_text || '(empty)'}</pre>
          )}
        </div>
      </details>
    );
  }

  // assistant group
  const { assistant, tools, budget } = group;
  if (!assistant) return null;

  const hasTools = tools.length > 0;
  const hasReasoning = assistant.reasoning && assistant.reasoning.trim();
  const hasReply = assistant.reply && assistant.reply.trim();
  const hasToolCalls = assistant.tool_calls_json;

  return (
    <details className="trace-msg trace-msg-assistant" open>
      <summary className="trace-msg-summary">
        <span className={`trace-msg-role trace-role-assistant`}>
          assistant
        </span>
        {assistant.source === 'injected' && (
          <span className="trace-msg-source">injected</span>
        )}
        <span className="trace-msg-finish">{assistant.finish_reason || '?'}</span>
        {hasTools && <span className="trace-msg-tool-count">{tools.length} tools</span>}
        {assistant.error && <span className="trace-msg-error-badge">error</span>}
      </summary>
      <div className="trace-msg-body">
        {assistant.error && (
          <div className="trace-msg-error">{assistant.error}</div>
        )}

        {/* reply */}
        {hasReply && (
          <details className="trace-msg-sub" open>
            <summary className="trace-msg-sub-summary">reply</summary>
            <div className="trace-msg-sub-body">
              <MarkdownBlock text={assistant.reply!} />
            </div>
          </details>
        )}

        {/* reasoning */}
        {hasReasoning && (
          <details className="trace-msg-sub">
            <summary className="trace-msg-sub-summary">reasoning</summary>
            <div className="trace-msg-sub-body">
              <pre className="trace-msg-text">{assistant.reasoning}</pre>
            </div>
          </details>
        )}

        {/* tool_calls */}
        {hasToolCalls && (
          <details className="trace-msg-sub" open>
            <summary className="trace-msg-sub-summary">tool_calls</summary>
            <div className="trace-msg-sub-body">
              <JsonViewer data={JSON.parse(assistant.tool_calls_json!)} />
            </div>
          </details>
        )}

        {/* 归属的 tool 结果 */}
        {tools.map((tool, ti) => (
          <details className="trace-msg-sub" key={ti}>
            <summary className="trace-msg-sub-summary">
              <span className="trace-msg-role trace-role-tool">tool: {tool.name}</span>
              {tool.error && <span className="trace-msg-error-badge">error</span>}
            </summary>
            <div className="trace-msg-sub-body">
              {tool.error && (
                <div className="trace-msg-error">{tool.error}</div>
              )}
              {tool.content_format === 'json' && tool.content_text ? (
                <JsonViewerSafe text={tool.content_text} />
              ) : tool.content_format === 'markdown' && tool.content_text ? (
                <MarkdownBlock text={tool.content_text} />
              ) : (
                <pre className="trace-msg-text">{tool.content_text || '(empty)'}</pre>
              )}
            </div>
          </details>
        ))}

        {/* _budget_info */}
        {budget && (
          <details className="trace-msg-sub trace-msg-budget">
            <summary className="trace-msg-sub-summary">
              <span className="trace-msg-source">_budget_info (injected)</span>
            </summary>
            <div className="trace-msg-sub-body">
              <pre className="trace-msg-text">{budget.sent.content_text || '(empty)'}</pre>
            </div>
          </details>
        )}
      </div>
    </details>
  );
}

// ==================================================================
//  MarkdownBlock —— 可切换 raw / rendered 的 Markdown 查看器
// ==================================================================

function MarkdownBlock({ text }: { text: string }) {
  const [showRendered, setShowRendered] = useState(false);
  return (
    <div className="trace-md-block">
      <div className="trace-md-toggle">
        <button
          className={`trace-md-btn ${!showRendered ? 'trace-md-btn-active' : ''}`}
          onClick={() => setShowRendered(false)}
        >
          Raw
        </button>
        <button
          className={`trace-md-btn ${showRendered ? 'trace-md-btn-active' : ''}`}
          onClick={() => setShowRendered(true)}
        >
          Rendered
        </button>
      </div>
      {showRendered ? (
        <div className="trace-md-rendered">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      ) : (
        <pre className="trace-msg-text">{text}</pre>
      )}
    </div>
  );
}

// ==================================================================
//  JsonViewerSafe —— 解析失败时 fallback 到 raw text
// ==================================================================

function JsonViewerSafe({ text }: { text: string }) {
  try {
    const parsed = JSON.parse(text);
    return <JsonViewer data={parsed} />;
  } catch {
    return <pre className="trace-msg-text">{text}</pre>;
  }
}
