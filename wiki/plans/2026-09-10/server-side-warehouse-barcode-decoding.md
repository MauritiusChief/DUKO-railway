# 仓库扫码服务端解码重构计划

## 状态

已实施（2026-09-10 同日完成）。构建与既有测试通过；人工真机验收通过（PC Chrome、Android、iPad Safari，同 Wi-Fi 环境）。稳定结论已回写 [仓库扫码](../../server/warehouse-scan.md)、[Windows 局域网手机测试](../../windows-lan-mobile-testing.md) 与 `.agent/context/data-safety.md`。实施偏差见文末。

## 目标

- 将仓库扫码的条码解码从浏览器全面迁移到服务端，消除 iPadOS Safari 对原生 `BarcodeDetector`、前端 ZXing WASM 及其静态资源的依赖。
- iPad 只负责拍照或选取图片、进行必要的尺寸压缩并上传；服务端在内存中确定性识别条码后返回结果。
- 保持现有扫码业务语义：一张图片只能贡献至多一个型号序列号和至多一个产品序列号；用户仍须点击确认，且只有既有 `POST /api/warehouse/scans` 可写入 SQLite。
- 支持现场持续约每秒两张图片的解码吞吐，不采用 LLM 或第三方图片服务。

## 非目标

- 不保留浏览器原生或 WASM 条码解码后备。
- 不增加持续摄像头预览、视频流、浏览器 Web Inspector 诊断面板或独立 Safari 调试流程。
- 不自动写入扫码记录、不改变型号/SKU 映射及导入语义。
- 不把仓库照片发送给 OpenRouter，不复用 `/api/image-parse`，不写入 trace、chat log、SQLite、磁盘或浏览器持久存储。
- 按当前要求不新增自动化测试；验收以构建与人工真机测试为准。

## 已核验现状

- `client/src/pages/WarehouseScanPage.tsx` 目前先尝试原生 `BarcodeDetector`，失败后动态加载 `barcode-detector` ponyfill 和同源 `zxing-wasm`；所有初始化异常均被合并为“条码识别器加载失败”。
- iPad Safari 缺少原生 Barcode Detection API 时会进入前端 WASM 后备路径；iPad Air 第四代的硬件能力不是该失败提示的充分原因。
- 前端目前直接对 `File` 调用 `detect()`，仅将已识别的型号和产品序列号传给 `POST /api/warehouse/scans`；后者是唯一持久化入口。
- 生产 Express 以 `express.static(client/dist)` 提供前端资源，并以 SPA fallback 返回 `index.html`；现有仓库没有服务端 multipart 上传、图像解码或服务端条码依赖。
- 现有 `/api/image-parse` 接收 JSON data URL、调用 OpenRouter 并可建立 trace，不能用于仓库扫码。
- 仓库写入接口已要求 JWT 和 `warehouse | manager | admin` 角色；其限流为每 IP `2000 次 / 15 分钟`。通用 API 限流为 `500 次 / 15 分钟`，LLM 限流为 `50 次 / 15 分钟`。
- `zxing-wasm` 上游声明支持 Node.js，并提供本地 WASM 二进制加载方式；当前前端锁定的版本为 `3.1.3`。

## 方案

### 前端

1. 修改 `client/src/pages/WarehouseScanPage.tsx`，删除原生 `BarcodeDetector`、`barcode-detector` ponyfill、前端 WASM URL 导入、初始化状态及对应失败文案。
2. 扫描按钮始终可用。用户选择或拍摄图片后，前端只做安全的图像准备：按最长边限制缩小、导出受控 JPEG；此过程不进行任何条码解码。
3. 使用既有 `fetchWithAuth` 将一个 `photo` 以 `FormData` 提交到新接口 `POST /api/warehouse/barcode-decode`。不得手动设置 multipart `Content-Type`。
4. 服务端返回可接受的型号和/或产品序列号时，前端继续复用现有轮次合并、冲突替换和“确认录入”流程；服务端返回无条码或无效结果时，不改变本轮状态。
5. 不显示单独的“照片会上传”确认弹窗或提示；数据流边界只记录在内部 Wiki 和数据安全文档。
6. 为连续作业保留小型图片提交队列，并按图片选择顺序应用服务端结果，防止并发响应乱序造成型号和产品错配。队列饱和时暂停新的提交并提示用户稍后重试。
7. 删除不再需要的 `client/src/types/barcode-detector.d.ts`，并从 `client/package.json` 与 lockfile 移除 `barcode-detector` 及仅为前端解码引入的依赖。

