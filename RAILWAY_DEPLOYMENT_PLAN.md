# Railway 部署与项目调整计划

## 目标

将当前项目部署到 Railway，使其可通过公网 HTTPS 在全美国稳定访问。当前阶段只需要一次性手动将 `Product-raw.csv` 放入 Railway Volume，随后在云端手动运行数据刷新命令，完成 SKU 数据处理、SQLite 导入和 LanceDB 向量库重建。

本阶段不新增管理员上传 API，也不新增管理员页面。未来接入 ERP API 时，复用同一套云端数据刷新流程，只替换 `Product-raw.csv` 的来源。

最终目标架构：

```text
Browser
  |
  | HTTPS
  v
Railway Web Service
  |-- /api/*                  Express API
  |-- /*                      client/dist 静态前端
  |-- /api/script/download    ScriptCat/Tampermonkey 脚本下载
  |-- /data                   Railway Volume 持久化数据
```

## 部署范围

需要部署以下子项目：

- `client/`：构建前端页面，由 Express 在生产环境中 serve `client/dist`。
- `server/`：Express API、认证、静态文件服务、SKU 数据处理和导入。
- `script/`：构建 `duko-filler.user.js`，用于保留 `/api/script/download`。

不部署以下内容：

- `experiment/`
- `node_modules/`
- `dist/`
- `.env`
- 本地临时数据和日志

## Railway 生产数据目录

Railway 上添加 Volume，并挂载到：

```text
/data
```

生产环境变量：

```env
DB_DIR=/data
```

所有生产数据都应写入 `/data`：

```text
/data/Product-raw.csv
/data/Product.csv
/data/Color.csv
/data/Parts.csv
/data/Items.csv
/data/Exposed-Items.csv
/data/Exposed-Color.csv
/data/Exposed-Types.csv
/data/sku.sqlite
/data/users.sqlite
/data/sku.lance/
```

## 数据处理目标流程

一次性手动将 `Product-raw.csv` 放入 `/data` 后，云端执行完整数据管线：

```text
Product-raw.csv
  -> Product.csv
  -> Color.csv
  -> Parts.csv
  -> Items.csv
  -> Exposed-Items.csv
  -> Exposed-Color.csv
  -> Exposed-Types.csv
  -> SQLite sku.sqlite
  -> LanceDB sku.lance
  -> BM25 内存索引重建
```

刷新后的服务行为：

- 当前阶段只计划手动执行一次数据刷新。
- 数据刷新通过 Railway Shell 或 one-off command 手动触发。
- 数据刷新不通过 Web API 暴露给前端或管理员页面。
- 未来 ERP API 接入后，由 ERP 拉取流程替代手动放置 `Product-raw.csv`。

## 阶段 1：新增 Railway 部署入口

建议新增根级 `package.json`，只负责编排三个子项目的构建和启动。

预期脚本：

```json
{
  "private": true,
  "scripts": {
    "railway:build": "npm --prefix client ci && npm --prefix client run build && npm --prefix script ci && npm --prefix script run build && npm --prefix server ci && npm --prefix server run build",
    "railway:start": "npm --prefix server start"
  },
  "engines": {
    "node": ">=20"
  }
}
```

