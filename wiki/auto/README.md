# Auto Worker

`auto/` 是运行在受控电脑上的独立 Playwright worker，不是 Railway 服务的一部分。它主动连接 Railway server，复用持久 Chromium profile 操作 Odoo。目前报价和库存 worker 流程均已实现。

## 已实现能力

报价：

- 在 Odoo Sales 中搜索并打开目标报价单。
- 核验报价编号、公司和现有行，向 server 发起用户确认。
- 支持 `overwrite` 和 `append` 写入模式；overwrite 保留型号与数量均匹配的行，删除其余行后按输入重写。
- 逐行填写产品与数量，回传逐行结果、进度及最终报价快照。
- 任务级失败、部分失败、中止和断线清理。

库存：

- 从 Odoo 下载产品库存 CSV 并回传。
- 针对 server 给出的低库存产品查询近期库存移动趋势。
- 流式回传单项趋势和进度，支持 server 发出的中止指令。

通信层已实现协议版本校验、共享 token 鉴权、ready/busy 单任务约束、30 秒心跳、连续丢失确认后的重连、带 jitter 的指数退避，以及未 ack 消息重放。

## 安装与配置

要求 Node.js 20 或更高版本，并安装 Chromium：

```bash
cd auto
npm ci
npx playwright install chromium
```

按 `auto/.env.example` 在 auto 运行电脑配置本地环境：

| 变量 | 说明 |
| --- | --- |
| `AUTO_SERVER_URL` | 生产使用 `wss://<Railway 域名>/api/auto/connect`，本地可用 `ws://localhost:3023/api/auto/connect` |
| `AUTO_WORKER_TOKEN` | 必须与 Railway server 的同名变量完全一致 |
| `AUTO_PROFILE_DIR` | 必填的 Chromium 持久用户目录；`.env.example` 使用 `./data/browser-profile` 作为示例 |
| `ODOO_BASE_URL` | Odoo 入口地址 |
| `AUTO_HEADLESS` | 当前首次登录和人工确认环境建议 `false` |
| `AUTO_CONFIRM_TIMEOUT_MS` | 报价用户确认等待时间，默认 300000 毫秒 |

不要提交实际 `.env`、worker token、Odoo Cookie 或 browser profile。profile 等同于登录凭据，应限制本机访问并纳入安全清理流程。

## 首次登录与运行

先初始化持久登录态：

```bash
npm run init-session
```

浏览器打开后手工登录 Odoo，再按终端提示保存会话。随后构建并启动：

```bash
npm run build
npm start
```

开发时可使用 `npm run dev`。生产 worker 应由本机服务管理器保持运行，但同一 server token 不应同时启动多个 worker 实例。

## 运行边界

- 每次只执行一个任务，报价任务在 server 调度中优先于库存任务。
- Odoo DOM、权限、语言、菜单和导出格式变化都可能使自动化失败；选择器不是 Odoo 官方 API 合约。
- 断线会中止当前浏览器上下文。报价任务可由 server 持久队列回收，库存任务只存在 server 内存中。
- 报价写入不是跨 Odoo 与 server 的原子事务。中途中止前已经写入的行可能保留，重试前必须核验现有行。
- worker 收到任务才启动持久 Chromium，任务结束后关闭 context，但保留 profile。
- 此目录不由根 `railway:build` 构建，也不应为了“全仓部署”而加入 Railway 服务。

## 故障定位

- 连接立即以鉴权错误关闭：核对两端 `AUTO_WORKER_TOKEN` 和协议版本，不要在日志中打印 token。
- 循环重连：检查 Railway 域名、`wss://`、服务在线状态及网络代理。
- 提示未登录：重新运行 `npm run init-session`，确认 `AUTO_PROFILE_DIR` 未变化且 profile 可写。
- 报价或库存页面超时：先人工打开同一 Odoo 页面确认账号权限和页面结构，再检查 worker 日志中的步骤，而不是盲目重试写入。
