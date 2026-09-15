/**
 * Inventory 查询编排器 —— 内存 job 状态 + 调动历史本地库（stock_moves）
 *
 * 流程：
 *   auto 模式：download 任务（worker 下载 CSV）→ cleanCSVFromString → 筛选低库存 → 自动 startMovesSync → classify
 *   upload 模式：cleanCSVFromString → 筛选低库存 → startMovesSync → classify
 *
 * 调动数据不再逐项查 Odoo：worker 执行一次 inventory-moves-sync 把 ATL/Stock
 * 调动批量写入 stock_moves（INSERT OR IGNORE），完成后 server 直接查本地库
 * 聚合每个低库存项的近期出入库并分类。SSE 事件形状与旧逐项 trend 流程一致。
 *
 * 每个 job 的状态保存在内存 Map 中；分类结果由前端存入 localStorage。
 * 通过 inventory-sse 向订阅者推送 phase/progress/low-stock/trend-result/complete/error 事件。
 *
 * worker 借用：通过 ws-handler.enqueueInventoryTask 入队（负数 taskId 命名空间），
 * 回调驱动状态机推进。
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { cleanCSVFromString } from './sku-clean.js';
import {
  enqueueInventoryTask,
  abortInventoryTask,
  isWorkerConnected,
} from './ws-handler.js';
import { broadcastInventory } from './inventory-sse.js';
import { getMovesWatermark, insertInventoryResult, insertStockMoves, queryItemMoves } from '../db/sku.js';
import { computeMovesSyncCutoff, monthsAgoTs } from './moves-sync-cutoff.js';
import { stageProductRawCsv } from './product-raw-stage.js';
import { config } from '../config/env.js';

// ==================================================================
//  类型
// ==================================================================

export interface LowStockItem {
  name: string;
  freeToUse: number;
  qtyOnHand?: number;
  forecasted?: number;
}

export interface ClassifiedItem extends LowStockItem {
  inbound: number;
  outbound: number;
}

export interface Classification {
  warning: ClassifiedItem[];
  reminder: ClassifiedItem[];
  info: ClassifiedItem[];
  noAttentionCount: number;
}

type Phase =
  | 'download'
  | 'cleaning'
  | 'filtering'
  | 'moves-sync'
  | 'classifying'
  | 'completed'
  | 'failed';
type JobStatus = 'running' | 'completed' | 'failed';
type ClassificationBucket = 'warning' | 'reminder' | 'info';

interface InventoryJob {
  jobId: string;
  userId: number;
  username: string;
  mode: 'auto' | 'upload';
  threshold: number;
  trendThreshold: number;
  recentMonths: number;
  /** 快速模式（增量补齐）；false = 全量检查（重读 recentMonths 窗口） */
  fastMode: boolean;
  phase: Phase;
  status: JobStatus;
  rawCsv?: string;
  totalCleaned?: number;
  lowStockItems?: LowStockItem[];
  classification?: Classification;
  error?: string;
  lastProgress?: string;
  downloadTaskId?: number;
  syncTaskId?: number;
  createdAt: number;
}

export interface JobSnapshot {
  jobId: string;
  mode: string;
  phase: Phase;
  status: JobStatus;
  threshold: number;
  trendThreshold: number;
  recentMonths: number;
  totalCleaned?: number;
  lowStockCount?: number;
  lowStockItems?: LowStockItem[];
  classification?: Classification;
  error?: string;
  lastProgress?: string;
}

// ==================================================================
//  内存 job 存储
// ==================================================================

const jobs = new Map<string, InventoryJob>();

/** 向 job 的所有 SSE 订阅者广播事件 */
function emit(jobId: string, type: string, data: unknown): void {
  broadcastInventory(jobId, { type, data });
}

/** 设置 phase 并广播 */
function setPhase(job: InventoryJob, phase: Phase): void {
  job.phase = phase;
  emit(job.jobId, 'phase', { phase });
}

