/**
 * stock_moves 数据层单元测试
 *
 * 覆盖：UNIQUE 去重对账（inserted + ignored = 总行数）、水位线读取、
 * 窗口聚合的方向语义（与旧逐项 trend 流程一致，含主仓库内部移动边界）。
 * 使用临时目录的独立 SQLite 文件，不触碰真实 DB_DIR。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  initSkuDB,
  getSkuDb,
  insertStockMoves,
  getMovesWatermark,
  queryItemMoves,
  type StockMoveRow,
} from './sku.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-moves-test-'));
  initSkuDB(tmpDir);
});

afterAll(() => {
  getSkuDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 窗口起点（固定 epoch，避免依赖系统时间） */
const WINDOW_START = 1_750_000_000_000;
/** 晚于窗口起点的基准时间 */
const BASE_TS = WINDOW_START + 24 * 60 * 60 * 1000;

function makeRow(overrides: Partial<StockMoveRow> = {}): StockMoveRow {
  return {
    dateText: '06/01/2026 10:00:00',
    dateTs: BASE_TS,
    reference: 'WH/IN/0001',
    product: '14B15',
    lot: '',
    locationFrom: 'Partners/Vendors',
    locationTo: 'ATL/Stock',
    qty: 10,
    uom: 'Units',
    state: 'Done',
    ...overrides,
  };
}

// 放在最前：此时 stock_moves 必然为空表
describe('空表初始状态', () => {
  it('watermark 返回 null', () => {
    expect(getMovesWatermark()).toBeNull();
  });

  it('queryItemMoves 返回 0/0', () => {
    expect(queryItemMoves('ANY', WINDOW_START)).toEqual({ inbound: 0, outbound: 0 });
  });
});

describe('insertStockMoves 去重', () => {
  it('首次插入全部计入 inserted', () => {
    const stats = insertStockMoves([
      makeRow({ reference: 'T1/IN/0001' }),
      makeRow({
        reference: 'T1/OUT/0002',
        locationFrom: 'ATL/Stock',
        locationTo: 'Partners/Customers',
        qty: -4,
      }),
    ]);
    expect(stats).toEqual({ inserted: 2, ignored: 0 });
  });

  it('重复行静默跳过，inserted + ignored = 总行数', () => {
    const rows = [
      makeRow({ reference: 'T2/IN/0010' }),
      makeRow({ reference: 'T2/IN/0010' }),
      makeRow({ reference: 'T2/IN/0010', lot: 'L1' }),
    ];
    const stats = insertStockMoves(rows);
    // 三行共享同一 UNIQUE 组合键（lot 不参与），仅首行入库
    expect(stats.inserted).toBe(1);
    expect(stats.ignored).toBe(2);
    expect(stats.inserted + stats.ignored).toBe(rows.length);
  });

  it('lot 不参与 UNIQUE：同键不同 lot 视为重复', () => {
    insertStockMoves([makeRow({ reference: 'T3/IN/0020', lot: 'A' })]);
    const stats = insertStockMoves([makeRow({ reference: 'T3/IN/0020', lot: 'B' })]);
    expect(stats).toEqual({ inserted: 0, ignored: 1 });
  });

  it('同秒同单号不同起止库位视为不同行', () => {
    const stats = insertStockMoves([
      makeRow({ reference: 'T4/MOVE/0030' }),
      makeRow({
        reference: 'T4/MOVE/0030',
        locationFrom: 'ATL/Stock',
        locationTo: 'Partners/Customers',
        qty: -3,
      }),
    ]);
    expect(stats.inserted).toBe(2);
  });

  it('空数组返回零计数', () => {
    expect(insertStockMoves([])).toEqual({ inserted: 0, ignored: 0 });
  });
});

describe('getMovesWatermark', () => {
  it('返回已插入行中的最大 date_ts', () => {
    const lateTs = BASE_TS + 365 * 24 * 60 * 60 * 1000;
    insertStockMoves([
      makeRow({ reference: 'T5/IN/0040', dateTs: BASE_TS - 1000 }),
      makeRow({ reference: 'T5/IN/0041', dateTs: lateTs }),
    ]);
    expect(getMovesWatermark()).toBe(lateTs);
  });
});

describe('queryItemMoves 方向语义', () => {
  beforeAll(() => {
    insertStockMoves([
      // 入库：Vendors → ATL/Stock
      makeRow({ product: 'QATL-TEST', reference: 'T6/IN/0001', qty: 10, dateTs: BASE_TS }),
      // 出库：ATL/Stock → Customers（Odoo 显示负数数量，汇总取绝对值）
      makeRow({
        product: 'QATL-TEST',
        reference: 'T6/OUT/0002',
        locationFrom: 'ATL/Stock',
        locationTo: 'Partners/Customers',
        qty: -4,
        dateTs: BASE_TS,
      }),
      // 主仓库内部移动：dest 优先，只计入入库、不计入出库
      makeRow({
        product: 'QATL-TEST',
        reference: 'T6/MOVE/0003',
        locationFrom: 'ATL/Stock',
        locationTo: 'ATL/Stock',
        qty: 7,
        dateTs: BASE_TS,
      }),
      // 与主仓库无关的移动：不计数
      makeRow({
        product: 'QATL-TEST',
        reference: 'T6/TR/0004',
        locationFrom: 'Partners/Vendors',
        locationTo: 'Transit',
        qty: 100,
        dateTs: BASE_TS,
      }),
      // 窗口起点之前的行：不计数
      makeRow({
        product: 'QATL-TEST',
        reference: 'T6/OLD/0005',
        qty: 50,
        dateTs: WINDOW_START - 1,
      }),
      // 恰好落在窗口起点上的行：计入（>= 语义）
      makeRow({
        product: 'QATL-TEST',
        reference: 'T6/EDGE/0006',
        qty: 2,
        dateTs: WINDOW_START,
      }),
      // 其他产品的行：不影响 QATL-TEST 汇总
      makeRow({ product: 'OTHER-TEST', reference: 'T6/IN/0007', qty: 999, dateTs: BASE_TS }),
    ]);
  });

  it('入库 = dest 主仓库的 |qty| 求和；出库 = location 主仓库且 dest 非主仓库', () => {
    // inbound = 10（入库） + 7（内部移动） + 2（窗口边界） = 19；outbound = |-4| = 4
    expect(queryItemMoves('QATL-TEST', WINDOW_START)).toEqual({
      inbound: 19,
      outbound: 4,
    });
  });
});
