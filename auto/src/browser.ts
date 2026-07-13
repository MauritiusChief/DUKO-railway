/**
 * 浏览器管理 —— 每任务启动 / 关闭 persistent Chromium
 *
 * 使用 launchPersistentContext 加载 AUTO_PROFILE_DIR 中保留的 Odoo 登录态。
 * 每个任务结束后关闭 context，但 userDataDir 保留以便下次复用。
 *
 * Odoo 报价填写逻辑（步骤 5-6）暂未实现；当前仅完成：
 *  - 启动浏览器
 *  - 检测 Odoo 登录状态
 *  - 上报占位结果
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { appConfig } from './config.js';
import type { QuotationTask, LineResult } from './protocol.js';

/** 单个任务执行的最终结果 */
export interface TaskOutcome {
  status: 'completed' | 'partial_failed' | 'failed';
  error?: string;
  lineResults: LineResult[];
}

/**
 * 执行一个报价任务：
 * 1. 启动 persistent headed Chromium
 * 2. 检测 Odoo 登录状态
 * 3. （占位）逐行处理 —— 当前全部标记为 pending 并以 failed 返回
 * 4. 关闭 context（profile 保留）
 *
 * @param onLineResult 每行完成时回调（用于立即上报 server）
 */
export async function runQuotationTask(
  task: QuotationTask,
  onLineResult: (result: LineResult) => Promise<void>,
): Promise<TaskOutcome> {
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(appConfig.profileDir, {
      headless: appConfig.headless,
      viewport: null,
    });

    const page = await context.newPage();

    // 打开 Odoo 入口并检测登录状态
    const loginCheck = await checkOdooLogin(page);
    if (!loginCheck.loggedIn) {
      return {
        status: 'failed',
        error: 'Odoo 登录状态失效，请联系技术部门',
        lineResults: [],
      };
    }

    // ===== 步骤 5-6 在此插入 Odoo 报价操作 =====
    // 当前为占位：所有行标记为失败（未实现）
    const lineResults: LineResult[] = [];
    for (const line of task.lines) {
      const result: LineResult = {
        lineNo: line.lineNo,
        status: 'failed',
        error: '报价填写逻辑尚未实现（步骤 5-6）',
      };
      await onLineResult(result);
      lineResults.push(result);
    }

    const anySuccess = lineResults.some((l) => l.status === 'success');
    const anyFailed = lineResults.some((l) => l.status === 'failed');
    const finalStatus: TaskOutcome['status'] = anySuccess && anyFailed
      ? 'partial_failed'
      : anySuccess
        ? 'completed'
        : 'failed';

    return { status: finalStatus, lineResults };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      error: `浏览器异常：${message}`,
      lineResults: [],
    };
  } finally {
    // 关闭 context（profile 自动保留在 AUTO_PROFILE_DIR）
    if (context) {
      try {
        await context.close();
      } catch {
        // 关闭失败不影响已上报的结果
      }
    }
  }
}

/**
 * 检测 Odoo 是否处于已登录状态。
 * 检测方法：访问入口页后，检查 URL 是否跳转到 /web/login 或页面存在登录表单。
 */
async function checkOdooLogin(page: Page): Promise<{ loggedIn: boolean }> {
  await page.goto(appConfig.odooBaseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {
    // networkidle 超时不一定代表未登录，继续用 URL/DOM 判断
  }

  const currentUrl = page.url();
  const isLoginUrl = currentUrl.includes('/web/login');

  let hasLoginForm = false;
  try {
    hasLoginForm = (await page.locator('.oe_login_form').count()) > 0;
  } catch {
    // 选择器查询失败，保守视为未登录
    hasLoginForm = false;
  }

  return { loggedIn: !isLoginUrl && !hasLoginForm };
}