/** 标记失败并广播（仅首次生效，避免重复 error 事件） */
function failJob(job: InventoryJob, error: string): void {
  if (job.status !== 'running') return;
  job.status = 'failed';
  job.phase = 'failed';
  job.error = error;
  console.error(`[inventory] job ${job.jobId} 失败: ${error}`);
  emit(job.jobId, 'error', { error });
}

/** 推送进度并记录最近一条 */
function progress(job: InventoryJob, message: string): void {
  job.lastProgress = message;
  emit(job.jobId, 'progress', { message });
}

// ==================================================================
//  清洗 + 筛选
// ==================================================================

/** 从清洗后的记录中筛选低于阈值的项目 */
function cleanAndFilter(job: InventoryJob, csv: string): void {
  setPhase(job, 'cleaning');
  const { records } = cleanCSVFromString(csv);
  job.totalCleaned = records.length;
  progress(job, `清洗完成：共 ${records.length} 个标准产品`);

  setPhase(job, 'filtering');
  const low: LowStockItem[] = [];
  for (const r of records) {
    const freeToUse = parseFloat(
      r.row['Free to use Quantity'] ?? r.row['free_qty'] ?? '',
    );
    if (isNaN(freeToUse)) continue;
    if (freeToUse < job.threshold) {
      const qtyOnHand = parseFloat(
        r.row['Quantity On Hand'] ?? r.row['qty_available'] ?? '',
      );
      const foreRaw = parseFloat(r.row['Forecasted Quantity'] ?? r.row['virtual_available'] ?? '');
      low.push({
        name: r.name,
        freeToUse,
        qtyOnHand: isNaN(qtyOnHand) ? undefined : qtyOnHand,
        forecasted: isNaN(foreRaw) ? undefined : foreRaw,
      });
    }
  }
  // 可用库存越低越靠前
  low.sort((a, b) => a.freeToUse - b.freeToUse);
  job.lowStockItems = low;

  progress(job, `筛选完成：${low.length} 个可用库存低于阈值 ${job.threshold}`);
  emit(job.jobId, 'low-stock', {
    totalCleaned: job.totalCleaned,
    lowStockCount: low.length,
    items: low,
  });
}

// ==================================================================
//  调动历史同步 + 分类
// ==================================================================

function emptyClassification(job: InventoryJob): Classification {
  return {
    warning: [],
    reminder: [],
    info: [],
    noAttentionCount: Math.max(
      0,
      (job.totalCleaned ?? 0) - (job.lowStockItems ?? []).length,
    ),
  };
}

/** 快速补齐的安全重叠窗口：读到水位线 − 48h 为止（覆盖同秒时间戳碰撞） */
export { MOVES_SYNC_OVERLAP_MS, computeMovesSyncCutoff, monthsAgoTs } from './moves-sync-cutoff.js';

/** 出库量分桶：达到警告阈值 → warning；有出库 → reminder；否则 info */
function classifyBucket(job: InventoryJob, outbound: number): ClassificationBucket {
  return outbound > 0 && outbound >= job.trendThreshold
    ? 'warning'
    : outbound > 0
      ? 'reminder'
      : 'info';
}

function upsertClassification(
  classification: Classification,
  bucket: ClassificationBucket,
  item: ClassifiedItem,
): void {
  classification.warning = classification.warning.filter((entry) => entry.name !== item.name);
  classification.reminder = classification.reminder.filter((entry) => entry.name !== item.name);
  classification.info = classification.info.filter((entry) => entry.name !== item.name);
  classification[bucket].push(item);
}

/**
 * 同步完成后：从本地库聚合每个低库存项的近期出入库，逐项分类并发
 * trend-result 事件（形状与旧逐项 trend 流程一致）。
 */
function completeMovesSync(job: InventoryJob): void {
  if (job.status !== 'running') return;

  const items = job.lowStockItems ?? [];
  const windowStartTs = monthsAgoTs(job.recentMonths);
  const classification = emptyClassification(job);

  let processed = 0;
  for (const item of items) {
    processed += 1;
    const { inbound, outbound } = queryItemMoves(item.name, windowStartTs);
    const classifiedItem: ClassifiedItem = { ...item, inbound, outbound };
    const bucket = classifyBucket(job, outbound);
    upsertClassification(classification, bucket, classifiedItem);

    emit(job.jobId, 'trend-result', {
      bucket,
      item: classifiedItem,
      processed,
      total: items.length,
      noAttentionCount: classification.noAttentionCount,
    });
  }

  job.classification = classification;
  classifyAndComplete(job);
}

