# Layout Recognize Multi-Agent Plan

## 背景

当前 layout recognize 只有一个单一的 `LayoutAgent`，直接使用较慢的 OpenRouter 多模态模型读图、推理、搜索并修改 layout。目标是把 layout recognize 改造成类似 table parse 的多 agent 架构，同时把原 `MainAgent` 改名为 `TableParseAgent`，避免多个功能都存在“主 agent”后产生歧义。

## 关键决策

- 不保留 `server/src/agents/main-agent.ts` 兼容文件。代码层面的更改应趁早完成，用户层面的兼容才需要斟酌。
- layout OCR 不是 `LayoutAgent` workflow 里的第一步工具调用，而是与 `LayoutAgent` 平级的预处理步骤。
- `/api/layout/parse-image` 先调用底层 OCR agent，产出一个或多个双轨列表，再把这些 OCR 结果作为输入交给 `LayoutAgent`。
- `dispatchLayoutOcr` 工具仍然需要，供 `LayoutAgent` 在发现初始 OCR 可疑时要求 OCR agent 重新检查原图局部。
- provider 需要拆分：视觉 OCR 走 OpenRouter，多数文本推理、layout 编排和 search 子 agent 走 DeepSeek，以降低耗时。
- 预算系统本质是限制总耗时，不需要区分“视觉预算”或“搜索预算”。只需把 `_budget_info` 文案从“搜索预算”调整为更中性的“工具预算”或“受限工具预算”。
- layout prompt 需要加入 exposed type 信息，即来自 sku.sqlite `exposed_types` 表的 `## 形状代码对照表`，可复用 `getShapeTypeTable()`。

## 1. MainAgent 改名为 TableParseAgent

不保留旧文件兼容。

改动点：

- `server/src/agents/main-agent.ts` 重命名为 `server/src/agents/table-parse-agent.ts`
- `MainAgent` 改为 `TableParseAgent`
- `MainAgentContext` 改为 `TableParseAgentContext`
- `server/src/routes/tableParse.ts` 改 import、实例化和 trace 名称
- `server/src/agents/index.ts` 改导出
- 所有注释、trace 示例、子 agent 注释中 `MainAgent` 改为 `TableParseAgent`
- 新 trace 数据使用 `TableParseAgent`；旧 trace 数据不迁移

## 2. mainAgentReply 改名

勘察结论：`mainAgentReply` 不涉及数据库字段，只存在于请求 schema、chat route、chat agent 内部上下文中。

建议改名：

- `mainAgentReply` -> `tableParseAgentReply`
- `mainAgentSection` -> `tableParseAgentSection`
- `server/src/validation/schemas.ts` 同步改字段
- `server/src/routes/chat.ts` 同步改请求体字段
- `server/src/agents/chat-agent.ts` 同步改参数和 prompt 构造变量
- 若客户端存在调用点，同步改客户端；不做旧字段兼容

数据库影响：

- `parse_records` 表没有该字段
- trace 表没有该字段
- 不需要迁移

## 3. Layout 总流程改造

新流程：

1. `/api/layout/parse-image` 接收图片、当前 layout、viewType、associatedWallIds。
2. 路由创建两个 provider：OpenRouter vision provider 和 DeepSeek text provider。
3. 路由先运行 `LayoutOcrAgent`，让视觉模型把图片转成一个或多个双轨 OCR 列表。
4. 路由把 `initialOcrText`、当前 layout、viewType、associatedWallIds 交给 `LayoutAgent`。
5. `LayoutAgent` 使用 DeepSeek 文本模型进行 layout 编排、SKU 查询调度、layout tools 修改。
6. 如发现 OCR 漏识别、宽度冲突、双轨物体无法对齐、局部文字不清，`LayoutAgent` 通过 `dispatchLayoutOcr` 工具要求 OCR agent 带备注重新检查原图。

## 4. 新增 LayoutOcrAgent

建议文件：

