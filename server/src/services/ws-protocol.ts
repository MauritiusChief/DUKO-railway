/**
 * WebSocket 协议类型与入站校验（Server 侧）
 *
 * 本模块以 .agent/auto-plan.md 中的消息类型定义为权威来源，
 * 仅校验从 auto 收到的入站消息；出站消息依赖调用方的类型检查。
 *
 * auto 侧在 auto/src/protocol.ts 中各自定义相同的协议（不共享代码）。
 */

import { z } from 'zod';

// ==================================================================
//  协议常量
// ==================================================================

/** 当前协议版本 */
export const PROTOCOL_VERSION = '3';

/** 心跳超时阈值（毫秒）：超过此时间未收到 heartbeat 视为断线 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** 心跳检测轮询间隔（毫秒） */
export const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;

/** auto 发送心跳的间隔（毫秒），仅作文档参考，server 不强制 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

// ==================================================================
//  入站消息（auto → Server）Zod 校验
// ==================================================================

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  version: z.string().min(1),
  token: z.string().min(1),
});

export const readyMessageSchema = z.object({
  type: z.literal('ready'),
});

export const acceptedMessageSchema = z.object({
  type: z.literal('accepted'),
  taskId: z.number().int(),
  attempt: z.number().int().positive(),
});

export const lineResultMessageSchema = z.object({
  type: z.literal('line-result'),
  taskId: z.number().int(),
  lineNo: z.number().int().positive(),
  status: z.enum(['success', 'failed']),
  error: z.string().optional(),
  attempt: z.number().int().positive(),
});

export const taskCompletedMessageSchema = z.object({
  type: z.literal('task-completed'),
  taskId: z.number().int(),
  status: z.enum(['completed', 'partial_failed']),
  attempt: z.number().int().positive(),
  // 任务种类（区分 quotation / inventory-download / inventory-trend）
  kind: z.enum(['quotation', 'inventory-download', 'inventory-trend']).optional(),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        partModel: z.string(),
        quantity: z.number().int().positive(),
        discount: z.number().optional(),
        status: z.enum(['pending', 'success', 'failed']),
        error: z.string().optional(),
      }),
    )
    .optional(),
  finalSnapshot: z
    .array(
      z.object({
        productModel: z.string(),
        quantity: z.string(),
        discount: z.number().optional(),
      }),
    )
    .optional(),
  // inventory 任务的 kind 专属产出（download→{csv}; trend→{items:[...]})
  result: z.unknown().optional(),
});

export const taskFailedMessageSchema = z.object({
  type: z.literal('task-failed'),
  taskId: z.number().int(),
  error: z.string(),
  attempt: z.number().int().positive(),
});

export const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
});

export const confirmRequestMessageSchema = z.object({
  type: z.literal('confirm-request'),
  taskId: z.number().int(),
  company: z.string(),
  quotationNumber: z.string(),
  existingLines: z.array(
    z.object({
      productModel: z.string(),
      quantity: z.string(),
      discount: z.number().optional(),
    }),
  ),
  inputLines: z.array(
    z.object({
      partModel: z.string(),
      quantity: z.number().int().positive(),
      discount: z.number().optional(),
    }),
  ),
  attempt: z.number().int().positive(),
});

export const progressMessageSchema = z.object({
  type: z.literal('progress'),
  taskId: z.number().int(),
  message: z.string().min(1),
  attempt: z.number().int().positive(),
});

export const inventoryTrendResultMessageSchema = z.object({
  type: z.literal('inventory-trend-result'),
  taskId: z.number().int(),
  result: z.object({
    name: z.string().min(1),
    moves: z.array(
      z.object({
        date: z.string(),
        qty: z.number(),
        dir: z.enum(['in', 'out']),
      }),
    ),
  }),
  attempt: z.number().int().positive(),
});

/** auto → Server 入站消息的联合校验 schema */
export const inboundMessageSchema = z.discriminatedUnion('type', [
  helloMessageSchema,
  readyMessageSchema,
  acceptedMessageSchema,
  lineResultMessageSchema,
  taskCompletedMessageSchema,
  taskFailedMessageSchema,
  heartbeatMessageSchema,
  confirmRequestMessageSchema,
  progressMessageSchema,
  inventoryTrendResultMessageSchema,
]);

// ==================================================================
//  入站消息 TypeScript 类型
// ==================================================================

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type ReadyMessage = z.infer<typeof readyMessageSchema>;
export type AcceptedMessage = z.infer<typeof acceptedMessageSchema>;
export type LineResultMessage = z.infer<typeof lineResultMessageSchema>;
export type TaskCompletedMessage = z.infer<typeof taskCompletedMessageSchema>;
export type TaskFailedMessage = z.infer<typeof taskFailedMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type ConfirmRequestMessage = z.infer<typeof confirmRequestMessageSchema>;
export type ProgressMessage = z.infer<typeof progressMessageSchema>;
export type InventoryTrendResultMessage = z.infer<typeof inventoryTrendResultMessageSchema>;

export type InboundMessage = z.infer<typeof inboundMessageSchema>;

// ==================================================================
//  出站消息（Server → auto）TypeScript 类型
// ==================================================================

/** 任务种类 */
export type TaskKind = 'quotation' | 'inventory-download' | 'inventory-trend';

export interface TaskAssignedLine {
  lineNo: number;
  partModel: string;
  quantity: number;
  /** 折扣百分比（%）—— 未指定时不返回 */
  discount?: number;
}

export interface QuotationTaskAssignedMessage {
  type: 'task-assigned';
  taskId: number;
  kind: 'quotation';
  quotationNumber: string;
  odooUrl: string;
  writeMode: 'overwrite' | 'append';
  lines: TaskAssignedLine[];
}

export interface InventoryDownloadTaskAssignedMessage {
  type: 'task-assigned';
  taskId: number;
  kind: 'inventory-download';
}

export interface InventoryTrendTaskAssignedMessage {
  type: 'task-assigned';
  taskId: number;
  kind: 'inventory-trend';
  items: string[];
  recentMonths: number;
}

export type TaskAssignedMessage =
  | QuotationTaskAssignedMessage
  | InventoryDownloadTaskAssignedMessage
  | InventoryTrendTaskAssignedMessage;

export interface AckMessage {
  type: 'ack';
  taskId: number;
  attempt: number;
}

export interface HeartbeatAckMessage {
  type: 'heartbeat-ack';
}

export interface ServerErrorMessage {
  type: 'error';
  message: string;
}

export interface ConfirmResponseMessage {
  type: 'confirm-response';
  taskId: number;
  decision: 'confirmed' | 'rejected';
}

/** 中止任务（server → auto）：让 worker 立即中止指定任务 */
export interface AbortTaskMessage {
  type: 'abort';
  taskId: number;
}

export type OutboundMessage =
  | TaskAssignedMessage
  | AckMessage
  | HeartbeatAckMessage
  | ServerErrorMessage
  | ConfirmResponseMessage
  | AbortTaskMessage;
