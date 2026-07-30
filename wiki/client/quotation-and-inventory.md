# 报价与库存

报价和库存页面都通过 server 借用同一个 `auto` worker 操作 Odoo。浏览器只使用 REST/SSE，不直接连接 worker；server 与 worker 使用 WebSocket。当前 worker 同时最多执行一个任务，因此两类业务共享执行资源。

## 报价任务页

`client/src/pages/QuotationTasksPage.tsx` 左侧显示当前用户任务，右侧在未选中任务时显示创建表单，选中后显示确认、实时日志、最终 Odoo 快照和失败行。

创建表单接收报价单号、精准 Odoo 地址、CSV 和 append/overwrite 模式。CSV 是简单的首列型号、次列正整数格式，可选首行 header；不支持通用带引号/内嵌逗号 CSV 语法。报价号与 URL 至少提供一个，worker 优先尝试 URL，失败后按报价号搜索。

草稿保存在 `localStorage` 的 `duko_quotation_draft`。主页产品清单的“创建报价任务”只写草稿并跳转；任务必须在报价页再次提交。已创建任务与逐行结果保存在 `users.sqlite`，每用户最多 100 条。

## 报价状态与通信

`client/src/stores/quotationStore.ts` 同时维护两路可重连 SSE：

- 全局流：worker 在线状态、当前活跃报价、跨用户排队摘要和当前用户任务列表。跨用户摘要目前包含报价号和用户名，所有登录用户均可见。
- 选中任务流：状态快照、进度、逐行结果、确认请求和最终完成信息。

页面首次进入也用 REST 拉取快照，SSE 随后接管增量；刷新或重新选任务时可从 REST 详情重建逐行日志、待确认数据和最终快照。终态任务不保持单任务 SSE。

任务状态为 queued、running、completed、partial_failed、failed 或 cancelled。只有 queued 可从页面取消。详情、确认和订阅允许任务所有者或管理员访问，任务列表仍只列当前用户任务；当前取消的数据库操作再次按当前用户 ID 限定，因此管理员不能借此取消他人的 queued 任务。

服务端任务与队列见 `server/src/routes/quotation.ts`、`server/src/db/quotation.ts` 和 `server/src/services/ws-handler.ts`。worker 流程见 `auto/src/browser.ts`：

1. 复用持久化 Chromium profile 检查 Odoo 登录。
2. 打开精确 URL或搜索报价，核验单号，读取公司与已有行。
3. 把确认请求发回页面；用户确认后才写入，拒绝/超时使任务失败。
4. append 追加；overwrite 保留型号与数量均匹配的行，删除不在输入或数量不一致的行后按输入重写；逐行上报成功/失败。
5. 尝试保存并读取最终 Odoo 行快照。

失败行可复制，或填回创建表单以补写。worker 断线时运行中的报价任务首次回到队列并增加 retry，第二次回收会标记失败。

## 库存看板

`client/src/pages/InventoryDashboardPage.tsx` 路由由 `client/src/components/RoleGuard.tsx` 保护，仅 `admin` 与 `manager` 可访问（普通 `user` 直接访问会跳回主页）；服务端全部库存端点同样要求 manager/admin。入口按钮只存在于主页（TableParsePage），且仅 manager/admin 可见；报价任务页不再提供库存入口。

看板提供两种起点：

- 自动下载：worker 从 Odoo 产品页导出 CSV。
- 上传 CSV：浏览器读取文件文本，服务端立即清洗；后续趋势查验仍需要 worker。

用户设置可用库存阈值、趋势警告阈值和近期月份。`server/src/services/inventory.ts` 使用 SKU 清洗逻辑标准化 CSV，筛选 `freeToUse < threshold` 的型号，再让 worker 逐项提取近期出入库：

- 警告：低库存且近期出库量大于等于趋势阈值。
- 提醒：低库存且近期有出库，但未达到警告阈值。
- 信息：低库存且近期无出库。
- 无需注意：清洗后未落入低库存集合的数量。

页面可按出库或库存排序，信息区每页 100 条。库存页文本当前为硬编码中文，不跟随全局语言切换（角色标签“经理/普通用户”走 i18n）。

自动下载取得 CSV 后，服务端会同时将其以 `Product-raw-YYYY-MM-DD.csv`（UTC 日期）暂存到 `DB_DIR` 并清理旧文件，供管理员择机手动重建 SKU 数据；上传模式不暂存。暂存失败不影响本次识别。

## 库存状态与通信

创建 job 后，页面只在查询期间订阅该 job 的 SSE，处理阶段、日志、低库存统计、逐项趋势结果和终态。取消会向服务端请求中止 worker 任务，并在本地显示失败/用户取消。

库存 job 的运行态只存在于 `server/src/services/inventory.ts` 的内存 Map；终态超过约一小时清理，服务重启丢失。但**成功完成的最终分类会持久化**到 `sku.sqlite` 的 `inventory_results`（全局共享，最近 20 条），不再写浏览器 localStorage。页面挂载时拉取历史列表并默认加载最新一条，头部历史下拉可切换；运行期禁用历史切换以免增量事件覆盖选中结果。完成新任务后会刷新历史并选中新写入结果。“清空表格”只清当前视图，不删除数据库记录。

## 注意点

- 报价与库存共享单 worker 队列；worker 在线不代表任务会立即执行。
- 报价状态持久化；库存 job 运行态不持久化，但成功完成的最终分类会写入 `sku.sqlite`，两者恢复能力不同。
- 库存页面只在挂载时 REST 查询一次在线状态，不订阅报价页的全局 worker 状态流，显示可能滞后。
- 库存快照、SSE 和取消当前共用按 job `userId` 的所有权判断，且全部库存端点要求 manager/admin；jobId 仍应按敏感标识处理。
- 全局报价 SSE 的报价号和用户名是当前跨用户可见元数据；不得在该广播中继续加入客户或报价明细，直至授权边界被重新设计。
- 自动库存下载和趋势查验都依赖有效 Odoo profile；上传 CSV 只能绕过下载，不能绕过趋势查验。
- 趋势单项异常在 worker 中会记录为空 moves 并继续，最终可能被归入“信息”，应结合日志判断。
- 报价 overwrite 的准确语义由 `auto/src/odoo/write-lines.ts` 决定；不要与 `script/quotation.ts` 的 DOM 覆写算法混为一谈。
- `script` 用户脚本直接在用户当前 Odoo 页面写表，不创建服务端报价任务、没有 SSE 日志，也不受 worker 队列保护。
