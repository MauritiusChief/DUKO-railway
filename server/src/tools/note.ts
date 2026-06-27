/**
 * 笔记工具 —— recordNote
 *
 * 提供 function calling 工具 recordNote：
 *  当用户指正产品/型号的正确名称时，记录映射关系。
 *  笔记会在后续对话中自动注入供参考。
 */

import type { ToolDefinition } from '../types/tool.js';
import type { NoteAccumulator } from '../types/manifest.js';

export const RECORD_NOTE_TOOL = {
  type: 'function',
  function: {
    name: 'recordNote',
    description:
      '当用户指出某个产品/型号的实际正确名称或型号时，将这一映射关系记录为笔记。笔记会在后续的清单解析和对话中自动作为参考知识注入，帮助提升解析准确率。调用时机：用户说类似 "XX其实是YY"、"XX的正确型号是YY"、"XX应该对应YY" 等信息时。',
    parameters: {
      type: 'object',
      properties: {
        originalName: {
          type: 'string',
          description: '原始名称（用户提到的模糊/错误/无法识别的名称或型号）',
        },
        content: {
          type: 'string',
          description: '笔记内容（记录正确的型号、说明、备注等信息）',
        },
      },
      required: ['originalName', 'content'],
    },
  },
} as const satisfies ToolDefinition;

export function executeRecordNote(acc: NoteAccumulator, args: Record<string, unknown>): string {
  const originalName = String(args.originalName ?? '').trim();
  const content = String(args.content ?? '').trim();

  if (!originalName || !content) {
    return '## recordNote 结果\n\n**错误**: `originalName` 和 `content` 均为必填项。请提供原始名称和笔记内容。';
  }

  acc.notes.push({ originalName, content });

  return `## recordNote 结果

已记录笔记：
- **原始名称**: ${originalName}
- **内容**: ${content}`;
}
