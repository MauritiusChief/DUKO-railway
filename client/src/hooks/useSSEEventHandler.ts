/**
 * useSSEEventHandler —— 通用 SSE 事件处理 hook
 *
 * 处理 round_start / tool_call / reply_chunk / done / error 等通用 SSE 事件，
 * 维护对话消息列表和 streaming 状态。
 * 通过 perCall 回调注入业务差异（如 store 更新、layout 推送等）。
 *
 * ChatPanel 和 LayoutChatPanel 共享此 hook。
 */
import { useRef, useCallback } from 'react';
import type { SSEEvent } from '../lib/sse';

// ==================================================================
// #region Types
// ==================================================================

export type DisplayRole = 'user' | 'assistant' | 'tool' | 'streaming' | 'parse_start';

export interface DisplayMessage {
  role: DisplayRole;
  content: string;
  /** parse_start 等特殊消息的结构化元数据 */
  meta?: {
    lineCount?: number;
    colorCodes?: string[];
  };
}

export interface PerCallCallbacks {
  /** parse_start 事件回调（清空历史等业务逻辑） */
  onParseStart?: () => void;
  /** 自定义事件处理（业务特有事件如 result / layout_update） */
  onCustomEvent?: (event: SSEEvent, helpers: {
    setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>;
    streamingIndexRef: React.MutableRefObject<number>;
  }) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/** i18n 翻译函数的最小接口 */
export interface SSEHandlerTranslations {
  calling: string;
  sorry: string;
  failed: string;
}

// ==================================================================
// #region Hook
// ==================================================================

export function useSSEEventHandler(
  setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
  t: SSEHandlerTranslations,
) {
  const streamingIndexRef = useRef(-1);
  const lastToolNameRef = useRef('');
  const toolDotCountRef = useRef(0);

  // 用 ref 持有翻译，避免 t 对象每次渲染变化导致 handleEvent 引用变化
  const tRef = useRef(t);
  tRef.current = t;

  const handleEvent = useCallback((
    event: SSEEvent,
    perCall?: PerCallCallbacks,
  ) => {
    const _t = tRef.current;

    switch (event.type) {

      case 'parse_start': {
        // 每次新解析过程清空旧记录
        setMessages([]);
        perCall?.onParseStart?.();
        const d = event.data as { lineCount: number; colorHintCodes?: string[] };
        setMessages((prev) => [
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
        const toolName = (event.data as { tool: string }).tool || '';
        if (toolName === lastToolNameRef.current) {
          toolDotCountRef.current++;
        } else {
          lastToolNameRef.current = toolName;
          toolDotCountRef.current = 0;
        }
        const dots = '.'.repeat(toolDotCountRef.current % 4);
        setMessages((prev) => {
          const toolMsg = `${_t.calling} ${toolName}${dots}`;
          if (prev.length > 0 && prev[prev.length - 1].role === 'tool') {
            return [...prev.slice(0, -1), { role: 'tool' as const, content: toolMsg }];
          }
          return [...prev, { role: 'tool' as const, content: toolMsg }];
        });
        break;
      }

      case 'reply_chunk': {
        const text = (event.data as { text: string }).text || '';
        setMessages((prev) => {
          if (
            streamingIndexRef.current >= 0 &&
            streamingIndexRef.current < prev.length &&
            prev[streamingIndexRef.current].role === 'streaming'
          ) {
            const updated = [...prev];
            updated[streamingIndexRef.current] = {
              role: 'streaming' as const,
              content: updated[streamingIndexRef.current].content + text,
            };
            return updated;
          }
          streamingIndexRef.current = prev.length;
          return [...prev, { role: 'streaming' as const, content: text }];
        });
        break;
      }

      case 'reply_done': {
        setMessages((prev) => {
          if (
            streamingIndexRef.current >= 0 &&
            streamingIndexRef.current < prev.length &&
            prev[streamingIndexRef.current].role === 'streaming'
          ) {
            const updated = [...prev];
            updated[streamingIndexRef.current] = {
              role: 'assistant' as const,
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
        const round = (event.data as { round: number }).round || 0;
        if (round > 1) {
          streamingIndexRef.current = -1;
          setMessages((prev) => prev.filter((m) => m.role !== 'streaming'));
        }
        break;
      }

      case 'done': {
        setMessages((prev) => {
          const fixed = prev.map((m) =>
            m.role === 'streaming' ? { ...m, role: 'assistant' as const } : m,
          );
          return fixed.filter((m) =>
            m.role === 'user' || m.role === 'assistant' || m.role === 'parse_start',
          );
        });
        perCall?.onDone?.();
        break;
      }

      case 'error': {
        const errMsg = String((event.data as { message?: string }).message || _t.failed);
        setMessages((prev) => {
          const clean = prev.filter((m) => m.role !== 'tool' && m.role !== 'streaming');
          return [...clean, { role: 'assistant' as const, content: `${_t.sorry}${errMsg}` }];
        });
        perCall?.onError?.(errMsg);
        break;
      }

      default: {
        // 业务特有事件交给 perCall 处理
        perCall?.onCustomEvent?.(event, { setMessages, streamingIndexRef });
        break;
      }
    }
  }, [setMessages]); // setMessages 是 useState 稳定引用

  return { handleEvent, streamingIndexRef };
}
