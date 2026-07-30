/**
 * InventoryDashboardPage —— 库存看板
 *
 * 功能：
 *  - 自动下载查询（worker 从 Odoo 下载 CSV）或手动上传 CSV
 *  - 套用 sku-clean 清洗 + 可用库存阈值筛选
 *  - 自动衔接趋势查验（worker 逐项查 ATL/Stock 指定月份的出入库）
 *  - 结果分为警告(红)/提醒(黄)/信息(灰) 三表 + 无需注意计数
 *
 * SSE 仅在查询过程中开启；完成后关闭。结果存 localStorage（单 key 覆盖）。
 * 无 i18n，文本硬编码中文。
 */

import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { ReconnectingSSE } from '../lib/sseStream';
import './InventoryDashboardPage.css';

interface ClassifiedItem {
  name: string;
  freeToUse: number;
  qtyOnHand?: number;
  forecasted?: number;
  inbound: number;
  outbound: number;
}
interface Classification {
  warning: ClassifiedItem[];
  reminder: ClassifiedItem[];
  info: ClassifiedItem[];
  noAttentionCount: number;
}

/** 库存识别历史摘要（来自 /api/inventory/results） */
interface HistorySummary {
  id: number;
  jobId: string;
  source: string;
  completedAt: string;
  triggeredByName: string;
  threshold: number;
  trendThreshold: number;
  recentMonths: number;
  totalCleaned: number;
  lowStockCount: number;
  warningCount: number;
  reminderCount: number;
  infoCount: number;
  noAttentionCount: number;
}

/** 旧版本 localStorage key，挂载时清理遗留的完整结果缓存（历史结果已改为服务端持久化） */
const LEGACY_LS_KEY = 'duko_inventory_last';

