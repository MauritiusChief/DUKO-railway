/**
 * BlockInfoBar —— 选中块的信息栏（wp-add-form 的平级兄弟）
 *
 * 点击 BlockCard 后在此展示完整信息：分类（只读）、距左（只读，编辑推迟到 Feature 3）、
 * SKU（可编辑）、宽度（可编辑）、叠放物品（增删）。
 * 提供静态/动态删除与关闭按钮。与 wp-add-form 通过状态互斥显示。
 */
import { useState, useCallback } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { useI18n } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import type { LayoutWall, SectionBlock, BlockItemCategory, TrackSpan } from '../types';
import './BlockInfoBar.css';

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
  onRemoveStackedItem: (blockId: string, itemId: string) => void;
  onClose: () => void;
}

export function BlockInfoBar({
  wall,
  track,
  block,
  distanceFromLeft,
  isDual,
  onDelete,
  onRemoveStackedItem,
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
  const [newStackedSku, setNewStackedSku] = useState('');

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

  // ---- 追加叠放 ----
  const handleAddStacked = useCallback(() => {
    const trimmed = newStackedSku.trim();
    if (!trimmed) return;
    store.addStackedItem(wall.id, block.id, trimmed);
    setNewStackedSku('');
  }, [newStackedSku, wall.id, block.id, store]);

  const handleDeleteDynamic = useCallback(() => {
    onDelete(block.id, 'dynamic');
  }, [block.id, onDelete]);

  const handleDeleteStatic = useCallback(() => {
    onDelete(block.id, 'static');
  }, [block.id, onDelete]);

  return (
    <div className="bib-bar">
      {/* 分类（只读） */}
      <span className="bib-category">
        {categoryLabel}
        {isDual && <span className="bib-dual-badge" title={t('双轨联动')}>⇅</span>}
      </span>

      {/* SKU（可编辑） */}
      <label className="bib-field">
        {t('请输入SKU')}
        <input
          className="bib-input bib-sku-input"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          onBlur={commitSku}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>

      {/* 宽度（可编辑） */}
      <label className="bib-field">
        {t('宽度')}
        <input
          className="bib-input bib-width-input"
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
      <span className="bib-readonly">
        {t('距左')}: {distanceFromLeft}{t('英寸')}
      </span>

      {/* 叠放物品管理 */}
      {block.items.length > 1 && (
        <div className="bib-stacked">
          {block.items.slice(1).map((si) => (
            <span key={si.id} className="bib-stacked-item">
              ↑ {si.sku}
              <button
                className="bib-stacked-remove"
                title={t('移除叠放物品')}
                onClick={() => onRemoveStackedItem(block.id, si.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {isStackable && (
        <div className="bib-stacked-add-row">
          <input
            className="bib-input bib-stacked-add-input"
            placeholder={t('请输入SKU')}
            value={newStackedSku}
            onChange={(e) => setNewStackedSku(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddStacked(); }}
          />
          <button className="bib-stacked-add-btn" onClick={handleAddStacked}>
            {t('添加叠放')}
          </button>
        </div>
      )}

      {/* 删除 */}
      <button
        className="bib-delete bib-delete-dynamic"
        title={t('动态删除')}
        onClick={handleDeleteDynamic}
      >
        ✕
      </button>
      {!isGap && (
        <button
          className="bib-delete bib-delete-static"
          title={t('静态删除')}
          onClick={handleDeleteStatic}
        >
          ⊘
        </button>
      )}

      {/* 关闭信息栏 */}
      <button className="bib-close" title={t('关闭')} onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
