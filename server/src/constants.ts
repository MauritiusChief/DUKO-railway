import type { BlockItemCategory } from './types/layout.js';

export const AMERICAN_STYLE_CODES = ["14", "15", "16", "17", "25", "27", "28", "29", "12", "13", "23", "24", "26", "11"]
export const EUROPEAN_STYLE_CODES = ["32", "37", "38", "42", "34", "52", "54", "60"]
export const UNIPACK_STYLE_CODES  = ["02", "04"]

export const DISCOUNT_STYLE_CODES = ['02', '04', '15', '16', '27', '29']

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
