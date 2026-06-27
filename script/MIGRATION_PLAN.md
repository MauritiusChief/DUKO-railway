# Playwright → ScriptCat 迁移计划

> **目标**：将 Odoo 报价单的填表逻辑从 Playwright 浏览器自动化迁移到 ScriptCat 用户脚本（注入浮动面板到 Odoo 页面）。

---

## 1. 项目概览

本项目的核心业务是：**把客户发来的商品型号（颜色码 + 型号 + 尺寸码），根据预设规则展开为一组零件型号，填入 Odoo ERP 的 quotation 报价单页面。**

项目分为三层：

| 层级 | 目录 | 角色 |
|------|------|------|
| Web 前端 | `web/` | React + Vite, 提供用户交互界面（含 4 个小工具面板） |
| Server | `server/` | Express, 提供 LLM 调用、零件解析、Playwright 浏览器操控 |
| 用户脚本 | 根目录 | rspack 构建的 ScriptCat/Tampermonkey 用户脚本（**目前只有构建骨架，尚未实现**） |

---

## 2. 当前架构：Playwright 浏览器自动化

### 2.1 整体流程

```
用户操作 Web 前端              Server                        Playwright 控制的 Chromium
      │                          │                                     │
  ① 点击"打开浏览器" ──POST /api/browser/open──> chromium.launch() ──> 启动 Chrome
      │                          │                                     │
      │                          │<── 返回 { status, currentUrl }      │
      │                          │                                     │
  ② （用户在 Playwright Chrome 中手动登录 Odoo）                          │
      │                          │                                     │
  ③ 点击"保存登录态" ──POST /api/browser/save-session──> storageState 落盘│
      │                          │                                     │
  ④ 在小工具2号生成零件预览 ──> 解析手动输入/上传 JSON ──> 展开为零件清单   │
      │                          │                                     │
  ⑤ 点击"写入 quotation" ──POST /api/quotation/write──> Playwright 操控  │
      │                          │    quotationTable.ts 填表      ───> 操作 Odoo DOM
      │                          │                                     │
      │<── 返回 { status, writtenParts, unfilledParts, message }        │
```

**关键问题**：整个流程依赖 Playwright 启动的 Chromium 实例一直保持运行且页面必须停留在 Odoo quotation 页面。用户不能关闭浏览器或导航到其他页面。

### 2.2 浏览器管理 (`server/src/playwright/`)

#### 2.2.1 状态管理 (`state.ts:1-46`)

一个模块级单例，维护三个 Playwright 对象的引用：

```typescript
const playwrightState = {
  browser: Browser | null,    // Playwright 启动的 Chromium 实例
  context: BrowserContext | null,  // 浏览器上下文（含登录态）
  page: Page | null,          // 当前活动页面
}
```

提供 getter/setter/clear 三个操作：
- `getBrowser()` / `setBrowser()` — 获取/设置浏览器实例
- `getContext()` / `setContext()` — 获取/设置上下文
- `getPage()` / `setPage()` — 获取/设置页面
- `clearContextAndPage()` — 清空上下文和页面引用
- `clearBrowserState()` — 清空全部（浏览器关闭时调用）

#### 2.2.2 浏览器生命周期 (`browser.ts:1-189`)

**打开浏览器** (`openBrowser`, line 21-45)：

1. 先尝试复用已有页面 (`getReusablePage`) — 从已有 context.pages() 中选一个未关闭的
2. 如果页面还存在 → `bringToFront()` → 返回 `status: 'reused'`
3. 如果没有页面 → 确保浏览器上下文存在 (`ensureBrowserContext`) → 创建新页 → `page.goto(playwrightBaseUrl)` → 返回 `status: 'opened'`

**确保浏览器上下文** (`ensureBrowserContext`, line 80-112)：

1. 检查 browser 是否还连着 → 不连则 `chromium.launch({ headless: false })` 启动新实例
2. 检查 context 是否存在 → 不存在则创建：
   - 先尝试读取 `storageStatePath`（如果存在 .playwright/storage-state.json）
   - 加载时如果文件损坏，自动回退到无状态模式
