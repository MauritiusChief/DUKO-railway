/**
 * Product-raw 暂存 —— 把自动下载得到的最新产品 CSV 落盘到数据目录，
 * 供管理员择机（非工作时间）手动运行 refresh-data-cli 重建数据管线。
 *
 * 设计要点：
 *   - 只落盘暂存，不触发任何 refresh；
 *   - 文件名带 UTC 日期（Product-raw-YYYY-MM-DD.csv），便于人工核对新鲜度；
 *   - 写入前删除目录中所有既存 Product-raw*.csv（含历史固定名 Product-raw.csv），
 *     保证最终只保留一个最新文件，避免 refresh 读到旧数据。
 */

import fs from 'fs';
import path from 'path';

const RAW_PREFIX = 'Product-raw';
const RAW_SUFFIX = '.csv';
const DATED_RAW_RE = /^Product-raw-\d{4}-\d{2}-\d{2}\.csv$/;

/**
 * 在 dataDir 中发现最新一份 Product-raw CSV 的路径。
 *
 * 优先选取日期归档的 Product-raw-YYYY-MM-DD.csv，
 * 回退到历史固定名 Product-raw.csv。
 *
 * 都不存在时抛出明确错误。
 */
export function discoverRawCsvPath(dataDir: string): string {
  try {
    const candidates = fs.readdirSync(dataDir)
      .filter((f) => DATED_RAW_RE.test(f))
      .sort();
    if (candidates.length > 0) {
      return path.join(dataDir, candidates[candidates.length - 1]);
    }
  } catch {
    // 目录可能不存在，继续尝试 legacy
  }
  const legacy = path.join(dataDir, 'Product-raw.csv');
  if (fs.existsSync(legacy)) {
    return legacy;
  }
  throw new Error(
    `未在 ${dataDir} 找到 Product-raw-YYYY-MM-DD.csv 或 Product-raw.csv。`
    + '请先在库存看板执行一次自动下载查询以暂存最新 CSV，再重试。',
  );
}

/**
 * 暂存最新 Product CSV 到数据目录。
 *
 * @param csv 下载得到的原始 CSV 文本
 * @param dataDir 数据目录（DB_DIR）
 * @returns 写入文件的绝对路径
 */
export function stageProductRawCsv(csv: string, dataDir: string): string {
  // 清理既有 Product-raw*.csv（含历史固定名 Product-raw.csv，它同样以 Product-raw 开头）
  for (const name of fs.readdirSync(dataDir)) {
    if (name.startsWith(RAW_PREFIX) && name.endsWith(RAW_SUFFIX)) {
      fs.unlinkSync(path.join(dataDir, name));
    }
  }

  const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const filename = `${RAW_PREFIX}-${dateStamp}${RAW_SUFFIX}`;
  const filepath = path.join(dataDir, filename);
  fs.writeFileSync(filepath, csv, 'utf-8');
  return filepath;
}
