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
import { loginSchema, registerSchema, adminUpdateUsernameSchema, adminUpdatePasswordSchema, adminDeleteUserSchema } from '../validation/schemas.js';
import { findUserByUsername, findUserById, createUser, listUsers, deleteUserById, updateUsername, updateUserPassword } from '../db/users.js';
import { config } from '../config/env.js';
import { apiLimiter, authLimiter } from '../middleware/rateLimit.js';

export const authRouter = Router();

const SALT_ROUNDS = 12;

/** POST /api/auth/login —— 验证凭据，返回 access token + 用户信息，refresh token 写入 HttpOnly Cookie */
authRouter.post('/login', authLimiter, validate(loginSchema), (req: Request, res: Response) => {
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
  '/register',
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
authRouter.post('/refresh', authLimiter, (req: Request, res: Response) => {
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
authRouter.post('/logout', apiLimiter, (req: Request, res: Response) => {
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

// ==================================================================
//  管理员用户管理端点
// ==================================================================

/** 辅助函数：校验管理员密码是否匹配当前登录的管理员 */
function verifyAdminPassword(req: Request, adminPassword: string): boolean {
  const admin = findUserById(req.user!.userId);
  if (!admin) return false;
  return bcrypt.compareSync(adminPassword, findUserByUsername(admin.username)!.password_hash);
}

/** 辅助函数：判断指定用户是否为种子管理员（环境变量中配置的管理员） */
function isSeedAdmin(userId: number): boolean {
  const user = findUserById(userId);
  if (!user) return false;
  return user.username === config.adminUsername;
}

/** GET /api/auth/users —— 管理员浏览所有用户列表 */
authRouter.get(
  '/users',
  authenticateToken,
  requireAdmin,
  (_req: Request, res: Response) => {
    const users = listUsers();
    res.json({ users });
  },
);

/** PATCH /api/auth/users/:id/username —— 管理员修改用户名 */
authRouter.patch(
  '/users/:id/username',
  authenticateToken,
  requireAdmin,
  validate(adminUpdateUsernameSchema),
  (req: Request, res: Response) => {
    const targetUserId = Number(req.params.id);
    if (Number.isNaN(targetUserId)) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }

    if (isSeedAdmin(targetUserId)) {
      res.status(403).json({ error: '种子管理员账户不允许修改用户名' });
      return;
    }

    const { username, adminPassword } = req.body as { username: string; adminPassword: string };

    if (!verifyAdminPassword(req, adminPassword)) {
      res.status(403).json({ error: '管理员密码错误' });
      return;
    }

    const existing = findUserByUsername(username);
    if (existing && existing.id !== targetUserId) {
      res.status(409).json({ error: '用户名已存在' });
      return;
    }

    const ok = updateUsername(targetUserId, username);
    if (!ok) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const updated = findUserById(targetUserId);
    res.json({ user: updated });
  },
);

/** PATCH /api/auth/users/:id/password —— 管理员修改密码 */
authRouter.patch(
  '/users/:id/password',
  authenticateToken,
  requireAdmin,
  validate(adminUpdatePasswordSchema),
  (req: Request, res: Response) => {
    const targetUserId = Number(req.params.id);
    if (Number.isNaN(targetUserId)) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }

    if (isSeedAdmin(targetUserId)) {
      res.status(403).json({ error: '种子管理员账户不允许修改密码' });
      return;
    }

    const { password, adminPassword } = req.body as { password: string; adminPassword: string };

    if (!verifyAdminPassword(req, adminPassword)) {
      res.status(403).json({ error: '管理员密码错误' });
      return;
    }

    const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
    const ok = updateUserPassword(targetUserId, passwordHash);
    if (!ok) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    res.json({ message: '密码已修改' });
  },
);

/** DELETE /api/auth/users/:id —— 管理员删除用户 */
authRouter.delete(
  '/users/:id',
  authenticateToken,
  requireAdmin,
  validate(adminDeleteUserSchema),
  (req: Request, res: Response) => {
    const targetUserId = Number(req.params.id);
    if (Number.isNaN(targetUserId)) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }

    if (isSeedAdmin(targetUserId)) {
      res.status(403).json({ error: '种子管理员账户不允许删除' });
      return;
    }

    const { adminPassword } = req.body as { adminPassword: string };

    if (!verifyAdminPassword(req, adminPassword)) {
      res.status(403).json({ error: '管理员密码错误' });
      return;
    }

    // 防止管理员删除自己（即便是非种子管理员）
    if (targetUserId === req.user!.userId) {
      res.status(403).json({ error: '不能删除当前登录的管理员账户' });
      return;
    }

    const ok = deleteUserById(targetUserId);
    if (!ok) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    res.json({ message: '用户已删除' });
  },
);

/** GET /api/me handler —— 导出供 index.ts 单独挂载 */
export function meHandler(req: Request, res: Response): void {
  const user = findUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json({ user });
}
