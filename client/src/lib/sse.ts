/**
 * 通用 SSE (Server-Sent Events) 解析工具
 *
 * 从 ChatPanel 提取，供 ImageUploadPanel / ChatPanel / LayoutChatPanel 共用。
 * 后端通过 SSEConnection 发送的格式为：
 *
 *   event: <type>\ndata: <JSON>\n\n
 */

/** 单条 SSE 事件的标准化表示 */
export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * 从 SSE 文本缓冲区中逐条解析事件。
 * 返回已解析的事件列表和未消费的剩余文本。
 */
export function parseSSEEvents(buffer: string): {
  events: SSEEvent[];
  remaining: string;
} {
  const events: SSEEvent[] = [];
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
      // 忽略格式错误的 JSON
    }
  }

  return { events, remaining };
}
