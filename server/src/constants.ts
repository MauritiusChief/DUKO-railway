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
 * Layout 物品分类表 —— shapeTypeCode -> BlockItemCategory
 *
 * 仅收录会作为布局块（block）出现的 DUKO 产柜体/填充条/开放性商品。
 * 配件（molding/panel/post/corbel/decor door 等）与非 DUKO 产电器
 * （冰箱/洗碗机/灶台/抽油烟机/窗户）不在此表：
 *   - 配件不作为布局块，不参与 air/ground 轨道编排；
 *   - 电器多按名称（如 "refrigerator"）由 LLM 判定分类；
 *   - 纯空位（gap / stuffed_gap）无对应 shapeTypeCode。
 *
 * 该表供 lookupItemCategory 工具查询，作为 LLM 插入物品前判定分类的权威依据。
 */
export const LAYOUT_CATEGORY_BY_SHAPE_TYPE: Readonly<Record<string, BlockItemCategory>> = {
  // wall_cabinet —— 吊柜（air）
  W: 'wall_cabinet',
  WBC: 'wall_cabinet',
  WDC: 'wall_cabinet',
  WER: 'wall_cabinet',
  WMC: 'wall_cabinet',

  // base_cabinet —— 地柜（ground），Vanity 系列配合 insertItem 的 isVanity
  B: 'base_cabinet',
  BBC: 'base_cabinet',
  BLS: 'base_cabinet',
  BMC: 'base_cabinet',
  BSR: 'base_cabinet',
  CSB: 'base_cabinet',
  NCSB: 'base_cabinet',
  DB: 'base_cabinet',
  FSB: 'base_cabinet',
  SB: 'base_cabinet',
  VC: 'base_cabinet',
  VDB: 'base_cabinet',
  VSB: 'base_cabinet',
  VSD: 'base_cabinet',
  VSDB: 'base_cabinet',

  // tall_cabinet —— 通天高柜（air + ground 双轨）
  UT: 'tall_cabinet',
  OV: 'tall_cabinet',

  // filler —— 填充条（air / ground）
  BF: 'filler',
  WF: 'filler',
  TF: 'filler',
  RF: 'filler',

  // gaplike_item —— 开放性商品：进清单但两侧遮挡不住（air / ground）
  VAL: 'gaplike_item',
  GH: 'gaplike_item',
  WES: 'gaplike_item',
  WR: 'gaplike_item',
  BES: 'gaplike_item',
  PR: 'gaplike_item',
};
