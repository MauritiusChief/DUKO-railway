# 仓库扫码

面向 Android Chrome 及 iOS 17+ Safari/Chrome 的仓库条形码点数功能：条码解码在服务端完成（浏览器只负责拍照/选图、压缩与上传，不做任何解码）；每次确认录入必须取得一个型号序列号和一个产品序列号；产品序列号全局唯一；数据由服务端 SQLite 持久化（`sku.sqlite`），不依赖浏览器 localStorage。不写入 Odoo，不触碰库存 CSV、库存看板与 auto worker。

实现入口：路由 `server/src/routes/warehouse.ts` 与解码路由 `server/src/routes/warehouse-decode.ts`，解码服务 `server/src/services/barcode-decode.ts`（worker `barcode-decode-worker.ts`），数据层 `server/src/db/warehouse.ts`（DDL 在 `server/src/db/sku.ts` 的 `initSkuDB`），校验 `server/src/validation/warehouse.ts`；前端 `client/src/pages/WarehouseScanPage.tsx` 与 `client/src/pages/WarehouseManagePage.tsx`。

## 角色与权限

- 角色为 `admin | manager | warehouse | user`（`server/src/db/users.ts`，迁移 `0003_users_warehouse_role`）。`warehouse` 只能使用扫码页与扫码录入 API；管理端点仅 manager/admin。
- 服务端每个请求都从 `users.sqlite` 读取当前用户与角色（见 [认证与持久化](./auth-and-persistence.md)），角色降级或删号立即生效。
- 限流：`POST /api/warehouse/scans` 与 `POST /api/warehouse/barcode-decode` 各自使用专用 limiter（均 2400 次/15 分钟每 IP，独立计数，现场约每秒两张持续 15 分钟为 1,800 次、留约三分之一突发余量，高于通用 apiLimiter 的 500），挂载在 `index.ts` 全局 `/api` fallback 之前（照 llmLimiter 先注册模式）；其余仓库端点走 apiLimiter。解码高频不消耗确认写入配额，反之亦然。

## 数据模型

`sku.sqlite` 中且仅有的两张仓库业务表（幂等 `CREATE TABLE IF NOT EXISTS`，`initSkuDB` 同时启用 `PRAGMA foreign_keys = ON`）：

- `model_seri_num_mappings`：`model_seri_num` 主键；`sku` 非空、`COLLATE NOCASE UNIQUE`（SKU 与型号全局一对一）；`created_at`/`updated_at` 为服务端 UTC ISO-8601。
- `product_seri_num_records`：`product_seri_num` 主键（即全局唯一，无独立数值 ID）；`model_seri_num` 外键 `REFERENCES model_seri_num_mappings ON UPDATE CASCADE`；`scanned_at` 为 UTC ISO-8601。索引覆盖 `scanned_at DESC` 与 `model_seri_num`。

核心语义：

- **占位映射**：`sku === model_seri_num` 即「待确认 SKU」，不单设占位布尔列。扫码遇到未知型号时在同一事务内创建 `型号 -> 型号` 占位映射，不阻止录入。
- **序列号格式**（服务端固定规则，规范化为 trim + 大写）：型号 `^[A-Z]{2}-[A-Z]{2}-\d{6}$`（如 `DK-CA-002919`），产品 `^[A-Z]{2}-[A-Z0-9]{8}-\d{6}$`（如 `DK-P0016073-347836`）。
- **单条编辑**：`PATCH /scans/:productSeriNum` 只影响该条记录；改到未知型号先建占位映射。绝不批量修改其他记录。
- **全局重命名**：`PATCH /mappings/:modelSeriNum` 修改型号走外键 `ON UPDATE CASCADE`，级联更新所有关联扫描记录；UI 须显示影响数量（`record_count`）并二次确认。管理端点返回 `affected_records`。
- **删除**：扫描记录可删除（无审计表），映射不提供删除入口；删记录不删映射。
- SKU 数据刷新只替换既有引用表，不触碰这两张表；回滚代码时保留表与数据（旧服务忽略未知表）。`sku.sqlite` 无迁移框架，改表结构前需先引入（见 [数据与搜索](./data-and-search.md)）。

## API 契约

所有输入经 Zod 校验并服务端规范化；错误格式与全站一致（`{ error, detail? }`）。唯一性冲突返回 `409`。