/** 启动调动历史同步（借用 worker；批量落库由本服务完成） */
function startMovesSync(job: InventoryJob): void {
  if (job.status !== 'running') return;
  const items = (job.lowStockItems ?? []).map((i) => i.name);
  job.classification = emptyClassification(job);
  if (items.length === 0) {
    // 无低库存项 → 直接分类完成
    classifyAndComplete(job);
    return;
  }

  setPhase(job, 'moves-sync');
  const { cutoffTs, mode } = computeMovesSyncCutoff(
    job.fastMode,
    getMovesWatermark(),
    job.recentMonths,
  );
  const label = mode === 'fast' ? '快速补齐' : '全量检查';
  if (!isWorkerConnected()) {
    progress(job, `等待 auto worker 上线后开始调动同步（${label}）…`);
  } else {
    progress(job, `开始调动历史同步（${label}）`);
  }

  let insertedTotal = 0;
  const taskId = enqueueInventoryTask(
    'inventory-moves-sync',
    {
      onProgress: (message) => progress(job, message),
      onMovesBatch: (rows) => {
        try {
          const stats = insertStockMoves(rows);
          insertedTotal += stats.inserted;
          progress(job, `已入库 ${stats.inserted} 条，本次累计新增 ${insertedTotal} 条`);
        } catch (err) {
          failJob(job, `调动数据落库失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onComplete: () => {
        try {
          completeMovesSync(job);
        } catch (err) {
          failJob(job, `调动同步结果处理失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onFailed: (error) => failJob(job, `调动同步失败：${error}`),
    },
    { cutoffTs, mode },
  );
  job.syncTaskId = taskId;
}

// ==================================================================
//  分类
// ==================================================================

/** 持久化分类结果并标记完成 */
function classifyAndComplete(job: InventoryJob): void {
  if (job.status !== 'running') return;
  setPhase(job, 'classifying');

  const classification = job.classification ?? emptyClassification(job);
  job.classification = classification;

  // 持久化到全局库存历史（最近 20 条）。写入失败则整个 job 视为失败，
  // 因为"成功完成"要求包含正式结果落库。
  try {
    insertInventoryResult({
      jobId: job.jobId,
      triggeredById: job.userId,
      triggeredByName: job.username,
      source: job.mode,
      threshold: job.threshold,
      trendThreshold: job.trendThreshold,
      recentMonths: job.recentMonths,
      totalCleaned: job.totalCleaned ?? 0,
      lowStockCount: (job.lowStockItems ?? []).length,
      warningCount: classification.warning.length,
      reminderCount: classification.reminder.length,
      infoCount: classification.info.length,
      noAttentionCount: classification.noAttentionCount,
      classificationJson: JSON.stringify(classification),
    });
  } catch (err) {
    failJob(job, `库存历史写入失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  job.status = 'completed';
  job.phase = 'completed';

  progress(job, `分类完成：警告 ${classification.warning.length} / 提醒 ${classification.reminder.length} / 信息 ${classification.info.length} / 无需注意 ${classification.noAttentionCount}`);
  emit(job.jobId, 'complete', { classification: job.classification });
}

// ==================================================================
//  对外 API
// ==================================================================

/** 创建 auto 下载模式的 job */
export function createDownloadJob(
  userId: number,
  username: string,
  threshold: number,
  trendThreshold: number,
  recentMonths: number,
  fastMode: boolean,
): string {
  const job: InventoryJob = {
    jobId: randomUUID(),
    userId,
    username,
    mode: 'auto',
    threshold,
    trendThreshold,
    recentMonths,
    fastMode,
    phase: 'download',
    status: 'running',
    createdAt: Date.now(),
  };
  jobs.set(job.jobId, job);

  setPhase(job, 'download');
  if (!isWorkerConnected()) {
    progress(job, '等待 auto worker 上线后开始下载…');
  } else {
    progress(job, '开始从 Odoo 下载产品数据');
  }

  const taskId = enqueueInventoryTask('inventory-download', {
    onProgress: (message) => progress(job, message),
    onComplete: (result) => {
      try {
        const r = (result ?? {}) as { csv?: string };
        const csv = r.csv ?? '';
        if (!csv) {
          failJob(job, '下载返回空 CSV');
          return;
        }
        job.rawCsv = csv;
        // best-effort 暂存为最新 Product-raw-YYYY-MM-DD.csv，供管理员择机手动 refresh。
        // 暂存失败仅记日志，不阻断本次库存识别。
        try {
          const staged = stageProductRawCsv(csv, config.dbDir);
          progress(job, `已暂存最新 Product-raw 供后续手动刷新：${path.basename(staged)}`);
        } catch (stageErr) {
          console.error(`[inventory] job ${job.jobId} 暂存 Product-raw 失败: ${stageErr instanceof Error ? stageErr.message : String(stageErr)}`);
        }
        cleanAndFilter(job, csv);
        // 自动衔接调动历史同步
        startMovesSync(job);
      } catch (err) {
        failJob(job, `下载后处理失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onFailed: (error) => failJob(job, `下载失败：${error}`),
  });
  job.downloadTaskId = taskId;

  return job.jobId;
}

/** 创建 upload 模式的 job（用户提供 CSV） */
export function createUploadJob(
  userId: number,
  username: string,
  csv: string,
  threshold: number,
  trendThreshold: number,
  recentMonths: number,
  fastMode: boolean,
): string {
  const job: InventoryJob = {
    jobId: randomUUID(),
    userId,
    username,
    mode: 'upload',
    threshold,
    trendThreshold,
    recentMonths,
    fastMode,
    phase: 'cleaning',
    status: 'running',
    rawCsv: csv,
    createdAt: Date.now(),
  };
  jobs.set(job.jobId, job);

  // 同步清洗 + 筛选（不依赖 worker）
  try {
    cleanAndFilter(job, csv);
  } catch (err) {
    failJob(job, `清洗失败：${err instanceof Error ? err.message : String(err)}`);
    return job.jobId;
  }

  // 自动衔接调动历史同步
  startMovesSync(job);
  return job.jobId;
}

/** 取 job 快照（供 SSE 初始推送 / GET 查询用） */
export function getJobSnapshot(jobId: string): JobSnapshot | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.jobId,
    mode: job.mode,
    phase: job.phase,
    status: job.status,
    threshold: job.threshold,
    trendThreshold: job.trendThreshold,
    recentMonths: job.recentMonths,
    totalCleaned: job.totalCleaned,
    lowStockCount: job.lowStockItems?.length,
    lowStockItems: job.lowStockItems,
    classification: job.classification,
    error: job.error,
    lastProgress: job.lastProgress,
  };
}

/**
 * 取 job 快照，仅限创建者本人。
 * 快照、SSE、取消三个入口共用此所有权判断，避免他人凭 jobId 猜测读取。
 */
export function getOwnedJobSnapshot(jobId: string, userId: number): JobSnapshot | null {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  return getJobSnapshot(jobId);
}

/** 取消 job（中止在途 worker 任务） */
export function cancelJob(jobId: string, userId: number): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.userId !== userId) return false;
  if (job.status !== 'running') return false;

  // 中止在途任务（download 或 moves-sync）
  if (job.syncTaskId) abortInventoryTask(job.syncTaskId);
  if (job.downloadTaskId) abortInventoryTask(job.downloadTaskId);

  job.status = 'failed';
  job.phase = 'failed';
  job.error = '用户取消';
  emit(job.jobId, 'error', { error: '用户取消' });
  return true;
}

// ==================================================================
//  清理（防止内存泄漏：删除已完成超过 1 小时的 job）
// ==================================================================

const JOB_TTL_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();
