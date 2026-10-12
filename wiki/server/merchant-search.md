# 商家搜索

## 当前状态

阶段 1 已实现服务端 Google Places Text Search (New) 接口，阶段 2 已实现临时搜索页面，阶段 3 已实现安全的单商家官网首页提取，阶段 4 已实现浏览器本地名录和 CSV。服务端仍不持久化搜索、官网内容或本地名录；前端只有人工确认后的记录写入当前浏览器 IndexedDB。

## API

`POST /api/merchants/search` 仅允许 `admin` 和 `manager`，请求继续使用普通 Bearer Access Token。认证通过后，该端点使用独立的按 IP 限流器：15 分钟最多 30 次；未认证请求不消耗商家搜索额度。

请求体：

```json
{
  "textQuery": "kitchen cabinet stores",
  "centerCoordinates": "41.02518681565052, -73.65277742711385",
  "rangeKm": 10
}
```

- `textQuery` 去除首尾空白后必须为 1～200 个字符，应填写类别或服务查询，不应填写经纬度。
- `centerCoordinates` 必须恰好包含纬度和经度两个有限数字。当前用连续 48 州的近似包围框限制中心点：纬度 `24.396308～49.384358`、经度 `-124.848974～-66.885444`。这是输入范围保护，不是州界多边形判断。
- `rangeKm` 表示矩形向东、西、南、北延伸的近似半宽，必须大于 0 且不超过 50 km。

成功响应：

```json
{
  "results": [],
  "resultCount": 0,
  "pageCount": 1,
  "possiblyTruncated": false,
  "partial": false
}
```

结果使用服务端 DTO，只包含 Place ID、名称、地址、坐标、国际/本地电话、官网、营业状态和 Google Maps URL。可缺失字段返回 `null`，Google 原始响应不会透传。

第一页失败时返回错误。第一页成功但后续页在有限重试后失败时返回 HTTP 200、已取得的结果、`partial: true`、`possiblyTruncated: true` 和固定 `warning`，避免把部分结果伪装为完整结果。

## Google Places 边界

服务端固定调用：

```text
POST https://places.googleapis.com/v1/places:searchText
```

请求固定使用 `pageSize: 20` 和 `locationRestriction.rectangle`，最多读取三页。翻页会保留首请求参数并增加上一页的 `pageToken`；结果按 Place ID 保留首次出现项。Google 原始返回达到 60 条，或第三页后仍有下一页 token 时，`possiblyTruncated` 为 `true`。

Field Mask 固定为：

```text
places.id,places.displayName,places.formattedAddress,places.location,places.internationalPhoneNumber,places.nationalPhoneNumber,places.websiteUri,places.businessStatus,places.googleMapsUri,nextPageToken
```

电话和官网字段会触发 Text Search Enterprise SKU。修改 Field Mask 前必须重新评估页面需求和费用，生产禁止使用 `*`。

每次 Google 请求超时 8 秒。429、网络错误、超时和可重试 5xx 最多重试一次；`Retry-After` 最长等待 5 秒。因此一次搜索最多读取三页、最多产生六次出站尝试，30 次入站额度的理论上限为 180 次出站尝试；Google 项目 quota 和预算告警仍是必要的最终费用保护。Google 返回先经过运行时 schema 校验，错误响应不包含上游 body、请求头或 API key。

## 配置与发布

`GOOGLE_PLACES_API_KEY` 只由服务端环境变量读取，并通过 `X-Goog-Api-Key` 请求头发送。缺少 key 不阻止服务启动，但搜索端点返回 503 和 `not_configured`。

生产项目应把 key 限制到 Places API (New)，并配置项目 quota 和预算告警。普通自动化测试全部使用合成响应，不调用真实 Google API；授权试运行前需确认目标 Google Cloud 项目、费用上限和查询范围。

## 客户端

`/merchant-collection` 仅对 admin/manager 开放，提供查询词、中心坐标和矩形半宽表单，并展示结果数、页数、截断/部分结果提示和 Google Maps attribution。搜索结果不写入浏览器持久存储。交互细节见 [客户端商家信息采集](../client/merchant-collection.md)。

阶段 3 页面支持选择有官网的商家，以最多 3 路并发调用官网提取端点，显示逐行状态、取消和失败重试。阶段 4 增加人工确认、IndexedDB 本地名录及浏览器端 CSV 导入导出；这些本地操作不调用服务端 API。

## 官网提取 API

`POST /api/merchant-websites/extract` 仅允许 `admin` 和 `manager`，请求体只包含：

```json
{
  "placeId": "google-place-id",
  "websiteUrl": "https://merchant.example/"
}
```

该端点按 IP 限制为 90 次/15 分钟，并在进程内最多同时执行 4 个抓取；角色检查先于专用额度。路由在全局 20 MiB JSON parser 之前挂载，并在认证、角色和限流检查之后使用独立 8 KiB 请求体上限，避免未授权大请求体占用内存；抓取并发许可在请求体解析后获取，慢速上传不会占住抓取槽位。每次只抓取一个首页，不建立服务端任务、重启恢复或持久化记录。

安全获取边界：

- 只允许无用户名/密码的 `http:`、`https:` URL。
- 每次请求和每次重定向都重新解析 DNS；任一解析结果属于 loopback、私网、link-local、CGNAT、组播、文档或其他特殊用途地址时整次拒绝。
- TCP/TLS 连接固定到已验证 IP，同时保留原始 Host、TLS SNI 和证书校验，避免 DNS 检查后的二次解析窗口。
- 最多 3 次重定向；整条 DNS、重定向、下载、解压和解析链共享 10 秒总 deadline。
- 压缩响应最多 2 MiB，解压响应最多 5 MiB；支持 identity、gzip、deflate 和 br，只接受 HTML/XHTML Content-Type。
- 不发送浏览器 Cookie、Authorization、Google key 或 Odoo 凭据；固定 User-Agent 为 `DUKO-Merchant-Contact-Extractor/1.0`。
- Cheerio 解析在可终止 worker 中运行，不执行网页 JavaScript。原始 HTML 只存在于当前请求内存中。

响应包含 `placeId`、最终 `sourceUrl`、去重后的邮箱和电话、title、meta description、canonical URL、清洗正文及 `textTruncated`。清洗会移除 script/style/noscript/SVG/template/iframe/canvas 和明显隐藏节点，正文按 UTF-8 截断到 50 KiB。本版不提取社交平台链接。
