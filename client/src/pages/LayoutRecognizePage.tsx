/**
 * LayoutRecognizePage —— 布局识别主页面
 *
 * 仅维护单个当前布局，通过保存/加载 JSON 文件进行备份与恢复。
 * 通过 LayoutCanvas 渲染所有墙，每面墙含空中 + 地面两个轨道。
 */
import { useState, useRef, useCallback } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { useI18n } from '../i18n/context';
import { LayoutCanvas } from '../components/LayoutCanvas';
import { ImageUploadPanel } from '../components/ImageUploadPanel';
import { LayoutChatPanel } from '../components/LayoutChatPanel';
import type { LayoutDocument } from '../types';
import './LayoutRecognizePage.css';

export default function LayoutRecognizePage() {
  const { t } = useI18n();
  const store = useLayoutStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeLayout = store.activeLayout;

  // ---- 保存 ----
  const handleSave = useCallback(() => {
    const json = store.getActiveLayoutJson();
    if (!json) return;
    const layout = JSON.parse(json);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(layout.name || 'layout').replace(/\s+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [store]);

  // ---- 加载 ----
  const handleLoadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          store.loadLayout(reader.result as string);
        } catch {
          alert('Invalid layout JSON file');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    [store],
  );

  // ---- 新建 ----
  const handleNew = useCallback(() => {
    if (!activeLayout || confirm('Create a new blank layout? Unsaved changes will be lost.')) {
      store.newLayout();
    }
  }, [activeLayout, store]);

  // ---- 添加墙面/岛台 ----
  const [showAddWall, setShowAddWall] = useState(false);
  const [wallName, setWallName] = useState('');
  const [wallWidth, setWallWidth] = useState('');

  const openAddWallForm = useCallback(() => {
    const active = store.getActiveLayout();
    const num = (active?.walls.length ?? 0) + 1;
    setWallName(`Wall ${num}`);
    setWallWidth('120');
    setShowAddWall(true);
  }, [store]);

  const handleAddWall = useCallback(() => {
    if (!wallName.trim() || !wallWidth.trim()) return;
    const width = parseFloat(wallWidth);
    if (isNaN(width) || width <= 0) return;
    store.addWall(wallName.trim(), width);
    setWallName('');
    setWallWidth('');
    setShowAddWall(false);
  }, [wallName, wallWidth, store]);

  // ---- 空状态 ----
  if (!activeLayout) {
    return (
      <div className="lr-container">
        <div className="lr-empty">
          <h2 className="lr-empty-title">{t('布局识别')}</h2>
          <p className="lr-empty-desc">{t('布局识别说明')}</p>
          <div className="lr-empty-actions">
            <button className="lr-btn lr-btn-primary" onClick={() => store.newLayout()}>
              {t('新建布局')}
            </button>
            <button className="lr-btn" onClick={handleLoadClick}>
              {t('导入布局')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        </div>
      </div>
    );
  }

  // ---- 正常页面 ----
  return (
    <div className="lr-container">
      {/* 顶部工具栏 */}
      <div className="lr-header">
        <div className="lr-header-left">
          <h1 className="lr-title">{t('布局识别')}</h1>
          <p className="lr-sub">{t('布局识别说明')}</p>
        </div>
        <div className="lr-header-right">
          <span className="lr-layout-name">{activeLayout.name}</span>

          <button className="lr-btn lr-btn-sm" onClick={handleNew}>
            {t('新建布局')}
          </button>
          <button className="lr-btn lr-btn-sm" onClick={handleSave}>{t('导出布局')}</button>
          <button className="lr-btn lr-btn-sm" onClick={handleLoadClick}>{t('导入布局')}</button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {/* 添加墙面/岛台 */}
          {showAddWall ? (
            <div className="lr-inline-form">
              <input
                className="lr-input lr-input-sm"
                placeholder={t('请输入名称')}
                value={wallName}
                onChange={(e) => setWallName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddWall(); }}
                autoFocus
              />
              <input
                className="lr-input lr-input-sm lr-input-num"
                placeholder={t('请输入宽度')}
                type="number"
                min="1"
                value={wallWidth}
                onChange={(e) => setWallWidth(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddWall(); }}
              />
              <button className="lr-btn lr-btn-primary lr-btn-sm" onClick={handleAddWall}>OK</button>
              <button className="lr-btn lr-btn-sm" onClick={() => { setShowAddWall(false); setWallName(''); setWallWidth(''); }}>X</button>
            </div>
          ) : (
            <button className="lr-btn lr-btn-sm lr-btn-primary" onClick={openAddWallForm}>
              + 墙面/岛台
            </button>
          )}
        </div>
      </div>

      {/* 主区域：左画布 + 右侧栏 */}
      <div className="lr-main">
        <div className="lr-canvas-wrap">
          <LayoutCanvas />
        </div>
        <div className="lr-sidebar">
          <ImageUploadPanel
            layout={activeLayout}
            onLayoutUpdated={(updatedLayout: LayoutDocument) => {
              store.loadLayout(JSON.stringify(updatedLayout));
            }}
          />
          <LayoutChatPanel />
        </div>
      </div>
    </div>
  );
}
