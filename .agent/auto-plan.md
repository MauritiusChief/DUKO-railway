# Playwright 自动报价填写计划

## 目标

以运行在旧电脑上的 `auto` 服务替代用户电脑中的 ScriptCat 插件和脚本：

- Railway 托管的 Server 负责保存、派发和展示报价填写任务。
- 旧电脑的 `auto` 服务主动以 WebSocket 连接 Railway。
- `auto` 收到任务后才启动有头 Playwright 浏览器，使用保留的 Chromium profile 执行 Odoo 操作。
- 每个任务结束后关闭浏览器；Chromium profile 保留，以便复用 Odoo 登录状态。
- 浏览器不运行在 Railway，旧电脑不需要公网 IP 或端口映射。

```text
Web Client
  | REST: 创建、查询报价任务
  | SSE: 接收逐行执行进度
  v
Railway Server
  | SQLite: 任务、逐行结果、状态
  | WebSocket: 与 auto 派发任务、接收进度与结果
  v
旧电脑 auto
  | 每个任务启动 headed Playwright + persistent profile
  v
Odoo (https://dukouserp.com/odoo/)
```

## 当前基础

- 当前前端在 `client/src/pages/TableParsePage.tsx` 生成聚合后的产品列表，并提供复制 CSV。
- 当前 ScriptCat 在用户浏览器本地的 Odoo quotation 页面执行逐行填写。
- `experiment/playwright/` 有 Playwright 浏览器复用、登录态保存和报价写入的试验实现，可作为迁移参考。
- Server 当前没有 WebSocket 服务或持久化报价任务队列。

## 任务模型

### 任务状态

```ts
type QuotationTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'cancelled'
```

**状态转换规则：**

```
queued → running    (auto 接受任务)
queued → cancelled  (用户取消)
running → completed (全部行成功)
running → partial_failed (至少一行成功 + 至少一行失败)
running → failed    (任务级错误)
running → queued    (断线回收，首次)
running → failed    (断线回收，二次超时)
```

- 只能取消 `queued` 状态的任务；尝试取消 `running` 返回 409。
- 取消由用户在 Web 页面触发，仅任务创建者和管理员可取消。

### 逐行结果

报价填写是逐行操作，必须持久化每一行的执行结果：

```ts
interface QuotationTaskLine {
  lineNo: number
  partModel: string
  quantity: number
  status: 'pending' | 'success' | 'failed'
  error?: string
}

interface QuotationTaskResult {
  quotationNumber: string
  lines: QuotationTaskLine[]
  message: string
  error?: string
}
```

判定规则：

- 所有行成功时，任务为 `completed`。
- 至少一行成功、至少一行失败时，任务为 `partial_failed`。
- 未成功写入任何行即出现任务级错误时，任务为 `failed`。
- 产品未匹配、数量无法填写等是行级失败；auto 应继续处理后续行。
- Odoo 登录状态失效、报价单找不到、页面结构变化、浏览器启动失败等是任务级失败。
- 首版不保存截图，只保存结构化错误信息。

### REST 请求 Schema

**创建任务 `POST /api/quotation-tasks`：**

```ts
// Zod schema
z.object({
  quotationNumber: z.string().min(1, '报价单号不能为空'),
  writeMode: z.enum(['overwrite', 'append']),
  lines: z.array(z.object({
    partModel: z.string(),
    quantity: z.number().int().min(1),
  })).min(1, '至少需要一行产品'),
})
```

### WebSocket 协议消息

server 和 auto 共享同一套消息类型定义。协议消息使用 plain TS interface 写在此计划中，两端各自用 Zod 封装自己的入站校验（不在 server 和 auto 之间创建共享包）。

**auto → Server 的消息：**