3. 注册 `context.on('close')` 回调清理引用

**保存登录态** (`saveSession`, line 51-65)：

- 调 `context.storageState({ path })` 把 cookies/localStorage 落盘
- 返回保存路径

**获取可复用页面** (`getReusablePage`, line 119-137)：

- 先从缓存 `cachedPage` 找 → 没关闭就直接用
- 再从 `context.pages()` 找最后一个未关闭的页面
- 用来防止用户手动关掉标签页后引用失效

**获取必需页面** (`getRequiredPage`, line 139-148)：

- 业务方调这个 → 没有页面直接抛错（提示用户先打开浏览器）

### 2.3 填表核心逻辑 (`server/src/playwright/quotationTable.ts`)

**这是本次迁移最关键的代码，共 240 行，定义了 9 个 Odoo CSS 选择器 + 8 个操作函数。**

#### 2.3.1 CSS 选择器常量 (line 3-16)

| 常量 | CSS 选择器 | 用途 |
|------|-----------|------|
| `QUOTATION_TABLE_SELECTOR` | `div.o_field_widget.o_field_section_and_note_one2many table.o_section_and_note_list_view` | 定位 Odoo quotation 主表格 |
| `QUOTATION_DATA_ROW_SELECTOR` | `tbody tr.o_data_row` | 所有业务数据行（非操作行、非空白行） |
| `QUOTATION_SELECTED_ROW_SELECTOR` | `tbody tr.o_data_row.o_selected_row` | 当前被选中的编辑行 |
| `PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR` | `td.o_sol_product_many2one_cell input.o-autocomplete--input` | 产品型号 autocomplete 输入框 |
| `PRODUCT_AUTOCOMPLETE_MENU_SELECTOR` | `td.o_sol_product_many2one_cell ul.o-autocomplete--dropdown-menu` | autocomplete 下拉菜单容器 |
| `PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR` | `td.o_sol_product_many2one_cell li.o-autocomplete--dropdown-item a.dropdown-item` | 下拉菜单的具体选项 |
| `EDITABLE_QUANTITY_INPUT_SELECTOR` | `td.o_data_cell.o_field_cell.o_list_number.o_required_modifier:not(.o_readonly_modifier) input.o_input` | 可编辑的数量输入框（排除只读态） |
| `ADD_PRODUCT_LINK_SELECTOR` | `tbody a:has-text("Add a product")` | "Add a product" 添加行链接 |
| `REMOVE_ROW_BUTTON_SELECTOR` | `td.o_list_record_remove button.fa-trash-o` | 行删除按钮 |

#### 2.3.2 操作函数详解

**`ensureQuotationTableReady(page)` (line 22-29)**

前置条件检查：等待表格出现在页面中并可见，超时 10 秒。所有填表操作都依赖这个。

**`getQuotationDataRows(page)` (line 35-47)**

读取已有数据行：
1. 先调 `ensureQuotationTableReady`
2. 用 `QUOTATION_DATA_ROW_SELECTOR` 查所有 `o_data_row` 行
3. 对每条行用 `.nth(index)` 逐个获取 Locator 引用，返回数组

**`removeAllQuotationRows(page)` (line 53-76)**

清空所有数据行（循环删除）：
1. `while(true)` 循环
2. 每次查当前 `o_data_row` 数量
3. 如果 `currentCount === 0` 则 return
4. 取第一行的删除按钮 → `.click()`
5. 用 `page.waitForFunction` 等待行数减 1（确保 Odoo 异步 DOM 刷新完成后再删下一条）

**`removeQuotationRow(rowLocator)` (line 82-86)**

删除单行（不等待表格变化），用于 autocomplete 超时后清理无效空行。

**`addNewEditableRow(page)` (line 93-105)**

