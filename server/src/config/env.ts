/**
 * 类型化的环境变量配置
 *
 * 将所有 process.env 读取集中于此，提供一个类型安全的配置单例。
 * 仅包含基础设施级配置（API keys、端口、特性开关）。
 *
 * 注意：对话轮数、搜索预算等 Agent 行为参数属于各 Agent 自身的配置，
 *       不由此处统一管理，而是由 Agent 构造函数参数决定。
 *
 * 数据目录解析规则（DB_DIR）：
 *   1. DB_DIR 环境变量已设置 → 直接使用（Railway 上为 /data）
 *   2. 运行环境是 dist/ 或 NODE_ENV=production → <项目根>/simvolume_data/
 *   3. 其他情况（tsx dev 模式）        → <项目根>/dev_data/
 */

import path from 'path';
import { fileURLToPath } from 'url';

function getEnv(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? '';
}

function getEnvBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function getEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

/** 根据运行时上下文解析默认数据目录 */
function resolveDataDir(): string {
  const envDir = path.dirname(fileURLToPath(import.meta.url));
  const serverDir = path.resolve(envDir, '..', '..');
  const projectRoot = path.resolve(serverDir, '..');

  const isProductionLike = envDir.split(path.sep).includes('dist') || process.env.NODE_ENV === 'production';
  const subDir = isProductionLike ? 'simvolume_data' : 'dev_data';

  return path.join(projectRoot, subDir);
}

export const config = {
  /** DeepSeek API key —— 文本类 Agent 默认使用 */
  deepseekApiKey: getEnv('DEEPSEEK_API_KEY'),

  /** OpenRouter API key —— 多模态 Agent 默认使用 */
  openrouterApiKey: getEnv('OPENROUTER_API_KEY'),

  /** HTTP 监听端口 */
  port: getEnvInt('PORT', 3023),

  /** 启动时是否自动执行数据处理管线 */
  autoProcess: getEnvBool('AUTO_PROCESS', false),

  /** 启动时是否自动将 CSV 数据导入 LanceDB */
  autoIngest: getEnvBool('AUTO_INGEST', false),

  /** 是否将对话历史写入 Markdown 日志文件 */
  chatLog: getEnvBool('CHAT_LOG', false),

  /** JWT Access Token 签名密钥（15 分钟过期）—— 无 fallback，缺失或为示例值则启动报错 */
  jwtAccessSecret: getEnv('JWT_ACCESS_SECRET'),

  /** JWT Refresh Token 签名密钥（7 天过期）—— 无 fallback，缺失或为示例值则启动报错 */
  jwtRefreshSecret: getEnv('JWT_REFRESH_SECRET'),

  /** 管理员初始账号 —— 无 fallback，缺失或为默认值则启动报错 */
  adminUsername: getEnv('ADMIN_USERNAME'),

  /** 管理员初始密码 —— 无 fallback，缺失或为默认值则启动报错 */
  adminPassword: getEnv('ADMIN_PASSWORD'),

  /** 数据目录（SQLite / LanceDB / CSV）—— DB_DIR 环境变量优先，否则根据运行上下文自动选择 */
  dbDir: getEnv('DB_DIR', resolveDataDir()),
} as const;

export type AppConfig = typeof config;

/** 启动时校验 JWT 密钥：缺失或未修改 .env.example 示例值则抛错阻止启动 */
export function validateSecrets(): void {
  const EXAMPLE_ACCESS = 'change-me-to-a-random-secret-in-production';
  const EXAMPLE_REFRESH = 'change-me-to-a-different-prod-refresh-secret';

  const empty = (s: string | undefined) =>
    !s || s === EXAMPLE_ACCESS || s === EXAMPLE_REFRESH;

  if (empty(config.jwtAccessSecret)) {
    throw new Error(
      'JWT_ACCESS_SECRET 未设置或仍为 .env.example 示例值，请在 .env 中设置强随机字符串',
    );
  }
  if (empty(config.jwtRefreshSecret)) {
    throw new Error(
      'JWT_REFRESH_SECRET 未设置或仍为 .env.example 示例值，请在 .env 中设置强随机字符串',
    );
  }
  if (config.jwtAccessSecret === config.jwtRefreshSecret) {
    throw new Error('JWT_ACCESS_SECRET 与 JWT_REFRESH_SECRET 不能相同');
  }

  // Admin 凭据校验
  if (!config.adminUsername || config.adminUsername === 'change-me-admin') {
    throw new Error(
      'ADMIN_USERNAME 未设置或仍为 .env.example 默认值，请在 .env 中修改',
    );
  }
  if (!config.adminPassword || config.adminPassword === 'change-me-admin-password') {
    throw new Error(
      'ADMIN_PASSWORD 未设置或仍为 .env.example 默认值，请在 .env 中修改',
    );
  }
  if (config.adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD 长度不足，最少 8 位');
  }
}
