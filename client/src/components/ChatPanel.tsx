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
import { parseSSEEvents, type SSEEvent } from '../lib/sse';
import { useSSEEventHandler, type DisplayMessage, type DisplayRole } from '../hooks/useSSEEventHandler';
import { useI18n } from '../i18n/context';
import { getLang } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import type { ChatHistoryEntry, Note, ParsedItem, ProductEntry, ConversationEntry } from '../types';
import { PaletteIcon, TableIcon } from './ChatIcons';
import './ChatPanel.css';

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
  const { handleEvent } = useSSEEventHandler(setDisplayMessages, {
    calling: t('正在调用'),
    sorry: t('抱歉前缀'),
    failed: t('请求失败'),
  });

  // 新消息到达时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayMessages, loading]);

  // 订阅 parseTable 事件，将解析过程展示在对话面板中
  useEffect(() => {
    const store = useTableParseStore.getState();

    const handler = (event: SSEEvent) => {
      handleEvent(event, {
        // 解析流程开始时清空对话历史
        onParseStart() {
          setHistory([]);
        },
        // 解析流程的自定义事件（result 等）
        onCustomEvent(event) {
          if (event.type === 'result') {
            const payload = event.data as { items?: unknown; products?: unknown; history?: unknown };
            if (payload.items) {
              store.replaceItems(payload.items as ParsedItem[]);
            }
            if (payload.products) {
              store.replaceProducts(payload.products as ProductEntry[]);
            }
            if (Array.isArray(payload.history)) {
              setHistory(payload.history as ChatHistoryEntry[]);
            }
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

  // 消费 HistoryPage 填充的对话记录
  const fillConversation = useTableParseStore((s) => s.fillConversation);
  const setFillConversation = useTableParseStore((s) => s.setFillConversation);

  useEffect(() => {
    if (!fillConversation) return;
    // 转为 displayMessages 供 UI 渲染
    setDisplayMessages(
      fillConversation.map((e) => ({
        role: (e.role === 'parse_start' ? 'parse_start' : e.role) as DisplayRole,
        content: e.content,
        ...(e.meta ? { meta: e.meta } : {}),
      })),
    );
    // 转为 history 供 LLM 上下文（仅 user/assistant）
    setHistory(
      fillConversation
        .filter((e) => e.role === 'user' || e.role === 'assistant')
        .map((e) => ({ role: e.role as 'user' | 'assistant', content: e.content })),
    );
    // 消费后清除信号
    setFillConversation(null);
  }, [fillConversation, setFillConversation]);

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
          initialInput: storeState.input,
          colorHints: Array.from(storeState.colorHints),
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
              onCustomEvent(event) {
                if (event.type !== 'result') return;
                const payload = event.data as unknown as SSEResultPayload;

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
