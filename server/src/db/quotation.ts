/**
 * 报价任务数据库层 —— SQLite 持久化（users.sqlite）
 *
 * 表结构：quotation_tasks / quotation_task_lines
 * 表在 db/users.ts 的 initUserDB() 中创建，本模块复用同一数据库连接。
 *
 * 提供任务 CRUD、状态转换、队列取任务、逐行结果写入和断线回收支持。
 */

import type Database from 'better-sqlite3';
import { getUserDb } from './users.js';

// ==================================================================
//  类型定义
// ==================================================================

export type QuotationTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'cancelled';

export type QuotationWriteMode = 'overwrite' | 'append';

export type QuotationLineStatus = 'pending' | 'success' | 'failed';

export interface QuotationTaskRow {
  id: number;
  user_id: number;
  username: string;
  quotation_number: string;
  write_mode: QuotationWriteMode;
  status: QuotationTaskStatus;
  task_error: string | null;
  retry_count: number;
  last_acked_attempt: number;
  pending_confirmation: string | null;
  final_lines_snapshot: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface QuotationTaskLineRow {
  id: number;
  task_id: number;
  line_no: number;
  part_model: string;
  quantity: number;
  status: QuotationLineStatus;
  error: string | null;
}

/** 创建任务时的输入行 */
export interface NewQuotationLine {
  partModel: string;
  quantity: number;
}

/** API 返回的任务摘要 */
export interface QuotationTaskSummary {
  id: number;
  userId: number;
  username: string;
  quotationNumber: string;
  writeMode: QuotationWriteMode;
  status: QuotationTaskStatus;
  taskError: string | null;
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lineCount: number;
  successCount: number;
  failedCount: number;
}

/** API 返回的任务详情（含逐行结果） */
export interface QuotationTaskDetail extends QuotationTaskSummary {
  lines: QuotationTaskLineRow[];
  pendingConfirmation: string | null;
  finalLinesSnapshot: string | null;
}

/** 当前活跃任务的公开摘要（不暴露敏感信息） */
export interface ActiveTaskSummary {
  autoOnline: boolean;
  activeTask?: {
    taskId: number;
    quotationNumber: string;
    username: string;
    startedAt: string;
    status: QuotationTaskStatus;
  };
}

// ==================================================================
//  模块级 DB 引用
// ==================================================================

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) db = getUserDb();
  return db;
}

/** 初始化：注入数据库连接（显式调用，便于测试） */
export function initQuotationDB(database: Database.Database): void {
  db = database;
}

// ==================================================================
//  行映射工具
// ==================================================================

function rowToSummary(
  r: QuotationTaskRow & { line_count: number; success_count: number; failed_count: number },
): QuotationTaskSummary {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    quotationNumber: r.quotation_number,
    writeMode: r.write_mode,
    status: r.status,
    taskError: r.task_error,
    retryCount: r.retry_count,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    lineCount: r.line_count,
    successCount: r.success_count,
    failedCount: r.failed_count,
  };
}

// ==================================================================
//  每用户任务上限
// ==================================================================

const MAX_TASKS_PER_USER = 100;

// ==================================================================
//  CRUD
// ==================================================================

/** 创建报价任务（含逐行），返回新任务 id */
export function createTask(
  userId: number,
  username: string,
  quotationNumber: string,
  writeMode: QuotationWriteMode,
  lines: NewQuotationLine[],
): number {
  const d = getDb();
  const insertTask = d.prepare(`
    INSERT INTO quotation_tasks (user_id, username, quotation_number, write_mode)
    VALUES (?, ?, ?, ?)
  `);
  const insertLine = d.prepare(`
    INSERT INTO quotation_task_lines (task_id, line_no, part_model, quantity)
    VALUES (?, ?, ?, ?)
  `);
  const countStmt = d.prepare(
    'SELECT COUNT(*) AS cnt FROM quotation_tasks WHERE user_id = ?',
  );
  const pruneStmt = d.prepare(`
    DELETE FROM quotation_tasks
    WHERE id IN (
      SELECT id FROM quotation_tasks
      WHERE user_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    )
  `);

  const tx = d.transaction(() => {
    const result = insertTask.run(userId, username, quotationNumber, writeMode);
    const taskId = Number(result.lastInsertRowid);
    lines.forEach((line, idx) => {
      insertLine.run(taskId, idx + 1, line.partModel, line.quantity);
    });

    // 超限时删除最旧任务（外键级联删除其 lines）
    const { cnt } = countStmt.get(userId) as { cnt: number };
    if (cnt > MAX_TASKS_PER_USER) {
      pruneStmt.run(userId, cnt - MAX_TASKS_PER_USER);
    }
    return taskId;
  });

  return tx();
}

