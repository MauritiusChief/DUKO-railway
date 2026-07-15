/**
 * SKU 数据清洗模块
 *
 * 清洗规则：
 *   1. 标准清洗：Name 列符合正则 /^\d{2}[A-Z0-9/]+(?:-[A-Z0-9]+)*$/
 *      两位数字 + 大写字母/数字/斜杠 + 零个或多个 "-后缀"（后缀由大写字母/数字组成）
 *      示例：30DB33-2-C、38B36/SB36/VSB36/VSD36-D、02B09F
 *   2. 白名单：不满足正则但在白名单中的行也保留
 *
 * 数据流：CSV 文件 → 解析 → 过滤 → 写入新 CSV
 */

import { readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';

/** 一行清洗后的数据记录 */
export interface CleanRecord {
  /** Name 列的值 */
  name: string;
  /** 保留原因：'standard' 正则匹配 ｜ 'whitelist' 白名单 */
  reason: 'standard' | 'whitelist';
  /** CSV 整行原始数据（所有列） */
  row: Record<string, string>;
}

/**
 * 标准名称正则：
 *   ^\d{2}            — 以两位数字开头
 *   [A-Z0-9./]+        — 后接一个或多个大写字母 / 数字 / 小数点 / 斜杠
 *   (?:-[A-Z0-9/"]+)*$  — 零个或多个 "-后缀"（后缀由大写字母/数字/斜杠/双引号组成），直到行尾
 */
const STANDARD_NAME_RE = /^\d{2}[A-Z0-9./]+(?:-[A-Z0-9/"]+)*$/;

// 清洗白名单 —— Name 不满足正则但需保留的产品
const CLEAN_WHITELIST = new Set<string>([
  '02/04 BLS-Tray',
  'TCR15_Wood Tray',
  'TCR18_Wood Tray',
  '10BLS-Tray',
  '30BLS-Tray',
  'Glass Doors',
]);

/**
 * 通过正则检查 Name 是否符合标准格式。
 */
export function isStandardName(name: string): boolean {
  return STANDARD_NAME_RE.test(name);
}

/**
 * 对 CSV 文本执行清洗过滤（内存版，不读写文件）。
 *
 * @param csvText  源 CSV 文本
 * @returns 过滤结果（保留的行 + 统计）
 */
export function cleanCSVFromString(
  csvText: string,
): { records: CleanRecord[]; count: number } {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors);
  }

  const rows = parsed.data;
  const kept: CleanRecord[] = [];

  for (const row of rows) {
    const name = String(row['Name'] ?? row['name'] ?? '').trim();
    const desc = String(row['Sales Description'] ?? '').trim();

    // 跳过 Name / Descriptipn 为空的行（这些不属于有效产品数据）
    if (!name || !desc) continue;

    if (isStandardName(name)) {
      kept.push({ name, reason: 'standard', row });
    } else if (CLEAN_WHITELIST.has(name)) {
      kept.push({ name, reason: 'whitelist', row });
    }
  }

  return { records: kept, count: kept.length };
}

/**
 * 对 CSV 文件执行清洗过滤（文件版，内部复用 cleanCSVFromString）。
 *
 * @param csvPath      - 源 CSV 文件路径
 * @param outputPath   - 清洗后输出的 CSV 路径；传入 null 则跳过写入
 * @returns 过滤结果（保留的行 + 统计）
 */
export function cleanCSV(
  csvPath: string,
  outputPath: string | null,
): { records: CleanRecord[]; count: number } {
  const raw = readFileSync(csvPath, 'utf-8');
  const { records, count } = cleanCSVFromString(raw);

  // 写入清洗后的 CSV
  if (outputPath) {
    const csvContent = Papa.unparse(records.map((r) => r.row));
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { records, count };
}
