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
  // #region 地柜辅料
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

  // #region 隔断与空白
  it('地柜中间夹 gap：QR 含 4 个侧深，SM 含 4 个地柜高', () => {
    const wall = makeWall({
      width: 75,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 15, items: [makeItem({ category: 'gap', sku: 'gap' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    expect(qty(result, '14B15')).toBe(2);
    // TK：正面 30 + 30 = 60 → ceil = 1
    expect(lenOf(result, '14TK')).toBe(30+30);
    expect(qty(result, '14TK')).toBe(1);
    // QR：正面 30 + 30 + 4 侧 4×24 = 156 → ceil = 2
    expect(lenOf(result, '14QR')).toBe(30+30+4*24);
    expect(qty(result, '14QR')).toBe(2);
    // SM：4 侧 4×34.5 = 138 → ceil = 2
    expect(lenOf(result, '14SM')).toBe(138);
    expect(qty(result, '14QR')).toBe(2);
    // BEP：4 个外露侧
    expect(qty(result, '14BEP')).toBe(4);
  });

  it('stuffed_gap 不进清单但触发外露', () => {
    const wall = makeWall({
      width: 75,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 15, items: [makeItem({ category: 'stuffed_gap', sku: 'stuffed_gap' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // stuffed_gap 不进原始产品行
    expect(result.items.find((i) => i.sku === 'stuffed_gap')).toBeUndefined();
    // 两侧地柜各 1
    expect(qty(result, '14B15')).toBe(2);
    // TK：正面 30 + 30 = 60 → ceil = 1
    expect(lenOf(result, '14TK')).toBe(30+30);
    expect(qty(result, '14TK')).toBe(1);
    // QR：正面 30 + 30 + 4 侧 4×24 = 156 → ceil = 2
    expect(lenOf(result, '14QR')).toBe(30+30+4*24);
    expect(qty(result, '14QR')).toBe(2);
    // SM：4 侧 4×34.5 = 138 → ceil = 2
    expect(lenOf(result, '14SM')).toBe(138);
    expect(qty(result, '14QR')).toBe(2);
    // BEP：两端边缘 + 两侧朝 stuffed_gap = 4 外露侧
    expect(qty(result, '14BEP')).toBe(4);
  });

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

  // #region 吊柜
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
    expect(lenOf(result, '14SM')).toBe(120);
    expect(qty(result, '14SM')).toBe(2);
  });
  // #endregion

  // #region Vanity
  it('vanity 邻接：普通地柜侧加 BEP，vanity 外侧加 VEP', () => {
    const wall = makeWall({
      width: 45,
      groundBlocks: [
        makeBlock({ width: 15, colorCode: '14', items: [makeItem({ sku: '14B15', isVanity: false })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ sku: '14V30', isVanity: true })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 普通地柜：左（边缘）+ 右（vanity 邻接）→ 2 BEP
    expect(qty(result, '14BEP')).toBe(2);
    // vanity：左（邻普通地柜，不外露）+ 右（边缘）→ 1 VEP
    expect(qty(result, '14VEP')).toBe(1);
    // TK: 普通和 vanity 都算
    expect(lenOf(result, '14TK')).toBe(15+30)
    // QR: 正面之合 + 向上升级的进深(21 → 24) * 2
    expect(lenOf(result, '14QR')).toBe(15+30+2*24)
    // SM: 两侧高
    expect(lenOf(result, '14SM')).toBe(34.5*2)
  });
  // #endregion

  // #region UNIPACK
  it('UNIPACK 颜色高柜侧板跳过（PNL3696Q 不产生）', () => {
    const tallItem = makeItem({ category: 'tall_cabinet', sku: '02UT', height: 96 });
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

  // #region 电器与框架
  it('DWP 贴墙边缘省略：exposedLeft=false → 仅 1 个 DWP', () => {
    const wall = makeWall({
      width: 51,
      exposedLeft: false,
      exposedRight: true,
      groundBlocks: [
        makeBlock({ width: 36, colorCode: '14', items: [makeItem({ category: 'base_appliance_need_top', sku: 'dishwasher' })] }),
        makeBlock({ width: 15, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 左侧贴墙且 exposedLeft=false → 省去左 DWP；右侧朝柜 → DWP 存在但框侧不外露
    expect(qty(result, '14DWP')).toBe(1);
    expect(qty(result, 'dishwasher')).toBe(0);
    // TK: 仅普通橱柜正面
    expect(lenOf(result, '14TK')).toBe(15)
    // QR: 仅普通橱柜正面+其侧面
    expect(lenOf(result, '14QR')).toBe(15+24)
    // SM: 仅普通橱柜那侧一个高
    expect(lenOf(result, '14SM')).toBe(34.5)
    // 仅普通橱柜那侧一个高
    expect(qty(result, '14BEP')).toBe(1);
  });

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
    // 无TK
    expect(lenOf(result, '14TK')).toBe(0)
    // QR: 仅侧面
    expect(lenOf(result, '14QR')).toBe(24)
    // SM: 仅一个侧面的整个高
    expect(lenOf(result, '14SM')).toBe(84+12)
    // 仅一个侧板
    expect(qty(result, '14PNL3696Q')).toBe(1);
  });

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

  // #region Filler 填充条
  it('filler 正常进清单（不紧邻电器时）', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 15, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'base_cabinet', sku: '14B15' })] }),
        makeBlock({ width: 15, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 进清单
    expect(qty(result, 'BF3')).toBe(2);
    // TK 包含 filler 的长度
    expect(lenOf(result, '14TK')).toBe(60);
    // QR 正面 60 + 2 侧 2×24, filler 的长度
    expect(lenOf(result, '14QR')).toBe(60+2*24);
    // filler 不产生额外 BEP → 2 BEP
    expect(qty(result, '14BEP')).toBe(2);
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

  it('filler 夹在普通地柜和 vanity 之间时普通地柜侧依然生成 BEP', () => {
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
      width: 48,
      groundBlocks: [
        makeBlock({ width: 15, colorCode: '14', items: [makeItem({ sku: '14B15' })] }),
        makeBlock({ width: 3, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'gap', sku: 'gap' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // 地柜：左边缘 + 右侧经 filler 朝 gap 外露
    expect(qty(result, '14BEP')).toBe(2);
    // TK 包含 filler 的长度
    expect(lenOf(result, '14TK')).toBe(15+3);
    // QR 正面 18 + 2 侧 2×24, filler 的长度
    expect(lenOf(result, '14QR')).toBe(15+3+2*24);
    // filler 不产生额外 BEP → 2 BEP
    expect(qty(result, '14BEP')).toBe(2);
  });

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

  it('filler 紧邻 base_appliance_need_top 被清除', () => {
    const wall = makeWall({
      width: 60,
      groundBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'base_appliance_need_top', sku: 'dishwasher' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'BF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 被清除
    expect(qty(result, 'BF3')).toBe(0);
    // DWP 辅料应正常生成
    expect(qty(result, '14DWP')).toBe(2);
  });
  // #endregion

  // #region CM（顶线）
  it('连续吊柜 CM：正面 + 两侧边缘', () => {
    const wall = makeWall({
      width: 60,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // CM：正面 30 + 30 + 两侧 2×12 = 84 → ceil = 1
    expect(lenOf(result, '14CM')).toBe(30+30+2*12);
    expect(qty(result, '14CM')).toBe(1);
    // SM: 两侧高
    expect(lenOf(result, '14SM')).toBe(30+30);
    expect(qty(result, '14SM')).toBe(1);
  });

  it('高柜 CM：进深 24', () => {
    const tallItem = makeItem({ category: 'tall_cabinet', sku: '14UT', height: 96 });
    const wall = makeWall({
      width: 30,
      airBlocks: [makeBlock({ width: 30, colorCode: '14', items: [tallItem] })],
      groundBlocks: [makeBlock({ width: 30, colorCode: '14', items: [{ ...tallItem }] })],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // CM：正面 30 + 两侧 2×24 = 78 → ceil = 1
    expect(lenOf(result, '14CM')).toBe(30+2*24);
    expect(qty(result, '14CM')).toBe(1);
    // SM: 两侧高
    expect(lenOf(result, '14SM')).toBe(96+96);
    expect(qty(result, '14SM')).toBe(2);
  });

  it('高柜+吊柜 CM：进深升级为 24', () => {
    const tallItem = makeItem({ category: 'tall_cabinet', sku: '14UT', height: 96 });
    const wall = makeWall({
      width: 60,
      airBlocks: [
        makeBlock({ width: 18, colorCode: '14', items: [tallItem] }),
        makeBlock({ width: 18, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
      groundBlocks: [makeBlock({ width: 30, colorCode: '14', items: [{ ...tallItem }] })],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // CM：正面 18 + 18 + 两侧升级为了 2×24
    expect(lenOf(result, '14CM')).toBe(18+18+2*24);
    // SM: 高柜两侧高+吊柜单侧
    expect(lenOf(result, '14SM')).toBe(96+96+30);
  });

  it('吊柜夹 gap：4 侧 CM', () => {
    const wall = makeWall({
      width: 90,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
        makeBlock({ width: 30, items: [makeItem({ category: 'gap', sku: 'gap' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // CM：正面 30 + 30 + 4 侧 4×12 = 108 → ceil = 2
    expect(lenOf(result, '14CM')).toBe(30+30+4*12);
    expect(qty(result, '14CM')).toBe(2);
  });

  it('吊柜夹 filler：filler 透明，仅 2 侧边缘 CM', () => {
    const wall = makeWall({
      width: 63,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
        makeBlock({ width: 3, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'AF3' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 计入正面：30 + 3 + 30 = 63
    // 两侧边缘外露 2×12 = 24（吊柜彼此透过 filler 相邻，不产生额外侧 CM）
    // Total: 63 + 24 = 87 → ceil = 1
    expect(lenOf(result, '14CM')).toBe(87);
    expect(qty(result, '14CM')).toBe(1);
  });

  it('边缘 filler + 吊柜：穿透 filler 触达墙边', () => {
    const wall = makeWall({
      width: 33,
      airBlocks: [
        makeBlock({ width: 3, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'AF3' })] }),
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // filler 正面 3 + 吊柜正面 30 = 33
    // 吊柜左侧经 filler 到外露墙边 → 侧 CM 12
    // 吊柜右侧本身在外露墙边 → 侧 CM 12
    // Total: 33 + 24 = 57 → ceil = 1
    expect(lenOf(result, '14CM')).toBe(57);
    expect(qty(result, '14CM')).toBe(1);
  });

  it('高电器 + 叠放吊柜 CM：进深 24', () => {
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

    // CM：正面 30 + 左侧 24 = 54 → ceil = 1（右侧贴墙且不外露，无侧 CM）
    expect(lenOf(result, '14CM')).toBe(54);
    expect(qty(result, '14CM')).toBe(1);
  });

  it('exposedBack 时背面 CM 计入', () => {
    const wall = makeWall({
      width: 30,
      exposedLeft: false,
      exposedRight: false,
      exposedBack: true,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'wall_cabinet', sku: '14W30', height: 30 })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // CM：正面 30 + 背面 30 = 60 → ceil = 1（两侧不露边）
    expect(lenOf(result, '14CM')).toBe(60);
    expect(qty(result, '14CM')).toBe(1);
  });

  it('单独 filler air：正面计入，无侧 CM', () => {
    const wall = makeWall({
      width: 30,
      airBlocks: [
        makeBlock({ width: 30, colorCode: '14', items: [makeItem({ category: 'filler', sku: 'AF3' })] }),
      ],
    });
    const result = generateMaterialList(makeLayout([wall]));

    // CM：仅正面 30，两侧 !isFiller 守卫 → 无侧 CM
    expect(lenOf(result, '14CM')).toBe(30);
    expect(qty(result, '14CM')).toBe(1);
  });
  // #endregion
});
