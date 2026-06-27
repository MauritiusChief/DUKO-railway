/**
 * WallPanel —— 单面墙/岛台的可折叠面板
 *
 * 展示墙头信息（名称、总宽、暴露面）、空中 + 地面两个轨道。
 * 每轨渲染 BlockCard 列表，支持拖拽移动、添加物品。
 * 拖拽时通过 mouse 事件计算距左距离，调用 store.moveBlock。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { useI18n } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import { BlockCard } from './BlockCard';
import type {
  LayoutWall,
  LayoutIsland,
  SectionBlock,
  BlockItem,
  BlockItemCategory,
  TrackSpan,
} from '../types';
import './WallPanel.css';

interface WallPanelProps {
  wall: LayoutWall | LayoutIsland;
  isIsland: boolean;
}

/** 每英寸对应的像素参考值 */
const PX_PER_INCH = 6;

/** 空中轨道可用物品分类 */
const AIR_CATEGORIES: BlockItemCategory[] = [
  'wall_cabinet', 'tall_cabinet', 'gap', 'range_hood', 'window', 'tall_appliance',
];

/** 地面轨道可用物品分类 */
const GROUND_CATEGORIES: BlockItemCategory[] = [
  'base_cabinet', 'tall_cabinet', 'gap', 'tall_appliance',
  'base_appliance_need_top', 'base_appliance_without_top',
];

const CATEGORY_T_KEY: Record<BlockItemCategory, string> = {
  wall_cabinet: '吊柜',
  base_cabinet: '地柜',
  tall_cabinet: '高柜',
  gap: '空挡',
  range_hood: '抽油烟机',
  window: '窗户',
  tall_appliance: '通天电器',
  base_appliance_need_top: '需台面电器',
  base_appliance_without_top: '免台面电器',
};