/** 获取某用户的任务摘要列表（按 created_at DESC） */
export function getTasksByUser(userId: number): QuotationTaskSummary[] {
  const d = getDb();
  const rows = d.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = t.id) AS line_count,
           (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = t.id AND status = 'success') AS success_count,
           (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = t.id AND status = 'failed') AS failed_count
    FROM quotation_tasks t
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
  `).all(userId) as (QuotationTaskRow & {
    line_count: number;
    success_count: number;
    failed_count: number;
  })[];

  return rows.map(rowToSummary);
}

/** 按 id 获取任务详情（含逐行结果）—— 不带权限校验，由调用方决定访问控制 */
export function getTaskByIdRaw(taskId: number): QuotationTaskDetail | undefined {
  const d = getDb();
  const task = d.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = t.id) AS line_count,
           (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = t.id AND status = 'success') AS success_count,
           (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = t.id AND status = 'failed') AS failed_count
    FROM quotation_tasks t
    WHERE t.id = ?
  `).get(taskId) as (QuotationTaskRow & {
    line_count: number;
    success_count: number;
    failed_count: number;
  }) | undefined;

  if (!task) return undefined;

  const lines = d.prepare(`
    SELECT id, task_id, line_no, part_model, quantity, status, error
    FROM quotation_task_lines
    WHERE task_id = ?
    ORDER BY line_no ASC
  `).all(taskId) as QuotationTaskLineRow[];

  return {
    ...rowToSummary(task),
    lines,
    pendingConfirmation: task.pending_confirmation,
    finalLinesSnapshot: task.final_lines_snapshot,
  };
}

/** 按 id 获取任务详情，仅限本人 */
export function getTaskByIdForUser(
  userId: number,
  taskId: number,
): QuotationTaskDetail | undefined {
  const task = getTaskByIdRaw(taskId);
  if (!task || task.userId !== userId) return undefined;
  return task;
}

/** 取队头的排队任务（status='queued'，按 created_at ASC） */
export function getNextQueuedTask(): QuotationTaskDetail | undefined {
  const d = getDb();
  const queued = d.prepare(`
    SELECT id FROM quotation_tasks
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as { id: number } | undefined;

  if (!queued) return undefined;
  return getTaskByIdRaw(queued.id);
}

/**
 * 取消任务：仅当状态为 queued 时成功，返回是否取消成功。
 * 同时记录任务被取消（status='cancelled', completed_at=now）。
 */
export function cancelTask(
  userId: number,
  taskId: number,
): 'cancelled' | 'not_found' | 'not_cancellable' {
  const d = getDb();
  const row = d
    .prepare('SELECT user_id, status FROM quotation_tasks WHERE id = ?')
    .get(taskId) as { user_id: number; status: QuotationTaskStatus } | undefined;

  if (!row || row.user_id !== userId) return 'not_found';
  if (row.status !== 'queued') return 'not_cancellable';

  const result = d
    .prepare(
      `UPDATE quotation_tasks
       SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`,
    )
    .run(taskId);

  return result.changes > 0 ? 'cancelled' : 'not_cancellable';
}

// ==================================================================
//  状态转换 / 任务执行支持
// ==================================================================

/**
 * 将任务从 queued/running 转为 running，并记录 started_at（仅首次）。
 * 由 ws-handler 在收到 accepted 时调用。
 */
export function markTaskRunning(taskId: number): boolean {
  const d = getDb();
  const result = d.prepare(
    `UPDATE quotation_tasks
     SET status = 'running',
         updated_at = datetime('now'),
         started_at = COALESCE(started_at, datetime('now'))
     WHERE id = ? AND status IN ('queued', 'running')`,
  ).run(taskId);
  return result.changes > 0;
}

/** 更新任务最终状态、错误与完成时间 */
export function updateTaskStatus(
  taskId: number,
  status: QuotationTaskStatus,
  error: string | null = null,
): boolean {
  const d = getDb();
  const result = d
    .prepare(
      `UPDATE quotation_tasks
       SET status = ?, task_error = ?, completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, error, taskId);
  return result.changes > 0;
}

