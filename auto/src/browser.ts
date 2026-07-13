/**
 * 浏览器管理 —— 每任务启动 / 关闭 persistent Chromium
 *
 * 使用 launchPersistentContext 加载 AUTO_PROFILE_DIR 中保留的 Odoo 登录态。
 * 每个任务结束后关闭 context，但 userDataDir 保留以便下次复用。
 *
 * 任务流程（步骤 5-6）：
 *   1. 启动浏览器 + 检测登录
 *   2. 导航到 /odoo/sales，移除 "My Quotations" facet
 *   3. 搜索报价单 → 打开首结果
 *   4. 核验单号 + 读取公司 + 读取已有行
 *   5. 通过 callbacks.requestConfirmation 向用户请求确认
 *   6. 确认后写入（append/overwrite），逐行回调 onLineResult
 *   7. 再次读取 Odoo 表格最终快照 → 随 task-completed 上报
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { appConfig } from './config.js';
import type {
  QuotationTask,
  LineResult,
  QuotationSnapshotLine,
} from './protocol.js';
import { navigateToSales, removeMyQuotationsFacet, searchQuotation, getSearchResultCount, openFirstResult } from './odoo/sales-search.js';
import { verifyQuotation, readExistingLines, type QuotationVerification } from './odoo/quotation-verify.js';
import { writeLines, type WriteLineResult } from './odoo/write-lines.js';

/** 确认请求载荷 */
export interface ConfirmationRequest {
  company: string
  quotationNumber: string
  existingLines: QuotationSnapshotLine[]
  inputLines: { partModel: string; quantity: number }[]
}

/** 确认结果 */
export type ConfirmationResult = 'confirmed' | 'rejected' | 'timeout';

/** 浏览器任务回调 */
export interface BrowserCallbacks {
  onLineResult: (result: LineResult) => Promise<void>
  requestConfirmation: (req: ConfirmationRequest) => Promise<ConfirmationResult>
}

/** 单个任务执行的最终结果 */
export interface TaskOutcome {
  status: 'completed' | 'partial_failed' | 'failed';
  error?: string;
  lineResults: LineResult[];
  finalSnapshot?: QuotationSnapshotLine[];
}

/**
 * 执行一个报价任务（完整流程）。
 */
export async function runQuotationTask(
  task: QuotationTask,
  callbacks: BrowserCallbacks,
): Promise<TaskOutcome> {
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(appConfig.profileDir, {
      headless: appConfig.headless,
      viewport: null,
    });

    const page = await context.newPage();

    // ---- 1. 检测 Odoo 登录状态 ----
    const loginCheck = await checkOdooLogin(page);
    if (!loginCheck.loggedIn) {
      return {
        status: 'failed',
        error: 'Odoo 登录状态失效，请联系技术部门',
        lineResults: [],
      };
    }

    // ---- 2. 导航到 /odoo/sales，移除 "My Quotations" facet ----
    const searchResult = await navigateAndSearch(page, task.quotationNumber);

    // ---- 3. 核验报价单 + 读取公司 + 已有行 ----
    let verification: QuotationVerification;
    try {
      verification = await verifyQuotation(page, task.quotationNumber);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        error: message,
        lineResults: [],
      };
    }

    // ---- 4. 用户确认握手 ----
    const inputLines = task.lines.map((l) => ({
      partModel: l.partModel,
      quantity: l.quantity,
    }));

    const confirmResult = await callbacks.requestConfirmation({
      company: verification.company,
      quotationNumber: verification.quotationNumber,
      existingLines: verification.existingLines,
      inputLines,
    });

    if (confirmResult !== 'confirmed') {
      const errorMsg = confirmResult === 'rejected'
        ? '用户在确认环节拒绝了报价单'
        : '用户确认超时';
      return {
        status: 'failed',
        error: errorMsg,
        lineResults: [],
      };
    }

    // ---- 5. 逐行写入 ----
    const lineResults: LineResult[] = [];

    await writeLines(page, {
      mode: task.writeMode,
      lines: task.lines,
      onLineResult: async (wlr: WriteLineResult) => {
        const result: LineResult = {
          lineNo: wlr.lineNo,
          status: wlr.status,
          error: wlr.error,
        };
        lineResults.push(result);
        await callbacks.onLineResult(result);
      },
    });

    // ---- 6. 读取最终快照（从 Odoo 页面表格） ----
    let finalSnapshot: QuotationSnapshotLine[] = [];
    try {
      finalSnapshot = await readExistingLines(page);
    } catch {
      // 即使快照读取失败，也不影响已写入的结果上报
    }

    // ---- 7. 计算最终状态 ----
    const anySuccess = lineResults.some((l) => l.status === 'success');
    const anyFailed = lineResults.some((l) => l.status === 'failed');
    const finalStatus: TaskOutcome['status'] = anySuccess && anyFailed
      ? 'partial_failed'
      : anySuccess
        ? 'completed'
        : 'failed';

    return { status: finalStatus, lineResults, finalSnapshot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      error: `浏览器异常：${message}`,
      lineResults: [],
    };
  } finally {
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * 导航到 /odoo/sales，搜索报价单并打开首结果。
 * 若搜索无结果，抛出错误（调用方转为 task-failed）。
 */
async function navigateAndSearch(page: Page, quotationNumber: string): Promise<'ok'> {
  await navigateToSales(page);
  await removeMyQuotationsFacet(page);
  await searchQuotation(page, quotationNumber);

  const count = await getSearchResultCount(page);
  if (count === 0) {
    throw new Error('未找到该报价单');
  }

  await openFirstResult(page);
  return 'ok';
}

/**
 * 检测 Odoo 是否处于已登录状态。
 */
async function checkOdooLogin(page: Page): Promise<{ loggedIn: boolean }> {
  await page.goto(appConfig.odooBaseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {
    // networkidle 超时不一定代表未登录
  }

  const currentUrl = page.url();
  const isLoginUrl = currentUrl.includes('/web/login');

  let hasLoginForm = false;
  try {
    hasLoginForm = (await page.locator('.oe_login_form').count()) > 0;
  } catch {
    hasLoginForm = false;
  }

  return { loggedIn: !isLoginUrl && !hasLoginForm };
}
