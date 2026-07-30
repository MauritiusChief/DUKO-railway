/**
 * 登录页面
 *
 * 提供用户名/密码登录表单。管理员登录后可见注册新用户按钮与用户管理面板。
 * 登录成功后跳转回用户最初请求的页面（通过 URL 参数 redirect）。
 */
import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore, type AuthUser } from '../stores/authStore';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { useI18n } from '../i18n/context';
import './LoginPage.css';

/** 用户列表项 */
interface UserListItem {
  id: number;
  username: string;
  role: string;
  created_at: string;
}

/** 用户操作类型 */
type UserAction = 'none' | 'delete' | 'rename' | 'password' | 'role';

export default function LoginPage() {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerSuccess, setRegisterSuccess] = useState(false);

  // 用户管理状态
  const [userList, setUserList] = useState<UserListItem[]>([]);
  const [userListLoaded, setUserListLoaded] = useState(false);
  const [activeUser, setActiveUser] = useState<number | null>(null);
  const [activeAction, setActiveAction] = useState<UserAction>('none');
  const [adminPwd, setAdminPwd] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'manager'>('user');
  const [mgmtLoading, setMgmtLoading] = useState(false);
  const [mgmtError, setMgmtError] = useState('');
  const [mgmtSuccess, setMgmtSuccess] = useState('');

  const { login, register, loading, error, user, logout, accessToken, userVerified, loadMe } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 页面刷新后 user 不在 localStorage，需通过 /api/me 从服务端恢复身份
  useEffect(() => {
    if (accessToken && !userVerified) {
      loadMe();
    }
  }, [accessToken, userVerified, loadMe]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    await login(username, password);
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
      // 刷新用户列表
      if (user?.role === 'admin') fetchUserList();
    }
  };

  /** 加载用户列表 */
  const fetchUserList = async () => {
    try {
      const res = await fetchWithAuth('/api/auth/users');
      if (res.ok) {
        const data = await res.json();
        setUserList(data.users ?? []);
      }
    } catch {
      /* 静默失败 */
    } finally {
      setUserListLoaded(true);
    }
  };

  // 管理员登录后加载用户列表
  useEffect(() => {
    if (user?.role === 'admin' && !userListLoaded) {
      fetchUserList();
    }
  }, [user, userListLoaded]);

  /** 重置操作表单 */
  const resetAction = () => {
    setActiveUser(null);
    setActiveAction('none');
    setAdminPwd('');
    setNewUsername('');
    setNewPassword('');
    setNewRole('user');
    setMgmtError('');
    setMgmtSuccess('');
  };

  /** 打开指定用户的某个操作面板 */
  const openAction = (userId: number, action: UserAction, currentRole?: string) => {
    setActiveUser(userId);
    setActiveAction(action);
    setAdminPwd('');
    setNewUsername('');
    setNewPassword('');
    setNewRole(currentRole === 'manager' ? 'manager' : 'user');
    setMgmtError('');
    setMgmtSuccess('');
  };

  /** 角色显示文案 */
  const roleLabel = (role: string) =>
    role === 'admin' ? t('管理员') : role === 'manager' ? t('经理') : t('普通用户');

  /** 删除用户 */
  const handleDeleteUser = async (e: FormEvent) => {
    e.preventDefault();
    setMgmtLoading(true);
    setMgmtError('');
    setMgmtSuccess('');
    try {
      const res = await fetchWithAuth(`/api/auth/users/${activeUser}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword: adminPwd }),
      });
      const data = await res.json();
      if (res.ok) {
        setMgmtSuccess(t('删除成功'));
        setUserList((prev) => prev.filter((u) => u.id !== activeUser));
        setTimeout(resetAction, 1500);
      } else {
        setMgmtError(data.error || '操作失败');
      }
    } catch {
      setMgmtError('网络错误');
    } finally {
      setMgmtLoading(false);
    }
  };

  /** 修改用户名 */
  const handleRenameUser = async (e: FormEvent) => {
    e.preventDefault();
    setMgmtLoading(true);
    setMgmtError('');
    setMgmtSuccess('');
    try {
      const res = await fetchWithAuth(`/api/auth/users/${activeUser}/username`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, adminPassword: adminPwd }),
      });
      const data = await res.json();
      if (res.ok) {
        setMgmtSuccess(t('修改成功'));
        setUserList((prev) =>
          prev.map((u) => (u.id === activeUser ? { ...u, username: data.user?.username ?? newUsername } : u)),
        );
        setTimeout(resetAction, 1500);
      } else {
        setMgmtError(data.error || '操作失败');
      }
    } catch {
      setMgmtError('网络错误');
    } finally {
      setMgmtLoading(false);
    }
  };

  /** 修改密码 */
  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setMgmtLoading(true);
    setMgmtError('');
    setMgmtSuccess('');
    try {
      const res = await fetchWithAuth(`/api/auth/users/${activeUser}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword, adminPassword: adminPwd }),
      });
      const data = await res.json();
      if (res.ok) {
        setMgmtSuccess(t('修改成功'));
        setTimeout(resetAction, 1500);
      } else {
        setMgmtError(data.error || '操作失败');
      }
    } catch {
      setMgmtError('网络错误');
    } finally {
      setMgmtLoading(false);
    }
  };

  /** 修改角色（仅 user ↔ manager） */
  const handleRoleChange = async (e: FormEvent) => {
    e.preventDefault();
    setMgmtLoading(true);
    setMgmtError('');
    setMgmtSuccess('');
    try {
      const res = await fetchWithAuth(`/api/auth/users/${activeUser}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole, adminPassword: adminPwd }),
      });
      const data = await res.json();
      if (res.ok) {
        setMgmtSuccess(t('修改成功'));
        setUserList((prev) =>
          prev.map((u) => (u.id === activeUser ? { ...u, role: data.user?.role ?? newRole } : u)),
        );
        setTimeout(resetAction, 1500);
      } else {
        setMgmtError(data.error || '操作失败');
      }
    } catch {
      setMgmtError('网络错误');
    } finally {
      setMgmtLoading(false);
    }
  };

  /** 判断是否为种子管理员（当前登录者） */
  const isSelfAdmin = (u: { role: string; username: string }) =>
    u.role === 'admin' && u.username === user?.username;

  // 待服务端验证身份（页面刷新后 user 不在 localStorage）
  if (accessToken && !userVerified) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p>正在验证身份...</p>
        </div>
      </div>
    );
  }

  // 已登录状态：显示用户信息 + 可选的注册面板 + 管理员用户管理
  if (user) {
    const homeRedirect = searchParams.get('redirect') || '/';
    return (
      <div className="login-page">
        <div className={`login-card ${user.role === 'admin' ? 'login-card-admin' : ''}`}>
          <h2>{t('已登录')}</h2>
          <p>
            {t('当前用户')}: <strong>{user.username}</strong> ({roleLabel(user.role)})
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

          {/* 管理员用户管理 */}
          {user.role === 'admin' && (
            <div className="user-management-section">
              <h3>{t('用户管理')}</h3>
              {!userListLoaded ? (
                <p className="mgmt-loading">{t('解析中') + '...'}</p>
              ) : userList.length === 0 ? (
                <p className="mgmt-empty">暂无用户</p>
              ) : (
                <div className="user-list">
                  {userList.map((u) => {
                    const isSeed = isSelfAdmin(u);
                    const isExpanded = activeUser === u.id && activeAction !== 'none';
                    return (
                      <div key={u.id} className={`user-list-item ${isSeed ? 'user-list-item-seed' : ''}`}>
                        <div className="user-list-item-info">
                          <span className="user-list-item-username">
                            {u.username}
                            {isSeed && <span className="user-list-item-badge">{t('管理员')}</span>}
                            {u.role === 'admin' && !isSeed && (
                              <span className="user-list-item-badge user-list-item-badge-admin">{t('管理员')}</span>
                            )}
                            {u.role === 'manager' && (
                              <span className="user-list-item-badge user-list-item-badge-manager">{t('经理')}</span>
                            )}
                          </span>
                          <span className="user-list-item-meta">
                            {roleLabel(u.role)} · {u.created_at}
                          </span>
                        </div>
                        <div className="user-list-item-actions">
                          {!isSeed ? (
                            <>
                              <button
                                className="mgmt-action-btn mgmt-action-rename"
                                onClick={() => openAction(u.id, 'rename')}
                                title={t('修改用户名')}
                              >
                                {t('修改用户名')}
                              </button>
                              <button
                                className="mgmt-action-btn mgmt-action-password"
                                onClick={() => openAction(u.id, 'password')}
                                title={t('修改密码')}
                              >
                                {t('修改密码')}
                              </button>
                              <button
                                className="mgmt-action-btn mgmt-action-role"
                                onClick={() => openAction(u.id, 'role', u.role)}
                                title={t('修改角色')}
                              >
                                {t('修改角色')}
                              </button>
                              <button
                                className="mgmt-action-btn mgmt-action-delete"
                                onClick={() => openAction(u.id, 'delete')}
                                title={t('确认删除')}
                              >
                                {t('确认删除')}
                              </button>
                            </>
                          ) : (
                            <span className="mgmt-protected-hint">{t('种子管理员保护')}</span>
                          )}
                        </div>

                        {/* 展开的操作表单 */}
                        {isExpanded && (
                          <div className="mgmt-action-panel">
                            <div className="mgmt-action-field">
                              <label>{t('管理员密码')}</label>
                              <input
                                type="password"
                                value={adminPwd}
                                onChange={(e) => setAdminPwd(e.target.value)}
                                placeholder={t('管理员密码')}
                                required
                                autoFocus
                              />
                            </div>

                            {activeAction === 'rename' && (
                              <form onSubmit={handleRenameUser}>
                                <div className="mgmt-action-field">
                                  <label>{t('新用户名')}</label>
                                  <input
                                    type="text"
                                    value={newUsername}
                                    onChange={(e) => setNewUsername(e.target.value)}
                                    placeholder={t('新用户名')}
                                    required
                                    minLength={2}
                                  />
                                </div>
                                <div className="mgmt-action-btns">
                                  {mgmtError && <p className="error-msg">{mgmtError}</p>}
                                  {mgmtSuccess && <p className="success-msg">{mgmtSuccess}</p>}
                                  {(mgmtError || mgmtSuccess) ? null : <button type="submit" disabled={mgmtLoading}>
                                    {mgmtLoading ? t('解析中') + '...' : t('保存')}
                                  </button>}
                                  <button type="button" onClick={resetAction}>
                                    {t('取消')}
                                  </button>
                                </div>
                              </form>
                            )}

                            {activeAction === 'password' && (
                              <form onSubmit={handleChangePassword}>
                                <div className="mgmt-action-field">
                                  <label>{t('新密码')}</label>
                                  <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    placeholder={t('新密码')}
                                    required
                                    minLength={6}
                                  />
                                </div>
                                <div className="mgmt-action-btns">
                                  {mgmtError && <p className="error-msg">{mgmtError}</p>}
                                  {mgmtSuccess && <p className="success-msg">{mgmtSuccess}</p>}
                                  {(mgmtError || mgmtSuccess) ? null : <button type="submit" disabled={mgmtLoading}>
                                    {mgmtLoading ? t('解析中') + '...' : t('保存')}
                                  </button>}
                                  <button type="button" onClick={resetAction}>
                                    {t('取消')}
                                  </button>
                                </div>
                              </form>
                            )}

                            {activeAction === 'delete' && (
                              <form onSubmit={handleDeleteUser}>
                                <p className="mgmt-confirm-text">
                                  确定要删除用户 <strong>{userList.find((x) => x.id === activeUser)?.username}</strong> 吗？此操作不可撤销。
                                </p>
                                {mgmtError && <p className="error-msg">{mgmtError}</p>}
                                {mgmtSuccess && <p className="success-msg">{mgmtSuccess}</p>}
                                <div className="mgmt-action-btns">
                                  <button type="submit" className="mgmt-btn-danger" disabled={mgmtLoading}>
                                    {mgmtLoading ? t('解析中') + '...' : t('确认删除')}
                                  </button>
                                  <button type="button" onClick={resetAction}>
                                    {t('取消')}
                                  </button>
                                </div>
                              </form>
                            )}

                            {activeAction === 'role' && (
                              <form onSubmit={handleRoleChange}>
                                <div className="mgmt-action-field">
                                  <label>{t('角色')}</label>
                                  <select
                                    value={newRole}
                                    onChange={(e) => setNewRole(e.target.value as 'user' | 'manager')}
                                  >
                                    <option value="user">{t('普通用户')}</option>
                                    <option value="manager">{t('经理')}</option>
                                  </select>
                                </div>
                                <div className="mgmt-action-btns">
                                  {mgmtError && <p className="error-msg">{mgmtError}</p>}
                                  {mgmtSuccess && <p className="success-msg">{mgmtSuccess}</p>}
                                  {(mgmtError || mgmtSuccess) ? null : <button type="submit" disabled={mgmtLoading}>
                                    {mgmtLoading ? t('解析中') + '...' : t('保存')}
                                  </button>}
                                  <button type="button" onClick={resetAction}>
                                    {t('取消')}
                                  </button>
                                </div>
                              </form>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
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
