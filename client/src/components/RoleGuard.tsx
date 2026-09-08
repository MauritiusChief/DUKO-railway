/**
 * 角色路由守卫组件
 *
 * 包裹仅限指定角色访问的页面（如库存看板仅 manager / admin）：
 *  - 未登录时重定向到 /login，并将当前路径保存为 redirect 参数
 *  - 已登录但角色不匹配时重定向到 /（系统主页面）
 *  - 通过 /api/me 从服务端确认用户角色后再渲染，防止篡改 localStorage 绕过权限
 */

import { type ReactNode, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

interface RoleGuardProps {
  /** 允许访问的角色列表 */
  allowedRoles: Array<'admin' | 'manager' | 'user'>;
  children: ReactNode;
}

export default function RoleGuard({ allowedRoles, children }: RoleGuardProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const userVerified = useAuthStore((s) => s.userVerified);
  const loadMe = useAuthStore((s) => s.loadMe);
  const location = useLocation();

  useEffect(() => {
    if (accessToken && !userVerified) {
      loadMe();
    }
  }, [accessToken, userVerified, loadMe]);

  if (!accessToken) {
    const redirect = location.pathname + location.search;
    return (
      <Navigate
        to={`/login?redirect=${encodeURIComponent(redirect)}`}
        replace
      />
    );
  }

  if (!userVerified) {
    return (
      <div className="admin-guard-loading">
        <p>正在验证身份...</p>
      </div>
    );
  }

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