添加新行：
1. 记录当前 `o_data_row` 数量
2. 点击 "Add a product" 链接
3. 等待新行出现（`.nth(beforeCount).waitFor({ state: 'attached' })`）
4. 返回当前被选中的编辑行 (`getSelectedEditableRow`)

**`getSelectedEditableRow(page)` (line 143-155)**

获取当前编辑行：查 `QUOTATION_SELECTED_ROW_SELECTOR` → 等待可见 → 返回 Locator

**`fillProductAndChooseFromMenu(rowLocator, targetPartModel)` (line 162-218)**

**这是最复杂的操作——产品型号填入（含 autocomplete 交互）**：

1. 在当前行内定位 autocomplete 输入框
2. 等待输入框可见
3. `editableInput.fill(targetPartModel)` — 输入完整零件型号（触发 Odoo 后端 autocomplete 查询）
4. 等待下拉菜单出现（超时 10 秒 — 超时则 catch，返回 `false` 表示该型号未匹配到）
5. 在下拉菜单中查找匹配项：`.filter({ hasText: targetPartModel })` — 用"包含"匹配（因为下拉项文本可能除了型号外还有描述）
6. 等待匹配项可见（超时 10 秒 — 超时同样返回 `false`）
7. `matchedMenuItem.click()` — 点击选中
8. 返回 `true` 表示成功

**`fillSelectedRowQuantity(rowLocator, quantity)` (line 224-239)**

填入数量：
1. 定位可编辑数量输入框
2. 等待可见
3. `editableInput.fill(String(quantity))`
4. `editableInput.press('Enter')` — 按回车提交（Odoo 行编辑依赖 Enter 确认）

#### 2.3.3 未使用的辅助函数

两个已实现但当前未使用的函数：
- `waitForNoSelectedEditableRow(page)` (line 113-118) — 等待所有 selected row 消失
- `exitSelectedRowByAddProductAndEscape(page)` (line 126-137) — 通过点击 Add product + Escape 退出编辑状态

### 2.4 写入编排 (`server/src/playwright/quotationWrite.ts`)

`writeGeneratedPartsToQuotation(input)` (line 23-75) 是真实写表的入口：

```
1. getRequiredPage()        → 获取页面
2. ensureQuotationTableReady → 确认表格就绪
3. if clearExistingRows     → removeAllQuotationRows (逐条删除)
4. for each part in parts:
   a. addNewEditableRow    → 新增一行
   b. fillProductAndChooseFromMenu → 填产品，失败则 removeQuotationRow + 记录到 unfilledParts
   c. fillSelectedRowQuantity      → 填数量
   d. page.locator(SELECT_CANCELLING).click() → 点击标题区域失焦，避免影响下一行
5. 返回 { status, message, writtenParts, unfilledParts }
```

`SELECT_CANCELLING` 是一个特殊的 CSS 选择器：
```
h1 > div.o_field_widget.o_readonly_modifier.o_required_modifier > span
```
点击这个元素的目的是让当前编辑行退出 `o_selected_row` 状态——否则下一次 "Add a product" 可能不会正确插入新行。

### 2.5 读取已有行 (`server/src/playwright/quotationRead.ts`)

`readQuotationLinesSummary()` (line 17-47)：
1. 获取已有数据行
2. 对每行：
   - 点击 `SELECT_CANCELLING` 取消选中状态（避免影响下一行读取）
   - `readProductModelFromRow` — 读 `td.o_sol_product_many2one_cell` 的文本内容
   - `readUnitPriceFromRow` — 读 `td.o_field_cell.o_list_number` 的价格文本
3. 返回 `{ lines: QuotationLineSummary[], warningMessage: string }`

### 2.6 DOM Tree 提取 (`server/src/playwright/domTree.ts`)

用于调试——读取 Odoo 页面指定区域的 DOM 树结构：

