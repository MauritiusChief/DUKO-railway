/**
 * 仓库扫码页（Android Chrome 与 iOS 17+ 浏览器）
 *
 * 流程：点击「扫描条码」拍照或选图 → 前端压缩为受控 JPEG（最长边 1600px / 质量 0.85）→
 * 以 FormData 上传至服务端解码（POST /api/warehouse/barcode-decode）→
 * 按图片选择顺序应用结果 → 确认录入提交服务端。
 * 浏览器不做任何条码解码；照片仅在上传期间经 HTTPS 传输，不写入浏览器持久存储。
 *
 * 扫码规则（与计划一致，服务端负责识别与分类，前端负责轮次合并）：
 *  - 服务端对每张图片只返回至多一个型号序列号和一个产品序列号，或固定结果类别；
 *  - 无条码、格式外条码、同类型重复或额外条码显示对应错误，不改变本轮状态；
 *  - 恰好一个有效序列号且本轮两码均已填时，先清空本轮再填入本次值（开始下一件）；
 *  - 合法结果与已填槽位不同时，丢弃旧轮次并使用当前图片的全部结果开始新一轮；
 *  - 服务端写入成功后清空本轮；重复产品序列号显示原记录摘要（不振动）。
 *
 * 连续作业：在途图片（压缩 + 上传 + 等待结果）最多 4 张，按选择顺序应用服务端结果，
 * 防止并发响应乱序造成型号和产品错配；饱和时提示稍后重试。
 *
 * 经理/管理员在此页额外看到映射管理入口；仓库角色只能看到录入结果与待确认提示。
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { useI18n } from '../i18n/context';
import './WarehouseScanPage.css';

/** 与服务端/原型一致的固定格式（不使用导入元数据中的正则） */
const MODEL_RE = /^[A-Z]{2}-[A-Z]{2}-\d{6}$/;
const PRODUCT_RE = /^[A-Z]{2}-[A-Z0-9]{8}-\d{6}$/;

/** 前端图片准备参数：按最长边缩小后导出受控 JPEG */
const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.85;

/** 同时在途（压缩 + 上传 + 等待结果）的图片数上限；饱和时提示稍后重试 */
const MAX_IN_FLIGHT = 4;

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

/** 服务端解码响应（POST /barcode-decode） */
type DecodeResponse =
  | { ok: true; model?: string; product?: string }
  | { ok: false; reason: 'no-barcode' | 'invalid' | 'decode-failed' };

type ScanPageMessage = { kind: 'success' | 'error' | 'info'; text: string };

/** 一个按序应用的解码任务结果 */
type DecodeOutcome =
  | { kind: 'codes'; codes: string[] }
  | { kind: 'message'; message: ScanPageMessage };

/** 本轮状态：两码 + 最近一次写入的 SKU 摘要 */
interface RoundState {
  model: string;
  product: string;
  lastSku: { sku: string; placeholder: boolean } | null;
}

const EMPTY_ROUND: RoundState = { model: '', product: '', lastSku: null };

/** 按最长边限制缩小并导出受控 JPEG；不进行任何条码解码 */
async function prepareJpeg(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // from-image：按 EXIF 方向解码；旧实现不认识该值时退回无参调用
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  try {
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('JPEG encode failed');
    return blob;
  } finally {
    bitmap.close();
  }
}