| 端点 | 权限 | 语义 |
| --- | --- | --- |
| `POST /api/warehouse/barcode-decode` | warehouse/manager/admin | multipart 单 `photo` 文件（内存存储，不落盘）；服务端解码，详见下文「服务端解码服务」；绝不写数据层 |
| `POST /api/warehouse/scans` | warehouse/manager/admin | body `{ modelSeriNum, productSeriNum }`；必要时建占位映射；`201` 返回 `{ record: { product_seri_num, model_seri_num, sku, scanned_at } }`；产品重复返回 `409 { existing }`（含原记录 SKU/型号/时间），不改变数据 |
| `GET /api/warehouse/mappings` | manager/admin | 全量映射，含 `is_placeholder` 与 `record_count` |
| `PATCH /api/warehouse/mappings/:modelSeriNum` | manager/admin | body `sku` 或 `newModelSeriNum` **严格二选一**；重命名返回 `affected_records`；目标型号已存在或 SKU 被占用返回 `409` |
| `GET /api/warehouse/scans` | manager/admin | 查询参数 `sku`/`modelSeriNum`/`productSeriNum`（大小写不敏感子串，交集）、`from`/`to`（任意可解析时间，转 UTC，含端点）、`limit`(≤200，默认 50)/`offset`；返回 `{ total, records }` |
| `PATCH /api/warehouse/scans/:productSeriNum` | manager/admin | body `modelSeriNum`/`newProductSeriNum` 至少一项；只改该条 |
| `DELETE /api/warehouse/scans/:productSeriNum` | manager/admin | 删除该条记录，保留映射；前端负责确认 |
| `GET /api/warehouse/summary` | manager/admin | 按时间范围（可省略）按型号分组返回 `{ model_seri_num, sku, is_placeholder, count }` |
| `POST /api/warehouse/imports/validate` | manager/admin | 见下文 JSON 导入契约 |
| `POST /api/warehouse/imports` | manager/admin | 按模式与决策在单一事务写入；任何校验或写入失败不改变现有数据 |

## 扫码页规则

`WarehouseScanPage` 使用 `input[type=file][capture=environment]` 拍照或选图，不显示持续摄像头画面，不振动。浏览器**不做任何条码解码**（不使用原生 BarcodeDetector，也没有 WASM 后备），扫码按钮始终可用：

- 照片在前端压缩为受控 JPEG：`createImageBitmap`（按 EXIF 方向，不支持该选项时回退）→ canvas 按最长边 1600px 缩小 → `toBlob('image/jpeg', 0.85)`，随后以 `FormData`（字段 `photo`，固定文件名 `photo.jpg`，不手动设置 multipart Content-Type）经 `fetchWithAuth` 上传至同源 `POST /api/warehouse/barcode-decode`。CSP 的 `connect-src 'self'` 不需放宽。
- 在途图片（压缩 + 上传 + 等待结果）上限 4 张；结果按**拍照顺序**应用（序号匹配），防止并发响应乱序造成型号/产品错配；队列饱和提示稍后重试，503 同样提示。
- 照片仅在上传期间经 HTTPS 传输，不写入浏览器持久存储；仅解码结果（型号/产品/结果类别）参与页面状态。
- iOS 的支持目标为 iOS 17+；Safari 与 Chrome 行为一致，使用者无需为扫码安装 Chrome。真机验收须覆盖实际标签和 HEIC/JPEG 照片。

服务端对每张图只返回至多一个型号格式值和一个产品格式值，或固定结果类别。前端轮次合并规则：

1. 服务端返回 `no-barcode`（无条码）、`invalid`（额外条码、同类型重复或格式外条码）或 `decode-failed` 时显示对应错误，不改变本轮状态；分类判定由服务端完成，前端不再本地过滤格式。
2. 恰好一个有效序列号且本轮两码均已填时，先清空两项及本轮 SKU 状态再填入本次值（开始下一件）。
3. 合法结果与任一已填槽位同类型但值不同时，丢弃本轮型号、产品及 SKU 状态，并用当前图片中的全部合法结果重建本轮；因此一张含一个新码的图片只填对应槽位，含型号和产品两个新码的图片同时填入两个槽位。
4. 两种序列号可一次拍到或分两次拍到；两者齐后由用户点「确认录入」提交，服务端成功写入后清空本轮。`409` 时显示原记录摘要，本轮保留，由用户手动清空。
5. manager/admin 在扫码页可见管理入口；warehouse 角色只见录入结果与待确认提示。

## 服务端解码服务

`server/src/routes/warehouse-decode.ts`（路由）+ `server/src/services/barcode-decode.ts` / `barcode-decode-worker.ts`（服务与 worker）。`POST /api/warehouse/barcode-decode` 只接受 multipart 的一个 `photo` 文件，输入边界与响应契约：

