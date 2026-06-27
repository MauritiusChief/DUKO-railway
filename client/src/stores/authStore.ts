/**
 * 认证状态管理 —— Zustand store
 *
 * 管理 Access Token（localStorage）与用户信息，提供登录/注册/登出/自动刷新方法。
 *
 * 安全策略：
 *  - Access Token 存 localStorage（15 分钟过期，XSS 窃取影响有限）
 *  - Refresh Token 通过 HttpOnly Cookie 传输，JS 不可读，防御 XSS 窃取
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
  /** 当前登录用户 */
  user: AuthUser | null;
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
  /** 获取带 Authorization 头的请求头对象（使用 access token） */
  getAuthHeaders: () => Record<string, string>;
}

const ACCESS_TOKEN_KEY = 'duko_access_token';
const USER_KEY = 'duko_auth_user';

/** 从 localStorage 恢复会话 */
function loadSession(): { accessToken: string | null; user: AuthUser | null } {
  try {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    const userRaw = localStorage.getItem(USER_KEY);
    if (accessToken && userRaw) {
      const user = JSON.parse(userRaw) as AuthUser;
      return { accessToken, user };
    }
  } catch {
    /* 数据损坏，静默清除 */
  }
  return { accessToken: null, user: null };
}

/** 持久化会话到 localStorage */
function saveSession(accessToken: string, user: AuthUser): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** 清除 localStorage 中的会话 */
function clearSession(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

const session = loadSession();

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: session.accessToken,
  user: session.user,
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

      saveSession(data.accessToken, data.user!);
      set({
        accessToken: data.accessToken,
        user: data.user!,
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
    set({ accessToken: null, user: null, error: '' });
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
      const user = data.user ?? get().user;
      if (user) saveSession(data.accessToken, user);
      else localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
      set({
        accessToken: data.accessToken,
        user: user ?? get().user,
      });
      return true;
    } catch {
      await get().logout();
      return false;
    }
  },

  getAuthHeaders: () => {
    const { accessToken } = get();
    return accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : ({} as Record<string, string>);
  },
}));