export function WallPanel({ wall, isIsland }: WallPanelProps) {
  const { t } = useI18n();
  const store = useLayoutStore();

  // ---- 折叠 ----
  const [collapsed, setCollapsed] = useState(false);

  // ---- 添加物品表单 ----
  const [addingTrack, setAddingTrack] = useState<TrackSpan | null>(null);
  const [newCategory, setNewCategory] = useState<BlockItemCategory>('wall_cabinet');
  const [newWidth, setNewWidth] = useState('');
  const [newSku, setNewSku] = useState('');
  const [stackedSkus, setStackedSkus] = useState<string[]>([]);

  /** 是否需要叠放吊柜的行 */
  const isStackableCategory =
    newCategory === 'wall_cabinet' || newCategory === 'tall_cabinet' || newCategory === 'tall_appliance';

  const startAdd = useCallback((track: TrackSpan) => {
    setAddingTrack(track);
    const categories = track === 'air' ? AIR_CATEGORIES : GROUND_CATEGORIES;
    setNewCategory(categories[0]);
    setNewWidth('');
    setNewSku('');
    setStackedSkus([]);
  }, []);

  const confirmAdd = useCallback(() => {
    if (!addingTrack || !newWidth.trim()) return;
    const width = parseFloat(newWidth);
    if (isNaN(width) || width <= 0) return;
    const primarySku = newSku.trim() || newCategory;
    const stacked: Omit<BlockItem, 'id'>[] = stackedSkus
      .filter((s) => s.trim())
      .map((s) => ({ category: 'wall_cabinet' as const, sku: s.trim() }));

    if (newCategory === 'tall_cabinet' || newCategory === 'tall_appliance') {
      store.insertBothTracksWithItems(
        wall.id,
        { category: newCategory, sku: primarySku },
        stacked,
        width,
      );
    } else {
      const items: Omit<BlockItem, 'id'>[] = [
        { category: newCategory, sku: primarySku },
      ];
      for (const s of stackedSkus) {
        if (s.trim()) {
          items.push({ category: 'wall_cabinet', sku: s.trim() });
        }
      }
      store.insertBlockWithItems(wall.id, addingTrack, items, width);
    }
    setAddingTrack(null);
    setStackedSkus([]);
  }, [addingTrack, newCategory, newWidth, newSku, stackedSkus, wall.id, store]);

  // ---- 删除 block ----
  const handleDelete = useCallback(
    (blockId: string, mode: 'static' | 'dynamic') => {
      // 找到该 block 的轨道
      const airBlock = wall.airBlocks.find((b) => b.id === blockId);
      const track: TrackSpan = airBlock ? 'air' : 'ground';
      const block = airBlock || wall.groundBlocks.find((b) => b.id === blockId);
      if (!block) return;

      const isDual = block.items.some(
        (item) => item.category === 'tall_cabinet' || item.category === 'tall_appliance',
      );

      if (isDual) {
        const itemId = block.items[0].id;
        store.deleteBothTracks(wall.id, itemId, mode);
      } else {
        store.deleteBlock(wall.id, track, blockId, mode);
      }
    },
    [wall, store],
  );

  // ---- 移除叠放物品 ----
  const handleRemoveStackedItem = useCallback(
    (blockId: string, itemId: string) => {
      store.removeStackedItem(wall.id, blockId, itemId);
    },
    [wall.id, store],
  );

  // ---- 拖拽 ----
  const airTrackRef = useRef<HTMLDivElement>(null);
  const groundTrackRef = useRef<HTMLDivElement>(null);
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragTrack, setDragTrack] = useState<TrackSpan | null>(null);
  const [dragIndicatorX, setDragIndicatorX] = useState<number | null>(null);
  const dragOffsetRef = useRef(0);

  const handleDragStart = useCallback(
    (blockId: string, e: React.MouseEvent) => {
      e.preventDefault();
      const airBlock = wall.airBlocks.find((b) => b.id === blockId);
      const track: TrackSpan = airBlock ? 'air' : 'ground';
      const trackRef = track === 'air' ? airTrackRef : groundTrackRef;
      const trackEl = trackRef.current;
      if (!trackEl) return;

      const trackRect = trackEl.getBoundingClientRect();
      dragOffsetRef.current = e.clientX - trackRect.left;
      setDragBlockId(blockId);
      setDragTrack(track);
      setDragIndicatorX(e.clientX - trackRect.left);
    },
    [wall],
  );

  useEffect(() => {
    if (!dragBlockId || !dragTrack) return;

    const handleMouseMove = (e: MouseEvent) => {
      const trackRef = dragTrack === 'air' ? airTrackRef : groundTrackRef;
      const trackEl = trackRef.current;
      if (!trackEl) return;
      const trackRect = trackEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - trackRect.left, trackRect.width));
      setDragIndicatorX(x);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const trackRef = dragTrack === 'air' ? airTrackRef : groundTrackRef;
      const trackEl = trackRef.current;
      if (trackEl) {
        const trackRect = trackEl.getBoundingClientRect();
        const inchesPerPixel = (wall.width || 1) / (trackRect.width || 1);
        const dropX = Math.max(0, Math.min(e.clientX - trackRect.left, trackRect.width));
        const newDistanceFromLeft = Math.round(dropX * inchesPerPixel);
        store.moveBlock(wall.id, dragTrack, dragBlockId, newDistanceFromLeft);
      }
      setDragBlockId(null);
      setDragTrack(null);
      setDragIndicatorX(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragBlockId, dragTrack, wall.id, wall.width, store]);

  // ---- 位置计算 ----
  const airPositioned = store.computePositions(wall.airBlocks);
  const groundPositioned = store.computePositions(wall.groundBlocks);

  // ---- 暴露面编辑 ----
  const handleExposedChange = useCallback(
    (field: 'exposedLeft' | 'exposedRight' | 'exposedBack') => {
      store.updateWall(wall.id, { [field]: !(wall as any)[field] });
    },
    [wall, store],
  );

  const handleWidthChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const w = parseFloat(e.target.value);
      if (!isNaN(w) && w > 0) {
        store.updateWall(wall.id, { width: w });
      }
    },
    [wall, store],
  );

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      store.updateWall(wall.id, { name: e.target.value });
    },
    [wall, store],
  );

  const handleRemoveWall = useCallback(() => {
    const label = isIsland ? 'island' : 'wall';
    if (confirm(`Delete ${label} "${wall.name}"?`)) {
      store.removeWall(wall.id);
    }
  }, [wall, store, isIsland]);

  // ---- 识别双轨物品（在当前位置有对应块的） ----
  const dualItemIds = new Set<string>();
  for (const block of wall.airBlocks) {
    for (const item of block.items) {
      if (item.category === 'tall_cabinet' || item.category === 'tall_appliance') {
        const hasGround = wall.groundBlocks.some((gb) =>
          gb.items.some((gi) => gi.id === item.id),
        );
        if (hasGround) dualItemIds.add(item.id);
      }
    }
  }

  const isDualBlock = (block: SectionBlock): boolean => {
    return block.items.some((item) => dualItemIds.has(item.id));
  };

  // ---- 渲染轨道 ----
  const renderTrack = (
    track: TrackSpan,
    positioned: { block: SectionBlock; distanceFromLeft: number }[],
    trackRef: React.MutableRefObject<HTMLDivElement | null>,
  ) => {
    const totalWidth = wall.width || 1;
    return (
      <div className="wp-track">
        <div className="wp-track-header">
          <span className="wp-track-label">
            {track === 'air' ? t('空中') : t('地面')}
          </span>
          <button className="wp-add-btn" onClick={() => startAdd(track)}>
            + {t('添加物品')}
          </button>
        </div>

        <div
          className="wp-track-blocks"
          ref={trackRef}
          style={{ position: 'relative' }}
        >
          {positioned.map(({ block, distanceFromLeft }) => {
            const leftPx = (distanceFromLeft / totalWidth) * 100;
            const widthPx = (block.width / totalWidth) * 100;
            return (
              <div
                key={block.id}
                className={`wp-block-wrapper ${dragBlockId === block.id ? 'wp-dragging' : ''}`}
                style={{
                  position: 'absolute',
                  left: `${leftPx}%`,
                  width: `${widthPx}%`,
                  minWidth: '40px',
                }}
              >
                <BlockCard
                  block={block}
                  distanceFromLeft={distanceFromLeft}
                  isDual={isDualBlock(block)}
                  onDragStart={handleDragStart}
                  onDelete={handleDelete}
                  onRemoveStackedItem={handleRemoveStackedItem}
                />
              </div>
            );
          })}
          {/* 拖拽指示线 */}
          {dragTrack === track && dragIndicatorX !== null && (
            <div
              className="wp-drop-indicator"
              style={{ left: `${dragIndicatorX}px` }}
            />
          )}
        </div>

        {/* 添加表单 */}
        {addingTrack === track && (
          <div className="wp-add-form">
            <select
              className="wp-add-select"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as BlockItemCategory)}
            >
              {(track === 'air' ? AIR_CATEGORIES : GROUND_CATEGORIES).map((cat) => (
                <option key={cat} value={cat}>
                  {t(CATEGORY_T_KEY[cat] as TranslationKey)}
                </option>
              ))}
            </select>
            <input
              className="wp-add-input"
              type="number"
              min="0.5"
              step="0.5"
              placeholder={t('宽度')}
              value={newWidth}
              onChange={(e) => setNewWidth(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
              autoFocus
            />
            <input
              className="wp-add-input wp-add-sku"
              placeholder={t('请输入SKU')}
              value={newSku}
              onChange={(e) => setNewSku(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
            />
            {/* 叠放吊柜行 */}
            {isStackableCategory && (
              <div className="wp-stacked-form">
                {stackedSkus.map((sku, i) => (
                  <div key={i} className="wp-stacked-row">
                    <span className="wp-stacked-label">↑</span>
                    <input
                      className="wp-add-input wp-add-sku"
                      placeholder={t('请输入SKU')}
                      value={sku}
                      onChange={(e) => {
                        const next = [...stackedSkus];
                        next[i] = e.target.value;
                        setStackedSkus(next);
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
                    />
                    <button
                      className="wp-add-cancel"
                      onClick={() => setStackedSkus(stackedSkus.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="wp-stacked-add"
                  onClick={() => setStackedSkus([...stackedSkus, ''])}
                >
                  + 叠放吊柜
                </button>
              </div>
            )}
            <button className="wp-add-ok" onClick={confirmAdd}>OK</button>
            <button
              className="wp-add-cancel"
              onClick={() => setAddingTrack(null)}
            >
              X
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`wp-panel ${collapsed ? 'wp-collapsed' : ''}`}>
      {/* 墙头 */}
      <div className="wp-header">
        <button
          className="wp-collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className={`wp-type-badge ${isIsland ? 'wp-island' : 'wp-wall'}`}>
          {isIsland ? t('添加岛台') : t('添加墙面')}
        </span>
        <input
          className="wp-name-input"
          value={wall.name}
          onChange={handleNameChange}
        />
        <label className="wp-field">
          {t('总宽度')}:
          <input
            className="wp-width-input"
            type="number"
            min="1"
            value={wall.width}
            onChange={handleWidthChange}
          />
          {t('英寸')}
        </label>
        <label className="wp-check">
          <input
            type="checkbox"
            checked={(wall as LayoutWall).exposedLeft ?? false}
            onChange={() => handleExposedChange('exposedLeft')}
          />
          {t('左侧暴露')}
        </label>
        <label className="wp-check">
          <input
            type="checkbox"
            checked={(wall as LayoutWall).exposedRight ?? false}
            onChange={() => handleExposedChange('exposedRight')}
          />
          {t('右侧暴露')}
        </label>
        <label className="wp-check">
          <input
            type="checkbox"
            checked={(wall as LayoutWall).exposedBack ?? false}
            onChange={() => handleExposedChange('exposedBack')}
          />
          {t('后侧暴露')}
        </label>
        {/* 连接信息（只读） */}
        {!isIsland && (wall as LayoutWall).connectedWallIds.length > 0 && (
          <span className="wp-connected" title="L-shaped connection (Agent-managed)">
            {t('连接墙面')}: {(wall as LayoutWall).connectedWallIds.length}
          </span>
        )}
        {isIsland && (wall as LayoutIsland).backToBackIslandIds.length > 0 && (
          <span className="wp-connected" title="Back-to-back (Agent-managed)">
            Back-to-back: {(wall as LayoutIsland).backToBackIslandIds.length}
          </span>
        )}
        <button className="wp-remove-btn" onClick={handleRemoveWall}>
          ✕
        </button>
      </div>

      {/* 轨道区 */}
      {!collapsed && (
        <div className="wp-body">
          {renderTrack('air', airPositioned, airTrackRef)}
          {renderTrack('ground', groundPositioned, groundTrackRef)}
        </div>
      )}
    </div>
  );
}
