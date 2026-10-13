// 销售／采购共享填表流程。所有行、字段、菜单操作限定于本次选定的订单表格。
import {
  QUOTATION_TABLE_SELECTOR, QUOTATION_DATA_ROW_SELECTOR, QUOTATION_SELECTED_ROW_SELECTOR,
  PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR, PRODUCT_AUTOCOMPLETE_MENU_SELECTOR,
  PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR, PRODUCT_CELL_SELECTOR,
  EDITABLE_QUANTITY_INPUT_SELECTOR, QUANTITY_CELL_SELECTOR,
  EDITABLE_DISCOUNT_INPUT_SELECTOR, DETAIL_DISCOUNT_CELL_SELECTOR,
  ADD_PRODUCT_LINK_SELECTOR, REMOVE_ROW_BUTTON_SELECTOR, SELECT_CANCELLING,
} from './selectors';
import { isVisible, waitUntil, waitForSelector, waitForElementRemoved, waitForCountDecrease } from './waiters';
import { TARGET, assertTargetPage, isTargetPage } from './target';
import type { WrittenPart, WriteResult } from './types';

function assertTableActive(table: Element): void {
  assertTargetPage();
  if (!isVisible(table) || table.closest('.o_dialog, .modal')) {
    throw new Error('订单表格已关闭或切换，请刷新对应页面后重试');
  }
}

/** 不猜测多个可见订单表格；先确认数量列属于当前脚本。 */
export async function ensureTableReady(): Promise<Element> {
  assertTargetPage();
  let table: Element | undefined;
  await waitUntil(() => {
    assertTargetPage();
    const candidates = Array.from(document.querySelectorAll(QUOTATION_TABLE_SELECTOR))
      .filter((element) => isVisible(element) && !element.closest('.o_dialog, .modal'))
      .filter((element) => element.querySelector(`th[data-name="${TARGET.quantityField}"]`)
        || element.querySelector(QUANTITY_CELL_SELECTOR));
    if (candidates.length > 1) throw new Error('存在多个订单表格，无法确定写入目标');
    table = candidates[0];
    return !!table;
  });
  return table!;
}

export function getDataRows(table: Element): Element[] {
  return Array.from(table.querySelectorAll(QUOTATION_DATA_ROW_SELECTOR));
}

export function getSelectedRow(table: Element): Element | null {
  return table.querySelector(QUOTATION_SELECTED_ROW_SELECTOR);
}

export function removeRow(table: Element, row: Element): void {
  assertTableActive(table);
  if (!table.contains(row)) throw new Error('待删除行已离开目标表格');
  const button = row.querySelector<HTMLElement>(REMOVE_ROW_BUTTON_SELECTOR);
  if (!button) throw new Error('找不到行删除按钮');
  button.click();
}

export async function addNewRow(table: Element): Promise<Element> {
  assertTableActive(table);
  const before = new Set(getDataRows(table).map((row) => row.getAttribute('data-id') ?? row));
  const addLink = table.querySelector<HTMLElement>(ADD_PRODUCT_LINK_SELECTOR);
  if (!addLink) throw new Error('找不到 "Add a product" 链接');
  addLink.click();
  let added: Element | null = null;
  await waitUntil(() => {
    assertTableActive(table);
    added = getSelectedRow(table);
    return !!added && !before.has(added.getAttribute('data-id') ?? added);
  }, 5000, table);
  return added!;
}

function insertText(table: Element, input: HTMLInputElement, value: string): void {
  assertTableActive(table);
  if (!table.contains(input)) throw new Error('输入框已离开目标表格');
  input.scrollIntoView({ block: 'center' });
  input.focus();
  input.select();
  // 保留已验证的 Odoo 原生输入方式。
  document.execCommand('insertText', false, value);
  if (input.value !== value) throw new Error('Odoo 输入框未接受输入');
}

function normalizeModel(value: string): string {
  return value.replace(/[-\s]/g, '').toLowerCase();
}

export async function fillProduct(table: Element, row: Element, model: string): Promise<boolean> {
  const input = row.querySelector<HTMLInputElement>(PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR);
  if (!input) throw new Error('找不到产品 autocomplete 输入框');
  insertText(table, input, model);
  const menuSelector = `${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_MENU_SELECTOR}`;
  const itemSelector = `${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR}`;
  try {
    await waitForSelector(menuSelector, 12000, table);
  } catch {
    assertTableActive(table);
    return false;
  }
  // 菜单可出现“无结果／Search More”，不能只等待有产品选项。
  await waitUntil(() => {
    assertTableActive(table);
    const menu = table.querySelector(menuSelector);
    return !!menu && !(menu.textContent ?? '').includes('Loading');
  }, 8000, table);
  const items = Array.from(table.querySelectorAll<HTMLElement>(itemSelector));
  const match = items.find((item) => item.textContent?.includes(model))
    ?? items.find((item) => normalizeModel(item.textContent ?? '').includes(normalizeModel(model)));
  if (!match) return false;
  assertTableActive(table);
  match.click();
  return true;
}

export async function fillQuantity(table: Element, row: Element, quantity: number): Promise<void> {
  const input = row.querySelector<HTMLInputElement>(EDITABLE_QUANTITY_INPUT_SELECTOR);
  if (!input) throw new Error('找不到可编辑的数量输入框');
  insertText(table, input, String(quantity));
}

export async function fillDiscount(table: Element, row: Element, discount: number): Promise<void> {
  if (!TARGET.supportsDiscount) return;
  const input = row.querySelector<HTMLInputElement>(EDITABLE_DISCOUNT_INPUT_SELECTOR);
  if (!input) throw new Error('找不到可编辑的折扣输入框');
  insertText(table, input, String(discount));
}

