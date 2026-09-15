# 库存调动历史本地库（move-history-db）计划

## 状态

**已实施（2026-09-15），待授权环境人工验证。** 验证项见"验证"一节的授权环境清单（首次导入、快速补齐停点、全量检查修复中断、state/facet 抽查）。

关键决策（实施前由维护者确认）：Location facet 双向覆盖已实测、库存放 server 端 SQLite、旧 `inventory-trend` 流程直接替换、同步分快速/全量两档（全量按 recentMonths 窗口补缺失行，不删除不更新已有记录）、直达 URL 已实测可直达且默认 "Status: Done" facet 保留、48h 重叠安全兜底、首次导入挂在第一次清点任务内自动完成。

### 实施偏差（与原方案的差异）

1. 旧 trend 协议类型删除从阶段 1 推迟到阶段 3：阶段 1 时 server 编排与 worker 流程仍在消费，先删会破坏构建；阶段 3 换编排时随消费代码一并删除。
2. cutoff 计算矩阵抽出为独立模块 `server/src/services/moves-sync-cutoff.ts`（`computeMovesSyncCutoff`/`monthsAgoTs`/`MOVES_SYNC_OVERLAP_MS`），inventory.ts re-export——纯函数可测，避免测试传递引入 ws-handler/DB 依赖。
3. ws-handler 路由未写单元测试（socket/DB mock 成本与收益不成比例），由构建、cutoff/DB 纯函数测试与人工验证覆盖。
4. `failJob` 增加 running 守卫：batch 落库失败后 worker 可能继续上报，防止重复 error 事件。
5. 客户端"快速模式"复选框位于 auto/upload 共用的控制区（单控件行服务两种模式），未在两个表单各放一份。

## 目标

1. 建立 server 端库存调动历史数据库（ATL/Stock 库位的 `stock.move.line` 记录），替代"每个低库存项逐个打开 Odoo 页面查 move history"的流程。
2. 每次库存清点前自动补齐差异：
   - 快速模式（默认）：从最新记录读到数据库水位线附近即停。
   - 全量检查（UI 取消勾选"快速模式"）：无视水位线，按 recentMonths 窗口重读 Odoo，仅补缺失行。用于修复同步中途意外终止留下的缺口、以及首次导入。
   - 首次运行在第一次清点任务内自动完成窗口内导入，无需人工干预。
3. 趋势分类（warning / reminder / info 分桶）逻辑与 SSE 事件形状保持不变，前端除新增复选框外零改动。
4. 顺带修复现流程的截断问题：旧 `extractMoves` 只读第一页（80 行），窗口内移动超过一页时会漏读；新方案完整翻页。

## 非目标

- 全量检查只补缺失行：不删除、不更新已有记录，因此不修复 Odoo 端历史 move 被编辑/取消造成的值级漂移（已确认接受）。修复深度也限于 recentMonths 窗口，更深的缺口超出分类消费范围，不做修复。
- 不改变清点端点路径、角色要求与响应形状；请求体仅新增可选 `fastMode` 字段（默认 true），向后兼容。
- 不改变库存 CSV 下载、清洗、低库存筛选逻辑（`inventory-download` 任务保留）。
- 不改变报价自动化流程；协议变更虽是全局版本号，但报价消息面不变。

## 已核验现状

- 现流程：`server/src/services/inventory.ts` 的 `startTrend` 对每个低库存项派发 `inventory-trend` 任务；`auto/src/odoo/inventory-trend.ts:196` 每项执行 跳转 action-809 → 搜索 → 定位 ATL/Stock 行 → 点 History → 读 move 表（仅当前页）。分类在 `classifyTrendItem`（inventory.ts:195），仅依赖 `{name, moves:[{date,qty,dir}]}`，与数据来源无关。
- 协议：server 与 auto 各自维护同版本协议（`server/src/services/ws-protocol.ts`、`auto/src/protocol.ts`），当前 `PROTOCOL_VERSION = '3'`，版本不匹配时 worker 被拒绝连接（ws-handler.ts:262）。
- 持久化：`server/src/db/sku.ts` 的 `initSkuDB` 打开 `DB_DIR/sku.sqlite`（WAL），`inventory_results` 表已在其中；`CREATE TABLE IF NOT EXISTS` 模式意味着新表无迁移负担。
- WS 任务派发：inventory 任务走负数 taskId 内存命名空间（ws-handler.ts:82-188），已有单槽 pending/running、attempt 幂等、断线拒绝逻辑。
- 前端：`client/src/pages/InventoryDashboardPage.tsx:259` 消费 SSE `trend-result` 事件（形状 `{bucket, item:{name,inbound,outbound}, processed, total}`），实时更新分类表；`recentMonths` 参数已存在于 job schema 与创建表单（默认 3）。
- Odoo 页面样本（`experiment/odoopage/`）：
  - `odoo-content.html`：`stock.move.line` 列表行，列均可按 `td[name="date|reference|product_id|lot_id|location_id|location_dest_id|quantity|product_uom_id|state"]` 定位，`data-tooltip` 携带原始值；Date 表头为 `th[data-name="date"].o_column_sortable`，点一次升序、两次降序；Date 字段 help 注明 quantity 增加、picked 状态更新、move 完成都会改写 date（即历史行可变）。
  - `odoo-control-panel-raw.html`：搜索框 `input.o_searchview_input`；翻页 `.o_pager_value` / `.o_pager_next` / `.o_pager_previous`；样本显示 `1-80 / 10000+`。
  - `odoo-control-panel-text-input.html`：输入文本后的 autocomplete `ul.o_searchview_autocomplete` 含 `li.o_menu_item`，按 `Search <b>Location</b> for:` 文本选中 Location 项。
