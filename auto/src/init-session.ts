/**
 * 首次会话初始化脚本
 *
 * 启动 headed Chromium，打开 Odoo，提示用户手动登录，
 * 用户登录完成后按回车关闭浏览器，profile 自动保存到 AUTO_PROFILE_DIR。
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { appConfig } from './config.js';

async function main(): Promise<void> {
  console.log('[init-session] 启动 headed Chromium...');
  console.log(`[init-session] profile 目录: ${appConfig.profileDir}`);
  console.log(`[init-session] Odoo 入口: ${appConfig.odooBaseUrl}`);

  const context = await chromium.launchPersistentContext(appConfig.profileDir, {
    headless: false,
    viewport: null,
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(appConfig.odooBaseUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n========================================');
  console.log('请在打开的浏览器窗口中完成 Odoo 登录。');
  console.log('登录成功后，回到此终端按回车保存 profile 并退出。');
  console.log('========================================\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  await rl.question('登录完成后按回车继续...');
  rl.close();

  await context.close();
  console.log('[init-session] profile 已保存，可以运行 npm start 启动 auto 服务。');
}

main().catch((err) => {
  console.error('[init-session] 失败:', err);
  process.exit(1);
});