- 输入校验：multer 内存存储、单文件 ≤8MB、声明 MIME 白名单（JPEG/PNG/HEIC/HEIF）、魔数识别 + MIME 一致性检验、sharp 像素上限 24MP。失败按 400/413/415 返回固定文案；`fields: 0` 拒绝额外表单字段。
- 响应：`200 { ok: true, model?, product? }`（至多各一个，规范化为大写）；`200 { ok: false, reason: 'no-barcode' | 'invalid' | 'decode-failed' }`；`503` 为解码容量饱和。不返回无界的候选条码值。
- 解码管线：sharp（限像素、EXIF 自动方向、RGBA 原始像素）→ 复制到自行分配的 `ArrayBuffer` → transfer 给 worker → `zxing-wasm/reader` 的 `readBarcodes(tryHarder)` 全格式解码，不设条码数量上限；文件大小、像素数、超时、并发与队列才是资源边界。
- worker 池：2 个 Node worker thread，各自从本地依赖包加载 `zxing-wasm@3.1.3`（精确锁定，WASM 二进制与 npm 版本一致，不经网络）；等待队列 4（饱和或排队超时 15 秒按 503 拒绝）；单任务硬超时 8 秒（覆盖像素转换 + 解码），超时 worker 终止重建；worker 连续异常 5 次熔断该槽位，防止无限重建。
- 结果分类复用 `server/src/validation/warehouse.ts` 的固定正则与 `normalizeSerial`，与扫码页轮次规则一致。
- **绝不调用 `createScanRecord` 或任何数据层写入**；用户确认后仍走既有 `POST /api/warehouse/scans`。

数据与日志边界：图片缓冲（multer Buffer、sharp 像素、worker 像素）仅存在于请求生命周期内，响应前清零；不落盘、不入 SQLite/trace/chat log、不发送任何外部服务或模型。日志仅含启动健康信号（每个 worker 一条 `wasm ready`）与异常分支的固定字符串/库错误描述（`wasm init failed` / `decode threw` / `pixel pipeline error` / `task timeout`），不含图片数据、文件名或条码值；正常解码请求零日志输出。

已知环境差异（勿回退）：PM2 子进程环境下 sharp 输出 Buffer 的底层内存不可 `postMessage` transfer，`.buffer.slice()` 副本同样不可转移（报 `Found invalid value in transferList`）。因此像素必须复制到**自行分配的 `ArrayBuffer`**（`new ArrayBuffer(n)` + `Uint8Array.set`）后再 transfer；直接 transfer 或 slice 副本都会让所有解码请求 200 + `decode-failed`。

## 管理页规则

`WarehouseManagePage`（manager/admin）：顶部本地日期整日或本地区间，客户端把边界转 UTC ISO 传给 API；汇总表两列（SKU/型号占位 + 数量，占位显示型号并标记待确认）；扫描记录表默认折叠，三列筛选按交集处理，支持逐行编辑与删除（带确认）；映射表默认折叠，待确认高亮，全局重命名显示影响数量并二次确认。

## 时间与 UTC 语义

- `scanned_at`/`created_at`/`updated_at` 一律为服务端写入的 UTC ISO-8601（`new Date().toISOString()`）。
- 日期/时段控件按使用者设备本地时区生成查询边界并转换为 UTC。不同时区使用者对「某日」汇总可能不同，这是已确认接受的行为。

## JSON 导入契约

只接受原型 `experiment/warehouse_count_helper_cn.html` 导出的单一 JSON，由管理页读文件文本提交，无文件上传中间件：

```json
{
  "app": "warehouse-count-helper",
  "version": 1,
  "exportedAt": "2026-09-08T08:30:00.000Z",
  "formats": { "model": "...", "product": "..." },
  "records": [
    { "id": "原型本地 ID", "sku": "SKU-001", "model": "DK-CA-002919",
      "product": "DK-P0016073-347836", "createdAt": "2026-09-08T08:30:00.000Z", "updatedAt": "" }
  ]
}
```

- 校验固定 `app`/`version` 与非空 `records`；`formats`/`exportedAt` 仅作元数据保留，不用其中正则替代服务端固定格式；`id`/`updatedAt` 无对应列，忽略。每条严格验证 `model`/`product`/`createdAt`（规范化为 UTC ISO）。
- 映射推导：`model -> model_seri_num`；`sku` 非空写入映射 SKU，为空则 `model -> model` 占位。
- 预检（`imports/validate`）：文件内部一致性（产品重复、同型号多 SKU、同 SKU 多型号，大小写不敏感）为 400 硬错误；返回现有/新增/相同跳过/占位升级计数，及三类冲突——产品内容冲突（同产品号但型号或时间不同）、映射冲突（现有非占位映射 SKU 不同）、SKU 碰撞（按「全部采用导入」推演后仍一对一冲突）。
- **替换**：完整校验通过后在单一事务清空并写入两表；UI 必须显示现有记录/映射数并经勾选确认。任何错误整体回滚。
- **合并**：完全相同（型号 + 时间都一致）跳过；占位映射自动升级为导入 SKU；产品内容冲突与映射冲突逐项决策「保留现有 / 采用导入」（缺省保留）；落定后 SKU 一对一仍被破坏则 `409` 并整体回滚。
- 导入记录与冲突清单包含仓库业务数据，前端预览只展示必要字段，不得写入日志、Git 或 Issue。
