/**
 * ChatPanel —— 对话面板，通过 SSE 流式接入后端 /api/chat。
 *
 * 显示工具调用过程 + 打字机效果的实时回复。
 * 支持多轮对话（最多 8 对），每次请求携带当前已解析清单。
 *
 * useSSEEventHandler hook —— 统一的 SSE 事件处理器。
 *   解析（TableParse）和聊天（/api/chat）共享同一套事件处理逻辑，
 *   通过 perCall 回调注入各自的业务差异（store 更新、notes 合并等）。
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTableParseStore } from '../stores/tableParseStore';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { useI18n } from '../i18n/context';
import { getLang } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import type { ChatHistoryEntry, Note, ParsedItem, ProductEntry, ConversationEntry } from '../types';
import { PaletteIcon, TableIcon } from './ChatIcons';
import './ChatPanel.css';

// ==================================================================
// #region Types
// ==================================================================

type DisplayRole = 'user' | 'assistant' | 'tool' | 'streaming' | 'parse_start';

interface DisplayMessage {
  role: DisplayRole;
  content: string;
  /** parse_start 等特殊消息的结构化元数据，渲染时通过 JSX 读取（天然跟随 i18n 切换） */
  meta?: {
    lineCount?: number;
    colorCodes?: string[];
  };
}

// ==================================================================
// #region SSE result payload (from server)
// ==================================================================

interface SSEResultPayload {
  items?: ParsedItem[];
  products?: ProductEntry[];
  history: ChatHistoryEntry[];
  notes?: Note[];
}

// ==================================================================
// #region SSE parser
// ==================================================================

function parseSSEEvents(buffer: string): { events: Array<{ type: string; data: Record<string, unknown> }>; remaining: string } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let remaining = buffer;

  while (true) {
    const idx = remaining.indexOf('\n\n');
    if (idx === -1) break;

    const raw = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 2);

    const match = raw.match(/^event: (.+)\ndata: (.+)$/s);
    if (!match) continue;

    try {
      const data = JSON.parse(match[2].trim());
      events.push({ type: match[1].trim(), data });
    } catch {
      // ignore malformed JSON
    }
  }

  return { events, remaining };
}

// ==================================================================
// #region SSE event handler hook —— 解析 & 聊天共享
// ==================================================================

/** 每个单独 SSE 流的业务差异回调 */
interface PerCallCallbacks {
  onResult?: (data: Record<string, unknown>) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

function useSSEEventHandler(
  setDisplayMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
  setHistory: React.Dispatch<React.SetStateAction<ChatHistoryEntry[]>>,
  convRef?: React.MutableRefObject<ConversationEntry[]>,
) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t; // 始终保持最新 t 引用，避免 handleEvent 依赖闭包过期

  // 以下三个 ref 是 SSE 流处理期间的局部可变状态 —— 解析和聊天各有自己的流，互不干扰
  const streamingIndexRef = useRef(-1);
  const lastToolNameRef = useRef('');
  const toolDotCountRef = useRef(0);