- 入口 `readDomTree()` (line 53-77)
- 提取脚本在 `server/browser-scripts/extractDomTree.js`，通过 `page.addScriptTag({ path })` 注入
- 注入后挂载 `window.__DUKO_extractDomTree`
- 通过 `page.evaluate(() => window.__DUKO_extractDomTree!(options))` 调用
- 限制参数：maxDepth=32, maxChildrenPerNode=160, maxDirectTextLength=640
- 默认只提取 `.o_form_sheet` 内部的 DOM 树
- 忽略 script、style、noscript、meta、link、template 标签

**本次迁移不涉及这部分**（用户已确认先不迁移 DOM Tree 功能）。

### 2.7 通信链路

```
Web 前端 (localhost:5174)           Server (localhost:3001)         Playwright Chrome
        │                                  │                              │
   BrowserControlPanel                      │                              │
   ├─ 打开浏览器 ── POST /api/browser/open ──> openBrowser() ──────────> 启动/复用
   ├─ 保存登录态 ── POST /api/browser/save-session ──> saveSession() ──> storageState
   └─ 读取DOM Tree ── GET /api/browser/dom-tree ──> readDomTree() ────> evaluate
        │                                  │
   Tool2Panel                              │
   ├─ 解析输入 ── POST /api/quotation/preview-manual ──> 预览（纯计算，不涉Playwright）
   ├─ 上传JSON ── POST /api/quotation/preview-upload ──> 预览（纯计算）
   └─ 写入 ── POST /api/quotation/write ──> writeGeneratedPartsToQuotation() ──> 填表
        │                                  │
   Tool3Panel                              │
   └─ 读取 ── GET /api/quotation/read-lines ──> readQuotationLinesSummary() ──> 读表
```

### 2.8 类型系统

`server/src/playwright/types.ts` 定义了 Playwright 相关的所有请求/响应类型：

| 类型 | 用途 |
|------|------|
| `BrowserOpenResult` | `{ status: 'opened'\|'reused', currentUrl }` |
| `SessionSaveResult` | `{ status: 'saved', storageStatePath }` |
| `DomTreeResult` | `{ title, currentUrl, tree: DomTreeNode }` |
| `QuotationWritePayload` | `{ writtenParts: WrittenPart[], clearExistingRows, sourceLabel?, uploadedFileName? }` |
| `QuotationWriteResult` | `{ status: 'added-new'\|'rebuilt-all', message, writtenParts, unfilledParts }` |
| `WrittenPart` | `{ partModel: string, quantity: number }` |
| `QuotationLineSummary` | `{ productModel, unitPrice }` |
| `QuotationReadResult` | `{ lines: QuotationLineSummary[], warningMessage }` |

前端 `web/src/types.ts` 有几乎相同的副本（为前后端分离设计）。

### 2.9 环境变量

(`server/.env`)

```
PORT=3001
PLAYWRIGHT_BASE_URL=https://dukouserp.com/odoo/sales/new
PLAYWRIGHT_STORAGE_STATE_PATH=.playwright/storage-state.json
```

`playwrightBaseUrl` 是 Playwright 启动后自动导航的入口 URL（Odoo quotation 新建页面）。

---

## 3. 目标架构：ScriptCat 用户脚本

### 3.1 整体流程

```
Web 前端 (localhost:5174)          Server (localhost:3001)          用户浏览器 (Odoo 页面)
        │                                │                                │
   Tool2Panel 生成零件预览                 │                                │
   ├─ 解析输入/上传 JSON ──> 展开为零件清单  │                                │
   │                                │                                │
   点击"暂存待写入"                      │                                │
   ── POST /api/quotation/stage ──>  存在内存队列                       │
        │                                │                                │
        │                          ┌──────────────────┐                  │
        │                          │  浮动面板（脚本注入）│                  │
        │                          │  [一键写入] ←─── 用户点击            │
        │                          └──────────────────┘                  │
        │                                │                                │
        │                          GET /api/quotation/pending ──>         │
        │                          <── 返回暂存的零件数据                  │
        │                                │                                │
        │                          脚本操作 Odoo Page DOM：               │
        │                          addRow → fillProduct → fillQuantity    │
        │                                │                                │
        │                          POST /api/quotation/write-result ──>   │
        │                                │                                │
        │<── GET /api/quotation/status ─>│                                │
        │<── 返回结果 { writtenParts, unfilledParts, ... }
```

