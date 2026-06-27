/**
 * 登录页面
 *
 * 提供用户名/密码登录表单。管理员登录后可见注册新用户按钮。
 * 登录成功后跳转回用户最初请求的页面（通过 URL 参数 redirect）。
 */

import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../i18n/context';
import './LoginPage.css';

export default function LoginPage() {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerSuccess, setRegisterSuccess] = useState(false);

  const { login, register, loading, error, user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    await login(username, password);
    // login 是 async，状态更新后需要读取最新的 store 值
    const accessToken = useAuthStore.getState().accessToken;
    if (accessToken) {
      const redirect = searchParams.get('redirect') || '/';
      navigate(redirect, { replace: true });
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    await register(registerUsername, registerPassword);
    const err = useAuthStore.getState().error;
    if (!err) {
      setRegisterSuccess(true);
      setRegisterUsername('');
      setRegisterPassword('');
      setTimeout(() => setRegisterSuccess(false), 3000);
    }
  };

  // 已登录状态：显示用户信息 + 可选的注册面板
  if (user) {
    const homeRedirect = searchParams.get('redirect') || '/';
    return (
      <div className="login-page">
        <div className="login-card">
          <h2>{t('已登录')}</h2>
          <p>
            {t('当前用户')}: <strong>{user.username}</strong> ({user.role === 'admin' ? t('管理员') : t('普通用户')})
          </p>
          <div className="login-actions">
            <button onClick={() => navigate(homeRedirect)}>{t('进入系统')}</button>
            {user.role === 'admin' && (
              <button onClick={() => setShowRegister(!showRegister)}>
                {showRegister ? t('取消注册') : t('注册新用户')}
              </button>
            )}
            <button onClick={() => logout()}>
              {t('登出')}
            </button>
          </div>

          {showRegister && (
            <form onSubmit={handleRegister} className="register-form">
              <h3>{t('注册新用户')}</h3>
              {registerSuccess && <p className="success-msg">{t('注册成功')}</p>}
              {error && <p className="error-msg">{error}</p>}
              <input
                type="text"
                placeholder={t('用户名')}
                value={registerUsername}
                onChange={(e) => setRegisterUsername(e.target.value)}
                required
                minLength={2}
              />
              <input
                type="password"
                placeholder={t('密码')}
                value={registerPassword}
                onChange={(e) => setRegisterPassword(e.target.value)}
                required
                minLength={6}
              />
              <button type="submit" disabled={loading}>
                {loading ? t('注册中') : t('确认注册')}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>DUKO</h1>
        <h2>{t('登录')}</h2>
        <form onSubmit={handleLogin} className="login-form">
          {error && <p className="error-msg">{error}</p>}
          <input
            type="text"
            placeholder={t('用户名')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
          <input
            type="password"
            placeholder={t('密码')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? t('登录中') : t('登录')}
          </button>
        </form>
      </div>
    </div>
  );
}
