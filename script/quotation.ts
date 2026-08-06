// Odoo quotation 填表核心逻辑
// 对 MIGRATION_PLAN §2.3.2 中 quotationTable.ts 的浏览器端重写
// Playwright Locator API → 原生 DOM API + dispatchEvent

import {
  QUOTATION_TABLE_SELECTOR,
  QUOTATION_DATA_ROW_SELECTOR,
  QUOTATION_SELECTED_ROW_SELECTOR,
  PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR,
  PRODUCT_AUTOCOMPLETE_MENU_SELECTOR,
  PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR,
  EDITABLE_QUANTITY_INPUT_SELECTOR,
  EDITABLE_DISCOUNT_INPUT_SELECTOR,
  DETAIL_DISCOUNT_CELL_SELECTOR,
  ADD_PRODUCT_LINK_SELECTOR,
  REMOVE_ROW_BUTTON_SELECTOR,
  SELECT_CANCELLING,
  PRODUCT_CELL_SELECTOR,
} from './selectors';
import {
  waitForSelector,
  waitForElementRemoved,
  waitForDropdownReady,
  waitForCountDecrease,
} from './waiters';
import type { WrittenPart, WriteResult } from './types';

// ---- 1. 前置检查 ----

/** 等待 Odoo quotation 主表格就绪（可见），超时 10 秒 */
export async function ensureTableReady(): Promise<Element> {
  return waitForSelector(QUOTATION_TABLE_SELECTOR, 10000);
}

// ---- 2. 读取已有行 ----

/** 获取所有 o_data_row 业务数据行 */
export function getDataRows(): Element[] {
  return Array.from(document.querySelectorAll(QUOTATION_DATA_ROW_SELECTOR));
}

// ---- 3. 获取当前编辑行 ----

/** 获取当前被选中的编辑行 */
export function getSelectedRow(): Element | null {
  return document.querySelector(QUOTATION_SELECTED_ROW_SELECTOR);
}

// ---- 4. 删除单行 ----

/** 删除指定行（不等待表格变化），用于 autocomplete 超时后清理无效空行 */
export function removeRow(row: Element): void {
  const delBtn = row.querySelector(REMOVE_ROW_BUTTON_SELECTOR) as HTMLElement | null;
  delBtn?.click();
}

// ---- 6. 新增编辑行 ----

/**
 * 点击 "Add a product" 新增一行。
 * 等待新行出现后，返回当前被选中的编辑行元素。
 *
 * 选择器 td.o_field_x2many_list_row_add > a 为 Odoo 标准标记，
 * 已通过实际 DOM 树确认可用。
 */
export async function addNewRow(): Promise<Element> {
  const beforeCount = getDataRows().length;

  const addLink = document.querySelector(ADD_PRODUCT_LINK_SELECTOR) as HTMLElement | null;

  if (!addLink) {
    throw new Error('找不到 "Add a product" 链接');
  }

  addLink.click();

  // 等待新行出现
  let retries = 0;
  while (retries < 20) {
    const current = getDataRows();
    if (current.length > beforeCount) {
      const selected = getSelectedRow();
      if (selected) return selected;
    }
    await new Promise((r) => setTimeout(r, 250));
    retries++;
  }

  throw new Error('新增行超时：新行未出现');
}

// ---- 7. 填入产品型号（含 autocomplete 交互） ----

/**
 * 在当前选中行内填入产品型号。
 * 流程：输入型号 → 触发 Odoo autocomplete 查询 → 等待下拉菜单 → 点击匹配项
 *
 * execCommand('insertText') 触发完整的原生输入管线（beforeinput → input → change），
 * Odoo Web Client 依赖此管线启动 autocomplete 查询，手动 dispatchEvent 不够。
 *
 * @returns true = 成功选中匹配项, false = 未匹配到（菜单未出现或无匹配项）
 */
