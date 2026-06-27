/**
 * 轻量级 fetch 封装：自动带 Authorization 头 + credentials: 'include' + 401 自动刷新并重试
 *
 * 用法：替换原生 fetch()，其余完全兼容。
 *   import { fetchWithAuth } from '../lib/fetchWithAuth';
 *   const res = await fetchWithAuth('/api/chat', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify(payload),
 *   });
 *
 * credentials: 'include' 确保浏览器自动携带 HttpOnly Cookie（refresh token），
 * 使服务端 /api/auth/refresh 和 /api/auth/logout 能读取到 Cookie。
 *
 * 并发去重：多个同时 401 的请求仅触发一次 token 刷新，
 * 其余请求等待刷新完成后使用新的 access token 重试。
 */

import { useAuthStore } from '../stores/authStore';

/** 保证多个并发 401 只触发一次 token 刷新 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessTokenOnce(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = useAuthStore
    .getState()
    .refreshAuth()
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

/** 替换常规 fetch，自动附带 Authorization 头 + credentials: 'include'，遇到 401 自动刷新并重试一次 */
export async function fetchWithAuth(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(options?.headers);
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  // credentials: 'include' 确保 HttpOnly Cookie 随请求发送
  let res = await fetch(url, { ...options, headers, credentials: 'include' });

  // Access token 过期 → 用 Cookie 中的 refresh token 换新双 token → 重试
  if (res.status === 401) {
    const ok = await refreshAccessTokenOnce();
    if (ok) {
      const newToken = useAuthStore.getState().accessToken;
      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`);
      }
      res = await fetch(url, { ...options, headers, credentials: 'include' });
    }
  }

  return res;
}
