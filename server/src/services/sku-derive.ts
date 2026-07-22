/**
 * SKU 衍生数据表生成模块
 *
 * 从清洗后的 Product.csv 生成：
 *   1. 颜色表 (Color.csv) — 两列：Color Code, Color Text
 *      颜色码 = Name 前两位数字，颜色文本 = Sales Description 最后一个分号后内容
 *      同颜色码的多种文本去重后分号拼接；黑名单子串匹配则排除
 *
 *   2. 单一零件表 (Parts.csv) — 独立查询表，Product 每一行都有对应行
 *      拆分优先级（从上到下依次匹配，命中即停止）：
 *        0. 后缀含英寸分数（数字/数字，如 -1/2/-1/4/-3/4）→ single = shared = name，直通避免误拆
 *        a. 无 "/" → single = shared = name（直接通过）
 *        b. XX/YY 双门码兼容 → 拆为两个单码行（如 02/04 BLS-Tray）
 *        c. L/R 左右变体 → 拆为 L 和 R 两行（如 30VC30L/R-C）
 *        d. Case A 完整变体码 → prefix + 各部件 + suffix（如 11B30/.../VSD30-D）
 *        e. 兜底 → single = shared = name（含复合模式如 60CSP15/18/.../361493）
 *      输出仅三列：Single Part Name, Shared Part Name, Sales Description
 */

import { readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';
import { AMERICAN_STYLE_CODES, EUROPEAN_STYLE_CODES, NONE_EURO_STYLE_CODES } from '../constants.js';

// 颜色文本黑名单 —— 包含任一子串则排除该颜色候选
const COLOR_BLACKLIST = new Set<string>([
  // 在此添加需排除的颜色关键词，不区分大小写
  '#','/','*',
]);

// 单一零件白名单 —— { 手动注入的单零件名: 共享零件名 }
// 共享零件需存在于 Product.csv 中，描述从该行获取

/**
 * W 用 OV 的门，但不确定柜体如何处理
 */
const wallUseOvenDoor = Object.fromEntries(AMERICAN_STYLE_CODES.flatMap(color => [
  [`${color}W3315-D`, `${color}OV331524-D`],
  [`${color}W3318-D`, `${color}OV331824-D`],
  [`${color}W3321-D`, `${color}OV332124-D`],
  [`${color}W3324-D`, `${color}OV332424-D`],
  [`${color}W3327-D`, `${color}OV332724-D`],
]))
/**
 * 美式柜的全高门白名单
 */
const americanStyleFullHeight = Object.fromEntries(AMERICAN_STYLE_CODES.flatMap(color => [
  [`${color}B12F-D`, `${color}W1230-D`],
  [`${color}B15F-D`, `${color}W1530-D`],
  [`${color}B18F-D`, `${color}W1830/UT183024-D`],
  [`${color}B21F-D`, `${color}W2130-D`],
  [`${color}B24F-D`, `${color}W2430/UT243024-D`],
  [`${color}B27F-D`, `${color}W2730-D`],
  [`${color}B30F-D`, `${color}W3030/UT303024-D`],
  [`${color}B33F-D`, `${color}W3330/OV333024-D`],
  [`${color}B36F-D`, `${color}W3630/UT363024-D`],
  [`${color}B42F-D`, `${color}W4230-D`],
]))

const PART_WHITELIST: Record<string, string> = {
  ...americanStyleFullHeight,
  // 全高柜子的柜体 - 美式
  ...Object.fromEntries(["12", "15", "18", "21", "24", "27", "30", "33", "36", "42"].flatMap(size => [
    [`10B${size}F-C`, `10B${size}-C`]
  ])),
  // 全高柜子的柜体 — 欧式
  ...Object.fromEntries(["12", "15", "18", "21", "24", "27", "30", "33", "36", "42"].flatMap(size => [
      [`30B${size}F-C`, `30B${size}-C`]
  ])),
  ...wallUseOvenDoor,
  // 欧式: BF3→WF330, BF6→WF630
  ...Object.fromEntries(EUROPEAN_STYLE_CODES.flatMap(color => [
    [`${color}BF3`, `${color}WF330`],
    [`${color}BF6`, `${color}WF630`],
  ])),
  // 非欧式: WF396→TF3, WF696→TF6, BF396→TF3, BF696→TF6
  ...Object.fromEntries(NONE_EURO_STYLE_CODES.flatMap(color => [
    [`${color}WF396`, `${color}TF3`],
    [`${color}WF696`, `${color}TF6`],
    [`${color}BF396`, `${color}TF3`],
    [`${color}BF696`, `${color}TF6`],
  ])),
  // 美式: PNL2496Q→SK2496
  ...Object.fromEntries(AMERICAN_STYLE_CODES.flatMap(color => [
    [`${color}PNL2496Q`, `${color}SK2496`],
  ])),
};

/**
 * 颜色重映射规则 —— 源色配件在 Parts 表层面解析到目标色
 *
 * 29 (Newport White Double Shaker) 与 02 (Unipack) 实质同色，仅仓库历史遗留标签不同；
 * 32 (White Creme Timberline) 与 12 同理。列入 types 的 shape type code 才参与重映射。
 *
 * 处理时机：deriveSinglePartTable 末尾，PART_WHITELIST 注入之后。
 *   - Phase 1：扫描已有源色条目（含 PART_WHITELIST 注入的），将源色 shared 改写为目标色
 *   - Phase 2：为目标色存在但源色缺失的组合，凭空生成源色条目（数据补全）
 *   若目标色件本身已有非 identity 映射（如 02PNL2496Q→02SK2496），源色件会自动解析到该最终目标。
 */
const COLOR_REMAP_RULES: Array<{ from: string; to: string; types: Set<string> }> = [
  {
    from: '29', to: '02',
    types: new Set(['CM', 'ACM', 'CCM', 'OCM', 'PNL', 'SK', 'SM', 'TK', 'BM']),
  },
  {
    from: '32', to: '12',
    types: new Set(['CM', 'ACM', 'CCM', 'OCM', 'SM', 'TK', 'BM']),
  },
];

// ---- 类型 ----

/** 颜色表一行 */
export interface ColorEntry {
  colorCode: string;
  colorText: string;
}

/** 单一零件表一行 */
export interface SinglePartEntry {
  singlePartName: string;
  sharedPartName: string;
  description: string;
}

// ---- 内部工具 ----

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

/**
 * 按 Case A（完整变体码）模式拆分名称。
 *
 * 例如 11B30/SB30/VSB30/VSD30-D：
 *   prefix  = "11"                           （前2位固定）
 *   suffix  = "-D"                           （最后一个 "-" 及之后）
 *   middle  = "B30/SB30/VSB30/VSD30"         （prefix 与 suffix 之间）
 *   parts   = ["B30","SB30","VSB30","VSD30"]  （middle 按 "/" 拆分）
 *   结果    = ["11B30-D","11SB30-D","11VSB30-D","11VSD30-D"]
 *
 * @param name - 含 "/" 的完整共享名称
 * @returns 拆分后的单一部分名称数组
 */
function splitCaseA(name: string): string[] {
  // 最后一个 "-" 及其之后为 suffix（若没有 "-" 则 suffix 为空字符串）
  const lastDash = name.lastIndexOf('-');
  const suffix = lastDash >= 0 ? name.substring(lastDash) : '';
  // prefix 固定为前两位（如 "11"、"30"）
  const prefix = name.substring(0, 2);
  // middle 为去掉 prefix 和 suffix 后的中间部分
  const middleEnd = lastDash >= 0 ? lastDash : name.length;
  const middle = name.substring(2, middleEnd);
  const parts = middle.split('/');

  // prefix + 各部件 + suffix → 单一部分名
  return parts.map((p) => `${prefix}${p}${suffix}`);
}

/**
 * 检测部件列表是否为复合模式（同时包含纯数字部件和含字母部件）。
 * 此类名称不适合按 Case A 自动拆分（如 60CSP15/18/24/30/361493）。
 */
function isComplexParts(parts: string[]): boolean {
  const hasLetters = parts.some((p) => /[A-Za-z]/.test(p));
  const hasPureDigits = parts.some((p) => /^\d+$/.test(p));
  return hasLetters && hasPureDigits;
}

/**
 * 在去掉颜色前缀的名称片段中匹配映射类型集合里的 shape type code。
 *
 * 匹配规则：
 *   - 按类型长度倒序匹配（CCM 优先于 CM），保证最长前缀优先
 *   - 类型后必须紧跟数字或结尾（边界检查），避免 BMC 被误识别为 BM
 *
 * @param nameRest - 去掉颜色前缀后的部分（如 "CM4"、"PNL3696F"、"BMC27-D"）
 * @param types    - 允许的 shape type code 集合
 * @returns 匹配到的 shape type code；未匹配返回 undefined
 */
function matchMappedTypeCode(nameRest: string, types: Set<string>): string | undefined {
  const sorted = [...types].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    if (nameRest.startsWith(t)) {
      const next = nameRest.charAt(t.length);
      if (next === '' || /\d/.test(next)) {
        return t;
      }
    }
  }
  return undefined;
}

