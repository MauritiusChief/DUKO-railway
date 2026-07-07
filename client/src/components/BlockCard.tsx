/**
 * BlockCard —— 单个橱柜/物品卡片的渲染组件（精简版）
 *
 * 仅显示 SKU（独占下半部分）与拖拽手柄/叠放徽标（上半部分）。
 * 点击卡片选中后在 WallPanel 的 BlockInfoBar 中展示完整信息并支持编辑/删除。
 * 支持拖拽（通过 dragHandle 触发 mousedown），拖拽时外部 WallPanel 处理。
 */
import { useCallback } from 'react';
import { useI18n } from '../i18n/context';
import type { SectionBlock, TrackSpan } from '../types';
import './BlockCard.css';

interface BlockCardProps {
  block: SectionBlock;
  /** 所属轨道，点击选中时回传 */
  track: TrackSpan;
  /** 是否为双轨联动块（高柜/通天电器） */
  isDual: boolean;
  isSelected: boolean;
  onDragStart: (blockId: string, e: React.MouseEvent) => void;
  onSelect: (blockId: string, track: TrackSpan) => void;
}

export function BlockCard({ block, track, isDual, isSelected, onDragStart, onSelect }: BlockCardProps) {
  const { t } = useI18n();
  const item = block.items[0];
  const isGap = item?.category === 'gap';

  // 点击卡片主体 → 选中（手柄 mousedown 会 stopPropagation，不会误触发）
  const handleCardClick = useCallback(() => {
    onSelect(block.id, track);
  }, [block.id, track, onSelect]);

  // 手柄按下 → 启动拖拽，阻止冒泡以免触发选中
  const handleDragHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDragStart(block.id, e);
    },
    [block.id, onDragStart],
  );

  const skuText = isGap ? t('空挡') : (item?.sku || '-');

  return (
    <div
      className={`bc-card ${isGap ? 'bc-gap' : ''} ${isDual ? 'bc-dual' : ''} ${isSelected ? 'bc-selected' : ''}`}
      onClick={handleCardClick}
      title={skuText}
    >
      {/* 上半：拖拽手柄 + 叠放/双轨指示 */}
      <div className="bc-top">
        <div
          className="bc-drag-handle"
          title={t('拖拽提示')}
          onMouseDown={handleDragHandleMouseDown}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </div>
        {isDual && <span className="bc-dual-badge" title={t('双轨联动')}>⇅</span>}
        {block.items.length > 1 && (
          <span className="bc-stack-badge" title={t('叠放提示', { n: block.items.length - 1 })}>
            {block.items.length - 1}↑
          </span>
        )}
      </div>

      {/* 下半：SKU 独占整行，溢出截断 */}
      <div className="bc-sku">
        {'·'+skuText}
      </div>
    </div>
  );
}