**关键变化**：

- ❌ 不再需要 Playwright 启动 Chromium
- ❌ 不再需要 `POST /api/browser/open`、`POST /api/browser/save-session`
- ❌ 不再需要用户在两处浏览器之间切换
- ✅ 用户在**自己的正常浏览器**中打开 Odoo，ScriptCat 自动注入脚本
- ✅ 填表操作由脚本直接操作 DOM，不经过 Playwright
- ✅ Web 前端先"暂存"数据，浮动面板再"拉取并执行"

### 3.2 脚本目录结构

根目录下新建 `script/` 文件夹：

```
script/
├── index.ts            # 入口文件：页面匹配 → 初始化浮动面板 → 绑定事件
├── selectors.ts        # CSS 选择器常量（从 quotationTable.ts 迁入，一字不改）
├── waiters.ts          # DOM 等待工具函数
├── quotation.ts        # 填表核心逻辑（对 quotationTable.ts 的浏览器端重写）
├── panel.ts            # 浮动面板 UI 注入
├── communicator.ts     # GM_xmlhttpRequest 封装，与 server 通信
└── types.ts            # 命令/响应类型定义
```

各文件职责：

#### `index.ts` — 入口

```typescript
// 检查 URL 是否匹配 Odoo quotation 页面
// 如果是 → 注入浮动面板（panel.ts）
// 给面板按钮绑定事件 → 调 communicator → 调 quotation 核心函数
```

该文件在 rspack.config.js 中作为 `entry`。

#### `selectors.ts` — CSS 选择器

从 `quotationTable.ts:3-16` 直接复制 9 个常量，不做任何修改。

#### `waiters.ts` — 等待工具

替代 Playwright 的 `waitFor(state)` 和 `waitForFunction`：

```typescript
// 等待某个 CSS 选择器在 DOM 中出现且可见
function waitForSelector(selector: string, timeout?: number): Promise<Element>

// 等待某个元素从 DOM 中消失
function waitForElementRemoved(selector: string, timeout?: number): Promise<void>

// 等待某个元素的文本内容包含指定字符串
function waitForText(selector: string, text: string, timeout?: number): Promise<boolean>
```

实现方式：用 `MutationObserver` 监听 DOM 变化 + `requestAnimationFrame` 轮询 + `setTimeout` 超时，包装成 Promise。

#### `quotation.ts` — 填表核心

对 `quotationTable.ts` 的逐函数浏览器端重写：

| Playwright 原函数 | 脚本对应函数 | 关键差异 |
|---|---|---|
| `ensureQuotationTableReady(page)` | `ensureTableReady()` | `document.querySelector` 替代 `page.locator`，等待由 `waitForSelector` 实现 |
| `getQuotationDataRows(page)` | `getDataRows()` | `querySelectorAll` 替代 `page.locator`，返回 `Element[]` 而非 `Locator[]` |
| `removeAllQuotationRows(page)` | `removeAllRows()` | `element.click()` 替代 `locator.click()`，等待改用 `waitForElementRemoved` |
| `addNewEditableRow(page)` | `addNewRow()` | 同上，等待改用 `waitForSelector` |
| `fillProductAndChooseFromMenu(row, model)` | `fillProduct(model)` | `input.value + dispatchEvent(InputEvent)` 替代 `locator.fill()`，菜单点击用原生 click |
| `fillSelectedRowQuantity(row, qty)` | `fillQuantity(qty)` | `input.value + dispatchEvent(InputEvent)` + `dispatchEvent(KeyboardEvent('Enter'))` |
| `getSelectedEditableRow(page)` | `getSelectedRow()` | `querySelector` 替代 `page.locator` |

**最大风险：autocomplete 事件触发**

