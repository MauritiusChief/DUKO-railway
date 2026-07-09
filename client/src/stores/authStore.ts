/**
 * 认证状态管理 —— Zustand store
 *
 * 管理 Access Token（localStorage）与用户信息，提供登录/注册/登出/自动刷新方法。
 *
 * 安全策略：
 *  - Access Token 存 localStorage（15 分钟过期，XSS 窃取影响有限）
 *  - Refresh Token 通过 HttpOnly Cookie 传输，JS 不可读，防御 XSS 窃取
 *  - 用户信息不落地 localStorage，每次页面刷新通过 /api/me 从服务端重新获取，
 *    防止通过修改 localStorage 伪造角色绕过前端 AdminGuard
 */

import { create } from 'zustand';

/** 用户信息（不含密码哈希） */
export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
}

/** 登录 / 刷新响应结构（refresh token 通过 HttpOnly Cookie 下发，不在 body 中） */
interface AuthTokenResponse {
  accessToken: string;
  user?: AuthUser;
}

interface AuthState {
  /** Access Token（15 分钟过期，存 localStorage 防刷新丢失） */
  accessToken: string | null;
  /** 当前登录用户（仅内存，不持久化，防 localStorage 篡改） */
  user: AuthUser | null;
  /** 用户身份是否已通过服务端 /api/me 确认 */
  userVerified: boolean;
  /** 是否正在登录/注册 */
  loading: boolean;
  /** 登录/注册错误信息 */
  error: string;
  /** 登录：提交凭据，获取 access token（refresh token 自动写入 Cookie） */
  login: (username: string, password: string) => Promise<void>;
  /** 管理员注册新用户（需要已登录的管理员 token） */
  register: (username: string, password: string) => Promise<void>;
  /** 登出：调服务端无效化 refresh token + 清除 Cookie + 清除本地状态 */
  logout: () => Promise<void>;
  /** 刷新：用 Cookie 中的 refresh token 换新 access token，返回是否成功 */
  refreshAuth: () => Promise<boolean>;
  /** 向服务端确认当前用户身份，防止 localStorage 角色篡改 */
  loadMe: () => Promise<void>;
  /** 获取带 Authorization 头的请求头对象（使用 access token） */
  getAuthHeaders: () => Record<string, string>;
}

const ACCESS_TOKEN_KEY = 'duko_access_token';
/** 保留旧 key 常量以便 clearSession 清理遗留数据 */
const USER_KEY = 'duko_auth_user';

/** 从 localStorage 仅恢复 accessToken（不再恢复用户信息，防止篡改） */
function loadSession(): { accessToken: string | null } {
  try {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    return { accessToken: accessToken || null };
  } catch {
    return { accessToken: null };
  }
}

/** 持久化 accessToken 到 localStorage（不持久化用户信息） */
function saveSession(accessToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

/** 清除 localStorage 中的会话（同时清理历史遗留的 USER_KEY） */
function clearSession(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

const session = loadSession();

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: session.accessToken,
  user: null,
  userVerified: false,
  loading: false,
  error: '',

  login: async (username, password) => {
    set({ loading: true, error: '' });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as AuthTokenResponse & { error?: string };

      if (!res.ok) {
        set({ loading: false, error: data.error || '登录失败' });
        return;
      }

      saveSession(data.accessToken);
      set({
        accessToken: data.accessToken,
        user: data.user!,
        userVerified: true, // 登录响应来自服务端，身份可信
        loading: false,
        error: '',
      });
    } catch {
      set({ loading: false, error: '网络错误，请稍后重试' });
    }
  },

  register: async (username, password) => {
    set({ loading: true, error: '' });
    try {
      const { accessToken } = get();
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        set({ loading: false, error: data.error || '注册失败' });
        return;
      }

      set({ loading: false, error: '' });
    } catch {
      set({ loading: false, error: '网络错误，请稍后重试' });
    }
  },

  logout: async () => {
    try {
      // 通知服务端无效化 refresh token + 清除 Cookie（fire-and-forget）
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      /* 网络错误不阻塞本地登出 */
    }
    clearSession();
    set({ accessToken: null, user: null, userVerified: false, error: '' });
  },

  /** 用 Cookie 中的 refresh token 换取新的 access token（rotation），返回是否成功 */
  refreshAuth: async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) {
        await get().logout();
        return false;
      }

      const data = (await res.json()) as AuthTokenResponse;
      saveSession(data.accessToken);
      set({
        accessToken: data.accessToken,
        user: data.user ?? get().user,
        // 不设置 userVerified —— 角色的最终确认统一由 loadMe() 负责
      });
      return true;
    } catch {
      await get().logout();
      return false;
    }
  },

  /** 通过 /api/me 从服务端获取当前用户真实角色，防止 localStorage 角色篡改 */
  loadMe: async () => {
    try {
      const { accessToken } = get();
      if (!accessToken) {
        set({ userVerified: true });
        return;
      }

      let res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        credentials: 'include',
      });

      // Access token 过期 → 刷新后重试
      if (res.status === 401) {
        const ok = await get().refreshAuth();
        if (ok) {
          const newToken = get().accessToken;
          if (newToken) {
            res = await fetch('/api/me', {
              headers: { Authorization: `Bearer ${newToken}` },
              credentials: 'include',
            });
          }
        }
      }

      // 401（刷新失败）、404（用户已被删除）、其他服务端错误 → 清理会话
      if (!res.ok) {
        await get().logout();
        return;
      }

      const data = (await res.json()) as { user: AuthUser };
      set({ user: data.user, userVerified: true });
    } catch {
      // 网络错误，不阻塞 UI —— 标记已验证（user 保持 null，AdminGuard 将重定向到首页）
      set({ userVerified: true });
    }
  },

  getAuthHeaders: () => {
    const { accessToken } = get();
    return accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : ({} as Record<string, string>);
  },
}));
