# 商家信息采集（merchant-collection）计划

## 状态

**阶段 1、2、3 已完成；阶段 4～5 待实施。**

阶段 1 于 2026-09-22 完成，实际实现包括：

- `POST /api/merchants/search`，仅允许 `admin` 和 `manager`。
- 可选 `GOOGLE_PLACES_API_KEY`、30 次/15 分钟按 IP 专用限流、固定 Field Mask、8 秒超时和最多一次重试。
- 中心坐标限制为连续 48 州近似包围框（纬度 `24.396308～49.384358`、经度 `-124.848974～-66.885444`），`rangeKm` 最大 50 km。
- 最多三页、按 Place ID 保留首次出现项；Google 原始返回达到 60 条或第三页仍有 token 时标记可能截断。
- 第一页成功而后续页失败时返回已取得结果，并明确设置 `partial: true`、`possiblyTruncated: true` 和警告。
- Google 响应经过运行时 schema 校验并映射为专用 DTO，不透传原始响应或持久化结果。

阶段 1 自动化验证：服务端 8 个测试文件、130 个测试全部通过，`npm --prefix server run build` 通过；未调用真实 Google API。

阶段 2 于 2026-09-22 完成，实际实现包括：

- 新增 `/merchant-collection` 路由及主页入口，前端路由与入口均只对 admin/manager 开放。
- 增加查询词、中心坐标和 50 km 上限的矩形半宽表单，客户端执行与服务端一致的基础校验。
- 通过 `fetchWithAuth` 调用阶段 1 API；离开页面取消在途请求，搜索结果只保存在组件内存中。
- 展示商家字段、结果数、页数、截断和部分结果警告、Google Maps attribution 与排序因素说明入口。
- 桌面使用表格，窄屏保留原生表格语义并横向滚动；官网和 Maps 外链只接受 `http:`/`https:`。

阶段 2 静态验证：`npm --prefix client run build` 通过；当前仓库没有客户端自动化测试脚本。

阶段 3 于 2026-09-22 完成，实际实现包括：

- 新增 `POST /api/merchant-websites/extract`，仅限 admin/manager，90 次/15 分钟按 IP 限流并限制服务端全局 4 路并发；认证、角色和限流先于独立 8 KiB JSON parser，并发许可在解析后获取。
- 每跳 DNS/IP 校验、固定已验证 IP 连接、Host/TLS SNI 保留、最多 3 次重定向和整链 10 秒 deadline。
- 压缩响应 2 MiB、解压响应 5 MiB，只接受 HTML/XHTML，支持 gzip/deflate/br；不转发任何浏览器、Google 或 Odoo 凭据。
- Cheerio 在可终止 worker 中提取邮箱、电话、title、meta description、canonical URL 和可见正文；正文最多 50 KiB，不提取社交链接。
- 前端支持选择、最多 3 路并发、整批取消、逐行 pending/loading/success/failed 和失败重试；结果仍是页面内存草稿。

阶段 3 自动化验证：服务端 9 个测试文件、187 个测试全部通过，服务端和客户端构建通过；官网测试只使用合成 HTML 和本地临时 HTTP server，未访问真实商家网站。

已确认的产品决策：

- 页面仅对 `admin` 和 `manager` 开放，前后端都必须执行角色校验。
- 使用 Places API (New) Text Search；API key 只通过服务端环境变量提供。
- Google Places 条款及数据来源边界已由维护者严格审核；业务员人工观察、核实并录入的信息按与 Google API 数据不同的来源处理。
- Google 搜索结果先作为临时草稿展示，业务员核实、编辑并明确确认后才纳入浏览器本地名录。
- 名录只保存在当前浏览器，不新增服务端商家数据库，不跨设备或浏览器 profile 同步。
- 商家官网只抓取首页；原始 HTML 只在请求内存中交给 Cheerio 解析，不长期保存。
- 长期保存官网提取的联系方式、页面元数据和限长后的清洗正文。
- Google 搜索与官网抓取是两个独立操作；不建立服务端后台任务。
- CSV 去重只使用 Google Place ID，不按名称、地址、域名、电话或邮箱猜测合并。
- 查询范围使用单个公里数表示矩形半宽。例如输入 `10 km`，表示从中心向东、西、南、北各约延伸 10 km，总宽和总高各约 20 km；只要求近似计算。

