/**
 * 环境变量配置 —— auto 服务
 *
 * 从 .env 加载并校验必填项。缺失必填项时启动报错。
 */

import 'dotenv/config';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`缺少必填环境变量：${key}（请参考 .env.example）`);
  }
  return v;
}

function getBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

export interface AutoConfig {
  serverUrl: string;
  workerToken: string;
  profileDir: string;
  odooBaseUrl: string;
  headless: boolean;
}

function loadConfig(): AutoConfig {
  return {
    serverUrl: requireEnv('AUTO_SERVER_URL'),
    workerToken: requireEnv('AUTO_WORKER_TOKEN'),
    profileDir: requireEnv('AUTO_PROFILE_DIR'),
    odooBaseUrl: requireEnv('ODOO_BASE_URL'),
    headless: getBool('AUTO_HEADLESS', false),
  };
}

export const appConfig = loadConfig();