  const handleEvent = useCallback((
    event: { type: string; data: Record<string, unknown> },
    perCall?: PerCallCallbacks,
  ) => {
    const _t = tRef.current;

    switch (event.type) {

      case 'parse_start': {
        // 每次点击"解析清单"代表新的解析过程，清空旧的对话记录
        setDisplayMessages([]);
        setHistory([]);

        // 以结构化 meta 存储原始数据，JSX 渲染时调用 t() → 语言切换后自动更新
        const d = event.data as { lineCount: number; colorHintCodes?: string[] };
        setDisplayMessages((prev) => [
          ...prev,
          {
            role: 'parse_start',
            content: '',
            meta: {
              lineCount: d.lineCount || 0,
              colorCodes: d.colorHintCodes?.length ? d.colorHintCodes : undefined,
            },
          },
        ]);
        break;
      }

      case 'tool_call': {
        // 新 tool_call 覆盖上一条 tool 消息（不追加），只展示最新被调用的工具
        // 同一工具连续调用时累加点号（. .. ...），产生动态效果
        const toolName = (event.data as { tool: string }).tool || '';
        if (toolName === lastToolNameRef.current) {
          toolDotCountRef.current++;
        } else {
          lastToolNameRef.current = toolName;
          toolDotCountRef.current = 0;
        }
        const dots = '.'.repeat(toolDotCountRef.current);
        setDisplayMessages((prev) => {
          if (prev.length > 0 && prev[prev.length - 1].role === 'tool') {
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, content: `${_t('正在调用')} ${toolName}${dots}` }];
          }
          return [...prev, { role: 'tool', content: `${_t('正在调用')} ${toolName}${dots}` }];
        });
        break;
      }

      case 'reply_chunk': {
        // LLM 流式文本：维持一条 streaming 消息不断追加文本（打字机效果）
        const text = (event.data as { text: string }).text || '';
        setDisplayMessages((prev) => {
          if (
            streamingIndexRef.current >= 0 &&
            streamingIndexRef.current < prev.length &&
            prev[streamingIndexRef.current].role === 'streaming'
          ) {
            // 追加到已有的 streaming 消息
            const updated = [...prev];
            updated[streamingIndexRef.current] = {
              role: 'streaming',
              content: updated[streamingIndexRef.current].content + text,
            };
            return updated;
          }
          // 新建 streaming 消息（首次 chunk 或上一条 streaming 已被 round_start 清除）
          streamingIndexRef.current = prev.length;
          return [...prev, { role: 'streaming', content: text }];
        });
        break;
      }

      case 'reply_done': {
        // LLM 流式文本推送完毕，将 streaming → assistant 完成转换
        setDisplayMessages((prev) => {
          if (
            streamingIndexRef.current >= 0 &&
            streamingIndexRef.current < prev.length &&
            prev[streamingIndexRef.current].role === 'streaming'
          ) {
            const updated = [...prev];
            updated[streamingIndexRef.current] = {
              role: 'assistant',
              content: updated[streamingIndexRef.current].content,
            };
            return updated;
          }
          return prev;
        });
        streamingIndexRef.current = -1;
        break;
      }

      case 'round_start': {
        // 非首轮时清空上一轮的 streaming 暂存，让下个 reply_chunk 创建新消息
        // 效果：中间轮次的过渡回复被覆盖，最终只保留最后一轮的回复
        const round = (event.data as { round: number }).round || 0;
        if (round > 1) {
          streamingIndexRef.current = -1;
          setDisplayMessages((prev) => prev.filter((m) => m.role !== 'streaming'));
        }
        break;
      }

      case 'result': {
        // 业务差异完全由调用方处理（store 更新、notes 合并等）
        perCall?.onResult?.(event.data);
        break;
      }

      case 'done': {
        // 防御：若 reply_done 未成功将 streaming 转为 assistant，此处兜底转换后再过滤
        setDisplayMessages((prev) => {
          const fixed = prev.map((m) =>
            m.role === 'streaming' ? { ...m, role: 'assistant' as DisplayRole } : m,
          );
          const filtered = fixed.filter((m) =>
            m.role === 'user' || m.role === 'assistant' || m.role === 'parse_start',
          );
          // 同步更新 convRef，供 store.saveToHistory 读取最新对话
          if (convRef) {
            convRef.current = filtered.map((m) => ({
              role: m.role === 'parse_start' ? 'parse_start' : (m.role as 'user' | 'assistant'),
              content: m.content,
              ...(m.meta ? { meta: m.meta } : {}),
            }));
          }
          return filtered;
        });
        perCall?.onDone?.();
        break;
      }

      case 'error': {
        const errMsg = String((event.data as { message?: string }).message || _t('请求失败'));
        setDisplayMessages((prev) => {
          const clean = prev.filter((m) => m.role !== 'tool' && m.role !== 'streaming');
          return [...clean, { role: 'assistant', content: `${_t('抱歉前缀')}${errMsg}` }];
        });
        perCall?.onError?.(errMsg);
        break;
      }
    }
  }, [setDisplayMessages, setHistory]); // 这两个 setter 是 useState 返回的稳定引用

  return { handleEvent };
}