/** 更新单行结果（status + error） */
export function updateLineResult(
  taskId: number,
  lineNo: number,
  status: QuotationLineStatus,
  error: string | null = null,
): boolean {
  const d = getDb();
  const result = d
    .prepare(
      `UPDATE quotation_task_lines
       SET status = ?, error = ?
       WHERE task_id = ? AND line_no = ?`,
    )
    .run(status, error, taskId, lineNo);
  return result.changes > 0;
}

/** 读取某个任务的 last_acked_attempt（幂等校验用） */
export function getLastAckedAttempt(taskId: number): number {
  const d = getDb();
  const row = d
    .prepare('SELECT last_acked_attempt FROM quotation_tasks WHERE id = ?')
    .get(taskId) as { last_acked_attempt: number } | undefined;
  return row?.last_acked_attempt ?? 0;
}

/**
 * 记录 attempt 并推进 last_acked_attempt。
 * 仅当传入的 attempt 大于当前值时才推进，保证幂等。
 */
export function ackAttempt(taskId: number, attempt: number): void {
  const d = getDb();
  d.prepare(
    `UPDATE quotation_tasks
     SET last_acked_attempt = MAX(last_acked_attempt, ?),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(attempt, taskId);
}

/** 根据最终行结果计算任务级状态：全部成功 / 部分失败 / 全部失败 */
export function computeFinalStatus(
  taskId: number,
): 'completed' | 'partial_failed' | 'failed' {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = ?) AS total,
         (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = ? AND status = 'success') AS success,
         (SELECT COUNT(*) FROM quotation_task_lines WHERE task_id = ? AND status = 'failed') AS failed`,
    )
    .get(taskId, taskId, taskId) as { total: number; success: number; failed: number };

  if (row.success === row.total) return 'completed';
  if (row.success > 0 && row.failed > 0) return 'partial_failed';
  return 'failed';
}

// ==================================================================
//  确认握手持久化
// ==================================================================

/** 写入 pending_confirmation（确认请求载荷 JSON） */
export function setPendingConfirmation(taskId: number, payload: object): void {
  const d = getDb();
  d.prepare(
    `UPDATE quotation_tasks
     SET pending_confirmation = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(payload), taskId);
}

/** 读取 pending_confirmation (JSON 字符串，无则 null) */
export function getPendingConfirmation(taskId: number): string | null {
  const d = getDb();
  const row = d
    .prepare('SELECT pending_confirmation FROM quotation_tasks WHERE id = ?')
    .get(taskId) as { pending_confirmation: string | null } | undefined;
  return row?.pending_confirmation ?? null;
}

/** 清空 pending_confirmation（确认后或回收时） */
export function clearPendingConfirmation(taskId: number): void {
  const d = getDb();
  d.prepare(
    `UPDATE quotation_tasks
     SET pending_confirmation = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(taskId);
}

/** 写入 final_lines_snapshot（任务结束后从 Odoo 页面读取的最终行） */
export function setFinalLinesSnapshot(taskId: number, snapshot: object): void {
  const d = getDb();
  d.prepare(
    `UPDATE quotation_tasks
     SET final_lines_snapshot = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(snapshot), taskId);
}

// ==================================================================
//  断线回收
// ==================================================================

/**
 * 返回所有处于 running 状态的任务（断线回收用）。
 * 由于首版只有一个 worker，断线即所有 running 任务都需要回收。
 */
export function getRunningTaskIds(): number[] {
  const d = getDb();
  const rows = d
    .prepare('SELECT id FROM quotation_tasks WHERE status = ?')
    .all('running') as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * 断线回收：retry_count == 0 → 回退 queued, retry_count=1
 *          retry_count >= 1 → 标记 failed
 * 返回回收后的任务状态，供 SSE 广播。
 */
export function reclaimTaskOnDisconnect(taskId: number): {
  status: QuotationTaskStatus;
  retryCount: number;
} {
  const d = getDb();
  const row = d
    .prepare('SELECT retry_count FROM quotation_tasks WHERE id = ? AND status = ?')
    .get(taskId, 'running') as { retry_count: number } | undefined;

  if (!row) {
    return { status: 'queued', retryCount: 0 };
  }

  if (row.retry_count === 0) {
    d.prepare(
      `UPDATE quotation_tasks
       SET status = 'queued', retry_count = 1, started_at = NULL, pending_confirmation = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(taskId);
    return { status: 'queued', retryCount: 1 };
  }

  d.prepare(
    `UPDATE quotation_tasks
     SET status = 'failed',
         task_error = 'worker 断线，任务超时',
         pending_confirmation = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(taskId);
  return { status: 'failed', retryCount: row.retry_count + 1 };
}
