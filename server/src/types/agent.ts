/**
 * Agent 相关类型 —— 多 Agent 通信协议
 *
 * AgentRole 标识 Agent 身份；AgentMessage 定义 Agent 间消息结构。
 * 配合 AgentOrchestrator 使用。
 */

// ==================================================================
//  AgentRole —— Agent 身份标识
// ==================================================================

/** Agent 角色标识，预定义 + 可扩展字符串 */
export type AgentRole = 'chat' | 'parser' | 'vision' | 'layout' | string;

// ==================================================================
//  AgentMessage —— Agent 间消息结构
// ==================================================================

/**
 * Agent 间通信消息。
 * 由 AgentOrchestrator 路由到目标 Agent。
 */
export interface AgentMessage {
  /** 消息唯一 ID */
  id: string;
  /** 关联任务 ID（跨多 Agent 的任务共享同一 taskId） */
  taskId: string;
  /** 发送方 Agent 角色 */
  from: AgentRole;
  /** 接收方 Agent 角色 */
  to: AgentRole;
  /** 消息类型 */
  type: 'task' | 'result' | 'error';
  /** 消息负载 */
  payload: Record<string, unknown>;
  /** UTC 时间戳（毫秒） */
  timestamp: number;
}
