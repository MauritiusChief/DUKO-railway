export const TARGET = __ODOO_TARGET__;

/** 按路径段匹配，避免 sales-other 等页面被误识别。 */
export function isTargetPage(location: Pick<Location, 'origin' | 'pathname'> = window.location): boolean {
  return location.origin === 'https://dukouserp.com'
    && (location.pathname === TARGET.path || location.pathname.startsWith(`${TARGET.path}/`));
}

export function assertTargetPage(): void {
  if (!isTargetPage()) {
    throw new Error(`当前页面不属于 ${TARGET.path}，请打开对应页面后刷新`);
  }
}