- 已确认的外部事实：直达 URL 为 `https://dukouserp.com/odoo/action-809/197381/action-393`（维护者已用 init session 实测可直达）；该页面**默认自带 "Status: Done" facet**（动作内置过滤，须保留，不得清理）；"Search Location for: ATL/Stock" facet 同时匹配 From 与 To（维护者已实测）。
- 现有常量：目标库位 `ATL/Stock`（inventory-trend.ts:33 `WAREHOUSE`）；方向判定 dest===库位→in、location===库位→out（inventory-trend.ts:179-181），查询时沿用。
- 设计约束：降序翻页逐页落库时，中断后水位线 = 最新已插入行的日期，而缺失尾部（中断页之后各页）日期早于水位线；快速补齐从最新页读到水位线附近即停，永远够不到缺失段。此类缺口只能靠全量检查修复。

## 方案

### 阶段 1 —— 协议与数据层（server + auto 同步改）

1. 两侧协议（`auto/src/protocol.ts`、`server/src/services/ws-protocol.ts`）：
   - `TaskKind` 增加 `inventory-moves-sync`。
   - `task-assigned` 携带 `{ cutoffTs: number, mode: 'fast' | 'full' }`：截止时间由 server 统一计算为绝对时间戳，worker 两种模式共用同一条停止逻辑，`mode` 仅用于进度文案——worker 不感知模式语义差异，减小出错面。
   - 新出站消息 `inventory-moves-batch`：`{ taskId, attempt, rows: MoveRow[] }`，每页一批；`MoveRow = { dateText, dateTs, reference, product, lot, locationFrom, locationTo, qty, uom, state }`。
   - 删除 `inventory-trend` kind、`inventory-trend-result` 消息、`TrendItemResult`/`TrendMove` 类型。
   - `PROTOCOL_VERSION` `'3'` → `'4'`。
2. `server/src/db/sku.ts` 新增 `stock_moves` 表：
   - 列：`id`、`date_ts`（epoch ms，worker 按浏览器 profile 本地时区解析，与现 `parseOdooDate` 一致）、`date_text`（Odoo 原始显示文本）、`reference`、`product`、`lot`、`location_from`、`location_to`、`qty REAL`、`uom`、`state`。
   - `UNIQUE(date_ts, reference, product, qty, location_from, location_to)`，写入用 `INSERT OR IGNORE`；索引 `(product, date_ts)`、`(date_ts)`。任何路径都不产生 UPDATE/DELETE。
   - 函数：`insertStockMoves(rows) → {inserted, ignored}`、`getMovesWatermark() → number | null`（MAX(date_ts)）、`queryItemMoves(product, windowStartTs) → {inbound, outbound}`（聚合时 location_to='ATL/Stock' 计入 inbound、location_from='ATL/Stock' 计入 outbound；state 过滤语义见风险 5）。

### 阶段 2 —— worker 新流程

1. 新文件 `auto/src/odoo/inventory-moves.ts`：
   - 导航到 `${ODOO_BASE_URL}/action-809/197381/action-393`（直达可用性已由维护者验证，无需回退路径）。
   - 不清理任何 facet：每次运行都是全新 `page.goto`，facet 只会是动作默认的 "Status: Done"（数据语义的一部分，只同步已完成调动）→ 搜索框填 `ATL/Stock` → 等 autocomplete → 点 "Search Location for:" 菜单项 → 等 facet 出现且值为 ATL/Stock，最终视图 = Done + ATL/Stock。
   - 排序：点 `th[data-name="date"]` 至多两次，用 caret 方向（`fa-angle-down`）加首行/尾行日期比较双重校验为降序。
   - 翻页循环：`page.evaluate` 按选择器提取当前页全部行（含 `data-tooltip` 原始值与 state 徽章文本）→ 解析 date → 发 `inventory-moves-batch` → 若整页 `date_ts` 均早于 `cutoffTs` 则停止，否则点 `.o_pager_next` 并等 `.o_pager_value` 变化；末页以 next 按钮禁用为准。
   - 等待策略沿用现约定：不盲点，等待目标元素与数据行稳定（参考 `waitForRowsStable`）。
