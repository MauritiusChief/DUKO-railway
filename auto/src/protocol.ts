/**
 * WebSocket 协议类型与入站校验（Auto 侧）
 *
 * 本模块以 .agent/auto-plan.md 中的消息类型定义为权威来源，
 * 仅校验从 server 收到的入站消息；出站消息依赖调用方的类型检查。
 *
 * server 侧在 server/src/services/ws-protocol.ts 中各自定义相同的协议（不共享代码）。
 */

import { z } from 'zod';

// ==================================================================
//  协议常量
// ==================================================================

/** 当前协议版本（必须与 server 一致） */
export const PROTOCOL_VERSION = '4';

/** 应用层心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 连续未收到 heartbeat-ack 的次数达到此阈值视为连接死亡 */
export const HEARTBEAT_MAX_MISSED = 3;

// ==================================================================
//  任务种类
// ==================================================================

export type TaskKind =
  | 'quotation'
  | 'inventory-download'
  | 'inventory-moves-sync';

/** 报价快照行（读取用） */
export interface QuotationSnapshotLine {
  productModel: string
  quantity: string
  /** 折扣百分比（%）—— 未指定时不返回 */
  discount?: number
}

export type QuotationWriteMode = 'overwrite' | 'append';

export interface TaskLine {
  lineNo: number;
  partModel: string;
  quantity: number;
  /** 折扣百分比（%）—— 未指定时不返回 */
  discount?: number;
}

export interface QuotationTask {
  taskId: number;
  quotationNumber: string;
  odooUrl: string;
  writeMode: QuotationWriteMode;
  lines: TaskLine[];
}

export type LineStatus = 'success' | 'failed';

export interface LineResult {
  lineNo: number;
  status: LineStatus;
  error?: string;
}

// inventory-moves-sync 任务：Odoo move 列表原始行（worker 每页提取一批）
export interface MoveRow {
  /** Odoo 原始日期文本（"MM/DD/YYYY HH:mm:ss"） */
  dateText: string;
  /** worker 按本地时区解析后的 epoch 毫秒 */
  dateTs: number;
  reference: string;
  product: string;
  lot: string;
  locationFrom: string;
  locationTo: string;
  qty: number;
  uom: string;
  state: string;
}

export type MovesSyncMode = 'fast' | 'full';

// ==================================================================
//  入站消息（Server → Auto）Zod 校验
// ==================================================================

// task-assigned 运行时校验：扁平 object（kind + 各变体字段可选）。
// 不能用嵌套 discriminatedUnion（Zod 的顶层 discriminatedUnion 要求成员为 ZodObject），
// 因此用单一扁平 schema 做入站校验，下方再用 TS 联合类型保证调用方类型安全。
export const taskAssignedSchema = z.object({
  type: z.literal('task-assigned'),
  taskId: z.number().int(),
  kind: z.enum(['quotation', 'inventory-download', 'inventory-moves-sync']),
  quotationNumber: z.string().optional(),
  odooUrl: z.string().optional(),
  writeMode: z.enum(['overwrite', 'append']).optional(),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        partModel: z.string(),
        quantity: z.number().int().positive(),
        discount: z.number().optional(),
      }),
    )
    .optional(),
  items: z.array(z.string()).optional(),
  recentMonths: z.number().int().min(1).optional(),
  // inventory-moves-sync 专属字段
  cutoffTs: z.number().int().optional(),
  mode: z.enum(['fast', 'full']).optional(),
});

export const ackSchema = z.object({
  type: z.literal('ack'),
  taskId: z.number().int(),
  attempt: z.number().int().positive(),
});

export const heartbeatAckSchema = z.object({
  type: z.literal('heartbeat-ack'),
});

export const serverErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const confirmResponseSchema = z.object({
  type: z.literal('confirm-response'),
  taskId: z.number().int(),
  decision: z.enum(['confirmed', 'rejected']),
});

/** 中止任务（server → auto） */
export const abortSchema = z.object({
  type: z.literal('abort'),
  taskId: z.number().int(),
});

