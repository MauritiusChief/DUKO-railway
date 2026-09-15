/**
 * moves-sync 截止时间计算单元测试（cutoff 计算矩阵）
 *
 * 纯函数测试，不依赖 Express / 数据库 / worker。
 */

import { describe, it, expect } from 'vitest';
import {
  computeMovesSyncCutoff,
  monthsAgoTs,
  MOVES_SYNC_OVERLAP_MS,
} from './moves-sync-cutoff.js';

const NOW = new Date(2026, 8, 15, 10, 0, 0).getTime();

describe('computeMovesSyncCutoff', () => {
  it('fast + 水位线存在 → 水位线 − 48h，mode=fast', () => {
    const watermark = NOW - 3_600_000;
    expect(computeMovesSyncCutoff(true, watermark, 3, NOW)).toEqual({
      cutoffTs: watermark - MOVES_SYNC_OVERLAP_MS,
      mode: 'fast',
    });
  });

  it('fast + 首次导入（水位线 null）→ now − recentMonths − 48h，mode=full', () => {
    expect(computeMovesSyncCutoff(true, null, 3, NOW)).toEqual({
      cutoffTs: monthsAgoTs(3, NOW) - MOVES_SYNC_OVERLAP_MS,
      mode: 'full',
    });
  });

  it('全量（fastMode=false）无视水位线 → now − recentMonths − 48h，mode=full', () => {
    const watermark = NOW - 1000;
    expect(computeMovesSyncCutoff(false, watermark, 3, NOW)).toEqual({
      cutoffTs: monthsAgoTs(3, NOW) - MOVES_SYNC_OVERLAP_MS,
      mode: 'full',
    });
  });

  it('recentMonths 参与窗口计算（2026-09-15 往前 6 个月 = 2026-03-15）', () => {
    expect(monthsAgoTs(6, NOW)).toBe(new Date(2026, 2, 15, 10, 0, 0).getTime());
  });

  it('48h 重叠窗口常量为 172800000 ms', () => {
    expect(MOVES_SYNC_OVERLAP_MS).toBe(48 * 60 * 60 * 1000);
  });
});
