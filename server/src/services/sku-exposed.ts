/**
 * SKU 暴露物品表生成模块
 *
 * 从 Items.csv + Parts.csv 生成 Exposed-Items.csv：
 *   将物品的柜体/柜门/额外零件描述拼接成面向下游（向量检索、编辑距离）的
 *   可读文案，并支持多组动态注入规则（别名、组合物品等）。
 *
 * 数据流：
 *   Items.csv ─┐
 *              ├─▶ 描述拼接（Phase 1，普通物品）
 *   Parts.csv ─┘
 *              ─▶ 插入组合物品（Phase 2，凭空创建）
 *              ─▶ 排序 → Exposed-Items.csv
 *
 * 输出列（11 列）：
 *   itemName, colorCode, shapeTypeCode, shapeTypeAlias,
 *   shapeSizeCode, shapeSizeAlias, subItemsName,
 *   mainDescription, mainAlias, sizeDescription, otherDescription
 *
 * 描述拼接规则（普通物品）：
 *   mainDescription  = 柜体描述第一段，去掉 " - Carcass/Box Only"
 *   sizeDescription  = 柜体描述第二段
 *   otherDescription = 门描述第三段起全部；如有 extraPart 则额外拼接其完整描述
 *
 *   ⚠  UNIPACK 占位：Unipack（02/04）物品的柜体描述不含 " - Carcass/Box Only"，
 *   当前仍按以上分段规则解析，此行为非最终形态，后续需重新设计。
 *
 * 动态注入规则：
 *   五条 InjectRule[] 数组 + 一个 CompositeItemRule[] 数组均为空占位，
 *   由外部按需填入 { condition, value }。
 *   condition 签名：(colorCode, shapeTypeCode, shapeSizeCode) => boolean
 *   所有命中的 value 用逗号拼接。
 */

import { readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';
import { ALL_STYLE_CODES, AMERICAN_STYLE_CODES, EUROPEAN_STYLE_CODES, NONE_EURO_STYLE_CODES, UNIPACK_STYLE_CODES } from '../constants.js';

// ---- 类型 ----

/** 条件回调签名 */
type ConditionFn = (colorCode: string, shapeTypeCode: string, shapeSizeCode: string) => boolean;

/** 一条动态注入规则 */
interface InjectRule {
  condition: ConditionFn;
  value: string;
}

/** 一条组合物品规则 */
interface CompositeItemRule {
  colorCode: string;
  shapeTypeCode: string;
  shapeSizeCode: string;
  subItems: string;
}

/** Exposed-Items 表一行 */
export interface ExposedItemEntry {
  itemName: string;
  colorCode: string;
  shapeTypeCode: string;
  shapeTypeAlias: string;
  shapeSizeCode: string;
  shapeSizeAlias: string;
  subItemsName: string;
  mainDescription: string;
  mainAlias: string;
  sizeDescription: string;
  otherDescription: string;
}

/** Exposed-Color 表一行 */
export interface ExposedColorEntry {
  colorCode: string;
  colorText: string;
}

// ---- 动态注入规则（自行填充） ----

// #region SHAPE TYPE ALIAS
const SHAPE_TYPE_ALIAS_RULES: InjectRule[] = [
  // 例：
  { condition: (_, t) => t === 'UT', value: 'PT' },
  { condition: (_, t) => t === 'OV', value: 'OC' },
  { condition: (_, t) => t === 'BLS', value: 'LSB,BER' },
  { condition: (_, t) => t === 'FSB', value: 'FS' },
  { condition: (_, t) => t === 'BTCR', value: 'BWBK' },
  { condition: (_, t) => t === 'DWP', value: 'DWR' },
  { condition: (_, t) => t === 'RD', value: 'ROT' },
  { condition: (_, t) => t === 'QR', value: 'QRM' },
  { condition: (_, t) => t === 'CCM', value: 'COV' },
  { condition: (_, t) => t === 'VSB', value: 'V' },
  { condition: (_, t) => t === 'BEP', value: 'BSK' },
  { condition: (_, t) => t === 'WEP', value: 'WSK' },
  { condition: (_, t, s) => t === 'OV' && s === '331524', value: 'W' },
  { condition: (c, t, s) => EUROPEAN_STYLE_CODES.includes(c) && t === 'PNL' && s === '2596', value: 'RRP' },
  { condition: (c, t) => EUROPEAN_STYLE_CODES.includes(c) && t === 'BEP', value: 'DWP' },
];

// #region SHAPE SIZE ALIAS

const europeanStyleOvenCabSize: InjectRule[] = ["84", "90", "93", "96"].map(h => {
  return { condition: (c, t, s) => EUROPEAN_STYLE_CODES.includes(c) && t === 'OV' && s === `30${h}`, value: `30${h}24` }
})
const SHAPE_SIZE_ALIAS_RULES: InjectRule[] = [
  // 例：
  { condition: (c, t, s) => AMERICAN_STYLE_CODES.includes(c) && t === 'PNL' && s === '2496H', value: '2596' },
  { condition: (c, t, s) => AMERICAN_STYLE_CODES.includes(c) && t === 'PNL' && s === '3696Q', value: '3496' },
  { condition: (c, t, s) => EUROPEAN_STYLE_CODES.includes(c) && t === 'TF' && (s === '396' || s === '696'), value: 'WF,BF' },
  ...europeanStyleOvenCabSize,
];

// #region SUB ITEMS

const noneEuroDishwasherPanel: InjectRule[] = NONE_EURO_STYLE_CODES.map(color => {
  return { condition: (c, t, s) => c === color && t === 'DWP' && s === '3', value: `${color}DWP1.5,${color}BF3` }
})
const SUB_ITEMS_RULES: InjectRule[] = [
  // 例：
  // ...noneEuroDishwasherPanel,
];

// #region MAIN ALIAS

const MAIN_ALIAS_RULES: InjectRule[] = [
  // 按需填入
  { condition: (_, t) => t === 'UT', value: 'Utility Cabinet,Pantry Cabinet' },
  { condition: (_, t) => t === 'BLS', value: 'Lazy Susan,Laze Susan,Lady Susan,Base Easy Reach Cabinet' },
  { condition: (_, t) => t === 'BTCR', value: 'Base Waste Basket Cabinet' },
  { condition: (_, t, s) => t === 'B' && s.endsWith('F'), value: 'Base Full Height Door Cabinet' },
  // { condition: (_, t) => t === 'DWP', value: 'Dishwasher End' },
  { condition: (_, t) => t === 'RD', value: 'Roll Out Tray' },
  { condition: (_, t) => t === 'CCM', value: 'Cov Molding' },
  { condition: (_, t) => t === 'BEP', value: 'Base End Skin' },
  { condition: (c, t) => EUROPEAN_STYLE_CODES.includes(c) && t === 'BEP', value: 'Base End Skin,Dish Washer Panel' },
  { condition: (_, t) => t === 'WEP', value: 'Wall End Skin' },
  { condition: (_, t) => t === 'CP', value: 'Leg,Pillar' },
  { condition: (_, t) => t === 'QR', value: 'Shoe Molding' },
  { condition: (c, t) => NONE_EURO_STYLE_CODES.includes(c) && t === 'RRP', value: 'Fridge End Panel,Fridge Side Panel' },
];

// #region Shared Info

const NON_EURO_UTIL_CAB: Record<string, string[]> = {
  '96': ['42', '54'],
  '93': ['42', '51'],
  '90': ['36', '54'],
  '87': ['36', '51'],
  '84': ['30', '54'],
  '81': ['30', '51'],
}
const AMERICAN_OV_HEIGHT = ['15', '18', '21', '24', '27', '30']
const AMERICAN_UTIL_WIDTH = ['18', '24', '30', '36']
const EUROPEAN_UTIL_HEIGHT = ["49", "55", "58", "61"]
const EUROPEAN_UTIL_WIDTH = ['15', '18', '24', '30', '36']

// #region MAIN DESCRIPTION

const noneEuroStyleUtilityMainDesc: InjectRule[] = Object.keys(NON_EURO_UTIL_CAB).map(totalH => {
  return { condition: (_, t, s) => t === 'UT' && s.slice(2, 4) === totalH, value: `Utility Cabinet Combo, Total Height ${totalH}"` }
})
const americanStyleOvenMainDesc: InjectRule[] = AMERICAN_OV_HEIGHT.map(h => {
  const totalH = String(Number(h) + 66)
  return { condition: (_, t, s) => t === 'OV' && s.slice(2, 4) === totalH, value: `Oven Cabinet Combo, Total Height ${totalH}"` }
})
const europeanStyleUtilityMainDesc: InjectRule[] = EUROPEAN_UTIL_HEIGHT.flatMap(h => {
  const totalH = String(Number(h) + 35)
  return EUROPEAN_UTIL_WIDTH.map( w => {
    return { condition: (_, t, s) => t === 'OV' && (s.slice(0, 2) === w && s.slice(2, 4) === totalH), value: `Utility Cabinet Combo, Total Height ${totalH}"` }
  })
})
const MAIN_DESCRIPTION_RULES: InjectRule[] = [
  // 仅组合物品生效；按需填入
  ...noneEuroStyleUtilityMainDesc,
  ...americanStyleOvenMainDesc,
  ...europeanStyleUtilityMainDesc,
  { condition: (_, t) => t === 'BTCR', value: 'Base Cabinet with Trash Bin' },
  { condition: (c, t) => NONE_EURO_STYLE_CODES.includes(c) && t === 'RRP', value: 'Fridge Panel with Filler' },
  { condition: (_, t) => t === 'BPNL', value: '1/4" Panel with Outside Corner Molding' },
];

// #region COMPOSITE ITEMS

/**
 * 组合式式物品生成
 */

// 美式岛台背板
const americanStyleBackPanel = AMERICAN_STYLE_CODES.map(color => {
  return { colorCode: color, shapeTypeCode: 'BPNL', shapeSizeCode: '3696', subItems: `${color}PNL3696Q,${color}OCM8` }
})
// 欧式岛台背板
const europeanStyleBackPanel = EUROPEAN_STYLE_CODES.map(color => {
  return { colorCode: color, shapeTypeCode: 'BPNL', shapeSizeCode: '3496', subItems: `${color}PNL3496,${color}OCM8` }
})
// 美式和一体式高柜规则生成
const noneEuroStyleUtilityCab = NONE_EURO_STYLE_CODES.flatMap(color => {
  return Object.keys(NON_EURO_UTIL_CAB).flatMap( totalH => {
    const [upperCab, lowerCab] = NON_EURO_UTIL_CAB[totalH]
    return AMERICAN_UTIL_WIDTH.map(w => {
      return { colorCode: color, shapeTypeCode: 'UT', shapeSizeCode: `${w}${totalH}24`, subItems: `${color}UT${w}${upperCab}24,${color}UT${w}${lowerCab}24` }
    })
  })
})
// 欧式高柜规则生成
const europeanStyleUtilityCab = EUROPEAN_STYLE_CODES.flatMap(color => {
  return EUROPEAN_UTIL_HEIGHT.flatMap(h => {
    return EUROPEAN_UTIL_WIDTH.map(w => ({ colorCode: color, shapeTypeCode: 'UT', shapeSizeCode: `${w}${String(Number(h)+35)}24`, subItems: `${color}B${w}F,${color}UT${w}${h}24` }))
  })
})
// 美式和一体式烤箱柜规则生成
const noneEuroStyleOvenCab = NONE_EURO_STYLE_CODES.flatMap(color => {
  return AMERICAN_OV_HEIGHT.map(h => ({ colorCode: color, shapeTypeCode: 'OV', shapeSizeCode: `33${String(Number(h)+66)}24`, subItems: `${color}OV33${h}24,${color}OV336624` }))
})
// 带柜垃圾桶生成
const baseCabWithTrashBin = [...ALL_STYLE_CODES].flatMap(color => {
  return ['15', '18'].map(w => ({ colorCode: color, shapeTypeCode: 'BTCR', shapeSizeCode: w, subItems: `${color}B${w},TCR${w}_Wood Tray` }))
})
// 冰箱板子
const noneEuroRefrigePanel = NONE_EURO_STYLE_CODES.flatMap(color => [
  { colorCode: color, shapeTypeCode: 'RRP', shapeSizeCode: `1.5`, subItems: `${color}RF1.5,${color}PNL2496H` },
  { colorCode: color, shapeTypeCode: 'RRP', shapeSizeCode: `3`, subItems: `${color}TF3,${color}PNL2496H` },
])
// 洗碗机板
const noneEuroDishwasherPanelCombo = NONE_EURO_STYLE_CODES.map(color => {
  return { colorCode: color, shapeTypeCode: 'DWP', shapeSizeCode: `3`, subItems: `${color}DWP1.5,${color}BF3` }
})
const eruroDishwasherPanelCombo = EUROPEAN_STYLE_CODES.map(color => {
  return { colorCode: color, shapeTypeCode: 'DWP', shapeSizeCode: `3`, subItems: `${color}BEP2534,${color}WF330` }
})
// 填入规则
const COMPOSITE_ITEMS_RULES: CompositeItemRule[] = [
  ...americanStyleBackPanel,
  ...europeanStyleBackPanel,
  ...noneEuroStyleUtilityCab,
  ...europeanStyleUtilityCab,
  ...noneEuroStyleOvenCab,
  ...baseCabWithTrashBin,
  ...noneEuroRefrigePanel,
  ...noneEuroDishwasherPanelCombo,
  ...eruroDishwasherPanelCombo,
];

// #region 其他注入规则

/**
 * Exposed-Types 注入规则
 *
 * 在从 Phase 1 自然描述提取完成后，用此规则向 shapeTypeCode 补充 description。
 * condition 签名：(colorCode, shapeTypeCode, shapeSizeCode) => boolean
 * value 为要注入的 description（多个以逗号分隔）。
 */
const EXPOSED_TYPES_RULES: InjectRule[] = [
  // 按需填入，例：
  { condition: (_, t) => t === 'BTCR', value: 'Base Cabinet with Trash Bin' },
];

/**
 * description 片段黑名单 —— 按 shapeTypeCode 分别指定。
 * 包含列表中任一子串（大小写不敏感），则排除该片段。
 */
const EXPOSED_TYPES_BLACKLIST_BY_TYPE: Record<string, string[]> = {
  '02': ['Wood Basket'],
  '15': ['One Door'],
  '27': ['Redondo Oak Shaker'],
};
const EXPOSED_TYPES_BLACKLIST = new Set<string>(["Door / Drawer Face Only", "Shaker"])

// 专为 TUK 设计别和 TK 搞混的 otherDescription
// 还有 RD
const extraOtherDescription: Record<string, string> = {
  'TUK': 'Don\'t mistake this with TK(Toe Kick)!',
  'RD': "Used inside cabinet, can pair with any color's cabinet",
}

// ---- Exposed-Color 黑名单 ----
/**
 * colorText 片段黑名单 —— 按 colorCode 分别指定。
 * 对 colorText 按 ; 拆分后，若片段包含列表中任一子串（大小写不敏感），则排除该片段。
 */
const EXPOSED_COLOR_BLACKLIST: Record<string, string[]> = {
  '02': ['Wood Basket'],
  '15': ['One Door'],
  '27': ['Redondo Oak Shaker'],
};
/**
 * colorText 补充同名
 */
const EXPOSED_COLOR_ALIAS_LIST: Record<string, string[]> = {
  '15': ['Black Shaker'],
  '17': ['White Oak Shaker'],
  '32': ['White Creme Slim'],
  '37': ['White Oak Slim'],
};


// #region ---- 内部工具 ----

/** 解析 CSV 文件，返回行对象数组 */
function readCSVRows(filePath: string): Record<string, string>[] {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors);
  }
  return parsed.data;
}

