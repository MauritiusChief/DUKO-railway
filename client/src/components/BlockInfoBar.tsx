/**
 * BlockInfoBar —— 选中块的信息栏（wp-add-form 的平级兄弟）
 *
 * 点击 BlockCard 后在此展示完整信息：分类（只读）、距左（只读，编辑推迟到 Feature 3）、
 * SKU（可编辑）、宽度（可编辑）、叠放物品（增删，通过 StackedItemsEditor）。
 * 提供静态/动态删除与关闭按钮。与 wp-add-form 通过状态互斥显示。
 * 样式复用 panelForm.css（pf- 前缀），与 wp-add-form 视觉一致。
 */
import { useState, useCallback, useEffect } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { useTableParseStore } from '../stores/tableParseStore';
import { useI18n } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import type { LayoutWall, SectionBlock, BlockItemCategory, TrackSpan } from '../types';
import { StackedItemsEditor } from './StackedItemsEditor';
import './panelForm.css';

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

interface BlockInfoBarProps {
  wall: LayoutWall;
  track: TrackSpan;
  block: SectionBlock;
  /** 实时计算的距左距离（英寸） */
  distanceFromLeft: number;
  isDual: boolean;
  onDelete: (blockId: string, mode: 'static' | 'dynamic') => void;
  onClose: () => void;
}

