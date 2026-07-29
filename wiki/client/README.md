# 客户端总览

客户端是 React 18 + React Router + Zustand 的 SPA，入口为 `client/src/main.tsx`，路由事实源为 `client/src/App.tsx`。

## 页面与权限

| 路径 | 页面 | 权限 | 主要用途 |
| --- | --- | --- | --- |
| `/login` | `LoginPage` | 公开 | 登录；登录后的管理员可创建和管理用户 |
| `/` | `TableParsePage` | 已登录 | 清单解析、修正、产品生成和对话 |
| `/history` | `HistoryPage` | 已登录 | 当前用户解析历史 |
| `/quotation-tasks` | `QuotationTasksPage` | 已登录 | 报价任务、确认、实时日志与失败行恢复 |
| `/layout-recognize` | `LayoutRecognizePage` | 已登录 | 图片布局识别、双轨编辑、物料生成 |
| `/inventory` | `InventoryDashboardPage` | 已登录 | 库存下载/上传、趋势查验和分类 |
| `/debug` | `DebugPage` | 管理员 | 直接测试 SKU 搜索工具 |
| `/trace` | `TracePage` | 管理员 | 查看最近 30 天 LLM trace |
| `/all-history` | `AllHistoryPage` | 管理员 | 浏览全部用户解析历史 |

当前主页提供报价、库存、个人历史和用户脚本下载入口；布局及管理员页面虽然有路由，但不应假设所有页面都在主页有导航按钮，必要时可直接访问路径。

## 状态分层

- `client/src/stores/authStore.ts`：access token、本次加载已验证的用户与刷新流程。
- `client/src/stores/tableParseStore.ts`：输入、颜色、解析 items、产品、图片模式和解析事件桥接。
- `client/src/stores/layoutStore.ts`：单个当前布局及全部墙/块编辑算法。
- `client/src/stores/quotationStore.ts`：任务列表、选中详情、两路 SSE、确认和草稿。
- 页面局部 state：库存 job UI、历史详情选择、图片临时数据、布局物料输出等。

浏览器持久化不是统一数据库：解析 items、当前布局、报价草稿、库存最近结果和 access token 使用不同 `localStorage` key；用户历史、笔记和报价任务则由服务端 SQLite 保存。清除浏览器数据不会删除服务端记录，服务端重启也不会删除 SQLite，但会丢失库存 job 等内存状态。

## 通信约定

- 普通 JSON 请求统一优先使用 `client/src/lib/fetchWithAuth.ts`。
- LLM POST 返回 SSE 流，组件/store 从响应体读取事件。
- 报价和库存的长连接使用 `client/src/lib/sseStream.ts`，支持 AbortController 与有限指数退避。
- 浏览器不直接连接 Odoo worker；所有 Odoo 队列操作先到 server，再由 server 通过 WebSocket 与 `auto` 通信。
- `script` 用户脚本是例外：它安装在 Odoo 页面，直接操作 Odoo DOM，与 React SPA 不共享状态。

## 专题文档

- [清单解析与对话](table-parse-and-chat.md)
- [布局识别](layout-recognize.md)
- [报价与库存](quotation-and-inventory.md)
- [管理、历史与追踪](admin-history-and-trace.md)
