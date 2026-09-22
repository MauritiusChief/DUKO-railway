import Papa from 'papaparse';
import {
  merchantRecordContentEqual,
  mergeMerchantRecord,
  normalizeMerchantPatch,
} from './merchantDb';
import type { MerchantRecord, MerchantRecordPatch } from '../types/merchant';

export const MAX_MERCHANT_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_MERCHANT_CSV_ROWS = 5_000;

export const MERCHANT_CSV_HEADERS = [
  'placeId', 'businessName', 'address', 'phone', 'emails', 'websiteUrl', 'socialLinks',
  'pageTitle', 'pageDescription', 'cleanedWebsiteText', 'notes', 'verificationStatus',
  'verifiedAt', 'createdAt', 'updatedAt',
] as const;

type MerchantCsvHeader = typeof MERCHANT_CSV_HEADERS[number];
type MerchantCsvRow = Record<MerchantCsvHeader, string>;

export interface MerchantCsvPreviewRow {
  line: number;
  placeId: string;
  action: 'new' | 'update' | 'unchanged' | 'error';
  errors: string[];
  patch?: MerchantRecordPatch;
}

export interface MerchantCsvPreview {
  rows: MerchantCsvPreviewRow[];
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
}

function recordToCsvRow(record: MerchantRecord): MerchantCsvRow {
  const row: MerchantCsvRow = {
    placeId: record.placeId,
    businessName: record.businessName,
    address: record.address,
    phone: record.phone,
    emails: JSON.stringify(record.emails),
    websiteUrl: record.websiteUrl,
    socialLinks: JSON.stringify(record.socialLinks),
    pageTitle: record.pageTitle,
    pageDescription: record.pageDescription,
    cleanedWebsiteText: record.cleanedWebsiteText,
    notes: record.notes,
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  for (const key of MERCHANT_CSV_HEADERS) {
    if (row[key].startsWith("'")) row[key] = `'${row[key]}`;
  }
  return row;
}

export function exportMerchantCsv(records: MerchantRecord[]): string {
  const csv = Papa.unparse(records.map(recordToCsvRow), {
    columns: [...MERCHANT_CSV_HEADERS],
    newline: '\r\n',
    quotes: true,
    escapeFormulae: true,
  });
  return `\uFEFF${csv}`;
}

function parseArray(value: string, field: string): string[] | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} 必须是 JSON 字符串数组`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} 必须是 JSON 字符串数组`);
  }
  return parsed;
}

function optionalValue(row: Record<string, string>, field: MerchantCsvHeader): string | undefined {
  const value = row[field]?.trim();
  return value ? value : undefined;
}

function rowToPatch(row: Record<string, string>): MerchantRecordPatch {
  const verificationStatus = optionalValue(row, 'verificationStatus');
  if (verificationStatus && verificationStatus !== 'verified' && verificationStatus !== 'unverified') {
    throw new Error('verificationStatus 只能是 verified 或 unverified');
  }
  return normalizeMerchantPatch({
    placeId: row.placeId ?? '',
    businessName: optionalValue(row, 'businessName'),
    address: optionalValue(row, 'address'),
    phone: optionalValue(row, 'phone'),
    emails: parseArray(row.emails ?? '', 'emails'),
    websiteUrl: optionalValue(row, 'websiteUrl'),
    socialLinks: parseArray(row.socialLinks ?? '', 'socialLinks'),
    pageTitle: optionalValue(row, 'pageTitle'),
    pageDescription: optionalValue(row, 'pageDescription'),
    cleanedWebsiteText: optionalValue(row, 'cleanedWebsiteText'),
    notes: optionalValue(row, 'notes'),
    verificationStatus: verificationStatus as MerchantRecordPatch['verificationStatus'],
    verifiedAt: optionalValue(row, 'verifiedAt'),
    createdAt: optionalValue(row, 'createdAt'),
  });
}

export function previewMerchantCsv(csv: string, existingRecords: MerchantRecord[]): MerchantCsvPreview {
  if (new TextEncoder().encode(csv).byteLength > MAX_MERCHANT_CSV_BYTES) {
    throw new Error('CSV 文件不能超过 5 MiB');
  }
  const source = csv.replace(/^\uFEFF/, '');
  const parsed = Papa.parse<Record<string, string>>(source, {
    header: true,
    skipEmptyLines: false,
    transformHeader: (header) => header.trim(),
    // Genuine leading apostrophes are doubled before export formula protection is applied.
    transform: (value) => value.startsWith("''")
      ? value.slice(1)
      : value.replace(/^'(?=[=+\-@\t\r])/, ''),
  });
  if (!parsed.meta.fields?.includes('placeId')) throw new Error('CSV 缺少必需列 placeId');
  if (parsed.data.length > MAX_MERCHANT_CSV_ROWS) throw new Error(`CSV 最多允许 ${MAX_MERCHANT_CSV_ROWS} 行`);

  const recordStartLines: number[] = [1];
  let physicalLine = 1;
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (inQuotes && source[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
      continue;
    }
    if (character === '\r' || character === '\n') {
      const isCrLf = character === '\r' && source[index + 1] === '\n';
      if (!inQuotes) recordStartLines.push(physicalLine + 1);
      physicalLine += 1;
      if (isCrLf) index += 1;
    }
  }

  const indexedRows = parsed.data.map((row, index) => ({
    row,
    line: recordStartLines[index + 1] ?? index + 2,
  })).filter(({ row }) => Object.values(row).some((value) => value.trim().length > 0));
  const existing = new Map(existingRecords.map((record) => [record.placeId, record]));
  const firstLineByPlaceId = new Map<string, number>();
  const parseErrors = new Map<number, string[]>();
  for (const error of parsed.errors) {
    const line = recordStartLines[(error.row ?? 0) + 1] ?? (error.row ?? 0) + 2;
    parseErrors.set(line, [...(parseErrors.get(line) ?? []), error.message]);
  }

  const rows = indexedRows.map(({ row, line }): MerchantCsvPreviewRow => {
    const errors = [...(parseErrors.get(line) ?? [])];
    const placeId = row.placeId?.trim() ?? '';
    if (!placeId) errors.push('placeId 不能为空');
    const firstLine = placeId ? firstLineByPlaceId.get(placeId) : undefined;
    if (firstLine !== undefined) errors.push(`Place ID 与第 ${firstLine} 行重复`);
    else if (placeId) firstLineByPlaceId.set(placeId, line);

    let patch: MerchantRecordPatch | undefined;
    if (errors.length === 0) {
      try {
        patch = rowToPatch(row);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : '字段校验失败');
      }
    }
    if (!patch || errors.length > 0) return { line, placeId, action: 'error', errors };

    const current = existing.get(patch.placeId);
    if (!current) return { line, placeId, action: 'new', errors: [], patch };
    const merged = mergeMerchantRecord(current, patch, current.updatedAt);
    return {
      line,
      placeId,
      action: merchantRecordContentEqual(current, merged) ? 'unchanged' : 'update',
      errors: [],
      patch,
    };
  });

  return {
    rows,
    added: rows.filter((row) => row.action === 'new').length,
    updated: rows.filter((row) => row.action === 'update').length,
    unchanged: rows.filter((row) => row.action === 'unchanged').length,
    errors: rows.filter((row) => row.action === 'error').length,
  };
}

export function applicableMerchantPatches(preview: MerchantCsvPreview): MerchantRecordPatch[] {
  return preview.rows
    .filter((row) => row.action === 'new' || row.action === 'update')
    .flatMap((row) => row.patch ? [row.patch] : []);
}
