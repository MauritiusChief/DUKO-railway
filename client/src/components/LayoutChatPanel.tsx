/**
 * LayoutChatPanel —— 布局 AI 对话面板
 *
 * 订阅 layoutStore 的 recognitionEventCallback，展示布局识别过程中的
 * 工具调用、流式回复和布局更新事件。
 * 复用 ChatPanel.css 中的对话消息样式和 useSSEEventHandler hook。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLayoutStore } from '../stores/layoutStore';
import { useI18n } from '../i18n/context';
import { useSSEEventHandler, type DisplayMessage } from '../hooks/useSSEEventHandler';
import type { SSEEvent } from '../lib/sse';
import './LayoutChatPanel.css';

// ==================================================================
// #region Component
// ==================================================================

export function LayoutChatPanel() {
  const { t } = useI18n();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { handleEvent } = useSSEEventHandler(setMessages, {
    calling: t('正在调用'),
    sorry: t('抱歉前缀'),
    failed: t('请求失败'),
  });

  // 处理 layout 特有的 SSE 事件
  const handleLayoutEvent = useCallback((event: SSEEvent) => {
    // reply_done → 已有通用处理
    // layout_update / result → 自定义处理
    if (event.type === 'layout_update') {
      const data = event.data as { message?: string };
      if (data.message) {
        setMessages((prev) => {
          const clean = prev.filter((m) => m.role !== 'streaming');
          return [...clean, { role: 'assistant' as const, content: data.message! }];
        });
      }
    } else if (event.type === 'result') {
      const data = event.data as { reply?: string };
      if (data.reply) {
        setMessages((prev) => {
          const clean = prev.filter((m) => m.role !== 'streaming');
          return [...clean, { role: 'assistant' as const, content: data.reply! }];
        });
      }
    }
  }, []);

  // 用 ref 持有最新的 handler，避免 useLayoutStore 订阅循环
  const handlerRef = useRef<(event: SSEEvent) => void>(() => {});
  handlerRef.current = (event: SSEEvent) => {
    handleEvent(event, { onCustomEvent: handleLayoutEvent });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 注册 SSE 事件回调（仅挂载/卸载一次）
  useEffect(() => {
    const cb = (event: SSEEvent) => handlerRef.current(event);
    useLayoutStore.getState().setRecognitionEventCallback(cb);
    return () => {
      useLayoutStore.getState().setRecognitionEventCallback(null);
    };
  }, []);

  const hasMessages = messages.length > 0;

  return (
    <div className="lc-panel">
      <div className="lc-panel-header">{t('对话')}</div>

      <div className="lc-panel-messages">
        {!hasMessages && (
          <div className="lc-panel-empty">{t('布局识别对话提示')}</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`tp-chat-msg tp-chat-msg-${m.role}`}>
            <div className="tp-chat-msg-role">
              {m.role === 'user'
                ? t('你')
                : m.role === 'tool'
                  ? t('工具')
                  : t('助手')}
            </div>
            {m.role === 'assistant' || m.role === 'streaming' ? (
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
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
