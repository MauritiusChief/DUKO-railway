const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const targets = require('../targets.json');
const { userscriptHeader, createConfig } = require('../build-config.cjs');

const scriptDir = path.resolve(__dirname, '..');

// 只运行隔离 DOM，不加载资源、不连接 Odoo。所有型号都是合成夹具。
function harness(target, html = '') {
  const dom = new JSDOM(html, {
    url: `https://dukouserp.com${target.path}/new`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__ODOO_TARGET__ = target;
  window.__BUILD_TS__ = 'test';
  window.GM_addStyle = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.document.execCommand = (command, _showUI, value) => {
    assert.equal(command, 'insertText');
    const input = window.document.activeElement;
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  };
  const cache = new Map();
  function load(filename) {
    const fullPath = path.resolve(scriptDir, filename);
    if (cache.has(fullPath)) return cache.get(fullPath).exports;
    const code = ts.transpileModule(fs.readFileSync(fullPath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    cache.set(fullPath, module);
    const localRequire = (request) => load(path.relative(scriptDir, path.resolve(path.dirname(fullPath), `${request}.ts`)));
    window.eval(`(function(exports, require, module) { ${code}\n})`)(module.exports, localRequire, module);
    return module.exports;
  }
  return { dom, window, load };
}

function productClass(target) {
  return target.id === 'sales' ? 'o_sol_product_many2one_cell' : 'o_many2one_barcode_cell';
}

function savedRow(target, model, quantity = 1, discount = 0, id = model) {
  return `<tr class="o_data_row" data-id="${id}">
    <td name="product_id" class="${productClass(target)}">${model}</td>
    <td name="${target.quantityField}">${quantity.toFixed(2)}</td>
    ${target.supportsDiscount ? `<td name="discount">${discount.toFixed(2)}</td>` : ''}
    <td class="o_list_record_remove"><button class="fa-trash-o">Delete</button></td>
  </tr>`;
}

function tableHtml(target, rows = '', name = 'order_line') {
  return `<div class="o_form_view"><h1>Test Order</h1>
    <div name="${name}" class="o_field_widget o_field_section_and_note_one2many">
      <table class="o_section_and_note_list_view"><thead><tr><th data-name="${target.quantityField}"></th></tr></thead>
        <tbody>${rows}<tr><td class="o_field_x2many_list_row_add"><a href="#">Add a product</a><a href="#">Add a section</a></td></tr></tbody>
      </table>
    </div></div>`;
}

function wireTable(window, table, target, { rejectSubmit = false, navigateOnProduct = false } = {}) {
  let sequence = 0;
  const onDelete = (row) => row.querySelector('button.fa-trash-o').addEventListener('click', () => row.remove());
  table.querySelectorAll('tr.o_data_row').forEach(onDelete);
  table.querySelector('td.o_field_x2many_list_row_add > a').addEventListener('click', (event) => {
    event.preventDefault();
    const row = window.document.createElement('tr');
    row.className = 'o_data_row o_selected_row';
    row.dataset.id = `new-${++sequence}`;
    row.innerHTML = `<td name="product_id" class="${productClass(target)}"><input class="o-autocomplete--input"></td>
      <td name="${target.quantityField}"><input class="o_input" value="1"></td>
      ${target.supportsDiscount ? '<td name="discount"><input class="o_input" value="0"></td>' : ''}
      <td class="o_list_record_remove"><button class="fa-trash-o">Delete</button></td>`;
    table.querySelector('tbody').prepend(row);
    onDelete(row);
    const cell = row.querySelector(target.productCell);
    cell.querySelector('input').addEventListener('input', (event) => {
      cell.querySelector('ul')?.remove();
      const menu = window.document.createElement('ul');
      menu.className = 'o-autocomplete--dropdown-menu';
      const model = event.target.value;
      menu.innerHTML = model === 'MISSING'
        ? '<li class="o-autocomplete--dropdown-item o_m2o_dropdown_option"><a class="dropdown-item">Search More...</a></li>'
        : `<li class="o-autocomplete--dropdown-item"><a class="dropdown-item">${model}</a></li>`;
      cell.append(menu);
      menu.querySelector('a').addEventListener('click', () => {
        cell.textContent = model;
        if (navigateOnProduct) window.history.pushState({}, '', '/odoo/other/new');
      });
    });
    const quantity = row.querySelector(`td[name="${target.quantityField}"] input`);
    quantity.addEventListener('input', () => {
      const discount = row.querySelector('td[name="discount"] input');
      if (discount) discount.value = '0';
    });
    quantity.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || rejectSubmit) return;
      const qty = Number(quantity.value);
      const discount = Number(row.querySelector('td[name="discount"] input')?.value ?? 0);
      row.outerHTML = savedRow(target, cell.textContent, qty, discount, row.dataset.id);
      onDelete(table.querySelector(`[data-id="new-${sequence}"]`));
    });
  });
}

for (const target of Object.values(targets)) {
  test(`${target.id}: metadata and runtime agree on exact route boundaries`, () => {
    const h = harness(target);
    try {
      const { isTargetPage } = h.load('target.ts');
      const route = (pathname, origin = 'https://dukouserp.com') => isTargetPage({ pathname, origin });
      assert.equal(route(target.path), true);
      assert.equal(route(`${target.path}/123`), true);
      assert.equal(route(`${target.path}-other`), false);
      assert.equal(route(target.id === 'sales' ? targets.purchase.path : targets.sales.path), false);
      assert.equal(route(target.path, 'https://example.test'), false);
      const header = userscriptHeader(target, 'test');
      assert.deepEqual(header.split('\n').filter((line) => line.includes('@match')).map((line) => line.trim()), [
        `// @match        https://dukouserp.com${target.path}`,
        `// @match        https://dukouserp.com${target.path}/*`,
      ]);
    } finally { h.dom.window.close(); }
  });

  test(`${target.id}: CSV and preview respect discount capability`, () => {
    const h = harness(target);
    try {
      const { parseCsv } = h.load('csv.ts');
      const rows = JSON.parse(JSON.stringify(parseCsv('productName,quantity,discount\nTEST-A,2,15\nTEST-B\t3\tinvalid\nTEST-C,1,0')));
      assert.deepEqual(rows, [
        { productName: 'TEST-A', quantity: 2, ...(target.supportsDiscount ? { discount: 15 } : {}) },
        { productName: 'TEST-B', quantity: 3 },
        { productName: 'TEST-C', quantity: 1, ...(target.supportsDiscount ? { discount: 0 } : {}) },
      ]);
      h.load('panel.ts').initPanel();
      const textarea = h.window.document.querySelector('.duko-panel-body textarea');
      textarea.value = 'TEST-A,2,15';
      textarea.dispatchEvent(new h.window.Event('input'));
      assert.equal(h.window.document.querySelectorAll('.duko-preview-table th').length, target.supportsDiscount ? 4 : 3);
    } finally { h.dom.window.close(); }
  });

  test(`${target.id}: writes multiple rows, scopes table and cleans missing product`, async () => {
    const unrelated = tableHtml(target, savedRow(target, 'UNRELATED'), 'other_lines');
    const hidden = `<div style="display:none">${tableHtml(target, savedRow(target, 'HIDDEN'))}</div>`;
    const dialog = `<div class="o_dialog">${tableHtml(target, savedRow(target, 'DIALOG'))}</div>`;
    const h = harness(target, unrelated + hidden + dialog + tableHtml(target, savedRow(target, 'EXISTING')));
    try {
      const q = h.load('quotation.ts');
      const table = await q.ensureTableReady();
      wireTable(h.window, table, target);
      const result = await q.writePartsToQuotation([
        { partModel: 'TEST-A', quantity: 2, discount: 15 },
        { partModel: 'MISSING', quantity: 1 },
        { partModel: 'TEST-B', quantity: 3 },
      ]);
      assert.equal(result.successCount, 2);
      assert.deepEqual(Array.from(result.unfilledParts, (part) => part.partModel), ['MISSING']);
      assert.deepEqual(Array.from(q.getExistingProducts(table)).sort(), ['EXISTING', 'TEST-A', 'TEST-B']);
      assert.equal(table.querySelector('tr.o_selected_row'), null);
      assert.equal(h.window.document.querySelectorAll('[name="other_lines"] tr.o_data_row').length, 1);
      assert.match(h.window.document.querySelector('.o_dialog').textContent, /DIALOG/);
      if (target.supportsDiscount) {
        const row = q.getDataRows(table).find((row) => row.querySelector(target.productCell).textContent === 'TEST-A');
        assert.equal(row.querySelector('[name="discount"]').textContent, '15.00');
      }
    } finally { h.dom.window.close(); }
  });

  test(`${target.id}: overwrite preserves matching products and counts retained rows`, async () => {
    const h = harness(target, tableHtml(target, savedRow(target, 'KEEP', 5, 10) + savedRow(target, 'REMOVE')));
    try {
      const q = h.load('quotation.ts');
      const table = await q.ensureTableReady();
      wireTable(h.window, table, target);
      const result = await q.overwriteQuotation([
        { partModel: 'KEEP', quantity: 5, discount: target.supportsDiscount ? 10 : 99 },
        { partModel: 'ADD', quantity: 2 },
      ]);
      assert.equal(result.successCount, 2);
      assert.equal(result.unfilledParts.length, 0);
      assert.deepEqual(Array.from(q.getExistingProducts(table)).sort(), ['ADD', 'KEEP']);
    } finally { h.dom.window.close(); }
  });

  test(`${target.id}: route navigation stops writes before quantity and later rows`, async () => {
    const h = harness(target, tableHtml(target));
    try {
      const q = h.load('quotation.ts');
      const table = await q.ensureTableReady();
      wireTable(h.window, table, target, { navigateOnProduct: true });
      const result = await q.writePartsToQuotation([
        { partModel: 'TEST-A', quantity: 7 }, { partModel: 'TEST-B', quantity: 8 },
      ]);
      assert.equal(result.successCount, 0);
      assert.equal(result.unfilledParts.length, 2);
      assert.equal(q.getDataRows(table).length, 1);
      assert.equal(table.querySelector(`[name="${target.quantityField}"] input`).value, '1');
    } finally { h.dom.window.close(); }
  });
}

test('required fields and missing submission never report success', async () => {
  const h = harness(targets.purchase, tableHtml(targets.purchase));
  try {
    const q = h.load('quotation.ts');
    const table = await q.ensureTableReady();
    await assert.rejects(q.fillQuantity(table, h.window.document.createElement('tr'), 2), /数量输入框/);
    assert.throws(() => q.submitEditableRow(table, h.window.document.createElement('tr')), /数量输入框/);
    // 短超时保留相同条件检查，避免回归用例等真实的八秒钟。
    const waiters = h.load('waiters.ts');
    const original = waiters.waitForElementRemoved;
    waiters.waitForElementRemoved = (selector, _timeout, root) => original(selector, 10, root);
    wireTable(h.window, table, targets.purchase, { rejectSubmit: true });
    const result = await q.writePartsToQuotation([{ partModel: 'TEST-A', quantity: 2 }]);
    assert.equal(result.successCount, 0);
    assert.equal(result.unfilledParts.length, 1);
  } finally { h.dom.window.close(); }
});

test('sales requires a discount field when one was specified', async () => {
  const h = harness(targets.sales, tableHtml(targets.sales));
  try {
    const q = h.load('quotation.ts');
    const table = await q.ensureTableReady();
    await assert.rejects(q.fillDiscount(table, h.window.document.createElement('tr'), 10), /折扣输入框/);
  } finally { h.dom.window.close(); }
});

test('ambiguous visible order tables fail before mutation', async () => {
  const h = harness(targets.purchase, tableHtml(targets.purchase) + tableHtml(targets.purchase));
  try {
    await assert.rejects(h.load('quotation.ts').ensureTableReady(), /多个订单表格/);
  } finally { h.dom.window.close(); }
});

test('loading both build configurations does not create or write production artifacts', () => {
  const productionDir = path.resolve(scriptDir, '../server/public/script');
  const snapshot = () => fs.existsSync(productionDir)
    ? Object.fromEntries(fs.readdirSync(productionDir).map((file) => [file, fs.readFileSync(path.join(productionDir, file)).toString('base64')]))
    : null;
  const before = snapshot();
  require('../rspack.config.js');
  for (const target of Object.values(targets)) {
    const config = createConfig(target, { outputPath: path.join(scriptDir, 'dist/manual') });
    assert.equal(config.output.path, path.join(scriptDir, 'dist/manual'));
    assert.equal(config.output.filename, target.filename);
  }
  assert.deepEqual(snapshot(), before);
});