## 目标

1. 新增商家采集页面，允许管理员和经理按文本查询、中心坐标和近似矩形范围搜索商家。
2. 服务端自动处理 Google Text Search 分页，使前端一次搜索操作获得最多 60 条结果。
3. 达到 Google 60 条上限时明确提示结果可能被截断，避免用户误认为已经取得范围内全部商家。
4. 临时搜索结果以可选择表格展示；用户可另行触发官网首页抓取，提取邮箱、电话、社交链接、页面元数据和清洗正文。
5. 用户核实并确认后，把商家记录保存到浏览器 IndexedDB；多次纳入和 CSV 导入按 Place ID 去重合并。
6. 本地名录支持表格编辑、删除、CSV 导入和 CSV 导出。
7. 为未来把清洗后的官网正文交给 LLM 理解商家业务保留稳定字段，但本期不调用 LLM。

## 非目标

- 不建立服务端商家 SQLite 数据库，不在 Railway Volume 保存商家名录或网页正文。
- 不自动把每次 Google 搜索结果写入 IndexedDB。
- 不提供多用户共享名录、跨设备同步、服务端备份或审计历史。
- 不抓取 Contact、About 或其他站内页面，不递归爬取整站。
- 不保存原始 HTML，不执行网页 JavaScript，不使用 Playwright，也不复用带 Odoo 登录态的 auto worker。
- 不绕过 Google 单次查询最多 60 条的限制，不通过自动切片网格扩大单次搜索结果集。
- 不对名称或地址做模糊去重；缺少 Place ID 的 CSV 行不进入本地名录。
- 不在本期调用 LLM、生成商家摘要、评估潜在客户或自动做业务分类。
- 不追求测地学级别的矩形边界精度；目标区域远离极区时采用常见近似公式即可。

## 已核验现状

- 客户端路由事实源为 `client/src/App.tsx`。`RoleGuard` 已支持传入 `['admin', 'manager']`，库存和仓库管理页面已有相同角色组合。
- 当前没有共享导航壳；主页 `client/src/pages/TableParsePage.tsx` 使用按钮和 `useNavigate()` 提供功能入口。新页面需要同时新增路由和可发现入口。
- 普通受保护请求通过 `client/src/lib/fetchWithAuth.ts` 附加 Bearer token，并在 401 时统一刷新后重试。
- 服务端角色事实源为 `server/src/middleware/auth.ts` 的 `requireAnyRole`。前端 guard 只负责用户体验，不能替代服务端授权。
- `server/src/index.ts` 在通用 `/api` 路由前装配认证和限流；高成本端点可像 LLM、仓库扫码端点一样单独挂载专用 limiter。
- 环境变量集中在 `server/src/config/env.ts`，示例位于 `server/.env.example`；实际 `.env` 不应读取、输出或提交。
- 服务端已有 `papaparse`，客户端没有标准 CSV 依赖。现有部分前端导出通过字符串拼接实现，不适合包含逗号、引号、换行和长正文的商家数据。
- 当前没有 `cheerio`，也没有可复用的通用 HTTP 抓取或 SSRF 防护模块。
- 当前浏览器持久化主要使用 `localStorage`。其容量不适合最多 1000 条且带清洗正文的商家记录，新功能应独立使用 IndexedDB。
- 当前没有客户端测试脚本；客户端静态验证依赖 `npm --prefix client run build`。服务端使用 Vitest。
- Google Text Search (New) 当前每页最多 20 条、跨所有页面最多 60 条，并通过 `nextPageToken` / `pageToken` 翻页。达到 60 条时应视为可能截断。
- Text Search (New) 可通过 Field Mask 直接返回电话和 `websiteUri`；请求电话或官网字段会触发对应的较高计费 SKU，因此字段集合必须固定且最小化。
- `locationRestriction.rectangle` 可限定类别型文本查询。页面需要提示用户输入商家类别或服务查询，而不是把经纬度本身放进 `textQuery`。

## 用户流程

