# DUKO 代码事实索引

本目录记录当前仓库已经实现的行为。阅读入口如下：

- [系统架构](architecture.md)：`client`、`server`、`auto`、`script` 的职责，通信、存储与主要业务流。
- [开发指南](development.md)：安装、开发、构建、测试、端口、数据目录和生成文件。
- [客户端总览](client/README.md)：现有路由、权限、共享状态与通信约定。
- [清单解析与对话](client/table-parse-and-chat.md)：文本/图片解析、人工校正、产品生成、对话与存档。
- [布局识别](client/layout-recognize.md)：图片识别、双轨布局编辑和物料清单。
- [报价与库存](client/quotation-and-inventory.md)：报价任务队列、Odoo worker、库存下载/上传与趋势分类。
- [管理、历史与追踪](client/admin-history-and-trace.md)：认证、用户管理、个人/全量历史、搜索调试与 LLM trace。
- [Server 概览](server/README.md)：服务端入口；下分 [Agents 与工具](server/agents-and-tools.md)、[认证与持久化](server/auth-and-persistence.md)、[数据与搜索](server/data-and-search.md)、[实时通信与自动化](server/realtime-and-automation.md)。
- [Auto Worker](auto/README.md)：独立 Playwright worker 的配置、任务和运行边界。
- [手工 CSV Quote Filler](script/README.md)：Odoo 用户脚本的构建、使用与 DOM 风险。
- 部署资料：[Railway 部署](RAILWAY_SETUP.md)、[WSL 可选操作环境](RAILWAY_SETUP_WSL.md)。本索引不复制其中的平台步骤。
- [实施计划](plans/README.md)：需要跨组件协调或记录重要取舍的临时方案。

## 事实优先级

发生冲突时按以下顺序判断：

1. 当前代码、测试、配置 schema 与 `.env.example`。
2. 用户在当前任务中的明确要求。
3. `.agent/context/` 中已核验并注明来源的背景。
4. 本 `wiki` 中的当前架构、接口和运维文档。
5. `wiki/plans/` 中的实施计划。
6. 注释、历史文档和推测。

计划只表示设计意图，不能证明功能已经实现，也不能证明计划中的接口仍存在。更新文档前必须回到路由、页面、store、数据库和 worker 实现核对。

## 维护规则

- 记录稳定的职责、流程和数据边界，引用源码路径，不维护容易漂移的逐端点/逐字段清单。
- 页面、权限、持久化位置、端口、命令或跨进程协议变化时，同一变更中更新对应文档。
- 明确区分“SQLite 持久化”“浏览器本地持久化”“服务端内存状态”和“组件内临时状态”。
- 对 SSE 与 WebSocket 分开描述：浏览器从服务端消费 SSE；`auto` 与服务端之间使用 WebSocket。
- 不把开发机现有数据库、构建产物或 `.env` 内容当成可移植配置；以源码默认值和 `.env.example` 为准。
- 不在此处复制部署平台的详细操作步骤；部署配置应由对应平台配置文件和专门文档维护。
- 文档无法从代码确认时写成“待验证”，不要用旧计划补全事实。

## 核心源码入口

- 客户端路由：`client/src/App.tsx`
- 客户端状态：`client/src/stores/`
- 服务端装配：`server/src/index.ts`
- 服务端路由：`server/src/routes/`
- 数据访问：`server/src/db/`
- Agent 与工具：`server/src/agents/`、`server/src/tools/`
- Odoo worker：`auto/src/index.ts`、`auto/src/browser.ts`、`auto/src/browser-inventory.ts`
- Odoo 用户脚本：`script/index.ts`、`script/panel.ts`、`script/quotation.ts`
