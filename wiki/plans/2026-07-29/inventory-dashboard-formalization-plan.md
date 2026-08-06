# 库存看板正式化实施计划

## 1. 目标

将当前临时库存看板改造为正式功能，覆盖以下范围：

1. 增加 `manager` 用户角色。
2. 库存看板入口只存在于主页，且仅 `manager` 和 `admin` 可见、可访问。
3. `admin` 可在登录页把非管理员用户设置为 `user` 或 `manager`，但不能授予或修改 `admin` 角色。
4. 库存看板保存并展示全局最近 20 次成功识别结果。
5. 自动下载成功后，使用同一份 CSV 在后台触发完整 SKU refresh。
6. 手工上传 CSV 继续作为备用库存识别入口，但不触发 SKU refresh。
7. SKU 数据库记录最后一次成功 refresh 时间，并将其提供给 Chat Agent。

库存看板和 manager 相关界面继续使用中文，不扩展 i18n。

## 2. 已确认的业务边界

### 2.1 历史记录

- 最近 20 次库存识别结果为全局共享记录。
- `manager` 和 `admin` 看到相同的最近 20 条结果。
- 记录执行用户，便于追踪来源，但不按用户隔离结果。
- 只保存成功完成且具有最终分类结果的识别。
- 失败和取消的任务不占用 20 条额度。
- 第 21 条成功结果写入后，直接删除最旧记录。

### 2.2 SKU refresh

- 自动下载查询取得 CSV 后，同时触发两条相互独立的链路：
  - 库存识别链路。
  - 完整 SKU refresh 链路。
- 完整 refresh 等同于当前 `Product-raw.csv` 加 `refresh-data-cli` 工作流，包括派生数据、SQLite、LanceDB 和运行时缓存。
- refresh 不阻塞、不决定库存识别是否成功。
- refresh 失败不影响库存识别结果入历史。
- 库存看板 UI 不显示 refresh 状态。
- 手工上传 CSV 仅触发库存识别，不触发 refresh。

### 2.3 时间语义

- 库存识别时间是最终分类完成并成功持久化的时间。
- 最近 20 条记录在数据库中统一保存 UTC 时间。
- 下拉菜单通过浏览器 `toLocaleString()` 显示用户本地时间。
- SKU refresh 时间只表示“最后一次完整 refresh 成功发布的时间”。
- 下载时间、源文件 mtime、refresh 开始时间和失败时间不能代替最后成功 refresh 时间。

## 3. 当前实现概况

### 3.1 角色与权限

- 服务端角色类型位于 `server/src/db/users.ts`，当前为 `admin | user`。
- 客户端角色类型位于 `client/src/stores/authStore.ts`，当前为 `admin | user`。
- `users` 表的 SQLite `CHECK` 约束只接受 `admin` 和 `user`。
- 当前没有修改用户角色的 API 或 UI。
- `/inventory` 由普通 `AuthGuard` 保护，所有登录用户均可访问。
- `/api/inventory/*` 只要求登录，没有 manager/admin 权限检查。
- 库存按钮当前存在于：
  - `client/src/pages/TableParsePage.tsx`
  - `client/src/pages/QuotationTasksPage.tsx`

### 3.2 库存结果

- 库存任务由 `server/src/services/inventory.ts` 在进程内管理。
- 最终分类结果在 `classifyAndComplete()` 中产生。
- 服务端结果不会持久化。
- 客户端只将一份结果写入固定的 `duko_inventory_last` localStorage key。
- localStorage 不区分用户，也可能保存未完成的增量结果。

### 3.3 SKU refresh

- `server/src/refresh-data-cli.ts` 是一次性 CLI，不能直接作为服务调用。
- refresh 会处理 `Product-raw.csv`，生成派生 CSV，更新 `sku.sqlite` 和 LanceDB。
- SQLite、LanceDB 及多张引用表当前没有统一发布事务或 generation 标识。
- BM25、LanceDB table handle、颜色表等运行时缓存需要重新加载。
- SKU 数据库目前没有 refresh metadata。

### 3.4 Chat Agent

- `server/src/agents/chat-agent.ts` 的 `**⚠️ 重要提示**` 仅说明库存来自可能过时的静态快照。
- 模型目前不知道最后一次成功 refresh 时间。