// ==================================================================
// #region Component
// ==================================================================

/** 对话框空态随机切换的示例提示 key 列表 */
const EXAMPLE_KEYS: TranslationKey[] = [
  '对话框示例_color',
  '对话框示例_qty',
  '对话框示例_size',
  '对话框示例_add',
  '对话框示例_delete',
  '对话框示例_door',
  '对话框示例_export',
  '对话框示例_sku',
  '对话框示例_correct',
];

export default function ChatPanel() {
  const { t } = useI18n();

  /** 当前显示的随机示例提示 key */
  const [placeholderKey, setPlaceholderKey] = useState<TranslationKey>(() =>
    EXAMPLE_KEYS[Math.floor(Math.random() * EXAMPLE_KEYS.length)],
  );

  /** 每 10 秒随机切换一次空态提示 */
  useEffect(() => {
    const timer = setInterval(() => {
      setPlaceholderKey(
        EXAMPLE_KEYS[Math.floor(Math.random() * EXAMPLE_KEYS.length)],
      );
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [history, setHistory] = useState<ChatHistoryEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  /** 供 store.saveToHistory 读取的最新对话消息快照 */
  const convRef = useRef<ConversationEntry[]>([]);
  /** 本轮聊天 SSE 流是否触发了数据变更（items/products 被修改） */
  const dataChangeRef = useRef(false);

  const [showNotes, setShowNotes] = useState(false);

  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const stored = localStorage.getItem('duko_notes');
      return stored ? (JSON.parse(stored) as Note[]) : [];
    } catch {
      return [];
    }
  });

  const [newNoteName, setNewNoteName] = useState('');
  const [newNoteContent, setNewNoteContent] = useState('');

  const notesIdRef = useRef(
    (() => {
      try {
        const stored = localStorage.getItem('duko_notes');
        if (!stored) return 1;
        const arr: Note[] = JSON.parse(stored);
        return arr.length > 0 ? Math.max(...arr.map((n) => n.id)) + 1 : 1;
      } catch {
        return 1;
      }
    })(),
  );

  // 笔记双写：localStorage + 服务端
  useEffect(() => {
    localStorage.setItem('duko_notes', JSON.stringify(notes));
    // fire-and-forget 同步到服务端
    fetchWithAuth('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: notes.map((n) => ({ originalName: n.originalName, content: n.content })),
      }),
    }).catch(() => {
      /* 静默失败，localStorage 已有副本 */
    });
  }, [notes]);

  // 统一的 SSE 事件处理器（解析 & 聊天共享）
  const { handleEvent } = useSSEEventHandler(setDisplayMessages, setHistory, convRef);

  // 新消息到达时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayMessages, loading]);

  // 订阅 parseTable 事件，将解析过程展示在对话面板中
  useEffect(() => {
    const store = useTableParseStore.getState();

    const handler = (event: { type: string; data: Record<string, unknown> }) => {
      handleEvent(event, {
        // 解析流程的 result：更新 store 中的 items / products / history
        onResult(data) {
          const payload = data as { items?: unknown; products?: unknown; history?: unknown };
          if (payload.items) {
            store.replaceItems(payload.items as ParsedItem[]);
          }
          if (payload.products) {
            store.replaceProducts(payload.products as ProductEntry[]);
          }
          if (Array.isArray(payload.history)) {
            setHistory(payload.history as ChatHistoryEntry[]);
          }
        },
        // 解析流程的 done：重置 loading 状态（此时 loading 通常是 false，作为安全复位）
        onDone() {
          setLoading(false);
        },
        // 解析流程的 error：重置 loading 状态
        onError() {
          setLoading(false);
        },
      });
    };

    store.setParseEventCallback(handler);
    return () => {
      store.setParseEventCallback(null);
    };
  }, [handleEvent]);

  // 注册 convRef 到 store，供 auto-save 读取
  useEffect(() => {
    const store = useTableParseStore.getState();
    store.setChatMessagesRef(convRef);
    return () => {
      store.setChatMessagesRef(null);
    };
  }, []);

  // 从服务端加载笔记（双写策略：localStorage 为即时缓存，服务端为准）
  useEffect(() => {
    const loadNotesFromServer = async () => {
      try {
        const res = await fetchWithAuth('/api/notes');
        if (!res.ok) return;
        const serverNotes: { id: number; originalName: string; content: string }[] = await res.json();
        if (serverNotes.length > 0) {
          const mapped: Note[] = serverNotes.map((n) => ({
            id: n.id,
            originalName: n.originalName,
            content: n.content,
          }));
          setNotes(mapped);
          localStorage.setItem('duko_notes', JSON.stringify(mapped));
          // 同步 notesIdRef 避免 ID 冲突
          notesIdRef.current = Math.max(...mapped.map((n) => n.id), 0) + 1;
        }
      } catch {
        /* 静默失败，回退到 localStorage 中的数据 */
      }
    };
    loadNotesFromServer();
  }, []);
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    setInput('');
    setLoading(true);

    // Abort any in-progress request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const abort = new AbortController();
    abortRef.current = abort;

    // 关闭笔记面板，关注对话区
    setShowNotes(false);

    // 重置本轮数据变更标记
    dataChangeRef.current = false;

    // 立即在 UI 中展示用户消息
    setDisplayMessages((prev) => [...prev, { role: 'user', content: msg }]);

    // 获取当前 store 中的清单和对话历史
    const storeState = useTableParseStore.getState();
    const items = storeState.items.length > 0 ? storeState.items : undefined;
    const products = storeState.products.length > 0 ? storeState.products : undefined;

    try {
      const res = await fetchWithAuth('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: msg,
          items,
          products,
          history,
          notes,
          lang: getLang(),
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: t('请求失败') }));
        throw new Error(errBody.error || t('请求失败'));
      }

      // Read SSE stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const readLoop = async () => {
        while (true) {
          if (abort.signal.aborted) return;

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const { events, remaining } = parseSSEEvents(buffer);
          buffer = remaining;

          for (const event of events) {
            handleEvent(event, {
              // 聊天流程的 result：更新 store 数据 + notes + history
              onResult(data) {
                const payload = data as unknown as SSEResultPayload;

                if (payload.items || payload.products) {
                  dataChangeRef.current = true;
                }

                if (payload.items) {
                  storeState.replaceItems(payload.items);
                }
                if (payload.products) {
                  storeState.replaceProducts(payload.products);
                }
                if (payload.notes && payload.notes.length > 0) {
                  setNotes((prevNotes) => {
                    const existing = new Set(prevNotes.map((n) => `${n.originalName}|${n.content}`));
                    const merged = [...prevNotes];
                    for (const incoming of payload.notes!) {
                      const key = `${incoming.originalName}|${incoming.content}`;
                      if (!existing.has(key)) {
                        existing.add(key);
                        merged.push({
                          id: notesIdRef.current++,
                          originalName: incoming.originalName,
                          content: incoming.content,
                        });
                      }
                    }
                    return merged;
                  });
                }

                setHistory(payload.history);
              },
              // 聊天流程的 done：若本轮有数据变更则自动保存历史记录
              onDone() {
                if (dataChangeRef.current) {
                  const store = useTableParseStore.getState();
                  store.saveToHistory();
                }
              },
            });
          }
        }
      };

      await readLoop();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const errorMsg = err instanceof Error ? err.message : t('网络错误');
      setDisplayMessages((prev) => {
        const withoutTool = prev.filter((m) => m.role !== 'tool' && m.role !== 'streaming');
        return [...withoutTool, { role: 'assistant', content: `${t('抱歉前缀')}${errorMsg}` }];
      });
      console.error('Chat error:', err);
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [input, loading, history, notes, t, handleEvent]);

  const hasMessages = displayMessages.length > 0;

  const handleAddNote = () => {
    const name = newNoteName.trim();
    const content = newNoteContent.trim();
    if (!name || !content) return;
    setNotes((prev) => [
      ...prev,
      { id: notesIdRef.current++, originalName: name, content },
    ]);
    setNewNoteName('');
    setNewNoteContent('');
  };

  const handleDeleteNote = (id: number) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div className={`tp-chat-panel${showNotes ? ' tp-has-notes' : ''}`}>
      <div className="tp-chat-header">
        <span>{t('对话')}</span>
      </div>

      <div className="tp-chat-messages">
        {!hasMessages && !loading && (
          <div className="tp-chat-empty">{t(placeholderKey)}</div>
        )}
        {displayMessages.map((m, i) => (
          <div key={i} className={`tp-chat-msg tp-chat-msg-${m.role}`}>
            <div className="tp-chat-msg-role">
              {m.role === 'user' || m.role === 'parse_start'
                ? t('你')
                : m.role === 'tool'
                  ? t('工具')
                  : t('助手')}
            </div>
            {m.role === 'parse_start' ? (
              <div className="tp-chat-msg-content tp-chat-parse-start">
                <ul className="tp-parse-start-list">
                  {m.meta?.colorCodes && m.meta.colorCodes.length > 0 && (
                    <li>
                      <PaletteIcon />
                      <strong>{t('颜色')}</strong>
                      <span className="tp-parse-start-sep">:</span>
                      {m.meta.colorCodes.map((code) => (
                        <code key={code} className="tp-parse-start-code">{code}</code>
                      ))}
                    </li>
                  )}
                  <li>
                    <TableIcon />
                    <strong>{t('行数标签')}</strong>
                    <span className="tp-parse-start-sep">:</span>
                    <span>{t('行数', { n: m.meta?.lineCount ?? 0 })}</span>
                  </li>
                </ul>
              </div>
            ) : m.role === 'assistant' || m.role === 'streaming' ? (
              <div className="tp-chat-msg-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {m.content}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="tp-chat-msg-content">{m.content}</div>
            )}
          </div>
        ))}
        {loading && displayMessages.length > 0 && displayMessages[displayMessages.length - 1].role === 'user' && (
          <div className="tp-chat-msg tp-chat-msg-assistant">
            <div className="tp-chat-msg-role">{t('助手')}</div>
            <div className="tp-chat-msg-content tp-chat-loading">
              <span className="tp-chat-spinner" />
              <span>{t('思考中')}</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="tp-chat-input-row">
        <textarea
          className="tp-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={t('对话输入提示')}
          rows={2}
          disabled={loading}
        />
        <button
          className="tp-chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || loading}
        >
          {t('发送')}
        </button>
      </div>

      {/* 笔记面板 —— 从底部向上展开 */}
      <div className={`tp-notes-panel${showNotes ? ' tp-notes-open' : ''}`}>
        <div className="tp-notes-header">{t('笔记')}</div>
        <div className="tp-notes-list">
          {notes.map((n) => (
            <div key={n.id} className="tp-note-row">
              <span className="tp-note-name">{n.originalName}</span>
              <span className="tp-note-content">{n.content}</span>
              <button
                className="tp-note-del"
                onClick={() => handleDeleteNote(n.id)}
                title={t('删除此行')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="tp-notes-add">
          <input
            className="tp-note-add-name"
            value={newNoteName}
            onChange={(e) => setNewNoteName(e.target.value)}
            placeholder={t('原始名称')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddNote();
              }
            }}
          />
          <input
            className="tp-note-add-content"
            value={newNoteContent}
            onChange={(e) => setNewNoteContent(e.target.value)}
            placeholder={t('笔记内容')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddNote();
              }
            }}
          />
          <button
            className="tp-note-add-btn"
            onClick={handleAddNote}
            disabled={!newNoteName.trim() || !newNoteContent.trim()}
          >
            +
          </button>
        </div>
      </div>

      {/* 笔记切换按钮 —— 固定在输入栏下方一行 */}
      <div className="tp-notes-toggle-row">
        <button
          className={`tp-notes-toggle${showNotes ? ' tp-notes-active' : ''}`}
          onClick={() => setShowNotes(!showNotes)}
        >
          {t('笔记')} {showNotes ? '▲' : '▼'}
        </button>
      </div>
    </div>
  );
}
