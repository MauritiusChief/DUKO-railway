import { Fragment, type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import {
  applicableMerchantPatches,
  exportMerchantCsv,
  MAX_MERCHANT_CSV_BYTES,
  previewMerchantCsv,
  type MerchantCsvPreview,
} from '../lib/merchantCsv';
import {
  applyMerchantPatches,
  deleteMerchantRecord,
  estimateMerchantStorage,
  listMerchantRecords,
  markMerchantExported,
  mergeMerchantRecord,
  MERCHANT_LIMITS,
  putMerchantRecordIfCurrent,
  requestPersistentMerchantStorage,
  type MerchantStorageEstimate,
} from '../lib/merchantDb';
import type {
  MerchantRecord,
  MerchantSearchResponse,
  MerchantSearchResult,
  MerchantWebsiteExtraction,
  MerchantWebsiteExtractionState,
} from '../types/merchant';
import './MerchantCollectionPage.css';

const CONTIGUOUS_US_BOUNDS = {
  minLatitude: 24.396308,
  maxLatitude: 49.384358,
  minLongitude: -124.848974,
  maxLongitude: -66.885444,
} as const;

const MAX_RANGE_KM = 50;

interface SearchForm {
  textQuery: string;
  centerCoordinates: string;
  rangeKm: string;
}

function validateForm(form: SearchForm): string | null {
  const textQuery = form.textQuery.trim();
  if (!textQuery) return '请输入商家类别或服务查询词。';
  if (textQuery.length > 200) return '查询词不能超过 200 个字符。';

  const parts = form.centerCoordinates.split(',');
  if (parts.length !== 2) return '中心坐标必须是“纬度, 经度”格式。';
  const latitude = Number(parts[0].trim());
  const longitude = Number(parts[1].trim());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return '中心坐标必须包含两个有效数字。';
  }
  const bounds = CONTIGUOUS_US_BOUNDS;
  if (
    latitude < bounds.minLatitude
    || latitude > bounds.maxLatitude
    || longitude < bounds.minLongitude
    || longitude > bounds.maxLongitude
  ) {
    return '中心坐标必须位于美国本土连续 48 州范围内。';
  }

  const rangeKm = Number(form.rangeKm);
  if (!Number.isFinite(rangeKm) || rangeKm <= 0 || rangeKm > MAX_RANGE_KM) {
    return `查询范围必须大于 0 且不超过 ${MAX_RANGE_KM} km。`;
  }
  return null;
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function websiteLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '访问官网';
  }
}

function businessStatusLabel(status: string | null): string {
  switch (status) {
    case 'OPERATIONAL':
      return '营业中';
    case 'CLOSED_TEMPORARILY':
      return '暂时停业';
    case 'CLOSED_PERMANENTLY':
      return '永久停业';
    default:
      return status ?? '未知';
  }
}

interface ResultRowProps {
  merchant: MerchantSearchResult;
  selected: boolean;
  collected: boolean;
  extraction?: MerchantWebsiteExtractionState;
  extracting: boolean;
  recordSaving: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onOpenRecord: () => void;
}

