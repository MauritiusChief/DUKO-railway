/**
 * StackedItemsEditor —— 叠放吊柜的 chips + 添加输入框（BlockInfoBar 与 wp-add-form 共用）
 *
 * 显示已有叠放物品为 chip（↑ SKU ×），并提供一个输入框用于追加。
 * 组件内部管理添加输入框的本地状态；新增/移除通过 onAdd/onRemove 回调交由调用方处理。
 * 当无叠放物品且 canAdd 为 false 时返回 null（整行不渲染）。
 */
import { useState, useCallback } from 'react';
import { useI18n } from '../i18n/context';
import './panelForm.css';

/** 叠放物品的最小数据结构（仅需 id 与 sku） */
export interface StackedItemRef {
  id: string;
  sku: string;
}

interface StackedItemsEditorProps {
  items: StackedItemRef[];
  onAdd: (sku: string) => void;
  onRemove: (id: string) => void;
  /** 是否显示添加输入框 */
  canAdd: boolean;
}

export function StackedItemsEditor({ items, onAdd, onRemove, canAdd }: StackedItemsEditorProps) {
  const { t } = useI18n();
  const [input, setInput] = useState('');

  const handleAdd = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setInput('');
  }, [input, onAdd]);

  // 无叠放物品且不可添加时整行不渲染
  if (items.length === 0 && !canAdd) return null;

  return (
    <div className="pf-row pf-row-stacked">
      {items.length > 0 && (
        <div className="pf-stacked">
          {items.map((it) => (
            <span key={it.id} className="pf-stacked-item">
              ↑ {it.sku}
              <button
                className="pf-stacked-remove"
                title={t('移除叠放物品')}
                onClick={() => onRemove(it.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {canAdd && (
        <div className="pf-stacked-add">
          <input
            className="pf-input pf-stacked-add-input"
            placeholder={t('请输入SKU')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          />
          <button className="pf-stacked-add-btn" onClick={handleAdd}>
            {t('添加叠放')}
          </button>
        </div>
      )}
    </div>
  );
}