## 4. 实施阶段

## 阶段一：角色模型和数据库迁移

### 4.1 扩展角色类型

将用户角色统一扩展为：

```ts
type UserRole = 'admin' | 'manager' | 'user';
```

涉及至少：

- `server/src/db/users.ts`
- `server/src/middleware/auth.ts`
- `client/src/stores/authStore.ts`
- 登录、刷新、`/api/me` 等响应类型

### 4.2 迁移现有 users 表

不能只修改 `CREATE TABLE IF NOT EXISTS`，因为生产 Volume 中的旧表仍保留原 `CHECK` 约束。

增加版本化迁移机制，并执行一次 users 表重建：

1. 创建允许 `admin | manager | user` 的新表。
2. 原样复制 ID、用户名、密码 hash、角色和时间字段。
3. 替换旧表。
4. 恢复约束和索引。
5. 执行外键一致性检查。
6. 保证迁移重复启动时幂等。

迁移必须保留所有现有用户及引用其 ID 的业务数据。

### 4.3 角色修改 API

增加管理员专用接口，例如：

```http
PATCH /api/auth/users/:id/role
```

请求体：

```json
{
  "role": "manager",
  "adminPassword": "..."
}
```

规则：

- 只有当前数据库角色为 `admin` 的用户可以调用。
- 请求角色只接受 `user | manager`。
- 不能将任何用户设置为 `admin`。
- 不能修改现有 `admin` 用户的角色。
- 目标用户必须存在。
- 保留当前敏感管理操作的管理员密码复核方式。
- 新建用户仍默认是 `user`。

### 4.4 角色变更即时生效

当前 access token 和 refresh token 都携带角色，直接修改数据库会留下旧权限。

调整为：

- `authenticateToken` 验证 JWT 后读取数据库中的当前用户和角色。
- 用户不存在时拒绝请求。
- 权限判断使用数据库角色，而不是 JWT 中的旧角色。
- refresh token 换发时从数据库读取最新用户名和角色后再签发 access token。
- 角色修改后撤销目标用户已有 refresh token。

这样 manager 被降级后不能继续使用旧 token 访问库存 API。

## 阶段二：库存入口和访问控制

### 4.5 服务端角色守卫

增加可复用角色守卫，例如：

```ts
requireAnyRole('admin', 'manager')
```

将其应用到全部库存 API：

- 创建自动下载任务。
- 创建手工上传任务。
- 获取 job 快照。
- 订阅 job SSE。
- 取消 job。
- 查询库存历史。

普通 `user` 必须得到 403，而不是仅依赖前端隐藏按钮。

### 4.6 修复 job 所有权检查

当前取消接口检查 `userId`，但快照和 SSE 只检查 `jobId`。

调整为：

- manager/admin 默认只能读取和订阅自己创建的运行中 job。
- 快照、SSE、取消三个入口使用相同的所有权判断。
- 全局历史结果仍对所有 manager/admin 共享。

### 4.7 前端路由守卫

- 将 `/inventory` 从普通 `AuthGuard` 改为 manager/admin 角色守卫。
- 未登录时保留 redirect 参数并跳转登录页。
- 普通用户直接访问 `/inventory` 时跳回主页或显示无权限。
- 页面渲染前通过 `/api/me` 完成真实角色验证。

同时统一普通受保护页面的认证初始化，避免 manager 刷新主页后 `user` 尚未恢复，导致库存按钮错误消失。

### 4.8 入口位置

- `TableParsePage.tsx`：仅 `manager` 和 `admin` 显示“库存看板”。
- `QuotationTasksPage.tsx`：删除“库存看板”按钮。
- 不在其他页面增加库存入口。

### 4.9 登录页角色管理

管理员用户列表增加中文角色下拉框：

- 普通用户
- 经理

规则：

- admin 行不显示可编辑角色控件。
- 非 admin 行可在 `user` 和 `manager` 之间切换。
- 修改时沿用管理员密码确认和 loading/error 状态。
- 成功后立即更新列表中的角色显示。
- 不为 manager 文案扩展 i18n。

## 阶段三：库存结果持久化

### 4.10 inventory_results 表