Odoo 的 autocomplete 下拉菜单可能依赖框架级别的 input 事件（Odoo Web Client 自研 JS 框架），单纯设置 `input.value = 'xxx'` 可能不会触发查询。需要渐进尝试以下方案：

```
方案A：
  input.value = model
  input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))

方案B（如果方案A无效）：
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, 'value'
  )!.set!
  nativeSetter.call(input, model)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

方案C：
  上面的都不行，需要在 Odoo 页面控制台逐步调试，
  找到 Odoo 框架内部绑定的具体事件处理器。
```

这一步**必须在 Odoo 真实页面环境中实测后才能确定最终方案**。

#### `panel.ts` — 浮动面板

```
┌──────────────────────────┐
│  Quote Filler     [_][X] │
├──────────────────────────┤
│  ● 已连接                 │
│  待写入：0 个零件          │  ← 显示当前暂存数据的摘要
├──────────────────────────┤
│  [ 一键写入 ]             │  ← 点击后：GET pending → 填表 → POST result
├──────────────────────────┤
│  结果：未执行              │  ← 显示上次操作的状态/结果
└──────────────────────────┘
```

技术实现：
- 用 `GM_addStyle`（已 grant）注入面板 CSS
- 面板 DOM 直接 `document.body.appendChild`
- 拖拽：mousedown/mousemove/mouseup 事件
- 最小化：折叠到一个小图标（点击展开）
- 状态文本实时更新（已连接 / 正在写入 / 写入完成 / 发生错误）
- 面板 `z-index` 足够高以覆盖 Odoo 原有 UI
- 只在 Odoo quotation 页面显示（index.ts 中判断 URL）

#### `communicator.ts` — 通信层

```typescript
// 把 GM_xmlhttpRequest 的 callback 包装成 Promise
function apiGet<T>(path: string): Promise<T>
function apiPost<T>(path: string, body?: unknown): Promise<T>
```

支持的 API 端点（全部指向 `http://localhost:3001`）：
- `GET /api/quotation/pending` → 获取暂存的待写入数据
- `POST /api/quotation/write-result` → 上报写入结果

#### `types.ts` — 类型

```typescript
interface WrittenPart {
  partModel: string
  quantity: number
}

interface PendingWriteData {
  taskId: string
  writtenParts: WrittenPart[]
  clearExistingRows: boolean
  sourceLabel?: string
}

interface WriteResult {
  status: 'added-new' | 'rebuilt-all'
  message: string
  writtenParts: WrittenPart[]
  unfilledParts: WrittenPart[]
}
```

### 3.3 通信协议

脚本与 Server 之间采用**请求-响应模式**（非轮询）：

1. **用户点击浮动面板的"一键写入"按钮**
2. 脚本 `GET /api/quotation/pending`
3. Server 返回当前暂存的待写入数据（`PendingWriteData`）或 `{ none: true }`
4. 脚本拿到数据后，调用 `quotation.ts` 中的函数逐条填表
5. 填完后 `POST /api/quotation/write-result` 上报结果
6. Server 返回 `{ ok: true }`

Web 前端与 Server 之间：

1. **Tool2Panel 点击"暂存待写入"** → `POST /api/quotation/stage` → Server 存到内存队列
2. **Tool2Panel 轮询结果** → `GET /api/quotation/status` → 返回 `{ status: 'pending' | 'completed' | 'failed', result? }`

### 3.4 Server 改造

#### 内存任务队列

```typescript
// server/src/ 中新增，模块级变量（单用户场景，不需要持久化）
interface PendingWriteTask {
  taskId: string
  writtenParts: WrittenPart[]
  clearExistingRows: boolean
  sourceLabel?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdAt: number
  result?: {
    writtenParts: WrittenPart[]
    unfilledParts: WrittenPart[]
    message: string
  }
}

let pendingTask: PendingWriteTask | null = null
```

#### 新增端点

