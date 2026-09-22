import type { MerchantRecord, MerchantRecordPatch } from '../types/merchant';

const DATABASE_NAME = 'duko-merchant-collection';
const DATABASE_VERSION = 1;
const MERCHANT_STORE = 'merchants';
const META_STORE = 'meta';

const MAX_TEXT_BYTES = 50 * 1024;
const textEncoder = new TextEncoder();

export const MERCHANT_LIMITS = {
  placeId: 256,
  businessName: 500,
  address: 1_000,
  phone: 128,
  email: 320,
  emails: 50,
  websiteUrl: 2_048,
  socialLink: 2_048,
  socialLinks: 50,
  pageTitle: 500,
  pageDescription: 2_000,
  cleanedWebsiteTextBytes: MAX_TEXT_BYTES,
  notes: 10_000,
} as const;

interface MerchantMeta {
  key: string;
  value: string;
}

export interface MerchantStorageEstimate {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export class MerchantRecordValidationError extends Error {}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction 失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction 已中止'));
  });
}

function openMerchantDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MERCHANT_STORE)) {
        database.createObjectStore(MERCHANT_STORE, { keyPath: 'placeId' });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开商家本地名录'));
    request.onblocked = () => reject(new Error('商家名录数据库升级被其他页面阻止，请关闭其他页面后重试'));
  });
}

function merchantDatabaseExists(): Promise<boolean> {
  if (!('indexedDB' in globalThis)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let creationAborted = false;
    const request = indexedDB.open(DATABASE_NAME);
    request.onupgradeneeded = () => {
      creationAborted = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(true);
    };
    request.onerror = () => {
      if (creationAborted && request.error?.name === 'AbortError') resolve(false);
      else reject(request.error ?? new Error('无法检查商家本地名录'));
    };
  });
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new MerchantRecordValidationError(`${field} 格式无效`);
  const normalized = value.trim();
  if (!normalized) throw new MerchantRecordValidationError(`${field} 不能为空`);
  if (normalized.length > maxLength) throw new MerchantRecordValidationError(`${field} 超过 ${maxLength} 个字符`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new MerchantRecordValidationError(`${field} 格式无效`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new MerchantRecordValidationError(`${field} 超过 ${maxLength} 个字符`);
  return normalized;
}

function dateString(value: unknown, field: string, allowEmpty = true): string {
  const normalized = optionalString(value, field, 64);
  if (!normalized && allowEmpty) return '';
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw new MerchantRecordValidationError(`${field} 不是有效日期`);
  }
  return new Date(normalized).toISOString();
}

function webUrl(value: unknown, field: string): string {
  const normalized = optionalString(value, field, MERCHANT_LIMITS.websiteUrl);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    return parsed.href;
  } catch {
    throw new MerchantRecordValidationError(`${field} 必须是 HTTP(S) URL`);
  }
}

function stringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new MerchantRecordValidationError(`${field} 必须是数组`);
  if (value.length > maxItems) throw new MerchantRecordValidationError(`${field} 最多 ${maxItems} 项`);
  const unique = new Set<string>();
  for (const item of value) {
    const normalized = optionalString(item, field, maxLength);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function cleanText(value: unknown): string {
  const normalized = optionalString(value, '官网正文', Number.MAX_SAFE_INTEGER);
  if (textEncoder.encode(normalized).byteLength > MAX_TEXT_BYTES) {
    throw new MerchantRecordValidationError('官网正文超过 50 KiB');
  }
  return normalized;
}

export function normalizeMerchantPatch(input: MerchantRecordPatch): MerchantRecordPatch {
  const patch: MerchantRecordPatch = {
    placeId: requiredString(input.placeId, 'Place ID', MERCHANT_LIMITS.placeId),
  };
  if (input.businessName !== undefined) patch.businessName = optionalString(input.businessName, '商家名称', MERCHANT_LIMITS.businessName);
  if (input.address !== undefined) patch.address = optionalString(input.address, '地址', MERCHANT_LIMITS.address);
  if (input.phone !== undefined) patch.phone = optionalString(input.phone, '电话', MERCHANT_LIMITS.phone);
  if (input.emails !== undefined) patch.emails = stringArray(input.emails, '邮箱', MERCHANT_LIMITS.emails, MERCHANT_LIMITS.email);
  if (input.websiteUrl !== undefined) patch.websiteUrl = webUrl(input.websiteUrl, '官网 URL');
  if (input.socialLinks !== undefined) {
    patch.socialLinks = stringArray(input.socialLinks, '社交链接', MERCHANT_LIMITS.socialLinks, MERCHANT_LIMITS.socialLink)
      .map((link) => webUrl(link, '社交链接'));
  }
  if (input.pageTitle !== undefined) patch.pageTitle = optionalString(input.pageTitle, '页面标题', MERCHANT_LIMITS.pageTitle);
  if (input.pageDescription !== undefined) patch.pageDescription = optionalString(input.pageDescription, '页面描述', MERCHANT_LIMITS.pageDescription);
  if (input.cleanedWebsiteText !== undefined) patch.cleanedWebsiteText = cleanText(input.cleanedWebsiteText);
  if (input.notes !== undefined) patch.notes = optionalString(input.notes, '备注', MERCHANT_LIMITS.notes);
  if (input.verificationStatus !== undefined) {
    if (input.verificationStatus !== 'verified' && input.verificationStatus !== 'unverified') {
      throw new MerchantRecordValidationError('核实状态无效');
    }
    patch.verificationStatus = input.verificationStatus;
  }
  if (input.verifiedAt !== undefined) patch.verifiedAt = dateString(input.verifiedAt, '核实时间');
  if (input.createdAt !== undefined) patch.createdAt = dateString(input.createdAt, '创建时间', false);
  return patch;
}

export function normalizeMerchantRecord(input: MerchantRecord): MerchantRecord {
  const patch = normalizeMerchantPatch(input);
  const updatedAt = dateString(input.updatedAt, '更新时间', false);
  return {
    placeId: patch.placeId,
    businessName: patch.businessName ?? '',
    address: patch.address ?? '',
    phone: patch.phone ?? '',
    emails: patch.emails ?? [],
    websiteUrl: patch.websiteUrl ?? '',
    socialLinks: patch.socialLinks ?? [],
    pageTitle: patch.pageTitle ?? '',
    pageDescription: patch.pageDescription ?? '',
    cleanedWebsiteText: patch.cleanedWebsiteText ?? '',
    notes: patch.notes ?? '',
    verificationStatus: patch.verificationStatus ?? 'unverified',
    verifiedAt: patch.verifiedAt ?? '',
    createdAt: patch.createdAt ?? updatedAt,
    updatedAt,
  };
}

export function mergeMerchantRecord(
  existing: MerchantRecord | undefined,
  input: MerchantRecordPatch,
  now = new Date().toISOString(),
): MerchantRecord {
  const patch = normalizeMerchantPatch(input);
  const use = <K extends keyof MerchantRecord>(key: K, fallback: MerchantRecord[K]): MerchantRecord[K] => {
    const value = patch[key as keyof MerchantRecordPatch] as MerchantRecord[K] | undefined;
    if (Array.isArray(value)) return (value.length > 0 ? value : fallback) as MerchantRecord[K];
    return (typeof value === 'string' && value.length > 0 ? value : fallback) as MerchantRecord[K];
  };
  const empty: MerchantRecord = {
    placeId: patch.placeId,
    businessName: '', address: '', phone: '', emails: [], websiteUrl: '', socialLinks: [],
    pageTitle: '', pageDescription: '', cleanedWebsiteText: '', notes: '',
    verificationStatus: 'unverified', verifiedAt: '', createdAt: now, updatedAt: now,
  };
  const base = existing ?? empty;
  return normalizeMerchantRecord({
    placeId: patch.placeId,
    businessName: use('businessName', base.businessName),
    address: use('address', base.address),
    phone: use('phone', base.phone),
    emails: use('emails', base.emails),
    websiteUrl: use('websiteUrl', base.websiteUrl),
    socialLinks: use('socialLinks', base.socialLinks),
    pageTitle: use('pageTitle', base.pageTitle),
    pageDescription: use('pageDescription', base.pageDescription),
    cleanedWebsiteText: use('cleanedWebsiteText', base.cleanedWebsiteText),
    notes: use('notes', base.notes),
    verificationStatus: patch.verificationStatus ?? base.verificationStatus,
    verifiedAt: use('verifiedAt', base.verifiedAt),
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: now,
  });
}

export function merchantRecordContentEqual(left: MerchantRecord, right: MerchantRecord): boolean {
  const withoutUpdatedAt = ({ updatedAt: _ignored, ...record }: MerchantRecord) => record;
  return JSON.stringify(withoutUpdatedAt(left)) === JSON.stringify(withoutUpdatedAt(right));
}

export async function listMerchantRecords(): Promise<MerchantRecord[]> {
  if (!await merchantDatabaseExists()) return [];
  const database = await openMerchantDatabase();
  try {
    const transaction = database.transaction(MERCHANT_STORE, 'readonly');
    const records = await requestResult(transaction.objectStore(MERCHANT_STORE).getAll()) as MerchantRecord[];
    await transactionComplete(transaction);
    return records.map(normalizeMerchantRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } finally {
    database.close();
  }
}

export async function putMerchantRecord(record: MerchantRecord): Promise<MerchantRecord> {
  const normalized = normalizeMerchantRecord(record);
  const database = await openMerchantDatabase();
  try {
    const transaction = database.transaction(MERCHANT_STORE, 'readwrite');
    transaction.objectStore(MERCHANT_STORE).put(normalized);
    await transactionComplete(transaction);
    return normalized;
  } finally {
    database.close();
  }
}

export async function putMerchantRecordIfCurrent(
  record: MerchantRecord,
  expectedUpdatedAt: string | null,
): Promise<MerchantRecord> {
  const normalized = normalizeMerchantRecord(record);
  const database = await openMerchantDatabase();
  try {
    const transaction = database.transaction(MERCHANT_STORE, 'readwrite');
    const completion = transactionComplete(transaction);
    try {
      const store = transaction.objectStore(MERCHANT_STORE);
      const current = await requestResult(store.get(normalized.placeId)) as MerchantRecord | undefined;
      const unchanged = expectedUpdatedAt === null ? current === undefined : current?.updatedAt === expectedUpdatedAt;
      if (!unchanged) throw new Error('该记录已在其他页面更新，请重新载入后再编辑');
      store.put(normalized);
      await completion;
      return normalized;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function deleteMerchantRecord(placeId: string): Promise<void> {
  const normalizedId = requiredString(placeId, 'Place ID', MERCHANT_LIMITS.placeId);
  const database = await openMerchantDatabase();
  try {
    const transaction = database.transaction(MERCHANT_STORE, 'readwrite');
    transaction.objectStore(MERCHANT_STORE).delete(normalizedId);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function applyMerchantPatches(patches: MerchantRecordPatch[]): Promise<void> {
  const normalizedPatches = patches.map(normalizeMerchantPatch);
  const database = await openMerchantDatabase();
  try {
    const transaction = database.transaction([MERCHANT_STORE, META_STORE], 'readwrite');
    const completion = transactionComplete(transaction);
    try {
      const merchants = transaction.objectStore(MERCHANT_STORE);
      for (const patch of normalizedPatches) {
        const existing = await requestResult(merchants.get(patch.placeId)) as MerchantRecord | undefined;
        merchants.put(mergeMerchantRecord(existing && normalizeMerchantRecord(existing), patch));
      }
      const meta: MerchantMeta = { key: 'lastImportAt', value: new Date().toISOString() };
      transaction.objectStore(META_STORE).put(meta);
      await completion;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function markMerchantExported(): Promise<void> {
  const database = await openMerchantDatabase();
  try {
    const transaction = database.transaction(META_STORE, 'readwrite');
    transaction.objectStore(META_STORE).put({ key: 'lastExportAt', value: new Date().toISOString() } satisfies MerchantMeta);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function estimateMerchantStorage(): Promise<MerchantStorageEstimate> {
  if (!navigator.storage) return { usage: null, quota: null, persisted: null };
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate(),
    navigator.storage.persisted?.() ?? Promise.resolve(null),
  ]);
  return {
    usage: estimate.usage ?? null,
    quota: estimate.quota ?? null,
    persisted,
  };
}

export async function requestPersistentMerchantStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  return navigator.storage.persist();
}
