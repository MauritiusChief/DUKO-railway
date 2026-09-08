// 浮动面板 UI —— 注入到 Odoo 页面的操作面板
// 功能：粘贴 CSV → 解析预览 → 一键填入 Odoo quotation

import type { CsvRow, PanelStatus, WrittenPart, WriteResult } from './types';
import { writePartsToQuotation, overwriteQuotation } from './quotation';
import { texts, type ScriptCatLang } from './i18n';

// ---- 面板 DOM 选择器（不挂全局，闭包内维护） ----

let panelVisible = true;
let panelMinimized = false;

/** 语言存储键（独立于 web app 的 duko_lang） */
const LANG_STORAGE_KEY = 'duko_scriptcat_lang';

/** 检测当前语言 */
function detectLang(): ScriptCatLang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLang: ScriptCatLang = detectLang();

/** 翻译辅助函数 */
function t(key: keyof typeof texts): string {
  return texts[key]?.[currentLang] ?? key;
}

// ---- CSS 注入 ----

// GM_addStyle 由 ScriptCat/Tampermonkey 提供
declare function GM_addStyle(css: string): void;

GM_addStyle(`
.duko-panel-wrap {
  position: fixed;
  top: 80px;
  right: 20px;
  width: 380px;
  z-index: 99999;
  font-size: 13px;
  border: 1px solid;
  background: #fff;
  user-select: none;
}
.duko-panel-wrap.duko-minimized {
  width: 140px;
}
.duko-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid;
  cursor: move;
}
.duko-panel-header-btns {
  display: flex;
  gap: 4px;
}
.duko-panel-header-btns button {
  background: none;
  border: 1px solid;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
}
.duko-panel-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.duko-minimized .duko-panel-body {
  display: none;
}
.duko-panel-body label {
  font-size: 12px;
}
.duko-panel-body textarea {
  width: 100%;
  height: 80px;
  resize: vertical;
  font-family: monospace;
  font-size: 12px;
  border: 1px solid;
  padding: 4px;
  box-sizing: border-box;
}
.duko-preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  max-height: 160px;
  overflow-y: auto;
  display: block;
}
.duko-preview-table thead {
  position: sticky;
  top: 0;
}
.duko-preview-table th {
  text-align: left;
  padding: 4px 6px;
  border-bottom: 1px solid;
  font-size: 12px;
}
.duko-preview-table td {
  padding: 3px 6px;
}
.duko-btn {
  padding: 4px 8px;
  border: 1px solid;
  font-size: 13px;
  cursor: pointer;
  width: 100%;
  background: ButtonFace;
}
.duko-btn:disabled {
  cursor: not-allowed;
}
.duko-status {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid;
}
.duko-status-textarea {
  width: 100%;
  height: 60px;
  resize: vertical;
  font-family: monospace;
  font-size: 12px;
  border: 1px solid;
  padding: 4px;
  box-sizing: border-box;
  user-select: text;
}
.duko-lang-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}
.duko-lang-toggle input {
  margin: 0;
}
`);

// ---- CSV 解析 ----

/** 将 CSV 文本解析为 CsvRow 数组。
 *  支持 header 行 productName,quantity[,discount]（可选，自动跳过）
 *  支持 "," 或 tab 分隔 */
function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // 检测第一行是否为 header（包含 productName 或 quantity）
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes('productname') || first.includes('product') || first.includes('sku') || first.includes('型号');

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows: CsvRow[] = [];

  for (const line of dataLines) {
    // 支持逗号或 tab 分隔
    const sep = line.includes('\t') ? '\t' : ',';
    const parts = line.split(sep);

    const productName = (parts[0] ?? '').trim();
    if (!productName) continue;

    const quantity = parseInt(parts[1]?.trim() ?? '1', 10) || 1;

    // 第三列折扣：空值保留为 undefined（不触碰 Odoo 折扣），无效值忽略
    const discountRaw = (parts[2] ?? '').trim();
    let discount: number | undefined;
    if (discountRaw !== '') {
      const parsed = Number(discountRaw);
      if (isFinite(parsed) && parsed >= 0 && parsed <= 100) discount = parsed;
    }

    rows.push({ productName, quantity, ...(discount !== undefined ? { discount } : {}) });
  }

  return rows;
}

