# Layout Recognize LLM + SSE 实时填充计划

## 目标

为 `layout-recognize` 页面补齐图片识别布局能力：用户上传 layout 图片后，LLM 识别图像并调用 layout tools 修改当前布局；前端通过 SSE 实时接收工具调用、LLM 回复和 layout 更新，使左侧 `wp-track-blocks` 能实时看到新增/修改的 block。

同时，去掉 `/api/layout/parse-image` 的 `requireAdmin` 限制，让普通已登录用户也能使用该功能。

## 当前状态

- `client/src/pages/LayoutRecognizePage.tsx` 已有 layout 编辑主页面，左侧 `LayoutCanvas` + `WallPanel` 基于 `layoutStore.activeLayout` 渲染。
- `client/src/components/WallPanel.tsx` 的 `wp-track-blocks` 已根据 store 数据实时计算 block 位置和宽度。
- `client/src/stores/layoutStore.ts` 已有完整的墙、轨道、block、双轨、位置编辑等操作，并持久化到 `localStorage`。
- `server/src/agents/layout-agent.ts` 已存在 `LayoutAgent`，能接收图片和当前 layout，并通过 function calling 调用 layout tools。
- `server/src/tools/layout.ts` 已有 `readLayout/createWall/deleteWall/insertItem/deleteItem/insertItemAtPosition/updateWallProperties/connect*` 等工具。
- `server/src/routes/layoutParseImage.ts` 已声明 SSE，但目前只发送 `tool_call` 和 `done`，没有推送最终或中间 `updatedLayout`。
- `client/src/components/ImageUploadPanel.tsx` 仍按 JSON 响应读取 `res.json()`，与后端 SSE 实现不匹配。
- `client/src/components/LayoutChatPanel.tsx` 目前只是占位。
- `client/src/components/ChatPanel.tsx` 已有主页面 SSE 解析、工具调用展示、流式回复展示逻辑，可以抽出公共逻辑和组件。

## 设计原则

- 最小改动优先：不重写 layout 编辑逻辑，直接复用现有 `layoutStore` 和 `WallPanel` 渲染链路。
- 单一数据源：前端 layout 仍以 `layoutStore.activeLayout` 为准；SSE 收到 layout 后写入 store。
- 实时反馈：每次 LLM 完成一个会修改 layout 的 tool 后，后端立即发送新的 layout 快照。
- 对话呈现复用：主页面 `ChatPanel` 和 layout 页面共用 SSE parser、streaming/tool message 展示组件或 hook。
- 普通用户可用：`parse-image` 路由仅需登录鉴权，不需要管理员鉴权。

## 后端计划

### 1. 去掉管理员限制

文件：`server/src/routes/layoutParseImage.ts`

- 删除 `requireAdmin` import。
- 将路由中间件从：

```ts
layoutParseImageRouter.post('/', requireAdmin, validate(layoutParseSchema), async (...)
```

改为：

```ts
layoutParseImageRouter.post('/', validate(layoutParseSchema), async (...)
```

说明：`server/src/index.ts` 已在挂载路由时使用 `authenticateToken`，所以去掉 `requireAdmin` 后仍要求用户登录。

### 2. 扩展 LayoutAgent 的 layout 更新回调

文件：`server/src/agents/layout-agent.ts`

为 `LayoutAgent` 增加可选回调，例如：

```ts
onLayoutUpdated?: (event: {
  layout: LayoutDocument;
  tool: string;
  message: string;
}) => void;
```

在 `executeTool` 中：

- 先执行搜索工具或 layout 工具。
- 对 layout 修改类工具执行后发送 layout 快照。
- `readLayout` 不发送 `layout_update`，避免无意义刷新。
- 搜索工具不发送 `layout_update`。

识别为会修改 layout 的工具：

```ts
createWall
deleteWall
insertItem
deleteItem
insertItemAtPosition
updateWallProperties
connectWalls
disconnectWalls
connectIslands
disconnectIslands
```

### 3. 完整转发 SSE 事件

文件：`server/src/routes/layoutParseImage.ts`

在 `LayoutAgent` config 的 `onStep` 中转发：

- `round_start` -> `round_start`
- `tool_call` -> `tool_call`
- `reply_chunk` -> `reply_chunk`
- `reply` -> `reply_chunk` 或忽略，视现有 BaseAgent 实际使用情况
- `error` -> `error`

在 layout 更新回调中发送：

```ts
sse.send('layout_update', {
  layout,
  tool,
  message,
});
```

在 `agent.parse(...)` 完成后发送：

```ts
sse.send('result', {
  updatedLayout,
  reply,
});
sse.send('done', {});
```

注意：当前 `LayoutAgent.parse` 只返回 `LayoutDocument`，如果要发送最终回复，需要改为返回 `{ layout, reply }`，或保留 `parse` 返回 layout 并新增内部方法。更小改动是把 `parse` 返回值改为：

```ts
Promise<{ layout: LayoutDocument; reply: string }>
```

并同步更新路由调用点。当前只有 `layoutParseImage.ts` 使用它，影响面小。

### 4. SSE 协议

```ts
event: round_start
data: { "round": 1 }

event: tool_call
data: { "tool": "insertItem" }

event: reply_chunk
data: { "text": "我识别到..." }

event: layout_update
data: {
  "layout": LayoutDocument,
  "tool": "insertItem",
  "message": "已在 Wall 1 的 ground 轨道插入 base_cabinet（15\"）。"
}

event: result
data: {
  "updatedLayout": LayoutDocument,
  "reply": "已完成布局识别。"
}

event: done
data: {}

event: error
data: { "message": "布局识别失败" }
```

## 前端计划

### 1. 提取通用 SSE parser

从 `client/src/components/ChatPanel.tsx` 提取：