```ts
// 握手：携带 worker token 和协议版本
{ type: 'hello', version: '1', token: string }

// 告知 server 可以派发任务（初始连接后或任务结束后发送）
{ type: 'ready' }

// 确认收到任务（在启动浏览器前发送）
{ type: 'accepted', taskId: number, attempt: number }

// 逐行结果上报（每行完成即上报）
{ type: 'line-result', taskId: number, lineNo: number, status: 'success' | 'failed', error?: string, attempt: number }

// 任务成功完成（所有行已处理）
{ type: 'task-completed', taskId: number, status: 'completed' | 'partial_failed', lines: QuotationTaskLine[], attempt: number }

// 任务级失败
{ type: 'task-failed', taskId: number, error: string, attempt: number }

// 应用层心跳
{ type: 'heartbeat' }
```

**Server → auto 的消息：**

```ts
// 派发任务（收到 ready 且有 queued 任务时发送）
{ type: 'task-assigned', taskId: number, quotationNumber: string, writeMode: 'overwrite' | 'append', lines: { lineNo: number, partModel: string, quantity: number }[] }

// 确认收到消息（幂等处理用）
{ type: 'ack', taskId: number, attempt: number }

// 心跳回复
{ type: 'heartbeat-ack' }

// 协议错误（如 token 无效、任务不存在等）
{ type: 'error', message: string }
```

**幂等约定：**

- 每条 auto→server 消息携带 `attempt`，从 1 开始，每次重发递增。
- server 为每个 taskId 记录 `last_acked_attempt`，收到 `attempt <= last_acked_attempt` 的消息时直接回复 `ack` 并丢弃。
- auto 重连后重放所有未收到 `ack` 的消息（包括 `accepted`、`line-result`、`task-completed`、`task-failed`）。
- `heartbeat` 和 `ready` 消息不携带 attempt（无须幂等）。

## 前端流程

### 主解析页

保留 `TableParsePage` 产品清单区的“复制 CSV”按钮。在其旁边新增“创建报价任务”按钮：

1. 用户在主页面完成解析并生成产品清单。
2. 点击“创建报价任务”跳转到 `/quotation-tasks`。
3. 将当前 Zustand `products` 带入报价任务页面作为产品来源。

### 报价任务页

新增受登录保护的 `/quotation-tasks` 页面：

- 输入 quotation 单号。
- 展示来自主解析页的 SKU、描述和数量，供用户提交前确认。
- 提供“清空原有行后重建”或“追加写入”的选择，与 ScriptCat 版一致。
- 显示 auto 是否在线。
- 显示当前正在执行任务的 quotation 单号、提交用户名、开始时间和状态。
- 显示当前用户的历史任务及每行的成功/失败结果。
- 对正在查看的任务建立 SSE 连接，实时显示当前处理行、每行成功或失败结果及最终状态。
- 任务详细结果仅任务创建者和管理员可见；当前执行任务的摘要对所有已登录用户可见。
- 登录失效等基础设施失败统一提示“自动化登录状态失效，请联系技术部门”。
- 产品未匹配等业务错误直接逐行显示 SKU 与错误原因。

为避免刷新后丢失 Zustand 中的产品列表，报价任务草稿应写入 `localStorage`；任务提交成功或用户主动清除草稿后删除。

## Server 设计

### 持久化

在现有 `users.sqlite` 中新增两张表，在 `initUserDB()` 的 `db.exec()` 中与现有表一起创建：

```sql
CREATE TABLE IF NOT EXISTS quotation_tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username          TEXT    NOT NULL,
  quotation_number  TEXT    NOT NULL,
  write_mode        TEXT    NOT NULL CHECK(write_mode IN ('overwrite','append')),
  status            TEXT    NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','partial_failed','failed','cancelled')),
  task_error        TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  last_acked_attempt INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at        TEXT,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotation_tasks_user ON quotation_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotation_tasks_status ON quotation_tasks(status, created_at ASC);

CREATE TABLE IF NOT EXISTS quotation_task_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES quotation_tasks(id) ON DELETE CASCADE,
  line_no    INTEGER NOT NULL,
  part_model TEXT    NOT NULL,
  quantity   INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotation_task_lines_task ON quotation_task_lines(task_id);
```

字段说明：

