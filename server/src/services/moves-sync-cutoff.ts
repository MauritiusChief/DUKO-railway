/**
 * inventory-moves-sync 截止时间计算（纯函数，无副作用）
 *
 * cutoff 计算矩阵：
 *   fast + 水位线存在 → 水位线 − 48h（增量补齐，停点位于分界线已入库一侧）
 *   全量，或快速但首次导入（水位线 null）→ now − recentMonths − 48h
 *
 * 独立成模块以便单元测试（inventory.ts 会传递引入 ws-handler 等重依赖）。
 */

/** 快速补齐的安全重叠窗口：读到水位线 − 48h 为止（覆盖同秒时间戳碰撞） */
export const MOVES_SYNC_OVERLAP_MS = 48 * 60 * 60 * 1000;

/** 计算 recentMonths 个月前的本地时间戳（与 worker 侧日期解析同时钟域） */
export function monthsAgoTs(months: number, now: number = Date.now()): number {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

/**
 * 计算 moves-sync 的停止截止时间与模式。
 * @param fastMode job 的快速模式开关
 * @param watermark stock_moves 当前水位线（空表为 null）
 * @param recentMonths 全量检查窗口（月）
 * @param now 当前时间（可注入以便测试）
 */
export function computeMovesSyncCutoff(
  fastMode: boolean,
  watermark: number | null,
  recentMonths: number,
  now: number = Date.now(),
): { cutoffTs: number; mode: 'fast' | 'full' } {
  if (fastMode && watermark !== null) {
    return { cutoffTs: watermark - MOVES_SYNC_OVERLAP_MS, mode: 'fast' };
  }
  return { cutoffTs: monthsAgoTs(recentMonths, now) - MOVES_SYNC_OVERLAP_MS, mode: 'full' };
}
