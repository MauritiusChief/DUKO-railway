/**
 * InventoryDashboardPage —— 库存看板
 *
 * 功能：
 *  - 自动下载查询（worker 从 Odoo 下载 CSV）或手动上传 CSV
 *  - 套用 sku-clean 清洗 + 低库存阈值筛选
 *  - 自动衔接趋势查验（worker 逐项查 ATL/Stock 近3月出入库）
 *  - 结果分为警告(红)/提醒(黄)/信息(灰) 三表 + 无需注意计数
 *
 * SSE 仅在查询过程中开启；完成后关闭。结果存 localStorage（单 key 覆盖）。
 * 无 i18n，文本硬编码中文。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { ReconnectingSSE } from '../lib/sseStream';
import './InventoryDashboardPage.css';

interface ClassifiedItem {
  name: string;
  qtyOnHand: number;
  freeToUse?: number;
  forecasted?: number;
  net: number;
}
interface Classification {
  warning: ClassifiedItem[];
  reminder: ClassifiedItem[];
  info: ClassifiedItem[];
  noAttentionCount: number;
}

const LS_KEY = 'duko_inventory_last';

function loadLastResult(): {
  classification: Classification;
  totalCleaned: number;
  threshold: number;
  trendThreshold: number;
} | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function InventoryDashboardPage() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);

  const [threshold, setThreshold] = useState(5);
  const [trendThreshold, setTrendThreshold] = useState(20);

  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');
  const [autoOnline, setAutoOnline] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [totalCleaned, setTotalCleaned] = useState<number | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sseRef = useRef<ReconnectingSSE | null>(null);
  const terminalRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const busy = status === 'running';

  // 恢复上次结果
  useEffect(() => {
    const last = loadLastResult();
    if (last) {
      setClassification(last.classification);
      setTotalCleaned(last.totalCleaned ?? null);
      setThreshold(last.threshold ?? 5);
      setTrendThreshold(last.trendThreshold ?? 20);
    }
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

  function openSSE(id: string) {
    sseRef.current?.stop();
    terminalRef.current = false;
    const sse = new ReconnectingSSE(`/api/inventory/jobs/${id}/events`, {
      onEvent: (type, data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        switch (type) {
          case 'snapshot': {
            if (d.phase) setPhase(String(d.phase));
            if (typeof d.autoOnline === 'boolean') setAutoOnline(d.autoOnline);
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
            if (typeof d.totalCleaned === 'number') setTotalCleaned(d.totalCleaned);
            if (typeof d.lowStockCount === 'number') setLowStockCount(d.lowStockCount);
            break;
          case 'complete':
            if (d.classification) {
              const c = d.classification as Classification;
              setClassification(c);
              saveResult(c);
            }
            setStatus('completed');
            finishSSE();
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

  function saveResult(c: Classification) {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          ts: Date.now(),
          threshold,
          trendThreshold,
          totalCleaned: totalCleaned ?? 0,
          classification: c,
        }),
      );
    } catch {
      /* 忽略配额错误 */
    }
  }

  function resetForNewJob() {
    setLog([]);
    setError(null);
    setClassification(null);
    setTotalCleaned(null);
    setLowStockCount(null);
    setStatus('running');
  }

  async function handleDownload() {
    resetForNewJob();
    setPhase('download');
    try {
      const res = await fetchWithAuth('/api/inventory/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold, trendThreshold }),
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
        body: JSON.stringify({ csv, threshold, trendThreshold }),
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

  function fmtNet(net: number): string {
    return (net >= 0 ? '+' : '') + net.toFixed(1);
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

  const warn = classification?.warning ?? [];
  const remind = classification?.reminder ?? [];
  const info = classification?.info ?? [];
  const noAttention = classification?.noAttentionCount ?? 0;

  function renderTable(items: ClassifiedItem[], colClass: string) {
    return (
      <div className="iv-table-wrap">
        <table className="iv-table">
          <thead>
            <tr>
              <th>型号</th>
              <th style={{ textAlign: 'right' }}>库存</th>
              <th style={{ textAlign: 'right' }}>净变化(3月)</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={3} className={`iv-td-empty ${colClass}`}>—</td>
              </tr>
            )}
            {items.map((it, i) => (
              <tr key={i}>
                <td>{it.name}</td>
                <td className="iv-td-num">{it.qtyOnHand.toFixed(0)}</td>
                <td className="iv-td-num">{fmtNet(it.net)}</td>
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
          <button className="iv-btn" onClick={() => navigate('/')}>回到主页</button>
          <button
            className="iv-btn"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            登出
          </button>
        </div>
      </div>

      {/* 控件 */}
      <div className="iv-controls">
        <div className="iv-field">
          低库存阈值
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
            value={trendThreshold}
            onChange={(e) => setTrendThreshold(Number(e.target.value))}
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
          清洗后共 {totalCleaned ?? '—'} 项，低于阈值 {lowStockCount ?? '—'} 项
        </div>
      )}

      {/* 四类展示区 */}
      <div className="iv-tables">
        <div className="iv-row iv-row-top">
          <div className="iv-col iv-col-red">
            <div className="iv-col-title">
              <span>警告 · 低于阈值且近期下降明显</span>
              <span>{warn.length}</span>
            </div>
            {renderTable(warn, 'iv-col-red')}
          </div>
          <div className="iv-col iv-col-yellow">
            <div className="iv-col-title">
              <span>提醒 · 低于阈值且有下降</span>
              <span>{remind.length}</span>
            </div>
            {renderTable(remind, 'iv-col-yellow')}
          </div>
        </div>
        <div className="iv-row iv-row-bottom">
          <div className="iv-col iv-col-gray">
            <div className="iv-col-title">
              <span>信息 · 低于阈值但近期无下降</span>
              <span>{info.length}</span>
            </div>
            {renderTable(info, 'iv-col-gray')}
          </div>
          <div className="iv-col iv-col-count">
            <div className="iv-count-num">{noAttention}</div>
            <div className="iv-count-label">无需注意（≥阈值）</div>
          </div>
        </div>
      </div>
    </div>
  );
}
