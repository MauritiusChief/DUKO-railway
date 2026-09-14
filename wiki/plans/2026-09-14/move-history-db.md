# 库存调动历史本地库（move-history-db）计划

## 状态

已确认方案（2026-09-14 创建），未开始实施。关键决策已由维护者确认：Location facet 双向覆盖已实测、库存放 server 端 SQLite、旧 `inventory-trend` 流程直接替换、不做手动全量重同步、首次全量导入挂在第一次清点任务内自动完成。

## 目标

1. 建立 server 端库存调动历史数据库（ATL/Stock 库位的 `stock.move.line` 记录），替代"每个低库存项逐个打开 Odoo 页面查 move history"的流程。
2. 每次库存清点前自动补齐从数据库最新记录到当前时刻的差异；首次运行在第一次清点任务内完成全量导入（约 125+ 页，无需人工干预）。
3. 趋势分类（warning / reminder / info 分桶）逻辑与 SSE 事件形状保持不变，前端零改动。
4. 顺带修复现流程的截断问题：旧 `extractMoves` 只读第一页（80 行），窗口内移动超过一页时会漏读；新方案完整翻页。

## 非目标

- 不做管理员手动全量重同步入口；历史 move 在 Odoo 端被编辑/取消导致的漂移按已确认决策接受。
- 不改变清点入口 API（`POST /api/inventory/jobs`、`/upload`）的请求/响应形状与角色要求。
- 不改变库存 CSV 下载、清洗、低库存筛选逻辑（`inventory-download` 任务保留）。
- 不改变报价自动化流程；协议变更虽是全局版本号，但报价消息面不变。

## 已核验现状

- 现流程：`server/src/services/inventory.ts` 的 `startTrend` 对每个低库存项派发 `inventory-trend` 任务；`auto/src/odoo/inventory-trend.ts:196` 每项执行 跳转 action-809 → 搜索 → 定位 ATL/Stock 行 → 点 History → 读 move 表（仅当前页）。分类在 `classifyTrendItem`（inventory.ts:195），仅依赖 `{name, moves:[{date,qty,dir}]}`，与数据来源无关。
- 协议：server 与 auto 各自维护同版本协议（`server/src/services/ws-protocol.ts`、`auto/src/protocol.ts`），当前 `PROTOCOL_VERSION = '3'`，版本不匹配时 worker 被拒绝连接（ws-handler.ts:262）。
- 持久化：`server/src/db/sku.ts` 的 `initSkuDB` 打开 `DB_DIR/sku.sqlite`（WAL），`inventory_results` 表已在其中；`CREATE TABLE IF NOT EXISTS` 模式意味着新表无迁移负担。
- WS 任务派发：inventory 任务走负数 taskId 内存命名空间（ws-handler.ts:82-188），已有单槽 pending/running、attempt 幂等、断线拒绝逻辑。
- 前端：`client/src/pages/InventoryDashboardPage.tsx:259` 消费 SSE `trend-result` 事件（形状 `{bucket, item:{name,inbound,outbound}, processed, total}`），实时更新分类表。
- Odoo 页面样本（`experiment/odoopage/`）：
  - `odoo-content.html`：`stock.move.line` 列表行，列均可按 `td[name="date|reference|product_id|lot_id|location_id|location_dest_id|quantity|product_uom_id|state"]` 定位，`data-tooltip` 携带原始值；Date 表头为 `th[data-name="date"].o_column_sortable`，点一次升序、两次降序；Date 字段 help 注明 quantity 增加、picked 状态更新、move 完成都会改写 date（即历史行可变）。
  - `odoo-control-panel-raw.html`：搜索框 `input.o_searchview_input`；翻页 `.o_pager_value` / `.o_pager_next` / `.o_pager_previous`；样本显示 `1-80 / 10000+`。
  - `odoo-control-panel-text-input.html`：输入文本后的 autocomplete `ul.o_searchview_autocomplete` 含 `li.o_menu_item`，按 `Search <b>Location</b> for:` 文本选中 Location 项。
- 已确认的外部事实：直达 URL 为 `https://dukouserp.com/odoo/action-809/197381/action-393`；"Search Location for: ATL/Stock" facet 同时匹配 From（location_id）与 To（location_dest_id）（维护者已实测）。
- 现有常量：目标库位 `ATL/Stock`（inventory-trend.ts:33 `WAREHOUSE`）；方向判定 dest===库位→in、location===库位→out（inventory-trend.ts:179-181），查询时沿用。

## 方案

### 阶段 1 —— 协议与数据层（server + auto 同步改）