- `username` 是创建时用户名快照，用于显示当前执行者（用户改名后不影响历史记录）
- `retry_count` 追踪断线回收次数：首次超时回收回 `queued` 并 `retry_count=1`；第二次超时标 `failed`
- `last_acked_attempt` 实现幂等：记录最后一次 ack 的 attempt 编号
- `task_error` 存储任务级错误信息（与行级的 `quotation_task_lines.error` 不同）
- 与现有 parse_records 的 200 条限制类似，每用户最多保留 100 条任务，删除旧任务时一并删除所属任务行

### 代码分层

新增文件：

```
server/src/db/quotation.ts     # DB 层：CRUD、状态转换、队列取任务
server/src/services/quotation.ts # 服务层：权限校验、状态机、SSE 广播集成
server/src/routes/quotation.ts # 路由层：REST 端点
```

遵循现有模式：DB 函数直接操作 `better-sqlite3`（参考 `db/users.ts`）；服务层封装业务逻辑；路由层仅做参数提取和响应。

### REST API

全部使用现有登录用户认证：

- `POST /api/quotation-tasks`：创建报价任务。请求体见上方 Zod schema。
- `GET /api/quotation-tasks`：获取当前用户的任务列表。按 `created_at DESC` 排序。首版不分页。
- `GET /api/quotation-tasks/:id`：获取当前用户的任务详情与逐行结果。仅任务创建者和管理员可访问。
- `POST /api/quotation-tasks/:id/cancel`：取消任务。仅当状态为 `queued` 时允许；`running` 返回 409。
- `GET /api/quotation-tasks/active`：公开可读。返回 `{ autoOnline: boolean, activeTask?: { quotationNumber, username, startedAt, status } }`。
- `GET /api/quotation-tasks/:id/events`：SSE 端点。通过 `Authorization` 请求头鉴权（复用 fetch + ReadableStream 方式）。仅任务创建者和管理员可订阅。

REST 负责创建、首次加载、历史查询、取消任务及页面刷新后的状态恢复。SSE 只负责 Server 向 `/quotation-tasks` 页面实时推送更新；页面先通过 REST 获取完整快照，再建立 SSE 连接，避免重连期间遗漏已持久化的结果。

SSE 事件示例：

```ts
{ type: 'task-status', taskId, status: 'running' }
{ type: 'line-result', taskId, lineNo: 3, status: 'success' }
{ type: 'line-result', taskId, lineNo: 4, status: 'failed', error: '产品未匹配' }
{ type: 'task-completed', taskId, status: 'partial_failed' }
```

由于当前前端认证使用 Bearer access token，SSE 实现应复用项目现有的 fetch 流式读取方式，以请求头传入 `Authorization`，而不依赖原生 `EventSource` 无法自定义请求头的限制。

### SSE 订阅广播

新增 `server/src/services/sse-broadcast.ts`：

- 维护 `Map<number, Set<SSEConnection>>`，按 taskId 分组管理订阅者。
- 提供 `subscribe(taskId, conn)` / `unsubscribe(taskId, conn)` 方法。
- 提供 `broadcast(taskId, type, data)` 方法，向该 taskId 的所有订阅者发送事件。
- WebSocket handler（步骤 3）在收到 auto 上报的状态或行结果后，调用 broadcast 推送。

### WebSocket

**库选择**：使用 `ws`（npm 包 `ws`）。轻量，可直接升级 Express HTTP server。

**端点**：`/api/auto/connect`（WebSocket upgrade 路径）

**鉴权流程**：

1. auto 连接 WebSocket 后立即发送 `{ type: 'hello', version: '1', token: '<AUTO_WORKER_TOKEN>' }`。
2. Server 直接比对 `hello.token` 与 `AUTO_WORKER_TOKEN` 环境变量一致，验证通过后标记该连接为已认证。
3. 认证失败回复 `{ type: 'error', message: 'worker token 无效' }` 并关闭连接。
4. 认证成功后，auto 发送 `{ type: 'ready' }`，Server 开始派发任务。
5. 任务执行完毕后，auto 再次发送 `{ type: 'ready' }` 以获取下一个任务。

**Worker Token 管理**：

- `server/.env` 和 `auto/.env` 均设置 `AUTO_WORKER_TOKEN`，两端保存相同的明文 token。
- 管理员自行生成一段随机字符串（如 `openssl rand -hex 32`）。
- 首版仅支持单个 worker token，不支持多 worker 或多 token。