function ResultRow({
  merchant, selected, collected, extraction, extracting, recordSaving, onToggle, onRetry, onOpenRecord,
}: ResultRowProps) {
  const websiteUrl = safeExternalUrl(merchant.websiteUrl);
  const googleMapsUrl = safeExternalUrl(merchant.googleMapsUrl);
  const phone = merchant.internationalPhoneNumber ?? merchant.nationalPhoneNumber;
  const status = extraction?.status ?? (selected ? 'pending' : null);

  return (
    <Fragment>
      <tr>
        <td className="mc-select-cell">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={!websiteUrl || extracting}
            aria-label={`选择 ${merchant.businessName ?? merchant.placeId} 进行官网提取`}
          />
        </td>
        <td>
          <div className="mc-business-name">{merchant.businessName ?? '未提供名称'}</div>
          <div className="mc-place-id">{merchant.placeId}</div>
        </td>
        <td>
          <div>{merchant.formattedAddress ?? '未提供地址'}</div>
          {merchant.location && (
            <div className="mc-coordinate">
              {merchant.location.latitude.toFixed(5)}, {merchant.location.longitude.toFixed(5)}
            </div>
          )}
        </td>
        <td>{phone ?? '未提供'}</td>
        <td>
          {websiteUrl ? (
            <a href={websiteUrl} target="_blank" rel="noreferrer">
              {websiteLabel(websiteUrl)}
            </a>
          ) : '未提供'}
        </td>
        <td>
          <span className={`mc-status mc-status-${merchant.businessStatus?.toLowerCase() ?? 'unknown'}`}>
            {businessStatusLabel(merchant.businessStatus)}
          </span>
        </td>
        <td>
          {googleMapsUrl ? (
            <a href={googleMapsUrl} target="_blank" rel="noreferrer">在 Google Maps 查看</a>
          ) : '未提供'}
        </td>
        <td className="mc-extraction-cell">
          {!websiteUrl && <span className="mc-extract-state mc-extract-state-none">无官网</span>}
          {status && (
            <span className={`mc-extract-state mc-extract-state-${status}`}>
              {status === 'pending' && '等待抓取'}
              {status === 'loading' && '抓取中'}
              {status === 'success' && '已提取'}
              {status === 'failed' && '失败'}
            </span>
          )}
          {extraction?.status === 'failed' && (
            <button className="mc-inline-button" type="button" onClick={onRetry} disabled={extracting}>
              重试
            </button>
          )}
          {extraction?.error && <div className="mc-row-error">{extraction.error}</div>}
        </td>
        <td className="mc-directory-cell">
          {collected && <span className="mc-directory-badge">已收录</span>}
          <button className="mc-inline-button" type="button" onClick={onOpenRecord} disabled={recordSaving}>
            {collected ? '核实并合并' : '核实并纳入'}
          </button>
        </td>
      </tr>
      {extraction?.status === 'success' && extraction.data && (
        <tr className="mc-detail-row">
          <td colSpan={9}>
            <ExtractionDetails extraction={extraction.data} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

function formatBytes(value: number | null): string {
  if (value === null) return '浏览器未提供';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function createRecordDraft(
  merchant: MerchantSearchResult,
  extraction?: MerchantWebsiteExtraction,
): MerchantRecord {
  const now = new Date().toISOString();
  return {
    placeId: merchant.placeId,
    businessName: merchant.businessName ?? '',
    address: merchant.formattedAddress ?? '',
    phone: extraction?.phones[0] ?? merchant.internationalPhoneNumber ?? merchant.nationalPhoneNumber ?? '',
    emails: extraction?.emails ?? [],
    websiteUrl: safeExternalUrl(extraction?.sourceUrl ?? merchant.websiteUrl) ?? '',
    socialLinks: [],
    pageTitle: extraction?.pageTitle ?? '',
    pageDescription: extraction?.pageDescription ?? '',
    cleanedWebsiteText: extraction?.cleanedWebsiteText ?? '',
    notes: '',
    verificationStatus: 'verified',
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

interface MerchantEditorProps {
  record: MerchantRecord;
  saving: boolean;
  onChange: (record: MerchantRecord) => void;
  onCancel: () => void;
  onSave: () => void;
}

function MerchantEditor({ record, saving, onChange, onCancel, onSave }: MerchantEditorProps) {
  const update = <K extends keyof MerchantRecord>(field: K, value: MerchantRecord[K]) => {
    onChange({ ...record, [field]: value });
  };
  return (
    <section className="mc-editor" aria-labelledby="merchant-editor-heading">
      <div className="mc-editor-heading">
        <div>
          <span className="mc-step">VERIFY</span>
          <h3 id="merchant-editor-heading">人工核实本地记录</h3>
          <p>保存后写入当前浏览器。空字段只会在这里被明确清除。</p>
        </div>
        <code>{record.placeId}</code>
      </div>
      <fieldset className="mc-editor-grid" disabled={saving}>
        <label className="mc-field">
          <span>商家名称</span>
          <input value={record.businessName} maxLength={MERCHANT_LIMITS.businessName} onChange={(e) => update('businessName', e.target.value)} />
        </label>
        <label className="mc-field">
          <span>电话</span>
          <input value={record.phone} maxLength={MERCHANT_LIMITS.phone} onChange={(e) => update('phone', e.target.value)} />
        </label>
        <label className="mc-field mc-editor-wide">
          <span>地址</span>
          <input value={record.address} maxLength={MERCHANT_LIMITS.address} onChange={(e) => update('address', e.target.value)} />
        </label>
        <label className="mc-field mc-editor-wide">
          <span>官网 URL</span>
          <input value={record.websiteUrl} maxLength={MERCHANT_LIMITS.websiteUrl} onChange={(e) => update('websiteUrl', e.target.value)} />
        </label>
        <label className="mc-field">
          <span>邮箱（逗号或换行分隔）</span>
          <textarea value={record.emails.join('\n')} onChange={(e) => update('emails', splitList(e.target.value))} />
        </label>
        <label className="mc-field">
          <span>社交链接（逗号或换行分隔）</span>
          <textarea value={record.socialLinks.join('\n')} onChange={(e) => update('socialLinks', splitList(e.target.value))} />
        </label>
        <label className="mc-field">
          <span>页面标题</span>
          <input value={record.pageTitle} maxLength={MERCHANT_LIMITS.pageTitle} onChange={(e) => update('pageTitle', e.target.value)} />
        </label>
        <label className="mc-field">
          <span>页面描述</span>
          <textarea value={record.pageDescription} maxLength={MERCHANT_LIMITS.pageDescription} onChange={(e) => update('pageDescription', e.target.value)} />
        </label>
        <label className="mc-field mc-editor-wide">
          <span>清洗后的官网正文（最多 50 KiB）</span>
          <textarea className="mc-editor-text" value={record.cleanedWebsiteText} onChange={(e) => update('cleanedWebsiteText', e.target.value)} />
        </label>
        <label className="mc-field mc-editor-wide">
          <span>人工备注</span>
          <textarea value={record.notes} maxLength={MERCHANT_LIMITS.notes} onChange={(e) => update('notes', e.target.value)} />
        </label>
        <label className="mc-field">
          <span>核实状态</span>
          <select value={record.verificationStatus} onChange={(e) => update('verificationStatus', e.target.value as MerchantRecord['verificationStatus'])}>
            <option value="verified">已核实</option>
            <option value="unverified">未核实</option>
          </select>
        </label>
      </fieldset>
      <div className="mc-editor-actions">
        <button className="mc-button mc-button-secondary" type="button" onClick={onCancel} disabled={saving}>取消</button>
        <button className="mc-button mc-button-primary" type="button" onClick={onSave} disabled={saving}>
          {saving ? '正在保存...' : '确认保存到本地名录'}
        </button>
      </div>
    </section>
  );
}

function ExtractionDetails({ extraction }: { extraction: MerchantWebsiteExtraction }) {
  const canonicalUrl = safeExternalUrl(extraction.canonicalUrl);
  return (
    <details className="mc-extraction-details">
      <summary>
        查看官网提取草稿
        <span>{extraction.emails.length} 邮箱 · {extraction.phones.length} 电话</span>
      </summary>
      <div className="mc-extraction-grid">
        <div>
          <span className="mc-detail-label">邮箱</span>
          <div>{extraction.emails.length > 0 ? extraction.emails.join(', ') : '静态首页未发现'}</div>
        </div>
        <div>
          <span className="mc-detail-label">电话</span>
          <div>{extraction.phones.length > 0 ? extraction.phones.join(', ') : '静态首页未发现'}</div>
        </div>
        <div>
          <span className="mc-detail-label">页面标题</span>
          <div>{extraction.pageTitle ?? '未提供'}</div>
        </div>
        <div>
          <span className="mc-detail-label">Meta description</span>
          <div>{extraction.pageDescription ?? '未提供'}</div>
        </div>
        <div>
          <span className="mc-detail-label">Canonical</span>
          <div>
            {canonicalUrl ? <a href={canonicalUrl} target="_blank" rel="noreferrer">{canonicalUrl}</a> : '未提供'}
          </div>
        </div>
      </div>
      <div className="mc-cleaned-text">
        <div className="mc-cleaned-text-heading">
          <span className="mc-detail-label">清洗正文</span>
          {extraction.textTruncated && <span>已截断到 50 KiB</span>}
        </div>
        <p>{extraction.cleanedWebsiteText || '静态首页没有可显示正文。'}</p>
      </div>
    </details>
  );
}

export default function MerchantCollectionPage() {
  const navigate = useNavigate();
  const requestRef = useRef<AbortController | null>(null);
  const extractionControllersRef = useRef(new Map<string, AbortController>());
  const extractionGenerationRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<SearchForm>({
    textQuery: '',
    centerCoordinates: '',
    rangeKm: '10',
  });
  const [searchResult, setSearchResult] = useState<MerchantSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedPlaceIds, setSelectedPlaceIds] = useState<Set<string>>(new Set());
  const [extractions, setExtractions] = useState<Record<string, MerchantWebsiteExtractionState>>({});
  const [extracting, setExtracting] = useState(false);
  const [merchantRecords, setMerchantRecords] = useState<MerchantRecord[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryMessage, setDirectoryMessage] = useState('');
  const [editingRecord, setEditingRecord] = useState<MerchantRecord | null>(null);
  const [editingExpectedUpdatedAt, setEditingExpectedUpdatedAt] = useState<string | null>(null);
  const [savingRecord, setSavingRecord] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState<MerchantStorageEstimate>({ usage: null, quota: null, persisted: null });
  const [importPreview, setImportPreview] = useState<MerchantCsvPreview | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [applyingImport, setApplyingImport] = useState(false);

  useEffect(() => () => {
    requestRef.current?.abort();
    extractionControllersRef.current.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    void refreshDirectory();
  }, []);

  async function refreshStorageEstimate() {
    try {
      setStorageEstimate(await estimateMerchantStorage());
    } catch {
      setStorageEstimate({ usage: null, quota: null, persisted: null });
    }
  }

  async function refreshDirectory() {
    setDirectoryLoading(true);
    try {
      setMerchantRecords(await listMerchantRecords());
      setDirectoryError('');
      await refreshStorageEstimate();
    } catch (loadError) {
      setDirectoryError(loadError instanceof Error ? loadError.message : '无法读取浏览器本地名录');
    } finally {
      setDirectoryLoading(false);
    }
  }

  function openMerchantRecord(merchant: MerchantSearchResult) {
    const existing = merchantRecords.find((record) => record.placeId === merchant.placeId);
    if (existing) {
      const extraction = extractions[merchant.placeId]?.data;
      setEditingRecord(mergeMerchantRecord(existing, {
        placeId: merchant.placeId,
        businessName: merchant.businessName ?? undefined,
        address: merchant.formattedAddress ?? undefined,
        phone: extraction?.phones[0] ?? merchant.internationalPhoneNumber ?? merchant.nationalPhoneNumber ?? undefined,
        emails: extraction?.emails,
        websiteUrl: safeExternalUrl(extraction?.sourceUrl ?? merchant.websiteUrl) ?? undefined,
        pageTitle: extraction?.pageTitle ?? undefined,
        pageDescription: extraction?.pageDescription ?? undefined,
        cleanedWebsiteText: extraction?.cleanedWebsiteText ?? undefined,
        verificationStatus: 'verified',
        verifiedAt: new Date().toISOString(),
      }, existing.updatedAt));
      setEditingExpectedUpdatedAt(existing.updatedAt);
      return;
    }
    setEditingRecord(createRecordDraft(merchant, extractions[merchant.placeId]?.data));
    setEditingExpectedUpdatedAt(null);
  }

  async function saveEditingRecord() {
    if (!editingRecord || savingRecord) return;
    setSavingRecord(true);
    setDirectoryError('');
    try {
      const now = new Date().toISOString();
      await putMerchantRecordIfCurrent({
        ...editingRecord,
        verifiedAt: editingRecord.verificationStatus === 'verified'
          ? editingRecord.verifiedAt || now
          : '',
        updatedAt: now,
      }, editingExpectedUpdatedAt);
      setEditingRecord(null);
      setEditingExpectedUpdatedAt(null);
      setDirectoryMessage('本地名录已更新。');
      await refreshDirectory();
    } catch (saveError) {
      setDirectoryError(saveError instanceof Error ? saveError.message : '保存本地记录失败');
    } finally {
      setSavingRecord(false);
    }
  }

  async function removeMerchantRecord(record: MerchantRecord) {
    if (!window.confirm(`确定从当前浏览器删除“${record.businessName || record.placeId}”吗？`)) return;
    try {
      await deleteMerchantRecord(record.placeId);
      if (editingRecord?.placeId === record.placeId) {
        setEditingRecord(null);
        setEditingExpectedUpdatedAt(null);
      }
      setDirectoryMessage('本地记录已删除。');
      await refreshDirectory();
    } catch (deleteError) {
      setDirectoryError(deleteError instanceof Error ? deleteError.message : '删除本地记录失败');
    }
  }

  async function exportDirectory() {
    if (merchantRecords.length === 0) return;
    const csv = exportMerchantCsv(merchantRecords);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `duko-merchants-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDirectoryMessage('CSV 已导出。清洗正文可能包含合法的多行单元格。');
    try {
      await markMerchantExported();
    } catch {
      // The downloaded backup remains valid even if optional export metadata cannot be updated.
    }
  }

  async function selectImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setImportPreview(null);
    setImportFileName('');
    if (!file) return;
    if (file.size > MAX_MERCHANT_CSV_BYTES) {
      setDirectoryError('CSV 文件不能超过 5 MiB。');
      return;
    }
    try {
      const preview = previewMerchantCsv(await file.text(), merchantRecords);
      setImportPreview(preview);
      setImportFileName(file.name);
      setDirectoryError('');
    } catch (importError) {
      setDirectoryError(importError instanceof Error ? importError.message : 'CSV 解析失败');
    }
  }

  async function confirmImport() {
    if (!importPreview || importPreview.errors > 0 || applyingImport) return;
    const patches = applicableMerchantPatches(importPreview);
    setApplyingImport(true);
    try {
      if (patches.length > 0) await applyMerchantPatches(patches);
      setDirectoryMessage(`CSV 已应用：新增 ${importPreview.added} 条，更新 ${importPreview.updated} 条。`);
      setImportPreview(null);
      setImportFileName('');
      await refreshDirectory();
    } catch (importError) {
      setDirectoryError(importError instanceof Error ? importError.message : 'CSV 导入失败，未应用更改');
    } finally {
      setApplyingImport(false);
    }
  }

  async function requestPersistentStorage() {
    try {
      const persisted = await requestPersistentMerchantStorage();
      setDirectoryMessage(persisted === true
        ? '浏览器已允许持久存储。清除站点数据仍会删除名录。'
        : persisted === false
          ? '浏览器未授予持久存储；请定期导出 CSV 备份。'
          : '当前浏览器不支持持久存储请求。');
      await refreshStorageEstimate();
    } catch {
      setDirectoryError('无法请求浏览器持久存储。');
    }
  }

  function resetExtractions() {
    extractionGenerationRef.current += 1;
    extractionControllersRef.current.forEach((controller) => controller.abort());
    extractionControllersRef.current.clear();
    setSelectedPlaceIds(new Set());
    setExtractions({});
    setExtracting(false);
  }

  function updateForm(field: keyof SearchForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      resetExtractions();
      setError(validationError);
      setSearchResult(null);
      return;
    }

    requestRef.current?.abort();
    resetExtractions();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    setSearchResult(null);

    try {
      const response = await fetchWithAuth('/api/merchants/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textQuery: form.textQuery.trim(),
          centerCoordinates: form.centerCoordinates.trim(),
          rangeKm: Number(form.rangeKm),
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null) as (MerchantSearchResponse & {
        error?: string;
        detail?: string;
      }) | null;

      if (!response.ok) {
        setError(data?.error ?? '商家搜索失败，请稍后重试。');
        return;
      }
      if (!data || !Array.isArray(data.results)) {
        setError('服务端返回了无法识别的搜索结果。');
        return;
      }
      setSearchResult(data);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError('网络连接失败，请稍后重试。');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  function toggleMerchant(placeId: string) {
    setSelectedPlaceIds((current) => {
      const next = new Set(current);
      if (next.has(placeId)) next.delete(placeId);
      else next.add(placeId);
      return next;
    });
  }

  function selectAllWebsites() {
    const placeIds = searchResult?.results
      .filter((merchant) => safeExternalUrl(merchant.websiteUrl))
      .map((merchant) => merchant.placeId) ?? [];
    setSelectedPlaceIds(new Set(placeIds));
  }

  async function extractOneWebsite(merchant: MerchantSearchResult, generation: number) {
    const websiteUrl = safeExternalUrl(merchant.websiteUrl);
    if (!websiteUrl || extractionGenerationRef.current !== generation) return;

    const controller = new AbortController();
    extractionControllersRef.current.set(merchant.placeId, controller);
    setExtractions((current) => ({
      ...current,
      [merchant.placeId]: { status: 'loading' },
    }));

    try {
      const response = await fetchWithAuth('/api/merchant-websites/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId: merchant.placeId, websiteUrl }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null) as (MerchantWebsiteExtraction & {
        error?: string;
      }) | null;
      if (extractionGenerationRef.current !== generation) return;
      if (!response.ok || !data || !Array.isArray(data.emails) || !Array.isArray(data.phones)) {
        setExtractions((current) => ({
          ...current,
          [merchant.placeId]: {
            status: 'failed',
            error: data?.error ?? '官网首页提取失败',
          },
        }));
        return;
      }
      setExtractions((current) => ({
        ...current,
        [merchant.placeId]: { status: 'success', data },
      }));
    } catch (requestError) {
      if (extractionGenerationRef.current !== generation) return;
      const cancelled = requestError instanceof DOMException && requestError.name === 'AbortError';
      setExtractions((current) => ({
        ...current,
        [merchant.placeId]: {
          status: 'failed',
          error: cancelled ? '已取消' : '网络连接失败',
        },
      }));
    } finally {
      if (extractionControllersRef.current.get(merchant.placeId) === controller) {
        extractionControllersRef.current.delete(merchant.placeId);
      }
    }
  }

  async function runExtraction(merchants: MerchantSearchResult[]) {
    if (extracting || merchants.length === 0) return;
    const generation = extractionGenerationRef.current;
    setExtracting(true);
    setExtractions((current) => {
      const next = { ...current };
      for (const merchant of merchants) next[merchant.placeId] = { status: 'pending' };
      return next;
    });

    let cursor = 0;
    const worker = async () => {
      while (cursor < merchants.length && extractionGenerationRef.current === generation) {
        const merchant = merchants[cursor];
        cursor += 1;
        await extractOneWebsite(merchant, generation);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, merchants.length) }, () => worker()));
    if (extractionGenerationRef.current === generation) setExtracting(false);
  }

  function extractSelectedWebsites() {
    const merchants = searchResult?.results.filter((merchant) => selectedPlaceIds.has(merchant.placeId)) ?? [];
    void runExtraction(merchants);
  }

  function cancelExtractions() {
    extractionGenerationRef.current += 1;
    extractionControllersRef.current.forEach((controller) => controller.abort());
    extractionControllersRef.current.clear();
    setExtracting(false);
    setExtractions((current) => Object.fromEntries(
      Object.entries(current).map(([placeId, state]) => [
        placeId,
        state.status === 'pending' || state.status === 'loading'
          ? { status: 'failed' as const, error: '已取消' }
          : state,
      ]),
    ));
  }

  function retryExtraction(merchant: MerchantSearchResult) {
    void runExtraction([merchant]);
  }

  return (
    <main className="mc-page">
      <header className="mc-header">
        <div>
          <div className="mc-eyebrow">MERCHANT DISCOVERY</div>
          <h1>商家信息采集</h1>
          <p>查找 Google Places 候选，人工核实后保存到当前浏览器的本地名录。</p>
        </div>
        <button className="mc-button mc-button-secondary" type="button" onClick={() => navigate('/')}>
          返回清单页面
        </button>
      </header>

      <section className="mc-search-panel" aria-labelledby="merchant-search-heading">
        <div className="mc-panel-heading">
          <div>
            <span className="mc-step">01</span>
            <h2 id="merchant-search-heading">定义搜索区域</h2>
          </div>
          <span className="mc-scope-badge">美国本土 · 最大 50 km</span>
        </div>

        <form className="mc-form" onSubmit={handleSearch}>
          <label className="mc-field mc-field-query">
            <span>商家类别或服务</span>
            <input
              type="text"
              value={form.textQuery}
              onChange={(event) => updateForm('textQuery', event.target.value)}
              placeholder="例如：kitchen cabinet stores"
              maxLength={200}
              disabled={loading}
              autoComplete="off"
            />
            <small>请输入类别或服务，不要把经纬度写入查询词。</small>
          </label>

          <label className="mc-field">
            <span>中心坐标</span>
            <input
              type="text"
              value={form.centerCoordinates}
              onChange={(event) => updateForm('centerCoordinates', event.target.value)}
              placeholder="41.0251868, -73.6527774"
              disabled={loading}
              autoComplete="off"
            />
            <small>从 Google Maps 复制纬度、经度，仅支持连续 48 州。</small>
          </label>

          <label className="mc-field mc-field-range">
            <span>矩形半宽</span>
            <div className="mc-range-input">
              <input
                type="number"
                value={form.rangeKm}
                onChange={(event) => updateForm('rangeKm', event.target.value)}
                min="0.1"
                max={MAX_RANGE_KM}
                step="0.1"
                disabled={loading}
              />
              <strong>km</strong>
            </div>
            <small>输入 10 表示向东、西、南、北各约延伸 10 km。</small>
          </label>

          <div className="mc-submit-cell">
            <button className="mc-button mc-button-primary" type="submit" disabled={loading}>
              {loading ? '正在搜索...' : '搜索商家'}
            </button>
          </div>
        </form>
      </section>

      {error && <div className="mc-alert mc-alert-error" role="alert">{error}</div>}

      <section className="mc-results" aria-labelledby="merchant-results-heading">
        <div className="mc-results-header">
          <div>
            <span className="mc-step">02</span>
            <div>
              <h2 id="merchant-results-heading">临时搜索结果</h2>
              <p>这些候选仅保存在当前页面内存中，刷新或离开页面后会消失。</p>
            </div>
          </div>
          {searchResult && (
            <div className="mc-result-stats" aria-label="搜索统计">
              <span><strong>{searchResult.resultCount}</strong> 条结果</span>
              <span><strong>{searchResult.pageCount}</strong> 页</span>
            </div>
          )}
        </div>

        {searchResult?.possiblyTruncated && (
          <div className="mc-alert mc-alert-warning" role="status">
            已达到 Google 单次查询上限或结果未完整返回，范围内可能还有其他商家。
          </div>
        )}
        {searchResult?.partial && searchResult.warning && (
          <div className="mc-alert mc-alert-partial" role="status">{searchResult.warning}</div>
        )}

        {!searchResult && !loading && (
          <div className="mc-empty-state">
            <div className="mc-empty-index">00</div>
            <div>
              <strong>尚未执行搜索</strong>
              <p>填写上方三个字段后，候选商家会显示在这里。</p>
            </div>
          </div>
        )}
        {loading && (
          <div className="mc-empty-state mc-loading-state" aria-live="polite">
            <div className="mc-loader" />
            <div>
              <strong>正在读取 Google Places</strong>
              <p>服务端会自动读取最多三页结果。</p>
            </div>
          </div>
        )}
        {searchResult && searchResult.results.length === 0 && (
          <div className="mc-empty-state">
            <div className="mc-empty-index">0</div>
            <div>
              <strong>没有找到匹配商家</strong>
              <p>尝试更换类别词、中心点或查询范围。</p>
            </div>
          </div>
        )}

        {searchResult && searchResult.results.length > 0 && (
          <>
            <div className="mc-extract-toolbar">
              <div>
                <strong>{selectedPlaceIds.size}</strong> 条已选择
                <span>仅抓取官网首页，最多同时处理 3 条</span>
              </div>
              <div className="mc-extract-actions">
                <button className="mc-button mc-button-secondary" type="button" onClick={selectAllWebsites} disabled={extracting}>
                  选择全部有官网商家
                </button>
                <button
                  className="mc-button mc-button-secondary"
                  type="button"
                  onClick={() => setSelectedPlaceIds(new Set())}
                  disabled={extracting || selectedPlaceIds.size === 0}
                >
                  清除选择
                </button>
                {extracting ? (
                  <button className="mc-button mc-button-danger" type="button" onClick={cancelExtractions}>
                    取消抓取
                  </button>
                ) : (
                  <button
                    className="mc-button mc-button-primary mc-extract-button"
                    type="button"
                    onClick={extractSelectedWebsites}
                    disabled={selectedPlaceIds.size === 0}
                  >
                    抓取所选官网首页
                  </button>
                )}
              </div>
            </div>
            <div className="mc-table-shell">
              <table className="mc-table">
              <thead>
                <tr>
                  <th aria-label="选择" />
                  <th>商家</th>
                  <th>地址</th>
                  <th>电话</th>
                  <th>官网</th>
                  <th>状态</th>
                  <th>地图</th>
                  <th>官网提取</th>
                  <th>本地名录</th>
                </tr>
              </thead>
              <tbody>
                {searchResult.results.map((merchant) => (
                  <ResultRow
                    key={merchant.placeId}
                    merchant={merchant}
                    selected={selectedPlaceIds.has(merchant.placeId)}
                    collected={merchantRecords.some((record) => record.placeId === merchant.placeId)}
                    extraction={extractions[merchant.placeId]}
                    extracting={extracting}
                    recordSaving={savingRecord}
                    onToggle={() => toggleMerchant(merchant.placeId)}
                    onRetry={() => retryExtraction(merchant)}
                    onOpenRecord={() => openMerchantRecord(merchant)}
                  />
                ))}
              </tbody>
              </table>
            </div>
          </>
        )}

        <footer className="mc-attribution">
          <span>
            搜索结果由 <span className="mc-google-attribution" translate="no">Google Maps</span> 提供
          </span>
          <a
            href="https://developers.google.com/maps/documentation/places/web-service/text-search#rankpreference"
            target="_blank"
            rel="noreferrer"
          >
            了解搜索结果排序因素
          </a>
        </footer>
      </section>

      {editingRecord && (
        <MerchantEditor
          record={editingRecord}
          saving={savingRecord}
          onChange={setEditingRecord}
          onCancel={() => {
            setEditingRecord(null);
            setEditingExpectedUpdatedAt(null);
          }}
          onSave={() => void saveEditingRecord()}
        />
      )}

      <section className="mc-results mc-directory" aria-labelledby="merchant-directory-heading">
        <div className="mc-results-header">
          <div>
            <span className="mc-step">03</span>
            <div>
              <h2 id="merchant-directory-heading">当前浏览器本地名录</h2>
              <p>数据不会同步到服务端、其他设备或其他浏览器 profile，退出账号也不会自动删除。</p>
            </div>
          </div>
          <div className="mc-result-stats" aria-label="本地名录统计">
            <span><strong>{merchantRecords.length}</strong> 条记录</span>
          </div>
        </div>

        <div className="mc-directory-warning">
          <strong>本地数据提示</strong>
          <span>共享浏览器的其他使用者可能访问这些数据；清除站点数据、无痕窗口结束或设备故障会删除名录，请定期导出 CSV。</span>
        </div>

        <div className="mc-directory-toolbar">
          <div className="mc-storage-summary">
            <span>站点用量 {formatBytes(storageEstimate.usage)}</span>
            <span>估算配额 {formatBytes(storageEstimate.quota)}</span>
            <span>{storageEstimate.persisted === true ? '持久存储已授予' : '持久存储未授予或不可用'}</span>
          </div>
          <div className="mc-extract-actions">
            <button className="mc-button mc-button-secondary" type="button" onClick={() => void requestPersistentStorage()}>
              请求持久存储
            </button>
            <input
              ref={importInputRef}
              className="mc-visually-hidden"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void selectImportFile(event)}
            />
            <button className="mc-button mc-button-secondary" type="button" onClick={() => importInputRef.current?.click()}>
              导入 CSV
            </button>
            <button className="mc-button mc-button-primary mc-extract-button" type="button" onClick={() => void exportDirectory()} disabled={merchantRecords.length === 0}>
              导出 CSV 备份
            </button>
          </div>
        </div>

        {directoryError && <div className="mc-alert mc-alert-error mc-directory-alert" role="alert">{directoryError}</div>}
        {directoryMessage && <div className="mc-alert mc-alert-partial mc-directory-alert" role="status">{directoryMessage}</div>}

        {importPreview && (
          <div className="mc-import-preview">
            <div className="mc-import-summary">
              <div>
                <strong>导入预览：{importFileName}</strong>
                <span>尚未写入 IndexedDB</span>
              </div>
              <div>
                <span>新增 {importPreview.added}</span>
                <span>更新 {importPreview.updated}</span>
                <span>无变化 {importPreview.unchanged}</span>
                <span className={importPreview.errors > 0 ? 'mc-import-error-count' : ''}>错误 {importPreview.errors}</span>
              </div>
            </div>
            {importPreview.errors > 0 && (
              <div className="mc-import-errors">
                {importPreview.rows.filter((row) => row.errors.length > 0).map((row) => (
                  <div key={row.line}>第 {row.line} 行{row.placeId ? `（${row.placeId}）` : ''}：{row.errors.join('；')}</div>
                ))}
              </div>
            )}
            <div className="mc-editor-actions">
              <button className="mc-button mc-button-secondary" type="button" onClick={() => setImportPreview(null)} disabled={applyingImport}>取消导入</button>
              <button
                className="mc-button mc-button-primary"
                type="button"
                onClick={() => void confirmImport()}
                disabled={applyingImport || importPreview.errors > 0 || importPreview.added + importPreview.updated === 0}
              >
                {applyingImport ? '正在应用...' : '确认应用新增和更新'}
              </button>
            </div>
          </div>
        )}

        {directoryLoading && (
          <div className="mc-empty-state mc-loading-state" aria-live="polite">
            <div className="mc-loader" />
            <div><strong>正在读取本地名录</strong></div>
          </div>
        )}
        {!directoryLoading && merchantRecords.length === 0 && (
          <div className="mc-empty-state">
            <div className="mc-empty-index">0</div>
            <div>
              <strong>本地名录为空</strong>
              <p>从搜索结果点击“核实并纳入”，或导入标准 CSV 备份。</p>
            </div>
          </div>
        )}
        {!directoryLoading && merchantRecords.length > 0 && (
          <div className="mc-table-shell">
            <table className="mc-table mc-directory-table">
              <thead>
                <tr>
                  <th>商家</th>
                  <th>联系方式</th>
                  <th>官网</th>
                  <th>核实状态</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {merchantRecords.map((record) => {
                  const websiteUrl = safeExternalUrl(record.websiteUrl);
                  return (
                    <tr key={record.placeId}>
                      <td>
                        <div className="mc-business-name">{record.businessName || '未命名商家'}</div>
                        <div>{record.address || '未提供地址'}</div>
                        <div className="mc-place-id">{record.placeId}</div>
                      </td>
                      <td>
                        <div>{record.phone || '未提供电话'}</div>
                        <div>{record.emails.length > 0 ? record.emails.join(', ') : '未提供邮箱'}</div>
                      </td>
                      <td>{websiteUrl ? <a href={websiteUrl} target="_blank" rel="noreferrer">{websiteLabel(websiteUrl)}</a> : '未提供'}</td>
                      <td><span className={`mc-extract-state mc-extract-state-${record.verificationStatus === 'verified' ? 'success' : 'pending'}`}>{record.verificationStatus === 'verified' ? '已核实' : '未核实'}</span></td>
                      <td>{new Date(record.updatedAt).toLocaleString()}</td>
                      <td className="mc-record-actions">
                        <button
                          className="mc-inline-button"
                          type="button"
                          disabled={savingRecord}
                          onClick={() => {
                            setEditingRecord({ ...record, emails: [...record.emails], socialLinks: [...record.socialLinks] });
                            setEditingExpectedUpdatedAt(record.updatedAt);
                          }}
                        >
                          编辑
                        </button>
                        <button className="mc-inline-button mc-delete-link" type="button" disabled={savingRecord} onClick={() => void removeMerchantRecord(record)}>删除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
