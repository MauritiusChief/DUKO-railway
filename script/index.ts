// ScriptCat 用户脚本入口
// 在 Odoo quotation 页面自动注入浮动面板

import { initPanel } from './panel';
import { TARGET, isTargetPage } from './target';

(function main() {
  console.log(`${TARGET.name} ${__BUILD_TS__}`);
  if (!isTargetPage()) return;

  // 等待页面基本加载完成再注入面板（给 Odoo 框架渲染留时间）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initPanel());
  } else {
    // DOM 已就绪，延迟一下确保 Odoo 框架渲染完毕
    setTimeout(initPanel, 1000);
  }
})();
