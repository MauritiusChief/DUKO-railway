/**
 * 折扣推导规则单元测试
 *
 * 纯函数测试：getDiscountPercent 只依赖最终输出产品型号的颜色前缀，
 * 不依赖 Express / 数据库。
 */

import { describe, it, expect } from 'vitest';
import { getDiscountPercent } from './constants.js';

describe('getDiscountPercent', () => {
  it('10% 颜色：02 / 04 / 11', () => {
    expect(getDiscountPercent('02B12')).toBe(10);
    expect(getDiscountPercent('04B15-D')).toBe(10);
    expect(getDiscountPercent('11W30')).toBe(10);
  });

  it('15% 颜色：15 / 16 / 27 / 29', () => {
    expect(getDiscountPercent('15B15')).toBe(15);
    expect(getDiscountPercent('16BLS33')).toBe(15);
    expect(getDiscountPercent('27W18')).toBe(15);
    expect(getDiscountPercent('29VC30L')).toBe(15);
  });

  it('10/30 柜体（无颜色码）不打折', () => {
    expect(getDiscountPercent('10B12')).toBeUndefined();
    expect(getDiscountPercent('10BLS-Tray')).toBeUndefined();
    expect(getDiscountPercent('30VC30L-C')).toBeUndefined();
  });

  it('其他颜色不打折', () => {
    expect(getDiscountPercent('14B15')).toBeUndefined();
    expect(getDiscountPercent('32VC30L')).toBeUndefined();
    expect(getDiscountPercent('52W30')).toBeUndefined();
  });

  it('无颜色前缀的产品（配件/白名单）不打折', () => {
    expect(getDiscountPercent('Glass Doors')).toBeUndefined();
    expect(getDiscountPercent('TCR15_Wood Tray')).toBeUndefined();
    expect(getDiscountPercent('BF3')).toBeUndefined();
    expect(getDiscountPercent('')).toBeUndefined();
  });
});