建议新增 `railway.json`：

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm run railway:build"
  },
  "deploy": {
    "startCommand": "npm run railway:start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

这样 Railway 从仓库根目录部署时可以明确知道如何构建和启动服务。

## 阶段 2：修复 server build

当前 `server/package.json` 的 `build` 使用 Windows 专用命令，例如 `md`、`xcopy`、`rd`，Railway Linux 环境会失败。

目标调整：

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:process": "tsx src/process-cli.ts",
    "db:ingest": "tsx src/ingest-cli.ts",
    "test": "vitest run"
  }
}
```

需要移除或停用：

```json
"prebuild": "npm run db:process && npm run db:ingest"
```

原因：

- 数据处理不应该在每次部署构建时执行。
- Railway build 阶段不适合写生产数据库。
- `server/src/data/` 当前已被 `.gitignore` 忽略，云端 build 阶段不应依赖它。

## 阶段 3：统一 DB_DIR

当前部分代码仍硬编码数据目录。需要统一改为使用 `DB_DIR`。

需要重点检查和调整：

```text
server/src/process-cli.ts
server/src/ingest-cli.ts
server/src/db/lance.ts
server/src/index.ts
```

目标：

- 本地默认仍能使用本地数据目录。
- Railway 生产环境使用 `DB_DIR=/data`。
- SQLite、LanceDB、CSV 中间产物都放在同一个可持久化目录下。

特别需要调整 `server/src/db/lance.ts`，避免继续硬编码：

```ts
path.resolve(__dirname, '../data/sku.lance')
```

目标语义：

```text
LanceDB path = <DB_DIR>/sku.lance
```

## 阶段 4：让数据处理函数支持传入 dataDir

当前 `process-cli.ts` 内部固定：

```ts
const dataDir = path.resolve(__dirname, 'data');
```

目标是将数据处理逻辑改为可复用函数：

```ts
runAllSteps(dataDir)
```

CLI 仍可保留默认行为，但 Railway 数据刷新命令应能显式使用 `/data`。

## 阶段 5：新增手动数据刷新 CLI

当前阶段不新增管理员上传 API、状态 API 或后台 job。改为新增一个可在 Railway Shell 或 one-off command 中手动执行的 CLI。

建议新增：

```text
server/src/refresh-data-cli.ts
```

建议新增 npm script：

```json
{
  "scripts": {
    "data:refresh": "node dist/refresh-data-cli.js"
  }
}
```

或在部署后直接运行：

```bash
node dist/refresh-data-cli.js
```

CLI 默认读取：

```text
<DB_DIR>/Product-raw.csv
```

Railway 生产环境中即：

```text
/data/Product-raw.csv
```

CLI 执行流程：

```text
1. 校验 DB_DIR 存在
2. 校验 /data/Product-raw.csv 存在
3. 执行 runAllSteps(dataDir)
4. 初始化 SQLite
5. 初始化 LanceDB
6. 执行 ingestFromFile(/data/Exposed-Items.csv)
7. 执行 loadAllReferenceData(dataDir)
8. 执行 initBm25Index()
9. 输出处理结果和计数
10. 失败时以非 0 exit code 退出
```

导入完成后仍必须重建 BM25：

```ts
initBm25Index()
```

否则 SQLite 中的新数据已经存在，但当前进程中的 BM25 内存索引仍可能使用旧数据。

如果数据刷新 CLI 是在独立 one-off command 中运行，Web Service 进程不会自动拿到新的 BM25 内存索引。刷新完成后应重启 Railway Web Service，让服务启动时重新读取 SQLite 并初始化 BM25。

## 阶段 6：一次性手动放置 Product-raw.csv

当前阶段只需要上传一次 `Product-raw.csv`，可以接受手动操作。

可选方式：

- 如果 Railway Dashboard 当前提供 Volume 文件上传能力，可以临时使用一次，将文件放到 `/data/Product-raw.csv`。
- 如果 Dashboard 不方便上传，则将 CSV 放到临时私有下载链接，再在 Railway Shell 中下载到 `/data/Product-raw.csv`。

临时下载方式示例：

```bash
curl -L "<temporary-csv-url>" -o /data/Product-raw.csv
```

建议下载后检查文件：

```bash
ls -lh /data/Product-raw.csv
head -n 1 /data/Product-raw.csv
```

然后运行数据刷新：

```bash
npm --prefix server run data:refresh
```

或：

```bash
node server/dist/refresh-data-cli.js
```

刷新完成后重启 Web Service，确保运行中的 Express 进程重新加载最新 SQLite、LanceDB 和 BM25。

## 阶段 7：未来 ERP API 演进方向

未来接 ERP API 时，不改变核心数据刷新管线，只替换 `Product-raw.csv` 的来源。

当前临时流程：

```text
手动放置 Product-raw.csv
  -> refresh-data-cli
  -> Product.csv / Items.csv / Exposed-Items.csv
  -> SQLite / LanceDB
```

未来 ERP 流程：

```text
ERP API 拉取 Product raw 数据
  -> 写入 /data/Product-raw.csv
  -> 同一套 refresh pipeline
  -> Product.csv / Items.csv / Exposed-Items.csv
  -> SQLite / LanceDB
