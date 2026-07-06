/**
 * BlockInfoBar —— 选中块的信息栏（wp-add-form 的平级兄弟）
 *
 * 点击 BlockCard 后在此展示完整信息：分类（只读）、距左（只读，编辑推迟到 Feature 3）、
 * SKU（可编辑）、宽度（可编辑）、叠放物品（增删，通过 StackedItemsEditor）。
 * 提供静态/动态删除与关闭按钮。与 wp-add-form 通过状态互斥显示。
 * 样式复用 panelForm.css（pf- 前缀），与 wp-add-form 视觉一致。
 */
import { useState, useCallback } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
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

  // ---- 叠放物品增删（交由 StackedItemsEditor 回调） ----
  const handleAddStacked = useCallback((skuVal: string) => {
    store.addStackedItem(wall.id, block.id, skuVal);
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
  const stackedItems = block.items.slice(1).map((it) => ({ id: it.id, sku: it.sku }));

  return (
    <div className="pf-bar">
      {/* 第1行：信息字段（分类 / SKU / 宽度 / 距左） */}
      <div className="pf-row">
        <span className="pf-category">
          {categoryLabel}
          {isDual && <span className="pf-dual-badge" title={t('双轨联动')}>⇅</span>}
        </span>

        <label className="pf-field">
          {t('请输入SKU')}
          <input
            className="pf-input pf-sku-input"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            onBlur={commitSku}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </label>

        <label className="pf-field">
          {t('宽度')}
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
          {t('英寸')}
        </label>

        {/* 距左（只读，编辑推迟到 Feature 3） */}
        <span className="pf-readonly">
          {t('距左')}: {distanceFromLeft}{t('英寸')}
        </span>
      </div>

      {/* 第2行：叠放物品管理（无叠放且不可叠放时 StackedItemsEditor 返回 null） */}
      <StackedItemsEditor
        items={stackedItems}
        onAdd={handleAddStacked}
        onRemove={handleRemoveStacked}
        canAdd={isStackable}
      />

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
