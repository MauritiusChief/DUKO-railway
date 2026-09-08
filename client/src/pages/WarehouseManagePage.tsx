/**
 * 仓库管理页（仅 manager / admin）
 *
 *  - 顶部时间范围：本地日期整日或本地区间，边界转换为 UTC ISO 传给 API；
 *    页面时间用 toLocaleString() 显示。不同时区使用者看到的"某日"汇总可不同，
 *    这是计划已确认接受的行为。
 *  - 汇总表固定两列：SKU/型号序列号 与 数量；占位映射显示型号并标记待确认。
 *  - 扫描记录表默认折叠：SKU（只读）/型号/产品三列文本筛选按交集处理，
 *    逐行编辑型号或产品（只影响该条记录），删除需确认。
 *  - 映射表默认折叠：维护全局一对一映射；全局重命名型号会级联更新关联
 *    扫描记录，UI 显示影响数量并需二次确认。
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { useI18n } from '../i18n/context';
import { SegSwitch } from '../components/SegSwitch';
import './WarehouseManagePage.css';

const PAGE_SIZE = 50;

/** 扫描记录 */
interface ScanRecord {
  product_seri_num: string;
  model_seri_num: string;
  sku: string;
  scanned_at: string;
}

/** 汇总行 */
interface SummaryItem {
  model_seri_num: string;
  sku: string;
  is_placeholder: boolean;
  count: number;
}

/** 映射行 */
interface MappingItem {
  model_seri_num: string;
  sku: string;
  is_placeholder: boolean;
  record_count: number;
  created_at: string;
  updated_at: string;
}

/** 导入预检分析（POST /imports/validate 响应） */
interface ImportAnalysis {
  existingRecordCount: number;
  existingMappingCount: number;
  recordCount: number;
  newCount: number;
  identicalCount: number;
  upgrades: number;
  productConflicts: {
    product: string;
    existingModel: string;
    existingScannedAt: string;
    importedModel: string;
    importedScannedAt: string;
  }[];
  mappingConflicts: { model: string; existingSku: string; importedSku: string }[];
  skuCollisions: { sku: string; models: string[] }[];
}

