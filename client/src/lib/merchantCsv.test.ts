import { describe, expect, it } from 'vitest';
import { exportMerchantCsv, previewMerchantCsv } from './merchantCsv';
import type { MerchantRecord } from '../types/merchant';

const record: MerchantRecord = {
  placeId: 'place-1',
  businessName: '=SUM(1,1)',
  address: 'One Street, Suite 2',
  phone: '+1 555 0100',
  emails: ['sales@example.com'],
  websiteUrl: 'https://example.com/',
  socialLinks: ['https://social.example/profile'],
  pageTitle: 'Example',
  pageDescription: 'Line one\nLine two',
  cleanedWebsiteText: 'Quoted "content"',
  notes: '',
  verificationStatus: 'verified',
  verifiedAt: '2026-09-22T00:00:00.000Z',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

describe('merchant CSV', () => {
  it('exports BOM, quoted multiline fields, JSON arrays, and formula protection', () => {
    const csv = exportMerchantCsv([record]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"[""sales@example.com""]"');
    expect(csv).toContain("'=SUM(1,1)");
    expect(csv).toContain('Line one\nLine two');
  });

  it('previews new, update, and unchanged rows', () => {
    const unchanged = exportMerchantCsv([record]);
    expect(previewMerchantCsv(unchanged, [record])).toMatchObject({ added: 0, updated: 0, unchanged: 1, errors: 0 });

    const updatedCsv = unchanged.replace('One Street, Suite 2', 'Two Street');
    expect(previewMerchantCsv(updatedCsv, [record])).toMatchObject({ added: 0, updated: 1, unchanged: 0, errors: 0 });
    expect(previewMerchantCsv(unchanged, [])).toMatchObject({ added: 1, updated: 0, unchanged: 0, errors: 0 });
  });

  it('rejects duplicate and missing Place IDs with line numbers', () => {
    const header = 'placeId,businessName\n';
    const preview = previewMerchantCsv(`${header}same,One\nsame,Two\n,Missing`, []);
    expect(preview.errors).toBe(2);
    expect(preview.rows[1]).toMatchObject({ line: 3, action: 'error' });
    expect(preview.rows[1].errors[0]).toContain('第 2 行');
    expect(preview.rows[2]).toMatchObject({ line: 4, action: 'error' });
  });

  it('reports physical lines after quoted multiline cells', () => {
    const preview = previewMerchantCsv('placeId,notes\nsame,"line one\nline two"\nsame,duplicate', []);
    expect(preview.rows[1]).toMatchObject({ line: 4, action: 'error' });
    expect(preview.rows[1].errors[0]).toContain('第 2 行');
  });

  it('round-trips genuine leading apostrophes separately from formula protection', () => {
    const apostropheRecord = { ...record, businessName: "'=literal" };
    const csv = exportMerchantCsv([apostropheRecord]);
    expect(csv).toContain("''=literal");
    expect(previewMerchantCsv(csv, [apostropheRecord])).toMatchObject({
      added: 0, updated: 0, unchanged: 1, errors: 0,
    });
  });

  it('rejects invalid JSON arrays and unsafe URLs', () => {
    const arrays = previewMerchantCsv('placeId,emails\np1,not-json', []);
    expect(arrays.rows[0].errors[0]).toContain('JSON');

    const urls = previewMerchantCsv('placeId,websiteUrl\np1,javascript:alert(1)', []);
    expect(urls.rows[0].errors[0]).toContain('HTTP(S)');
  });
});