/** 读取 Parts.csv → singlePartName → description 映射 */
function readPartsMap(filePath: string): Map<string, string> {
  const rows = readCSVRows(filePath);
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = String(row['singlePartName'] ?? '').trim();
    const desc = String(row['description'] ?? '').trim();
    if (name && desc) map.set(name, desc);
  }
  return map;
}

/**
 * 遍历所有规则，收集命中的 value，用逗号拼接。
 * 无命中则返回空字符串。
 */
function applyRules(
  rules: InjectRule[],
  colorCode: string,
  shapeTypeCode: string,
  shapeSizeCode: string,
): string {
  return rules
    .filter((r) => r.condition(colorCode, shapeTypeCode, shapeSizeCode))
    .map((r) => r.value)
    .join(',');
}

/**
 * 从柜体描述取 mainDescription：第一段，去掉 " - Carcass/Box Only"。
 * ⚠ Unipack 占位：不含 " - Carcass/Box Only" 时无影响，后续需重新设计。
 */
function parseMain(desc: string | undefined): string {
  if (!desc) return '';
  return (desc.split(';')[0] ?? '').replace(' - Carcass Only', '').replace(' - Box Only', '').trim();
}

/** 从柜体描述取 sizeDescription：第二段。 */
function parseSize(desc: string | undefined): string {
  if (!desc) return '';
  return (desc.split(';')[1] ?? '').trim();
}

