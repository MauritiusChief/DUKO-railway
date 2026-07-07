/**
 * layout-material-list 单元测试
 *
 * 纯函数测试，不依赖 Express / 数据库。
 * 覆盖计划中的 11 个用例：连续 run / gap / window / vanity / UNIPACK /
 * DWP / RRP / 取整 / 缺色等核心场景。
 */

import { describe, it, expect } from 'vitest';
import {
  generateMaterialList,
  type MaterialListResult,
} from './layout-material-list.js';
import type {
  LayoutDocument,
  LayoutWall,
  SectionBlock,
  BlockItem,
} from '../types/layout.js';

// ==================================================================
//  测试辅助工厂
// ==================================================================

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${idCounter++}`;
}

function makeItem(overrides: Partial<BlockItem> = {}): BlockItem {
  return {
    id: nextId('item'),
    category: 'base_cabinet',
    sku: '14B15',
    ...overrides,
  };
}

function makeBlock(overrides: Partial<SectionBlock> = {}): SectionBlock {
  return {
    id: nextId('block'),
    width: 30,
    items: [makeItem()],
    colorCode: '14',
    ...overrides,
  };
}

function makeWall(overrides: Partial<LayoutWall> = {}): LayoutWall {
  return {
    id: nextId('wall'),
    name: 'Wall',
    width: 120,
    exposedLeft: true,
    exposedRight: true,
    exposedBack: false,
    airBlocks: [],
    groundBlocks: [],
    connectedWallIds: [],
    backToBackIslandIds: [],
    ...overrides,
  };
}

function makeLayout(walls: LayoutWall[]): LayoutDocument {
  return {
    id: nextId('layout'),
    walls,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

/** 取结果中指定 SKU 的数量，不存在返回 0 */
function qty(result: MaterialListResult, sku: string): number {
  return result.items.find((i) => i.sku === sku)?.quantity ?? 0;
}

/** 取 lengthDetails 中指定 SKU 的原始长度，不存在返回 0 */
function lenOf(result: MaterialListResult, sku: string): number {
  return result.lengthDetails.find((d) => d.sku === sku)?.length ?? 0;
}

// ==================================================================
//  测试用例
// ==================================================================

describe('generateMaterialList', () => {
  // #region 1. 连续地柜 run
  it('1. 连续地柜 run：原始行 + TK + QR + SM + BEP', () => {
    const wall = makeWall({
      width: 90,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 原始行：3 个地柜
    expect(qty(result, '14B15')).toBe(3);
    // TK：90" → ceil(90/96) = 1
    expect(qty(result, '14TK')).toBe(1);
    // QR：正面 90 + 两侧 2×24 = 138 → ceil = 2
    expect(qty(result, '14QR')).toBe(2);
    // SM：两侧 2×34.5 = 69 → ceil = 1
    expect(qty(result, '14SM')).toBe(1);
    // BEP：两端各 1
    expect(qty(result, '14BEP')).toBe(2);
    // lengthDetails：原始长度（ceil 前）
    expect(lenOf(result, '14TK')).toBe(90);
    expect(lenOf(result, '14QR')).toBe(138);
    expect(lenOf(result, '14SM')).toBe(69);
  });
  // #endregion

  // #region 2. 地柜中间夹 gap
  it('2. 地柜中间夹 gap：QR 含 4 个侧深，SM 含 4 个地柜高', () => {
    const wall = makeWall({
      width: 90,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'gap', sku: 'gap' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    expect(qty(result, '14B15')).toBe(2);
    // QR：正面 60 + 4 侧 4×24 = 156 → ceil = 2
    expect(qty(result, '14QR')).toBe(2);
    // SM：4 侧 4×34.5 = 138 → ceil = 2
    expect(qty(result, '14SM')).toBe(2);
    // BEP：4 个外露侧
    expect(qty(result, '14BEP')).toBe(4);
  });
  // #endregion

  // #region 3. 吊柜夹 window
  it('3. 吊柜夹 window：WEP 朝窗侧 + SM 侧高', () => {
    const wall = makeWall({
      width: 90,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'window', sku: 'window' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    expect(qty(result, '14W30')).toBe(2);
    // WEP：4 个外露侧（两端边缘 + 两侧朝窗）
    expect(qty(result, '14WEP')).toBe(4);
    // SM：4 侧 4×30 = 120 → ceil = 2
    expect(qty(result, '14SM')).toBe(2);
  });
  // #endregion

  // #region 4. vanity 邻接
  it('4. vanity 邻接：普通地柜侧加 BEP，vanity 外侧加 VEP', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15', isVanity: false })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14V30', isVanity: true })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 普通地柜：左（边缘）+ 右（vanity 邻接）→ 2 BEP
    expect(qty(result, '14BEP')).toBe(2);
    // vanity：左（邻普通地柜，不外露）+ 右（边缘）→ 1 VEP
    expect(qty(result, '14VEP')).toBe(1);
  });
  // #endregion

  // #region 5. UNIPACK 柜体侧板跳过
  it('5. UNIPACK 颜色高柜侧板跳过（PNL3696Q 不产生）', () => {
    const tallItem = makeItem({ category: 'tall_cabinet', sku: '02T96', height: 96 });
    const wall = makeWall({
      width: 30,
      exposedLeft: true,
      exposedRight: true,
      airBlocks: [makeBlock({ width: 30, colorCode: '02', items: [tallItem] })],
      groundBlocks: [makeBlock({ width: 30, colorCode: '02', items: [{ ...tallItem }] })],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // UNIPACK 颜色 → 柜体侧板跳过
    expect(qty(result, '02PNL3696Q')).toBe(0);
    expect(qty(result, 'PNL3696Q')).toBe(0);
    expect(result.text).not.toContain('PNL3696Q');
  });
  // #endregion

  // #region 6. UNIPACK DWP 框侧仍用 PNL3696Q
  it('6. UNIPACK 颜色 DWP 框侧仍用 PNL3696Q', () => {
    const wall = makeWall({
      width: 30,
      exposedLeft: true,
      exposedRight: true,
      groundBlocks: [
        makeBlock({
          width: 30,
          colorCode: '02',
          items: [makeItem({ category: 'base_appliance_need_top', sku: '02DWPA' })],
        }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // DWP：两侧均存在 → 2
    expect(qty(result, '02DWP')).toBe(2);
    // 框侧板：UNIPACK → PNL3696Q，两侧外露 → 2
    expect(qty(result, '02PNL3696Q')).toBe(2);
  });
  // #endregion

  // #region 7. DWP 贴墙边缘省略
  it('7. DWP 贴墙边缘省略：exposedLeft=false → 仅 1 个 DWP', () => {
    const wall = makeWall({
      width: 60,
      exposedLeft: false,
      exposedRight: true,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'base_appliance_need_top', sku: '14DWPA' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 左侧贴墙且 exposedLeft=false → 省去左 DWP；右侧朝柜 → DWP 存在但框侧不外露
    expect(qty(result, '14DWP')).toBe(1);
  });
  // #endregion

  // #region 8. 通天电器无叠放
  it('8. 通天电器无叠放：无 RRP', () => {
    const tallApp = makeItem({ category: 'tall_appliance', sku: '14TF', height: 84 });
    const wall = makeWall({
      width: 30,
      airBlocks: [makeBlock({ width: 30, colorCode: '14', items: [tallApp] })],
      groundBlocks: [makeBlock({ width: 30, colorCode: '14', items: [{ ...tallApp }] })],
    });
    const result = generateMaterialList(makeLayout([wall]));

    expect(qty(result, '14TF')).toBe(1);
    expect(qty(result, '14RRP')).toBe(0);
    expect(result.text).not.toContain('RRP');
  });
  // #endregion

  // #region 9. 通天电器 + 叠放吊柜 + 贴右墙
  it('9. 通天电器 + 叠放吊柜 + 贴右墙：仅 1 个 RRP', () => {
    const tallApp = makeItem({ category: 'tall_appliance', sku: '14TF', height: 84 });
    const stacked = makeItem({ category: 'wall_cabinet', sku: '14W24', height: 12 });
    const wall = makeWall({
      width: 30,
      exposedLeft: true,
      exposedRight: false,
      airBlocks: [makeBlock({ width: 30, colorCode: '14', items: [tallApp, stacked] })],
      groundBlocks: [makeBlock({ width: 30, colorCode: '14', items: [{ ...tallApp }] })],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 左侧外露 → RRP 存在；右侧贴墙 exposedRight=false → 省去
    expect(qty(result, '14RRP')).toBe(1);
  });
  // #endregion

  // #region 10. 96 英寸取整
  it('10. 96 英寸取整：长度 97 → 数量 2', () => {
    const wall = makeWall({
      width: 97,
      exposedLeft: false,
      exposedRight: false,
      groundBlocks: [
        makeBlock({ width: 97, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // TK：97" → ceil(97/96) = 2
    expect(qty(result, '14TK')).toBe(2);
  });
  // #endregion

  // #region 11. 缺色行为
  it('11. 缺色：BEP 无颜色前缀，不按 UNIPACK 跳过', () => {
    const wall = makeWall({
      width: 30,
      exposedLeft: true,
      exposedRight: true,
      groundBlocks: [
        makeBlock({
          width: 30,
          colorCode: '',
          items: [makeItem({ sku: '02B15' })], // sku 以 02 开头但 colorCode 为空
        }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 缺色 → BEP 无前缀；两端外露 → 2
    expect(qty(result, 'BEP')).toBe(2);
    // 不应出现带颜色的 02BEP
    expect(qty(result, '02BEP')).toBe(0);
    // 缺色应产生 warning
    expect(result.warnings.length).toBeGreaterThan(0);
    // 原始行仍用 sku 原样
    expect(qty(result, '02B15')).toBe(1);
  });
  // #endregion
});