在 `sku.sqlite` 增加库存历史表。建议结构：

```sql
CREATE TABLE inventory_results (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              TEXT NOT NULL UNIQUE,
  triggered_by_id     INTEGER NOT NULL,
  triggered_by_name   TEXT NOT NULL,
  source              TEXT NOT NULL CHECK(source IN ('auto', 'upload')),
  threshold           REAL NOT NULL,
  trend_threshold     REAL NOT NULL,
  recent_months       INTEGER NOT NULL,
  total_cleaned       INTEGER NOT NULL,
  low_stock_count     INTEGER NOT NULL,
  classification_json TEXT NOT NULL,
  completed_at        TEXT NOT NULL
);

CREATE INDEX idx_inventory_results_completed
  ON inventory_results(completed_at DESC, id DESC);
```

说明：

- 用户数据位于 `users.sqlite`，因此 `triggered_by_id` 不建立跨数据库外键。
- 同时保存用户名快照，避免用户改名或删除后无法识别执行人。
- `classification_json` 保存最终完整分类结果。
- 若未来需要按 SKU 做跨批次统计，再考虑拆分 item 子表；当前最多 20 份结果，JSON 更简单。

### 4.11 写入和裁剪边界

在 `server/src/services/inventory.ts` 的 `classifyAndComplete()` 中：

1. 汇总最终 `Classification`。
2. 在事务中插入 `inventory_results`。
3. 按 `completed_at DESC, id DESC` 保留最新 20 条。
4. 删除其余记录。
5. 持久化成功后标记 job completed 并发送 SSE `complete`。

识别历史写入失败应使该库存 job 失败，因为“成功完成”需要包含正式结果落库；这与 SKU refresh 的成功或失败无关。

### 4.12 历史查询 API

增加 manager/admin-only API：

```http
GET /api/inventory/results
GET /api/inventory/results/:id
```

列表接口返回最多 20 条摘要：

- id
- source
- completedAt
- triggeredByName
- 查询参数
- totalCleaned
- lowStockCount
- warning/reminder/info/noAttention 数量

详情接口返回完整 `classification`。

如果实际结果体量确认很小，可以后续合并为一个接口；默认使用摘要加详情，避免页面每次加载 20 份完整 JSON。

## 阶段四：库存历史 UI

### 4.13 下拉菜单

在“清空表格”旁增加历史下拉菜单：

- 显示最近 20 次识别的本地时间。
- 使用稳定的结果 ID 作为选项值。
- 时间通过 `new Date(completedAt).toLocaleString()` 格式化。
- 可在辅助文本或 title 中显示来源和执行人，但主显示内容保持时间戳。

### 4.14 页面行为

- 页面进入时请求历史列表。
- 有历史时默认选择并加载最新一条。
- 选择其他时间后加载对应详情并展示其参数、统计和分类表格。
- 新库存任务完成后刷新历史列表，并选中新写入结果。
- 任务执行期间禁用历史选择，避免增量事件覆盖用户选中的旧结果。
- “清空表格”只清当前视图，不删除数据库记录。
- 不增加“清空历史”行为。

### 4.15 localStorage

服务端历史成为唯一权威来源。

- 停止将增量 classification 作为完整结果写入 `duko_inventory_last`。
- 可以只缓存当前选中的历史 ID或当前运行 job ID，但不得缓存跨用户可见的完整库存数据。
- 避免共享浏览器中不同账号看到前一个账号留下的 localStorage 结果。

## 阶段五：自动完整 SKU refresh

### 4.16 提取可复用 refresh service

把 `server/src/refresh-data-cli.ts` 的核心逻辑提取为服务函数，例如：

```ts
refreshSkuData(options): Promise<RefreshResult>
```

该函数负责：

1. 接收或写入本次 `Product-raw.csv`。
2. 校验 CSV 非空及必要字段存在。
3. 执行 clean、color、parts、items、exposed 派生流程。
4. 构建 embedding 和 LanceDB 数据。
5. 准备 SQLite 全部 SKU 数据。
6. 发布新 generation。
7. 重载运行时缓存。
8. 更新最后成功 refresh metadata。

现有 CLI 改为调用同一个 service，并保留退出码和日志输出。