/**
 * 从门描述取 otherDescription：第三段起全部内容。
 * 例如 "A; B; C; D" → "C; D"
 */
function parseOther(desc: string | undefined): string {
  if (!desc) return '';
  const segs = desc.split(';');
  if (segs.length <= 2) return '';
  return segs.slice(2).map((s) => s.trim()).join('; ');
}

/**
 * 清理 mainDescription，去掉尺寸数字、量度符号及句点后的次要内容。
 *
 * 示例：
 * - 12" Base Cabinet                → Base Cabinet
 * - 24""x30"" Utility Pantry. Top Portion → Utility Pantry
 * - 1/4" Panel                      → Panel
 */
function cleanDescription(desc: string): string {
  if (!desc) return '';

  let result = desc.trim();
  // 1. 去掉开头的数字/分数 + 可选引号（如 "12"" 或 "1/4""）
  result = result.replace(/^\d+(?:[\/.]\d+)?["']*\s*/, '');
  // 2. 如果还有 "x/×/* 数字" 形式的乘法维度（如 "x 30""），也去掉
  result = result.replace(/^\s*[x×*]\s*\d+(?:[\/.]\d+)?["']*\s*/, '');
  // 3. 去掉第一个 ". " 开始的所有后续内容
  result = result.replace(/\s*\..*$/, '');

  return result.trim();
}

// #region ---- 公开 API ----

/**
 * 生成 Exposed-Items 表。
 *
 * @param itemsPath  - Items.csv 路径
 * @param partsPath  - Parts.csv 路径
 * @param outputPath - 输出 CSV 路径；传 null 跳过写入
 */
export function generateExposedItemsTable(
  itemsPath: string,
  partsPath: string,
  outputPath: string | null,
): { entries: ExposedItemEntry[]; count: number } {
  const itemRows = readCSVRows(itemsPath);
  const partsMap = readPartsMap(partsPath);
  const entries: ExposedItemEntry[] = [];

  // ---- Phase 1：处理 Items.csv 全部普通物品 ----

  for (const row of itemRows) {
    const itemName = String(row['itemName'] ?? '').trim();
    const colorCode = String(row['colorCode'] || '').trim(); // 无颜色的型号（GD/TCR）colorCode 为空
    const shapeTypeCode = String(row['shapeTypeCode'] ?? '').trim();
    const shapeSizeCode = String(row['shapeSizeCode'] || '').trim(); // 无尺寸的型号（GD/CBL/TUK/SD）shapeSizeCode 为空
    const doorPart = String(row['doorPart'] ?? '').trim();
    const cabinetPart = String(row['cabinetPart'] ?? '').trim();
    const extraPart = String(row['extraPart'] ?? '').trim();

    if (!itemName) continue;

    // 动态注入
    const shapeTypeAlias = applyRules(SHAPE_TYPE_ALIAS_RULES, colorCode, shapeTypeCode, shapeSizeCode);
    const shapeSizeAlias = applyRules(SHAPE_SIZE_ALIAS_RULES, colorCode, shapeTypeCode, shapeSizeCode);
    /**
     * 虽然非常稀有，但还是留一个可卖的物品被解析为其他可卖物品的功能入口
     */
    const subItemsName = applyRules(SUB_ITEMS_RULES, colorCode, shapeTypeCode, shapeSizeCode);

    let mainDescription: string;
    let sizeDescription: string;
    let otherDescription: string;
    let mainAlias: string;

    if (subItemsName) {
      // 普通物品被标记为组合 → 不再从 Parts 查描述
      mainDescription = '';
      sizeDescription = '';
      otherDescription = '';
    } else {
      // 柜体描述 → mainDescription + sizeDescription
      const cabinetDesc = partsMap.get(cabinetPart);
      mainDescription = parseMain(cabinetDesc);
      sizeDescription = parseSize(cabinetDesc);

      // 门描述 → otherDescription（第三段起）
      if (doorPart) {
        otherDescription = parseOther(partsMap.get(doorPart));
      } else { // 没有则取柜体描述兜底
        otherDescription = parseOther(cabinetDesc);
      }

      // 额外零件 → 拼接到 otherDescription
      if (extraPart) {
        const extraDesc = partsMap.get(extraPart);
        if (extraDesc) {
          otherDescription = otherDescription
            ? `${otherDescription}; ${extraDesc}`
            : extraDesc;
        }
      }

      // 额外信息继续拼接到 otherDescription
      if (extraOtherDescription[shapeTypeCode]) {
        otherDescription = otherDescription
          ? `${otherDescription}; ${extraOtherDescription[shapeTypeCode]}`
          : extraOtherDescription[shapeTypeCode]
      }
    }

    mainAlias = applyRules(MAIN_ALIAS_RULES, colorCode, shapeTypeCode, shapeSizeCode);

    entries.push({
      itemName,
      colorCode,
      shapeTypeCode,
      shapeTypeAlias,
      shapeSizeCode,
      shapeSizeAlias,
      subItemsName,
      mainDescription,
      mainAlias,
      sizeDescription,
      otherDescription,
    });
  }

  // ---- Phase 2：插入组合物品 ----

  for (const rule of COMPOSITE_ITEMS_RULES) {
    const itemName = rule.colorCode + rule.shapeTypeCode + rule.shapeSizeCode;
    const colorCode = rule.colorCode;
    const shapeTypeCode = rule.shapeTypeCode;
    const shapeSizeCode = rule.shapeSizeCode;

    const shapeTypeAlias = applyRules(SHAPE_TYPE_ALIAS_RULES, colorCode, shapeTypeCode, shapeSizeCode);
    const shapeSizeAlias = applyRules(SHAPE_SIZE_ALIAS_RULES, colorCode, shapeTypeCode, shapeSizeCode);
    const mainDescription = applyRules(MAIN_DESCRIPTION_RULES, colorCode, shapeTypeCode, shapeSizeCode);
    const mainAlias = applyRules(MAIN_ALIAS_RULES, colorCode, shapeTypeCode, shapeSizeCode);

    entries.push({
      itemName,
      colorCode,
      shapeTypeCode,
      shapeTypeAlias,
      shapeSizeCode,
      shapeSizeAlias,
      subItemsName: rule.subItems,
      mainDescription,
      mainAlias,
      sizeDescription: '',
      otherDescription: '',
    });
  }

  // ---- 排序 + 写入 ----

  entries.sort((a, b) => a.itemName.localeCompare(b.itemName));

  if (outputPath) {
    const csvContent = Papa.unparse(entries, {
      columns: [
        'itemName', 'colorCode',
        'shapeTypeCode', 'shapeTypeAlias',
        'shapeSizeCode', 'shapeSizeAlias',
        'subItemsName',
        'mainDescription', 'mainAlias',
        'sizeDescription', 'otherDescription',
      ],
    });
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { entries, count: entries.length };
}

/**
 * 生成 Exposed-Color 表。
 *
 * 从 Color.csv 读取全量颜色，仅保留 colorCode 属于 ALL_STYLE_CODES 的行，
 * 并对每行的 colorText 按 ; 拆分后应用按 colorCode 区分的黑名单启发过滤，
 * 过滤后的片段重新以 ; 拼接输出。
 *
 * @param colorPath  - Color.csv 路径
 * @param outputPath - 输出 CSV 路径；传 null 跳过写入
 */
export function generateExposedColorTable(
  colorPath: string,
  outputPath: string | null,
): { entries: ExposedColorEntry[]; count: number } {
  const rows = readCSVRows(colorPath);
  const entries: ExposedColorEntry[] = [];

  for (const row of rows) {
    const colorCode = String(row['colorCode'] ?? '').trim();
    const colorText = String(row['colorText'] ?? '').trim();

    if (!colorCode) continue;

    // 仅保留 ALL_STYLE_CODES 中的颜色码
    if (!ALL_STYLE_CODES.has(colorCode)) continue;

    // 空文本直接跳过
    if (!colorText) continue;

    // 按 ; 拆分 colorText，对每个片段做黑名单子串匹配
    const segments = colorText.split(';');
    const blacklist = EXPOSED_COLOR_BLACKLIST[colorCode] ?? [];
    const filtered: string[] = EXPOSED_COLOR_ALIAS_LIST[colorCode] ?? []; // 直接注入 Alias 名单

    for (const seg of segments) {
      const trimmed = seg.trim();
      if (!trimmed) continue;

      const isBlacklisted = blacklist.some((b) =>
        trimmed.toLowerCase().includes(b.toLowerCase()),
      );
      if (isBlacklisted) {
        continue;
      }

      filtered.push(trimmed);
    }

    if (filtered.length === 0) continue;

    entries.push({
      colorCode,
      colorText: filtered.join('; '),
    });
  }

  // 按颜色码排序
  entries.sort((a, b) => a.colorCode.localeCompare(b.colorCode));

  if (outputPath) {
    const csvContent = Papa.unparse(entries, { columns: ['colorCode', 'colorText'] });
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { entries, count: entries.length };
}

/**
 * 生成 Exposed-Types 表。
 *
 * 仅从 Phase 1 普通物品的自然 mainDescription 提取（MAIN_DESCRIPTION_RULES
 * 注入前），经 cleanDescription 清理后按 shapeTypeCode 分组去重，
 * 再通过 EXPOSED_TYPES_RULES 注入补充 description，以 ; 拼接输出。
 *
 * 输出列（2 列）：
 *   shapeTypeCode, description
 *
 * @param itemsPath  - Items.csv 路径
 * @param partsPath  - Parts.csv 路径
 * @param outputPath - 输出 CSV 路径；传 null 跳过写入
 */
export function generateExposedTypesTable(
  itemsPath: string,
  partsPath: string,
  outputPath: string | null,
): { entries: { shapeTypeCode: string; description: string }[]; count: number } {
  const itemRows = readCSVRows(itemsPath);
  const partsMap = readPartsMap(partsPath);
  const descMap = new Map<string, Set<string>>();

  // ---- Phase 1：从普通物品提取自然 mainDescription ----

  for (const row of itemRows) {
    const shapeTypeCode = String(row['shapeTypeCode'] ?? '').trim();
    const cabinetPart = String(row['cabinetPart'] ?? '').trim();

    if (!shapeTypeCode) continue;

    const cabinetDesc = partsMap.get(cabinetPart);
    const mainDescription = parseMain(cabinetDesc);

    if (!mainDescription) continue;

    const secByComma = cleanDescription(mainDescription).split(',')
    for (const cleaned of secByComma) {
      // 有数字的话，就不认为是有效的描述，舍弃
      if (!cleaned || /\d/.test(cleaned)) continue;
      // 黑名单子串匹配（不区分大小写），命中则排除
      const isBlacklisted = [...EXPOSED_TYPES_BLACKLIST].some( b => 
        cleaned.toLowerCase().includes(b.toLowerCase())
      )
      if (isBlacklisted) continue;

      if (!descMap.has(shapeTypeCode)) {
        descMap.set(shapeTypeCode, new Set());
      }
      descMap.get(shapeTypeCode)!.add(cleaned);
    }
  }

  // ---- Phase 2：EXPOSED_TYPES_RULES 注入 ----

  for (const row of itemRows) {
    const colorCode = String(row['colorCode'] || '').trim();
    const shapeTypeCode = String(row['shapeTypeCode'] ?? '').trim();
    const shapeSizeCode = String(row['shapeSizeCode'] || '').trim();

    if (!shapeTypeCode) continue;

    const injectedDesc = applyRules(EXPOSED_TYPES_RULES, colorCode, shapeTypeCode, shapeSizeCode);
    if (!injectedDesc) continue;

    if (!descMap.has(shapeTypeCode)) {
      descMap.set(shapeTypeCode, new Set());
    }
    for (const token of injectedDesc.split(',')) {
      const trimmed = token.trim();
      if (trimmed) {
        descMap.get(shapeTypeCode)!.add(trimmed);
      }
    }
  }

  // ---- 输出 ----

  const entries: { shapeTypeCode: string; description: string }[] = [];
  for (const [shapeTypeCode, descSet] of descMap) {
    entries.push({
      shapeTypeCode,
      description: [...descSet].sort().join('; '),
    });
  }

  entries.sort((a, b) => a.shapeTypeCode.localeCompare(b.shapeTypeCode));

  if (outputPath) {
    const csvContent = Papa.unparse(entries, { columns: ['shapeTypeCode', 'description'] });
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { entries, count: entries.length };
}