export async function fillProduct(row: Element, model: string): Promise<boolean> {
  const input = row.querySelector(PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR) as HTMLInputElement | null;
  if (!input) {
    console.warn('[fillProduct] 找不到 autocomplete 输入框');
    return false;
  }

  input.scrollIntoView({ block: 'center' });
  input.focus();
  input.select();
  document.execCommand('insertText', false, model);

  // 等待真实下拉结果加载完成（不再只是 "Loading..." 占位），合并了原先"菜单项出现"与"结果加载"两步等待
  try {
    // await waitForSelector(PRODUCT_AUTOCOMPLETE_MENU_SELECTOR, 12000);
    await waitForSelector(
      `${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_MENU_SELECTOR}`,
      12000,
    );
  } catch {
    console.warn(`[fillProduct] "${model}" 未触发 autocomplete 下拉菜单`);
    return false;
  }

  // Odoo autocomplete 先渲染 "Loading..." 占位，等后端返回真实结果。
  // 动态等待下拉项不再全是 Loading，而不是粗暴延时 1500ms。
  await waitForDropdownReady(
    `${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR}`,
    8000,
  );

  // 查找匹配项（包含目标型号文本）
  const itemsArr = Array.from(document.querySelectorAll(PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR));
  // 诊断：打印实际找到的选项文本（排查后用可移除）
  console.log(`[fillProduct] autocomplete 共 ${itemsArr.length} 个选项:`, itemsArr.slice(0, 5).map((el) => el.textContent?.trim()));
  let matchedItem: Element | null = null;
  for (const item of itemsArr) {
    if (item.textContent?.includes(model)) {
      matchedItem = item;
      break;
    }
  }

  if (!matchedItem) {
    const coreModel = model.replace(/[-\s]/g, '').toLowerCase();
    for (const item of itemsArr) {
      const text = item.textContent?.replace(/[-\s]/g, '').toLowerCase() ?? '';
      if (text.includes(coreModel)) {
        matchedItem = item;
        break;
      }
    }
  }

  if (!matchedItem) {
    console.warn(`[fillProduct] 在下拉菜单中找不到 "${model}" 的匹配项`);
    return false;
  }

  (matchedItem as HTMLElement).click();

  // // 改后：jQuery UI autocomplete 监听 mousedown 完成选项确认
  // // 点击 <li> 父元素避开 <a href="#"> 的浏览器默认导航行为
  // const li = matchedItem.closest('li') as HTMLElement | null;
  // const target = li ?? matchedItem as HTMLElement;
  // target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  return true;
}

// ---- 8. 填入折扣 ----

/**
 * 在当前选中行填入折扣百分比。
 * 不按 Enter，由随后的数量填写统一提交（避免提前结束编辑态）。
 */
export async function fillDiscount(row: Element, discount: number): Promise<void> {
  const input = row.querySelector(EDITABLE_DISCOUNT_INPUT_SELECTOR) as HTMLInputElement | null;
  if (!input) {
    console.warn('[fillDiscount] 找不到可编辑的折扣输入框');
    return;
  }

  input.scrollIntoView({ block: 'center' });
  input.focus();
  input.select();
  document.execCommand('insertText', false, String(discount));
}

// ---- 9. 填入数量 ----

/**
 * 在当前选中行填入数量。
 * 填入后按 Enter 提交（Odoo 行编辑依赖 Enter 确认）。
 */
export async function fillQuantity(row: Element, quantity: number): Promise<void> {
  const input = row.querySelector(EDITABLE_QUANTITY_INPUT_SELECTOR) as HTMLInputElement | null;
  if (!input) {
    console.warn('[fillQuantity] 找不到可编辑的数量输入框');
    return;
  }

  input.scrollIntoView({ block: 'center' });
  input.focus();
  input.select();
  document.execCommand('insertText', false, String(quantity));

  // 按 Enter 确认（Odoo 依赖此事件完成行保存）
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
    }),
  );
}

// ---- 10. 取消选中 ----

/**
 * 点击标题区域失焦，让当前编辑行退出 o_selected_row 状态。
 * 否则下一次 "Add a product" 可能不会正确插入新行。
 */
export function deselectCurrentRow(): void {
  const canceller = document.querySelector(SELECT_CANCELLING) as HTMLElement | null;
  canceller?.click();
}

// ---- 11. 编排写入 ----

/**
 * 主入口：将零件列表逐行追加到 Odoo quotation 表格末尾。
 *
 * @param parts - 待写入的零件列表
 * @returns 写入结果
 */