1. 两侧协议（`auto/src/protocol.ts`、`server/src/services/ws-protocol.ts`）：
   - `TaskKind` 增加 `inventory-moves-sync`；`task-assigned` 携带可选 `since`（ISO 或 epoch ms，缺省表示全量首导）。
   - 新出站消息 `inventory-moves-batch`：`{ taskId, attempt, rows: MoveRow[] }`，每页一批；`MoveRow = { dateText, dateTs, reference, product, lot, locationFrom, locationTo, qty, uom, state }`。
   - 删除 `inventory-trend` kind、`inventory-trend-result` 消息、`TrendItemResult`/`TrendMove` 类型。
   - `PROTOCOL_VERSION` `'3'` → `'4'`。
2. `server/src/db/sku.ts` 新增 `stock_moves` 表：
   - 列：`id`、`date_ts`（epoch ms，worker 按浏览器 profile 本地时区解析，与现 `parseOdooDate` 一致）、`date_text`（Odoo 原始显示文本）、`reference`、`product`、`location_from`、`location_to`、`qty REAL`。
   - `UNIQUE(date_ts, reference, product, qty, location_from, location_to)`，写入用 `INSERT OR IGNORE`；索引 `(product, date_ts)`、`(date_ts)`。
   - 函数：`insertStockMoves(rows) → {inserted, ignored}`、`getMovesWatermark() → number | null`（MAX(date_ts)）、`queryItemMoves(product, windowStartTs) → {inbound, outbound}`（仅统计 `state='Done'`？——见风险 5，默认与旧行为一致不过滤，聚合时 location_to='ATL/Stock' 计入 inbound、location_from='ATL/Stock' 计入 outbound）。

### 阶段 2 —— worker 新流程

1. 新文件 `auto/src/odoo/inventory-moves.ts`：
   - 导航到 `${ODOO_BASE_URL}/odoo/action-809/197381/action-393`；实施第一步先人工验证直达 URL 在 persistent profile 下能直接渲染 move line 列表（URL 含 record id `197381`，可能依赖面包屑上下文）。若失败，回退点击路径：action-809 → ATL/Stock 行 History → 跳转后读取最终 URL 固化。
   - 清残留 facet（循环点 `.o_facet_remove` 至无）→ 搜索框填 `ATL/Stock` → 等 autocomplete → 点 "Search Location for:" 菜单项 → 等 facet 出现且值为 ATL/Stock。
   - 排序：点 `th[data-name="date"]` 至多两次，用 caret 方向（`fa-angle-down`）加首行/尾行日期比较双重校验为降序。
   - 翻页循环：`page.evaluate` 按选择器提取当前页全部行（含 `data-tooltip` 原始值与 state 徽章文本）→ 解析 date → 发 `inventory-moves-batch` → 若整页 `date_ts` 均早于 `cutoff = since - 48h`（重叠窗口）则停止，否则点 `.o_pager_next` 并等 `.o_pager_value` 变化；末页以 next 按钮禁用为准。
   - 等待策略沿用现约定：不盲点，等待目标元素与数据行稳定（参考 `waitForRowsStable`）。
2. `auto/src/browser-inventory.ts`：新增 `runInventoryMovesSyncTask(since, callbacks, abortSignal)`，复用 `prepare()`；进度回调按页报告（页码、行数、水位）。
3. `auto/src/index.ts`：`handleTaskAssigned` 增加 `inventory-moves-sync` 分支。
4. 删除 `auto/src/odoo/inventory-trend.ts` 与 `runInventoryTrendTask`。

### 阶段 3 —— server 编排替换

1. `server/src/services/ws-handler.ts`：
   - `InventoryTaskEntry.kind` 增加 `'inventory-moves-sync'`；派发消息携带 `since`。
   - 新入站 `inventory-moves-batch` 路由：ack 后交回调；回调内 `insertStockMoves` 落库（插入失败 → 任务失败）。
   - 删除 `handleInventoryTrendResult` 与 trend 相关路由。
2. `server/src/services/inventory.ts`：
   - `startTrend` 替换为 `startMovesSync`：phase 改为 `'moves-sync'`；`since = getMovesWatermark()`（null → 全量）；入队 sync 任务；progress 转发（追加"已入库 N 条"信息）。
   - `onComplete`：对每个低库存项 `queryItemMoves(name, now - recentMonths)` 组装与原 `TrendResultDTO` 相同形状的结果，走原 `recordTrendResult` / `classifyAndComplete` 路径；SSE 仍逐项发 `trend-result`，前端不改。
   - `createUploadJob` 同样经过 `startMovesSync`（upload 模式趋势数据从此来自本地库；worker 在线要求不变，但只依赖一次 sync 而非逐项翻页）。
   - 删除 trend 任务相关代码路径，保留分类逻辑与 `inventory_results` 落库。
3. server 首次全量（水位线为 null）不做特殊分支——`since` 缺省时 worker 读完全部页即可，与增量同一代码路径；中断后水位线已推进，重跑自动续传。

### 阶段 4 —— 验证与文档

见下文"验证"与"文档影响"。

## 风险