export function submitEditableRow(table: Element, row: Element): void {
  assertTableActive(table);
  const input = row.querySelector<HTMLInputElement>(EDITABLE_QUANTITY_INPUT_SELECTOR);
  if (!input || !table.contains(input)) throw new Error('找不到可提交的数量输入框');
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13,
  }));
}

export function deselectCurrentRow(table: Element): void {
  assertTableActive(table);
  const form = table.closest('.o_form_view');
  const canceller = form?.querySelector<HTMLElement>(SELECT_CANCELLING)
    ?? form?.querySelector<HTMLElement>('h1');
  canceller?.click();
}

function findWrittenRow(table: Element, row: Element): Element | undefined {
  const id = row.getAttribute('data-id');
  return id ? getDataRows(table).find((candidate) => candidate.getAttribute('data-id') === id)
    : (table.contains(row) ? row : undefined);
}

function readNumber(cell: Element | null): number | undefined {
  const text = (cell?.textContent ?? '').replace(/[\s,]/g, '');
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

async function writeParts(table: Element, parts: WrittenPart[]): Promise<WriteResult> {
  const unfilledParts: WrittenPart[] = [];
  let successCount = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    let addedRow: Element | undefined;
    let productChosen = false;
    try {
      assertTableActive(table);
      const row = await addNewRow(table);
      addedRow = row;
      await waitForSelector(`${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR}`, 5000, table);
      const editingRow = getSelectedRow(table);
      if (!editingRow) throw new Error('新增行没有进入编辑态');
      productChosen = await fillProduct(table, editingRow, part.partModel);
      if (!productChosen) throw new Error('找不到匹配产品');
      await waitForElementRemoved(`${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_MENU_SELECTOR}`, 5000, table);
      await waitForSelector(`${QUOTATION_SELECTED_ROW_SELECTOR} ${EDITABLE_QUANTITY_INPUT_SELECTOR}`, 5000, table);
      const filledRow = getSelectedRow(table);
      if (!filledRow) throw new Error('产品行没有进入编辑态');
      addedRow = filledRow;
      await fillQuantity(table, filledRow, part.quantity);
      if (TARGET.supportsDiscount && part.discount !== undefined) {
        await fillDiscount(table, filledRow, part.discount);
      }
      submitEditableRow(table, filledRow);
      try {
        await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 5000, table);
      } catch {
        deselectCurrentRow(table);
        await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 3000, table);
      }
      assertTableActive(table);
      const saved = findWrittenRow(table, filledRow);
      if (!saved || !(saved.querySelector(PRODUCT_CELL_SELECTOR)?.textContent ?? '').trim()
        || readNumber(saved.querySelector(QUANTITY_CELL_SELECTOR)) !== part.quantity) {
        throw new Error('行提交后产品或数量未确认');
      }
      if (TARGET.supportsDiscount && part.discount !== undefined
        && readNumber(saved.querySelector(DETAIL_DISCOUNT_CELL_SELECTOR)) !== part.discount) {
        throw new Error('行提交后折扣未确认');
      }
      successCount++;
    } catch (error) {
      console.error('[DUKO Filler] 行写入失败:', error);
      unfilledParts.push(part);
      // 页面切换后立即停止，不能恢复或修改新页面上的行。
      if (!isTargetPage() || !isVisible(table)) {
        unfilledParts.push(...parts.slice(index + 1));
        break;
      }
      try {
        // 只删除本次创建且尚未选定产品的行，不触碰已有行。
        const current = addedRow && findWrittenRow(table, addedRow);
        if (current && !productChosen) {
          const count = getDataRows(table).length;
          removeRow(table, current);
          await waitForCountDecrease(QUOTATION_DATA_ROW_SELECTOR, count, 3000, table);
        } else if (getSelectedRow(table)) {
          deselectCurrentRow(table);
          await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 3000, table);
        }
      } catch {
        // 未恢复完成时停止，避免后续输入写入同一行。
        unfilledParts.push(...parts.slice(index + 1));
        break;
      }
    }
  }
  return { successCount, unfilledParts };
}

export async function writePartsToQuotation(parts: WrittenPart[]): Promise<WriteResult> {
  return writeParts(await ensureTableReady(), parts);
}

export function getExistingProducts(table: Element): string[] {
  return getDataRows(table).map((row) => (row.querySelector(PRODUCT_CELL_SELECTOR)?.textContent ?? '').trim()).filter(Boolean);
}

/** 沿用现有覆写语义：保留匹配行，删除多余行，追加缺失型号。 */
export async function overwriteQuotation(parts: WrittenPart[]): Promise<WriteResult> {
  const table = await ensureTableReady();
  const newMap = new Map(parts.map((part) => [part.partModel, part]));
  for (const row of getDataRows(table)) {
    const name = (row.querySelector(PRODUCT_CELL_SELECTOR)?.textContent ?? '').trim();
    if (!name) continue;
    const want = newMap.get(name);
    const shouldRemove = !want || (TARGET.supportsDiscount && want.discount !== undefined
      && readNumber(row.querySelector(DETAIL_DISCOUNT_CELL_SELECTOR)) !== want.discount);
    if (shouldRemove) {
      const count = getDataRows(table).length;
      removeRow(table, row);
      await waitForCountDecrease(QUOTATION_DATA_ROW_SELECTOR, count, 5000, table);
    }
  }
  const kept = new Set(getExistingProducts(table));
  const toAdd = parts.filter((part) => !kept.has(part.partModel));
  const result = await writeParts(table, toAdd);
  return { successCount: parts.length - toAdd.length + result.successCount, unfilledParts: result.unfilledParts };
}
