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
export const PROTOCOL_VERSION = '2';

/** 应用层心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 连续未收到 heartbeat-ack 的次数达到此阈值视为连接死亡 */
export const HEARTBEAT_MAX_MISSED = 3;

// ==================================================================
//  任务种类
// ==================================================================

export type TaskKind = 'quotation' | 'inventory-download' | 'inventory-trend';

/** 报价快照行（读取用） */
export interface QuotationSnapshotLine {
  productModel: string
  quantity: string
}

export type QuotationWriteMode = 'overwrite' | 'append';

export interface TaskLine {
  lineNo: number;
  partModel: string;
  quantity: number;
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

// inventory 趋势任务的库存移动数据
export interface TrendMove {
  date: string;
  qty: number;
  dir: 'in' | 'out';
}
export interface TrendItemResult {
  name: string;
  moves: TrendMove[];
}

// ==================================================================
//  入站消息（Server → Auto）Zod 校验
// ==================================================================

// task-assigned 运行时校验：扁平 object（kind + 各变体字段可选）。
// 不能用嵌套 discriminatedUnion（Zod 的顶层 discriminatedUnion 要求成员为 ZodObject），
// 因此用单一扁平 schema 做入站校验，下方再用 TS 联合类型保证调用方类型安全。
export const taskAssignedSchema = z.object({
  type: z.literal('task-assigned'),
  taskId: z.number().int(),
  kind: z.enum(['quotation', 'inventory-download', 'inventory-trend']),
  quotationNumber: z.string().optional(),
  odooUrl: z.string().optional(),
  writeMode: z.enum(['overwrite', 'append']).optional(),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        partModel: z.string(),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
  items: z.array(z.string()).optional(),
  recentMonths: z.number().int().min(1).optional(),
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
  lines: { lineNo: number; partModel: string; quantity: number }[];
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

export interface InventoryTrendTaskCompletedMessage {
  type: 'task-completed';
  taskId: number;
  kind: 'inventory-trend';
  status: 'completed' | 'partial_failed';
  result: { items: TrendItemResult[] };
  attempt: number;
}

export type TaskCompletedMessage =
  | QuotationTaskCompletedMessage
  | InventoryDownloadTaskCompletedMessage
  | InventoryTrendTaskCompletedMessage;

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
  inputLines: { partModel: string; quantity: number }[];
  attempt: number;
}

export interface ProgressMessage {
  type: 'progress';
  taskId: number;
  message: string;
  attempt: number;
}

export interface InventoryTrendResultMessage {
  type: 'inventory-trend-result';
  taskId: number;
  result: TrendItemResult;
  attempt: number;
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
  | InventoryTrendResultMessage;