/** 从响应中提取可读错误信息 */
async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; detail?: string };
    return data.error || data.detail || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function WarehouseManagePage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // 时间范围
  const [rangeMode, setRangeMode] = useState<'day' | 'range'>('day');
  const [day, setDay] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');

  // 数据
  const [summary, setSummary] = useState<SummaryItem[]>([]);
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [mappings, setMappings] = useState<MappingItem[]>([]);

  // 筛选（三列文本交集）
  const [fSku, setFSku] = useState('');
  const [fModel, setFModel] = useState('');
  const [fProduct, setFProduct] = useState('');

  // 折叠区
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [mappingsOpen, setMappingsOpen] = useState(false);

  // 状态提示与编辑
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editRow, setEditRow] = useState<{
    product: string;
    modelOriginal: string;
    model: string;
    newProduct: string;
  } | null>(null);
  const [skuEdit, setSkuEdit] = useState<{ model: string; value: string } | null>(null);
  const [renameEdit, setRenameEdit] = useState<{ model: string; value: string } | null>(null);

  // JSON 导入
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importPayload, setImportPayload] = useState<unknown>(null);
  const [importAnalysis, setImportAnalysis] = useState<ImportAnalysis | null>(null);
  const [productDecisions, setProductDecisions] = useState<Record<string, 'keep' | 'adopt'>>({});
  const [mappingDecisions, setMappingDecisions] = useState<Record<string, 'keep' | 'adopt'>>({});
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  /** 将当前时间范围选择转换为 UTC 查询边界 */
  const rangeParams = (): { from?: string; to?: string } => {
    if (rangeMode === 'day') {
      if (!day) return {};
      return {
        from: new Date(`${day}T00:00:00`).toISOString(),
        to: new Date(`${day}T23:59:59.999`).toISOString(),
      };
    }
    return {
      from: fromLocal ? new Date(fromLocal).toISOString() : undefined,
      to: toLocal ? new Date(toLocal).toISOString() : undefined,
    };
  };

  const loadMain = async (nextOffset = offset) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      const range = rangeParams();
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (fSku.trim()) params.set('sku', fSku.trim());
      if (fModel.trim()) params.set('modelSeriNum', fModel.trim());
      if (fProduct.trim()) params.set('productSeriNum', fProduct.trim());
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(nextOffset));

      const [scansRes, summaryRes] = await Promise.all([
        fetchWithAuth(`/api/warehouse/scans?${params.toString()}`),
        fetchWithAuth(`/api/warehouse/summary?${params.toString()}`),
      ]);

      if (!scansRes.ok) {
        setError(await readError(scansRes));
        return;
      }
      const scansData = (await scansRes.json()) as { total: number; records: ScanRecord[] };
      setRecords(scansData.records);
      setTotal(scansData.total);
      setOffset(nextOffset);

      if (summaryRes.ok) {
        const summaryData = (await summaryRes.json()) as { summary: SummaryItem[] };
        setSummary(summaryData.summary);
      }
    } catch {
      setError(t('网络错误'));
    } finally {
      setLoading(false);
    }
  };

  const loadMappings = async () => {
    try {
      const res = await fetchWithAuth('/api/warehouse/mappings');
      if (res.ok) {
        const data = (await res.json()) as { mappings: MappingItem[] };
        setMappings(data.mappings);
      }
    } catch {
      /* 静默失败 */
    }
  };

  useEffect(() => {
    loadMain(0);
    loadMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetFilters = () => {
    setFSku('');
    setFModel('');
    setFProduct('');
    setDay('');
    setFromLocal('');
    setToLocal('');
    setOffset(0);
  };

  const flashSuccess = (text: string) => {
    setSuccess(text);
    setError('');
    setTimeout(() => setSuccess(''), 2500);
  };

  // ---- 扫描记录：逐行编辑 ----

  const saveRowEdit = async () => {
    if (!editRow) return;
    setLoading(true);
    setError('');
    try {
      const body: Record<string, string> = {};
      if (editRow.model !== editRow.modelOriginal) body.modelSeriNum = editRow.model;
      if (editRow.newProduct !== editRow.product) body.newProductSeriNum = editRow.newProduct;

      const res = await fetchWithAuth(`/api/warehouse/scans/${encodeURIComponent(editRow.product)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setEditRow(null);
      flashSuccess(t('已保存'));
      await loadMain();
    } catch {
      setError(t('网络错误'));
    } finally {
      setLoading(false);
    }
  };

  const deleteRow = async (product: string) => {
    if (!window.confirm(t('确定要删除该扫描记录吗？此操作不可撤销。'))) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchWithAuth(`/api/warehouse/scans/${encodeURIComponent(product)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      flashSuccess(t('已删除'));
      await loadMain();
    } catch {
      setError(t('网络错误'));
    } finally {
      setLoading(false);
    }
  };

  // ---- 映射：修改 SKU / 全局重命名 ----

  const saveMappingSku = async () => {
    if (!skuEdit) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchWithAuth(
        `/api/warehouse/mappings/${encodeURIComponent(skuEdit.model)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku: skuEdit.value }),
        },
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setSkuEdit(null);
      flashSuccess(t('已保存'));
      await Promise.all([loadMappings(), loadMain()]);
    } catch {
      setError(t('网络错误'));
    } finally {
      setLoading(false);
    }
  };

  const saveMappingRename = async () => {
    if (!renameEdit) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchWithAuth(
        `/api/warehouse/mappings/${encodeURIComponent(renameEdit.model)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newModelSeriNum: renameEdit.value }),
        },
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setRenameEdit(null);
      flashSuccess(t('已保存'));
      await Promise.all([loadMappings(), loadMain()]);
    } catch {
      setError(t('网络错误'));
    } finally {
      setLoading(false);
    }
  };

  // ---- JSON 导入 ----

  const resetImport = () => {
    setImportPayload(null);
    setImportAnalysis(null);
    setProductDecisions({});
    setMappingDecisions({});
    setReplaceConfirmed(false);
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError('');
    resetImport();
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const res = await fetchWithAuth('/api/warehouse/imports/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
      const data = (await res.json()) as { analysis?: ImportAnalysis; error?: string; detail?: string };
      if (!res.ok || !data.analysis) {
        setImportError(data.detail || data.error || `HTTP ${res.status}`);
        return;
      }
      setImportPayload(payload);
      setImportAnalysis(data.analysis);
    } catch (err) {
      setImportError(err instanceof SyntaxError ? t('文件内容不是有效 JSON') : t('网络错误'));
    }
  };

  const runImport = async () => {
    if (!importPayload || importing) return;
    if (importMode === 'replace' && !replaceConfirmed) return;
    setImporting(true);
    setImportError('');
    try {
      const res = await fetchWithAuth('/api/warehouse/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: importPayload, mode: importMode, productDecisions, mappingDecisions }),
      });
      const data = (await res.json()) as {
        records?: number;
        mappings?: number;
        inserted?: number;
        updated?: number;
        skipped?: number;
        mappingsAdded?: number;
        mappingsUpdated?: number;
        error?: string;
      };
      if (!res.ok) {
        setImportError(data.error || `HTTP ${res.status}`);
        return;
      }
      flashSuccess(
        importMode === 'replace'
          ? t('替换导入完成：写入 {records} 条记录、{mappings} 条映射', {
              records: data.records ?? 0,
              mappings: data.mappings ?? 0,
            })
          : t('导入完成：记录新增 {inserted}、更新 {updated}、跳过 {skipped}；映射新增 {mappingsAdded}、更新 {mappingsUpdated}', {
              inserted: data.inserted ?? 0,
              updated: data.updated ?? 0,
              skipped: data.skipped ?? 0,
              mappingsAdded: data.mappingsAdded ?? 0,
              mappingsUpdated: data.mappingsUpdated ?? 0,
            }),
      );
      resetImport();
      await Promise.all([loadMain(), loadMappings()]);
    } catch {
      setImportError(t('网络错误'));
    } finally {
      setImporting(false);
    }
  };

  const formatTime = (utc: string) => new Date(utc).toLocaleString();

  return (
    <div className="wm-page">
      <div className="wm-header">
        <h1>{t('仓库管理')}</h1>
        <button className="wm-btn" onClick={() => navigate('/warehouse-scan')}>
          {t('返回扫码页')}
        </button>
      </div>

      {(error || success) && (
        <p className={`wm-msg ${error ? 'wm-msg-error' : 'wm-msg-success'}`}>{error || success}</p>
      )}

      {/* ---- 时间范围 ---- */}
      <section className="wm-card">
        <div className="wm-range-row">
          <SegSwitch
            options={[
              { value: 'day', label: t('按日') },
              { value: 'range', label: t('按区间') },
            ]}
            value={rangeMode}
            onChange={(v) => setRangeMode(v)}
          />
          {rangeMode === 'day' ? (
            <input type="date" className="wm-input" value={day} onChange={(e) => setDay(e.target.value)} />
          ) : (
            <>
              <input
                type="datetime-local"
                className="wm-input"
                value={fromLocal}
                onChange={(e) => setFromLocal(e.target.value)}
              />
              <span className="wm-range-sep">→</span>
              <input
                type="datetime-local"
                className="wm-input"
                value={toLocal}
                onChange={(e) => setToLocal(e.target.value)}
              />
            </>
          )}
          <button className="wm-btn wm-btn-primary" disabled={loading} onClick={() => loadMain(0)}>
            {t('查询')}
          </button>
          <button
            className="wm-btn"
            disabled={loading}
            onClick={() => {
              resetFilters();
            }}
          >
            {t('重置')}
          </button>
        </div>
      </section>

      {/* ---- 汇总 ---- */}
      <section className="wm-card">
        <h2 className="wm-card-title">{t('汇总')}</h2>
        <table className="wm-table">
          <thead>
            <tr>
              <th>SKU / {t('型号序列号')}</th>
              <th className="wm-num">{t('数量')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.length === 0 ? (
              <tr>
                <td colSpan={2} className="wm-empty">{t('加载中')}</td>
              </tr>
            ) : (
              summary.map((item) => (
                <tr key={item.model_seri_num}>
                  <td>
                    <span className="wm-mono">{item.is_placeholder ? item.model_seri_num : item.sku}</span>
                    {item.is_placeholder && <span className="wm-badge">{t('待确认 SKU')}</span>}
                  </td>
                  <td className="wm-num">{item.count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* ---- 扫描记录（默认折叠） ---- */}
      <section className="wm-card">
        <button className="wm-collapse" onClick={() => setRecordsOpen(!recordsOpen)}>
          {recordsOpen ? '▾' : '▸'} {t('扫描记录')}（{t('共 {total} 条', { total })}）
        </button>

        {recordsOpen && (
          <>
            <div className="wm-filter-row">
              <input
                className="wm-input"
                placeholder="SKU"
                value={fSku}
                onChange={(e) => setFSku(e.target.value)}
              />
              <input
                className="wm-input"
                placeholder={t('型号序列号')}
                value={fModel}
                onChange={(e) => setFModel(e.target.value)}
              />
              <input
                className="wm-input"
                placeholder={t('产品序列号')}
                value={fProduct}
                onChange={(e) => setFProduct(e.target.value)}
              />
              <button className="wm-btn wm-btn-primary" disabled={loading} onClick={() => loadMain(0)}>
                {t('筛选')}
              </button>
            </div>

            <div className="wm-table-wrap">
              <table className="wm-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>{t('型号序列号')}</th>
                    <th>{t('产品序列号')}</th>
                    <th>{t('时间')}</th>
                    <th>{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="wm-empty">—</td>
                    </tr>
                  ) : (
                    records.map((r) => {
                      const editing = editRow?.product === r.product_seri_num;
                      return (
                        <tr key={r.product_seri_num}>
                          <td className="wm-mono">{r.sku}</td>
                          <td>
                            {editing ? (
                              <input
                                className="wm-input wm-input-cell"
                                value={editRow!.model}
                                onChange={(e) => setEditRow({ ...editRow!, model: e.target.value })}
                              />
                            ) : (
                              <span className="wm-mono">{r.model_seri_num}</span>
                            )}
                          </td>
                          <td>
                            {editing ? (
                              <input
                                className="wm-input wm-input-cell"
                                value={editRow!.newProduct}
                                onChange={(e) => setEditRow({ ...editRow!, newProduct: e.target.value })}
                              />
                            ) : (
                              <span className="wm-mono">{r.product_seri_num}</span>
                            )}
                          </td>
                          <td className="wm-time">{formatTime(r.scanned_at)}</td>
                          <td className="wm-actions-cell">
                            {editing ? (
                              <>
                                <button className="wm-btn wm-btn-primary" disabled={loading} onClick={saveRowEdit}>
                                  {t('保存')}
                                </button>
                                <button className="wm-btn" disabled={loading} onClick={() => setEditRow(null)}>
                                  {t('取消')}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="wm-btn"
                                  onClick={() =>
                                    setEditRow({
                                      product: r.product_seri_num,
                                      modelOriginal: r.model_seri_num,
                                      model: r.model_seri_num,
                                      newProduct: r.product_seri_num,
                                    })
                                  }
                                >
                                  {t('编辑')}
                                </button>
                                <button className="wm-btn wm-btn-danger" disabled={loading} onClick={() => deleteRow(r.product_seri_num)}>
                                  {t('删除')}
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="wm-pager">
              <button className="wm-btn" disabled={loading || offset <= 0} onClick={() => loadMain(Math.max(0, offset - PAGE_SIZE))}>
                {t('上一页')}
              </button>
              <button
                className="wm-btn"
                disabled={loading || offset + PAGE_SIZE >= total}
                onClick={() => loadMain(offset + PAGE_SIZE)}
              >
                {t('下一页')}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ---- 映射（默认折叠） ---- */}
      <section className="wm-card">
        <button className="wm-collapse" onClick={() => setMappingsOpen(!mappingsOpen)}>
          {mappingsOpen ? '▾' : '▸'} {t('映射')}（{mappings.length}）
        </button>

        {mappingsOpen && (
          <div className="wm-table-wrap">
            <table className="wm-table">
              <thead>
                <tr>
                  <th>{t('型号序列号')}</th>
                  <th>SKU</th>
                  <th>{t('记录数')}</th>
                  <th>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => {
                  const skuEditing = skuEdit?.model === m.model_seri_num;
                  const renaming = renameEdit?.model === m.model_seri_num;
                  return (
                    <tr key={m.model_seri_num} className={m.is_placeholder ? 'wm-row-pending' : ''}>
                      <td>
                        <span className="wm-mono">{m.model_seri_num}</span>
                      </td>
                      <td>
                        {skuEditing ? (
                          <input
                            className="wm-input wm-input-cell"
                            value={skuEdit!.value}
                            onChange={(e) => setSkuEdit({ ...skuEdit!, value: e.target.value })}
                          />
                        ) : (
                          <>
                            <span className="wm-mono">{m.sku}</span>
                            {m.is_placeholder && <span className="wm-badge">{t('待确认 SKU')}</span>}
                          </>
                        )}
                      </td>
                      <td className="wm-num">{m.record_count}</td>
                      <td className="wm-actions-cell">
                        {skuEditing ? (
                          <>
                            <button className="wm-btn wm-btn-primary" disabled={loading} onClick={saveMappingSku}>
                              {t('保存')}
                            </button>
                            <button className="wm-btn" disabled={loading} onClick={() => setSkuEdit(null)}>
                              {t('取消')}
                            </button>
                          </>
                        ) : renaming ? (
                          <span className="wm-rename-form">
                            <input
                              className="wm-input wm-input-cell"
                              value={renameEdit!.value}
                              onChange={(e) => setRenameEdit({ ...renameEdit!, value: e.target.value })}
                            />
                            <button className="wm-btn wm-btn-primary" disabled={loading} onClick={saveMappingRename}>
                              {t('确认重命名')}
                            </button>
                            <button className="wm-btn" disabled={loading} onClick={() => setRenameEdit(null)}>
                              {t('取消')}
                            </button>
                          </span>
                        ) : (
                          <>
                            <button className="wm-btn" onClick={() => setSkuEdit({ model: m.model_seri_num, value: m.sku })}>
                              {t('修改 SKU')}
                            </button>
                            <button
                              className="wm-btn"
                              onClick={() => setRenameEdit({ model: m.model_seri_num, value: m.model_seri_num })}
                            >
                              {t('重命名型号')}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {renameEdit && (
              <p className="wm-rename-hint">
                {t('重命名将同步更新 {count} 条关联扫描记录', {
                  count: mappings.find((m) => m.model_seri_num === renameEdit.model)?.record_count ?? 0,
                })}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ---- JSON 导入 ---- */}
      <section className="wm-card">
        <button className="wm-collapse" onClick={() => setImportOpen(!importOpen)}>
          {importOpen ? '▾' : '▸'} {t('JSON 导入')}
        </button>

        {importOpen && (
          <div className="wm-import">
            <p className="wm-import-hint">{t('仅支持 warehouse-count-helper 导出的 JSON 文件')}</p>
            <div className="wm-filter-row">
              <input type="file" accept="application/json,.json" onChange={handleImportFile} disabled={importing} />
              <SegSwitch
                options={[
                  { value: 'merge', label: t('合并') },
                  { value: 'replace', label: t('替换') },
                ]}
                value={importMode}
                onChange={(v) => {
                  setImportMode(v);
                  setReplaceConfirmed(false);
                }}
              />
            </div>

            {importError && <p className="wm-msg wm-msg-error">{importError}</p>}

            {importAnalysis && (
              <>
                <table className="wm-table wm-import-summary">
                  <tbody>
                    <tr>
                      <td>{t('记录总数')}</td>
                      <td className="wm-num">{importAnalysis.recordCount}</td>
                      <td>{t('新增')}</td>
                      <td className="wm-num">{importAnalysis.newCount}</td>
                    </tr>
                    <tr>
                      <td>{t('内容相同将跳过')}</td>
                      <td className="wm-num">{importAnalysis.identicalCount}</td>
                      <td>{t('占位映射自动升级')}</td>
                      <td className="wm-num">{importAnalysis.upgrades}</td>
                    </tr>
                  </tbody>
                </table>

                {importAnalysis.productConflicts.length > 0 && (
                  <>
                    <h3 className="wm-card-title">{t('产品冲突')}</h3>
                    <div className="wm-table-wrap">
                      <table className="wm-table">
                        <thead>
                          <tr>
                            <th>{t('产品序列号')}</th>
                            <th>{t('现有')}</th>
                            <th>{t('导入值')}</th>
                            <th>{t('操作')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importAnalysis.productConflicts.map((c) => (
                            <tr key={c.product}>
                              <td className="wm-mono">{c.product}</td>
                              <td className="wm-time">
                                {c.existingModel} · {formatTime(c.existingScannedAt)}
                              </td>
                              <td className="wm-time">
                                {c.importedModel} · {formatTime(c.importedScannedAt)}
                              </td>
                              <td className="wm-actions-cell">
                                <label>
                                  <input
                                    type="radio"
                                    checked={(productDecisions[c.product] ?? 'keep') === 'keep'}
                                    onChange={() =>
                                      setProductDecisions((prev) => ({ ...prev, [c.product]: 'keep' }))
                                    }
                                  />{' '}
                                  {t('保留现有')}
                                </label>
                                <label className="wm-radio-adopt">
                                  <input
                                    type="radio"
                                    checked={productDecisions[c.product] === 'adopt'}
                                    onChange={() =>
                                      setProductDecisions((prev) => ({ ...prev, [c.product]: 'adopt' }))
                                    }
                                  />{' '}
                                  {t('采用导入')}
                                </label>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {importAnalysis.mappingConflicts.length > 0 && (
                  <>
                    <h3 className="wm-card-title">{t('映射冲突')}</h3>
                    <div className="wm-table-wrap">
                      <table className="wm-table">
                        <thead>
                          <tr>
                            <th>{t('型号序列号')}</th>
                            <th>{t('现有')} SKU</th>
                            <th>{t('导入值')} SKU</th>
                            <th>{t('操作')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importAnalysis.mappingConflicts.map((c) => (
                            <tr key={c.model}>
                              <td className="wm-mono">{c.model}</td>
                              <td className="wm-mono">{c.existingSku}</td>
                              <td className="wm-mono">{c.importedSku}</td>
                              <td className="wm-actions-cell">
                                <label>
                                  <input
                                    type="radio"
                                    checked={(mappingDecisions[c.model] ?? 'keep') === 'keep'}
                                    onChange={() =>
                                      setMappingDecisions((prev) => ({ ...prev, [c.model]: 'keep' }))
                                    }
                                  />{' '}
                                  {t('保留现有')}
                                </label>
                                <label className="wm-radio-adopt">
                                  <input
                                    type="radio"
                                    checked={mappingDecisions[c.model] === 'adopt'}
                                    onChange={() =>
                                      setMappingDecisions((prev) => ({ ...prev, [c.model]: 'adopt' }))
                                    }
                                  />{' '}
                                  {t('采用导入')}
                                </label>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {importAnalysis.skuCollisions.length > 0 && (
                  <div className="wm-import-warning">
                    <strong>{t('SKU 冲突')}</strong>
                    {importAnalysis.skuCollisions.map((c) => (
                      <span key={c.sku}>
                        {c.sku}: {c.models.join(', ')}
                      </span>
                    ))}
                    <span>{t('采用导入映射将导致 SKU 一对一冲突，请改为保留现有或先调整现有映射')}</span>
                  </div>
                )}

                {importMode === 'replace' && (
                  <div className="wm-import-danger">
                    <p>
                      {t('替换将清空全部仓库数据，不可恢复')}
                      <br />
                      {t('现有扫描记录 {records} 条、映射 {mappings} 条', {
                        records: importAnalysis.existingRecordCount,
                        mappings: importAnalysis.existingMappingCount,
                      })}
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={replaceConfirmed}
                        onChange={(e) => setReplaceConfirmed(e.target.checked)}
                      />{' '}
                      {t('我确认清空全部数据')}
                    </label>
                  </div>
                )}

                <button
                  className="wm-btn wm-btn-primary wm-import-run"
                  disabled={importing || (importMode === 'replace' && !replaceConfirmed)}
                  onClick={runImport}
                >
                  {t('执行导入')}
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