// ---- 面板构建 ----

/** 初始化并注入浮动面板到页面 */
export function initPanel(): void {
  // 防止重复注入
  if (document.querySelector('.duko-panel-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'duko-panel-wrap';

  // --- 标题栏 ---
  const header = document.createElement('div');
  header.className = 'duko-panel-header';
  header.innerHTML = `<span>${t('panelTitle')}</span>`;

  const btnGroup = document.createElement('div');
  btnGroup.className = 'duko-panel-header-btns';

  // 语言切换 checkbox
  const langLabel = document.createElement('label');
  langLabel.className = 'duko-lang-toggle';
  const langCb = document.createElement('input');
  langCb.type = 'checkbox';
  langCb.checked = currentLang === 'en';
  langCb.addEventListener('change', () => {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
    // 移除旧面板并重建
    wrap.remove();
    initPanel();
  });
  langLabel.appendChild(langCb);
  langLabel.appendChild(document.createTextNode(t('langLabel')));
  btnGroup.appendChild(langLabel);

  const minBtn = document.createElement('button');
  minBtn.textContent = '\u2500'; // —
  minBtn.title = t('minimize');
  minBtn.addEventListener('click', () => toggleMinimized(wrap));

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '\u2715'; // ✕
  closeBtn.title = t('close');
  closeBtn.addEventListener('click', () => {
    panelVisible = false;
    wrap.remove();
  });

  btnGroup.append(minBtn, closeBtn);
  header.appendChild(btnGroup);

  // --- 主体 ---
  const body = document.createElement('div');
  body.className = 'duko-panel-body';

  // 文本框标签
  const label = document.createElement('label');
  label.textContent = t('csvLabel');
  body.appendChild(label);

  // CSV 文本框
  const textarea = document.createElement('textarea');
  textarea.placeholder = '02B15-D,2\n28B24-D,1';
  body.appendChild(textarea);

  // 预览表格
  const previewLabel = document.createElement('label');
  previewLabel.id = 'duko-preview-label';
  previewLabel.textContent = `${t('previewLabel')}0`;
  body.appendChild(previewLabel);

  const previewTable = document.createElement('table');
  previewTable.className = 'duko-preview-table';
  previewTable.style.display = 'none';
  body.appendChild(previewTable);

  // "一键写入" 按钮
  const writeBtn = document.createElement('button');
  writeBtn.className = 'duko-btn duko-btn-primary';
  writeBtn.textContent = t('writeBtn');
  writeBtn.disabled = true;
  body.appendChild(writeBtn);

  // 覆写模式 checkbox
  const overwriteLabel = document.createElement('label');
  overwriteLabel.className = 'duko-lang-toggle';
  const overwriteCb = document.createElement('input');
  overwriteCb.type = 'checkbox';
  overwriteCb.id = 'duko-overwrite-cb';
  overwriteLabel.appendChild(overwriteCb);
  overwriteLabel.appendChild(document.createTextNode(t('overwriteLabel')));
  body.appendChild(overwriteLabel);

  // 状态显示
  const statusEl = document.createElement('div');
  statusEl.className = 'duko-status duko-status-idle';
  statusEl.textContent = t('statusReady');
  body.appendChild(statusEl);

  // ---- 文本框输入处理：实时解析 CSV 并更新预览 ----
  let currentRows: CsvRow[] = [];

  textarea.addEventListener('input', () => {
    currentRows = parseCsv(textarea.value);
    updatePreview(previewLabel, previewTable, currentRows);
    writeBtn.disabled = currentRows.length === 0;
    // 重置状态
    setStatus(statusEl, 'idle', t('statusReady'));
  });

  // ---- 写入按钮点击 ----
  writeBtn.addEventListener('click', async () => {
    if (currentRows.length === 0) return;

    writeBtn.disabled = true;
    setStatus(statusEl, 'writing', t('statusWriting'));

    try {
      const parts = currentRows.map((r) => ({
        partModel: r.productName,
        quantity: r.quantity,
        ...(r.discount !== undefined ? { discount: r.discount } : {}),
      }));
      const isOverwrite = overwriteCb.checked;

      const result: WriteResult = isOverwrite
        ? await overwriteQuotation(parts)
        : await writePartsToQuotation(parts);

      if (result.unfilledParts.length === 0) {
        setStatus(statusEl, 'done', `${t('statusDone')}${result.successCount} / ${currentRows.length}`);
      } else if (result.successCount > 0) {
        alert(
          `${t('interceptAlert')}\n${result.unfilledParts.map(p => `- ${p.partModel} x${p.quantity}`).join('\n')}`
        );
        setFailedStatus(statusEl, result.unfilledParts, result.successCount, currentRows.length);
      } else {
        setFailedStatus(statusEl, result.unfilledParts, 0, currentRows.length);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(statusEl, 'error', `${t('statusErrMsg')}${msg}`);
    } finally {
      writeBtn.disabled = false;
    }
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  document.body.appendChild(wrap);

  // ---- 拖拽 ----
  makeDraggable(wrap, header);
}

// ---- 辅助函数 ----

/** 更新预览表格 */
function updatePreview(
  label: HTMLElement,
  table: HTMLTableElement,
  rows: CsvRow[],
): void {
  label.textContent = `${t('previewLabel')}${rows.length}`;

  if (rows.length === 0) {
    table.style.display = 'none';
    return;
  }

  table.style.display = '';
  table.innerHTML = `
    <thead><tr><th>#</th><th>${t('colModel')}</th><th>${t('colQty')}</th><th>${t('colDiscount')}</th></tr></thead>
    <tbody>
      ${rows
        .map(
          (r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.productName)}</td><td>${r.quantity}</td><td>${r.discount ?? ''}</td></tr>`,
        )
        .join('')}
    </tbody>`;
}

function escapeHtml(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

/** 设置状态文字 */
function setStatus(el: HTMLElement, _status: PanelStatus, text: string): void {
  el.className = 'duko-status';
  el.textContent = text;
}

/** 将状态区域变成可复制的文本框，显示写入失败的型号列表 */
function setFailedStatus(el: HTMLElement, unfilledParts: WrittenPart[], successCount: number, total: number): void {
  el.className = 'duko-status';
  el.textContent = '';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:12px;margin-bottom:4px';
  label.textContent = `${t('copyFailedLabel')}（${successCount}/${total} 成功）`;
  el.appendChild(label);
  const textarea = document.createElement('textarea');
  textarea.className = 'duko-status-textarea';
  textarea.readOnly = true;
  textarea.value = unfilledParts
    .map(p => `${p.partModel},${p.quantity}${p.discount !== undefined ? `,${p.discount}` : ''}`)
    .join('\n');
  el.appendChild(textarea);
}

/** 最小化/展开切换 */
function toggleMinimized(wrap: HTMLElement): void {
  panelMinimized = !panelMinimized;
  if (panelMinimized) {
    wrap.classList.add('duko-minimized');
  } else {
    wrap.classList.remove('duko-minimized');
  }
}

/** 实现面板拖拽 */
function makeDraggable(wrap: HTMLElement, handle: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  handle.addEventListener('mousedown', (e) => {
    startX = (e as MouseEvent).clientX;
    startY = (e as MouseEvent).clientY;
    const rect = wrap.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      wrap.style.right = 'auto';
      wrap.style.top = `${Math.max(0, origTop + dy)}px`;
      wrap.style.left = `${origLeft + dx}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
