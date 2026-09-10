/**
 * 速率限制中间件
 *
 * authLimiter             —— 认证端点（登录/注册），20 次 / 15 分钟
 * apiLimiter              —— 通用 API 端点，500 次 / 15 分钟
 * warehouseScanLimiter    —— 仓库扫码确认写入，2400 次 / 15 分钟
 * warehouseDecodeLimiter  —— 仓库扫码图片解码，2400 次 / 15 分钟（独立计数）
 */

import rateLimit from 'express-rate-limit';

/** 认证端点限流：防暴力破解，15 分钟内最多 20 次请求 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请 15 分钟后再试' },
});

/** 通用 API 限流：15 分钟内最多 500 次请求 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});

/** LLM API 限流：15 分钟内最多 50 次请求（DeepSeek / OpenRouter 调用昂贵） */
export const llmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'LLM 请求过于频繁，请 15 分钟后再试' },
});

/**
 * 仓库扫码确认写入限流：15 分钟内最多 2400 次请求。
 * 现场单次盘点约 1,000 条，通用 apiLimiter（500 次/15 分钟）会阻断正常作业；
 * 与解码限流使用相同额度但独立计数，避免高频图片解码消耗确认写入的配额。
 */
export const warehouseScanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '扫码请求过于频繁，请 15 分钟后再试' },
});

/**
 * 仓库扫码图片解码限流：15 分钟内最多 2400 次请求。
 * 现场约每秒两张持续 15 分钟为 1,800 次，2400 为该基线保留约三分之一短时突发余量；
 * 独立于确认写入计数。解码容量本身由双 worker、前端有界队列与硬超时控制，
 * 限流不替代容量保护。
 */
export const warehouseDecodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '解码请求过于频繁，请 15 分钟后再试' },
});