export async function writePartsToQuotation(
  parts: WrittenPart[],
): Promise<WriteResult> {
  await ensureTableReady();

  const unfilledParts: WrittenPart[] = [];
  let successCount = 0;

  for (const part of parts) {
    const countBefore = getDataRows().length;

    try {
      // a. 新增一行
      const row = await addNewRow();
      // 动态等待 autocomplete 输入框在选中行中可用（替代 setTimeout 1000ms）
      await waitForSelector(
        `${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR}`,
        5000,
      );

      // b. 填入产品型号
      const filled = await fillProduct(row, part.partModel);

      if (!filled) {
        // 未匹配到产品 → 先 Escape 退出编辑，再删除空行
        document.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27 }),
        );
        // 动态等待选中行消失（替代 setTimeout 300ms）
        await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 3000);
        removeRow(row);
        // 动态等待数据行数回落（替代 setTimeout 300ms）
        await waitForCountDecrease(QUOTATION_DATA_ROW_SELECTOR, countBefore + 1, 3000);
        unfilledParts.push(part);
        continue;
      }

      // 等待 autocomplete 下拉菜单消失，确认产品选择已生效（替代 setTimeout 500ms）
      await waitForElementRemoved(
        `${QUOTATION_SELECTED_ROW_SELECTOR} ${PRODUCT_AUTOCOMPLETE_MENU_SELECTOR}`,
        5000,
      );

      // 动态等待选中行被 Odoo 重新确认（autocomplete 选定后行可能被重建）
      await waitForSelector(QUOTATION_SELECTED_ROW_SELECTOR, 3000);

      // c. 先填折扣（如指定）、再填数量；数量回车统一提交行
      const filledRow = getSelectedRow();
      if (filledRow) {
        if (part.discount !== undefined) {
          await fillDiscount(filledRow, part.discount);
        }
        await fillQuantity(filledRow, part.quantity);
        successCount++;
      } else {
        unfilledParts.push(part);
      }

      // 等待 Odoo 提交行后自动退出编辑态（Enter 会触发保存并取消选中，替代 setTimeout 500ms + 300ms）
      await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 5000);
      // 兜底：如果还未退出选中，手动取消选中
      if (getSelectedRow()) {
        deselectCurrentRow();
        await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 3000);
      }
    } catch (err) {
      console.error(`[writeParts] 写入 "${part.partModel}" 失败:`, err);
      unfilledParts.push(part);
      // 恢复：按 Escape 退出编辑 + 失焦
      document.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27 }),
      );
      deselectCurrentRow();
      // 动态等待选中行消失（替代 setTimeout 500ms）
      await waitForElementRemoved(QUOTATION_SELECTED_ROW_SELECTOR, 5000);
    }
  }

  return { successCount, unfilledParts };
}

// ---- 12. 读取已有行产品型号 ----

/**
 * 从当前 Odoo quotation 表格的已有行中提取产品型号列表。
 * 用于覆写模式中的精确匹配对比。
 */
export function getExistingProducts(): string[] {
  const rows = getDataRows();
  return rows
    .map((row) => {
      const productCell = row.querySelector(PRODUCT_CELL_SELECTOR);
      return (productCell?.textContent ?? '').trim();
    })
    .filter(Boolean);
}

// ---- 13. 覆写模式 ----

/**
 * 覆写模式入口：对比已有 Odoo 列表与新输入，精确删除多余行后在末尾追加新内容。
 *
 * 流程：
 * 1. 读取已有行的产品型号
 * 2. 删除型号不在新输入列表里的行，以及指定折扣但现有折扣不一致的行（精确匹配）
 * 3. 把新输入中有、但已有列表中无的项追加到表格末尾
 *
 * 注意：对未指定折扣的输入行，沿用原行为——保留已有匹配行且不读取、不清零其折扣。
 */
export async function overwriteQuotation(
  parts: WrittenPart[],
): Promise<WriteResult> {
  await ensureTableReady();

  const newMap = new Map(parts.map((p) => [p.partModel, p]));

  // 2. 删除：型号不在新列表中，或指定折扣但现有折扣不一致的行
  const rows = getDataRows();
  for (const row of rows) {
    const productCell = row.querySelector(PRODUCT_CELL_SELECTOR);
    const productName = (productCell?.textContent ?? '').trim();
    if (!productName) continue;
    const want = newMap.get(productName);
    let shouldRemove = !want;
    if (want && want.discount !== undefined) {
      const saved = readDiscountFromRow(row);
      if (saved === undefined || saved !== want.discount) shouldRemove = true;
    }
    if (shouldRemove) {
      const countBefore = getDataRows().length;
      removeRow(row);
      // 动态等待数据行数减少
      await waitForCountDecrease(QUOTATION_DATA_ROW_SELECTOR, countBefore, 5000);
    }
  }

  // 3. 保留行（未被删除的）视为已写入；不在保留列表中的输入行追加
  const keptProducts = new Set(getExistingProducts());
  const partsToAdd = parts.filter(
    (p) => !keptProducts.has(p.partModel),
  );

  if (partsToAdd.length === 0) {
    return {
      successCount: parts.length - partsToAdd.length,
      unfilledParts: [],
    };
  }

  // 4. 追加新项
  return writePartsToQuotation(partsToAdd);
}

/** 从已保存行读取折扣百分比（无折扣单元格或无法解析时返回 undefined） */
function readDiscountFromRow(row: Element): number | undefined {
  const cell = row.querySelector(DETAIL_DISCOUNT_CELL_SELECTOR);
  if (!cell) return undefined;
  const parsed = Number.parseFloat((cell.textContent ?? '').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}
