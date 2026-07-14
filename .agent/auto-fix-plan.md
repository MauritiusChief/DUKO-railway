# Auto Worker 与 QuotationTasks 修复计划

## 目标

修复报价单自动化中筛选、搜索和结果点击的时序问题，消除页面无意义停顿；使 QuotationTasks 页面上的任务列表、Auto Worker 状态和执行日志具备可靠的实时更新能力；避免 Worker 重连时同一任务被并发执行。

本计划仅覆盖已确认的问题，不包含改写报价单产品行、数量或覆写模式行为的改动。

## 已确认现状

### 浏览器自动化

- `auto/src/odoo/sales-search.ts` 的 `removeMyQuotationsFacet` 使用 `.o_searchview_facet .o_facet_remove` 匹配全部筛选项，而非仅 `My Quotations`。
- 该函数每删除一个筛选项后，都会等待页面中所有 facet 删除按钮消失。若仍有其他筛选项，每次最多额外等待 15 秒。这是“打开页面后停一段时间”的首要原因。
- `searchQuotation` 在按下 Enter 后仅等待任意第一条数据行可见。筛选前的旧行尚未被 Odoo 替换时，这个等待会立即成功。
- `openFirstResult` 无条件点击第一行，未确认该行报价单号等于目标单号。因此可能在新搜索结果尚未渲染时打开旧结果。
- `searchQuotation` 先等待首行存在，导致零结果场景 30 秒后以超时失败，`navigateAndSearch` 中的“未找到该报价单”分支无法生效。
- `checkOdooLogin` 与 `openFirstResult` 使用 `networkidle`。Odoo 的轮询或长连接会让这两个等待分别额外消耗最多 30 秒和 15 秒，且超时被忽略。

### Worker 生命周期

- Auto WebSocket 重连成功后会立即发送 `ready`，即使前一个 `handleTaskAssigned` 仍在执行浏览器任务。
- 断线仅取消确认等待，不会中止运行中的浏览器任务，也没有 busy 或 task-id 去重保护。
- 服务端在 Worker 断线时会回收 running 任务；Worker 重连后立即 ready 可导致同一任务被重新派发，同时旧执行继续操作相同的 persistent profile。

### QuotationTasks 实时状态

- 日志为真实 SSE：浏览器以 `fetch` 消费 `/api/quotation-tasks/:id/events` 的 `text/event-stream`，服务器从 Worker WebSocket 消息广播为 SSE 事件。
- 当前 SSE 不是原生 `EventSource`，而是 `ReadableStream` 解析器；连接结束或报错后只静默退出，不会重连。
- 页面只在挂载时读取一次任务列表和 Auto 在线状态，因此任务状态、当前任务、Worker 在线/离线状态会陈旧。
- 页面仅当已选任务的详情状态已经是 `running` 时建立 SSE。选中 queued 任务后，如果它转为 running，页面不会得到转换事件，也不会自动订阅。
- 收到 `task-completed` 后先追加完成日志，随后调用 `selectTask`。后者清空 `sseLog`，所以完成提示会立即丢失。

## 修复顺序

按以下顺序实施，保证先消除可能写错单的高风险自动化问题，再完善可观测性与重连可靠性。

1. 修复销售列表筛选和搜索结果等待。
2. 为 Worker 增加单任务执行约束及断线恢复策略。
3. 让任务页持续刷新摘要状态，并修复 queued 到 running 的订阅时机。
4. 为浏览器 SSE 增加受控重连和日志保留。
5. 补充针对核心状态机和搜索时序的测试，执行构建验证。

## 1. 修复筛选、搜索与点击

涉及文件：

- `auto/src/odoo/selectors.ts`
- `auto/src/odoo/sales-search.ts`
- `auto/src/browser.ts`

### 1.1 仅移除 My Quotations

1. 增加能定位 facet 容器或 facet 标签文本的选择器，而不是复用全局删除按钮选择器。
2. 在 `removeMyQuotationsFacet` 中遍历 facet 容器，读取可见标签，仅选择文本规范化后等于 `My Quotations` 的项。
3. 点击该项的删除按钮后，等待该 facet 容器 detached 或隐藏；不要等待其他 facet 消失。
4. 若目标 facet 不存在，立即返回；保留合理的显式超时及可诊断错误信息。
5. 不删除用户主动设置的其他筛选条件。

验收：存在多个 facet 时，只移除 `My Quotations`，总耗时不再按其余 facet 数量累加；其他筛选保持不变。

### 1.2 等待目标搜索结果而非任意旧行

