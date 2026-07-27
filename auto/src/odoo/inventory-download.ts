/**
 * Odoo 产品列表页（/odoo/products）CSV 导出流程
 *
 * 步骤（与 experiment/html/manul-download-data-*..html 注释一致）：
 *   1. 勾选表头"全选当前页"复选框
 *   2. 点击 "Select all" 把选择扩展到全部记录
 *   3. 点击 Actions 齿轮下拉
 *   4. 点击 Export 菜单项
 *   5. 选择 "Inventory 核对" 导出模板（自动选中 6 列）
 *   6. 选 CSV 格式并点 Export → 捕获下载 → 返回 CSV 文本
 *
 * 全程用 waitForSelector / waitForEvent 等待目标就绪，不盲点（Odoo 较慢）。
 */

import type { Page } from 'playwright'
import { readFileSync } from 'fs'
import { appConfig } from '../config.js'
import {
  PRODUCT_SELECT_ALL_CHECKBOX,
  PRODUCT_SELECT_ALL_DOMAIN_BUTTON,
  PRODUCT_SELECTION_BOX,
  PRODUCT_ACTIONS_DROPDOWN,
  PRODUCT_EXPORT_MENU_ITEM,
  EXPORT_DATA_DIALOG,
  EXPORT_TEMPLATE_SELECT,
  EXPORT_FIELDS_LIST,
  EXPORT_CSV_RADIO,
  EXPORT_BUTTON,
} from './selectors.js'

const TIMEOUT = 30_000

/** 导航到 /odoo/products 并等待列表渲染完成 */
async function navigateToProducts(page: Page): Promise<void> {
  const url = `${appConfig.odooBaseUrl.replace(/\/$/, '')}/products`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT * 2 })

  try {
    await page.waitForSelector(PRODUCT_SELECT_ALL_CHECKBOX, { state: 'visible', timeout: TIMEOUT })
  } catch {
    throw new Error('导航到产品列表页失败：全选复选框未渲染')
  }
}

/**
 * 执行完整导出流程，返回下载到的 CSV 文本。
 * @param onProgress 进度回调
 */
export async function downloadProductsCsv(
  page: Page,
  onProgress: (m: string) => Promise<void>,
): Promise<string> {
  await navigateToProducts(page)

  // ---- 步骤 1：勾选表头全选（当前页） ----
  await onProgress('PRODUCTS: 勾选当前页全部项目')
  await page.locator(PRODUCT_SELECT_ALL_CHECKBOX).first().check()
  // 等待选中提示条出现
  await page.waitForSelector(PRODUCT_SELECTION_BOX, { state: 'visible', timeout: TIMEOUT })

  // ---- 步骤 2：点击 "Select all" 扩展到全部记录 ----
  await onProgress('PRODUCTS: 扩展选择到全部记录')
  const selectAllBtn = page.locator(PRODUCT_SELECT_ALL_DOMAIN_BUTTON)
  await selectAllBtn.waitFor({ state: 'visible', timeout: TIMEOUT })
  await selectAllBtn.first().click()
  // 等待 "All N selected" 全量选中状态
  await page
    .locator(PRODUCT_SELECTION_BOX)
    .filter({ hasText: /All\s+\d+\s*selected/i })
    .waitFor({ state: 'visible', timeout: TIMEOUT })

  // ---- 步骤 3：点击 Actions 齿轮下拉 ----
  await onProgress('PRODUCTS: 打开 Actions 菜单')
  const actionsBtn = page.locator(PRODUCT_ACTIONS_DROPDOWN)
  await actionsBtn.first().waitFor({ state: 'visible', timeout: TIMEOUT })
  await actionsBtn.first().click()

  // ---- 步骤 4：点击 Export 菜单项 ----
  await onProgress('PRODUCTS: 点击 Export')
  const exportItem = page.locator(PRODUCT_EXPORT_MENU_ITEM)
  await exportItem.first().waitFor({ state: 'visible', timeout: TIMEOUT })
  await exportItem.first().click()

  // ---- 步骤 5：选择 "Inventory 核对" 模板 ----
  await onProgress('PRODUCTS: 选择 Inventory 核对 模板')
  await page.waitForSelector(EXPORT_DATA_DIALOG, { state: 'visible', timeout: TIMEOUT })
  // 选择模板（按 option value=29）
  await page.selectOption(EXPORT_TEMPLATE_SELECT, '29')
  // 等待字段列表更新：qty_available 字段出现，确认模板已应用
  await page
    .locator(`${EXPORT_FIELDS_LIST} .o_export_field[data-field_id="qty_available"]`)
    .waitFor({ state: 'visible', timeout: TIMEOUT })

  // ---- 步骤 6a：选 CSV 格式 ----
  await onProgress('PRODUCTS: 选择 CSV 格式')
  await page.locator(EXPORT_CSV_RADIO).check()

  // ---- 步骤 6b：点 Export，捕获下载 ----
  await onProgress('PRODUCTS: 导出并等待下载')
  const exportBtn = page.locator(EXPORT_BUTTON)
  await exportBtn.waitFor({ state: 'visible', timeout: TIMEOUT })

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    exportBtn.click(),
  ])

  const path = await download.path()
  if (!path) {
    throw new Error('下载文件路径为空，无法读取 CSV')
  }
  const csv = readFileSync(path, 'utf-8')
  await onProgress(`PRODUCTS: 下载完成（${csv.length} 字节）`)
  return csv
}