export const inboundMessageSchema = z.discriminatedUnion('type', [
  taskAssignedSchema,
  ackSchema,
  heartbeatAckSchema,
  serverErrorSchema,
  confirmResponseSchema,
  abortSchema,
]);

// ==================================================================
//  入站消息 TypeScript 类型
// ==================================================================

export interface QuotationTaskAssignedMessage {
  type: 'task-assigned';
  taskId: number;
  kind: 'quotation';
  quotationNumber: string;
  odooUrl: string;
  writeMode: 'overwrite' | 'append';
  lines: TaskLine[];
}
export interface InventoryDownloadTaskAssignedMessage {
  type: 'task-assigned';
  taskId: number;
  kind: 'inventory-download';
}
export interface InventoryMovesSyncTaskAssignedMessage {
  type: 'task-assigned';
  taskId: number;
  kind: 'inventory-moves-sync';
  /** 截止时间（epoch ms）：整页行 dateTs 均早于该值即停止翻页 */
  cutoffTs: number;
  mode: MovesSyncMode;
}
export type TaskAssignedMessage =
  | QuotationTaskAssignedMessage
  | InventoryDownloadTaskAssignedMessage
  | InventoryMovesSyncTaskAssignedMessage;
export type AckMessage = z.infer<typeof ackSchema>;
export type HeartbeatAckMessage = z.infer<typeof heartbeatAckSchema>;
export type ServerErrorMessage = z.infer<typeof serverErrorSchema>;
export type ConfirmResponseMessage = z.infer<typeof confirmResponseSchema>;
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

// ==================================================================
//  出站消息（Auto → Server）TypeScript 类型
// ==================================================================

export interface HelloMessage {
  type: 'hello';
  version: string;
  token: string;
}

export interface ReadyMessage {
  type: 'ready';
}

export interface AcceptedMessage {
  type: 'accepted';
  taskId: number;
  attempt: number;
}

export interface LineResultMessage {
  type: 'line-result';
  taskId: number;
  lineNo: number;
  status: LineStatus;
  error?: string;
  attempt: number;
}

export interface QuotationTaskCompletedMessage {
  type: 'task-completed';
  taskId: number;
  kind: 'quotation';
  status: 'completed' | 'partial_failed';
  lines: (TaskLine & { status: 'pending' | 'success' | 'failed'; error?: string })[];
  finalSnapshot?: QuotationSnapshotLine[];
  attempt: number;
}

export interface InventoryDownloadTaskCompletedMessage {
  type: 'task-completed';
  taskId: number;
  kind: 'inventory-download';
  status: 'completed' | 'partial_failed';
  result: { csv: string };
  attempt: number;
}

export interface InventoryMovesSyncTaskCompletedMessage {
  type: 'task-completed';
  taskId: number;
  kind: 'inventory-moves-sync';
  status: 'completed' | 'partial_failed';
  result: Record<string, never>;
  attempt: number;
}

export type TaskCompletedMessage =
  | QuotationTaskCompletedMessage
  | InventoryDownloadTaskCompletedMessage
  | InventoryMovesSyncTaskCompletedMessage;

export interface TaskFailedMessage {
  type: 'task-failed';
  taskId: number;
  error: string;
  attempt: number;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export interface ConfirmRequestMessage {
  type: 'confirm-request';
  taskId: number;
  company: string;
  quotationNumber: string;
  existingLines: QuotationSnapshotLine[];
  inputLines: { partModel: string; quantity: number; discount?: number }[];
  attempt: number;
}

export interface ProgressMessage {
  type: 'progress';
  taskId: number;
  message: string;
  attempt: number;
}

export interface InventoryMovesBatchMessage {
  type: 'inventory-moves-batch';
  taskId: number;
  attempt: number;
  rows: MoveRow[];
}

export type OutboundMessage =
  | HelloMessage
  | ReadyMessage
  | AcceptedMessage
  | LineResultMessage
  | TaskCompletedMessage
  | TaskFailedMessage
  | HeartbeatMessage
  | ConfirmRequestMessage
  | ProgressMessage
  | InventoryMovesBatchMessage;
