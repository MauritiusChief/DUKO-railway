# 开发指南

## 前提

- Node.js 20 或更高版本，根 `package.json` 明确要求 `>=20`。
- 四个子项目各有独立 `package-lock.json`，没有根级 workspace 安装命令。
- `auto` 还需要 Playwright Chromium；真实自动化需要可用的 Odoo 账号和持久化登录 profile。

以下命令均从仓库根目录执行。

## 安装

```bash
npm --prefix client ci
npm --prefix server ci
npm --prefix auto ci
npm --prefix script ci
npm --prefix auto exec -- playwright install chromium
```

只开发某一部分时可只安装对应子项目。不要用根目录 `npm install` 代替子项目安装，根包没有应用依赖。

## 环境变量

服务端以 `server/.env.example` 为模板创建本地 `server/.env`。启动至少会严格校验以下值：

- `JWT_ACCESS_SECRET` 与 `JWT_REFRESH_SECRET`：必须设置且不能相同。
- `ADMIN_USERNAME`、`ADMIN_PASSWORD`：不能保留示例值，密码至少 8 位。

文本 Agent 需要 `DEEPSEEK_API_KEY`；图片清单和布局 OCR 需要 `OPENROUTER_API_KEY`。`PORT` 默认 `3023`，`DB_DIR` 可覆盖数据目录。注意示例文件中的 `DB_DIR=data` 已经构成覆盖：使用 `npm --prefix server ...` 时通常解析为 `server/data/`，不会使用下文的自动 `dev_data/`。`AUTO_PROCESS` 和 `AUTO_INGEST` 控制启动时的数据处理/导入，默认都关闭。`TRACE_LOG=true` 才记录 LLM trace。

`auto` 以 `auto/.env.example` 为模板创建 `auto/.env`，必须配置服务端 WebSocket URL、与服务端一致的 `AUTO_WORKER_TOKEN`、浏览器 profile 和 Odoo 地址。`AUTO_HEADLESS` 未设置时默认为 `false`。首次建立登录态：

```bash
npm --prefix auto run init-session
```

## 本地开发

分别启动服务端和客户端：

```bash
npm --prefix server run dev
npm --prefix client run dev
```

- Express 默认监听 `0.0.0.0:3023`。
- Vite 固定监听 `5273`，并把 `/api` 代理到 `http://localhost:3023`，配置见 `client/vite.config.ts`。
- WebSocket 没有独立端口，复用 Express 端口的 `/api/auto/connect`。

需要 Odoo 队列时另开进程：

```bash
npm --prefix auto run dev
```

用户脚本没有 watch/dev 命令；修改后重新构建，再在脚本管理器中更新构建产物。

## 构建与启动

分别构建：

```bash
npm --prefix client run build
npm --prefix script run build
npm --prefix server run build
npm --prefix auto run build
```

构建网页、用户脚本和服务端的仓库级命令为：

```bash
npm run railway:build
```

该命令会重新 `ci` 并依次构建 `client`、`script`、`server`，不会构建 `auto`。构建后的组合服务启动命令：

```bash
npm run railway:start
```

它等价于 `npm --prefix server start`。此时 Express 同时提供 API、WebSocket 和 `client/dist/`。`client` 也可用 `npm --prefix client run preview` 单独预览，但这不是完整应用服务。

## 测试

当前自动测试仅配置在服务端：

```bash
npm --prefix server test
```

Vitest 读取 `server/vitest.config.ts`，匹配 `server/src/**/*.test.ts`。现有测试重点覆盖结构化 SKU 搜索和布局物料清单算法。`client`、`auto`、`script` 没有 package test 命令；其基本静态验证分别依赖 build。

完整的非 Odoo 验证通常至少运行：

```bash
npm --prefix server test
npm --prefix client run build
npm --prefix server run build
npm --prefix auto run build
npm --prefix script run build
```

真实 Odoo 操作依赖账号、登录态和当时的页面 DOM，不能由上述单元测试证明。

## 数据处理命令

服务端提供两段 package script 数据命令：

```bash
npm --prefix server run db:process
npm --prefix server run db:ingest
```

- `db:process` 从 `<DB_DIR>/Product-raw.csv` 开始执行清洗/派生管线，生成 `Product.csv`、`Color.csv`、`Parts.csv`、`Items.csv` 和 `Exposed-*.csv`。
- `db:ingest` 读取 `<DB_DIR>/Exposed-Items.csv`，写入 `sku.sqlite`、`sku.lance/` 并加载引用数据。

`db:process` 还支持 `clean`、`color`、`parts`、`items`、`exposed` 阶段参数。完整刷新 CLI 没有 package script；先构建 server，再执行：

```bash
npm --prefix server run build
node server/dist/refresh-data-cli.js
```

完整刷新会依次重建派生 CSV、SQLite、LanceDB 和 BM25 初始化数据。该流程不是跨文件或跨数据库原子事务，运行前必须备份一致版本并确认恢复方式。

这些命令会修改数据目录，运行前应确认 `DB_DIR` 和输入 CSV。

## 数据目录

解析规则以 `server/src/config/env.ts` 为准：

- 设置 `DB_DIR` 时直接使用该目录；相对路径按进程工作目录解析。
- `tsx` 开发且未设置 `DB_DIR` 时使用仓库根的 `dev_data/`。
- 从 `server/dist/` 运行或 `NODE_ENV=production` 且未设置 `DB_DIR` 时使用仓库根的 `simvolume_data/`。

目录内可包含 `users.sqlite`、`sku.sqlite`、SQLite 的 `-wal`/`-shm` 文件、`sku.lance/` 和 CSV 输入/派生文件。它们是运行数据，不应当作为源码编辑。

`auto` 的默认示例 profile 是 `auto/data/browser-profile/`。其中包含 Odoo 登录状态，属于本机敏感运行数据。

## 生成文件

- `client/dist/`：Vite 网页产物。
- `server/dist/`：服务端 JavaScript 与声明文件。
- `auto/dist/`：worker JavaScript。
- `script/dist/duko-filler.user.js`：用户脚本产物；是否同时存在旧 source map 不应作为当前构建契约。
- `server/public/script/duko-filler.user.js`：`script` postbuild 复制的下载文件。
- `server/public/script/build-meta.json`：脚本构建时间戳，构建配置在 `script/rspack.config.js`。
- `*.tsbuildinfo`：TypeScript 增量/solution build 元数据，可能由 build 生成；`client/tsconfig.tsbuildinfo` 和 `server/tsconfig.tsbuildinfo` 当前已被 Git 跟踪，构建后应只保留符合本次源码变化的更新。

`dist/`、数据目录、`.env`、`auto/data/` 和 `server/public/script/` 已由 `.gitignore` 排除。不要手工修改生成文件；修改源码后重新构建。