1. 管理员或经理从主页进入 `/merchant-collection`。
2. 输入商家查询词，例如 `kitchen cabinet stores`。
3. 输入从 Google Maps 复制的中心坐标，例如 `41.02518681565052, -73.65277742711385`。
4. 输入查询范围公里数。`10` 表示中心向四个方向各约 10 km。
5. 点击搜索。页面校验输入后调用服务端，服务端计算矩形并自动读取 Google 的全部可用页。
6. 页面展示临时结果、返回数量、页数和错误；结果达到 60 条时显示“已达到 Google 单次查询上限，范围内可能还有未返回商家”。
7. 用户在临时结果表中选择商家，另行点击“抓取所选官网首页”。前端以受控并发逐条调用官网提取端点并实时更新每行状态。
8. 用户根据官网、电话联系或实地观察核实并编辑记录，明确点击“纳入本地名录”。
9. 本地名录按 Place ID upsert 到 IndexedDB；已存在记录不产生重复行。
10. 用户可继续搜索并合并更多经核实记录，也可从 CSV 导入或把完整本地名录导出为 CSV。

搜索结果和本地名录应在视觉与状态上明确分区，避免用户把临时 Google 响应误认为已经保存的数据。

## 范围计算

输入：中心纬度 `latitude`、中心经度 `longitude`、向四周延伸的近似距离 `rangeKm`。

采用以下近似：

```text
latitudeDelta  = rangeKm / 111
longitudeDelta = rangeKm / (111 * cos(latitudeRadians))

south = latitude  - latitudeDelta
north = latitude  + latitudeDelta
west  = longitude - longitudeDelta
east  = longitude + longitudeDelta
```

请求中的矩形为：

```text
low  = { latitude: south, longitude: west }
high = { latitude: north, longitude: east }
```

实现约束：

- 坐标输入允许逗号两侧有空白，但必须恰好解析出两个有限数字。
- 中心点使用连续 48 州的近似包围框限制：纬度 `24.396308～49.384358`、经度 `-124.848974～-66.885444`；这是业务输入边界，不做州界多边形判断。`rangeKm` 必须为正数且不超过 50 km。
- 本功能只要求常用业务区域内的近似矩形；不增加球面测地库，也不在返回后执行严格圆形距离过滤。
- 对导致矩形越过极点或无法形成有效 Google viewport 的输入直接返回校验错误，不为罕见极区输入增加复杂兼容逻辑。
- 初始 UI 只提供一个范围值，不分别设置东西和南北半宽。

## Google Places 集成

### 配置

在 `server/src/config/env.ts` 和 `server/.env.example` 增加：

```text
GOOGLE_PLACES_API_KEY=
```

- key 只在服务端读取，通过 `X-Goog-Api-Key` 请求头发送，不返回客户端，不放进查询字符串或日志。
- 在 Google Cloud 中把 key 限制到 Places API，并通过项目配额和预算告警控制费用。
- 该功能是可选外部能力：缺少 key 时服务仍可启动，但商家搜索端点返回明确的未配置错误。

### Text Search 请求

- 固定调用 `POST https://places.googleapis.com/v1/places:searchText`，不接受客户端提供 API host。
- 请求体包含 `textQuery`、`pageSize: 20`、`locationRestriction.rectangle`，后续页增加上一页返回的 `pageToken`。
- Field Mask 固定为实际表格所需字段和 `nextPageToken`，禁止在生产使用 `*`。
- 初始候选字段：Place ID、显示名称、格式化地址、坐标、国际/本地电话、官网、营业状态、Google Maps URL和 `nextPageToken`。
- 对 Google 响应做运行时 schema 校验，不把未知响应原样透传给浏览器。
- 循环条件为存在 `nextPageToken` 且未超过 3 页；每页按 Place ID 去重合并。
- 总数等于 60，或者第三页后仍存在下一页信号时，`possiblyTruncated = true`。
- 某一后续页失败时返回明确错误；不要静默把部分结果伪装成完整成功。是否允许前端展示已取得的部分结果由响应中的 `partial` 状态显式表达。
- 设置请求超时，并对 429、可重试 5xx 和不可重试 4xx 分类；重试次数必须有小上限并尊重 `Retry-After`。

### 返回 DTO

返回客户端的临时结果使用专用 DTO，只包含页面需要的字段，不返回 Google API key、原始响应或未使用字段。建议顶层结构：

