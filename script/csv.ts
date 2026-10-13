import { TARGET } from './target';
import type { CsvRow } from './types';

/** 采购在解析阶段就丢弃第三列，预览、填写、覆写都不接收折扣。 */
export function parseCsv(text: string): CsvRow[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const first = lines[0].toLowerCase();
  const hasHeader = first.includes('productname') || first.includes('product')
    || first.includes('sku') || first.includes('型号');
  const rows: CsvRow[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const parts = line.split(line.includes('\t') ? '\t' : ',');
    const productName = (parts[0] ?? '').trim();
    if (!productName) continue;
    const quantity = parseInt(parts[1]?.trim() ?? '1', 10) || 1;
    const row: CsvRow = { productName, quantity };
    if (TARGET.supportsDiscount && (parts[2] ?? '').trim() !== '') {
      const discount = Number(parts[2].trim());
      if (Number.isFinite(discount) && discount >= 0 && discount <= 100) row.discount = discount;
    }
    rows.push(row);
  }
  return rows;
}
