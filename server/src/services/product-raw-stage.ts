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
