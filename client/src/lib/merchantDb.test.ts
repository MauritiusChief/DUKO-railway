import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyMerchantPatches,
  deleteMerchantRecord,
  listMerchantRecords,
  putMerchantRecordIfCurrent,
  putMerchantRecord,
} from './merchantDb';
import type { MerchantRecord } from '../types/merchant';

const DATABASE_NAME = 'duko-merchant-collection';
const timestamp = '2026-09-22T00:00:00.000Z';

function record(overrides: Partial<MerchantRecord> = {}): MerchantRecord {
  return {
    placeId: 'place-1',
    businessName: 'Original Name',
    address: 'One Street',
    phone: '555-0100',
    emails: ['old@example.com'],
    websiteUrl: 'https://example.com/',
    socialLinks: [],
    pageTitle: '',
    pageDescription: '',
    cleanedWebsiteText: '',
    notes: 'Keep this',
    verificationStatus: 'verified',
    verifiedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe('merchant IndexedDB', () => {
  beforeEach(deleteDatabase);

  it('stores, lists, explicitly clears, and deletes records', async () => {
    await putMerchantRecord(record());
    await putMerchantRecord(record({ businessName: '', emails: [], notes: '' }));
    expect(await listMerchantRecords()).toMatchObject([{
      placeId: 'place-1', businessName: '', emails: [], notes: '',
    }]);

    await deleteMerchantRecord('place-1');
    expect(await listMerchantRecords()).toEqual([]);
  });

  it('does not persist an empty database while only listing records', async () => {
    expect(await listMerchantRecords()).toEqual([]);
    const databases = await indexedDB.databases();
    expect(databases.some((database) => database.name === DATABASE_NAME)).toBe(false);
  });

  it('upserts by Place ID without allowing empty imports to clear fields', async () => {
    await putMerchantRecord(record());
    await applyMerchantPatches([{
      placeId: 'place-1',
      businessName: '',
      phone: '555-0200',
      emails: [],
    }]);

    const [updated] = await listMerchantRecords();
    expect(updated).toMatchObject({
      placeId: 'place-1',
      businessName: 'Original Name',
      phone: '555-0200',
      emails: ['old@example.com'],
      createdAt: timestamp,
    });
  });

  it('validates every patch before opening the import transaction', async () => {
    await putMerchantRecord(record());
    await expect(applyMerchantPatches([
      { placeId: 'place-2', businessName: 'Valid' },
      { placeId: 'place-3', websiteUrl: 'file:///private/data' },
    ])).rejects.toThrow('HTTP(S)');

    expect((await listMerchantRecords()).map((item) => item.placeId)).toEqual(['place-1']);
  });

  it('rejects website text over 50 KiB on every write path', async () => {
    await expect(putMerchantRecord(record({
      cleanedWebsiteText: 'x'.repeat(50 * 1024 + 1),
    }))).rejects.toThrow('50 KiB');
    expect(await listMerchantRecords()).toEqual([]);
  });

  it('rejects stale or conflicting editor writes', async () => {
    await putMerchantRecord(record());
    await expect(putMerchantRecordIfCurrent(
      record({ businessName: 'Stale edit', updatedAt: '2026-09-23T00:00:00.000Z' }),
      '2026-09-21T00:00:00.000Z',
    )).rejects.toThrow('其他页面更新');
    expect((await listMerchantRecords())[0].businessName).toBe('Original Name');

    await expect(putMerchantRecordIfCurrent(
      record({ placeId: 'place-1', businessName: 'Conflicting new record' }),
      null,
    )).rejects.toThrow('其他页面更新');
  });
});
