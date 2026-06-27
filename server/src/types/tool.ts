/**
 * 通用工具类型 —— 跨 LLM provider 统一的 ToolDefinition 与 ToolCall
 *
 * 当前 deepseek.ts 与 openrouter.ts 各自定义了语义相同的类型。
 * 本文件为 canonical 定义，两者后续统一引用自此。
 */

import { ToolName } from "../tools";

/** 向 LLM 注册的工具定义（OpenAI function calling schema） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM 发起的单次工具调用 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: ToolName;
    arguments: string; // JSON 字符串，调用方需 JSON.parse
  };
}

/** 工具执行结果 —— 以 tool 角色消息回传给 LLM */
export interface ToolResult {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
}

/** 工具注册表 —— Agent 通过此映射查找工具名对应的执行器 */
export type ToolExecutor = (args: Record<string, unknown>) => string | Promise<string>;

export type ToolRegistry = Map<string, ToolExecutor>;
