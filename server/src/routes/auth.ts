/**
 * 认证路由 —— 登录 / 注册 / Token 刷新 / 登出
 *
 * POST /api/auth/login    —— 凭据验证 + 签发 access token，refresh token 通过 HttpOnly Cookie 下发
 * POST /api/auth/register —— 管理员创建新用户（需 admin 角色）
 * POST /api/auth/refresh  —— 从 Cookie 读取 refresh token，旋转后下发新 access token + 新 Cookie
 * POST /api/auth/logout   —— 撤销 refresh token 并清除 Cookie
 *
 * GET /api/me —— 已迁移到 index.ts 单独挂载（使用 apiLimiter 而非 authLimiter）
 */

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  authenticateToken,
  requireAdmin,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  storeRefreshToken,
  isRefreshTokenValid,
  revokeRefreshToken,
  getRefreshCookie,
  setRefreshCookie,
  clearRefreshCookie,
  type JwtPayload,
} from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, registerSchema } from '../validation/schemas.js';
import { findUserByUsername, findUserById, createUser } from '../db/users.js';

export const authRouter = Router();

const SALT_ROUNDS = 12;

/** POST /api/auth/login —— 验证凭据，返回 access token + 用户信息，refresh token 写入 HttpOnly Cookie */
authRouter.post('/auth/login', validate(loginSchema), (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };

  const user = findUserByUsername(username);
  if (!user) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }

  const payload: JwtPayload = {
    userId: user.id,
    username: user.username,
    role: user.role,
  };

  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);
  storeRefreshToken(user.id, refreshToken);

  // refresh token 仅通过 HttpOnly Cookie 下发，不在 JSON body 中暴露
  setRefreshCookie(res, refreshToken);

  res.json({
    accessToken,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      created_at: user.created_at,
    },
  });
});

/** POST /api/auth/register —— 管理员创建新用户 */
authRouter.post(
  '/auth/register',
  authenticateToken,
  requireAdmin,
  validate(registerSchema),
  (req: Request, res: Response) => {
    const { username, password } = req.body as { username: string; password: string };

    const existing = findUserByUsername(username);
    if (existing) {
      res.status(409).json({ error: '用户名已存在' });
      return;
    }

    const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
    const user = createUser(username, passwordHash);

    res.status(201).json({ user });
  },
);

/** POST /api/auth/refresh —— 从 Cookie 读取 refresh token，旋转后返回新 access token + 新 Cookie */
authRouter.post('/auth/refresh', (req: Request, res: Response) => {
  const refreshToken = getRefreshCookie(req);

  if (!refreshToken) {
    res.status(401).json({ error: '未提供 refresh token（Cookie 缺失或已过期）' });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Refresh token 无效或已过期' });
    return;
  }

  if (!isRefreshTokenValid(payload.userId, refreshToken)) {
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Refresh token 已被撤销（可能已在别处使用）' });
    return;
  }

  // Rotation：立即删除旧的 refresh token，签发新的
  revokeRefreshToken(payload.userId, refreshToken);

  // jwt.verify 返回的对象含 exp/iat 等 JWT 标准字段，
  // 重新签名须构造干净 payload，否则 jsonwebtoken 拒绝覆盖已有 exp 属性
  const signPayload: JwtPayload = {
    userId: payload.userId,
    username: payload.username,
    role: payload.role,
  };

  const newAccessToken = generateAccessToken(signPayload);
  const newRefreshToken = generateRefreshToken(signPayload);
  storeRefreshToken(signPayload.userId, newRefreshToken);
  setRefreshCookie(res, newRefreshToken);

  // 查询最新用户信息返回
  const user = findUserById(signPayload.userId);

  res.json({
    accessToken: newAccessToken,
    user: user ?? undefined,
  });
});

/** POST /api/auth/logout —— 从 Cookie 读取 refresh token 并撤销，清除 Cookie */
authRouter.post('/auth/logout', (req: Request, res: Response) => {
  const refreshToken = getRefreshCookie(req);

  if (refreshToken) {
    // 尝试验证并撤销：即使 token 已过期也尝试清理内存
    try {
      const payload = verifyRefreshToken(refreshToken);
      revokeRefreshToken(payload.userId, refreshToken);
    } catch {
      // refresh token 已过期或无效，无需额外操作
    }
  }

  clearRefreshCookie(res);
  res.json({ message: '已登出' });
});

/** GET /api/me handler —— 导出供 index.ts 单独挂载 */
export function meHandler(req: Request, res: Response): void {
  const user = findUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json({ user });
}
