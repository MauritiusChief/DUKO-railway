/**
 * JWT 认证中间件
 *
 * authenticateToken —— 从 Authorization 头提取并验证 Access Token
 * requireAdmin      —— 检查已认证用户是否为管理员
 * generateAccessToken  —— 签发 Access Token（15 分钟过期）
 * generateRefreshToken —— 签发 Refresh Token（7 天过期）
 * verifyRefreshToken   —— 验证 Refresh Token 签名
 *
 * Refresh Token 存储：当前使用内存 Map，服务器重启所有 token 丢失，用户需重新登录。
 * 这是为安全性做的有意设计——等接入 Redis 或数据库后可改为持久化存储。
 *
 * bcrypt.compareSync / hashSync：当前并发不高，同步方法可接受。
 * 如果未来需高并发，建议改为异步 bcrypt.compare() + bcrypt.hash()。
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import type { UserRole } from '../db/users.js';

/** JWT payload 中携带的用户信息 */
export interface JwtPayload {
  userId: number;
  username: string;
  role: UserRole;
}

/** 扩展 Express Request，附加已认证用户信息 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ---- Access Token ----

/** 签发 Access Token，15 分钟过期，HS256 算法 */
export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtAccessSecret, {
    expiresIn: '15m',
    algorithm: 'HS256',
  });
}

/** 验证 Access Token 并将解析出的用户信息挂载到 req.user */
export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: '未提供认证令牌' });
    return;
  }

  try {
    // 显式锁定 HS256 算法，防止 alg=none 降级攻击
    const decoded = jwt.verify(token, config.jwtAccessSecret, {
      algorithms: ['HS256'],
    }) as JwtPayload;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: '认证令牌无效或已过期' });
  }
}

/** 要求当前用户为管理员，否则返回 403 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

// ---- Refresh Token ----

/** 签发 Refresh Token，7 天过期，HS256 算法 */
export function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtRefreshSecret, {
    expiresIn: '7d',
    algorithm: 'HS256',
  });
}

/** 验证 Refresh Token 签名并返回 payload —— 不检查内存存储，仅验证 JWT 有效性 */
export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtRefreshSecret, {
    algorithms: ['HS256'],
  }) as JwtPayload;
}

// ---- 内存 Refresh Token 存储 ----
//
// 服务器重启后所有 refresh token 故意丢失，用户需重新登录。
// 等拥有可靠的持久化设施（Redis 等）后再考虑将 token 存入数据库。

/** userId → 该用户当前有效的 refresh token 集合，支持多个设备登陆状态分离 */
const refreshTokenStore = new Map<number, Set<string>>();

/** 将 refresh token 存入内存 */
export function storeRefreshToken(userId: number, token: string): void {
  if (!refreshTokenStore.has(userId)) {
    refreshTokenStore.set(userId, new Set());
  }
  refreshTokenStore.get(userId)!.add(token);
}

/** 检查 refresh token 是否在内存存储中有效 */
export function isRefreshTokenValid(userId: number, token: string): boolean {
  const tokens = refreshTokenStore.get(userId);
  return tokens ? tokens.has(token) : false;
}

/** 从内存中删除指定 refresh token，返回是否找到并删除 */
export function revokeRefreshToken(userId: number, token: string): boolean {
  const tokens = refreshTokenStore.get(userId);
  if (!tokens) return false;
  const deleted = tokens.delete(token);
  if (tokens.size === 0) refreshTokenStore.delete(userId);
  return deleted;
}

/** 撤销指定用户的所有 refresh token（例如用户被禁用时调用） */
export function revokeAllUserTokens(userId: number): void {
  refreshTokenStore.delete(userId);
}

// ---- HttpOnly Cookie 工具 ----
//
// Refresh Token 通过 HttpOnly Cookie 传输，JS 不可读取，防御 XSS 窃取。
// 仅 /api/auth/* 路径会携带此 cookie（refresh / logout 端点）。
// Vite 开发代理（/api → localhost:3022）下 SameSite=Lax 正常工作。

/** Cookie 名称 */
const REFRESH_COOKIE = 'duko_refresh_token';

/** Cookie 公共选项 */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/api/auth',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  };
}

/** 从 Cookie 请求头中提取 refresh token（无 cookie-parser 依赖） */
export function getRefreshCookie(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** 设置 HttpOnly refresh token cookie（7 天过期） */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(7 * 24 * 60 * 60 * 1000));
}

/** 清除 refresh token cookie */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}
