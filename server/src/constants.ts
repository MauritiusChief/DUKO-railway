
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

// 换色配件：在 /generate-products 步骤中，将指定颜色的配件重映射到参考颜色
// 29 (美式) 使用 02 的配件，32 (欧式) 使用 12 的配件
export const NONE_EURO_COLOR_MAPPED_SHAPE_TYPE_CODES = new Set(['CM', 'ACM', 'CCM', 'OCM', 'PNL', 'SK', 'SM', 'TK', 'BM']);
export const EURO_COLOR_MAPPED_SHAPE_TYPE_CODES = new Set(['CM', 'ACM', 'CCM', 'OCM', 'SM', 'TK', 'BM']);
export const ACCESSORY_COLOR_REMAP: Record<string, string> = { '29': '02', '32': '12' };

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
