
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