服务函数不得调用 `process.exit()`。

### 4.17 自动下载接入

在 `createDownloadJob()` 的下载完成回调中取得 CSV 后：

```text
同一份 CSV
  ├─ 立即进入 clean/filter/trend/classification 库存识别
  └─ 提交到后台 SKU refresh 队列
```

约束：

- 两条链路互不等待。
- refresh 失败只写服务端结构化日志。
- refresh 失败不调用 `failJob()`。
- refresh 状态不进入库存 SSE，也不进入库存历史。
- `createUploadJob()` 不提交 refresh。

### 4.18 refresh 串行队列

完整 refresh 会写相同的数据文件、SQLite 和 LanceDB，必须串行执行。

- 每次自动下载创建一个独立 refresh 请求。
- refresh 使用 FIFO 单消费者队列。
- 每次请求保存独立的 CSV 内容或临时源文件，不能共享会被覆盖的 `Product-raw.csv`。
- 一个 refresh 失败后继续处理下一个请求。
- 服务关闭时记录未完成任务，不允许未处理 rejection 导致进程退出。

当前库存 worker 也只有一个全局 pending 槽，正式化时建议同步改为 FIFO，避免多个 manager/admin 的库存任务互相取代。

### 4.19 安全发布

不能直接在运行中对正式数据执行当前的逐表替换和 LanceDB drop/create，否则查询可能读到混合版本。

建议采用 generation 发布：

1. 在独立临时目录生成派生 CSV。
2. 在非活动 LanceDB table/generation 中完成向量构建。
3. 在发布前完成数据量和必要表校验。
4. 使用一个 SQLite 事务替换正式 SKU 数据表并切换 active generation metadata。
5. 切换 LanceDB 活动 table handle。
6. 重建 BM25。
7. 清除并重新加载颜色、类型等内存缓存。
8. 全部成功后记录最后成功 refresh 时间。
9. 最后清理旧 generation 和临时文件。

`inventory_results` 和 refresh metadata 位于同一个稳定的 `sku.sqlite`，发布时只能更新 SKU 数据表，不能用新文件整体覆盖 `sku.sqlite`，否则会丢失库存历史。

发布切换期间应通过服务级读写锁或等价机制阻止新 SKU 查询进入，避免 SQLite 已切换而 LanceDB 仍使用旧 generation。

## 阶段六：refresh metadata 与 Chat Agent

### 4.20 sku_refresh_metadata 表

在 `sku.sqlite` 增加单例 metadata 表：

```sql
CREATE TABLE sku_refresh_metadata (
  id                         INTEGER PRIMARY KEY CHECK(id = 1),
  active_generation          TEXT,
  last_successful_refresh_at TEXT,
  source                     TEXT
);
```

最低要求：

- `last_successful_refresh_at` 使用 UTC ISO-8601。
- 只有完整 refresh 发布和缓存重载均成功后才能更新。
- refresh 失败保留上一次成功值。
- 老数据库首次升级后允许时间为空。

可选的运行审计信息应写到日志或独立 refresh run 表，不需要暴露到库存 UI。

### 4.21 Chat Agent 提示词

在每次构造 Chat Agent system prompt 时读取 metadata。

有成功时间时：

```md
**⚠️ 重要提示**：当前库存数据来自产品数据库的静态快照，上次成功刷新时间为 2026-07-27 12:34:56 UTC，可能与实时 ERP 存在差异。回答库存问题时必须如实说明该时间和局限，并建议以实际 ERP 系统数据为准。
```

没有成功时间时：

```md
**⚠️ 重要提示**：当前库存数据来自产品数据库的静态快照，上次成功刷新时间未知，可能已过时。回答库存问题时必须如实说明该局限，并建议以实际 ERP 系统数据为准。
```

同时在 `lookupProductInventory` 工具的成功、未找到和映射失败结果中附带统一 metadata，避免模型只依赖 system prompt。

不要把文件 mtime 或 CSV 下载时间描述为库存快照时间。

## 5. 测试计划

### 5.1 用户与角色