### 解码 API

1. 新增专用路由文件，例如 `server/src/routes/warehouse-decode.ts`，提供 `POST /api/warehouse/barcode-decode`。
2. 在 `server/src/index.ts` 中于通用 `/api/warehouse` 管理路由之前挂载此端点，并施加 JWT 认证、专用限流和 `warehouse | manager | admin` 角色校验。
3. 端点只接受 `multipart/form-data` 的一个 `photo` 文件；拒绝额外文件、额外字段、无文件、伪造 MIME、错误图片魔数、超出文件大小及超出像素上限的输入。
4. 上传使用内存存储，禁止写入临时目录、数据库、日志、trace 或 chat log。异常日志不得包含原始图片、图片名、条码值或 multipart 请求对象。
5. 服务端对一张已通过限制的图片完成正常解码，不设置“最多三个候选”的条码数量上限。文件大小、像素数、解码超时、并发数和队列长度才是资源保护边界。
6. 服务端以与既有型号、产品格式相同的规则规范化和分类全部已解码结果：
   - 合法结果最多返回一个型号和一个产品，供前端合并本轮。
   - 无条码、格式外条码、同类型重复或任何额外条码，返回无敏感候选值的结果类别；前端显示现有的对应错误并保持本轮不变。
   - 这样不截断解码结果，也不需要将无界的无效条码值返回给浏览器。
7. 端点绝不调用 `createScanRecord` 或其他数据层写入函数。用户确认后调用原有写入 API 的边界保持不变。

### 图像与解码服务

1. 在 `server/src/services/` 新增独立解码服务，并直接在 `server/package.json` 固定 `zxing-wasm@3.1.3`，不依赖前端的传递依赖。
2. 新增 `multer` 作为路由级内存 multipart 解析器；新增 `sharp` 用于独立读取图像元数据、限制像素、应用方向并转换为受控 RGBA 像素。
3. 解码服务使用 Node worker thread 加载本地 `zxing-wasm/reader` 的匹配 WASM 二进制；worker 不访问网络、数据库、环境变量或外部模型。
4. 保持两个可用的解码 worker，并使用有界等待队列。每个任务设置硬超时；超时 worker 被终止并重建。队列满或 worker 无法在时限内接手任务时返回 `503`，不无限保留图片缓冲。
5. 优先上传前端缩放后的 JPEG。服务端仍应可安全检验 JPEG、PNG 与可用的 HEIC；先在 Railway Node 镜像验证 `sharp` 的 HEIC 解码能力。若镜像缺少该能力，前端必须成功转换 JPEG，否则拒绝原始 HEIC。

### 吞吐和限流

1. 在 `server/src/middleware/rateLimit.ts` 新增 `warehouseDecodeLimiter`，并将既有 `warehouseScanLimiter` 统一为每 IP `2400 次 / 15 分钟`。
2. 每秒两次持续 15 分钟为 `1800` 次；`2400` 为该基线保留约三分之一短时突发余量，显著高于 LLM 限流。
3. 解码吞吐由两个 worker、前端有界队列、图像缩放与硬超时共同控制；限流不替代容量保护。
4. 解码与确认写入分别保留独立的限流计数，但使用相同额度，避免高频图片解码消耗用户确认写入的配额。

## 数据、安全与外部系统

- 照片由浏览器经 HTTPS 传至本服务的请求内存、图像处理缓冲和解码 worker；请求结束或超时后释放，不构成持久化数据。
- 条码和照片均按仓库业务数据处理，禁止出现在日志、错误详情、测试夹具、Git、Issue、trace 和外部模型请求中。
- 新端点继承仓库角色权限；普通 `user` 不得上传或解码仓库图片。
- `sharp` 为原生依赖，Railway 构建和运行兼容性是发布前风险；`zxing-wasm` 的服务端 WASM 文件必须与锁定的 npm 版本一致。
- 此改动不改变 SQLite schema、迁移、Odoo、自动化 worker、外部 API 或模型调用。

