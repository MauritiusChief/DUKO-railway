/**
 * Inventory 查询编排器 —— 纯内存，不落库
 *
 * 流程：
 *   auto 模式：download 任务（worker 下载 CSV）→ cleanCSVFromString → 筛选低库存 → 自动 startTrend → classify
 *   upload 模式：cleanCSVFromString → 筛选低库存 → startTrend → classify
 *
 * 每个 job 的状态保存在内存 Map 中；最终结果由前端存入 localStorage。
 * 通过 inventory-sse 向订阅者推送 phase/progress/low-stock/complete/error 事件。
 *
 * worker 借用：通过 ws-handler.enqueueInventoryTask 入队（负数 taskId 命名空间），
 * 回调驱动状态机推进。
 */

import { randomUUID } from 'crypto';
import { cleanCSVFromString } from './sku-clean.js';
import {
  enqueueInventoryTask,
  abortInventoryTask,
  isWorkerConnected,
} from './ws-handler.js';
import { broadcastInventory } from './inventory-sse.js';
import { getAutoOnlineState } from './ws-state.js';

// ==================================================================
//  类型
// ==================================================================

export interface LowStockItem {
  name: string;
  qtyOnHand: number;
  freeToUse?: number;
  forecasted?: number;
}

export interface ClassifiedItem extends LowStockItem {
  net: number;
}

export interface Classification {
  warning: ClassifiedItem[];
  reminder: ClassifiedItem[];
  info: ClassifiedItem[];
  noAttentionCount: number;
}

/** worker 回传的趋势数据 */
interface TrendMoveDTO {
  date: string;
  qty: number;
  dir: 'in' | 'out';
}
interface TrendResultDTO {
  name: string;
  moves: TrendMoveDTO[];
}

type Phase = 'download' | 'cleaning' | 'filtering' | 'trend' | 'classifying' | 'completed' | 'failed';
type JobStatus = 'running' | 'completed' | 'failed';

interface InventoryJob {
  jobId: string;
  userId: number;
  username: string;
  mode: 'auto' | 'upload';
  threshold: number;
  trendThreshold: number;
  phase: Phase;
  status: JobStatus;
  rawCsv?: string;
  totalCleaned?: number;
  lowStockItems?: LowStockItem[];
  trendResults?: TrendResultDTO[];
  classification?: Classification;
  error?: string;
  lastProgress?: string;
  downloadTaskId?: number;
  trendTaskId?: number;
  createdAt: number;
}

export interface JobSnapshot {
  jobId: string;
  mode: string;
  phase: Phase;
  status: JobStatus;
  threshold: number;
  trendThreshold: number;
  autoOnline: boolean;
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

/** 标记失败并广播 */
function failJob(job: InventoryJob, error: string): void {
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
    const qtyRaw = r.row['Quantity On Hand'] ?? r.row['qty_available'] ?? '';
    const qty = parseFloat(qtyRaw);
    if (isNaN(qty)) continue;
    if (qty < job.threshold) {
      const freeRaw = parseFloat(r.row['Free to use Quantity'] ?? '');
      const foreRaw = parseFloat(r.row['Forecasted Quantity'] ?? r.row['virtual_available'] ?? '');
      low.push({
        name: r.name,
        qtyOnHand: qty,
        freeToUse: isNaN(freeRaw) ? undefined : freeRaw,
        forecasted: isNaN(foreRaw) ? undefined : foreRaw,
      });
    }
  }
  // 库存越低越靠前
  low.sort((a, b) => a.qtyOnHand - b.qtyOnHand);
  job.lowStockItems = low;

  progress(job, `筛选完成：${low.length} 个低于阈值 ${job.threshold}`);
  emit(job.jobId, 'low-stock', {
    totalCleaned: job.totalCleaned,
    lowStockCount: low.length,
    items: low,
  });
}

// ==================================================================
//  趋势查验
// ==================================================================

