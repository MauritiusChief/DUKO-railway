/**
 * SegSwitch —— 通用分段切换组件
 *
 * 适用于在两个或多个互斥选项之间切换，例如语言切换（中文 | English）、
 * 输入模式切换（文本 | 图片）等。样式由 index.css 中的 .seg-* 规则提供。
 */
import { Fragment, type ReactNode } from 'react';
import './SegSwitch.css';

/** 单个选项定义 */
export interface SegSwitchOption<T extends string> {
  /** 选项值 */
  value: T;
  /** 选项展示文案 */
  label: ReactNode;
}

interface SegSwitchProps<T extends string> {
  /** 可选项列表 */
  options: SegSwitchOption<T>[];
  /** 当前激活值 */
  value: T;
  /** 值变更回调 */
  onChange: (value: T) => void;
  /** 是否整体禁用 */
  disabled?: boolean;
}

export function SegSwitch<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: SegSwitchProps<T>) {
  return (
    <span className="seg-switch">
      {options.map((opt, i) => (
        <Fragment key={opt.value}>
          {/* 选项之间的分隔符 */}
          {i > 0 && <span className="seg-sep">|</span>}
          <button
            type="button"
            className={`seg-btn${value === opt.value ? ' seg-active' : ''}`}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
          >
            {opt.label}
          </button>
        </Fragment>
      ))}
    </span>
  );
}
