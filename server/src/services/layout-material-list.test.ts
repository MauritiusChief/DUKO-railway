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
  // #region 连续地柜 run
  it('连续地柜 run：原始行 + TK + QR + SM + BEP', () => {
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

  // #region 地柜中间夹 gap
  it('地柜中间夹 gap：QR 含 4 个侧深，SM 含 4 个地柜高', () => {
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

  // #region 吊柜夹 window
  it('吊柜夹 window：WEP 朝窗侧 + SM 侧高', () => {
    const wall = makeWall({
      width: 90,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'stuffed_gap', sku: 'window' })] }),
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

  // #region vanity 邻接
  it('vanity 邻接：普通地柜侧加 BEP，vanity 外侧加 VEP', () => {
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

  // #region UNIPACK 柜体侧板跳过
  it('UNIPACK 颜色高柜侧板跳过（PNL3696Q 不产生）', () => {
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

  // #region UNIPACK DWP 框侧仍用 PNL3696Q
  it('UNIPACK 颜色 DWP 框侧仍用 PNL3696Q', () => {
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

  // #region DWP 贴墙边缘省略
  it('DWP 贴墙边缘省略：exposedLeft=false → 仅 1 个 DWP', () => {
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
    expect(qty(result, '14DWPA')).toBe(0);
  });
  // #endregion

  // #region 高电器无叠放
  it('高电器无叠放：无 RRP', () => {
    const tallApp = makeItem({ category: 'tall_appliance', sku: 'REF', height: 84 });
    const wall = makeWall({
      width: 30,
      airBlocks: [makeBlock({ width: 30, colorCode: '14', items: [tallApp] })],
      groundBlocks: [makeBlock({ width: 30, colorCode: '14', items: [{ ...tallApp }] })],
    });
    const result = generateMaterialList(makeLayout([wall]));

    expect(qty(result, 'REF')).toBe(0);
    expect(qty(result, '14RRP')).toBe(0);
    expect(result.text).not.toContain('RRP');
  });
  // #endregion

  // #region 高电器 + 叠放吊柜 + 贴右墙
  it('高电器 + 叠放吊柜 + 贴右墙：仅 1 个 RRP', () => {
    const tallApp = makeItem({ category: 'tall_appliance', sku: 'REF', height: 84 });
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
    expect(qty(result, 'REF')).toBe(0);
  });
  // #endregion

  // #region 96 英寸取整
  it('96 英寸取整：长度 97 → 数量 2', () => {
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

  // #region 缺色行为
  it('缺色：BEP 无颜色前缀，不按 UNIPACK 跳过', () => {
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

  // #region stuffed_gap 不进清单但触发外露
  it('stuffed_gap 不进清单但触发外露', () => {
    const wall = makeWall({
      width: 90,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'stuffed_gap', sku: 'stuffed_gap' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // stuffed_gap 不进原始产品行
    expect(result.items.find((i) => i.sku === 'stuffed_gap')).toBeUndefined();
    // 两侧地柜各 1
    expect(qty(result, '14B15')).toBe(2);
    // BEP：两端边缘 + 两侧朝 stuffed_gap = 4 外露侧
    expect(qty(result, '14BEP')).toBe(4);
  });
  // #endregion

  // #region gaplike_item 进清单且两侧不遮挡
  it('gaplike_item 进清单且两侧不遮挡', () => {
    const wall = makeWall({
      width: 90,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'gaplike_item', sku: 'VAL' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // gaplike_item 进清单
    expect(qty(result, 'VAL')).toBe(1);
    // BEP：4 个外露侧（两端边缘 + 两侧朝 gaplike_item，因为 gaplike_item 不挡两侧）
    expect(qty(result, '14BEP')).toBe(4);
    // 无颜色分类不应产生 warning
    const colorWarnings = result.warnings.filter((w) => w.includes('VAL'));
    expect(colorWarnings.length).toBe(0);
  });
  // #endregion

  // #region filler 默认进清单
  it('filler 正常进清单（不紧邻电器时）', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 进清单
    expect(qty(result, 'BF3')).toBe(2);
  });

  it('边缘 filler 后的地柜按有效边缘生成 BEP', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'base_cabinet', sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 在侧板判断中透明：地柜左侧经 filler 到外露墙边，右侧本身在外露墙边
    expect(qty(result, '14BEP')).toBe(2);
  });

  it('单一 filler 不合理，不生成 BEP', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 没有 BEP 生成
    expect(qty(result, '14BEP')).toBe(0);
  });

  it('filler 夹在普通地柜和 vanity 之间时普通地柜侧生成 BEP', () => {
    const wall = makeWall({
      width: 90,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15', isVanity: false })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14V30', isVanity: true })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 普通地柜：左边缘 + 右侧经 filler 邻 vanity
    expect(qty(result, '14BEP')).toBe(2);
    // vanity：右边缘；左侧经 filler 邻普通地柜不算外露
    expect(qty(result, '14VEP')).toBe(1);
  });

  it('filler 夹在地柜和 gap 之间时地柜朝 gap 侧生成 BEP', () => {
    const wall = makeWall({
      width: 90,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'gap', sku: 'gap' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 地柜：左边缘 + 右侧经 filler 朝 gap 外露
    expect(qty(result, '14BEP')).toBe(2);
  });
  // #endregion

  // #region filler 紧邻 tall_appliance 被清除
  it('filler 紧邻 tall_appliance 被清除', () => {
    const tallApp = makeItem({ category: 'tall_appliance', sku: 'refrigerator', height: 84 });
    const wall = makeWall({
      width: 60,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [tallApp] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'TF3' })] }),
      ],
      groundBlocks: [
        makeBlock({ width: 30, items: [{ ...tallApp }] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'filler', sku: 'TF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 原始产品行不应用 filler 出现
    expect(qty(result, 'TF3')).toBe(0);
    // 高电器不应在清单中，因为其不是实际售卖的产品
    expect(qty(result, 'refrigerator')).toBe(0);
  });
  // #endregion

  // #region filler 紧邻 base_appliance_need_top 被清除
  it('filler 紧邻 base_appliance_need_top 被清除', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'base_appliance_need_top', sku: '14DWPA' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 被清除
    expect(qty(result, 'BF3')).toBe(0);
    // DWP 辅料应正常生成
    expect(qty(result, '14DWP')).toBeGreaterThan(0);
  });
  // #endregion

  // #region 电器缺色不报警
  it('电器缺色不报警', () => {
    const wall = makeWall({
      width: 30,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '', items: [makeItem({ category: 'tall_appliance', sku: 'refrigerator', height: 84 })] }),
      ],
      airBlocks: [
        makeBlock({ width: 30, colorCode: '', items: [makeItem({ category: 'tall_appliance', sku: 'refrigerator', height: 84 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 电器缺色不应产生 warning
    const colorWarnings = result.warnings.filter((w) => w.includes('颜色'));
    expect(colorWarnings.length).toBe(0);
  });
  // #endregion
});
