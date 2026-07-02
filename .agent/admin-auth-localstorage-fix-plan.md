# Admin 权限依赖 localStorage 的修复计划

## 背景

当前前端管理员路由判断依赖 `localStorage` 中恢复出来的 `user.role`。由于 `localStorage` 可被用户自行修改，普通用户可以把本地 `duko_auth_user.role` 改成 `admin`，从而绕过前端 `AdminGuard`，进入原本只展示给管理员的页面。

已检查到当前关键管理员 API 基本都在服务端使用了 `authenticateToken` 和 `requireAdmin`，因此普通用户修改 `localStorage` 后通常只能看到管理员页面外壳，无法真正获得后端管理员权限。但该问题仍需要修复，因为前端权限状态不可信，后续新增管理员功能时容易引入真正越权漏洞。

## 严重性评估

严重性：中等。

原因：

- 不是单纯 UI 问题，普通用户确实可以进入 admin-only 页面。
- 目前后端关键接口已有角色校验，尚未发现可直接读写管理员数据的路径。
- 风险主要来自未来维护：如果新增 admin 页面或接口遗漏后端 `requireAdmin`，该前端绕过会立即放大为高危越权。

## 现状定位

- `client/src/stores/authStore.ts` 会从 `localStorage` 恢复 `duko_auth_user`。
- `client/src/components/AdminGuard.tsx` 使用 `user.role === 'admin'` 判断是否放行。
- `client/src/App.tsx` 中 `/layout-recognize`、`/debug`、`/trace`、`/all-history` 依赖 `AdminGuard`。
- `server/src/middleware/auth.ts` 已提供 `requireAdmin`。
- 已加后端管理员校验的接口包括用户管理、debug 工具、trace、全部历史、layout 图片解析。

## 修复目标

前端路由守卫不能信任 `localStorage` 中的信息。当前登录用户身份与角色应以后端验证结果为准。

## 推荐方案

1. `localStorage` 最多保留 `accessToken`，不要把 `duko_auth_user` 作为权限判断依据。
2. 在 `authStore` 中增加会话确认能力，例如 `loadMe()` 或 `ensureUser()`。
3. 应用启动或进入受保护路由时，调用 `/api/me` 获取服务端确认的当前用户。
4. `AdminGuard` 在服务端身份确认完成前显示 loading，不直接根据本地缓存放行。
5. `AdminGuard` 只在 `/api/me` 确认是管理员时渲染子页面。
6. `/api/me` 返回 401 或用户不存在时清理本地 token，并跳转登录页。
7. 所有 admin API 继续保留服务端 `authenticateToken + requireAdmin`，后端仍是最终安全边界。

## 最小实现步骤

1. 修改 `AuthState`，增加 `initialized` 或 `userVerified` 状态。
2. 修改 `loadSession()`，只恢复 `accessToken`，不再使用可篡改的 `user`。
3. 新增 `loadMe()`：使用当前 `accessToken` 请求 `/api/me`，成功后在内存中记录用户状态，失败后清理会话。
4. 在 `AuthGuard` 中，如果有 token 但未完成验证，触发 `loadMe()` 并显示加载态。
5. 在 `AdminGuard` 中同样等待 `loadMe()` 完成，再判断用户角色。
6. 登录成功后仍可使用登录接口返回的 `user` 立即更新 UI，但刷新页面后的角色必须重新由 `/api/me` 确认。
7. 移除 `duko_auth_user`，避免以后误用。

## 验证用例

1. 普通用户登录后手动把 `localStorage.duko_auth_user.role` 改成 `admin`，刷新 `/debug`，应无法进入管理员页面。
2. 管理员登录后刷新 `/debug`、`/trace`、`/all-history`，应正常进入。
3. 普通用户直接请求 `/api/admin/history`，应返回 403。
4. token 过期时，`fetchWithAuth` 应刷新 token 后重新获取 `/api/me` 并保持正确角色。
5. 退出登录后，应清除 token 和用户状态，管理员页面应跳转到 `/login`。

## 注意事项

- 不要仅仅把 `localStorage` 换成 `sessionStorage`，两者都不可信。
- 不要把 JWT payload 在前端解码后作为管理员判断依据，除非同时确认签名；浏览器端不适合作为安全边界。
- 前端守卫只负责体验和隐藏入口，真正权限必须始终在后端接口校验。