/** 拉取全局最近 20 条识别结果摘要 */
async function loadHistoryList(): Promise<HistorySummary[]> {
  try {
    const res = await fetchWithAuth('/api/inventory/results');
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: HistorySummary[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

/** 历史下拉选项文本：本地时间为主，附来源与执行人 */
function formatHistoryLabel(h: HistorySummary): string {
  // completed_at 来自 SQLite datetime('now')，为 'YYYY-MM-DD HH:MM:SS'（UTC），补 T/Z 以便按 UTC 解析后转本地时区
  const iso = h.completedAt.trim().replace(' ', 'T') + 'Z';
  const local = new Date(iso).toLocaleString();
  const source = h.source === 'auto' ? '下载' : '上传';
  return `${local} · ${source} · ${h.triggeredByName}`;
}

type ClassificationBucket = 'warning' | 'reminder' | 'info';
type SortMode = 'stock' | 'outbound';

const INFO_PAGE_SIZE = 100;

function upsertClassifiedItem(
  current: Classification | null,
  bucket: ClassificationBucket,
  item: ClassifiedItem,
  noAttentionCount: number,
): Classification {
  const next: Classification = {
    warning: (current?.warning ?? []).filter((entry) => entry.name !== item.name),
    reminder: (current?.reminder ?? []).filter((entry) => entry.name !== item.name),
    info: (current?.info ?? []).filter((entry) => entry.name !== item.name),
    noAttentionCount,
  };
  next[bucket].push(item);
  return next;
}

export default function InventoryDashboardPage() {
  const [threshold, setThreshold] = useState(5);
  const [trendThreshold, setTrendThreshold] = useState(10);
  const [recentMonths, setRecentMonths] = useState(3);
  const [warningSort, setWarningSort] = useState<SortMode>('outbound');
  const [reminderSort, setReminderSort] = useState<SortMode>('outbound');
  const [infoPage, setInfoPage] = useState(1);

  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');
  const [autoOnline, setAutoOnline] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [totalCleaned, setTotalCleaned] = useState<number | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 库存识别历史（服务端持久化，全局最近 20 条）
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const sseRef = useRef<ReconnectingSSE | null>(null);
  const terminalRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const busy = status === 'running';

  // 挂载时清理旧版本遗留的完整结果缓存，并加载服务端历史（默认选择最新一条）
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_LS_KEY);
    } catch {
      /* 忽略 */
    }
    let cancelled = false;
    (async () => {
      const list = await loadHistoryList();
      if (cancelled) return;
      setHistory(list);
      if (list.length > 0) {
        const latest = list[0];
        setSelectedId(latest.id);
        await loadResultDetail(latest.id);
        // 与旧 localStorage 行为一致：恢复最新一次的查询参数
        setThreshold(latest.threshold);
        setTrendThreshold(latest.trendThreshold);
        setRecentMonths(latest.recentMonths);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil((classification?.info.length ?? 0) / INFO_PAGE_SIZE));
    setInfoPage((current) => Math.min(current, totalPages));
  }, [classification?.info.length]);

  // 挂载时拉取一次 worker 在线状态
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/auto-worker/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.autoOnline === 'boolean') {
          setAutoOnline(data.autoOnline);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 日志自动滚动
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  // 卸载时关闭 SSE
  useEffect(() => {
    return () => {
      sseRef.current?.stop();
    };
  }, []);

  function appendLog(message: string) {
    setLog((prev) => {
      const next = [...prev, message];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }

  /** 加载指定历史结果的完整分类并展示 */
  async function loadResultDetail(id: number) {
    try {
      const res = await fetchWithAuth(`/api/inventory/results/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as { result?: { classification: Classification; totalCleaned: number; lowStockCount: number } };
      if (!data.result) return;
      setClassification(data.result.classification);
      setTotalCleaned(data.result.totalCleaned);
      setLowStockCount(data.result.lowStockCount);
    } catch {
      /* 静默失败 */
    }
  }

  /** 任务完成后刷新历史列表并选中新写入的最新结果 */
  async function refreshHistoryAfterComplete() {
    const list = await loadHistoryList();
    setHistory(list);
    if (list.length > 0) {
      setSelectedId(list[0].id);
    }
  }

  /** 手动选择某条历史 */
  async function handleSelectHistory(id: number) {
    setSelectedId(id);
    await loadResultDetail(id);
  }

  function openSSE(id: string) {
    sseRef.current?.stop();
    terminalRef.current = false;
    const sse = new ReconnectingSSE(`/api/inventory/jobs/${id}/events`, {
      onEvent: (type, data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        switch (type) {
          case 'snapshot': {
            if (d.phase) setPhase(String(d.phase));
            if (typeof d.totalCleaned === 'number') setTotalCleaned(d.totalCleaned);
            if (typeof d.lowStockCount === 'number') setLowStockCount(d.lowStockCount);
            if (d.classification) setClassification(d.classification as Classification);
            if (d.error) setError(String(d.error));
            if (d.lastProgress) appendLog(String(d.lastProgress));
            if (d.status === 'completed' || d.status === 'failed') {
              setStatus(d.status);
            }
            break;
          }
          case 'phase':
            if (d.phase) setPhase(String(d.phase));
            break;
          case 'progress':
            if (d.message) appendLog(String(d.message));
            break;
          case 'low-stock':
            if (typeof d.totalCleaned === 'number' && typeof d.lowStockCount === 'number') {
              setTotalCleaned(d.totalCleaned);
              setLowStockCount(d.lowStockCount);
              setClassification({
                warning: [],
                reminder: [],
                info: [],
                noAttentionCount: Math.max(0, d.totalCleaned - d.lowStockCount),
              });
            }
            break;
          case 'trend-result': {
            const bucket = d.bucket;
            const item = d.item as ClassifiedItem | undefined;
            if (
              (bucket === 'warning' || bucket === 'reminder' || bucket === 'info')
              && item
              && typeof d.noAttentionCount === 'number'
            ) {
              setClassification((current) => upsertClassifiedItem(
                current,
                bucket,
                item,
                d.noAttentionCount as number,
              ));
            }
            break;
          }
          case 'complete':
            if (d.classification) {
              const c = d.classification as Classification;
              setClassification(c);
            }
            setStatus('completed');
            finishSSE();
            // 刷新历史列表并选中新写入的最新结果
            refreshHistoryAfterComplete();
            break;
          case 'error':
            setError(String(d.error ?? '未知错误'));
            setStatus('failed');
            finishSSE();
            break;
        }
      },
      shouldReconnect: () => !terminalRef.current,
    });
    sse.start();
    sseRef.current = sse;
  }

  function finishSSE() {
    terminalRef.current = true;
    setTimeout(() => sseRef.current?.stop(), 500);
  }

  function resetForNewJob() {
    setLog([]);
    setError(null);
    setClassification(null);
    setTotalCleaned(null);
    setLowStockCount(null);
    setInfoPage(1);
    setStatus('running');
  }

  function handleClearTables() {
    setClassification(null);
    setTotalCleaned(null);
    setLowStockCount(null);
    setInfoPage(1);
  }

  async function handleDownload() {
    resetForNewJob();
    setPhase('download');
    try {
      const res = await fetchWithAuth('/api/inventory/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold, trendThreshold, recentMonths }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `请求失败 (${res.status})`);
        setStatus('failed');
        return;
      }
      const data = (await res.json()) as { jobId: string };
      setJobId(data.jobId);
      openSSE(data.jobId);
    } catch (err) {
      setError(`网络错误：${err instanceof Error ? err.message : String(err)}`);
      setStatus('failed');
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!file) return;
    resetForNewJob();
    setPhase('cleaning');
    try {
      const csv = await file.text();
      const res = await fetchWithAuth('/api/inventory/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, threshold, trendThreshold, recentMonths }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `请求失败 (${res.status})`);
        setStatus('failed');
        return;
      }
      const data = (await res.json()) as { jobId: string };
      setJobId(data.jobId);
      openSSE(data.jobId);
    } catch (err) {
      setError(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      setStatus('failed');
    }
  }

  async function handleCancel() {
    if (jobId) {
      try {
        await fetchWithAuth(`/api/inventory/jobs/${jobId}/cancel`, { method: 'POST' });
      } catch {
        /* 忽略 */
      }
    }
    finishSSE();
    setStatus('failed');
    setError('用户取消');
  }

  function fmtQuantity(quantity: number): string {
    return quantity.toFixed(1);
  }

  const phaseLabel: Record<string, string> = {
    '': '',
    download: '下载中',
    cleaning: '清洗中',
    filtering: '筛选中',
    trend: '趋势查验中',
    classifying: '分类中',
    completed: '已完成',
    failed: '失败',
  };

  function sortItems(items: ClassifiedItem[], mode: SortMode): ClassifiedItem[] {
    return [...items].sort(mode === 'stock'
      ? (a, b) => a.freeToUse - b.freeToUse
      : (a, b) => b.outbound - a.outbound);
  }

  const warn = sortItems(classification?.warning ?? [], warningSort);
  const remind = sortItems(classification?.reminder ?? [], reminderSort);
  const info = sortItems(classification?.info ?? [], 'stock');
  const infoTotalPages = Math.max(1, Math.ceil(info.length / INFO_PAGE_SIZE));
  const pagedInfo = info.slice((infoPage - 1) * INFO_PAGE_SIZE, infoPage * INFO_PAGE_SIZE);
  const noAttention = classification?.noAttentionCount ?? 0;

  function renderTable(items: ClassifiedItem[], colClass: string) {
    return (
      <div className="iv-table-wrap">
        <table className="iv-table">
          <thead>
            <tr>
              <th>型号</th>
              <th style={{ textAlign: 'right' }}>可用库存</th>
              <th style={{ textAlign: 'right' }}>近期出库</th>
              <th style={{ textAlign: 'right' }}>近期入库</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className={`iv-td-empty ${colClass}`}>—</td>
              </tr>
            )}
            {items.map((it) => (
              <tr key={it.name}>
                <td>{it.name}</td>
                <td className="iv-td-num">{it.freeToUse.toFixed(0)}</td>
                <td className="iv-td-num">{fmtQuantity(it.outbound)}</td>
                <td className="iv-td-num">{fmtQuantity(it.inbound)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="iv-container">
      {/* 头部 */}
      <div className="iv-header">
        <div className="iv-header-left">
          <div className="iv-header-title">库存看板</div>
          <span className={autoOnline ? 'iv-auto-online' : 'iv-auto-offline'}>
            {autoOnline ? 'Auto 在线' : 'Auto 离线'}
          </span>
          {busy && phase && (
            <span style={{ fontSize: 12, color: '#1565c0' }}>{phaseLabel[phase] ?? phase}…</span>
          )}
        </div>
        <div className="iv-header-right">
          <select
            className="iv-history-select"
            value={selectedId ?? ''}
            onChange={(e) => handleSelectHistory(Number(e.target.value))}
            disabled={busy || history.length === 0}
            title={busy ? '查询进行中，暂停历史切换' : '选择历史识别结果'}
          >
            {history.length === 0 && <option value="">暂无历史</option>}
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {formatHistoryLabel(h)}
              </option>
            ))}
          </select>
          <button className="iv-btn" onClick={handleClearTables} disabled={busy}>清空表格</button>
        </div>
      </div>

      {/* 控件 */}
      <div className="iv-controls">
        <div className="iv-field">
          可用库存阈值
          <input
            className="iv-input"
            type="number"
            min={0}
            value={threshold}
            onChange={(e) => setThreshold(Math.max(0, Number(e.target.value)))}
            disabled={busy}
          />
        </div>
        <div className="iv-field">
          趋势警告阈值
          <input
            className="iv-input"
            type="number"
            min={0}
            value={trendThreshold}
            onChange={(e) => setTrendThreshold(Math.max(0, Number(e.target.value) || 0))}
            disabled={busy}
          />
        </div>
        <div className="iv-field">
          近期（月）
          <input
            className="iv-input"
            type="number"
            min={1}
            step={1}
            value={recentMonths}
            onChange={(e) => setRecentMonths(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            disabled={busy}
          />
        </div>
        <button className="iv-btn iv-btn-primary" onClick={handleDownload} disabled={busy}>
          {busy && phase === 'download' ? '下载中…' : '自动下载查询'}
        </button>
        <label className="iv-upload-btn" style={{ opacity: busy ? 0.5 : 1 }}>
          上传 CSV…
          <input type="file" accept=".csv,text/csv" onChange={handleUpload} hidden disabled={busy} />
        </label>
        {busy && (
          <button className="iv-btn iv-btn-danger" onClick={handleCancel}>取消</button>
        )}
      </div>

      {/* 进度日志 */}
      {log.length > 0 && (
        <div className="iv-progress">
          {log.map((line, i) => (
            <div key={i} className="iv-progress-line">{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
      {error && <div className="iv-error">{error}</div>}

      {(totalCleaned !== null || lowStockCount !== null) && (
        <div className="iv-low-stock-info">
          清洗后共 {totalCleaned ?? '—'} 项，可用库存低于阈值 {lowStockCount ?? '—'} 项
        </div>
      )}

      {/* 四类展示区 */}
      <div className="iv-tables">
        <div className="iv-row iv-row-top">
          <div className="iv-col iv-col-red">
            <div className="iv-col-title">
              <span>警告 · 可用库存低于阈值且近期出库达到警告阈值</span>
              <div className="iv-title-actions">
                <select
                  className="iv-sort-select"
                  value={warningSort}
                  onChange={(e) => setWarningSort(e.target.value as SortMode)}
                >
                  <option value="outbound">出库量从多到少</option>
                  <option value="stock">可用库存从少到多</option>
                </select>
                <span>{warn.length}</span>
              </div>
            </div>
            {renderTable(warn, 'iv-col-red')}
          </div>
          <div className="iv-col iv-col-yellow">
            <div className="iv-col-title">
              <span>提醒 · 可用库存低于阈值且近期有出库</span>
              <div className="iv-title-actions">
                <select
                  className="iv-sort-select"
                  value={reminderSort}
                  onChange={(e) => setReminderSort(e.target.value as SortMode)}
                >
                  <option value="outbound">出库量从多到少</option>
                  <option value="stock">可用库存从少到多</option>
                </select>
                <span>{remind.length}</span>
              </div>
            </div>
            {renderTable(remind, 'iv-col-yellow')}
          </div>
        </div>
        <div className="iv-row iv-row-bottom">
          <div className="iv-col iv-col-gray">
            <div className="iv-col-title">
              <span>信息 · 可用库存低于阈值但近期无出库</span>
              <span>{info.length}</span>
            </div>
            {renderTable(pagedInfo, 'iv-col-gray')}
            <div className="iv-pagination">
              <span>
                {info.length === 0 ? '0' : `${(infoPage - 1) * INFO_PAGE_SIZE + 1}-${Math.min(infoPage * INFO_PAGE_SIZE, info.length)}`}
                {' / '}{info.length} 条
              </span>
              <div className="iv-pagination-actions">
                <button
                  className="iv-page-btn"
                  onClick={() => setInfoPage((page) => Math.max(1, page - 1))}
                  disabled={infoPage === 1}
                >
                  上一页
                </button>
                <span>{infoPage} / {infoTotalPages}</span>
                <button
                  className="iv-page-btn"
                  onClick={() => setInfoPage((page) => Math.min(infoTotalPages, page + 1))}
                  disabled={infoPage === infoTotalPages}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
          <div className="iv-col iv-col-count">
            <div className="iv-count-num">{noAttention}</div>
            <div className="iv-count-label">无需注意（可用库存 ≥ 阈值）</div>
          </div>
        </div>
      </div>
    </div>
  );
}
