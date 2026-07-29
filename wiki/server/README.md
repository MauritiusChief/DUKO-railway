# Server 概览

`server/` 是单进程 Express 应用，也是 Railway 上唯一运行的进程。它同时承担业务 API、Agent 编排、数据检索、认证、报价与库存自动化协调、实时事件分发，以及生产前端静态文件服务。

## 启动结构

构建使用 TypeScript `tsc`，产物位于 `server/dist/`；启动入口为 `node dist/index.js`。启动顺序为：

1. 校验 JWT 和管理员安全配置。
2. 初始化 `users.sqlite`、trace 与报价任务数据层。
3. 初始化 `sku.sqlite` 和 `sku.lance/`。
4. 按开关选择是否处理、导入 CSV 数据。
5. 从 SQLite 预热 BM25 描述索引。
6. 启动 HTTP 服务，并在同一个 HTTP server 上挂载 auto worker WebSocket。

生产模式下 Express 从 `client/dist/` 提供 SPA，并从 `server/public/script/` 提供已构建的用户脚本下载。API JSON body 上限为 20 MB；Helmet、安全头、CORS 和分级限流在入口统一配置。

## 当前业务能力

- 文本聊天、原始清单解析、图片清单识别、厨房布局图片识别与布局编辑。
- SKU 形状模糊搜索、BM25 描述搜索、组合搜索、结构化过滤及本地向量语义检索。
- 清单编辑、产品库存和组件查询、布局物料清单生成、用户笔记与解析历史。
- 用户登录、管理员创建和维护用户、管理员浏览全量历史与 LLM trace。
- 报价任务持久队列，通过外部 auto worker 在 Odoo 搜索、核验、确认并写入报价行。
- 库存 CSV 上传或由 worker 下载，随后清洗、低库存筛选、近期移动趋势查验和分级。
- LLM 步进、报价状态、全局队列和库存进度通过 SSE 推送；worker 使用 WebSocket 双向通信。

## 文档导航

- [Agents 与工具](./agents-and-tools.md)
- [数据与搜索](./data-and-search.md)
- [认证与持久化](./auth-and-persistence.md)
- [实时通信与自动化](./realtime-and-automation.md)
- [Railway 部署](../RAILWAY_SETUP.md)

## 重要边界

- 文本模型默认由 DeepSeek provider 配置，多模态模型默认由 OpenRouter provider 配置。当前模型名是代码默认值，不从 `OPENROUTER_MODEL` 读取。
- Agent 输出依赖模型、工具预算和已有数据，不应被视为无条件正确的业务事实；候选产品和自动写入目标仍需用户核验。
- `AgentOrchestrator` 当前只提供注册、查找、消息监听和工具所有权查询，不是实际的持久 workflow 引擎。当前主/子 Agent 委派主要由 Agent 类直接创建子 Agent 完成。
- server 不直接运行浏览器。所有 Odoo Playwright 行为在外部 `auto/` 进程中执行。
- 库存任务和部分认证状态是内存态；详细差异见持久化文档。
