/**
 * 速率限制中间件
 *
 * authLimiter —— 认证端点（登录/注册），20 次 / 15 分钟
 * apiLimiter  —— 通用 API 端点，500 次 / 15 分钟
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