- `parseSSEEvents`
- SSE event type 定义
- 可复用 reader 消费函数，或至少复用 parser

文件：`client/src/lib/sse.ts`

```ts
export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

export function parseSSEEvents(buffer: string): {
  events: SSEEvent[];
  remaining: string;
}
```

然后 `ChatPanel.tsx` 和 `ImageUploadPanel.tsx` 都从这里 import。

### 2. 提取通用对话展示组件/Hook

从 `ChatPanel.tsx` 提取以下通用部分：

- `DisplayRole`
- `DisplayMessage`
- tool message 更新逻辑
- `reply_chunk` streaming message 合并逻辑
- `reply_done/done/error` 的基础处理
- 消息列表渲染（Markdown + tool + loading）

建议文件：

- `client/src/components/StreamChatPanel.tsx`
- `client/src/components/StreamChatPanel.css`，或复用现有 `ChatPanel.css` class
- `client/src/hooks/useSSEEventHandler.ts`，逻辑和 UI 分离

主页面 `ChatPanel` 保留 notes、table parse、输入框和历史记录特有逻辑，只改为使用通用 hook/组件。

`LayoutChatPanel` 使用同一套对话消息展示，但不需要 notes。

### 3. 建立 layout 识别事件流到对话面板的通道

选择最小实现：在 `layoutStore` 中增加识别事件 callback，类似 `tableParseStore.setParseEventCallback`。

新增 store 状态/方法：

```ts
recognitionEventCallback: ((event: SSEEvent) => void) | null;
setRecognitionEventCallback: (cb: ((event: SSEEvent) => void) | null) => void;
emitRecognitionEvent: (event: SSEEvent) => void;
```

`LayoutChatPanel` mount 时注册 callback，把事件交给通用 SSE handler，渲染对话。

`ImageUploadPanel` 读取 SSE 时调用 `emitRecognitionEvent(event)`。

### 4. 改造 ImageUploadPanel 为 SSE 消费

文件：`client/src/components/ImageUploadPanel.tsx`

替换当前 JSON 读取：

```ts
const data = await res.json();
onLayoutUpdated(data.updatedLayout);
```

改为：

- `const reader = res.body!.getReader()`
- 使用 `TextDecoder` 和 `parseSSEEvents`
- 对每个事件：
  - 先转发给 layout 对话面板
  - `layout_update`: `onLayoutUpdated(layout)`，并可显示中间状态
  - `result`: `onLayoutUpdated(updatedLayout)`，设置成功消息
  - `done`: `loading=false`
  - `error`: 显示错误，`loading=false`

为了避免最终 `done` 未到导致 loading 卡住，`finally` 仍应兜底 `setLoading(false)`。

### 5. 改造 LayoutChatPanel

文件：`client/src/components/LayoutChatPanel.tsx`

- 去掉占位文案。
- 使用通用对话面板 UI。
- 空态文案类似：`上传 layout 图片后，我会实时显示识别过程和工具调用。`
- 收到识别开始时，可以追加一条 user 消息，例如：`识别当前图片（俯视图）`。这个事件可以由 `ImageUploadPanel` 在提交前 emit 一个本地事件，或仅展示 tool/assistant 流。

### 6. `wp-track-blocks` 实时刷新机制

不需要直接改 `WallPanel`。

链路为：

```txt
SSE layout_update
  -> ImageUploadPanel onLayoutUpdated(layout)
  -> LayoutRecognizePage store.loadLayout(JSON.stringify(layout))
  -> layoutStore.activeLayout 更新并持久化
  -> LayoutCanvas/WallPanel 重新渲染
  -> wp-track-blocks 立即显示新增/修改 block
```

## 验证计划

### 自动验证

- 前端 TypeScript/build。
- 后端 TypeScript/build。
- 如项目已有 lint/test，运行相关命令。

### 手动验证

1. 普通用户登录后进入 `/layout-recognize`。
2. 不使用管理员账号，上传图片并点击识别。
3. 请求不应因 `requireAdmin` 被拒绝。
4. 右侧 layout 对话面板显示工具调用，例如 `正在调用 insertItem`。
5. LLM 每次调用 layout 修改工具后，左侧对应墙的 `wp-track-blocks` 立即出现新 block。
6. 最终完成后显示成功状态。
7. 刷新页面后，layout 仍从 `localStorage` 恢复。
8. 主页面 `ChatPanel` 的表格解析和聊天仍正常显示 streaming/tool 消息。

## 风险与注意事项

- `LayoutAgent.parse` 返回类型变更需同步路由，否则 TypeScript 会报错。
- SSE 中发送完整 layout 快照可能较大，但 layout 数据通常较小，初版可接受。
- 如果 LLM 在同一轮调用多个修改工具，BaseAgent 默认 layout 工具串行执行，逐个发送快照即可。
- 搜索工具可能耗时长，期间只显示 `tool_call`，不会更新 `wp-track-blocks`，这是预期行为。
- 当前图片 data URL 走 JSON body，`express.json({ limit: '20mb' })` 已配置；大图仍可能超过限制，后续可单独优化。
- 普通用户可调用后，LLM 成本暴露给所有登录用户，必要时后续增加频率限制或额度控制。

## 推荐实施顺序

1. 后端去掉 `requireAdmin` 并补齐 `result/layout_update/reply_chunk` SSE。
2. 前端提取 `parseSSEEvents`。
3. 改造 `ImageUploadPanel` 读取 SSE 并实时写入 layout store。
4. 实现 `LayoutChatPanel` 事件展示。
5. 再回头把主页面 `ChatPanel` 的公共 UI/hook 抽干净，降低重复。

这个顺序优先打通端到端功能，再做组件复用收敛，风险最低。
