# 布局识别

## 页面与数据模型

`client/src/pages/LayoutRecognizePage.tsx` 由图片识别、物料清单、布局画布和对话区组成。客户端只维护一个当前 `LayoutDocument`，状态与编辑算法位于 `client/src/stores/layoutStore.ts`，自动保存到 `localStorage` 的 `duko_layout`。

布局包含若干 wall；“墙面/岛台”在内部统一使用 wall 表示。每面墙有宽度、左右/背面暴露标记、连接关系以及 air/ground 两条有序 block 轨道。block 有宽度、颜色和一个或多个 item；高柜、高电器在双轨使用相同 item id 联动。

页面支持新建、JSON 导入/导出和手工添加墙。新建会直接替换当前本地布局；导入只做基础结构检查，导出文件名为 `duko-layout-<时间>.json`。

## 图片识别

`client/src/components/ImageUploadPanel.tsx` 接受单张粘贴、拖入或选择的图片，并要求选择正视、俯视或 3D 视图；还可关联已有墙。图片只存在于组件内，不进入布局持久化。

请求把图片、视图、关联墙 ID 和当前完整布局发送到 `server/src/routes/layoutParseImage.ts`：

1. LayoutOcrAgent 使用 OpenRouter 视觉模型把图片转成双轨文字描述。
2. LayoutAgent 使用 DeepSeek 文本模型和布局、SKU 搜索、委派工具增量修改布局。
3. 每次工具修改可通过 SSE `layout_update` 推送快照，最终以 result 返回完整 updatedLayout。
4. 客户端收到快照后通过 `loadLayout` 覆盖当前布局并立即写 `localStorage`；过程事件同步显示在 `LayoutChatPanel`。

因此识别不是纯 OCR 展示，而是会改变当前布局。提交前需要确认当前布局和关联墙选择；不存在独立的服务端布局版本或撤销栈。

## 手工编辑

画布实现集中在 `client/src/components/LayoutCanvas.tsx`、`WallPanel.tsx`、`BlockInfoBar.tsx` 和 `layoutStore.ts`：

- 墙可重命名、改总宽、设置暴露面、折叠或删除。
- air/ground 轨道可添加适用分类、SKU、宽高、颜色和叠放吊柜；地柜可标记 vanity。
- block 可选中编辑 SKU、宽度、高度、颜色、距左位置和叠放项。
- 删除支持动态删除或用同宽 gap 静态替换。
- 鼠标拖拽按块边界吸附重排；精确位置编辑使用推挤/gap 算法。
- 高柜和高电器双轨联动，store 会尝试保持两轨距左位置一致。
- 若精确移动后的轨道总长超过墙宽，墙宽会自动扩展；普通追加和部分手工修改不应被理解为完整几何约束求解器。

连接墙和背靠背岛台关系在当前 UI 中主要只读显示，由 Agent 管理。

## 物料清单

“生成完整清单”把当前布局发给 `server/src/routes/layoutGenerateList.ts`。这是 `server/src/services/layout-material-list.ts` 中的确定性算法，不调用 LLM；返回文本、按长度计算的明细和警告。结果只在页面组件 state 中，刷新不会恢复，但可复制到剪贴板。

算法覆盖柜体、配件、台面/饰面、暴露边、gap/filler、vanity、电器和叠放等规则，具体事实以服务及 `server/src/services/layout-material-list.test.ts` 为准，不应在客户端复制另一套计算逻辑。

## 注意点

- 布局是浏览器级单 key，不按用户隔离，也不写服务端历史；需要长期保留时导出 JSON。
- 新建、导入和 Agent SSE 快照都可能整体替换当前布局，没有内置 undo/redo。
- 图片请求未做清单页同样的 canvas 压缩，原始 data URL 可能触及 20 MB 请求限制。
- 识别同时依赖 OpenRouter 与 DeepSeek；缺任一 key 都会失败，手工编辑和纯算法物料生成不依赖这两个请求。
- 轨道数组顺序决定距左位置；直接手改导入 JSON 时必须保持双轨共享 item id 和数据结构一致。
- 页面路由存在，但主页当前没有布局入口按钮，可能需要直接访问 `/layout-recognize`。
