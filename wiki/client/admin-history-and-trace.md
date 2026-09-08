# 管理、历史与追踪

## 认证与会话

路由保护由 `client/src/components/AuthGuard.tsx`、`AdminGuard.tsx` 和 `RoleGuard.tsx` 完成：`AuthGuard` 仅要求登录，`AdminGuard` 要求 admin，`RoleGuard` 按传入角色校验（库存看板 `/inventory` 用其限定 manager/admin）。所有 guard 都在渲染前通过 `/api/me` 确认服务端角色，服务端仍在中间件和各路由重复执行真实权限检查，不能只依赖前端 guard。

`client/src/stores/authStore.ts` 的会话模型：

- access token 有效期 15 分钟，保存在 `localStorage` 的 `duko_access_token`。
- refresh token 有效期 7 天，通过 HttpOnly cookie 传输，JS 不可读；刷新时 rotation。
- 用户对象不落本地，页面刷新后通过 `/api/me` 重新验证角色。
- `fetchWithAuth` 遇到 401 时只触发一次并发共享刷新，然后重试原请求。

服务端 refresh token 有效集合是内存状态；服务重启后现有 refresh cookie 无法通过集合校验，需要重新登录。access token 在过期前仍按 JWT 校验。

## 登录页与用户管理

`client/src/pages/LoginPage.tsx` 在未登录时显示登录表单，并保留 guard 提供的 redirect。已登录时显示身份和进入系统按钮；管理员还可：

- 创建普通用户。
- 查看用户列表（含角色显示：管理员/经理/普通用户）。
- 在再次输入当前管理员密码后修改非种子用户的用户名/密码或删除用户，也可在 `user` 与 `manager` 之间切换非管理员用户的角色。
- 环境变量播种的管理员受保护，不能在该界面改名、改密、删除或改角色；管理员也不能删除自己。账号及 bcrypt 密码哈希位于 `users.sqlite`。删除用户会通过 SQLite 外键级联删除其解析历史、笔记、trace 和报价任务。

当前改密和删除不会撤销目标用户已经签发的 Access/Refresh Token，refresh 路由也不会先确认用户仍存在。因此管理界面的成功提示只证明数据库修改完成，不代表该账号的现有会话已经立即失效。**修改角色是例外**——会撤销目标 refresh token，迫使在 access token 过期（≤15 分钟）后重新登录拿到新角色。

## 个人历史

`client/src/pages/HistoryPage.tsx` 只显示当前用户记录，按时间倒序。详情含原始输入、颜色提示、解析 items 和对话。用户可以删除自己的记录，或“填充回主页”继续编辑。

历史写入发生在服务端：

- 表格文本解析成功后自动新增。
- ChatAgent 实质修改 items 后自动新增。
- 也保留显式保存历史的服务端能力，但当前主要页面流程以上述自动保存为主。

每用户最多 200 条，超限删除最旧记录。历史是快照，不会随主页后续本地编辑自动更新。

## 全部历史

`client/src/pages/AllHistoryPage.tsx` 仅管理员可用，显示所有用户记录及用户名，可查看详情并填充回主页。当前页面没有删除他人历史的操作；服务端管理员历史路由也是只读列表与详情。

管理员填充他人记录只会把快照载入当前浏览器的表格 store，不改变原记录归属，也不会立即创建新历史；之后若重新解析或由聊天修改，新增记录属于当前管理员。

## 搜索调试

`client/src/pages/DebugPage.tsx` 是管理员工具页，可直接调用 shape、description、overlap 和 structured 四类 SKU 搜索执行器并渲染 Markdown 输出。服务端实现位于 `server/src/routes/debug.ts`，有 `requireAdmin` 保护。

该页面是底层搜索诊断入口，不模拟完整 Agent 提示、预算或多轮工具编排；结果不能单独证明清单 Agent 的最终行为。

## LLM Trace

`client/src/pages/TracePage.tsx` 仅管理员可用。列表展示最近 30 天 trace session，详情展示用户、主/子 Agent、route、provider/model、状态、错误和消息序列；消息按 assistant/tool 关系分组，JSON 可展开，Markdown 可在 raw/rendered 间切换。

trace 只有 `TRACE_LOG=true` 时由 LLM 路由写入 `users.sqlite`。表和写入逻辑位于 `server/src/db/users.ts` 与 `server/src/services/trace.ts`。服务启动时会清理旧 trace，列表查询也以最近 30 天为范围。布局初始 OCR 可形成独立子 session，主页面会显示 Agent 层级。

Trace 可能包含用户输入、模型回复、推理、工具参数和工具输出，只应向受信任管理员开放。它不是业务历史：关闭 trace 不影响解析历史，删除用户会同时级联删除该用户 trace。

## 注意点

- 前端 AdminGuard 主要改善导航体验，真正授权以服务端 `requireAdmin` 为准。
- access token 是浏览器级本地 key，存在 XSS 可读风险；HttpOnly 只保护 refresh token。
- 登出不会统一删除 `duko_notes`、`duko_quotation_draft`、`duko_parsed_data` 和 `duko_layout`。共享浏览器切换账号时可能看到上一账号的业务缓存，应使用独立浏览器 profile 或手工清理站点数据。
- 个人历史与本地当前表是两套状态；清除 `localStorage` 不删除历史，删除历史也不清空主页本地表。
- 全部历史页只读原记录，但“填充回主页”会覆盖当前浏览器 store。
- Trace 页面中的 provider/model 是记录创建时事实，不代表当前默认配置。
- 管理员路由目前没有集中导航页；`/debug`、`/trace`、`/all-history` 可能需要直接访问。
