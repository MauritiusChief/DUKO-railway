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

在现有 `users.sqlite` 中新增：

- `quotation_tasks`：创建用户、报价单号、写入模式、状态、任务错误、时间戳。
- `quotation_task_lines`：产品型号、数量、行号、行状态、行错误、任务id(FK)。

任务保存 `user_id` 与用户名快照，以便显示当前执行者，同时按用户隔离任务详情。

### REST API

全部使用现有登录用户认证：

- `POST /api/quotation-tasks`：创建报价任务。
- `GET /api/quotation-tasks`：获取当前用户的任务列表。
- `GET /api/quotation-tasks/:id`：获取当前用户的任务详情与逐行结果。
- `POST /api/quotation-tasks/:id/cancel`：取消尚未开始的任务。
- `GET /api/quotation-tasks/active`：返回 auto 在线状态与当前执行任务的公开摘要。
- `GET /api/quotation-tasks/:id/events`：以 SSE 推送该任务的状态和逐行结果；仅任务创建者和管理员可订阅。

REST 负责创建、首次加载、历史查询、取消任务及页面刷新后的状态恢复。SSE 只负责 Server 向 `/quotation-tasks` 页面实时推送更新；页面先通过 REST 获取完整快照，再建立 SSE 连接，避免重连期间遗漏已持久化的结果。

SSE 事件示例：

```ts
{ type: 'task-status', taskId, status: 'running' }
{ type: 'line-result', taskId, lineNo: 3, status: 'success' }
{ type: 'line-result', taskId, lineNo: 4, status: 'failed', error: '产品未匹配' }
{ type: 'task-completed', taskId, status: 'partial_failed' }
```

由于当前前端认证使用 Bearer access token，SSE 实现应复用项目现有的 fetch 流式读取方式，以请求头传入 `Authorization`，而不依赖原生 `EventSource` 无法自定义请求头的限制。

### WebSocket

Server 在现有 HTTP Server 上提供 `/api/auto/connect`：

- auto 用独立、可撤销的 worker token 鉴权；不得复用普通用户 JWT。
- Server 仅保存 worker token 的哈希值，原始 token 只存在旧电脑环境变量中。
- auto 连接后发送 `hello` 和 `ready`，Server 才派发 `queued` 任务。
- auto 收到任务立即确认，执行过程中上报进度和逐行结果，结束后上报最终结果；Server 每次持久化状态或行结果后立即向对应任务的 SSE 订阅者广播事件。
- 消息携带 `version`、`taskId` 和 `attempt`，Server 以此实现幂等处理。
- worker 断线或任务租约超时时，未完成任务回到队列或按重试策略标记失败，避免永久卡住。
- 首版一个 auto 实例一次只处理一个任务，避免并发操作同一个 Odoo 浏览器状态。

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

建议环境变量：

```env
AUTO_SERVER_URL=wss://your-railway-domain/api/auto/connect
AUTO_WORKER_TOKEN=replace-with-long-random-token
AUTO_PROFILE_DIR=./data/browser-profile
ODOO_BASE_URL=https://dukouserp.com/odoo/
AUTO_HEADLESS=false
```

### 每任务浏览器流程

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

1. 定义报价任务、逐行结果和 WebSocket 消息的 Zod schema。
2. 建立 SQLite 表、任务服务和 REST API，并测试状态转换与用户权限。
3. 实现 worker token 配置、WebSocket 鉴权、在线状态、派发、幂等结果处理和断线回收。
4. 创建 `auto` 基础运行时，完成重连、心跳、每任务启动/关闭浏览器和登录失效检测。
5. 在真实 Odoo 页面实现 `/odoo/orders` 搜索报价单、目标核验及失败处理。
6. 从 `experiment/playwright/` 和 ScriptCat 脚本迁移报价写入逻辑，并改为返回逐行结果。
7. 创建报价任务页，在主解析页增加跳转按钮，保留复制 CSV；实现 REST 快照加载与 SSE 逐行状态更新。
8. 实测追加、清空重建、单行失败、报价单找不到、登录失效、worker 断线及 Railway 重启。

## 验收标准

- 用户可从主页面的产品清单进入报价任务页并创建任务。
- auto 离线时前端明确显示不可派发。
- auto 在线时，任务能按 quotation 单号在 `/odoo/orders` 中找到并核验目标报价单。
- 浏览器仅在任务执行期间运行，任务结束后关闭。
- 所有产品行都具有可查询的成功或失败结果。
- 打开任务页后，用户无需刷新即可看到任务状态和逐行填写结果更新；SSE 断线或页面刷新后可通过 REST 快照恢复完整结果。
- 登录失效被识别为任务失败，界面引导用户联系技术部门。
- Railway 重启或 auto 断线不会导致任务永久卡在 `running`。
