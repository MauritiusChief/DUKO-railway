/**
 * 预算注入工具 —— 虚拟 _budget_info tool pair
 *
 * 在每轮工具调用完成后，向 LLM 注入剩余搜索预算信息。
 * 采用虚拟 tool call + tool result 对的方式，让 LLM 感知预算状态
 * 而不需要在实际工具 schema 中注册。
 *
 * 使用方式：
 *   injectBudgetInfo(messages, round, remaining, total, langHint);
 *
 * 会向 messages 数组 push 一个 assistant（虚拟 tool_calls）+ tool 消息对。
 */

import type { ChatMessage, MultimodalChatMessage } from '../types/message.js';

/**
 * 向对话消息队列注入 _budget_info 虚拟工具对。
 *
 * @param messages         - 消息数组（原地追加）
 * @param round            - 当前轮次（用于生成唯一 call id）
 * @param remaining        - 剩余搜索次数
 * @param total            - 总搜索次数
 * @param langHint         - 语言提示（'中文' | '英文'）
 * @param extraNote        - 额外提示信息（如"可随意使用清单编辑工具"）
 * @param budgetedToolList - 受限制的工具名列表文字，预算耗尽时用此覆写默认提示
 */
export function injectBudgetInfo(
  messages: (ChatMessage | MultimodalChatMessage)[],
  round: number,
  remaining: number,
  total: number,
  langHint: string,
  extraNote?: string,
  budgetedToolList?: string,
): void {
  const forbiddenTools = budgetedToolList || '【出错：未获取到工具名单】';
  const budgetMessage =
    remaining > 0
      ? `搜索预算：${remaining}/${total} 次剩余。请据此规划搜索查询。${extraNote || ''}用户使用${langHint}，请据此回复。`
      : `搜索预算已用尽。你不得再调用 ${forbiddenTools}。${extraNote || ''}请基于已收集信息给出最终回答。使用${langHint}回复。`;

  const budgetCallId = `_budget_info_${round}`;

  messages.push({
    role: 'assistant',
    content: '',
    reasoning_content: '',
    tool_calls: [
      {
        id: budgetCallId,
        type: 'function',
        function: {
          name: '_budget_info',
          arguments: '{}',
        },
      },
    ],
  } as ChatMessage | MultimodalChatMessage);

  messages.push({
    role: 'tool',
    tool_call_id: budgetCallId,
    name: '_budget_info',
    content: budgetMessage,
  } as ChatMessage | MultimodalChatMessage);
}
