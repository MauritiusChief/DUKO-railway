/**
 * 浏览器管理 —— 每任务启动 / 关闭 persistent Chromium
 *
 * 使用 launchPersistentContext 加载 AUTO_PROFILE_DIR 中保留的 Odoo 登录态。
 * 每个任务结束后关闭 context，但 userDataDir 保留以便下次复用。
 *
 * 任务流程（步骤 5-6）：
 *   1. 启动浏览器 + 检测登录
 *   2. 导航到 /odoo/sales，移除 "My Quotations" facet
 *   3. 搜索报价单 → 打开精确匹配结果
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
import { navigateToSales, removeMyQuotationsFacet, searchQuotation, countExactMatches, openExactMatch } from './odoo/sales-search.js';
import { verifyQuotation, readExistingLines, type QuotationVerification } from './odoo/quotation-verify.js';
import { writeLines, type WriteLineResult } from './odoo/write-lines.js';
import { verifyFinalLines } from './odoo/verify-lines.js';
import { FORM_SAVE_BUTTON, DETAIL_QUOTATION_NUMBER } from './odoo/selectors.js';

/** 确认请求载荷 */
export interface ConfirmationRequest {
  company: string
  quotationNumber: string
  existingLines: QuotationSnapshotLine[]
  inputLines: { partModel: string; quantity: number; discount?: number }[]
}

/** 确认结果 */
export type ConfirmationResult = 'confirmed' | 'rejected' | 'timeout';

/** 浏览器任务回调 */
export interface BrowserCallbacks {
  onLineResult: (result: LineResult) => Promise<void>
  requestConfirmation: (req: ConfirmationRequest) => Promise<ConfirmationResult>
  onProgress: (message: string) => Promise<void>
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
 *
 * @param abortSignal 可选的中止信号；触发 abort 时会立即关闭浏览器上下文，
 *                   已在飞行中的 Playwright 操作将抛错并被捕获，转为 failed 结果。
 *                   用于 Worker 断线时尽快终止浏览器任务。
 */
export async function runQuotationTask(
  task: QuotationTask,
  callbacks: BrowserCallbacks,
  abortSignal?: AbortSignal,
): Promise<TaskOutcome> {
  let context: BrowserContext | null = null;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    if (context) {
      // 关闭上下文会使所有在飞 Playwright 操作立即拒绝
      context.close().catch(() => { /* 已在关闭则忽略 */ });
    }
  };
  abortSignal?.addEventListener('abort', onAbort);

  try {
    if (abortSignal?.aborted) {
      aborted = true;
      return {
        status: 'failed',
        error: 'worker 断线，任务中止',
        lineResults: [],
      };
    }

    context = await chromium.launchPersistentContext(appConfig.profileDir, {
      headless: appConfig.headless,
      viewport: null,
      slowMo: 1_000,
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

    // ---- 2. 导航到目标报价单 ----
    // 若提供精准 Odoo 地址则优先直接进入详情页，失败回退到销售列表搜索
    if (task.odooUrl) {
      try {
        await callbacks.onProgress('NAVIGATING DIRECTLY TO THE PROVIDED ODOO URL...');
        await page.goto(task.odooUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page.waitForSelector(DETAIL_QUOTATION_NUMBER, {
          state: 'visible',
          timeout: 15_000,
        });
        await callbacks.onProgress('DIRECT ODOO URL NAVIGATION SUCCEEDED');
      } catch {
        await callbacks.onProgress('DIRECT ODOO URL NAVIGATION FAILED; FALLING BACK TO SEARCH');
        await navigateAndSearch(page, task.quotationNumber);
      }
    } else {
      await navigateAndSearch(page, task.quotationNumber);
    }

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
      ...(l.discount !== undefined ? { discount: l.discount } : {}),
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

    // ---- 5.5 若 Odoo 页面存在手动保存按钮，点击以确保写入已同步 ----
    await tryManualSave(page, callbacks.onProgress);

    // ---- 6. 读取最终快照（从 Odoo 页面表格） ----
    let finalSnapshot: QuotationSnapshotLine[] = [];
    try {
      finalSnapshot = await readExistingLines(page);
    } catch {
      // 即使快照读取失败，也不影响已写入的结果上报
    }

    // ---- 6.5 整表校验：逐条在日志反应多了/少了/不一致（不改行状态） ----
    try {
      const issues = verifyFinalLines(task.lines, finalSnapshot, verification.existingLines, task.writeMode);
      for (const issue of issues) {
        await callbacks.onProgress(issue.message);
      }
    } catch {
      // 校验失败不影响已写入的结果上报
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
    const message = aborted
      ? 'worker 断线，任务中止'
      : `浏览器异常：${err instanceof Error ? err.message : String(err)}`;
    return {
      status: 'failed',
      error: message,
      lineResults: [],
    };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * 导航到 /odoo/sales，搜索报价单并打开精确匹配结果。
 * 若搜索无精确匹配，抛出"未找到该报价单"（调用方转为 task-failed）。
 */
async function navigateAndSearch(page: Page, quotationNumber: string): Promise<void> {
  await navigateToSales(page);
  await removeMyQuotationsFacet(page);
  await searchQuotation(page, quotationNumber);

  const matchCount = await countExactMatches(page, quotationNumber);
  if (matchCount === 0) {
    throw new Error('未找到该报价单');
  }

  await openExactMatch(page, quotationNumber);
}

/**
 * 检测 Odoo 是否处于已登录状态。
 *
 * 不依赖 networkidle（Odoo 的长连接/轮询会让它长时间不进入 idle）。
 * 改为等待"登录表单"或"已登录应用外壳"任一可见，再据其存在判断。
 */
export async function checkOdooLogin(page: Page): Promise<{ loggedIn: boolean }> {
  await page.goto(appConfig.odooBaseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  const loginForm = page.locator('.oe_login_form');
  const appShell = page.locator('body.o_web_client, .o_navbar').first();

  // 竞速等待任一标志性元素可见，最多 20s
  await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    appShell.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
  ]);

  const hasLoginForm = (await loginForm.count()) > 0;
  const hasAppShell = (await appShell.count()) > 0;

  return { loggedIn: !hasLoginForm && hasAppShell };
}

/**
 * 若 Odoo 页面存在手动保存按钮（表单 dirty 时出现），点击保存并等待完成。
 * 不存在则跳过（已自动保存）。每步通过 onProgress 回调写入日志。
 */
async function tryManualSave(
  page: Page,
  onProgress?: (message: string) => Promise<void>,
): Promise<void> {
  const saveButton = page.locator(FORM_SAVE_BUTTON)
  if ((await saveButton.count()) === 0) {
    await onProgress?.('NO MANUAL SAVE BUTTON DETECTED (MAY ALREADY BE SAVED)')
    return
  }

  await onProgress?.('SAVING...')
  try {
    await saveButton.first().click()
    // 等待保存完成：按钮消失（hidden 涵盖 detached + 隐藏）
    await saveButton.first().waitFor({ state: 'hidden', timeout: 15_000 })
    await onProgress?.('SAVED')
  } catch {
    await onProgress?.('SAVE WAIT TIMED OUT; CONTINUING')
  }
}