/** 启动趋势任务（借用 worker） */
function startTrend(job: InventoryJob): void {
  if (job.status !== 'running') return;
  const items = (job.lowStockItems ?? []).map((i) => i.name);
  if (items.length === 0) {
    // 无低库存项 → 直接分类完成
    classifyAndComplete(job);
    return;
  }

  setPhase(job, 'trend');
  if (!isWorkerConnected()) {
    progress(job, '等待 auto worker 上线后开始趋势查验…');
  } else {
    progress(job, `开始趋势查验（共 ${items.length} 项）`);
  }

  const taskId = enqueueInventoryTask(
    'inventory-trend',
    {
      onProgress: (message) => progress(job, message),
      onComplete: (result) => {
        try {
          const r = (result ?? {}) as { items?: TrendResultDTO[] };
          job.trendResults = r.items ?? [];
          classifyAndComplete(job);
        } catch (err) {
          failJob(job, `趋势结果解析失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onFailed: (error) => failJob(job, `趋势查验失败：${error}`),
    },
    items,
  );
  job.trendTaskId = taskId;
}

// ==================================================================
//  分类
// ==================================================================

/** 计算净变化并分桶，标记完成 */
function classifyAndComplete(job: InventoryJob): void {
  setPhase(job, 'classifying');

  const trendByName = new Map<string, TrendResultDTO>();
  for (const t of job.trendResults ?? []) trendByName.set(t.name, t);

  const warning: ClassifiedItem[] = [];
  const reminder: ClassifiedItem[] = [];
  const info: ClassifiedItem[] = [];

  for (const item of job.lowStockItems ?? []) {
    const trend = trendByName.get(item.name);
    const moves = trend?.moves ?? [];
    let net = 0;
    for (const m of moves) net += m.dir === 'in' ? m.qty : -m.qty;
    const ci: ClassifiedItem = { ...item, net };
    if (net <= -job.trendThreshold) warning.push(ci);
    else if (net < 0) reminder.push(ci);
    else info.push(ci);
  }

  warning.sort((a, b) => a.net - b.net);
  reminder.sort((a, b) => a.net - b.net);
  info.sort((a, b) => a.qtyOnHand - b.qtyOnHand);

  const noAttentionCount = (job.totalCleaned ?? 0) - (job.lowStockItems ?? []).length;

  job.classification = { warning, reminder, info, noAttentionCount };
  job.status = 'completed';
  job.phase = 'completed';

  progress(job, `分类完成：警告 ${warning.length} / 提醒 ${reminder.length} / 信息 ${info.length} / 无需注意 ${noAttentionCount}`);
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
): string {
  const job: InventoryJob = {
    jobId: randomUUID(),
    userId,
    username,
    mode: 'auto',
    threshold,
    trendThreshold,
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
        cleanAndFilter(job, csv);
        // 自动衔接趋势查验
        startTrend(job);
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
): string {
  const job: InventoryJob = {
    jobId: randomUUID(),
    userId,
    username,
    mode: 'upload',
    threshold,
    trendThreshold,
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

  // 自动衔接趋势查验
  startTrend(job);
  return job.jobId;
}

/** 取 job 快照（供 SSE 初始推送 / GET 查询用） */
export function getJobSnapshot(jobId: string): JobSnapshot | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const { online } = getAutoOnlineState();
  return {
    jobId: job.jobId,
    mode: job.mode,
    phase: job.phase,
    status: job.status,
    threshold: job.threshold,
    trendThreshold: job.trendThreshold,
    autoOnline: online,
    totalCleaned: job.totalCleaned,
    lowStockCount: job.lowStockItems?.length,
    lowStockItems: job.lowStockItems,
    classification: job.classification,
    error: job.error,
    lastProgress: job.lastProgress,
  };
}

/** 取消 job（中止在途 worker 任务） */
export function cancelJob(jobId: string, userId: number): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.userId !== userId) return false;
  if (job.status !== 'running') return false;

  // 中止在途任务（download 或 trend）
  if (job.trendTaskId) abortInventoryTask(job.trendTaskId);
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