// ---- 公开 API ----

/**
 * 从清洗后的 CSV 生成颜色表。
 *
 * @param csvPath   - 清洗后的 Product.csv 路径
 * @param outputPath - 输出 CSV 路径；传 null 跳过写入
 */
export function deriveColorTable(
  csvPath: string,
  outputPath: string | null,
): { entries: ColorEntry[]; count: number } {
  const rows = readCSVRows(csvPath);
  const map = new Map<string, Set<string>>();

  for (const row of rows) {
    const name = String(row['Name'] ?? '').trim();
    const descRaw = String(row['Sales Description'] ?? '').trim();
    if (!name || !descRaw) continue;

    // 颜色码 = Name 前两位数字（如 02、30 等），非数字前缀则跳过
    const prefix = name.substring(0, 2);
    if (!/^\d{2}$/.test(prefix)) continue;

    // 取描述中最后一个不在结尾的分号后的文本作为候选颜色文本
    const desc = descRaw.lastIndexOf(';') === descRaw.length-1 ? descRaw.slice(0, -1) : descRaw; // 需排除最后一个字符本身就是分号的情况
    const lastSemi = desc.lastIndexOf(';');
    if (lastSemi === -1) continue;

    const candidate = desc.substring(lastSemi + 1).trim();
    if (!candidate) continue;

    // 黑名单子串匹配（不区分大小写），命中则排除
    const isBlacklisted = [...COLOR_BLACKLIST].some((b) =>
      candidate.toLowerCase().includes(b.toLowerCase()),
    );
    if (isBlacklisted) continue;

    // 按颜色码聚合候选文本（Set 去重）
    if (!map.has(prefix)) map.set(prefix, new Set());
    map.get(prefix)!.add(candidate);
  }

  // 转换为条目列表，去重后的文本按分号拼接
  const entries: ColorEntry[] = [];
  for (const [code, texts] of map) {
    entries.push({
      colorCode: code,
      colorText: [...texts].join('; '),
    });
  }

  // 按颜色码排序
  entries.sort((a, b) => a.colorCode.localeCompare(b.colorCode));

  if (outputPath) {
    const csvContent = Papa.unparse(entries);
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { entries, count: entries.length };
}

/**
 * 从清洗后的 CSV 生成单一零件表（独立查询表，Product 每一行都有对应行）。
 *
 * 拆分优先级：
 *   0. 后缀含英寸分数（数字/数字，如 -1/2/-1/4/-3/4）→ single = shared = name，直通避免误拆
 *   1. 不含 "/" → single = shared = name，直接通过
 *   2. XX/YY 兼容模式（name[2]=='/' 且后面两位为数字，如 02/04 BLS-Tray）
 *   3. L/R 或 R/L 变体模式（斜杠左右分别为 L 和 R）
 *   4. Case A 完整变体码（prefix[0:2] + middle.split('/') + suffix）
 *   5. 以上均不满足 → single = shared = name，兜底通过
 *
 * @param csvPath    - 清洗后的 Product.csv 路径
 * @param outputPath - 输出 CSV 路径；传 null 跳过写入
 */
export function deriveSinglePartTable(
  csvPath: string,
  outputPath: string | null,
): { entries: SinglePartEntry[]; count: number } {
  const rows = readCSVRows(csvPath);
  let entries: SinglePartEntry[] = [];
  const usingSharedPart = new Set()

  // 构建 Name → Description 索引，供白名单查找
  const nameToDesc = new Map<string, string>();
  for (const row of rows) {
    const n = String(row['Name'] ?? '').trim();
    const d = String(row['Sales Description'] ?? '').trim();
    if (n && d) nameToDesc.set(n, d);
  }

  for (const row of rows) {
    const name = String(row['Name'] ?? '').trim();
    const desc = String(row['Sales Description'] ?? '').trim();
    if (!name || !desc) continue;

    // 不含 "/"：直接通过
    if (!name.includes('/')) {
      entries.push({ singlePartName: name, sharedPartName: name, description: desc });
      continue;
    }

    // ── 优先级 0：尺寸分数直通 ──
    // 后缀中的"数字/数字"(如 -1/2, -1/4, -3/4)是英寸尺寸标记，非变体分隔符
    // 检测到直接以 whole name 通过，不参与后续任何拆分
    const lastDash0 = name.lastIndexOf('-');
    const suffix0 = lastDash0 >= 0 ? name.substring(lastDash0) : '';
    if (/\d\/\d/.test(suffix0)) {
      entries.push({ singlePartName: name, sharedPartName: name, description: desc });
      continue;
    }

    // ── 优先级 1：XX/YY 双门码兼容模式 ──
    // 检测 name[2] 为 '/' 且 name[3]、name[4] 均为数字（如 02/04 BLS-Tray）
    // 表示该零件兼容两种门框规格，拆为两个独立行
    //   例如 "02/04 BLS-Tray" → "02 BLS-Tray" + "04 BLS-Tray"
    if (name.length >= 5 && name[2] === '/' && /\d/.test(name[3]) && /\d/.test(name[4])) {
      const code1 = name.substring(0, 2);
      const code2 = name.substring(3, 5);
      const rest = name.substring(5);
      entries.push({ singlePartName: code1 + rest, sharedPartName: name, description: desc });
      entries.push({ singlePartName: code2 + rest, sharedPartName: name, description: desc });
      continue;
    }

    // ── 优先级 2：L/R（或 R/L）左右变体模式 ──
    // 检测斜杠左右两侧字符分别为 L 和 R（无论顺序）
    // 提取斜杠两侧外的公共前后部分，生成 L 和 R 两个独立行
    //   例如 "30VC30L/R-C" → before="30VC30", after="-C" → "30VC30L-C" + "30VC30R-C"
    const slashPos = name.indexOf('/');
    if (slashPos > 0 && slashPos < name.length - 1) {
      const leftChar = name[slashPos - 1];
      const rightChar = name[slashPos + 1];
      if ((leftChar === 'L' && rightChar === 'R') || (leftChar === 'R' && rightChar === 'L')) {
        const before = name.substring(0, slashPos - 1);
        const after = name.substring(slashPos + 2);
        entries.push({ singlePartName: before + leftChar + after, sharedPartName: name, description: desc });
        entries.push({ singlePartName: before + rightChar + after, sharedPartName: name, description: desc });
        continue;
      }
    }

    // ── 优先级 3：Case A — 完整变体码 ──
    // 取出 prefix(前2位) 和 suffix(末 "-" 后)，middle 按 "/" 拆分
    // 若 middle 部件同时含纯数字和字母 → 复合模式，不拆分（兜底为 single=shared）
    //   例如 "11B30/SB30/VSB30/VSD30-D" → "11B30-D", "11SB30-D", ...
    const middleEnd = name.lastIndexOf('-');
    const middlePart = middleEnd >= 0 ? name.substring(2, middleEnd) : name.substring(2);
    const parts = middlePart.split('/');

    if (isComplexParts(parts)) {
      entries.push({ singlePartName: name, sharedPartName: name, description: desc });
      continue;
    }

    for (const singleName of splitCaseA(name)) {
      usingSharedPart.add(singleName)
      entries.push({ singlePartName: singleName, sharedPartName: name, description: desc });
    }
  }

  // 白名单手动注入
  for (const [singleName, sharedName] of Object.entries(PART_WHITELIST)) {
    const sharedDesc = nameToDesc.get(sharedName);
    if (!sharedDesc) {
      console.warn(`白名单: 共享零件 "${sharedName}" 未在 CSV 中找到`);
      continue;
    }
    if (entries.some((e) => e.singlePartName === singleName)) continue;

    entries.push({
      singlePartName: singleName,
      sharedPartName: sharedName,
      description: sharedDesc,
    });
  }

  // 颜色重映射注入（29→02, 32→12 等）：
  //   将源色件解析到目标色件，使 /generate-products 不必在 itemName 层做颜色改写。
  //   先建立 singlePartName 索引避免 O(n²) 查找。
  const entryByName = new Map<string, SinglePartEntry>();
  for (const e of entries) entryByName.set(e.singlePartName, e);

  for (const rule of COLOR_REMAP_RULES) {
    // Phase 1：覆盖已存在的源色条目
    //   扫描所有以 rule.from 开头的条目（含 PART_WHITELIST 注入的），
    //   若其 sharedPartName 也在源色空间，则改写为目标色对应件。
    const sourceNames = entries
      .filter((e) => e.singlePartName.startsWith(rule.from))
      .map((e) => e.singlePartName);
    for (const srcName of sourceNames) {
      const srcRest = srcName.substring(rule.from.length);
      if (!matchMappedTypeCode(srcRest, rule.types)) continue;

      const existing = entryByName.get(srcName)!;
      const srcSharedName = existing.sharedPartName;
      // 仅当 shared 也是源色时才重映射（避免误改已是目标色或非颜色前缀的 shared）
      if (!srcSharedName.startsWith(rule.from)) continue;

      const tgtSharedName = rule.to + srcSharedName.substring(rule.from.length);
      const tgtDesc = nameToDesc.get(tgtSharedName);
      if (!tgtDesc) continue; // 目标色件不存在，保持原样（孤儿）

      existing.sharedPartName = tgtSharedName;
      existing.description = tgtDesc;
    }

    // Phase 2：为目标色存在但源色缺失的组合注入新条目（数据补全）
    //   遍历 Product.csv 中所有以 rule.to 开头且类型匹配的件，
    //   若对应源色件不存在，则按目标色件的最终解析结果生成源色条目。
    for (const [tgtName, tgtDesc] of nameToDesc) {
      if (!tgtName.startsWith(rule.to)) continue;
      const tgtRest = tgtName.substring(rule.to.length);
      if (!matchMappedTypeCode(tgtRest, rule.types)) continue;

      const srcName = rule.from + tgtRest;
      if (entryByName.has(srcName)) continue; // Phase 1 已处理或本就存在

      // 解析目标色件的最终 shared（目标可能已被 PART_WHITELIST 重定向，如 PNL2496Q→SK2496）
      const tgtEntry = entryByName.get(tgtName);
      const finalShared = tgtEntry?.sharedPartName ?? tgtName;
      const finalDesc = tgtEntry?.description ?? tgtDesc;

      const newEntry: SinglePartEntry = {
        singlePartName: srcName,
        sharedPartName: finalShared,
        description: finalDesc,
      };
      entries.push(newEntry);
      entryByName.set(srcName, newEntry);
    }
  }

  // 按单零件名排序
  entries.sort((a, b) => a.singlePartName.localeCompare(b.singlePartName));
  // 过滤属于共享零件名单但共享零件却和单独零件一致的零件
  entries = entries.filter( e => !(usingSharedPart.has(e.singlePartName) && e.singlePartName === e.sharedPartName))

  if (outputPath) {
    const csvContent = Papa.unparse(entries);
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { entries, count: entries.length };
}