- 新数据库支持 `admin | manager | user`。
- 旧数据库迁移后用户 ID、密码 hash 和关联数据不变。
- 迁移重复执行幂等。
- admin 可执行 `user -> manager` 和 `manager -> user`。
- manager/user 调角色接口返回 403。
- API 拒绝 `role=admin`。
- API 拒绝修改现有 admin。
- 角色降级后旧 access token 立即失去库存权限。
- refresh token 不会重新签出旧 manager 权限。

### 5.2 库存权限

对每个库存 API 验证：

- 未登录：401。
- user：403。
- manager：admin 允许。
- manager A 不能读取、订阅或取消 manager B 的运行中 job。
- manager/admin 都能读取全局库存历史。

前端验证：

- user 主页无库存按钮。
- manager/admin 主页有库存按钮。
- 报价任务页不存在库存按钮。
- user 直接访问 `/inventory` 被拒绝。
- manager 刷新主页后按钮不会因认证状态恢复延迟而消失。

### 5.3 库存历史

- 自动和上传模式成功完成后都写入历史。
- 失败和取消任务不写入历史。
- 第 21 条写入后只保留最新 20 条。
- 相同完成时间通过 ID稳定排序。
- 新结果保存失败时 job 不被错误标记为 completed。
- 页面默认加载最新结果。
- 下拉选择可恢复正确的参数和分类。
- 时间在浏览器本地时区正确显示。
- 清空表格不删除历史。

### 5.4 自动 refresh

- 自动下载成功后库存识别和 refresh 都被触发。
- 上传 CSV 不触发 refresh。
- refresh 失败不影响库存结果完成和历史写入。
- refresh 失败不更新最后成功时间。
- 多个 refresh 请求严格串行。
- 每个请求使用自己的 CSV，不发生覆盖。
- 派生或 embedding 失败时旧 generation 仍可查询。
- 成功发布后 SQLite、LanceDB、BM25 和颜色缓存属于同一 generation。
- refresh 后无需重启 Web Service 即可查询新数据。

### 5.5 Chat Agent

- 有 refresh 时间时提示词包含准确 UTC 时间。
- 无时间时明确显示未知。
- 失败 refresh 后仍显示上一次成功时间。
- `lookupProductInventory` 的所有返回路径都带一致的快照信息。
- 长对话历史不会截断 system prompt 中的 refresh 信息。

### 5.6 构建验证

- 运行 server Vitest。
- 运行 server TypeScript build。
- 运行 client build。
- 运行 auto build。
- 使用旧版模拟 Volume 数据执行一次迁移和完整 refresh 演练。

## 6. 建议实施顺序

1. 增加数据库迁移基础设施。
2. 迁移用户角色约束并实现角色修改 API。
3. 修复 token 角色时效和认证初始化。
4. 加入 manager/admin 前后端守卫并移除多余入口。
5. 增加 `inventory_results` 表、持久化和历史 API。
6. 实现历史下拉菜单并移除完整结果 localStorage 依赖。
7. 提取可复用 refresh service。
8. 实现串行 refresh 队列和安全 generation 发布。
9. 接入自动下载回调，保持上传模式不触发 refresh。
10. 增加 refresh metadata 并更新 Chat Agent/tool 提示。
11. 完成测试、构建和旧 Volume 演练。

## 7. 主要风险和非目标

### 7.1 主要风险

- SQLite 和 LanceDB 当前没有原子发布机制，完整 refresh 不能简单复用 CLI 的原地替换。
- `sku.sqlite` 新增库存历史后，不能再通过整体替换数据库文件发布 SKU 数据。
- embedding 生成可能耗时较长，必须避免阻塞库存识别和 HTTP 请求。
- 当前库存 pending 槽可能让并发用户互相取消任务，正式上线前应改为 FIFO。
- 当前趋势自动化将部分异常视为空移动并归类为“信息”，可能产生业务误判；虽非本需求核心，实施时应记录为后续数据质量工作。

### 7.2 本计划非目标

- 不在库存 UI 展示 SKU refresh 状态或错误。
- 不保存失败/取消的库存任务历史。
- 不为 manager 或库存页面增加 i18n。
- 不允许通过应用创建新的 admin。
- 不在本阶段实现跨 20 次记录的 SKU 趋势分析。
- 不将文件 mtime 当作 ERP 数据业务时间。
