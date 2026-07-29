# 清单解析与对话

## 页面组成

`client/src/pages/TableParsePage.tsx` 是登录后的主页：左上为文本/图片输入和颜色提示，左下为解析结果与产品清单，右侧为 `client/src/components/ChatPanel.tsx`。三个分隔条只改变当前组件内的布局比例，不做持久化。

文本模式支持 `Ctrl/Cmd+Enter` 解析。图片模式支持选择、粘贴、拖入和多图追加；浏览器先把每张图片缩放到最长边不超过 1536，并转为 JPEG quality 0.6 的 data URL，再发送服务端。成功后图片 Agent 的文本结果会回填文本框并切回文本模式，用户需要再次触发文本解析。

颜色提示来自服务端引用数据，作为 Agent 上下文而不是强制过滤器。解析表字段包括原始名称、颜色、形状型号、形状尺寸、定制要求、数量和删除操作。

## 解析与编辑状态

核心状态在 `client/src/stores/tableParseStore.ts`：

- 解析字段只有一个值时直接可编辑；多个值时要求用户选择候选或自填；无值时显示未知输入。
- 用户编辑字段后，该字段被收敛为单值。字段失焦会批量检查当前颜色/型号/尺寸组合是否存在于 Exposed Items。
- GD/TCR 可忽略颜色；GD/CBL/TUK/SD 可忽略尺寸。忽略规则同时影响警告样式、组合校验和产品生成。
- 当前 items 自动覆盖保存到 `localStorage` 的 `duko_parsed_data`，刷新后恢复；原始输入、颜色勾选和产品结果本身不随该 key 恢复。
- Exposed 组合查询结果只在当前 JS 会话的 Map 中缓存，刷新即清空。

页面还支持把 items 下载为 `duko-archive-<时间>.json`，并加载数组形式或带 `items` 数组的 JSON。该文件只恢复解析表，不恢复对话、输入或产品。

## SSE 解析流

文本解析调用由 `server/src/routes/tableParse.ts` 实现；图片转文字由 `server/src/routes/imageParse.ts` 实现。两者都是认证后的 POST + SSE 响应。事件包含 Agent 轮次、工具调用、流式回复、结构化结果、完成与错误，前端只依赖这些稳定事件类别，不应把 Agent 内部逐工具顺序当成协议。

`tableParseStore` 通过回调把解析流转发给 `ChatPanel`，所以主解析过程也显示在右侧对话区域。服务端在文本解析成功后自动保存一条用户历史，内容包括输入、颜色提示、items 和解析会话摘要。

## 产品清单

“生成产品清单”是普通 REST 请求，不调用 LLM。服务端在 `server/src/routes/tableParse.ts` 中：

- 跳过未收敛的必填字段，并返回未解析行索引。
- 根据 items/parts 引用表拆解复合物品，按 shared part 聚合数量。
- `door` 仅取门件，`box` 仅取柜体，未指定时取门件、柜体和额外件。
- 非配件排在前，配件排在后，各组按产品名排序。

产品可复制为 `productName,quantity` CSV，也可写入报价草稿并跳转报价页。后者使用 `duko_quotation_draft`，不会直接创建任务。

主页的“下载脚本”获取构建后的 Odoo 用户脚本。该脚本和报价任务 worker 是两套不同操作路径。

## 对话与笔记

`ChatPanel` 把当前 items、products、短对话历史、初始输入、颜色提示和笔记提交给 `server/src/routes/chat.ts`。ChatAgent 可以搜索 SKU、编辑清单/产品并更新笔记；结构化结果返回后写回对应 store。

服务端限制传回的多轮上下文为最多 8 对 user/assistant 文本。仅当 Agent 对 items 产生实质变更时，服务端额外保存解析历史。个人笔记最终通过 `/api/notes` 按用户保存在 `users.sqlite`；客户端也使用本地笔记缓存作为解析请求上下文，因此调试时要同时考虑浏览器缓存和服务端笔记。

历史页“填充回主页”会恢复 input、颜色、items 和 conversation，之后由 ChatPanel 消费待填充会话。它不会恢复当时图片、产品清单或页面分栏比例。

## 注意点

- 图片清单是“图片 -> 可编辑文本 -> 结构化表”两步，不是一次调用直接得到最终产品。
- base64 图片进入 JSON 请求，受 Express 20 MB body 限制；多图和大图仍可能超限。
- 当前解析 items 是浏览器级单 key，不按登录用户隔离；同一浏览器切换账号时可能看到上一账号本地表格。
- 候选值必须显式选择；仅看到候选并不等于字段已确认。
- 生成产品后继续修改/删除表格可能使现有产品失效；删除会清空产品，但普通字段编辑不会自动重新生成。
- 历史由服务端自动新增而非更新原记录，每用户最多保留 200 条。
