// ScriptCat 用户脚本入口
// 在 Odoo quotation 页面自动注入浮动面板

import { initPanel } from './panel';

(function main() {
  console.log(`DUKO Quote Filler ${__BUILD_TS__}`);
  const url = window.location.href;

  // 仅在 Odoo quotation 相关页面激活（含 sales/new, sales/xxx 等）
  if (!url.includes('dukouserp.com/odoo')) return;

  // 等待页面基本加载完成再注入面板（给 Odoo 框架渲染留时间）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initPanel());
  } else {
    // DOM 已就绪，延迟一下确保 Odoo 框架渲染完毕
    setTimeout(initPanel, 1000);
  }
})();