**派发逻辑**：

1. Server 收到 `ready` 后，查询 `SELECT id FROM quotation_tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`。
2. 取到任务后发送 `task-assigned`，状态不变（仍为 `queued`）。
3. 收到 `accepted` 后，将任务状态更新为 `running`，设置 `started_at = now`。
4. 无排队任务时，Server 不做任何回应；auto 保持连接，等待新任务创建时 Server 主动推送。

**心跳与断线检测**：

- auto 每 **30s** 发送 `{ type: 'heartbeat' }`，Server 回复 `{ type: 'heartbeat-ack' }`。
- Server 为每个 worker 连接记录 `lastHeartbeat`。每 **15s** 检查一次：如果距离上次心跳超过 **90s**，认为 worker 断线。
- WebSocket 的 `ws` 库自带 TCP 级 ping/pong 作为补充保障。

**断线回收**：

1. Server 检测到 worker 断线时，查找该 worker 名下所有 `running` 状态的 `quotation_tasks`。
2. 对于每个任务：如果 `retry_count == 0`，将状态回退为 `queued`，`retry_count = 1`；如果 `retry_count >= 1`，将状态标为 `failed`，`task_error = 'worker 断线，任务超时'`。
3. worker 名下跟踪：由于首版只有一个 worker，断线就是该 worker 离开。在内存中维护 `activeWorkerAssignment: Map<number, number>`（taskId → worker 连接标识符）。

**SSE 集成**：

WebSocket handler 在收到 `line-result`、`task-completed`、`task-failed` 后，调用 `sse-broadcast.broadcast(taskId, type, data)` 向对应的 SSE 订阅者推送事件。

## auto 服务

目录与 `server`、`client`、`script` 平级：

```text
auto/
  src/
    index.ts              # WebSocket、重连、任务调度
    protocol.ts           # 消息与任务类型
    browser.ts            # 每任务启动和关闭 persistent Chromium
    odoo/
      quotation.ts        # 定位、核验报价单
      write-lines.ts      # 逐行填写并返回结果
      selectors.ts
  package.json
  tsconfig.json
  .env.example
  README.md
```

**`package.json` 依赖**：

```json
{
  "name": "duko-auto",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "init-session": "tsx src/init-session.ts"
  },
  "dependencies": {
    "playwright": "...",
    "ws": "...",
    "dotenv": "...",
    "zod": "..."
  },
  "devDependencies": {
    "tsx": "...",
    "typescript": "...",
    "@types/ws": "..."
  }
}
```

`tsconfig.json` 参照 `server/tsconfig.json`（ESM, target ES2022）。

### 环境变量

```env
AUTO_SERVER_URL=wss://your-railway-domain/api/auto/connect
AUTO_WORKER_TOKEN=replace-with-long-random-token
AUTO_PROFILE_DIR=./data/browser-profile
ODOO_BASE_URL=https://dukouserp.com/odoo/
AUTO_HEADLESS=false
```

### 运行时流程

**启动流程**：

1. 从 `.env` 加载环境变量，校验必填项。
2. 建立 WebSocket 连接 → 发送 `hello` → 等待认证通过 → 发送 `ready`。
3. 进入事件循环：等待 `task-assigned` → 执行任务 → 发送 `ready` → 等待下一个任务。

**重连策略**：

- 初始连接或断线后，使用指数退避重连：1s → 2s → 4s → 8s → 16s → 32s → 60s（上限），每次 ±25% jitter。
- 重连成功后重置退避计数器。
- `ws` 连接成功并收到 `heartbeat-ack` 后，发送 `hello`（重新认证）+ `ready`。
- 无限重试；如果重连前有未完成的任务（未收到 `ack` 的 `accepted`），在重连后重放未确认的消息。

**应用层心跳**：

- 连接建立后启动 30s 间隔定时器，发送 `{ type: 'heartbeat' }`。
- 若连续 3 次（90s）未收到 `heartbeat-ack`，视为连接死亡，主动断开并触发重连。
- `ws` 内置 ping/pong 也配置为 30s 间隔作为底层保障。

