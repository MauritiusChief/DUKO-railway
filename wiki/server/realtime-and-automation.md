# 实时通信与自动化

## 通信分层

浏览器与 server 使用普通 HTTPS 请求提交操作，并使用 Server-Sent Events 接收单向实时更新。server 与外部 auto worker 使用同一 HTTP 服务上的 WebSocket 双向通信。server 自身不启动 Chromium，也不直接操作 Odoo DOM。

### SSE

Agent 路由会流式发送轮次开始、工具调用、回复文本片段、最终结果和错误。报价侧分别提供单任务逐行事件及全局 worker/Agent 状态、队列和当前用户任务列表。库存侧发送阶段、进度、低库存项、单项趋势和最终分类。

SSE 订阅只存在内存中。断线重连后，报价和库存订阅会先发送当前快照；报价快照来自 SQLite，库存快照只来自尚未过期的内存 job。SSE 不是消息队列，客户端离线期间的每条瞬时事件不会永久保存。

报价任务的详情与 SSE 会检查任务创建者或管理员权限。全部库存端点要求 `manager` 或 `admin` 角色，且快照、SSE 与取消共用按 job `userId` 的所有权判断——非创建者无法读取或订阅他人 job。

### Auto WebSocket

worker 主动连接 `/api/auto/connect`，以协议版本和 `AUTO_WORKER_TOKEN` 完成 `hello` 鉴权，然后发送 `ready`。当前只支持一个全局 worker 连接和单任务执行。协议当前版本为 `3`：报价任务行与快照携带可选 `discount`（百分数，缺省表示不指定）；server 与 worker 必须同步升级，否则旧 worker 会因版本不匹配被拒绝连接。

应用层每 30 秒心跳。worker 连续三次没有收到确认会断开并指数退避重连；server 也定期检测心跳超时。需要确认的重要上报带递增 `attempt`，server 回复 `ack`，worker 重连后重放未确认消息。

## 报价自动化

报价任务先持久化到 `users.sqlite`，按 FIFO 派发。报价优先于库存任务。worker 接受任务后在 Odoo 中：

- 搜索报价单并核验编号及目标信息。
- 读取已有报价行，向用户发出覆盖/追加前的确认请求。
- 按选择的 write mode 写入产品型号、数量与可选折扣并逐行上报；overwrite 保留型号、数量（及指定折扣）均匹配的行，其余删除后按输入重写；CSV 未指定折扣的输入行不读取、不清零 Odoo 现有折扣。
- 完成后读取最终快照（含折扣），由 server 持久化并复核最终状态。

用户确认通过 HTTP 提交，server 再经 WebSocket 返回 worker。待确认内容写入 SQLite，因此页面刷新可以重现确认卡片；确认等待仍受 worker 超时限制。

worker 断线时浏览器任务会被中止，server 将符合条件的 running 报价回收到队列或在重试耗尽后失败。旧连接迟到的结果会根据任务状态和 attempt 丢弃。由于 Odoo 是外部系统，断线前已写入的行不能由 server 数据库自动回滚。

## 库存自动化

worker 已实现两类库存任务：

- `inventory-download`：在 Odoo 导出产品 CSV 并回传 server。
- `inventory-trend`：逐项读取指定月份范围内的库存移动并流式上报结果。

库存任务使用负数内存 task ID，与报价数据库正数 ID 隔离。报价队列为空时才派发库存任务。当前 pending inventory 是单槽，新任务可能取代尚未派发的旧 pending 任务；库存流程不适合作为可靠持久队列。

server 支持用户直接上传 CSV，跳过下载步骤，但趋势查验仍需要在线 worker。运行中的 job 与趋势中间结果只在内存中，服务重启后不可恢复；成功完成的最终分类会持久化到 `sku.sqlite` 的 `inventory_results`（全局共享最近 20 条）。

## 安全与部署边界

- 生产页面应通过 HTTPS，worker 应使用 `wss://`。
- worker token 在 WebSocket 消息中传输，因此不能使用明文公网 `ws://`。
- auto 的 Chromium profile 保存 Odoo 登录态，必须只保存在受控电脑并限制文件访问。
- `auto/` 不部署到 Railway；它需要有头浏览器、持久 profile 和可交互登录环境。
- 当前单 worker 设计不支持水平扩展、多 worker 抢占或跨 server 实例协调。
