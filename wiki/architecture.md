# 系统架构

## 总览

DUKO 是由四个 Node.js/TypeScript 子项目组成的单仓库应用：

```text
浏览器 client
  | REST + fetch/ReadableStream SSE
  v
Express server ---- SQLite / LanceDB / 进程内状态
  |
  | WebSocket（单 worker、双向任务协议）
  v
auto worker ---- Playwright persistent Chromium ---- Odoo

Odoo 页面 ---- script 用户脚本（直接操作当前页面 DOM）
```

- `client/`：React 18 + Vite SPA，负责认证、清单解析、布局、报价、库存、历史与管理员界面。路由见 `client/src/App.tsx`。
- `server/`：Express API、LLM Agent、SKU 检索、任务编排、认证和静态文件服务。入口为 `server/src/index.ts`。
- `auto/`：独立运行的 Playwright worker，主动连接服务端，复用 Chromium profile 中的 Odoo 登录态，执行报价、库存下载和趋势查验。
- `script/`：ScriptCat/Tampermonkey 用户脚本。它注入 Odoo 页面并直接操作当前报价表格，不经过 `auto` 任务队列。

生产式构建后，Express 从 `client/dist/` 提供 SPA 静态文件，因此网页与 API 可共用一个 HTTP 端口。开发时 Vite 单独监听并代理 `/api`。

## Client

客户端以 `client/src/App.tsx` 为路由事实源。普通业务页由 `AuthGuard` 保护，调试、trace 和全部历史由 `AdminGuard` 保护。认证状态、表格状态、布局状态和报价状态分别位于 `client/src/stores/`。

常规请求经 `client/src/lib/fetchWithAuth.ts`：附加 Bearer access token、携带 refresh cookie，并在 401 时对并发刷新去重后重试一次。浏览器原生 `EventSource` 不能附加 Authorization 头，因此持续 SSE 使用 `client/src/lib/sseStream.ts` 的 `fetch + ReadableStream` 实现；LLM 流也直接读取 POST 响应体。

客户端本地状态分为三类：

- Zustand 内存状态：当前表单、加载状态、SSE 日志和选中项。
- `localStorage`：access token、当前解析表、当前布局、报价草稿、库存最近结果、语言等可恢复数据。
- 下载文件：表格 JSON 存档和布局 JSON，可由用户重新导入。

## Server

`server/src/index.ts` 依次装配安全中间件、认证与 LLM 路由、普通 API、SPA 静态文件和 WebSocket server。除登录/刷新/脚本下载等明确例外，业务 API 都需要认证；管理员检查仍在对应路由中执行。

服务端主要能力包括：

- DeepSeek 文本 Agent：清单结构化、对话和布局编排。
- OpenRouter 多模态 Agent：清单图片识别和布局图片 OCR。
- SKU 工具：SQLite 结构化查询、BM25 内存索引和 LanceDB 向量检索。
- 用户、历史、笔记、trace 和报价任务持久化。
- 报价/库存任务队列、SSE 广播和 `auto` WebSocket 协议。
- 客户端构建产物与用户脚本下载文件的提供。

REST 用于短请求、查询和命令；SSE 用于 LLM 流式结果、报价全局/单任务更新和库存 job 更新。SSE 连接是 server 到浏览器的单向事件流，确认、取消等反向操作仍走 REST。

## Auto 与 WebSocket

服务端在同一 HTTP server 的 `/api/auto/connect` 挂载 WebSocket，具体协议在 `server/src/services/ws-protocol.ts` 与 `auto/src/protocol.ts` 分别定义。当前实现是单 worker 模型，在线状态和当前任务保存在 `server/src/services/ws-state.ts`。

`auto/src/index.ts` 完成 token/version 握手、ready、任务派发、ack、应用层心跳、断线重连和未确认消息重放。同一时刻只执行一个任务。任务分为报价、库存下载和库存趋势三类；浏览器流程分别位于 `auto/src/browser.ts` 与 `auto/src/browser-inventory.ts`。

每项任务启动 persistent Chromium context，使用 `AUTO_PROFILE_DIR` 保留的 Odoo cookie，任务结束关闭 context 但保留 profile。报价流程在核验单号、公司与已有行后，通过 WebSocket -> server -> SSE 请求网页用户确认；用户的 REST 决定再经 WebSocket 返回 worker。断线会中止浏览器流程，服务端对运行中的报价任务执行一次回队重试，之后再次断线则失败，见 `server/src/db/quotation.ts`。

## Script