**优雅关闭**：

```
SIGINT / SIGTERM
  → 发送未 ack 的最终结果（如有）
  → 关闭 WebSocket 连接（1000 正常关闭）
  → 关闭浏览器 context（如果有正在执行的任务，先发送 task-failed）
  → process.exit(0)
```

### 浏览器管理

**Profile 初始化**：

- 提供 `npm run init-session` 脚本（`src/init-session.ts`）：
  1. 以 `persistentContext` 模式启动 headed Chromium，指定 `AUTO_PROFILE_DIR`。
  2. 打开 `ODOO_BASE_URL`。
  3. 提示用户手动登录 Odoo。
  4. 用户登录后按回车确认 → 关闭浏览器，profile 自动保存。
- 正常任务执行时，从同一个 `AUTO_PROFILE_DIR` 加载 profile 获得登录态。
- `experiment/playwright/browser.ts:51-65` 中的 `saveSession` 逻辑可作为参考：`context.storageState()` 由 Playwright 自动持久化到 `userDataDir`。

**每任务浏览器流程**：

1. 收到 `task-assigned` 后发送 `accepted`。
2. 启动 persistent headed Chromium context（加载 `AUTO_PROFILE_DIR`）。
3. 打开 `ODOO_BASE_URL`，检查登录状态：
   - **检测方法**：检查 `page.url()` 是否包含 `/web/login`，或 `page.locator('.oe_login_form')` 是否可见。
   - 若未登录 → 上报 `task-failed`，`error = 'Odoo 登录状态失效，请联系技术部门'`。
4. 后续步骤 4~10 见下方"每任务浏览器流程"（步骤 5-6 实现）。
5. 上报最终任务状态。
6. 关闭浏览器 context（profile 自动保留）。

### PM2 集成

更新 `ecosystem.config.cjs` 以包含 auto 服务：

```js
module.exports = {
  apps: [
    {
      name: 'duko-advance',
      script: 'dist/index.js',
      cwd: './server',
      env: { NODE_ENV: 'production', PORT: 3023 },
    },
    {
      name: 'duko-auto',
      script: 'dist/index.js',
      cwd: './auto',
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

### 每任务浏览器流程（步骤 5-6 实现细节）

> 以下为步骤 5-6 的预设计，暂不实现。

1. 收到任务后发送 `accepted`。
2. 启动 persistent headed Chromium context。
3. 打开 Odoo，并检查是否仍为已登录状态。
4. 访问 `https://dukouserp.com/odoo/orders`。
5. 在 orders 页面搜索栏输入任务中的 quotation 单号，打开搜索到的目标报价单。
6. 核验打开页面的 quotation 单号与任务一致后，才允许修改行项目。
7. 根据任务选择追加或清空后重建，并逐行填写产品与数量。
8. 记录每一行的成功或失败；行级失败后继续处理剩余行。
9. 上报最终任务状态、任务错误和所有行结果。
10. 关闭浏览器与 context，保留 profile。

orders 搜索栏的选择器、搜索提交方式、搜索结果选择及报价单号核验方式需要在 Playwright 实作阶段以真实 Odoo 页面逐步调整。实现中不得假设固定 URL 规则或内部数据库 ID。

## 实施顺序

### 步骤 1：定义报价任务、逐行结果和 WebSocket 消息的 Zod schema

**交付物：**

- [ ] 在 `server/src/validation/schemas.ts` 新增：
  - `createQuotationTaskSchema`：创建任务请求（`quotationNumber`, `writeMode`, `lines`）
  - `cancelQuotationTaskSchema`：取消任务（空 body 或 `{ taskId }` 从 params 获取，无需额外 schema）
- [ ] 在 `server` 和 `auto` 两侧各自定义 WebSocket 协议消息的 Zod schema：
  - Server 侧（`server/src/validation/schemas.ts` 或 `server/src/services/quotation.ts`）：校验 auto 发来的 `hello`、`ready`、`accepted`、`line-result`、`task-completed`、`task-failed`、`heartbeat`
  - Auto 侧（`auto/src/protocol.ts`）：校验 server 发来的 `task-assigned`、`ack`、`heartbeat-ack`、`error`