1. **直达 URL 有效性未验证**：`/odoo/action-809/197381/action-393` 含 record id，直接 goto 可能依赖会话内的面包屑上下文。实施第一步在授权环境用 persistent profile 验证；失败则回退点击路径并固化实际 URL。
2. **历史 move 可变导致漂移**：Odoo 端编辑/取消历史行后本地库不会自动纠正（已确认接受）。重叠窗口 48h + UNIQUE 去重只覆盖"新增/补写"，不覆盖"修改/删除"。漂移对分类的影响集中在 recentMonths 窗口内，窗口本身随每次清点重新补齐，实际暴露有限。
3. **产品名精确匹配**：分类查询按 `product = 清洗后的物品名` 精确相等聚合；旧流程靠搜索框容错。若 Odoo 显示名与 CSV 清洗名存在差异，对应项会被聚合为 0 移动。验证阶段需抽查比对；必要时在查询侧加规范化映射（不动 CSV 清洗逻辑）。
4. **首次全量耗时**：10000+ 行 ÷ 80 行/页 ≈ 125+ 页，估算数分钟量级。逐页落库 + 水位线使中断天然可恢复；翻页需防乱序（以 `.o_pager_value` 变化为准）。
5. **state 过滤语义**：旧 `extractMoves` 不过滤 state（History 视图可能含未 Done 的预留行）。新方案存 `state` 列，聚合阶段默认沿用旧行为（不过滤）以保持结果可比；若验证发现明显不合理再改为仅 `Done`，并在 Wiki 记录语义变化。
6. **时区**：`date_ts` 由 worker 所在机器时区解析（与现状一致）。窗口比较均在同一时钟域内完成；部署说明需注明 server 与 worker 时钟/时区不需一致，但 worker 机器时区不应中途变更。
7. **协议版本升级窗口**：版本 4 上线后旧 worker 会被拒绝连接，报价自动化同时短暂不可用。worker 与 server 需同窗口发布（见"发布/回滚"）。
8. **数据安全**：调动记录含单号（reference）、产品、数量等敏感业务数据，仅落 server 端 `DB_DIR`（Railway Volume）；不得写入日志、trace、Issue 或测试夹具原文。同步 `.agent/context/data-safety.md`。

## 验证

- 自动化（Vitest，`npm --prefix server test`）：
  - `stock_moves` 层：插入/去重（UNIQUE 冲突 IGNORE 计数）、水位线、窗口聚合（in/out 方向、时间窗过滤）。
  - ws-handler：`inventory-moves-sync` 派发消息形状、batch 消息路由与 ack、断线清理。
  - inventory 服务：sync 完成后分类结果与 SSE 事件形状回归（可用内存 SQLite）。
- 静态构建：`npm --prefix server run build`、`npm --prefix auto run build`、`npm --prefix client run build`（auto 与 client 无测试脚本，以 build 为准）。
- 授权环境人工验证：
  1. 直达 URL 可用性（阶段 2 第一步）。
  2. 首次全量导入：挂在一次真实清点任务内完成，抽查若干产品的 in/out 汇总与 Odoo 页面人工比对。
  3. 增量补齐：第二次清点应只读少量页即停；核对边界日期行不重不漏。
- 数据命令与浏览器自动化有副作用，不为"验证"而运行；人工验证前取得明确授权。

## 发布 / 回滚

- 发布顺序：同一窗口内先发布 server（Railway 自动部署）再重启本地 worker（`git pull && npm --prefix auto run build && npm start`）。server 先上线、worker 未更新期间，worker 因协议版本不匹配被拒，报价与库存自动化不可用，属预期窗口。
- 回滚：两侧 git revert 到版本 3 并重启；`stock_moves` 表留存无害（无消费方）。`inventory_results` 语义不变，历史记录不受影响。
- 首次全量导入发生在升级后第一次清点任务中，不需要单独的数据迁移步骤；`CREATE TABLE IF NOT EXISTS` 保证旧库平滑升级。

## 文档影响（实施时同步）

- `wiki/auto/README.md`（已实现能力/运行边界：新任务、移除逐项趋势）。
- `wiki/server/realtime-and-automation.md`（库存自动化一节：moves-sync 流程、协议版本 4）。
- `wiki/client/quotation-and-inventory.md`（前端可见行为差异：进度文案、trend-result 时序）。
- `.agent/context/external-systems.md`（Odoo 交互变化：直达 URL、全局 move 列表抓取）。
- `.agent/context/data-safety.md`（stock_moves 落库的数据分类与防护）。
- `.agent/context/domain.md`（如涉及 ATL/Stock 趋势语义的稳定结论）。
- 实施完成后更新本计划状态与偏差，稳定结论回写上述页面。

## 关联 Issue

实施时按 AGENTS.md 规范创建 GitHub Issue 跟踪验收结果；本计划不作为待办队列。
