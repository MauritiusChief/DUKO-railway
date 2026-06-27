/**
 * 路由守卫组件
 *
 * 包裹需要认证的页面。未登录时重定向到 /login 页面，
 * 并将当前请求路径保存为 redirect 参数，登录成功后跳回。
 */

import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

interface AuthGuardProps {
  children: ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const location = useLocation();

  if (!accessToken) {
    const redirect = location.pathname + location.search;
    return (
      <Navigate
        to={`/login?redirect=${encodeURIComponent(redirect)}`}
        replace
      />
    );
  }

  return <>{children}</>;
}
