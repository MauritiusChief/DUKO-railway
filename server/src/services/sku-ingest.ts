/**
 * SKU 数据导入管道（仅支持 CSV）
 *
 * 流程：Exposed-Items.csv → 解析行 → 拼接文本 → embedding → 写入 LanceDB + SQLite
 *
 * 列映射（与 Exposed-Items.csv 列一一对应，共 11 个文本列）：
 *  itemName / colorCode / shapeTypeCode / shapeTypeAlias
 *  / shapeSizeCode / shapeSizeAlias / subItemsName
 *  / mainDescription / mainAlias / sizeDescription / otherDescription
 *
 * 文本拼接公式（供 embedding 用）：
 *   text = itemName + " " + subItemsName + " " + mainDescription
 *        + " " + mainAlias + " " + sizeDescription + " " + otherDescription
 *
 * 每次导入使用 replaceAll 全量替换，同时写入 LanceDB（向量索引）和 SQLite（结构化字段）。
 * LanceDB 保留 384 维向量用于语义搜索，SQLite 负责所有非向量查询。
 */

import { readFileSync } from 'fs';
import Papa from 'papaparse';
import { getEmbeddings } from './embeddings.js';
import { replaceAll as replaceAllLance } from '../db/lance.js';
import { replaceAllRecords } from '../db/sku.js';
import type { SkuRecord } from '../types/sku.js';

/**
 * 解析 Exposed-Items.csv 为 SKU 记录（不生成 embedding）。
 * 供 ingestFromFile 和 loadCacheFromCSV 共用。
 *
 * CSV 列名与 SkuRecord 字段名完全一致，直接一一对应读取。
 */
function parseCSV(filePath: string): { records: SkuRecord[]; texts: string[] } {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,          // 首行为列名 → 输出对象数组
    skipEmptyLines: true,  // 跳过空行
    dynamicTyping: false,  // 保持字符串类型，避免数字被误转
  });

  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors);
  }

  const rows = parsed.data;
  const records: SkuRecord[] = [];
  const texts: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // 直接从 CSV 读取各列
    const itemName = String(row['itemName'] ?? '').trim();
    const colorCode = String(row['colorCode'] ?? '').trim();
    const shapeTypeCode = String(row['shapeTypeCode'] ?? '').trim();
    const shapeTypeAlias = String(row['shapeTypeAlias'] ?? '').trim();
    const shapeSizeCode = String(row['shapeSizeCode'] ?? '').trim();
    const shapeSizeAlias = String(row['shapeSizeAlias'] ?? '').trim();
    const subItemsName = String(row['subItemsName'] ?? '').trim();
    const mainDescription = String(row['mainDescription'] ?? '').trim();
    const mainAlias = String(row['mainAlias'] ?? '').trim();
    const sizeDescription = String(row['sizeDescription'] ?? '').trim();
    const otherDescription = String(row['otherDescription'] ?? '').trim();

    // 跳过完全空行
    if (!itemName && !mainDescription && !mainAlias) continue;

    /**
     * 拼接全文用于生成 embedding。
     * 拼接顺序：标识符 → 组合子物品 → 主体描述 → 别名 → 尺寸 → 其他细节。
     */
    const text = [
      itemName,
      subItemsName,
      mainDescription,
      mainAlias,
      sizeDescription,
      otherDescription,
    ].filter(Boolean).join(' ').trim();

    records.push({
      id: `sku-${i}`,
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
      text,
      vector: [], // 暂时占位，批量 embed 后回填
    });
    texts.push(text);
  }

  return { records, texts };
}

/**
 * 从 CSV 文件导入 SKU 数据到向量数据库 + SQLite。
 *
 * 写入策略：
 *   - LanceDB：全量覆盖（含 384 维 embedding 向量，供语义搜索）
 *   - SQLite：全量覆盖（结构化字段，供 CRUD 和过滤查询）
 *
 * @param filePath - 本地 CSV 文件路径（应为 Exposed-Items.csv）
 * @returns 导入记录数
 */
export async function ingestFromFile(filePath: string): Promise<{ count: number }> {
  // 第 1 步：解析 CSV
  const { records, texts } = parseCSV(filePath);

  // 第 2 步：批量生成 embedding 向量（384 维）
  const vectors = await getEmbeddings(texts);

  // 回填向量到记录
  for (let i = 0; i < records.length; i++) {
    records[i].vector = vectors[i];
  }

  // 第 3 步：写入 SQLite（结构化字段）
  replaceAllRecords(records);

  // 第 4 步：全量覆盖写入 LanceDB（向量索引）
  await replaceAllLance(records);

  return { count: records.length };
}

/**
 * 从 CSV 文件加载记录到 SQLite（不生成 embedding，不写 LanceDB）。
 *
 * 适用场景：已通过 CLI 导入过，LanceDB 端已有历史数据，
 * 启动时快速恢复 SQLite 表而不重复生成 embedding。
 *
 * @param filePath - 本地 CSV 文件路径（应为 Exposed-Items.csv）
 * @returns 加载的记录数
 */
export function loadCacheFromCSV(filePath: string): number {
  const { records } = parseCSV(filePath);
  replaceAllRecords(records);
  return records.length;
}