| 端点 | 方法 | 调用方 | 说明 |
|------|------|--------|------|
| `/api/quotation/stage` | POST | Web 前端 | 暂存待写入数据（body: `{ writtenParts, clearExistingRows, sourceLabel? }`） |
| `/api/quotation/pending` | GET | 脚本 | 获取暂存数据，状态改为 `in_progress` |
| `/api/quotation/write-result` | POST | 脚本 | 上报写入结果（body: `WriteResult`），状态改为 `completed` |
| `/api/quotation/status` | GET | Web 前端 | 查询当前任务状态 |

#### 停用/保留的旧端点

| 端点 | 处理方式 |
|------|----------|
| `POST /api/quotation/write` | 保留在 `index.ts` 中但注释掉调用，改为调 `stage` |
| `GET /api/quotation/read-lines` | 同上（本阶段不迁移读取功能） |
| `POST /api/browser/open` | 保留代码注释掉 |
| `POST /api/browser/save-session` | 同上 |
| `GET /api/browser/dom-tree` | 同上 |

`server/src/playwright/` 整个目录保留不动，在 `index.ts` 中注释掉相关 import。

`server/package.json` 中 `playwright` 依赖保留不删。

### 3.5 构建配置改动

`rspack.config.js` 修改：

```javascript
// 改变前
entry: './src/index.ts',
// 改变后
entry: './script/index.ts',

// 改变前
@match        https://*/*
@exclude      https://www.linkedin.com/*
// 改变后
@match        https://dukouserp.com/odoo/*
// （移除 @exclude）
```

根目录空的 `src/` 目录可以删除（当前不存在 `src/index.ts`）。

---

## 4. 迁移步骤

### 第一步：创建 `script/` 目录，搬运选择器

**产出**：`script/selectors.ts`

- 从 `server/src/playwright/quotationTable.ts:3-16` 复制 9 个 CSS 选择器常量
- 完全不修改，确保和 Playwright 版一致

### 第二步：实现 DOM 等待工具

**产出**：`script/waiters.ts`

- 实现 `waitForSelector(selector, timeout)` → 轮询 `document.querySelector` + `MutationObserver`
- 实现 `waitForElementRemoved(selector, timeout)` → 等待元素从 DOM 消失
- 实现 `waitForText(selector, text, timeout)` → 等待文本内容包含指定字符串

### 第三步：实现填表核心

**产出**：`script/quotation.ts`

- `ensureTableReady()` — 等待表格可见
- `getDataRows()` — 获取所有 `o_data_row` 元素
- `removeAllRows()` — 循环删除所有行
- `removeRow(row)` — 删除单行
- `addNewRow()` — 点击 "Add a product" → 等待新行出现 → 返回编辑行
- `fillProduct(model)` — 输入型号 → 等待下拉 → 点击匹配项
- `fillQuantity(qty)` — 输入数量 → 按 Enter
- `getSelectedRow()` — 获取当前编辑行

**风险点**：autocomplete 触发需要在真实 Odoo 页面调试确定方案。

### 第四步：实现通信层

**产出**：`script/communicator.ts`

- 封装 `GM_xmlhttpRequest` 为 Promise 风格
- 提供 `apiGet` 和 `apiPost` 函数
- 默认指向 `http://localhost:3001`

### 第五步：实现浮动面板

**产出**：`script/panel.ts`

- 用 `GM_addStyle` 注入面板 CSS
- 构建面板 DOM 并附加到 `document.body`
- 实现拖拽、最小化
- 按钮绑定：点击 → 调 communicator 获取数据 → 调 quotation 执行填表 → 调 communicator 上报结果
- 状态文本实时更新

### 第六步：实现入口文件

**产出**：`script/index.ts`

- 检查当前 URL 是否在 Odoo quotation 页面
- 如果是 → 调 `initPanel()` 初始化浮动面板

### 第七步：创建类型文件

**产出**：`script/types.ts`

- 定义 `WrittenPart`、`PendingWriteData`、`WriteResult` 等共享类型

### 第八步：修改 rspack 配置

