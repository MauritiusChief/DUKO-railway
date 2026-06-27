# Railway 部署与项目调整计划

## 目标

将当前项目部署到 Railway，使其可通过公网 HTTPS 在全美国稳定访问，并支持管理员只上传 `Product-raw.csv` 后，剩余 SKU 数据处理、SQLite 导入、LanceDB 向量库重建都在云端完成。

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

管理员上传 `Product-raw.csv` 后，云端执行完整数据管线：

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

上传后的服务行为：

- 导入过程中旧数据继续服务。
- 同一时间只允许一个导入任务运行。
- 导入成功后整体切换为新数据。
- 导入失败时保留错误状态，尽量不影响已存在数据。

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

CLI 仍可保留默认行为，但服务端后台任务应能显式传入 `/data`。

## 阶段 5：新增管理员上传 API

新增管理员专用数据管理路由。

建议文件：

```text
server/src/routes/adminData.ts
server/src/services/data-import-job.ts
```

建议接口：

```text
POST /api/admin/data/upload-product-raw
GET  /api/admin/data/import-status
POST /api/admin/data/rebuild
```

权限要求：

```text
authenticateToken
requireAdmin
```

上传接口行为：

```text
1. 校验管理员权限
2. 校验上传文件存在
3. 校验文件扩展名为 .csv
4. 限制文件大小，例如 50MB 或 100MB
5. 保存为 /data/Product-raw.csv.tmp
6. 校验 CSV 基本格式和必要列
7. 原子替换为 /data/Product-raw.csv
8. 启动后台导入任务
9. 立即返回当前导入状态
```

上传建议使用 `multipart/form-data`。可以引入 `multer`，也可以使用其他轻量方案。

## 阶段 6：新增后台导入 Job

不建议上传请求同步跑完整导入，因为 embedding 和 LanceDB 重建可能耗时较长，容易超时。

第一版建议使用进程内单任务 Job，不引入 Redis 或独立队列。

状态模型：

```ts
type ImportStatus = 'idle' | 'processing' | 'success' | 'failed';
```

状态内容：

```ts
{
  status: 'processing',
  step: 'ingesting',
  startedAt: string,
  finishedAt?: string,
  error?: string,
  counts?: {
    products?: number,
    parts?: number,
    items?: number,
    exposedItems?: number,
    vectors?: number
  }
}
```

Job 执行流程：

```text
1. 检查是否已有任务运行
2. 设置状态为 processing
3. 执行 runAllSteps(dataDir)
4. 初始化 SQLite
5. 初始化 LanceDB
6. 执行 ingestFromFile(/data/Exposed-Items.csv)
7. 执行 loadAllReferenceData(dataDir)
8. 执行 initBm25Index()
9. 设置状态为 success
10. 捕获错误并设置状态为 failed
```

导入完成后必须重建 BM25：

```ts
initBm25Index()
```

否则 SQLite 中的新数据已经存在，但 BM25 内存索引仍可能使用旧数据。

## 阶段 7：运行时数据刷新策略

第一版采用最小复杂度策略：

- 旧数据在导入过程中继续服务。
- SQLite 表使用事务性全量替换。
- LanceDB 使用现有全量替换流程。
- 导入完成后重建 BM25。
- 同一时间禁止第二个导入任务。

后续如果发现 LanceDB 重建期间有短暂查询失败，可以升级为蓝绿目录切换：

```text
/data/sku.lance.active
/data/sku.lance.next
```

第一版不建议直接引入该复杂度。

## 阶段 8：可选管理员页面

可以先只做 API，用 Postman 或 curl 上传。但为了日常使用，建议增加管理员页面。

建议新增：

```text
client/src/pages/AdminDataPage.tsx
client/src/pages/AdminDataPage.css
```

建议路由：

```text
/admin/data
```

页面功能：

- 选择 `Product-raw.csv`
- 上传文件
- 显示当前导入状态
- 显示当前步骤
- 显示错误信息
- 显示完成时间和导入数量

页面应使用现有 `AdminGuard` 保护。

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
8. 打开 Railway 生成域名测试。
9. 稳定后绑定自定义域名。

区域建议：

- 用户遍布全美国：优先 US East 或 Railway 推荐的美国默认区域。
- 西海岸用户明显更多：选择 US West。

## 阶段 11：安全要求

上传和导入相关接口必须满足：

- 仅 admin 可访问。
- 只接受 `.csv`。
- 限制文件大小。
- 上传到固定路径，不允许用户控制最终文件路径。
- 使用临时文件再原子替换，避免半写入文件被处理。
- 导入任务加锁，防止并发导入。
- 错误响应不要泄露 API key、绝对路径或敏感环境变量。

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
4. 上传 Product-raw.csv 成功
5. import-status 显示 processing
6. import-status 最终显示 success
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
4. 管理员上传 Product-raw.csv
5. 导入任务成功完成
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
5. 新增 `data-import-job` 服务。
6. 新增 admin 上传和状态查询 API。
7. 导入完成后刷新 SQLite、LanceDB 和 BM25。
8. 可选新增管理员上传页面。
9. 本地完整验证。
10. Railway 添加 Volume 和环境变量。
11. Railway 部署。
12. 上传真实 `Product-raw.csv` 并验证核心功能。

## 第一版建议范围

第一版建议先实现：

- Railway 部署配置。
- `script/` build 集成。
- `server` build 跨平台化。
- `DB_DIR` 统一。
- admin CSV 上传 API。
- 后台导入 job。
- import status API。
- BM25 重建。
- Railway 部署说明文档。

管理员上传 UI 可以作为第二步。如果上线后需要非技术人员操作，则应在第一版中一起完成。
