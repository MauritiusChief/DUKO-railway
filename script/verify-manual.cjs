const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const targets = require('./targets.json');

for (const target of Object.values(targets)) {
  const outputDir = path.join(__dirname, 'dist/manual');
  const code = fs.readFileSync(path.join(outputDir, target.filename), 'utf8');
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, `${target.id}.build-meta.json`), 'utf8'));
  new vm.Script(code); // 验证最终安装文件语法，不只检查 TypeScript 源码。
  assert.equal(metadata.target, target.id);
  assert.ok(code.startsWith('// ==UserScript==\n'));
  assert.ok(code.includes(`// @name         ${target.name}\n`));
  assert.ok(code.includes(`// @version      ${metadata.buildTs}\n`));
  assert.deepEqual(code.split('\n').filter((line) => line.startsWith('// @match')), [
    `// @match        https://dukouserp.com${target.path}`,
    `// @match        https://dukouserp.com${target.path}/*`,
  ]);
  const other = target.id === 'sales' ? targets.purchase : targets.sales;
  for (const pathname of [target.path, `${target.path}/new`, other.path, `${target.path}-other`]) {
    const dom = new JSDOM('', {
      url: `https://dukouserp.com${pathname}`,
      runScripts: 'outside-only',
    });
    try {
      dom.window.GM_addStyle = () => {};
      dom.window.console.log = () => {};
      dom.window.eval(code);
      dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
      const expected = pathname === target.path || pathname.startsWith(`${target.path}/`);
      const panel = dom.window.document.querySelector('.duko-panel-wrap');
      assert.equal(!!panel, expected, `${target.id}: ${pathname}`);
      if (expected) {
        assert.match(panel.querySelector('.duko-panel-header').textContent, new RegExp(target.name));
        const textarea = panel.querySelector('textarea');
        textarea.value = 'TEST-A,2,15';
        textarea.dispatchEvent(new dom.window.Event('input'));
        assert.equal(panel.querySelectorAll('.duko-preview-table th').length, target.supportsDiscount ? 4 : 3);
      }
    } finally {
      dom.window.close();
    }
  }
  console.log(`Verified ${target.filename}: metadata, syntax, route guard and CSV preview`);
}
