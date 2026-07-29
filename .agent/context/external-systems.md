# 外部系统

## Railway

- 根 `railway.json` 使用 Railpack，执行 `npm run railway:build` 后以 `npm run railway:start` 启动。
- Express 在单端口提供 `/api/*`、WebSocket 和 `client/dist`；持久数据目录由 `DB_DIR` 控制，Railway Volume 预期挂载到外部持久路径。
- Railway 反向代理是服务端 `trust proxy=1` 和限流 IP 判断的一部分。

## LLM 与模型

- DeepSeek 提供文本 Agent；OpenRouter 提供多模态 Agent。清单图片和 layout 原始图片内容会直接发送给 OpenRouter；请求还可能携带用户输入、工具结果与业务上下文。Layout Agent 可因复查再次发送同一图片。
- 文本 embedding 由 `@huggingface/transformers` 本地推理生成，模型为 `onnx-community/all-MiniLM-L6-v2-ONNX`；首次使用会从 Hugging Face 下载模型。
- API key 只通过环境变量提供。模型、provider 或发送内容变化都要检查成本、隐私、输出兼容性和降级行为。

## Odoo 与 Auto Worker

- Railway 服务端通过 `/api/auto/connect` WebSocket 向本地 `auto/` worker 派发报价、库存下载和库存趋势任务。
- server 与 worker 使用相同 `AUTO_WORKER_TOKEN` 鉴权。worker 主动连接、单任务执行、心跳并在断线后重连；未确认出站消息会重放。
- worker 使用 Playwright persistent Chromium profile 保存 Odoo 登录态。profile、cookie 和下载数据属于敏感本地状态。
- 报价写入支持 overwrite/append，并存在用户确认握手；不得在测试或调试中绕过确认后连接真实 Odoo。
- 库存也可由用户上传 CSV，不一定经过 worker；上传内容仍按敏感业务数据处理。

## ScriptCat

- `script/` 构建 Odoo 页面用户脚本，产物复制到 `server/public/script/`，由无需登录的下载端点提供。
- 脚本依赖 Odoo DOM 和页面行为，不是稳定公共 API；选择器或写入逻辑变化需要在授权的非生产场景人工验证。

## 待确认

- 外部服务的正式数据处理协议、保留策略、区域和 SLA 未由仓库代码说明。
- Odoo 测试环境、账号权限边界和生产发布审批流程未在当前代码或 `.env.example` 中定义。