## 人工验证

不新增自动化测试。实施后仅执行以下无副作用静态验证：

```bash
npm --prefix client run build
npm --prefix server run build
```

由使用者手动完成以下验收：

1. 在生产 HTTPS 的 iPad Safari 上以相机拍摄实际仓库标签，确认单个型号、单个产品及一图双码场景。
2. 使用相册 JPEG 与 HEIC 各验证一次；确认方向正确且不因压缩破坏识别。
3. 持续以约每秒两张图片提交，确认结果按拍摄顺序进入当前轮次，且无明显队列堆积或服务端繁忙。
4. 验证无条码、格式外条码、同类型重复和含额外条码的图片均不改变当前轮次。
5. 验证 `warehouse` 角色可解码，普通 `user` 被拒绝，且解码接口不会创建扫码记录；只有确认录入后才写入。
6. 在隔离、可信的同 Wi-Fi 环境使用测试账号重复前述场景；测试结束关闭 PM2 和仅限 Private 网络的临时防火墙规则。

## 发布与回滚

- 前端与服务端必须作为同一 Railway 部署发布，避免新前端调用不存在的解码端点。
- 发布前在 Railway 环境手动确认 `sharp` 安装、WASM 本地加载及 HEIC 策略；不得用生产业务图片做构建验证。
- 回滚使用完整应用部署回滚。该方案不含数据库迁移或持久化图片，因此没有数据回滚步骤。
- 回滚后的旧前端会恢复浏览器解码行为；若需要长期保留服务端解码，必须先修复而不是只回滚前端。

## 文档同步

实施完成后更新：

- `wiki/server/warehouse-scan.md`：扫码数据流、解码 API、权限、限流和无持久化图片边界。
- `wiki/windows-lan-mobile-testing.md`：同 Wi-Fi 手动验收改为服务端解码流程。
- `.agent/context/data-safety.md`：仓库照片短暂进入服务端内存但不进入持久化、日志或外部服务的边界。

## 实施结果与偏差

已按方案实施，参数经确认定版：前端压缩最长边 1600px / JPEG 质量 0.85；服务端输入上限 8MB / 24MP；解码硬超时 8s；服务端等待队列 4；前端在途上限 4。

与原方案的偏差：

1. **transfer 修复（关键）**：PM2 子进程环境下 sharp 输出 Buffer 的底层内存不可 `postMessage` transfer，`.buffer.slice()` 副本同样不可转移（`Found invalid value in transferList`，所有请求 200 + `decode-failed`）。实际实现把 RGBA 像素复制到**自行分配的 `ArrayBuffer`**（`new ArrayBuffer(n)` + `Uint8Array.set`）后再 transfer，多一次内存复制。独立 node 进程无此问题，属环境差异，已记录在 wiki 以防回退。
2. **诊断日志保留**：worker 启动健康信号（每 worker 一条 `wasm ready`）与异常分支固定字符串日志（`wasm init failed` / `decode threw` / `pixel pipeline error` / `task timeout`）保留为运维信号；均不含图片数据与条码值，正常解码零日志输出。
3. **队列排队超时具体化**：任务在等待队列中超过 15 秒按 503 拒绝（对应方案中"worker 无法在时限内接手任务时返回 503"）。
4. **worker 熔断**：worker 连续异常重建超过 5 次熔断该槽位（超时不计入），防止 WASM 加载失败时无限重建；计划未提及，为实施中补充的稳定性措施。
5. **分类实现**：`invalid` 涵盖格式外条码、同类型重复与额外条码（未细分），`decode-failed` 覆盖图片损坏与 worker 失败/超时——均为无敏感候选值的结果类别，符合方案意图。
6. 前端移除 `barcode-detector` 依赖及其传递依赖 `zxing-wasm`，删除 `client/src/types/barcode-detector.d.ts`；服务端新增 `multer`、`sharp`、`zxing-wasm@3.1.3`（精确锁定）与 `@types/multer`。