```text
{
  results,
  resultCount,
  pageCount,
  possiblyTruncated,
  partial,
  warning?
}
```

页面在临时搜索结果区域显示符合 Google Places 政策的 Google Maps attribution，并提供搜索排序因素说明入口。

## 官网首页提取

### 接口与执行方式

- 新增单商家提取端点，例如 `POST /api/merchant-websites/extract`。
- 请求只携带 `placeId` 和 `websiteUrl`；每次只抓一个首页，便于隔离失败、重试和限流。
- 用户点击“抓取所选官网首页”后，客户端以小并发池调用该端点并显示 `pending / loading / success / failed`。
- 建议客户端并发上限为 3；取消或离开页面时使用 `AbortController` 停止尚未开始或仍在等待的请求。
- 不在服务端建立任务表、队列或重启恢复机制；刷新页面会中断本次抓取，已确认写入 IndexedDB 的数据不受影响。

### SSRF 和资源边界

官网 URL 即使来自 Google 也必须视为不可信输入：

- 只允许 `http:` 和 `https:`，优先请求 HTTPS，不允许 `file:`、`data:`、`ftp:` 等协议。
- DNS 解析后拒绝 loopback、私网、link-local、组播、保留地址、运营商级 NAT 和云元数据地址。
- 每次重定向都重新验证协议、主机和解析 IP，限制重定向次数。
- 不转发浏览器 cookie、Authorization、Google key、Odoo 凭据或其他内部请求头。
- 设置连接/总请求超时、最大响应字节和最大解压后字节；超过上限立即中止。
- 只解析 HTML Content-Type；对下载文件、图片、视频和未知二进制内容返回可解释错误。
- 使用固定且可识别的 User-Agent，不记录页面正文、邮箱、电话或完整响应。
- 不使用 auto worker 或其持久 Chromium profile，避免把不可信网站与 Odoo 登录态放在同一信任边界。

### Cheerio 提取

原始 HTML 只在当前请求内存中解析，响应结束后丢弃。提取内容包括：

- `mailto:` 和页面文本中格式合理的邮箱地址。
- `tel:` 和可保守识别的电话号码候选。
- `<title>`、meta description、canonical URL。
- 去除 `script`、`style`、`noscript`、SVG、模板和重复空白后的可见文本。

此版不提取的内容包括：

- 常见社交平台链接。

限制：

- 邮箱、电话和链接去重后返回，并保留提取来源 URL。
- 清洗正文在服务端截断到最多 50 KiB；同时返回 `textTruncated` 供页面提示。
- 不执行 JavaScript，因此纯客户端渲染网站可能只能得到很少内容；页面应显示“静态首页未发现”而不是断言商家不存在联系方式。
- 自动提取结果先进入草稿，用户确认后才进入本地名录。

## 浏览器本地数据

### IndexedDB 选择

100～1000 条记录适合 IndexedDB，不使用 `localStorage`：

- 若每条记录最多保存约 50 KiB 清洗正文，1000 条正文上界约为 50 MiB，其他文本字段相对很小。
- 实际浏览器配额由浏览器、磁盘空间和 profile 策略决定，不能把固定容量写死为产品承诺。
- 页面使用 `navigator.storage.estimate()` 显示当前估算用量和配额；可尝试 `navigator.storage.persist()` 降低浏览器自动回收概率，但不能把返回成功作为功能前提。
- 清除站点数据、无痕窗口结束、浏览器 profile 损坏或设备丢失仍会删除名录，因此 CSV 导出是必要的用户备份和迁移路径。

建议新增独立 IndexedDB，例如 `duko-merchant-collection`，首版 schema 包含：

- `merchants` object store，`keyPath = placeId`。
- `meta` object store，保存 schema 版本、最近导入/导出时间等非敏感状态。

### 本地记录

本地记录与 Google 临时 DTO 使用不同 TypeScript 类型，避免无意中持久化完整响应。建议字段：

```text
placeId
businessName
address
phone
emails[]
websiteUrl
socialLinks[]
pageTitle
pageDescription
cleanedWebsiteText
notes
verificationStatus
verifiedAt
createdAt
updatedAt
```