- `server/src/agents/layout-ocr-agent.ts`

职责：

- 接收图片并识别图片上的橱柜结构。
- 输出一个或多个双轨列表，每个列表对应图片中一面墙、岛台或独立连续段。
- 不开放 SKU 查询工具。
- 不检查双轨物体是否真实对齐。
- 不访问 `exposed_types` 或产品数据库。
- 只记录可见文本、标注宽度、是否双轨。

类型建议：

- `LayoutOcrAgent extends BaseAgent<MultimodalChatMessage>`
- 使用 OpenRouter provider。
- 通常不需要工具，直接返回文本。

输入：

- `image`
- `viewType`
- `associatedWallNames`
- `note?: string`

输出格式建议：

```md
## OCR List 1

* air
  * W3024 - 30 in
  * (gap) - 15 in
  * W3036 - 30 in
  * REF - 30 in (also in ground)

* ground
  * REF - 30 in (also in air)

## OCR List 2

* air
  * ...
* ground
  * ...
```

## 5. 新增 dispatchLayoutOcr 工具

建议位置：

- `server/src/tools/dispatch.ts`

新增定义：

- `DISPATCH_LAYOUT_OCR_TOOL`
- tool name: `dispatchLayoutOcr`

参数建议：

- `note`: 给 OCR agent 的复查说明
- `targetArea`: 可选，描述图片区域，例如 left/right/top/bottom/center 或自然语言区域
- `expectedIssue`: 可选，说明怀疑的问题，例如 missing item、unclear width、dual-track alignment mismatch

同步注册：

- `server/src/tools/index.ts`
- `server/src/tools/names.ts`

执行逻辑：

- `LayoutAgent.executeTool()` 用 context 中保存的 `image`、`viewType`、`associatedWallNames`。
- 将工具参数中的 note/targetArea/expectedIssue 拼成 OCR 备注。
- 创建 `LayoutOcrAgent(visionLlm, ...)`。
- 返回 OCR 文本给 layout agent。

## 6. LayoutAgent 改为文本编排 agent

改动方向：

- `LayoutAgent extends BaseAgent<ChatMessage>`。
- 主 LLM 使用 DeepSeek text provider。
- 构造参数或 config 中额外持有 `visionLlm: LlmProvider<MultimodalChatMessage>`，用于 `dispatchLayoutOcr`。
- context 保存 `image`，供二次 OCR 使用。
- `parse()` 参数新增 `initialOcrText`。

工具集：

- layout tools: `readLayout`、`createWall`、`deleteWall`、`insertItem`、`deleteItem`、`insertItemAtPosition`、`updateWallProperties`、`connectWalls`、`disconnectWalls`、`connectIslands`、`disconnectIslands`
- dispatch tools: `dispatchLayoutOcr`、`dispatchBatchSearch`、`dispatchPreciseSearch`
- 可保留自有补漏搜索工具：`searchSkuShape`、`searchSkuDescription`

并发策略：

- `dispatchLayoutOcr`、`dispatchBatchSearch`、`dispatchPreciseSearch` 可并发。
- layout 修改工具不并发，避免共享 layout 状态竞态。

预算策略：

- budgeted tools 包含 `dispatchLayoutOcr`、`dispatchBatchSearch`、`dispatchPreciseSearch`、自有 search tools。
- `dispatchLayoutOcr` 计入预算，因为它同样会拉长总耗时。

## 7. Provider 分离

`server/src/routes/layoutParseImage.ts` 需要同时检查：

- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`

创建：

- `visionLlm = createOpenRouterProvider(...)`
- `textLlm = createDeepSeekProvider(...)`

使用：

- 初始 `LayoutOcrAgent` 使用 `visionLlm`
- `LayoutAgent` 使用 `textLlm`
- `LayoutAgent` 内部创建 `BatchSearchAgent` / `PreciseSearchAgent` 时使用 `textLlm`
- `LayoutAgent` 内部执行 `dispatchLayoutOcr` 时使用 `visionLlm`

trace 注意：

- 当前 `BaseAgent.initSubTrace()` 会复制父 trace 的 provider/model。
- provider 分离后需要给 `initSubTrace()` 增加可选 override，例如 `{ provider, model }`。
- OCR 子 trace 应记录 OpenRouter/model。
- batch/precise 子 trace 应记录 DeepSeek/model。

## 8. Budget 文案调整

不引入复杂双预算系统。

建议最小改动：

- 将 `injectBudgetInfo()` 文案中的“搜索预算”改为“工具预算”或“受限工具预算”。
- 预算耗尽文案改为“你不得再调用这些受限工具”。
- 保留 `getBudgetedToolNames()` 和当前单一预算计数逻辑。

原因：

- 预算本质是限制模型循环和昂贵工具调用造成的总耗时。
- layout 中受限工具既包括 SKU search，也包括视觉 OCR 复查。
- 不需要在第一版区分功能语义。

## 9. Layout Prompt 增加 exposed type 信息

澄清：这里的 exposed type 信息是 sku.sqlite `exposed_types` 表，即 table parse prompt 里的 `## 形状代码对照表`。

已有工具函数：

- `server/src/services/utils.ts#getShapeTypeTable()`
- 数据来源：`server/src/db/sku.ts#getAllShapeTypeEntries()` -> `exposed_types`

改动：

- `LayoutAgent` constructor 加载 `shapeTypeTable`。
- `LayoutAgent.buildPrompt()` 加入 `## 形状代码对照表`。
- OCR agent 不加入这个表，因为 OCR 只做图像文本/宽度识别，不做型号解释或 SKU 查询。

## 10. LayoutAgent 新 workflow prompt

关键点：不是要求 layout agent 第一轮调用 OCR，而是系统已经提供了初始 OCR 结果。

建议 workflow：

1. 阅读 `initialOcrText`，其中可能有一个或多个双轨列表。
2. 调用 `readLayout` 读取当前 layout。
3. 将 OCR 列表与关联墙/岛台匹配。
4. 判断每个 block 的轨道、宽度、双轨属性、gap、墙总宽度。
5. 对需要数据库验证的柜体型号，调用 `dispatchBatchSearch` 或 `dispatchPreciseSearch`。
6. 如果发现 OCR 可能漏识别、双轨无法对齐、宽度总和明显冲突、局部文字不清，调用 `dispatchLayoutOcr` 并带上具体备注。
7. 使用 layout tools 增量修改布局。
8. 最后用中文简短说明修改了什么，以及哪些区域仍不确定。

## 11. SSE 行为

最小改动方案：

- 初始 OCR 预处理开始/完成可通过现有 `tool_call` 事件表示，例如 `layout-ocr-preprocess`。
- 若需要调试初始 OCR 文本，可新增 `ocr_result` SSE 事件，但第一版不是必须。
- `LayoutAgent` 内部二次 OCR 通过现有 `tool_call: dispatchLayoutOcr` 显示。
- layout 修改仍通过现有 `layout_update` 事件推送。

## 12. 验证计划

构建验证：

- `npm --prefix server run build`
- `npm --prefix client run build`
- 可选：`npm --prefix server test`

手动验证：

- `/api/table-parse` 能正常解析清单。
- `/api/table-parse` 新 trace 名称为 `TableParseAgent`。
- chat 上下文字段改为 `tableParseAgentReply` 后仍能工作。
- `/api/layout/parse-image` 会先执行 OCR 预处理，再进入 layout agent。
- 初始 OCR 能输出一个或多个双轨列表。
- layout agent 可以根据初始 OCR 修改 layout 并推送 `layout_update`。
- layout agent 在可疑区域可以通过 `dispatchLayoutOcr` 二次 OCR。
- trace 中 layout 顶层是 DeepSeek，OCR 子 agent 是 OpenRouter，search 子 agent 是 DeepSeek。
