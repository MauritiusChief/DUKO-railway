/**
 * 仓库扫码页（Android Chrome 与 iOS 17+ 浏览器）
 *
 * 流程：点击「扫描条码」用后置相机拍一张照片 → 原生 BarcodeDetector 或本地 WASM 解码 →
 * 填充本轮型号/产品序列号 → 确认录入提交服务端。
 *
 * 扫码规则（与计划一致）：
 *  - 每张图片解码收集全部条码，只接受至多一个型号格式值和一个产品格式值；
 *  - 额外条码、两个同类型有效值或格式外条码使整次扫码无效，不改变本轮状态；
 *  - 恰好一个有效序列号且本轮两码均已填时，先清空本轮再填入本次值（开始下一件）；
 *  - 合法结果与已填槽位不同时，丢弃旧轮次并使用当前图片的全部结果开始新一轮；
 *  - 服务端写入成功后清空本轮；重复产品序列号显示原记录摘要（不振动）。
 *
 * 经理/管理员在此页额外看到映射管理入口；仓库角色只能看到录入结果与待确认提示。
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { useI18n } from '../i18n/context';
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import './WarehouseScanPage.css';

/** 与服务端/原型一致的固定格式（不使用导入元数据中的正则） */
const MODEL_RE = /^[A-Z]{2}-[A-Z]{2}-\d{6}$/;
const PRODUCT_RE = /^[A-Z]{2}-[A-Z0-9]{8}-\d{6}$/;

/** 序列号规范化：trim + 大写 */
function normalizeSerial(value: string): string {
  return value.trim().toUpperCase();
}

/** 扫描记录（POST /scans 响应） */
interface ScanRecord {
  product_seri_num: string;
  model_seri_num: string;
  sku: string;
  scanned_at: string;
}

type ScanPageMessage = { kind: 'success' | 'error' | 'info'; text: string };
type BarcodeDetectorLike = {
  detect(source: Blob): Promise<{ rawValue: string }[]>;
};

