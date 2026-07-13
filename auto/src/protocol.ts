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
export const PROTOCOL_VERSION = '1';

/** 应用层心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 连续未收到 heartbeat-ack 的次数达到此阈值视为连接死亡 */
export const HEARTBEAT_MAX_MISSED = 3;

// ==================================================================
//  任务相关类型
// ==================================================================

export type QuotationWriteMode = 'overwrite' | 'append';

export interface TaskLine {
  lineNo: number;
  partModel: string;
  quantity: number;
}

export interface QuotationTask {
  taskId: number;
  quotationNumber: string;
  writeMode: QuotationWriteMode;
  lines: TaskLine[];
}

export type LineStatus = 'success' | 'failed';

export interface LineResult {
  lineNo: number;
  status: LineStatus;
  error?: string;
}

// ==================================================================
//  入站消息（Server → Auto）Zod 校验
// ==================================================================

export const taskAssignedSchema = z.object({
  type: z.literal('task-assigned'),
  taskId: z.number().int().positive(),
  quotationNumber: z.string().min(1),
  writeMode: z.enum(['overwrite', 'append']),
  lines: z.array(
    z.object({
      lineNo: z.number().int().positive(),
      partModel: z.string(),
      quantity: z.number().int().positive(),
    }),
  ),
});

export const ackSchema = z.object({
  type: z.literal('ack'),
  taskId: z.number().int().positive(),
  attempt: z.number().int().positive(),
});

export const heartbeatAckSchema = z.object({
  type: z.literal('heartbeat-ack'),
});

export const serverErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const inboundMessageSchema = z.discriminatedUnion('type', [
  taskAssignedSchema,
  ackSchema,
  heartbeatAckSchema,
  serverErrorSchema,
]);

// ==================================================================
//  入站消息 TypeScript 类型
// ==================================================================

export type TaskAssignedMessage = z.infer<typeof taskAssignedSchema>;
export type AckMessage = z.infer<typeof ackSchema>;
export type HeartbeatAckMessage = z.infer<typeof heartbeatAckSchema>;
export type ServerErrorMessage = z.infer<typeof serverErrorSchema>;
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

export interface TaskCompletedMessage {
  type: 'task-completed';
  taskId: number;
  status: 'completed' | 'partial_failed';
  lines: (TaskLine & { status: 'pending' | 'success' | 'failed'; error?: string })[];
  attempt: number;
}

export interface TaskFailedMessage {
  type: 'task-failed';
  taskId: number;
  error: string;
  attempt: number;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export type OutboundMessage =
  | HelloMessage
  | ReadyMessage
  | AcceptedMessage
  | LineResultMessage
  | TaskCompletedMessage
  | TaskFailedMessage
  | HeartbeatMessage;