- [ ] Auto 侧导出纯 TypeScript 类型（供 `index.ts` 和 `browser.ts` 使用）

**策略说明**：WebSocket 协议消息不使用跨包共享代码，而是以本计划文档中的消息类型定义为权威来源，两端各自实现校验。Zod schema 仅校验入站消息（从对方收到的消息），出站消息依赖调用方的类型检查。

### 步骤 2：建立 SQLite 表、任务服务和 REST API

**交付物：**

- [ ] 新建 `server/src/db/quotation.ts`：
  - `createQuotationTable(db)` / 在 `initUserDB()` 的 `db.exec()` 中加入 DDL（见上方持久化章节）
  - `createTask(userId, username, quotationNumber, writeMode, lines)` → 插入任务 + 行、返回 taskId
  - `getTasksByUser(userId)` → 任务列表（按 created_at DESC）
  - `getTaskById(userId, taskId)` → 任务详情（含行结果），仅限本人
  - `getTaskByIdForAdmin(taskId)` → 管理员可查看任意任务
  - `cancelTask(userId, taskId)` → 仅 `queued` 可取消
  - `getNextQueuedTask()` → 取 `status='queued' ORDER BY created_at ASC LIMIT 1`
  - `updateTaskStatus(taskId, status, error?)` → 更新状态 + 错误
  - `updateLineResult(taskId, lineNo, status, error?)` → 更新单行
  - `getActiveTaskSummary()` → 当前 `running` 任务的公开摘要
  - `updateTaskRetry(taskId, retryCount, newStatus)` → 断线回收用
- [ ] 新建 `server/src/services/quotation.ts`：
  - 状态机验证（如 `running` → `completed` 是否合法）
  - 权限校验包装（如 `getTaskById` 仅 owner + admin）
  - 与 SSE 广播服务的集成入口
- [ ] 新建 `server/src/routes/quotation.ts`：
  - 6 个 REST 端点（见上方 REST API 章节）
  - SSE 端点（`GET /:id/events`）：使用 `SSEConnection` 类，订阅 `sse-broadcast`
- [ ] 在 `server/src/index.ts` 中挂载路由（`/api/quotation-tasks`，使用 `apiLimiter + authenticateToken`）
- [ ] 编写测试（`server/src/services/__tests__/quotation.test.ts`）：
  - 状态转换：`queued → running → completed` / `queued → cancelled` / `running → failed`
  - 权限校验：用户不能查看/取消他人任务；管理员可以
  - 边界：空 lines 创建失败、取消 `running` 返回 409

### 步骤 3：实现 worker token 配置、WebSocket 鉴权、在线状态、派发、幂等结果处理和断线回收

**交付物：**

- [ ] 安装依赖：`npm install ws`（server 侧）
- [ ] `server/src/config/env.ts` 新增 `autoWorkerToken` 配置项（从 `AUTO_WORKER_TOKEN` 环境变量读取）
- [ ] 新建 `server/src/services/sse-broadcast.ts`：按 taskId 分组的 SSE 订阅管理器
- [ ] 新建 `server/src/services/ws-handler.ts`：
  - WebSocket 连接升级（通过 `ws.Server` 挂载到 Express `http.Server`）
  - 消息路由：按 `type` 分发到对应 handler
  - `hello` handler：比对 `hello.token` 与 `AUTO_WORKER_TOKEN` 环境变量 → 标记连接已认证
  - `ready` handler：取队头 `queued` 任务 → 发送 `task-assigned`
  - `accepted` handler：更新任务为 `running`，记录 `started_at`
  - `line-result` handler：幂等检查 → 写入行结果 → 调用 `sse-broadcast.broadcast`
  - `task-completed` / `task-failed` handler：幂等检查 → 写入最终状态 → SSE 广播
  - `heartbeat` handler：回复 `heartbeat-ack`
  - 断线检测与回收：`ws.Server` 的 `close` 事件 + 心跳超时定时器
