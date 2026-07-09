/**
 * WallPanel —— 单面墙的可折叠面板（统一定义，岛台视为特殊墙面）
 *
 * 展示墙头信息（名称、总宽、暴露面）、空中 + 地面两个轨道。
 * 每轨渲染 BlockCard 列表（仅显示 SKU），点击块后在 wp-add-form 平级位置
 * 展示 BlockInfoBar 信息栏（编辑 SKU/宽度/叠放、删除），与添加表单互斥。
 * 支持拖拽改序（吸附到块间隙）、添加物品。拖拽时通过 mouse 事件计算最近间隙，调用 store.reorderBlock。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { useTableParseStore } from '../stores/tableParseStore';
import { useI18n } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import { BlockCard } from './BlockCard';
import { BlockInfoBar } from './BlockInfoBar';
import { StackedItemsEditor, type StackedItemRef } from './StackedItemsEditor';
import type {
  LayoutWall,
  SectionBlock,
  BlockItem,
  BlockItemCategory,
  TrackSpan,
} from '../types';
import './WallPanel.css';
import './panelForm.css';

interface WallPanelProps {
  wall: LayoutWall;
}

/** 每英寸对应的像素参考值 */
const PX_PER_INCH = 6;

const RULER_INTERVALS = [30, 15, 9, 6, 3];

/**
 * 计算给定的墙宽度使用哪个标尺 intervel
 * @param wallWidth
 * @returns
 */
function pickRulerInterval(wallWidth: number): number {
  for (const iv of RULER_INTERVALS) {
    let marks = 0;
    for (let k = 1; k * iv < wallWidth; k++) marks++;
    if (marks >= 3) return iv;
  }
  return 3;
}

/** 空中轨道可用物品分类 */
const AIR_CATEGORIES: BlockItemCategory[] = [
  'wall_cabinet', 'tall_cabinet', 'gap', 'stuffed_gap', 'gaplike_item', 'filler', 'tall_appliance',
];

/** 地面轨道可用物品分类 */
const GROUND_CATEGORIES: BlockItemCategory[] = [
  'base_cabinet', 'tall_cabinet', 'gap', 'stuffed_gap', 'gaplike_item', 'filler', 'tall_appliance',
  'base_appliance_need_top', 'base_appliance_without_top',
];

/** 无需颜色信息的分类 */
const NO_COLOR_CATEGORIES: ReadonlySet<BlockItemCategory> = new Set([
  'gap', 'stuffed_gap',
  'tall_appliance', 'base_appliance_need_top', 'base_appliance_without_top',
]);

const CATEGORY_T_KEY: Record<BlockItemCategory, string> = {
  wall_cabinet: '吊柜',
  base_cabinet: '地柜',
  tall_cabinet: '高柜',
  gap: '空挡',
  stuffed_gap: '近似空挡',
  gaplike_item: '装饰性商品',
  filler: '填充条',
  tall_appliance: '高电器',
  base_appliance_need_top: '需台面电器',
  base_appliance_without_top: '免台面电器',
};