- `placeId` 是唯一键且不可为空。
- 数组在 UI 和 IndexedDB 中保持数组，在 CSV 中使用明确且可逆的编码约定。
- 每次写入前再次执行长度限制，防止 CSV 导入绕过官网提取端的限制。
- IndexedDB 数据是同一浏览器 origin/profile 下的站点数据，不因退出账号自动删除。页面应提示共享浏览器风险。

### 合并规则

- 新 Place ID：创建记录。
- 已存在 Place ID：合并到现有记录，不创建第二行。
- 导入或再次确认时，传入的非空字段更新现有值，空字段不清除现有值；显式清空必须在编辑 UI 中完成。
- 同一 CSV 内 Place ID 重复时按文件行号报告，避免依赖隐含的“最后一行获胜”。
- 搜索草稿命中已有 Place ID 时标记“已收录”，但不自动覆盖本地人工字段。

## CSV 导入与导出

- 客户端引入标准 CSV 解析/生成能力，例如 `papaparse`；不使用 `split(',')` 或手工字符串拼接。
- 导出范围只包含 IndexedDB 本地名录，不直接导出仍处于临时搜索区的结果。
- CSV 固定表头、UTF-8 BOM，并正确处理逗号、双引号、换行和 Unicode。
- 对以 `=`, `+`, `-`, `@`、制表符或回车开头的单元格执行电子表格公式注入防护。
- 导入前校验文件大小、最大行数、字段长度和必需列；本功能预期 100～1000 行，初始最大行数可留安全余量但不能无限制读取。
- 缺少或空白 `placeId` 的行拒绝导入并报告行号。
- 导入先显示预览统计：新增、更新、无变化、错误；用户确认后再以单个 IndexedDB transaction 应用。
- 导出长清洗正文会产生包含多行单元格的合法 CSV；页面应提示使用支持标准 CSV 引号规则的软件打开。

## 前端方案

预计新增或修改：

- `client/src/App.tsx`：新增 `/merchant-collection`，使用 `RoleGuard allowedRoles={['admin', 'manager']}`。
- `client/src/pages/TableParsePage.tsx`：为管理员和经理增加页面入口。
- `client/src/pages/MerchantCollectionPage.tsx`：搜索表单、临时结果、抓取进度、本地名录和 CSV 操作。
- `client/src/pages/MerchantCollectionPage.css`：桌面表格和移动端可用布局。
- `client/src/lib/merchantDb.ts`：IndexedDB schema、迁移和 transaction 封装。
- `client/src/lib/merchantCsv.ts`：CSV 映射、校验、公式注入防护和导入预览。
- `client/src/types/merchant.ts`：临时 Google DTO、抓取 DTO、本地记录和 CSV 行类型。

UI 最少需要：

- 查询词、中心坐标、范围公里数和搜索按钮。
- 对范围语义的明确说明：“输入 10 表示向东、西、南、北各约 10 km”。
- Google 临时结果与本地名录两个清晰区域。
- 搜索页数、结果数、60 条截断提示和 Google Maps attribution。
- 临时结果多选、官网抓取、逐行状态、失败重试和纳入本地名录操作。
- 本地表格编辑、删除、CSV 导入/导出、存储占用提示。
- 移动端允许横向滚动或切换为记录卡片，不能依赖桌面宽表才能操作。

## 服务端方案

预计新增或修改：

- `server/src/routes/merchants.ts`：搜索与单官网提取端点，router 级 `requireAnyRole('admin', 'manager')`。
- `server/src/validation/merchants.ts`：坐标、范围、查询词和 URL schema。
- `server/src/services/google-places.ts`：固定 Google endpoint、Field Mask、分页、超时、重试和响应映射。
- `server/src/services/website-contact-extractor.ts`：安全抓取、Cheerio 解析和限长清洗。
- `server/src/middleware/rateLimit.ts`：商家搜索和官网抓取专用 limiter。
- `server/src/config/env.ts`：`GOOGLE_PLACES_API_KEY`。
- `server/src/index.ts`：在通用 `/api` middleware 前按明确 limiter 和认证顺序挂载路由。
- `server/.env.example`：新增变量说明。
- `server/package.json`：新增 `cheerio` 及必要类型依赖。

