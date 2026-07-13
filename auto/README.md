# DUKO Auto

旧电脑上运行的自动化 worker，接收 Railway server 派发的报价填写任务，
使用 Playwright 有头浏览器在 Odoo 中执行逐行写入。

## 架构

```
Railway Server  ←WebSocket→  auto（本服务）  →Playwright→  Odoo
```

- auto 主动连接 Railway server 的 `/api/auto/connect` WebSocket 端点。
- 收到任务后才启动有头 Chromium（复用持久化 profile 保留登录态）。
- 任务结束后关闭浏览器；profile 保留供下次复用。

## 首次部署

### 1. 安装依赖

```bash
cd auto
npm install
```

### 2. 安装 Playwright 浏览器

```bash
npx playwright install chromium
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env`，填写：

```env
AUTO_SERVER_URL=wss://your-railway-domain.up.railway.app/api/auto/connect
AUTO_WORKER_TOKEN=<与 server/.env 中的 AUTO_WORKER_TOKEN 完全一致>
AUTO_PROFILE_DIR=./data/browser-profile
ODOO_BASE_URL=https://dukouserp.com/odoo/
AUTO_HEADLESS=false
```

> `AUTO_WORKER_TOKEN` 用 `openssl rand -hex 32` 生成，server 和 auto 两端必须相同。

### 4. 初始化 Odoo 登录态（首次）

```bash
npm run init-session
```

会打开浏览器窗口，手动登录 Odoo，登录成功后回到终端按回车保存 profile。

### 5. 启动 auto 服务

```bash
npm start
```

开发模式（文件变动自动重启）：

```bash
npm run dev
```

## 运行时行为

- 启动后自动连接 server，鉴权通过后发送 `ready` 等待任务。
- 收到任务 → 启动浏览器 → 检测登录态 → 逐行填写 → 上报结果 → 关闭浏览器 → 等待下一个任务。
- 断线后自动指数退避重连（1s → 2s → 4s → ... → 60s 上限）。
- 应用层心跳 30s 一次，连续 3 次未收到回复主动断开重连。

## 目录结构

```
auto/
  src/
    index.ts          # WebSocket 客户端、重连、心跳、任务调度
    config.ts         # 环境变量加载与校验
    protocol.ts       # 消息类型 + Zod 入站校验
    browser.ts        # 每任务启动/关闭 persistent Chromium
    init-session.ts   # 首次登录态初始化脚本
  data/
    browser-profile/  # Chromium userDataDir（保留 Odoo cookies）
  package.json
  tsconfig.json
  .env.example
```

## 当前进度

- ✅ WebSocket 客户端、重连、心跳
- ✅ 浏览器启动与 Odoo 登录检测
- ⏳ Odoo `/odoo/orders` 报价单搜索与核验（步骤 5）
- ⏳ 报价逐行填写逻辑迁移（步骤 6）
