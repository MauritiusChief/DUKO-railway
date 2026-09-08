import type { BlockItemCategory } from './types/layout.js';

export const AMERICAN_STYLE_CODES = ["14", "15", "16", "17", "25", "27", "28", "29", "12", "13", "23", "24", "26", "11"]
export const EUROPEAN_STYLE_CODES = ["32", "37", "38", "42", "34", "52", "54", "60"]
export const UNIPACK_STYLE_CODES  = ["02", "04"]

/** 最终产品型号颜色前缀 → 折扣百分比（%） */
export const COLOR_DISCOUNT_PERCENT: Record<string, number> = {
  '02': 10,
  '04': 10,
  '11': 10,
  '15': 15,
  '16': 15,
  '27': 15,
  '29': 15,
}

/**
 * 根据最终输出产品型号推导折扣百分比。
 * 规则：取型号前两位作为颜色代码查 COLOR_DISCOUNT_PERCENT；
 * 10/30 柜体、无颜色前缀或不在映射中的颜色一律不打折（返回 undefined）。
 * 该判断在 sharedPartName（最终产品型号）之上执行，因此 29→02 等
 * 重映射后的最终产品按其实际输出型号的折扣档位处理。
 */
export function getDiscountPercent(productName: string): number | undefined {
  const prefix = productName.substring(0, 2);
  return COLOR_DISCOUNT_PERCENT[prefix];
}

export const NONE_EURO_STYLE_CODES = [...AMERICAN_STYLE_CODES, ...UNIPACK_STYLE_CODES]

export const ALL_STYLE_CODES = new Set([...AMERICAN_STYLE_CODES, ...EUROPEAN_STYLE_CODES, ...UNIPACK_STYLE_CODES]);

export const ACCESSORY_SHAPE_TYPE_CODES = [
  // FILLER
  "BF",
  "WF",
  "TF",
  "RF",

  // MOLDING
  "TK",
  "BM",
  "LM",
  "SM",
  "OCM",
  "CM",
  "ACM",
  "CCM",
  "QR",

  // PANEL
  "SK",
  "PNL",
  "IEP",
  "DWP",
  "WEP",
  "BEP",

  // MISC
  "VAL",
  "CP",
  "CBL",
  "TUK",
  "WDD",
  "BDD",
  "VDD",
  "GH",
  "TCR",

  // 玻璃门
  "GD",
];

// 颜色重映射规则已迁移至 services/sku-derive.ts 的 COLOR_REMAP_RULES，
// 在 Parts 表层面将源色件（29/32）解析到目标色件（02/12）。

// Shape types whose color field can be N/A (not tied to any specific color/finish)
export const SHAPE_TYPES_COLOR_NA = new Set([
  "GD",  // Glass Doors — no color
  "TCR", // Trash Can Rollout — no color
]);

// Shape types whose size field can be N/A (no meaningful size distinction)
export const SHAPE_TYPES_SIZE_NA = new Set([
  "GD",  // Glass Doors — no size
  "CBL", // Corbel — no size
  "TUK", // Touch up kit — no size
  "SD",  // Sample Door — no size
]);

/**
 * Layout 物品分类表 —— 按 BlockItemCategory 分组的 shapeTypeCode 列表
 *
 * 仅收录会作为布局块（block）出现的 DUKO 产柜体/填充条/开放性商品。
 * 配件（molding/panel/post/corbel/decor door 等）与非 DUKO 产电器
 * （冰箱/洗碗机/灶台/抽油烟机/窗户）不在此表：
 *   - 配件不作为布局块，不参与 air/ground 轨道编排；
 *   - 电器多按名称（如 "refrigerator"）由 LLM 判定分类；
 *   - 纯空位（gap / stuffed_gap）无对应 shapeTypeCode。
 *
 * 该表是分类的单一真相源：lookupItemCategory 工具反向查表，layout ocr agent
 * 的形状代码分类对照表也由它 + exposed_types 描述拼接生成。
 */
export const LAYOUT_CATEGORY_BY_SHAPE_TYPE: Readonly<Record<BlockItemCategory, readonly string[]>> = {
  // air 轨
  wall_cabinet: ['W', 'WBC', 'WDC', 'WER', 'WMC'],

  // ground 轨（Vanity 系列配合 insertItem 的 isVanity）
  base_cabinet: ['B', 'BBC', 'BLS', 'BMC', 'BSR', 'CSB', 'NCSB', 'DB', 'FSB', 'SB', 'VC', 'VDB', 'VSB', 'VSD', 'VSDB'],

  // air + ground 双轨
  tall_cabinet: ['UT', 'OV'],

  // 以下分类无对应 shapeTypeCode —— 纯空位或非 DUKO 产电器，按名称/位置判定
  gap: [],
  stuffed_gap: [],

  // air / ground（进清单但两侧遮挡不住）
  gaplike_item: ['VAL', 'GH', 'WES', 'WR', 'BES', 'PR'],

  // air / ground / air + ground
  filler: ['BF', 'WF', 'TF', 'RF'],

  // 以下电器分类无对应 DUKO 产 shapeTypeCode，按名称判定
  tall_appliance: [],
  base_appliance_need_top: [],
  base_appliance_without_top: [],
};