export function BlockInfoBar({
  wall,
  track,
  block,
  distanceFromLeft,
  isDual,
  onDelete,
  onClose,
}: BlockInfoBarProps) {
  const { t } = useI18n();
  const store = useLayoutStore();
  const { availableColors, fetchColors } = useTableParseStore();

  useEffect(() => {
    fetchColors();
  }, [fetchColors]);

  const mainItem = block.items[0];
  const isGap = mainItem?.category === 'gap';
  const categoryLabel = mainItem ? t(CATEGORY_T_KEY[mainItem.category] as TranslationKey) : '?';

  // 叠放仅 air 轨且主物品可叠放时有意义
  const isStackable =
    track === 'air'
    && !isGap
    && (mainItem?.category === 'wall_cabinet'
      || mainItem?.category === 'tall_cabinet'
      || mainItem?.category === 'tall_appliance');

  // ---- 本地输入态（commit on blur / Enter） ----
  const [sku, setSku] = useState(mainItem?.sku || '');
  const [width, setWidth] = useState(String(block.width));
  const [height, setHeight] = useState(mainItem?.height != null ? String(mainItem.height) : '');
  const [pos, setPos] = useState(String(distanceFromLeft));

  // ---- SKU 提交 ----
  const commitSku = useCallback(() => {
    if (!mainItem) return;
    const trimmed = sku.trim();
    if (trimmed && trimmed !== mainItem.sku) {
      store.updateItemSku(wall.id, mainItem.id, trimmed);
    } else if (!trimmed) {
      // 空值回退为原值
      setSku(mainItem.sku || '');
    }
  }, [mainItem, sku, wall.id, store]);

  // ---- 宽度提交 ----
  const commitWidth = useCallback(() => {
    const w = parseFloat(width);
    if (!isNaN(w) && w > 0 && w !== block.width) {
      if (isDual) {
        store.updateBlockWidthBothTracks(wall.id, mainItem.id, w);
      } else {
        store.updateBlockWidth(wall.id, track, block.id, w);
      }
    } else if (isNaN(w) || w <= 0) {
      // 非法值回退
      setWidth(String(block.width));
    }
  }, [width, block.width, block.id, isDual, mainItem, wall.id, track, store]);

  // ---- 高度提交 ----
  const heightRelevant =
    mainItem?.category === 'wall_cabinet' ||
    mainItem?.category === 'tall_cabinet' ||
    mainItem?.category === 'tall_appliance';
  const commitHeight = useCallback(() => {
    if (!mainItem) return;
    const h = parseFloat(height);
    if (!isNaN(h) && h > 0 && h !== (mainItem.height || 0)) {
      store.updateItemHeight(wall.id, mainItem.id, h);
    } else if (isNaN(h) || h <= 0) {
      setHeight(mainItem.height != null ? String(mainItem.height) : '');
    }
  }, [height, mainItem, wall.id, store]);

  // ---- 距左提交（推挤算法） ----
  const commitPos = useCallback(() => {
    const p = parseFloat(pos);
    if (!isNaN(p) && p >= 0 && p !== distanceFromLeft) {
      store.setBlockPosition(wall.id, track, block.id, p);
    } else if (isNaN(p) || p < 0) {
      setPos(String(distanceFromLeft));
    }
  }, [pos, distanceFromLeft, wall.id, track, block.id, store]);

  // ---- isVanity 编辑 ----
  const handleVanityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (mainItem) {
        store.updateItemVanity(wall.id, mainItem.id, e.target.checked);
      }
    },
    [mainItem, wall.id, store],
  );

  // ---- 颜色编辑 ----
  const handleColorChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (isDual && mainItem) {
        store.updateBlockColorBothTracks(wall.id, mainItem.id, e.target.value);
      } else {
        store.updateBlockColor(wall.id, track, block.id, e.target.value);
      }
    },
    [wall.id, track, block.id, isDual, mainItem, store],
  );

  // ---- 叠放物品增删（交由 StackedItemsEditor 回调） ----
  const handleAddStacked = useCallback((skuVal: string, h?: number) => {
    store.addStackedItem(wall.id, block.id, skuVal, h);
  }, [wall.id, block.id, store]);

  const handleRemoveStacked = useCallback((itemId: string) => {
    store.removeStackedItem(wall.id, block.id, itemId);
  }, [wall.id, block.id, store]);

  const handleDeleteDynamic = useCallback(() => {
    onDelete(block.id, 'dynamic');
  }, [block.id, onDelete]);

  const handleDeleteStatic = useCallback(() => {
    onDelete(block.id, 'static');
  }, [block.id, onDelete]);

  // 叠放物品映射为 StackedItemRef
  const stackedItems = block.items.slice(1).map((it) => ({ id: it.id, sku: it.sku, height: it.height }));

  return (
    <div className="pf-bar">
      {/* 第1行：信息字段（分类 / 宽度 / SKU / 距左） */}
      <div className="pf-row">
        <span className="pf-category">
          {categoryLabel}
          {isDual && <span className="pf-dual-badge" title={t('双轨联动')}>⇅</span>}
        </span>

        <label className="pf-field">
          <input
            className="pf-input pf-width-input"
            type="number"
            min="0.5"
            step="0.5"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            onBlur={commitWidth}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </label>

        {heightRelevant && (
          <label className="pf-field">
            <input
              className="pf-input pf-height-input"
              type="number"
              min="0.5"
              step="0.5"
              placeholder={t('高度')}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              onBlur={commitHeight}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        )}

        <label className="pf-field">
          <input
            className="pf-input pf-sku-input"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            onBlur={commitSku}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </label>

        {/* 距左位置编辑（gap 块保持只读） */}
        {isGap ? (
          <span className="pf-readonly">
            {t('距左')}: {distanceFromLeft}{t('英寸')}
          </span>
        ) : (
          <label className="pf-field">
            {t('距左')}
            <input
              className="pf-input pf-width-input"
              type="number"
              min="0"
              step="0.5"
              value={pos}
              onChange={(e) => setPos(e.target.value)}
              onBlur={commitPos}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            {t('英寸')}
          </label>
        )}
        <select
          className="pf-select"
          value={block.colorCode || ''}
          onChange={handleColorChange}
          style={{ marginLeft: 'auto' }}
        >
          <option value="">{t('无颜色')}</option>
          {availableColors.map((c) => (
            <option key={c.code} value={c.code}>
              [{c.code}] {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* 第2行：叠放物品管理（无叠放且不可叠放时 StackedItemsEditor 返回 null） */}
      <StackedItemsEditor
        items={stackedItems}
        onAdd={handleAddStacked}
        onRemove={handleRemoveStacked}
        canAdd={isStackable}
      />

      {/* ground 轨 base_cabinet 的 isVanity 编辑 */}
      {mainItem?.category === 'base_cabinet' && track === 'ground' && (
        <div className="pf-row">
          <label className="pf-field">
            <input
              type="checkbox"
              checked={!!mainItem.isVanity}
              onChange={handleVanityChange}
            />
            {t('浴室柜')}
          </label>
        </div>
      )}

      {/* 第3行：操作按钮（删除 + 关闭） */}
      <div className="pf-row">
        <button
          className="pf-btn-delete pf-btn-delete-dynamic"
          title={t('动态删除')}
          onClick={handleDeleteDynamic}
        >
          ✕
        </button>
        {!isGap && (
          <button
            className="pf-btn-delete pf-btn-delete-static"
            title={t('静态删除')}
            onClick={handleDeleteStatic}
          >
            ⊘
          </button>
        )}
        <button className="pf-btn-close" title={t('关闭')} onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