`script/` 是独立于服务端队列的人工辅助路径。构建产物含用户脚本元数据，在匹配的 Odoo 页面注入可拖动面板；用户粘贴 SKU/数量 CSV 后可追加或覆写当前报价表格。它使用浏览器 DOM、Odoo autocomplete 和事件模拟，行为集中在 `script/panel.ts` 与 `script/quotation.ts`。

构建会把脚本复制到 `server/public/script/`，网页主页通过无需登录的下载入口获取它。脚本直接依赖 Odoo DOM 结构，选择器变化是其主要脆弱点。

## 数据与状态

### SQLite

数据根目录由 `DB_DIR` 决定。服务端维护两个 SQLite 文件：

- `users.sqlite`：用户、解析历史、笔记、trace session/消息、报价任务及逐行结果。初始化和表结构见 `server/src/db/users.ts`，报价访问封装见 `server/src/db/quotation.ts`。
- `sku.sqlite`：清洗后的 SKU、颜色、物品和零件等结构化数据，供精确匹配、产品拆解和搜索过滤使用，见 `server/src/db/sku.ts`。

两者使用进程内 `better-sqlite3` 连接；用户库启用 WAL 与外键。每用户解析历史最多保留 200 条，报价任务最多保留 100 条，删除用户会按外键级联相关记录。

### LanceDB 与 BM25

`<DB_DIR>/sku.lance/` 是嵌入式 LanceDB 数据目录，用于 SKU 描述向量检索，不需要额外数据库服务。启动时还会从 SQLite 预热 BM25 描述索引；BM25 记录缓存只存在于服务端进程内。导入与检索实现分别位于 `server/src/services/sku-ingest.ts`、`server/src/db/lance.ts` 和 `server/src/services/bm25.ts`。

### 内存状态

- refresh token 有效集合位于 `server/src/middleware/auth.ts` 的内存 Map；服务重启会丢失该集合。
- `auto` 在线/当前任务、SSE 订阅者和待派发的库存 worker 任务属于进程内状态。
- 库存 job 及分类过程位于 `server/src/services/inventory.ts` 的 Map，不落 SQLite；终态 job 超过约一小时会被清理，服务重启会立即丢失。客户端仅把最近分类结果覆盖保存到自己的 `localStorage`。
- 当前布局不保存在服务端；客户端以 `duko_layout` 保存单个布局，并支持 JSON 导入导出。

## 主要业务流

### 清单解析与对话

1. 浏览器提交文本，或先把图片发给多模态 Agent 得到可人工修改的文本。
2. TableParseAgent 通过 SSE 输出轮次、工具调用、回复片段和结构化 items。
3. 服务端自动把解析结果写入当前用户历史；浏览器把当前 items 保存到本地。
4. 用户修正候选字段后，服务端用 SQLite 校验组合并拆解/聚合为产品清单。
5. ChatAgent 接收当前 items、products、笔记和短对话历史，可调用工具并返回更新后的状态；发生实质 items 变化时再次写历史。

相关入口：`server/src/routes/imageParse.ts`、`tableParse.ts`、`chat.ts`。

### 布局识别与物料

1. 浏览器发送单张布局图、视图类型、关联墙 ID 和当前布局。
2. LayoutOcrAgent 使用视觉模型生成双轨文字描述。
3. LayoutAgent 使用文本模型和布局/搜索/委派工具增量修改布局，并以 SSE 推送快照。
4. 客户端覆盖当前布局并写入 `localStorage`，仍可手工编辑墙、轨道和块。
5. 完整物料清单由服务端纯算法生成，不调用 LLM。

相关入口：`server/src/routes/layoutParseImage.ts`、`layoutGenerateList.ts`。

### 报价任务

1. 用户提交报价标识/精确 URL、写入模式和 SKU/数量/可选折扣行，任务及行写入 `users.sqlite`。
2. 服务端按全局 FIFO 队列向在线 `auto` 派发；全局 SSE 更新 worker、队列和用户任务列表。
3. worker 打开 Odoo、定位并核验报价，网页确认后逐行写入。
4. worker 上报进度、逐行结果和最终快照；服务端持久化并通过单任务 SSE 推送。

### 库存查询

1. 自动模式由 worker 从 Odoo 导出 CSV；上传模式由浏览器把 CSV 交给服务端。
2. 服务端清洗并按可用库存阈值筛选。
3. 低库存型号排入同一个 worker 做近期出入库趋势查验。
4. 服务端按出库量分类为警告、提醒、信息，并以 SSE 增量推送；浏览器保存最近结果。