**产出**：修改 `rspack.config.js`

- `entry` 改为 `./script/index.ts`
- `@match` 改为 `https://dukouserp.com/odoo/*`
- 移除 `@exclude`

### 第九步：Server 新增端点

**产出**：修改 `server/src/index.ts`

- 新增内存任务队列
- 新增 4 个端点（stage / pending / write-result / status）
- 注释掉旧的 Playwright 相关 import 和端点

### 第十步：前端适配

**产出**：修改 `web/src/`

- `Tool2Panel` 的"写入 quotation"按钮改为"暂存待写入"（调 `POST /api/quotation/stage`）
- 新增轮询逻辑：暂存后轮询 `GET /api/quotation/status` 直到完成
- `Tool3Panel` 的"读取已填内容"按钮暂时保留但显示"该功能暂不可用"（本阶段不迁移读取功能）
- `BrowserControlPanel` 的三个按钮（打开浏览器 / 保存登录态 / 读取 DOM Tree）标记为弃用或隐藏

### 第十一步：构建与测试

- 运行 `npm run build`（在根目录）→ 产物 `apply-smash.user.js`
- 在 ScriptCat 中安装该脚本
- 打开 Odoo quotation 页面 → 验证浮动面板出现
- 完整端到端测试：前端暂存 → 浮动面板写入 → 查看结果

---

## 5. 风险点

| 风险 | 严重程度 | 缓解措施 |
|------|----------|----------|
| Odoo autocomplete 不响应原生 input 事件 | **高** | 在 Odoo 页面控制台逐步调试，可能需要研究 Odoo Web Client 的框架事件机制 |
| Odoo 页面的动态 DOM 结构与开发时不同 | 中 | 选择器已在 Playwright 版本验证过，迁移时保持完全一致 |
| 浮动面板被 Odoo CSS 覆盖样式 | 低 | 使用高特异性选择器 + z-index 隔离 |
| 多个 Odoo 标签页同时打开导致脚本多次执行 | 低 | 在 `index.ts` 中检查是否已有面板实例 |
| Web 前端与脚本之间的并发问题（同时暂存多次） | 低 | 任务队列只存一个任务，新的会覆盖旧的 |

---

## 6. 文件变更清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `script/index.ts` | 脚本入口 |
| `script/selectors.ts` | CSS 选择器常量 |
| `script/waiters.ts` | DOM 等待工具 |
| `script/quotation.ts` | 填表核心逻辑 |
| `script/panel.ts` | 浮动面板 UI |
| `script/communicator.ts` | 通信层 |
| `script/types.ts` | 类型定义 |
| `MIGRATION_PLAN.md` | 本文档 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `rspack.config.js` | 改 entry、改 @match、移除 @exclude |
| `server/src/index.ts` | 新增 4 个端点、注释旧 Playwright 端点 |
| `web/src/api.ts` | 新增 `stageQuotation`、`getQuotationStatus` API 函数 |
| `web/src/App.tsx` | 修改 `handleWriteQuotation` 逻辑（暂存+轮询）、弃用 `handleOpenBrowser`/`handleSaveSession`/`handleReadDomTree`/`handleReadQuotationLines` |
| `web/src/components/Tool2Panel.tsx` | "写入 quotation" 按钮改为"暂存待写入" |
| `web/src/components/BrowserControlPanel.tsx` | 按钮标记弃用 |
| `web/src/components/Tool3Panel.tsx` | 按钮标记暂不可用 |
| `web/src/types.ts` | 新增 `StageWriteRequest` 等类型 |

### 保留不动

| 目录/文件 | 说明 |
|------|------|
| `server/src/playwright/` | 整个目录保留，注释标记 @deprecated |
| `server/package.json` | playwright 依赖保留 |
| `server/browser-scripts/extractDomTree.js` | 保留不动（DOM Tree 暂不迁移） |
| `server/.env` | 保留，Playwright 相关环境变量可不删 |
| `server/.env.example` | 同上 |
