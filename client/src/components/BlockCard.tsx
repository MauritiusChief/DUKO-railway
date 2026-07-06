/**
 * BlockCard —— 单个橱柜/物品卡片的渲染组件
 *
 * 显示 category 标签、宽度、SKU、距左位置。
 * 支持拖拽（通过 dragHandle 触发 mousedown），拖拽时外部 WallPanel 处理。
 * 支持删除（弹出选择 static/dynamic 模式，全高物品自动联动删除）。
 */
import { useCallback } from 'react';
import { useI18n } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import type { SectionBlock, BlockItemCategory } from '../types';
import './BlockCard.css';

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

interface BlockCardProps {
  block: SectionBlock;
  distanceFromLeft: number;
  isDual: boolean;
  onDragStart: (blockId: string, e: React.MouseEvent) => void;
  onDelete: (blockId: string, mode: 'static' | 'dynamic') => void;
  onRemoveStackedItem?: (blockId: string, itemId: string) => void;
}

export function BlockCard({ block, distanceFromLeft, isDual, onDragStart, onDelete, onRemoveStackedItem }: BlockCardProps) {
  const { t } = useI18n();
  const item = block.items[0];
  const isGap = item?.category === 'gap';
  const categoryLabel = item ? t(CATEGORY_T_KEY[item.category] as TranslationKey) : '?';

  const handleDeleteClick = useCallback(() => {
    onDelete(block.id, 'dynamic');
  }, [block.id, onDelete]);

  const handleDeleteStatic = useCallback(() => {
    onDelete(block.id, 'static');
  }, [block.id, onDelete]);

  return (
    <div className={`bc-card ${isGap ? 'bc-gap' : ''} ${isDual ? 'bc-dual' : ''}`}>
      {/* 拖拽手柄 */}
      <div
        className="bc-drag-handle"
        title={t('拖拽提示')}
        onMouseDown={(e) => onDragStart(block.id, e)}
      >
        ⠿
      </div>

      {/* 主体信息 */}
      <div className="bc-body">
        <div className="bc-top-row">
          <span className={`bc-category ${isGap ? 'bc-cat-gap' : ''}`}>
            {categoryLabel}
            {isDual && <span className="bc-dual-badge">⇅</span>}
          </span>
          <span className="bc-width">{block.width}{t('英寸')}</span>
        </div>
        <div className="bc-bottom-row">
          <span className="bc-sku">{item?.sku || '-'}</span>
          <span className="bc-pos">{t('距左')}: {distanceFromLeft}{t('英寸')}</span>
        </div>
        {block.items.length > 1 && (
          <div className="bc-stacked">
            {block.items.slice(1).map((si) => (
              <span key={si.id} className="bc-stacked-item">
                + {t((CATEGORY_T_KEY[si.category] || si.category) as TranslationKey)}: {si.sku}
                {onRemoveStackedItem && (
                  <button
                    className="bc-stacked-remove"
                    onClick={(e) => { e.stopPropagation(); onRemoveStackedItem(block.id, si.id); }}
                    title={t('移除叠放物品')}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 删除按钮 */}
      <div className="bc-actions">
        <button
          className="bc-delete-btn"
          title={t('动态删除')}
          onClick={handleDeleteClick}
        >
          ✕
        </button>
        {!isGap && (
          <button
            className="bc-delete-btn bc-delete-static"
            title={t('静态删除')}
            onClick={handleDeleteStatic}
          >
            ⊘
          </button>
        )}
      </div>
    </div>
  );
}