2. `auto/src/browser-inventory.ts`：新增 `runInventoryMovesSyncTask(cutoffTs, mode, callbacks, abortSignal)`，复用 `prepare()`；进度回调按页报告并携带 mode 文案。
3. `auto/src/index.ts`：`handleTaskAssigned` 增加 `inventory-moves-sync` 分支。
4. 删除 `auto/src/odoo/inventory-trend.ts` 与 `runInventoryTrendTask`。

### 阶段 3 —— server 编排替换与 UI

1. `server/src/services/ws-handler.ts`：
   - `InventoryTaskEntry.kind` 增加 `'inventory-moves-sync'`；派发消息携带 `{ cutoffTs, mode }`。
   - 新入站 `inventory-moves-batch` 路由：ack 后交回调；回调内 `insertStockMoves` 落库（插入失败 → 任务失败）。
   - 删除 `handleInventoryTrendResult` 与 trend 相关路由。
2. `server/src/services/inventory.ts`：
   - `startTrend` 替换为 `startMovesSync`：phase 改为 `'moves-sync'`。
   - cutoff 计算矩阵（均由 server 完成）：
     - `fastMode=true` 且水位线存在 → `cutoffTs = 水位线 − 48h`；
     - `fastMode=true` 但水位线为 null（首次导入）→ 回退全量：`cutoffTs = now − recentMonths 个月 − 48h`；
     - `fastMode=false`（全量检查）→ `cutoffTs = now − recentMonths 个月 − 48h`。
   - 停止位置安全性：快速模式的停止条件是"整页早于水位线 − 48h"，停点位于 Odoo 与数据库分界线的已入库一侧（最多深 48h）；越界重读部分与同秒时间戳碰撞的漏网行均由 `INSERT OR IGNORE` 静默去重。
   - 入队 `inventory-moves-sync`；progress 文案按 mode 区分："快速补齐（第 N 页…）" / "全量检查（第 N 页…）"，并追加"已入库 N 条"累计信息。
   - `onComplete`：对每个低库存项 `queryItemMoves(name, now − recentMonths)` 组装与原 `TrendResultDTO` 相同形状的结果，走原 `recordTrendResult` / `classifyAndComplete` 路径；SSE 仍逐项发 `trend-result`。
   - `createUploadJob` 同样经过 `startMovesSync`（upload 模式趋势数据来自本地库；worker 在线要求不变，但只依赖一次 sync 而非逐项翻页）。
   - 删除 trend 任务相关代码路径，保留分类逻辑与 `inventory_results` 落库。
3. `server/src/routes/inventory.ts`：`downloadJobSchema` / `uploadJobSchema` 增加 `fastMode: z.boolean().default(true)`，透传至 job。
4. `client/src/pages/InventoryDashboardPage.tsx`：auto 与 upload 两个创建表单各加复选框"快速模式"（默认勾选；未勾选 = 全量检查），随创建请求提交 `fastMode`。

### 阶段 4 —— 验证与文档

见下文"验证"与"文档影响"。

## 风险

