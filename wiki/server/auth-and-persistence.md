# 认证与持久化

## 认证模型

用户密码使用 bcrypt，成本参数为 12。启动时由 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 播种第一个管理员；若数据库中已经存在管理员则跳过，不会用环境变量密码覆盖现有账号。

登录后返回 15 分钟有效的 HS256 Access Token，客户端通过 `Authorization: Bearer ...` 访问受保护功能。7 天有效的 Refresh Token 只通过 HttpOnly Cookie 传输，Cookie 路径限定为 `/api/auth`，`SameSite=Lax`，生产环境启用 `Secure`。刷新时旧 token 会被撤销并轮换新 token。

管理员可以创建普通用户、查看用户列表、修改非种子管理员用户的用户名或密码、删除用户；敏感管理操作还要求当前管理员密码。种子管理员不能通过这些接口改名、改密或删除，当前管理员也不能删除自己。

## 认证边界

- Refresh Token 的有效集合保存在进程内存 `Map`，不写 SQLite。server 重启后所有 refresh token 失效，用户需要重新登录；这是当前实现，不是故障。
- Access Token 自包含，在过期前只校验签名和算法。用户资料变更后，旧 token 内的用户名/角色可能保留到过期。
- 当前修改密码或删除账号不会撤销该用户已签发的 Access/Refresh Token；refresh 路由也不会在轮换前确认用户仍存在。被删除或改密用户可能继续刷新会话，这是待修复的高风险认证边界，不能把数据库删除等同于立即终止访问。
- `AUTO_WORKER_TOKEN` 是独立的 worker 共享密钥，不是用户 JWT。它通过 WebSocket 首条 `hello` 消息验证，必须与外部 auto 配置完全一致。
- 登录、刷新和 LLM/普通 API 使用不同限流器；限流是单进程运行态，不是分布式策略。
- Inventory 路由整体要求有效 Access Token，但当前按 job ID 获取快照或订阅 SSE 时没有再次比较 job 的 `userId`；取消操作才校验所有者。job ID 是随机 UUID，但不能替代授权检查，调用方不得向其他用户泄露该 ID。
- 报价全局 SSE 会向所有登录用户发送队列和活跃任务摘要，其中包含报价号和用户名；这属于当前跨用户可见边界，不应在摘要中加入更多客户或报价细节。
- Access Token 位于 `localStorage`，可被页面 JavaScript 读取；HttpOnly 只保护 Refresh Token。CSP/Helmet 可降低但不能消除 XSS 导致 Access Token 泄露的风险。

## `users.sqlite`

该数据库不仅保存用户，还保存大部分用户业务状态：

- 用户账号和 bcrypt 密码哈希。
- 每用户解析历史，最多保留 200 条，超限删除最旧记录。
- 用户笔记；更新采用按用户全量替换事务。
- 可选 LLM trace，包括 session、发给模型/工具的内容和接收结果，启动时清理 30 天前 trace。
- 报价任务、逐行内容、状态、失败信息、确认请求、最终快照和消息幂等 attempt。

删除用户时，外键级联删除其历史、笔记、trace 和报价任务。数据库启用 WAL 与外键。

## 报价持久队列

报价任务按创建时间排队，每用户最多保留 100 条，超限删除最旧任务及其行。任务状态包含 queued、running、completed、partial_failed、failed 和 cancelled。逐行结果、最后确认的消息 attempt、待用户确认内容与最终 Odoo 行快照都可持久化。

worker 断开时，server 会按重试策略回收运行中的报价任务；重连消息通过 attempt 和最后 ack 值去重。持久化保证任务记录可恢复，但不能保证外部 Odoo 操作天然具有数据库事务性，因此最终快照和人工核验仍然重要。

## 不持久化的状态

- Refresh Token 有效集合。
- SSE 订阅者、WebSocket 连接、worker 在线和 busy 状态。
- Inventory job、负数 ID 的库存 worker 子任务、下载 CSV 和趋势分类。
- 正在执行的 LLM 请求与 Agent manifest/layout 请求上下文。
- BM25 运行时索引。
- `CHAT_LOG` Markdown 文件写在应用构建目录旁，不属于 `DB_DIR`，在 Railway 上不保证跨部署保留。

服务重启后，前述状态会丢失或重建。不要把“数据库在 Volume 上”理解为所有界面状态都可恢复。

## 密钥与数据保护

生产必须配置两个不同的高熵 JWT secret、非示例管理员凭据和高熵 `AUTO_WORKER_TOKEN`。API key、token、密码、Cookie 和数据库备份都不得提交到 Git。开启 `TRACE_LOG` 或 `CHAT_LOG` 前，应评估用户输入、图片内容、工具参数与模型输出的敏感性；当前 Markdown logger 还可能保留图片 data URL 的截断前缀。
