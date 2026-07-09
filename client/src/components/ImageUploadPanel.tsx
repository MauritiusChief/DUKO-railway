/**
 * ImageUploadPanel —— 图片上传 + 视图选择面板
 *
 * 用户在此粘贴/拖入橱柜布局图片，选择视图类型和关联的墙/岛台，
 * 点击识别后发送到后端 OpenRouter 视觉模型进行布局识别。
 * 通过 SSE 流式接收 tool_call / reply_chunk / layout_update / result 事件，
 * 实时更新左侧画布和右侧对话面板。
 * 图片不持久化，仅作为 LayoutInstruction 的临时载体。
 */
import { useState, useCallback, useRef } from 'react';
import { useI18n } from '../i18n/context';
import { useLayoutStore } from '../stores/layoutStore';
import type { LayoutDocument } from '../types';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { parseSSEEvents, type SSEEvent } from '../lib/sse';
import './ImageUploadPanel.css';

interface ImageUploadPanelProps {
  layout: LayoutDocument | null;
  onLayoutUpdated: (layout: LayoutDocument) => void;
}

export function ImageUploadPanel({ layout, onLayoutUpdated }: ImageUploadPanelProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imageData, setImageData] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'top' | 'elevation' | '3d'>('elevation');
  const [associatedWallIds, setAssociatedWallIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  /** 处理图片选择/粘贴/拖拽 */
  const handleImage = useCallback((dataUrl: string) => {
    // 释放旧预览
    if (imagePreviewUrl && imagePreviewUrl !== dataUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
    }
    setImageData(dataUrl);
    // 若已是 blob URL 则直接用；否则从 base64 创建
    if (dataUrl.startsWith('blob:')) {
      setImagePreviewUrl(dataUrl);
    } else {
      try {
        const parts = dataUrl.split(',');
        if (parts.length < 2) { setImagePreviewUrl(dataUrl); return; }
        const mime = parts[0].match(/data:(image\/[^;]*)/)?.[1] || 'image/png';
        const binary = atob(parts[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        setImagePreviewUrl(URL.createObjectURL(blob));
      } catch {
        setImagePreviewUrl(dataUrl);
      }
    }
    setError('');
    setSuccessMsg('');
  }, [imagePreviewUrl]);

  /** 文件选择 */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => handleImage(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = '';
  }, [handleImage]);

  /** 粘贴 */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = () => handleImage(reader.result as string);
          reader.readAsDataURL(file);
          break;
        }
      }
    }
  }, [handleImage]);

  /** 拖拽 */
  const [dragOver, setDragOver] = useState(false);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true); }, []);
  const handleDragLeave = useCallback(() => setDragOver(false), []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => handleImage(reader.result as string);
    reader.readAsDataURL(file);
  }, [handleImage]);

  /** 切换关联墙 */
  const toggleWall = useCallback((id: string) => {
    setAssociatedWallIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  /** 提交识别（SSE 流式） */
  const handleRecognize = useCallback(async () => {
    if (!imageData || !layout) return;
    setLoading(true);
    setError('');
    setSuccessMsg('');

    try {
      const res = await fetchWithAuth('/api/layout/parse-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageData,
          viewType,
          associatedWallIds,
          layout,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: t('识别失败') }));
        setError(errBody.error || errBody.detail || t('识别失败'));
        setLoading(false);
        return;
      }

      // SSE 流式读取
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const readLoop = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseSSEEvents(buffer);
          buffer = remaining;

          for (const event of events) {
            // 转发给 LayoutChatPanel 展示对话过程
            useLayoutStore.getState().emitRecognitionEvent(event);

            if (event.type === 'layout_update') {
              const data = event.data as { layout: LayoutDocument; tool?: string };
              if (data.layout) {
                onLayoutUpdated(data.layout);
              }
            } else if (event.type === 'result') {
              const data = event.data as { updatedLayout: LayoutDocument; reply?: string };
              if (data.updatedLayout) {
                onLayoutUpdated(data.updatedLayout);
              }
              setSuccessMsg(t('布局更新成功'));
            } else if (event.type === 'error') {
              const data = event.data as { message?: string };
              setError(data.message || t('识别失败'));
            }
          }
        }
      };

      await readLoop();
    } catch {
      setError(t('网络请求失败'));
    } finally {
      setLoading(false);
    }
  }, [imageData, viewType, associatedWallIds, layout, onLayoutUpdated, t]);

  const allItems = layout ? layout.walls : [];

  return (
    <div className="iup-panel" onPaste={handlePaste}>
      <div className="iup-header">{t('图片识别')}</div>

      {/* 图片区域 */}
      <div
        className={`iup-dropzone ${dragOver ? 'iup-dragover' : ''} ${imagePreviewUrl ? 'iup-has-image' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        {imagePreviewUrl ? (
          <img src={imagePreviewUrl} alt="Preview" className="iup-preview" />
        ) : (
          <div className="iup-placeholder">
            <span className="iup-placeholder-icon">🖼</span>
            <span>{t('拖拽图片提示')}</span>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>

      {/* 类型选择 */}
      <div className="iup-row">
        <label className="iup-label">{t('视图类型')}:</label>
        <select className="iup-select" value={viewType} onChange={(e) => setViewType(e.target.value as 'top' | 'elevation' | '3d')}>
          <option value="elevation">{t('正视图')}</option>
          <option value="top">{t('俯视图')}</option>
          <option value="3d">{t('立体图')}</option>
        </select>
      </div>

      {/* 关联墙/岛台 */}
      {allItems.length > 0 && (
        <div className="iup-row iup-row-col">
          <label className="iup-label">{t('关联墙面岛台')}:</label>
          <div className="iup-checkboxes">
            {allItems.map((item) => (
              <label key={item.id} className="iup-check">
                <input
                  type="checkbox"
                  checked={associatedWallIds.includes(item.id)}
                  onChange={() => toggleWall(item.id)}
                />
                {item.name}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 按钮 */}
      <button
        className="iup-btn"
        disabled={!imageData || loading}
        onClick={handleRecognize}
      >
        {loading ? t('识别中') : t('识别此图片')}
      </button>

      {/* 清空图片 */}
      {imageData && (
        <button
          className="iup-btn-clear"
          onClick={() => { setImageData(null); setImagePreviewUrl(null); }}
        >
          {t('清除图片')}
        </button>
      )}

      {/* 反馈 */}
      {error && <div className="iup-error">{error}</div>}
      {successMsg && <div className="iup-success">{successMsg}</div>}
    </div>
  );
}