搜索端点一次用户请求最多读取 3 页，每页至多重试一次，因此最坏可产生 6 次 Google 出站尝试。不能只依赖通用 HTTP request limiter；除专用 limiter 外还要硬编码三页和重试上限，并在 Google Cloud 设置项目配额和费用告警。

## 认证、日志与数据边界

- 客户端路由和主页入口仅向 admin/manager 显示；服务端两个端点必须独立返回 403 给其他角色。
- API key 只存在于服务端配置和出站请求头，不进入浏览器、错误响应、日志、trace 或测试快照。
- 服务端不记录 Google 原始响应、官网 HTML、清洗正文、邮箱和电话。
- 可记录脱敏运行指标：用户 ID、操作类型、页数、结果数、抓取耗时、HTTP 状态类别和固定错误码。
- 浏览器本地名录不会被当前服务端备份，也不会随账号删除或登出清除；这项行为必须在页面和 Wiki 中明确。
- 未来把官网正文交给 LLM 时，必须把正文视为不可信数据，隔离网页中的 prompt injection，限制发送字段并重新评估隐私、费用、trace 和保留策略。

## 实施阶段

### 阶段 1：类型、配置和 Google 搜索（已完成）

1. 增加环境变量、验证 schema、专用 limiter 和角色受限路由。
2. 实现范围近似计算、Text Search 固定客户端、三页循环、Place ID 去重和截断状态。
3. 为范围计算、分页、去重、错误分类和授权矩阵增加服务端测试。

### 阶段 2：临时搜索页面（已完成）

1. 增加路由、主页入口和搜索表单。
2. 展示临时结果、Google Maps attribution、分页统计和截断警告。
3. 保持搜索结果为页面内存状态，不在该阶段写入 IndexedDB。

### 阶段 3：官网首页提取（已完成）

1. 实现 SSRF 防护、受限 HTTP 获取、Cheerio 解析和响应限长。
2. 前端增加选择、受控并发、取消、逐行进度和失败重试。
3. 使用合成 HTML 和本地 mock 测试，不为验证访问真实商家网站。

### 阶段 4：本地名录和 CSV

1. 建立 IndexedDB schema 和本地记录编辑流程。
2. 实现人工确认后纳入、Place ID upsert、存储估算和共享浏览器提示。
3. 实现标准 CSV 导入、预览、合并、导出和公式注入防护。

### 阶段 5：验证、文档和授权环境试运行

1. 执行自动化测试和各受影响项目构建。
2. 在已授权的 Google 项目中用小范围类别查询核对计费字段、分页、attribution 和 60 条提示。
3. 经明确授权后使用少量公开测试网站验证 SSRF 边界、静态首页提取效果和超时行为。
4. 同步主题 Wiki、context、本计划状态与实际偏差。

## 风险

1. **Google 结果不保证穷尽**：即使未达到 60 条，搜索也是相关性排序而不是范围内商家全集；达到 60 条时必须提示可能截断。
2. **费用放大**：一个搜索操作最多产生 3 次 Text Search 请求，且电话/官网字段提高 SKU；通过固定 Field Mask、页数硬上限、专用限流、Google quota 和预算告警控制。
3. **官网 SSRF**：公开 URL 可解析到私网或通过重定向进入内网；必须验证每个 DNS 结果和每次重定向，不能只检查 URL 字符串。
4. **抓取成功率有限**：只抓静态首页且不执行 JavaScript，会漏掉 Contact 页和客户端渲染内容；这是已接受的产品取舍。
5. **浏览器数据丢失**：IndexedDB 容量足以覆盖预期记录量，但不是备份系统；清除站点数据或更换设备会丢失名录，需依赖 CSV 导出。
6. **共享浏览器泄露**：IndexedDB 属于浏览器 origin/profile，不随退出登录清除；共享设备上的后续用户可能接触本地商家数据。
7. **CSV 体积和兼容性**：长正文可产生多行 CSV 单元格；必须使用标准 quoting，并对电子表格公式注入做防护。
8. **严格 Place ID 去重**：人工 CSV 若缺少 Place ID 将无法导入；同一真实商家若 Google Place ID 发生变化也会形成不同记录，不做名称/地址自动合并。
9. **本地 schema 演进**：未来增加 LLM 字段时需要 IndexedDB version migration；不得通过删除数据库来简化升级。
10. **网页提示注入**：未来 LLM 不得把抓取正文当作指令或可信事实；本期虽不调用 LLM，字段命名和文档仍需保留该安全边界。

