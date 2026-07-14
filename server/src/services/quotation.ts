/**
 * 报价任务服务层 —— 业务逻辑、状态机和权限校验
 *
 * 包装 db/quotation.ts 的原始 CRUD，补充：
 *  - 状态转换合法性校验
 *  - 权限校验（仅任务创建者和管理员可访问详情/取消）
 *  - SSE 广播集成入口
 *
 * 路由层仅做参数提取和响应；ws-handler 通过本模块推进任务状态。
 */

import type { QuotationTaskStatus } from '../db/quotation.js';

// ==================================================================
//  状态机
// ==================================================================

/** 合法的状态转换（key → 合法目标值集合） */
const TRANSITIONS: Record<QuotationTaskStatus, QuotationTaskStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'partial_failed', 'failed', 'queued'],
  completed: [],
  partial_failed: [],
  failed: [],
  cancelled: [],
};

/** 校验状态转换是否合法 */
export function canTransition(
  from: QuotationTaskStatus,
  to: QuotationTaskStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 业务错误：非法状态转换 */
export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly from: QuotationTaskStatus,
    public readonly to: QuotationTaskStatus,
  ) {
    super(`非法状态转换：${from} → ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

/** 业务错误：无权访问 */
export class QuotationPermissionError extends Error {
  constructor(message = '无权访问此报价任务') {
    super(message);
    this.name = 'QuotationPermissionError';
  }
}

// ==================================================================
//  权限校验工具
// ==================================================================

/**
 * 判断指定用户能否查看/操作某任务：仅任务创建者和管理员。
 */
export function canAccessTask(
  taskOwnerUserId: number,
  accessorUserId: number,
  accessorRole: 'admin' | 'user',
): boolean {
  return taskOwnerUserId === accessorUserId || accessorRole === 'admin';
}
