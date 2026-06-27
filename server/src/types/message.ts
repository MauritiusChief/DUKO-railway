/**
 * 统一消息类型 —— 覆盖纯文本对话与多模态对话场景
 *
 * ChatMessage      —— 纯文本 LLM 对话消息（DeepSeek）
 * MultimodalContent  —— 多模态消息的 content 联合类型
 * MultimodalChatMessage —— 多模态 LLM 对话消息（OpenRouter）
 */

import type { ToolCall } from './tool.js';

// ==================================================================
//  ChatMessage —— 纯文本（DeepSeek）
// ==================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** API 返回的停止原因：stop | tool_calls | length | content_filter */
  finish_reason?: string;
  /** 思索过程文本（thinking 启用时返回） */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ==================================================================
//  MultimodalChatMessage —— 多模态（OpenRouter）
// ==================================================================

export type MultimodalContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
    >;

export interface MultimodalChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | MultimodalContent;
  finish_reason?: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ==================================================================
//  LLM 消息联合类型
// ==================================================================

export type LlmMessage = ChatMessage | MultimodalChatMessage;