1. **直达 URL 已验证，默认 Done facet 须保留**：维护者已用 init session 实测直达；页面动作默认自带 "Status: Done" facet，流程不清理任何 facet（见方案阶段 2）。若 Odoo 端将来改动动作默认过滤导致非 Done 行混入，同一 move 后续变 Done 时会被 UNIQUE 静默 IGNORE（state 列留存旧值）——validation 阶段抽查同步行 state 均为 Done 即可确认语义未漂移。
2. **历史 move 可变导致漂移**：Odoo 端编辑/取消历史行后本地库不会自动纠正（已确认接受）。全量检查只补缺失行、不更新已有行，值级漂移不在修复范围。48h 重叠窗口只覆盖"新增/补写"。漂移对分类的影响集中在 recentMonths 窗口内，窗口本身随每次清点重新补齐，实际暴露有限。
3. **产品名精确匹配**：分类查询按 `product = 清洗后的物品名` 精确相等聚合；旧流程靠搜索框容错。若 Odoo 显示名与 CSV 清洗名存在差异，对应项会被聚合为 0 移动。验证阶段需抽查比对；必要时在查询侧加规范化映射（不动 CSV 清洗逻辑）。
4. **首导与全量耗时**：页数取决于调拨密度（80 行/页），范围已被 recentMonths 窗口约束，实施首导时实测并记录页数/耗时基线。中断缺口修复深度限于 recentMonths 窗口；更深的缺口超出分类消费范围，明确不修复。翻页需防乱序（以 `.o_pager_value` 变化为准）。
5. **state 过滤语义**：数据源视图由直达 URL 的默认 Done facet 决定，只含已完成调动；`state` 列预期恒为 "Done"，聚合阶段不做额外 state 过滤。旧流程 History 视图是否同样 Done-only 未验证——人工比对时若发现差异（旧视图含未 Done 预留行），新库更严格（少计预留行），属语义改善，需在 Wiki 记录。
6. **时区**：`date_ts` 由 worker 所在机器时区解析（与现状一致）。窗口比较均在同一时钟域内完成（截止时间由 server 计算绝对时间戳下发）；worker 机器时区不应中途变更。
7. **协议版本升级窗口**：版本 4 上线后旧 worker 会被拒绝连接，报价自动化同时短暂不可用。worker 与 server 需同窗口发布（见"发布/回滚"）。
8. **数据安全**：调动记录含单号（reference）、产品、数量等敏感业务数据，仅落 server 端 `DB_DIR`（Railway Volume）；不得写入日志、trace、Issue 或测试夹具原文。同步 `.agent/context/data-safety.md`。

## 验证

- 自动化（Vitest，`npm --prefix server test`）：
  - `stock_moves` 层：插入/去重（UNIQUE 冲突 IGNORE 计数，`inserted + ignored = 总行数` 对账）、水位线、窗口聚合（in/out 方向、时间窗过滤）。
  - ws-handler：`inventory-moves-sync` 派发消息形状（含 `cutoffTs`/`mode`）、batch 消息路由与 ack、断线清理。
  - inventory 服务：cutoff 计算矩阵（fast+水位线 / fast+首次导入 / 全量）、sync 完成后分类结果与 SSE 事件形状回归（可用内存 SQLite）。
- 静态构建：`npm --prefix server run build`、`npm --prefix auto run build`、`npm --prefix client run build`（auto 与 client 无测试脚本，以 build 为准）。
- 授权环境人工验证：
  1. 首次导入：挂在一次真实清点任务内完成，抽查若干产品的 in/out 汇总与 Odoo 页面人工比对；记录页数/耗时基线；抽查同步行 `state` 均为 Done、筛选后视图为 Done + ATL/Stock。
  2. 快速补齐：第二次清点应只读少量页即停，停点位于分界线已入库一侧；核对边界日期行不重不漏。
  3. 全量检查：在窗口截止处（`now − recentMonths − 48h`）停止；构造/模拟一次中断后运行全量检查，确认缺口被补齐且 `inserted + ignored` 对账成立。
- 数据命令与浏览器自动化有副作用，不为"验证"而运行；人工验证前取得明确授权。

## 发布 / 回滚

- 发布顺序：同一窗口内先发布 server（Railway 自动部署）再重启本地 worker（`git pull && npm --prefix auto run build && npm start`）。server 先上线、worker 未更新期间，worker 因协议版本不匹配被拒，报价与库存自动化不可用，属预期窗口。
- 回滚：两侧 git revert 到版本 3 并重启；`stock_moves` 表留存无害（无消费方）。`inventory_results` 语义不变，历史记录不受影响。
- 首次导入发生在升级后第一次清点任务中（范围为 recentMonths 窗口），不需要单独的数据迁移步骤；`CREATE TABLE IF NOT EXISTS` 保证旧库平滑升级。

## 文档影响（已同步，2026-09-15）

- `wiki/auto/README.md`（已实现能力/运行边界：moves-sync 任务、移除逐项趋势）。
- `wiki/server/realtime-and-automation.md`（库存自动化一节：moves-sync 流程、快速/全量两档、cutoff 矩阵、协议版本 4）。
- `wiki/client/quotation-and-inventory.md`（快速模式复选框、moves-sync 阶段、trend-result 时序、注意点更新）。
- `.agent/context/external-systems.md`（Odoo 交互：直达 URL、默认 Done facet、全局 move 列表抓取）。
- `.agent/context/data-safety.md`（`stock_moves` 数据分类与只增不改的防护约束）。
- `.agent/context/domain.md`（库存分类方向判定/分桶/窗口语义）。
- 本计划状态与偏差已更新。

## 关联 Issue

实施时按 AGENTS.md 规范创建 GitHub Issue 跟踪验收结果；本计划不作为待办队列。