1. 在输入前取得列表当前可识别状态，例如首行文本、行数或加载指示器状态。
2. 清空并填入目标报价单号，按 Enter 后等待 Odoo 搜索完成。优先使用 Odoo 的加载遮罩/请求完成状态；若页面结构没有稳定加载标志，则等待表格数据状态相对输入前发生变化。
3. 构建精确匹配目标报价单号的行定位器。匹配时对可见单元格文本进行 trim；不要使用 contains 作为最终选择条件。
4. 等待条件必须允许两种终态：精确匹配行出现，或列表刷新完成且无数据行。
5. 搜索完成后由 `navigateAndSearch` 判断精确匹配行数量：零条抛出 `未找到该报价单`；多条记录诊断信息并选择第一条精确匹配行。
6. 将 `openFirstResult` 改为接收目标报价单号或已定位的精确结果行，禁止无条件点击列表第一行。

验收：旧列表在 Enter 后短暂保留时，不会点击旧行；不存在目标单号时快速返回“未找到该报价单”，而不是 30 秒 selector 超时；进入详情页后单号校验仍保留，作为最后防线。

### 1.3 去除不可靠的 networkidle 延迟

1. 在 `checkOdooLogin` 中移除 `networkidle` 等待：`page.goto` 完成 `domcontentloaded` 后，检查当前 URL 是否为 `/web/login`、`.oe_login_form` 是否存在，并等待一个稳定的已登录 Odoo 业务页面元素可见；不依赖 Odoo 的轮询或长连接进入 network idle。
2. 在打开详情后，保留对 `DETAIL_QUOTATION_NUMBER` 的可见等待，并以该元素文本或报价单表格等后续必要元素作为页面就绪条件；移除 `networkidle`。
3. 所有保留的等待应只服务于后续即将使用的 UI 元素，并保留明确超时。

验收：Odoo 保持长连接时，登录检查和详情打开不会额外等待 15 至 30 秒；页面未加载时仍在明确超时后失败。

## 2. Worker 单任务与断线恢复

涉及文件：

- `auto/src/index.ts`
- 必要时 `auto/src/browser.ts`
- 必要时 `server/src/services/ws-handler.ts`

### 2.1 在 Auto 客户端建立忙碌状态

1. 在 `AutoClient` 中维护当前执行任务的 task id 与执行 Promise，收到 `task-assigned` 时先检查是否忙碌。
2. 对同一 task id 的重复派发，不启动第二个浏览器流程；仅按协议处理必要的重复确认或接受消息。
3. 对不同 task id 的并发派发，拒绝执行并输出明确日志，不能覆盖当前任务状态。
4. 仅当浏览器执行、最终上报和确认状态清理全部结束后，清除 busy 状态并发送 `ready`。

### 2.2 明确断线策略

推荐策略：客户端断线后让当前浏览器任务继续完成，但在任务完成前不发送 `ready`；所有最终/逐行消息继续进入待重放队列，重连后重放。这样不会重新领取任务，也能保留已完成结果。

1. `onDisconnected` 不应将正在执行的确认自动转换为普通任务超时并继续造成模糊状态。确认连接丢失时可结束当前确认等待，但要将任务终止为可上报的明确失败结果，或将确认等待与连接状态解耦并在重连后继续等待，二者需选择一种并统一实现。
2. `open` 事件只在没有当前执行任务时发送 `ready`；重连后先 `hello`、重放待确认消息，再根据 busy 状态决定是否 ready。
3. 完成处理应使用 `finally` 清除当前任务标记，确保异常路径也不会永久卡住。
4. 服务端 `handleReady` / `tryDispatch` 保持单 worker 的 ready 语义；如客户端明确报告 busy，可增加服务端防御性校验，拒绝在 active task 未清除时分配新任务。
5. 保持服务端断线回收策略与客户端策略一致。若服务端已将任务回收为 queued，旧实例完成后的消息必须视为陈旧并丢弃，不能再次写入；该行为当前已有部分保护，需以集成测试确认。

验收：网络抖动、重复 `task-assigned` 或重连时，同一 persistent profile 最多只有一个浏览器任务；Worker 只有在确实空闲后才会接收下一个任务；任务状态不会因旧实例结果覆盖重派后的结果。

## 3. QuotationTasks 实时摘要与订阅时机

涉及文件：

- `client/src/pages/QuotationTasksPage.tsx`
- `client/src/stores/quotationStore.ts`
- 如需推送全局状态，新增或扩展 `server/src/routes/quotation.ts`、`server/src/services/sse-broadcast.ts`

### 3.1 选择全局状态更新方式

优先采用轻量轮询，而非为 Auto 在线状态额外建立全局 SSE：现有 API 已提供完整摘要，任务页数量有限，且 Worker 状态不要求毫秒级更新。

1. 页面挂载时立即加载任务和 active 摘要。
2. 页面可见期间以固定、保守间隔刷新 `fetchTasks` 与 `fetchActiveStatus`，建议 5 秒。
3. 页面隐藏时暂停轮询，页面重新可见时立即刷新。
4. 卸载时清理 interval 和 visibility listener。
5. 在创建、取消、任务 SSE 状态事件和完成事件后继续立即刷新，轮询仅作为遗漏事件或 Worker 状态变化的兜底。