## 验证

### 服务端自动化

- 坐标字符串解析：空白、非法数字、越界和多余分隔项。
- `rangeKm` 近似矩形：示例坐标、10 km 四向半宽及非法范围。
- Google 1、2、3 页分页，`nextPageToken` 传递和最多 3 页硬限制。
- 跨页重复 Place ID 去重。
- 60 条和第三页仍有 token 时的 `possiblyTruncated`。
- Google 429、5xx、4xx、超时、畸形 JSON 和部分分页失败。
- admin/manager 可用，user/warehouse 返回 403。
- 官网 URL 协议校验、私网/loopback/link-local/元数据地址拒绝。
- DNS 与重定向重新校验、重定向上限、响应大小、Content-Type 和超时。
- Cheerio 对邮箱、电话、社交链接、元数据、正文清洗和 50 KiB 截断的合成夹具测试。
- 日志和错误响应不包含 API key、HTML 正文或联系人数据。

### 客户端静态与人工验证

- `npm --prefix client run build` 覆盖 TypeScript 和 Vite 构建。
- 临时结果不会因搜索完成而自动写入 IndexedDB。
- 人工确认后按 Place ID 新增/合并，刷新页面后本地名录仍存在。
- CSV 正确处理逗号、引号、换行、Unicode、数组字段和公式注入前缀。
- 缺少 Place ID、重复 ID、超长字段和超限行数有明确导入报告。
- IndexedDB 容量估算和持久存储请求失败时不阻断基本功能。
- admin/manager 可进入页面，其他角色无入口且直接访问被 guard 拦截。
- 桌面和移动端均可完成搜索、选择、抓取、确认、编辑和导出。

### 命令

```bash
npm --prefix server test
npm --prefix server run build
npm --prefix client run build
```

外部 Google 请求和真实网站抓取有费用及网络副作用，不作为普通自动化验证运行；授权环境验证前确认目标项目、配额和查询范围。

## 发布 / 回滚

- 先在 Google Cloud 配置 Places API key 限制、配额和预算告警，再向 Railway 添加 `GOOGLE_PLACES_API_KEY`。
- 代码发布后先用管理员账号和小范围查询验证；随后验证经理权限和其他角色 403。
- 新功能不迁移服务端数据。IndexedDB 首版只在用户实际进入并保存记录时创建。
- 回滚代码会移除页面和 API，但浏览器中的 IndexedDB 不应自动删除；重新发布兼容版本后仍可读取。若未来决定废弃数据，必须提供导出和明确的用户确认流程，不能静默清库。
- API key 泄露或异常费用时，先在 Google Cloud 撤销/轮换 key 并关闭端点，再调查日志；不得把 key 写进 Issue。

## 文档影响

实施时需要同步：

- `wiki/architecture.md`：浏览器 → server → Google Places / 商家官网的数据流和本地 IndexedDB 状态。
- `wiki/client/README.md`：新页面、权限、本地数据、CSV 和共享浏览器边界。
- 新建或扩展客户端商家采集专题页：表单语义、两阶段流程、抓取限制和备份方式。
- `wiki/server/README.md`：Places 搜索与安全官网提取能力。
- `wiki/server/auth-and-persistence.md`：admin/manager API 权限及“服务端不持久化、本地 IndexedDB 持久化”的边界。
- `wiki/RAILWAY_SETUP.md`：`GOOGLE_PLACES_API_KEY`、Google Cloud key 限制、quota 和预算告警。
- `.agent/context/external-systems.md`：Google Places 固定 endpoint、计费/配额和官网抓取信任边界。
- `.agent/context/data-safety.md`：浏览器商家名录、清洗正文、共享浏览器和 CSV 导出风险。
- 本计划：实施后更新状态、实际偏差和授权环境验证结果。

Wiki 强制影响检查：本计划对应的未来实现会改变系统数据流、API、认证角色范围、配置项、外部系统交互、部署配置和安全边界，因此上述文档同步是实施完成条件。本次仅新增计划文件，没有改变当前运行行为，主题 Wiki 仍描述现状，不提前改写为未实现能力。