- [ ] 在 `server/src/index.ts` 启动流程中初始化 WebSocket server
- [ ] `server/.env.example` 更新：增加 `AUTO_WORKER_TOKEN` 说明
- [ ] 编写测试或手动验证：
  - worker token 无效时连接被拒绝
  - 重放 `accepted`（attempt=1 重复）被幂等丢弃
  - 断线后 `running` 任务回收到 `queued`（retry_count=1）
  - 再次断线后任务标为 `failed`（retry_count>=2）

### 步骤 4：创建 `auto` 基础运行时

**交付物：**

- [ ] 创建 `auto/` 目录并初始化：
  - `package.json`（依赖：`playwright`, `ws`, `dotenv`, `zod`）
  - `tsconfig.json`（ESM, target ES2022，参照 server）
  - `.env.example`
  - `README.md`（首次使用说明：安装依赖、初始化 browser profile、配置环境变量、启动）
- [ ] `auto/src/protocol.ts`：WebSocket 消息 TypeScript 类型定义 + Zod 入站校验 schema
- [ ] `auto/src/index.ts`：
  - 环境变量加载与校验
  - `WebSocketClient` 类：连接、指数退避重连、消息收发、未确认消息重放队列
  - 应用层心跳定时器（30s 间隔）
  - 事件循环：等待 `task-assigned` → 调用 browser 执行 → 重连时重放未 ack 消息
  - 优雅关闭处理（SIGINT/SIGTERM）
- [ ] `auto/src/browser.ts`：
  - `runQuotationTask(task)` 函数：
    1. 发送 `accepted`
    2. `chromium.launchPersistentContext(userDataDir, { headless })`
    3. 打开 `ODOO_BASE_URL`，检测登录状态：
       - `await page.waitForLoadState('networkidle')`
       - `const isLoginPage = page.url().includes('/web/login') || (await page.locator('.oe_login_form').count()) > 0`
       - 若为登录页 → 上报 `task-failed('Odoo 登录状态失效')`，return
    4. （占位：后续步骤 5-6 在此插入 Odoo 报价操作）
    5. 上报最终结果
    6. 关闭 browser context（不删除 userDataDir）
  - 浏览器异常处理：启动失败 → `task-failed`；页面崩溃 → `task-failed`
- [ ] `auto/src/init-session.ts`：
  - 首次运行脚本：启动 headed Chromium → 打开 Odoo → 提示用户登录 → 用户确认后关闭
- [ ] 安装 Playwright 浏览器：`npx playwright install chromium`
- [ ] 更新 `ecosystem.config.cjs` 加入 `duko-auto` 进程定义
- [ ] 验收：
  - auto 能成功连接 server WebSocket
  - 连接断开后自动重连（观察指数退避日志）
  - 浏览器启动和关闭正常（profile 目录生成且包含 Odoo cookies）
  - 登录检测逻辑可区分已登录/未登录页面

### 步骤 5：在真实 Odoo 页面实现 `/odoo/orders` 搜索报价单、目标核验及失败处理

（后续细化）

### 步骤 6：从 `experiment/playwright/` 和 ScriptCat 脚本迁移报价写入逻辑，并改为返回逐行结果

（后续细化）

### 步骤 7：创建报价任务页，在主解析页增加跳转按钮，保留复制 CSV；实现 REST 快照加载与 SSE 逐行状态更新

（后续细化）

### 步骤 8：实测追加、清空重建、单行失败、报价单找不到、登录失效、worker 断线及 Railway 重启

（后续细化）

## 验收标准

- 用户可从主页面的产品清单进入报价任务页并创建任务。
- auto 离线时前端明确显示不可派发。
- auto 在线时，任务能按 quotation 单号在 `/odoo/orders` 中找到并核验目标报价单。
- 浏览器仅在任务执行期间运行，任务结束后关闭。
- 所有产品行都具有可查询的成功或失败结果。
- 打开任务页后，用户无需刷新即可看到任务状态和逐行填写结果更新；SSE 断线或页面刷新后可通过 REST 快照恢复完整结果。
- 登录失效被识别为任务失败，界面引导用户联系技术部门。
- Railway 重启或 auto 断线不会导致任务永久卡在 `running`。
