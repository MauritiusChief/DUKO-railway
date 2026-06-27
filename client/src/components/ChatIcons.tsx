/**
 * ChatIcons —— ChatPanel 中使用的内联 SVG 图标
 *
 * 作为独立组件引入，避免 ChatPanel.tsx 中嵌入长 SVG 代码。
 */

/** parse_start 消息中"颜色"行前的调色板图标 */
export function PaletteIcon() {
  return (
    <svg className="tp-parse-start-icon" viewBox="0 0 24 24" width="14" height="14"
         fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-9.5 13.5c.5 1 1.5 1.5 2.5 1.5h14c1 0 2-.5 2.5-1.5A10 10 0 0 0 12 2z"/>
      <circle cx="8.5" cy="11" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="15.5" cy="11" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  );
}

/** parse_start 消息中"行数"行前的表格图标 */
export function TableIcon() {
  return (
    <svg className="tp-parse-start-icon" viewBox="0 0 24 24" width="14" height="14"
         fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="3" y1="15" x2="21" y2="15"/>
      <line x1="9" y1="3" x2="9" y2="21"/>
    </svg>
  );
}
