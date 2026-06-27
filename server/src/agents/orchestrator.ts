/**
 * AgentOrchestrator —— 多 Agent 编排器
 *
 * 提供 Agent 实例的注册、查找和消息路由。
 * 为后续流水线（pipeline）和委派（delegate）功能提供基础设施。
 *
 * 用法：
 *   const orc = new AgentOrchestrator();
 *   orc.register('chat', chatAgent);
 *   orc.register('parser', parseAgent);
 *   const agent = orc.resolve('parser');
 *
 * 当前阶段（Phase 5）仅提供注册与消息路由，
 * pipeline 和 workflow 编排在后续阶段实现。
 */

import { BaseAgent } from './base.js';
import type { AgentRole, AgentMessage } from '../types/agent.js';

// ==================================================================
//  OrchestratorContext —— 消息路由时的共享上下文
// ==================================================================

export interface OrchestratorContext {
  /** 消息历史（可被多个 Agent 读取） */
  messages?: unknown[];
  /** 额外的共享状态 */
  [key: string]: unknown;
}

// ==================================================================
//  AgentOrchestrator
// ==================================================================

export class AgentOrchestrator {
  /** Agent 实例注册表 */
  private agents: Map<AgentRole, BaseAgent> = new Map();

  /** 消息处理器注册表（按目标角色订阅） */
  private listeners: Map<AgentRole, Set<(msg: AgentMessage) => void>> = new Map();

  // ----------------------------------------------------------------
  //  Agent 注册
  // ----------------------------------------------------------------

  /** 注册一个 Agent 实例 */
  register(role: AgentRole, agent: BaseAgent): void {
    this.agents.set(role, agent);
  }

  /** 注销一个 Agent 实例 */
  unregister(role: AgentRole): void {
    this.agents.delete(role);
    this.listeners.delete(role);
  }

  /** 按角色查找 Agent 实例 */
  resolve(role: AgentRole): BaseAgent | undefined {
    return this.agents.get(role);
  }

  /** 返回所有已注册的角色列表 */
  registeredRoles(): AgentRole[] {
    return [...this.agents.keys()];
  }

  // ----------------------------------------------------------------
  //  消息路由
  // ----------------------------------------------------------------

  /**
   * 将消息从源 Agent 路由到目标 Agent。
   * 返回目标 Agent 产生的响应消息。
   */
  async send(msg: AgentMessage): Promise<AgentMessage | null> {
    const handlers = this.listeners.get(msg.to);
    if (!handlers || handlers.size === 0) return null;

    const response: AgentMessage = {
      id: crypto.randomUUID(),
      taskId: msg.taskId,
      from: msg.to,
      to: msg.from,
      type: 'result',
      payload: {},
      timestamp: Date.now(),
    };

    for (const handler of handlers) {
      handler(msg);
    }

    return response;
  }

  /** 订阅特定角色的消息 */
  on(role: AgentRole, handler: (msg: AgentMessage) => void): () => void {
    if (!this.listeners.has(role)) {
      this.listeners.set(role, new Set());
    }
    this.listeners.get(role)!.add(handler);

    return () => {
      this.listeners.get(role)?.delete(handler);
    };
  }

  // ----------------------------------------------------------------
  //  工具所有权查询
  // ----------------------------------------------------------------

  /**
   * 查询指定角色拥有的工具名集合。
   * 通过 Agent 子类的 static ownedToolNames 获取。
   */
  getOwnedToolNames(role: AgentRole): Set<string> {
    const agent = this.agents.get(role);
    if (!agent) return new Set();

    const ctor = agent.constructor as typeof BaseAgent;
    return new Set(ctor.ownedToolNames || []);
  }

  /**
   * 查询拥有指定工具的 Agent 角色列表。
   * 用于工具调用路由：当某个 Agent 需要调用另一 Agent 的专属工具时，
   * 通过此方法找到工具的所有者。
   */
  findToolOwners(toolName: string): AgentRole[] {
    const owners: AgentRole[] = [];
    for (const [role, agent] of this.agents) {
      const ctor = agent.constructor as typeof BaseAgent;
      if (ctor.ownedToolNames?.includes(toolName)) {
        owners.push(role);
      }
    }
    return owners;
  }
}
