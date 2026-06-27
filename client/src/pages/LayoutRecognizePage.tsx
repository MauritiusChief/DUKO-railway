/**
 * LayoutRecognizePage —— 布局识别主页面
 *
 * 提供布局文档管理（新建/切换/导入/导出/删除）、墙/岛台展示与编辑。
 * 通过 LayoutCanvas 渲染所有墙/岛台，每面墙含空中 + 地面两个轨道。
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

  const activeLayout = store.getActiveLayout();

  // ---- 新建布局 ----
  const [newLayoutName, setNewLayoutName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);

  const openNewLayoutForm = useCallback(() => {
    const num = store.layouts.length + 1;
    setNewLayoutName(`Layout ${num}`);
    setShowNewForm(true);
  }, [store.layouts.length]);

  const handleCreateLayout = useCallback(() => {
    if (!newLayoutName.trim()) return;
    store.createLayout(newLayoutName.trim());
    setNewLayoutName('');
    setShowNewForm(false);
  }, [newLayoutName, store]);

  // ---- 导出 ----
  const handleExport = useCallback(() => {
    const layout = store.exportActiveLayout();
    if (!layout) return;
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${layout.name.replace(/\s+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [store]);

  // ---- 导入 ----
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const layout = JSON.parse(reader.result as string) as LayoutDocument;
          store.importLayout(layout);
        } catch {
          alert('Invalid layout JSON file');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    [store],
  );

  // ---- 添加墙面 / 岛台 ----
  const [showAddWall, setShowAddWall] = useState(false);
  const [wallName, setWallName] = useState('');
  const [wallWidth, setWallWidth] = useState('');
  const [wallType, setWallType] = useState<'wall' | 'island'>('wall');

  const computeWallDefaultName = useCallback(
    (type: 'wall' | 'island') => {
      const active = store.getActiveLayout();
      const num = type === 'wall'
        ? (active?.walls.length ?? 0) + 1
        : (active?.islands.length ?? 0) + 1;
      return `${type === 'wall' ? 'Wall' : 'Island'} ${num}`;
    },
    [store],
  );

  const openAddWallForm = useCallback(() => {
    setWallType('wall');
    setWallName(computeWallDefaultName('wall'));
    setWallWidth('120');
    setShowAddWall(true);
  }, [computeWallDefaultName]);

  const handleWallTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const type = e.target.value as 'wall' | 'island';
      setWallType(type);
      setWallName(computeWallDefaultName(type));
    },
    [computeWallDefaultName],
  );

  const handleAddWall = useCallback(() => {
    if (!wallName.trim() || !wallWidth.trim()) return;
    const width = parseFloat(wallWidth);
    if (isNaN(width) || width <= 0) return;
    if (wallType === 'wall') {
      store.addWall(wallName.trim(), width);
    } else {
      store.addIsland(wallName.trim(), width);
    }
    setWallName('');
    setWallWidth('');
    setShowAddWall(false);
  }, [wallName, wallWidth, wallType, store]);

  // ---- 空状态 ----
  if (store.layouts.length === 0) {
    return (
      <div className="lr-container">
        <div className="lr-empty">
          <h2 className="lr-empty-title">{t('布局识别')}</h2>
          <p className="lr-empty-desc">{t('布局识别说明')}</p>
          <div className="lr-empty-actions">
            {showNewForm ? (
              <div className="lr-inline-form">
                <input
                  className="lr-input"
                  placeholder={t('布局名称')}
                  value={newLayoutName}
                  onChange={(e) => setNewLayoutName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateLayout(); }}
                  autoFocus
                />
                <button className="lr-btn lr-btn-primary" onClick={handleCreateLayout}>
                  {t('新建布局')}
                </button>
                <button className="lr-btn" onClick={() => { setShowNewForm(false); setNewLayoutName(''); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="lr-btn lr-btn-primary" onClick={openNewLayoutForm}>
                {t('新建布局')}
              </button>
            )}
            <button className="lr-btn" onClick={handleImportClick}>
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
          {/* 布局选择 */}
          <select
            className="lr-select"
            value={activeLayout?.id ?? ''}
            onChange={(e) => store.setActiveLayout(e.target.value)}
          >
            {store.layouts.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>

          {/* 新建 */}
          {showNewForm ? (
            <div className="lr-inline-form">
              <input
                className="lr-input lr-input-sm"
                placeholder={t('布局名称')}
                value={newLayoutName}
                onChange={(e) => setNewLayoutName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateLayout(); }}
                autoFocus
              />
              <button className="lr-btn lr-btn-primary lr-btn-sm" onClick={handleCreateLayout}>OK</button>
              <button className="lr-btn lr-btn-sm" onClick={() => { setShowNewForm(false); setNewLayoutName(''); }}>X</button>
            </div>
          ) : (
            <button className="lr-btn lr-btn-sm" onClick={openNewLayoutForm}>
              {t('新建布局')}
            </button>
          )}

          <button className="lr-btn lr-btn-sm" onClick={handleExport}>{t('导出布局')}</button>
          <button className="lr-btn lr-btn-sm" onClick={handleImportClick}>{t('导入布局')}</button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {activeLayout && store.layouts.length > 1 && (
            <button
              className="lr-btn lr-btn-sm lr-btn-danger"
              onClick={() => {
                if (confirm(`Delete layout "${activeLayout.name}"?`)) {
                  store.deleteLayout(activeLayout.id);
                }
              }}
            >
              {t('删除布局')}
            </button>
          )}

          {/* 添加墙/岛台 */}
          {showAddWall ? (
            <div className="lr-inline-form">
              <select
                className="lr-select lr-select-sm"
                value={wallType}
                onChange={handleWallTypeChange}
              >
                <option value="wall">{t('添加墙面')}</option>
                <option value="island">{t('添加岛台')}</option>
              </select>
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
              + Wall/Island
            </button>
          )}
        </div>
      </div>

      {/* 主区域：左画布 + 右侧栏 */}
      {activeLayout && (
        <div className="lr-main">
          <div className="lr-canvas-wrap">
            <LayoutCanvas />
          </div>
          <div className="lr-sidebar">
            <ImageUploadPanel
              layout={activeLayout}
              onLayoutUpdated={(updatedLayout: LayoutDocument) => {
                store.importLayout(updatedLayout);
              }}
            />
            <LayoutChatPanel />
          </div>
        </div>
      )}
    </div>
  );
}