export default function WarehouseScanPage() {
  const { t } = useI18n();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [detectorState, setDetectorState] = useState<'checking' | 'ready' | 'failed'>('checking');
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [model, setModel] = useState('');
  const [product, setProduct] = useState('');
  const [lastSku, setLastSku] = useState<{ sku: string; placeholder: boolean } | null>(null);
  const [duplicate, setDuplicate] = useState<{ sku: string; model: string; scannedAt: string } | null>(null);
  const [message, setMessage] = useState<ScanPageMessage | null>(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 优先使用浏览器原生能力；iOS 等不支持时改用同源 WASM，图片始终只在设备本地解码。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if ('BarcodeDetector' in globalThis) {
        try {
          const formats = await BarcodeDetector.getSupportedFormats();
          if (cancelled) return;
          detectorRef.current = formats.length ? new BarcodeDetector({ formats }) : new BarcodeDetector();
          setDetectorState('ready');
          return;
        } catch {
          // 原生实现不可用时继续尝试同源 WASM 后备。
        }
      }

      try {
        const { BarcodeDetector: BarcodeDetectorPonyfill, prepareZXingModule } = await import('barcode-detector/ponyfill');
        await prepareZXingModule({
          fireImmediately: true,
          overrides: {
            locateFile: (path, prefix) => (path.endsWith('.wasm') ? zxingReaderWasmUrl : prefix + path),
          },
        });
        if (cancelled) return;
        detectorRef.current = new BarcodeDetectorPonyfill();
        setDetectorState('ready');
      } catch {
        if (!cancelled) setDetectorState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 依规则应用一次解码结果（codes 已规范化） */
  const applyCodes = (codes: string[]) => {
    if (codes.length === 0) {
      setMessage({ kind: 'error', text: t('未识别到条码，请对准条码后重试') });
      return;
    }

    const models = codes.filter((c) => MODEL_RE.test(c));
    const products = codes.filter((c) => PRODUCT_RE.test(c));
    // 额外条码、两个同类型有效值或格式外条码 → 整次无效
    if (models.length + products.length !== codes.length || models.length > 1 || products.length > 1) {
      setMessage({ kind: 'error', text: t('识别到多个或不符合格式的条码，本次扫码无效') });
      return;
    }

    const newModel = models[0];
    const newProduct = products[0];
    setDuplicate(null);

    const setRound = (nextModel: string, nextProduct: string, replaced: boolean) => {
      setModel(nextModel);
      setProduct(nextProduct);
      if (replaced) setLastSku(null);

      if (nextModel && nextProduct) {
        setMessage({
          kind: 'info',
          text: replaced
            ? t('本轮已更新为最新扫描结果，请确认录入或清空本轮')
            : t('本轮已就绪，请确认录入或清空本轮'),
        });
      } else if (nextModel) {
        setMessage({
          kind: 'info',
          text: replaced ? t('本轮已更新为最新型号，请扫描产品条码') : t('已扫描型号，请扫描产品条码'),
        });
      } else {
        setMessage({
          kind: 'info',
          text: replaced ? t('本轮已更新为最新产品，请扫描型号条码') : t('已扫描产品，请扫描型号条码'),
        });
      }
    };

    // 恰好一个有效序列号且两码均已填 → 清空本轮再填入（开始下一件）
    if (codes.length === 1 && model && product) {
      setRound(newModel ?? '', newProduct ?? '', true);
      return;
    }

    // 新值与已填槽位冲突时，以当前图片的全部合法结果开始新一轮。
    if ((newModel && model && model !== newModel) || (newProduct && product && product !== newProduct)) {
      setRound(newModel ?? '', newProduct ?? '', true);
      return;
    }

    const nextModel = newModel ?? model;
    const nextProduct = newProduct ?? product;
    setRound(nextModel, nextProduct, false);
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !detectorRef.current || scanning) return;

    setScanning(true);
    setMessage(null);
    try {
      const found = await detectorRef.current.detect(file);
      const codes = found.map((item) => normalizeSerial(item.rawValue)).filter(Boolean);
      applyCodes(codes);
    } catch {
      setMessage({ kind: 'error', text: t('图片处理失败，请重试') });
    } finally {
      setScanning(false);
    }
  };

  const clearRound = () => {
    setModel('');
    setProduct('');
    setLastSku(null);
    setDuplicate(null);
    setMessage(null);
  };

  const handleSubmit = async () => {
    if (!model || !product || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetchWithAuth('/api/warehouse/scans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelSeriNum: model, productSeriNum: product }),
      });
      const data = (await res.json()) as { record?: ScanRecord; existing?: ScanRecord; error?: string };

      if (res.status === 201 && data.record) {
        const rec = data.record;
        const placeholder = rec.sku.toUpperCase() === rec.model_seri_num.toUpperCase();
        setLastSku({ sku: rec.sku, placeholder });
        setMessage({ kind: 'success', text: placeholder ? t('已保存，SKU 待确认') : t('已保存') });
        setModel('');
        setProduct('');
        setDuplicate(null);
      } else if (res.status === 409 && data.existing) {
        // 重复：显示原记录摘要，不改变本轮状态，不振动
        setDuplicate({
          sku: data.existing.sku,
          model: data.existing.model_seri_num,
          scannedAt: data.existing.scanned_at,
        });
        setMessage({ kind: 'error', text: t('产品序列号已存在') });
      } else {
        setMessage({ kind: 'error', text: data.error || t('保存失败') });
      }
    } catch {
      setMessage({ kind: 'error', text: t('网络错误') });
    } finally {
      setSubmitting(false);
    }
  };

  const canManage = user?.role === 'admin' || user?.role === 'manager';

  return (
    <div className="ws-page">
      <div className="ws-header">
        <h1>{t('仓库扫码')}</h1>
        {canManage && (
          <button className="ws-manage-link" onClick={() => navigate('/warehouse-manage')}>
            {t('仓库管理')}
          </button>
        )}
      </div>

      {detectorState === 'checking' && (
        <p className="ws-banner ws-banner-info">{t('正在准备条码识别器...')}</p>
      )}

      {detectorState === 'failed' && (
        <p className="ws-banner ws-banner-error">{t('条码识别器加载失败，请刷新页面后重试')}</p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handleFileChange}
      />

      <button
        className="ws-scan-btn"
        disabled={detectorState !== 'ready' || scanning || submitting}
        onClick={() => fileInputRef.current?.click()}
      >
        {scanning ? t('正在识别条码...') : t('扫描条码')}
      </button>

      <div className="ws-status">
        <div className="ws-status-row">
          <span className="ws-status-label">{t('型号序列号')}</span>
          <span className={`ws-status-value ${model ? '' : 'ws-status-empty'}`}>{model || '—'}</span>
        </div>
        <div className="ws-status-row">
          <span className="ws-status-label">{t('产品序列号')}</span>
          <span className={`ws-status-value ${product ? '' : 'ws-status-empty'}`}>{product || '—'}</span>
        </div>
        <div className="ws-status-row">
          <span className="ws-status-label">SKU</span>
          <span className={`ws-status-value ${lastSku ? (lastSku.placeholder ? 'ws-status-pending' : '') : 'ws-status-empty'}`}>
            {lastSku ? (lastSku.placeholder ? `${lastSku.sku}（${t('待确认 SKU')}）` : lastSku.sku) : '—'}
          </span>
        </div>
      </div>

      {message && <p className={`ws-message ws-message-${message.kind}`}>{message.text}</p>}

      {duplicate && (
        <div className="ws-duplicate">
          <strong>{t('原记录')}</strong>
          <span>SKU: {duplicate.sku}</span>
          <span>{t('型号序列号')}: {duplicate.model}</span>
          <span>{t('扫描时间')}: {new Date(duplicate.scannedAt).toLocaleString()}</span>
        </div>
      )}

      <div className="ws-actions">
        <button
          className="ws-submit-btn"
          disabled={!model || !product || submitting}
          onClick={handleSubmit}
        >
          {submitting ? t('保存中...') : t('确认录入')}
        </button>
        <button className="ws-clear-btn" onClick={clearRound} disabled={submitting}>
          {t('清空本轮')}
        </button>
      </div>
    </div>
  );
}
