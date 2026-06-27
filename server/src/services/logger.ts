/**
 * 对话日志写入器 —— 将完整消息历史写入 Markdown 文件。
 *
 * 用于开发调试：每次 /api/chat 请求完成后，将 messages 数组
 * 按角色以二级章节（##）组织，思索/回复以三级章节（###）细分，
 * 工具调用以 JSON 代码围栏展示，工具结果若为 JSON 则围栏展示、否则以纯文本输出。
 *
 * 文件名格式：YYYY-MM-DD_HH-mm-ss.md（冒号在 Windows 不合法，用下划线替代）
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { LlmMessage } from '../types/message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../log');

/** 确保日志目录存在（首次调用时自动创建） */
function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/** 生成时间戳文件名，如 2026-06-10_14-30-05.md */
function timestampName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${date}_${time}.md`;
}

/** 格式化 JSON 为缩进 2 空格的可读字符串，失败则返回原始文本 */
function formatJson(raw: string | null): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** 检测文本中是否有行首井号（即包含 markdown 标题语法），/m 标志让 ^ 匹配每一行的开头 */
function hasMarkdownHeading(text: string): boolean {
  return /^#/m.test(text);
}

/** 若文本含 markdown 标题则用 ```md 代码围栏包裹，避免消息内部的 markdown 层级污染外部日志结构 */
function appendContent(lines: string[], text: string): void {
  if (hasMarkdownHeading(text)) {
    lines.push('```md');
    lines.push(text);
    lines.push('```');
  } else {
    lines.push(text);
  }
}

/**
 * 将单条消息写入写入流。
 *
 * 格式规则：
 *  - 每类消息以 ## {role} message 开头
 *  - tool 消息标题附加函数名：## tool message (searchSku)
 *  - assistant 的 reasoning 用 ### reasoning
 *  - assistant 的 tool_calls 用 ### tool_call 并以 ```json 围栏展示
 *  - assistant 的 content 用 ### reply
 *  - tool 的 content 若为 JSON 以 ```json 围栏展示，否则直接输出纯文本
 *  - system / user 的 content 直接以纯文本输出
 */
function appendMessage(lines: string[], msg: LlmMessage, index: number): void {
  // 角色标题
  if (msg.role === 'tool' && msg.name) {
    lines.push(`## ${index}. ${msg.role} message (${msg.name})`);
  } else {
    lines.push(`## ${index}. ${msg.role} message`);
  }
  lines.push('');

  // 多模态消息：提取文本内容并标注图片
  const contentText = ((): string => {
    const c = msg.content;
    if (typeof c === 'string' || c === null) return c || '';
    // c 是 MultimodalContent 数组：提取 text 块并标注 image_url 块
    const parts: string[] = [];
    for (const block of c) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'image_url') {
        parts.push(`[image: ${block.image_url.url.slice(0, 60)}...]`);
      }
    }
    return parts.join('\n') || '';
  })();

  switch (msg.role) {
    case 'system':
    case 'user':
      if (contentText) {
        appendContent(lines, contentText); // 有 markdown 标题时自动包裹 ```md 围栏
      }
      break;

    case 'assistant': {
      if (msg.finish_reason) {
        lines.push(`> finish_reason: ${msg.finish_reason}`);
        lines.push('');
      }

      if (contentText && contentText.trim()) {
        lines.push('### reply');
        lines.push('');
        appendContent(lines, contentText.trim()); // 有 markdown 标题时自动包裹 ```md 围栏
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        lines.push('### tool_call');
        lines.push('');
        lines.push('```json');
        lines.push(formatJson(JSON.stringify(
          msg.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: (() => {
              try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; }
            })(),
          })),
        )));
        lines.push('```');
        lines.push('');
      }

      if (msg.reasoning_content && msg.reasoning_content.trim()) {
        lines.push('### reasoning');
        lines.push('');
        lines.push(msg.reasoning_content.trim());
        lines.push('');
      }

      break;
    }

    case 'tool':
      if (msg.tool_call_id) {
        lines.push(`> tool_call_id: ${msg.tool_call_id}`);
        lines.push('');
      }
      if (contentText) {
        const isJson = (() => {
          try { JSON.parse(contentText); return true; } catch { return false; }
        })();
        if (isJson) {
          lines.push('```json');
          lines.push(formatJson(contentText));
          lines.push('```');
        } else {
          appendContent(lines, contentText); // 有 markdown 标题时自动包裹 ```md 围栏
        }
      }
      break;
  }

  lines.push('');
}

/**
 * 将完整对话历史写入 MD 日志文件。
 *
 * @param messages - 对话消息数组
 * @returns 写入的文件绝对路径
 */
export function writeChatLog(messages: LlmMessage[]): string {
  ensureLogDir();

  const lines: string[] = [];
  let index = 0;
  for (const msg of messages) {
    appendMessage(lines, msg, ++index);
  }

  const filePath = path.join(LOG_DIR, timestampName());
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  console.log(`Chat log saved: ${filePath}`);
  return filePath;
}
