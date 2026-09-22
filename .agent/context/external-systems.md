# 外部系统

## Railway

- 根 `railway.json` 使用 Railpack，执行 `npm run railway:build` 后以 `npm run railway:start` 启动。
- Express 在单端口提供 `/api/*`、WebSocket 和 `client/dist`；持久数据目录由 `DB_DIR` 控制，Railway Volume 预期挂载到外部持久路径。
- Railway 反向代理是服务端 `trust proxy=1` 和限流 IP 判断的一部分。

## LLM 与模型

- DeepSeek 提供文本 Agent；OpenRouter 提供多模态 Agent。清单图片和 layout 原始图片内容会直接发送给 OpenRouter；请求还可能携带用户输入、工具结果与业务上下文。Layout Agent 可因复查再次发送同一图片。
- 文本 embedding 由 `@huggingface/transformers` 本地推理生成，模型为 `onnx-community/all-MiniLM-L6-v2-ONNX`；首次使用会从 Hugging Face 下载模型。
- API key 只通过环境变量提供。模型、provider 或发送内容变化都要检查成本、隐私、输出兼容性和降级行为。

## Google Places

- server 固定调用 Places API (New) Text Search endpoint `POST https://places.googleapis.com/v1/places:searchText`；浏览器不能提供 host，API key 只来自 `GOOGLE_PLACES_API_KEY` 并通过 `X-Goog-Api-Key` 请求头发送。
- 商家搜索最多读取三页、每页 20 条，按 Place ID 去重。电话和官网字段触发 Text Search Enterprise SKU；固定 Field Mask、专用限流、Google quota 和预算告警共同构成费用边界。
- 搜索中心当前只接受连续 48 州近似包围框内坐标，矩形半宽最大 50 km。Google 结果按相关性返回且不保证穷尽，60 条或第三页后仍有 token 表示可能截断。
- Google 原始响应在请求内存中完成 schema 校验和 DTO 映射，不写入服务端数据库、文件、trace 或日志。浏览器已有临时搜索页面，但结果只保存在 React 内存中；尚无官网提取或浏览器本地名录。

## Odoo 与 Auto Worker

- Railway 服务端通过 `/api/auto/connect` WebSocket 向本地 `auto/` worker 派发报价、库存下载和库存调动历史同步（`inventory-moves-sync`）任务。
- server 与 worker 使用相同 `AUTO_WORKER_TOKEN` 鉴权。worker 主动连接、单任务执行、心跳并在断线后重连；未确认出站消息会重放。
- worker 使用 Playwright persistent Chromium profile 保存 Odoo 登录态。profile、cookie 和下载数据属于敏感本地状态。
- 调动同步打开 stock.move.line 全局列表直达 URL（`{ODOO_BASE_URL}/action-809/197381/action-393`，已验证可直达；该动作默认自带 "Status: Done" facet，必须保留不得清理），再以 "Search Location for: ATL/Stock" 过滤（同时覆盖 From/To），按日期降序逐页抓取。Odoo DOM 或动作默认过滤变化都会破坏该流程。
- 报价写入支持 overwrite/append，并存在用户确认握手；不得在测试或调试中绕过确认后连接真实 Odoo。
- 报价行可携带可选折扣（百分数）。折扣按最终产品型号颜色前缀由 server 在生成产品清单时推导（`server/src/constants.ts` 的 `getDiscountPercent`），并随 CSV/协议/快照贯穿；CSV 折扣为空表示不指定，worker 不读取、不清零 Odoo 现有折扣。
- 报价写入不做逐行折扣回读；写入完成后 worker 读取整表与输入 CSV 整体对比，逐条在日志（`FINAL CHECK: ...`）反应多了/少了/不一致，不改行状态与任务状态。
- 库存也可由用户上传 CSV，不一定经过 worker；上传内容仍按敏感业务数据处理。

## ScriptCat

- `script/` 构建 Odoo 页面用户脚本，产物复制到 `server/public/script/`，由无需登录的下载端点提供。
- 脚本依赖 Odoo DOM 和页面行为，不是稳定公共 API；选择器或写入逻辑变化需要在授权的非生产场景人工验证。
- Odoo 修改报价行数量会清空当前行已填折扣；ScriptCat 必须按数量、可选折扣、提交的顺序写入。

## 待确认

- 外部服务的正式数据处理协议、保留策略、区域和 SLA 未由仓库代码说明。
- Odoo 测试环境、账号权限边界和生产发布审批流程未在当前代码或 `.env.example` 中定义。