验收：Auto Worker 连接、断开或接收任务后，页面最多一个轮询周期内显示正确在线状态和当前任务；任务列表状态不会停留在旧值。

### 3.2 queued 任务的 SSE 订阅

1. 用户选中 queued 或 running 任务时均建立该任务 SSE 订阅，而不是只订阅 running。
2. 订阅建立前中止旧任务的 controller；切换选中任务或卸载时中止当前 controller。
3. 处理 snapshot 事件：使用其状态更新已选任务详情和对应列表摘要，确保任务从 queued 转为 running 时无需依赖轮询才能更新。
4. 终态任务不必维持 SSE；收到终态状态或完成事件后关闭对应连接。

验收：用户选中 queued 任务后，Worker 接受任务时页面自动转为运行中；确认卡片和逐行日志均可在不刷新页面的情况下出现。

## 4. SSE 重连与日志保留

涉及文件：

- `client/src/stores/quotationStore.ts`
- `client/src/pages/QuotationTasksPage.tsx`

### 4.1 受控的 SSE 重连

1. 将当前 `fetchWithAuth(...).then(...)` 的单次读取封装为可取消的连接循环。
2. 非用户取消、非终态、非 HTTP 鉴权失败时，按有限指数退避重连，例如 1、2、5、10 秒，设置最大间隔。
3. 每次重连先读取服务端 snapshot；已有行结果由详情恢复，实时事件只追加尚未显示的行，避免重复日志。
4. AbortController 被中止时立即停止重连；切换任务时旧连接不得更新新任务的 store 状态。
5. 记录可观测的错误状态或控制台诊断，不再静默吞掉所有异常。

### 4.2 保留完成日志

1. 收到 `task-completed` 后先写入最终状态、快照和任务列表，再刷新详情。
2. 避免 `selectTask` 无条件清空当前任务的 `sseLog`；可将其改为仅在用户主动切换到不同 task id 时清空，或在刷新详情时合并已存在的实时日志与 REST 重建日志。
3. 对日志条目按 task id、line no 和事件类型去重，避免 REST 恢复与 SSE 同时到达时重复显示。
4. 完成提示保留在当前任务日志中，直到用户切换任务或显式清除。

验收：短暂断网后运行任务的日志恢复；任务完成的“全部完成/部分失败/任务失败”提示可见；刷新详情不会擦除刚收到的实时日志。

## 5. 测试与验证

现有 `auto` 和 `client` 没有测试脚本。实施时应先补充最小可维护测试覆盖，再运行 TypeScript 构建。

### 5.1 自动化搜索单元测试

推荐为 `sales-search` 提取可测试的定位/等待边界，使用 Playwright mock page 或静态测试页覆盖：

1. 含多个 facet 时仅删除 `My Quotations`。
2. 删除目标 facet 后，不等待其他 facet 消失。
3. Enter 后旧行短暂存在，新结果延迟出现时，仅点击精确匹配新单号的行。
4. 零结果完成后返回“未找到该报价单”。
5. 多个精确匹配行时行为确定且有日志。

### 5.2 Worker 生命周期测试

在 WebSocket handler 或 AutoClient 可注入依赖后覆盖：

1. 同一 task id 重复派发不启动第二次执行。
2. 执行中重连不发送 `ready`。
3. 任务完成后只发送一次 `ready`。
4. 服务端回收任务后收到陈旧完成消息，不会覆盖当前状态。

### 5.3 Client 状态测试

若项目引入 Vitest 或既有测试设施，覆盖：

1. 选中 queued 任务即订阅 SSE。
2. snapshot 和 task-status 会更新选中详情及任务列表。
3. 流关闭时按退避重连，Abort 后不重连。
4. task-completed 后完成日志仍存在。
5. 可见页面轮询、隐藏页面暂停、恢复可见时立即刷新。

### 5.4 命令验证

实施完成后至少运行：

```powershell
npm run build --prefix auto
npm run build --prefix client
```

并运行新增的对应测试命令。若自动化环境可以访问测试 Odoo，再执行一次真实但无写入的搜索验证，确认目标单号、零结果和多 facet 场景。

## 发布与回滚

1. 先发布 Auto 搜索修复，观察日志中筛选、搜索耗时和最终验证的单号。
2. 再发布 Worker 重连保护，模拟短暂 WebSocket 断线验证不会并发启动浏览器。
3. 最后发布客户端实时状态和 SSE 重连改动。
4. 保留详情页单号二次核验，任何搜索选择异常都必须在写入前失败。
5. 若新搜索等待与实际 Odoo DOM 不匹配，回退到上一版 Auto，并依据真实页面 DOM 调整选择器；不要放宽为“点击第一行”。