```

因此第一版代码应尽量把核心逻辑设计成：

```text
refreshFromRawCsv(dataDir)
```

而不是绑定到上传 API 或页面。

## 阶段 8：运行时数据刷新策略

第一版采用最小复杂度策略：

- 数据刷新手动执行，计划只执行一次。
- Web Service 可在数据刷新完成后重启。
- SQLite 表使用事务性全量替换。
- LanceDB 使用现有全量替换流程。
- Web Service 重启后重新初始化 BM25。

后续如果发现 LanceDB 重建期间有短暂查询失败，可以升级为蓝绿目录切换：

```text
/data/sku.lance.active
/data/sku.lance.next
```

第一版不建议直接引入该复杂度。

## 阶段 9：Railway 环境变量

Railway Variables 至少配置：

```env
NODE_ENV=production
DB_DIR=/data
AUTO_PROCESS=false
AUTO_INGEST=false
CHAT_LOG=false
DEEPSEEK_API_KEY=...
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=qwen/qwen3.7-plus
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
ADMIN_USERNAME=...
ADMIN_PASSWORD=...
```

通常不要手动设置：

```env
PORT
```

Railway 会自动注入 `PORT`，当前服务已经读取该变量。

## 阶段 10：Railway 项目配置

Railway 操作步骤：

1. 从 GitHub 导入当前仓库。
2. 选择美国区域。
3. 使用 Nixpacks 构建。
4. 添加一个 Web Service。
5. 添加 Volume，挂载到 `/data`。
6. 配置环境变量。
7. 部署。
8. 一次性将 `Product-raw.csv` 放入 `/data/Product-raw.csv`。
9. 运行数据刷新命令。
10. 重启 Web Service。
11. 打开 Railway 生成域名测试。
12. 稳定后绑定自定义域名。

区域建议：

- 用户遍布全美国：优先 US East 或 Railway 推荐的美国默认区域。
- 西海岸用户明显更多：选择 US West。

## 阶段 11：手动数据操作要求

当前阶段没有 Web 上传接口，主要风险来自手动文件放置和命令执行。

要求：

- 文件最终路径固定为 `/data/Product-raw.csv`。
- 放置文件后检查文件大小和 CSV 表头。
- 数据刷新命令只在 Railway 运维环境中手动执行。
- 不把 `Product-raw.csv` 提交进 Git。
- 不在日志或文档中记录临时下载链接中的敏感 token。
- 刷新完成后重启 Web Service。

## 阶段 12：本地验证清单

本地部署构建验证：

```bash
npm run railway:build
npm run railway:start
```

本地功能验证：

```text
1. 首页可打开
2. admin 可以登录
3. /api/script/download 可下载脚本
4. 手动放置 Product-raw.csv
5. 手动执行 data:refresh 成功
6. 重启服务后数据仍可用
7. /api/check-exposed 可用
8. /api/generate-products 可用
9. /api/chat 中产品查询工具可用
10. 重启服务后数据仍可用
```

## 阶段 13：Railway 验证清单

Railway 首次部署后验证：

```text
1. 首页可打开
2. 登录可用
3. Cookie refresh 可用
4. `/data/Product-raw.csv` 已存在
5. 手动数据刷新命令成功完成
6. SKU 搜索有真实结果
7. Table parse 可用
8. Product generation 可用
9. Image parse 可用
10. /api/script/download 可用
11. 重新部署后 /data 数据未丢失
12. Railway service 重启后用户和 SKU 数据未丢失
```

## 推荐实施顺序

1. 新增根级 `package.json` 和 `railway.json`。
2. 修复 `server/package.json`，移除 Windows-only build 和 `prebuild`。
3. 统一 `DB_DIR`，让 CSV、SQLite、LanceDB 都使用 `/data`。
4. 修改 `process-cli.ts`，让数据处理函数支持传入 `dataDir`。
5. 新增手动数据刷新 CLI。
6. 数据刷新流程写入 SQLite 和 LanceDB。
7. 刷新完成后通过服务重启重新加载 BM25。
8. 本地完整验证。
9. Railway 添加 Volume 和环境变量。
10. Railway 部署。
11. 一次性放置真实 `Product-raw.csv`。
12. 手动运行数据刷新命令并验证核心功能。

## 第一版建议范围

第一版建议先实现：

- Railway 部署配置。
- `script/` build 集成。
- `server` build 跨平台化。
- `DB_DIR` 统一。
- 手动数据刷新 CLI。
- 一次性手动放置 `Product-raw.csv` 的操作说明。
- BM25 重建。
- Railway 部署说明文档。

不在第一版实现管理员上传 API、import status API 或管理员页面。未来接 ERP API 时，再把数据来源从手动文件替换为 ERP 拉取。