export default function WarehouseScanPage() {
  const { t } = useI18n();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [round, setRound] = useState<RoundState>(EMPTY_ROUND);
  // 同步镜像：结果按序应用时直接读取最新值，避免批量响应下的过期闭包
  const roundRef = useRef<RoundState>(EMPTY_ROUND);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [duplicate, setDuplicate] = useState<{ sku: string; model: string; scannedAt: string } | null>(null);
  const [message, setMessage] = useState<ScanPageMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 在途解码任务：计数（驱动按钮态）+ 序号（保证按拍照顺序应用）
  const [inFlight, setInFlight] = useState(0);
  const inFlightRef = useRef(0);
  const nextSeqRef = useRef(0);
  const nextApplySeqRef = useRef(0);
  const doneRef = useRef(new Map<number, DecodeOutcome>());

  const commitRound = (next: RoundState) => {
    roundRef.current = next;
    setRound(next);
  };

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

    const current = roundRef.current;
    const setRoundAndMessage = (nextModel: string, nextProduct: string, replaced: boolean) => {
      commitRound({
        model: nextModel,
        product: nextProduct,
        lastSku: replaced ? null : current.lastSku,
      });

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
    if (codes.length === 1 && current.model && current.product) {
      setRoundAndMessage(newModel ?? '', newProduct ?? '', true);
      return;
    }

    // 新值与已填槽位冲突时，以当前图片的全部合法结果开始新一轮。
    if (
      (newModel && current.model && current.model !== newModel) ||
      (newProduct && current.product && current.product !== newProduct)
    ) {
      setRoundAndMessage(newModel ?? '', newProduct ?? '', true);
      return;
    }

    setRoundAndMessage(newModel ?? current.model, newProduct ?? current.product, false);
  };

  /** 结果就绪：入桶并按序应用，保证与图片选择顺序一致 */
  const finishTask = (seq: number, outcome: DecodeOutcome) => {
    doneRef.current.set(seq, outcome);
    while (doneRef.current.has(nextApplySeqRef.current)) {
      const next = doneRef.current.get(nextApplySeqRef.current)!;
      doneRef.current.delete(nextApplySeqRef.current);
      nextApplySeqRef.current += 1;
      if (next.kind === 'codes') {
        applyCodes(next.codes);
      } else {
        setMessage(next.message);
      }
    }
  };

  /** 上传一张受控 JPEG 到服务端解码，并将固定类别的结果转为按序应用的结果 */
  const decodeOnServer = async (seq: number, blob: Blob) => {
    let outcome: DecodeOutcome;
    try {
      const formData = new FormData();
      formData.append('photo', blob, 'photo.jpg'); // 固定文件名，不携带用户原始文件名
      const res = await fetchWithAuth('/api/warehouse/barcode-decode', {
        method: 'POST',
        body: formData, // 不手动设置 Content-Type，由浏览器生成 multipart boundary
      });

      if (res.status === 503) {
        outcome = { kind: 'message', message: { kind: 'error', text: t('图片解码任务较多，请稍候再试') } };
      } else if (res.ok) {
        const data = (await res.json()) as DecodeResponse;
        if (data.ok) {
          const codes = [data.model, data.product].filter((v): v is string => Boolean(v)).map(normalizeSerial);
          outcome = codes.length
            ? { kind: 'codes', codes }
            : { kind: 'message', message: { kind: 'error', text: t('未识别到条码，请对准条码后重试') } };
        } else if (data.reason === 'no-barcode') {
          outcome = { kind: 'message', message: { kind: 'error', text: t('未识别到条码，请对准条码后重试') } };
        } else if (data.reason === 'invalid') {
          outcome = { kind: 'message', message: { kind: 'error', text: t('识别到多个或不符合格式的条码，本次扫码无效') } };
        } else {
          outcome = { kind: 'message', message: { kind: 'error', text: t('图片处理失败，请重试') } };
        }
      } else {
        let errorText = '';
        try {
          errorText = ((await res.json()) as { error?: string }).error ?? '';
        } catch {
          // 非 JSON 错误体，忽略
        }
        outcome = { kind: 'message', message: { kind: 'error', text: errorText || t('图片处理失败，请重试') } };
      }
    } catch {
      outcome = { kind: 'message', message: { kind: 'error', text: t('网络错误') } };
    }
    finishTask(seq, outcome);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (inFlightRef.current >= MAX_IN_FLIGHT) {
      setMessage({ kind: 'error', text: t('图片解码任务较多，请稍候再试') });
      return;
    }

    const seq = nextSeqRef.current;
    nextSeqRef.current += 1;
    inFlightRef.current += 1;
    setInFlight(inFlightRef.current);
    setMessage(null);

    void (async () => {
      try {
        const blob = await prepareJpeg(file);
        await decodeOnServer(seq, blob);
      } catch {
        // 压缩失败（含浏览器无法解码的图片格式），本轮状态不变
        finishTask(seq, { kind: 'message', message: { kind: 'error', text: t('图片处理失败，请重试') } });
      } finally {
        inFlightRef.current -= 1;
        setInFlight(inFlightRef.current);
      }
    })();
  };

  const clearRound = () => {
    commitRound(EMPTY_ROUND);
    setDuplicate(null);
    setMessage(null);
  };

  const handleSubmit = async () => {
    const { model, product } = roundRef.current;
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
        commitRound({ model: '', product: '', lastSku: { sku: rec.sku, placeholder } });
        setMessage({ kind: 'success', text: placeholder ? t('已保存，SKU 待确认') : t('已保存') });
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
        disabled={submitting}
        onClick={() => fileInputRef.current?.click()}
      >
        {inFlight > 1
          ? t('正在识别条码（{n}）...', { n: inFlight })
          : inFlight === 1
            ? t('正在识别条码...')
            : t('扫描条码')}
      </button>

      <div className="ws-status">
        <div className="ws-status-row">
          <span className="ws-status-label">{t('型号序列号')}</span>
          <span className={`ws-status-value ${round.model ? '' : 'ws-status-empty'}`}>{round.model || '—'}</span>
        </div>
        <div className="ws-status-row">
          <span className="ws-status-label">{t('产品序列号')}</span>
          <span className={`ws-status-value ${round.product ? '' : 'ws-status-empty'}`}>{round.product || '—'}</span>
        </div>
        <div className="ws-status-row">
          <span className="ws-status-label">SKU</span>
          <span className={`ws-status-value ${round.lastSku ? (round.lastSku.placeholder ? 'ws-status-pending' : '') : 'ws-status-empty'}`}>
            {round.lastSku
              ? round.lastSku.placeholder
                ? `${round.lastSku.sku}（${t('待确认 SKU')}）`
                : round.lastSku.sku
              : '—'}
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
          disabled={!round.model || !round.product || submitting}
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