export function WallPanel({ wall }: WallPanelProps) {
  const { t } = useI18n();
  const store = useLayoutStore();
  const { availableColors, fetchColors } = useTableParseStore();

  // ---- 折叠 ----
  const [collapsed, setCollapsed] = useState(false);

  // 加载颜色列表（缓存，仅首次触发请求）
  useEffect(() => {
    fetchColors();
  }, [fetchColors]);

  // ---- 添加物品表单 ----
  const [addingTrack, setAddingTrack] = useState<TrackSpan | null>(null);
  const [newCategory, setNewCategory] = useState<BlockItemCategory>('wall_cabinet');
  const [newWidth, setNewWidth] = useState('');
  const [newHeight, setNewHeight] = useState('');
  const [newSku, setNewSku] = useState('');
  const [stackedItems, setStackedItems] = useState<StackedItemRef[]>([]);
  const [newIsVanity, setNewIsVanity] = useState(false);
  const [newColorCode, setNewColorCode] = useState('');

  // ---- 选中块（信息栏）---- 与 addingTrack 互斥
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<TrackSpan | null>(null);

  /** 是否需要叠放吊柜的行 */
  const isStackableCategory =
    newCategory === 'wall_cabinet' || newCategory === 'tall_cabinet' || newCategory === 'tall_appliance';

  /** 选中某个块：显示信息栏，同时取消添加表单 */
  const handleSelectBlock = useCallback((blockId: string, track: TrackSpan) => {
    setSelectedBlockId(blockId);
    setSelectedTrack(track);
    setAddingTrack(null);
  }, []);

  /** 关闭信息栏 */
  const handleCloseInfoBar = useCallback(() => {
    setSelectedBlockId(null);
    setSelectedTrack(null);
  }, []);

  const startAdd = useCallback((track: TrackSpan) => {
    setAddingTrack(track);
    // 显示添加表单时自动取消信息栏
    setSelectedBlockId(null);
    setSelectedTrack(null);
    const categories = track === 'air' ? AIR_CATEGORIES : GROUND_CATEGORIES;
    setNewCategory(categories[0]);
    setNewWidth('');
    setNewHeight('');
    setNewSku('');
    setStackedItems([]);
    setNewIsVanity(false);
    setNewColorCode('');
  }, []);

  const confirmAdd = useCallback(() => {
    if (!addingTrack || !newWidth.trim()) return;
    const width = parseFloat(newWidth);
    if (isNaN(width) || width <= 0) return;
    const primarySku = newSku.trim() || newCategory;
    const h = parseFloat(newHeight);
    const hasHeight = !isNaN(h) && h > 0;
    const heightRelevant =
      newCategory === 'wall_cabinet' || newCategory === 'tall_cabinet' || newCategory === 'tall_appliance';
    const stacked: Omit<BlockItem, 'id'>[] = stackedItems
      .filter((it) => it.sku.trim())
      .map((it) => {
        const item: Omit<BlockItem, 'id'> = { category: 'wall_cabinet' as const, sku: it.sku.trim() };
        if (it.height != null && it.height > 0) item.height = it.height;
        return item;
      });
    const cc = newColorCode.trim() || undefined;

    if (newCategory === 'tall_cabinet' || newCategory === 'tall_appliance') {
      store.insertBothTracksWithItems(
        wall.id,
        { category: newCategory, sku: primarySku, ...(hasHeight && heightRelevant ? { height: h } : {}) },
        stacked,
        width,
        cc,
      );
    } else {
      const items: Omit<BlockItem, 'id'>[] = [
        { category: newCategory, sku: primarySku, isVanity: newIsVanity || undefined, ...(hasHeight && heightRelevant ? { height: h } : {}) },
      ];
      for (const it of stackedItems) {
        if (it.sku.trim()) {
          const item: Omit<BlockItem, 'id'> = { category: 'wall_cabinet', sku: it.sku.trim() };
          if (it.height != null && it.height > 0) item.height = it.height;
          items.push(item);
        }
      }
      store.insertBlockWithItems(wall.id, addingTrack, items, width, cc);
    }
    setAddingTrack(null);
    setStackedItems([]);
    setNewIsVanity(false);
    setNewColorCode('');
  }, [addingTrack, newCategory, newWidth, newHeight, newSku, newIsVanity, newColorCode, stackedItems, wall.id, store]);

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
      // 删除后关闭信息栏
      setSelectedBlockId(null);
      setSelectedTrack(null);
    },
    [wall, store],
  );

  // ---- 拖拽 ----
  const airTrackRef = useRef<HTMLDivElement>(null);
  const groundTrackRef = useRef<HTMLDivElement>(null);
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragTrack, setDragTrack] = useState<TrackSpan | null>(null);
  const [dragIndicatorX, setDragIndicatorX] = useState<number | null>(null);
  const dragOffsetRef = useRef(0);

  // 供拖拽 effect 闭包访问 positioned 数据，在 render 中 .current 更新
  const airPositionedRef = useRef<{ block: SectionBlock; distanceFromLeft: number }[]>([]);
  const groundPositionedRef = useRef<{ block: SectionBlock; distanceFromLeft: number }[]>([]);

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

      // 吸附到最近间隙：计算所有边界像素位置
      const positioned = dragTrack === 'air' ? airPositionedRef.current : groundPositionedRef.current;
      const boundaries: number[] = [0];
      let cumulative = 0;
      for (const p of positioned) {
        cumulative += p.block.width;
        boundaries.push(cumulative);
      }

      let nearestPx = 0;
      let nearestDist = Infinity;
      for (const boundary of boundaries) {
        const boundaryPx = (boundary / (wall.width || 1)) * trackRect.width;
        const dist = Math.abs(x - boundaryPx);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPx = boundaryPx;
        }
      }
      setDragIndicatorX(nearestPx);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const trackRef = dragTrack === 'air' ? airTrackRef : groundTrackRef;
      const trackEl = trackRef.current;
      if (trackEl) {
        const trackRect = trackEl.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - trackRect.left, trackRect.width));

        // 同 handleMouseMove 计算最近边界索引作为 toIndex
        const positioned = dragTrack === 'air' ? airPositionedRef.current : groundPositionedRef.current;
        const boundaries: number[] = [0];
        let cumulative = 0;
        for (const p of positioned) {
          cumulative += p.block.width;
          boundaries.push(cumulative);
        }

        let nearestBoundaryIndex = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < boundaries.length; i++) {
          const boundaryPx = (boundaries[i] / (wall.width || 1)) * trackRect.width;
          const dist = Math.abs(x - boundaryPx);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestBoundaryIndex = i;
          }
        }

        store.reorderBlock(wall.id, dragTrack, dragBlockId, nearestBoundaryIndex);
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
  airPositionedRef.current = airPositioned;
  groundPositionedRef.current = groundPositioned;

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
    if (confirm(t('删除墙面确认', { name: wall.name }))) {
      store.removeWall(wall.id);
    }
  }, [wall, store, t]);

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
    const rulerInterval = pickRulerInterval(totalWidth);
    const rulerMarks: number[] = [];
    for (let k = 1; k * rulerInterval < totalWidth; k++) {
      rulerMarks.push(k * rulerInterval);
    }
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
                }}
              >
                <BlockCard
                  block={block}
                  track={track}
                  isDual={isDualBlock(block)}
                  isSelected={selectedBlockId === block.id}
                  onDragStart={handleDragStart}
                  onSelect={handleSelectBlock}
                />
              </div>
            );
          })}
          {/* 动态布置标尺线 */}
          {rulerMarks.map((pos) => (
            <div
              key={`ruler-${pos}`}
              className="wp-ruler-mark"
              style={{ left: `${(pos / totalWidth) * 100}%` }}
            >
              <span className="wp-ruler-label">{pos}{t('英寸')}</span>
            </div>
          ))}
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
          <div className="pf-bar">
            {/* 第1行：分类 / 宽度 / SKU */}
            <div className="pf-row">
              <select
                className="pf-select"
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
                className="pf-input pf-width-input"
                type="number"
                min="0.5"
                step="0.5"
                placeholder={t('宽度')}
                value={newWidth}
                onChange={(e) => setNewWidth(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
                autoFocus
              />
              {isStackableCategory && (
                <input
                  className="pf-input pf-height-input"
                  type="number"
                  min="0.5"
                  step="0.5"
                  placeholder={t('高度')}
                  value={newHeight}
                  onChange={(e) => setNewHeight(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
                />
              )}
              <input
                className="pf-input pf-sku-input"
                placeholder={t('请输入SKU')}
                value={newSku}
                onChange={(e) => setNewSku(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
              />
              {!NO_COLOR_CATEGORIES.has(newCategory) && (
              <select
                className="pf-select"
                value={newColorCode}
                onChange={(e) => setNewColorCode(e.target.value)}
                style={{ marginLeft: 'auto' }}
              >
                <option value="">{t('无颜色')}</option>
                {availableColors.map((c) => (
                  <option key={c.code} value={c.code}>
                    [{c.code}] {c.name}
                  </option>
                ))}
              </select>
              )}
            </div>

            {/* 第2行：叠放吊柜（条件渲染，chips + 添加输入框） */}
            {isStackableCategory && (
              <StackedItemsEditor
                items={stackedItems}
                onAdd={(sku, height) => setStackedItems([...stackedItems, { id: crypto.randomUUID(), sku, height }])}
                onRemove={(id) => setStackedItems(stackedItems.filter((it) => it.id !== id))}
                canAdd
              />
            )}

            {/* Vanity Cabinet 选项（仅地面轨 + 地柜） */}
            {track === 'ground' && newCategory === 'base_cabinet' && (
              <div className="pf-row">
                <label className="pf-field">
                  <input
                    type="checkbox"
                    checked={newIsVanity}
                    onChange={(e) => setNewIsVanity(e.target.checked)}
                  />
                  {t('浴室柜')}
                </label>
              </div>
            )}

            {/* 第3行：确定 / 取消 */}
            <div className="pf-row">
              <button className="pf-btn-ok" onClick={confirmAdd}>✓</button>
              <button
                className="pf-btn-close"
                onClick={() => setAddingTrack(null)}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* 选中块信息栏（与添加表单互斥） */}
        {selectedTrack === track && selectedBlockId && (() => {
          const selected = positioned.find((p) => p.block.id === selectedBlockId);
          if (!selected) return null;
          return (
            <BlockInfoBar
              key={selected.block.id}
              wall={wall}
              track={track}
              block={selected.block}
              distanceFromLeft={selected.distanceFromLeft}
              isDual={isDualBlock(selected.block)}
              onDelete={handleDelete}
              onClose={handleCloseInfoBar}
            />
          );
        })()}
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
        <span className="wp-type-badge wp-wall">
          {t('墙面岛台')}
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
            checked={wall.exposedLeft}
            onChange={() => handleExposedChange('exposedLeft')}
          />
          {t('左侧暴露')}
        </label>
        <label className="wp-check">
          <input
            type="checkbox"
            checked={wall.exposedRight}
            onChange={() => handleExposedChange('exposedRight')}
          />
          {t('右侧暴露')}
        </label>
        <label className="wp-check">
          <input
            type="checkbox"
            checked={wall.exposedBack}
            onChange={() => handleExposedChange('exposedBack')}
          />
          {t('后侧暴露')}
        </label>
        {/* 连接信息（只读，由 Agent 管理） */}
        {wall.connectedWallIds.length > 0 && (
          <span className="wp-connected" title={t('L形连接提示')}>
            {t('连接墙面')}: {wall.connectedWallIds.length}
          </span>
        )}
        {wall.backToBackIslandIds.length > 0 && (
          <span className="wp-connected" title={t('背靠背连接提示')}>
            {t('背靠背')}: {wall.backToBackIslandIds.length}
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
