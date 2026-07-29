# Railway 部署

本文只描述当前仓库的实际部署方式。Railway 产品界面和行为可能变化，平台操作以 [Railway 官方文档](https://docs.railway.com/) 为准。

## 部署结构

Railway 上只部署一个 Node.js Web 服务：

- `railway.json` 指定 `railpack` builder。
- 构建命令是根目录的 `npm run railway:build`。
- 启动命令是根目录的 `npm run railway:start`。
- 根 `package.json` 只有这两个脚本，没有普通的 `build` 或 `start`。
- 构建依次对 `client`、`script`、`server` 执行 `npm ci` 和各自的构建。用户脚本构建产物会复制到 `server/public/script/`，前端产物位于 `client/dist/`。
- 运行期只启动 `server/dist/index.js`。Express 同时提供 API、前端静态文件和用户脚本下载。
- `auto/` 不在根构建命令中，也不部署到 Railway。它必须运行在能访问 Odoo、能保存 Chromium profile 的独立电脑上，并主动连接 Railway 服务。

当前要求 Node.js 20 或更高版本。

## 创建服务

1. 在 Railway 创建项目并从本仓库创建服务，服务根目录保持仓库根目录。
2. 不要把 Root Directory 改为 `server`，否则根脚本无法先构建前端和用户脚本。
3. `railway.json` 已包含 Railpack、构建命令、启动命令及失败重启策略，通常无需在控制台重复覆盖。
4. 为服务生成公开域名。浏览器访问、HTTP API、SSE 以及 auto worker 的 WebSocket 都使用同一个域名和端口。

Railway 会提供运行端口；服务读取 `PORT` 并监听 `0.0.0.0`。不要在公开域名上另行暴露多个应用端口。

## Volume

生产数据必须使用 Railway Volume。`railway.json` **不会创建或挂载 Volume**，必须在 Railway 项目界面为此服务单独添加，并将挂载路径设为：

```text
/data
```

同时设置：

```text
DB_DIR=/data
```

两者必须一致。仅设置 `DB_DIR=/data` 而未挂载 Volume 时，文件仍写入临时容器文件系统，重新部署后可能丢失；仅挂载 Volume 而未设置 `DB_DIR` 时，应用也不会自动改用 `/data`。

Railway Volume 的挂载、备份、限制及计费以 [Volumes 官方文档](https://docs.railway.com/reference/volumes) 为准。

## 环境变量

以下名称来自 `server/.env.example` 和当前代码。值应只配置在 Railway Variables，不要写入仓库或文档。

| 变量 | 作用 | 生产说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 文本 Agent | 聊天、表格解析和布局文本编排需要 |
| `OPENROUTER_API_KEY` | 多模态 Agent | 图片清单和布局 OCR 需要 |
| `PORT` | HTTP 端口 | 通常使用 Railway 注入值 |
| `AUTO_PROCESS` | 启动时处理原始 CSV | 默认 `false`；生产环境谨慎开启 |
| `AUTO_INGEST` | SQLite 为空时导入 Exposed CSV、引用表和向量库 | 默认 `false`；需要 `/data` 中已有输入文件 |
| `CHAT_LOG` | 写入 Markdown 对话日志 | 默认 `false`；当前写到应用构建目录旁，不受 `DB_DIR` 或 Volume 管理 |
| `TRACE_LOG` | 将 LLM trace 写入 SQLite | 默认 `false`；内容可能包含用户输入和模型输出 |
| `JWT_ACCESS_SECRET` | Access Token 签名 | 必填，不能保留示例值 |
| `JWT_REFRESH_SECRET` | Refresh Token 签名 | 必填，必须与 Access Secret 不同 |
| `ADMIN_USERNAME` | 首次播种管理员用户名 | 必填，不能保留示例值 |
| `ADMIN_PASSWORD` | 首次播种管理员密码 | 必填，至少 8 位，不能保留示例值 |
| `DB_DIR` | SQLite、LanceDB 和 CSV 数据目录 | Railway 固定设为 `/data` |
| `AUTO_WORKER_TOKEN` | server 与 auto worker 的共享鉴权 token | 两端必须完全一致，使用高熵随机值 |

`server/.env.example` 目前还列有 `OPENROUTER_MODEL`，但当前代码**不读取该变量**。模型由 `server/src/llm/provider.ts` 中的默认配置决定；在 Railway 设置 `OPENROUTER_MODEL` 不会改变运行模型。

`CHAT_LOG=true` 时，当前 logger 在编译后的 `server/dist/log/` 写文件，而不是写入 `/data`。Railway 重部署后这些文件不保证保留；若需要审计留存，应先修改实现和数据保护方案，不能把当前 Markdown 日志当作可靠持久化。

服务启动会拒绝缺失、仍为示例值或不符合要求的 JWT 与管理员配置。`AUTO_WORKER_TOKEN` 未设置时 WebSocket worker 无法通过鉴权。

## 首次启动与检查

部署日志应依次显示数据库、BM25 索引和 HTTP 服务初始化。完成后检查：

- 公开域名能加载前端，而不是只返回 API 文本。
- 能使用配置的管理员账号登录。
- 重新部署后用户与任务仍存在，以确认 `/data` 确实挂载。
- 外部 auto worker 使用 `wss://<域名>/api/auto/connect`，并在前端显示在线。
- 图片功能只有在 `OPENROUTER_API_KEY` 可用时工作；文本 Agent 只有在 `DEEPSEEK_API_KEY` 可用时工作。

## 数据与安全备份

`/data` 中至少可能包含 `users.sqlite`、`sku.sqlite`、`sku.lance/` 以及导入用 CSV。两个 SQLite 数据库都启用了 WAL；`users.sqlite` 保存账号、历史、笔记、trace 和报价任务，属于敏感数据。

不要在服务持续写入时只复制单个 `.sqlite` 文件。这样可能漏掉对应的 `-wal` 内容，得到不一致或缺数据的副本。安全方式二选一：

1. 暂停服务写入或停止服务后，完整复制 `/data`，包括 SQLite 主文件、`-wal`、`-shm`、LanceDB 目录和所需 CSV。
2. 服务仍运行时，使用 SQLite 自带的在线备份能力为每个数据库生成一致快照，再导出快照；不要用普通文件复制替代在线备份。

恢复时先停止服务，将完整备份恢复到挂载的 `/data`，确认文件所有权和目录结构正确，再启动服务。SQLite 快照与 `sku.lance/` 应来自同一数据版本；只恢复其中一方可能让结构化搜索与向量搜索结果不一致。

Railway 平台自身的 Volume 备份与恢复能力以官方文档为准。任何导出文件都应加密保存并限制访问，不要上传到 Git。

## 已知运行边界

- 单个 server 进程只维护一个 auto worker 连接；当前不是多 worker 调度系统。
- 报价任务持久化到 SQLite，worker 断线时运行任务可被回收并重新排队。
- 库存 job、库存 worker 子任务、SSE 订阅和 Refresh Token 有效集合只在内存中。服务重启会丢失这些运行态，用户可能需要重新登录或重新发起库存查询。
- Volume 通常约束服务副本和持久盘的挂载方式；不要在未验证共享写入安全性的情况下扩为多个同时写 SQLite 的实例。

## 配置来源

- 构建和启动：根 `package.json`
- Railway builder 与命令：`railway.json`
- 环境变量名称：`server/.env.example`
- 环境变量实际读取：`server/src/config/env.ts`
- 数据初始化与通信：`server/src/index.ts`
