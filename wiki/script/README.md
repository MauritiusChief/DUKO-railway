# 手工 CSV 销售／采购填入器

`script/` 从一套共享代码生成销售和采购两份独立的 Tampermonkey/ScriptCat 用户脚本，用于人在 Odoo 页面上粘贴 CSV 并逐行填入产品与数量。它不是 auto worker，也不连接 DUKO server 的 API、SSE 或 WebSocket。

## 使用模型

销售脚本只匹配 `https://dukouserp.com/odoo/sales` 及其子路径；采购脚本只匹配 `https://dukouserp.com/odoo/purchase` 及其子路径。用户粘贴 CSV、在页面上确认操作，脚本直接通过浏览器 DOM 驱动当前已登录的 Odoo 页面：

- 销售接受 `productName,quantity[,discount]`；折扣为百分数，空值不触碰 Odoo 折扣。采购只使用型号和数量，直接忽略第三列，不报错、不提示，预览也不显示折扣。
- 在当前可见的 `order_line` 表格内读取已有行、添加产品、选择 autocomplete 结果、填写并提交；排除隐藏表格和弹窗，有多个目标表格时拒绝猜测。
- 销售使用 `product_uom_qty`，采购使用 `product_qty`。销售先填写数量、再按需填写折扣并提交；Odoo 修改数量会清空当前行已填折扣，因此折扣不能先于数量填写。采购单价和单位由 Odoo 选定产品后自动带出。
- 对找不到的产品进行清理并汇总未填项目。
- 提交后确认行仍存在、产品非空、数量及指定的销售折扣正确，才计为成功；缺少必要输入框或提交超时会计为失败。
- 覆写沿用现有语义：保留匹配产品行，删除不在输入中的产品，追加缺失型号；销售还比较指定折扣。保留行的数量不会重新同步。

页面路径来自单一配置，metadata 和运行时使用相同规则；写入前及逐行操作都会检查路径和表格状态。Odoo 单页导航跨模块后，若目标脚本未加载或旧面板仍存在，请刷新页面。

它依赖当前 Odoo DOM 选择器和用户已有登录态。没有 server 任务记录、远程确认、断线重试、SQLite 持久化或库存 worker 能力。

## 本地双脚本测试构建

```bash
npm --prefix script ci
npm --prefix script run typecheck
npm --prefix script test
npm --prefix script run build:manual
npm --prefix script run verify:manual
```

本地构建只写入 `script/dist/manual/`，不运行 npm 的 `postbuild` 发布钩子，不创建或覆盖 `server/public/script/`：

| 页面 | 安装文件 | 构建信息 |
| --- | --- | --- |
| 销售 | `script/dist/manual/duko-sales-filler.user.js` | `sales.build-meta.json` |
| 采购 | `script/dist/manual/duko-purchase-filler.user.js` | `purchase.build-meta.json` |

两份 bundle 都从 `index.ts` 构建；`targets.json` 是路径、产品控件、数量字段、折扣能力和安装标识的唯一配置来源。`build-config.cjs` 共用打包与 metadata 生成；面板、CSV 解析、填表、覆写和等待逻辑均共用，不维护两份源代码。

`test` 使用合成数据和隔离 jsdom，不连接 Odoo；`verify:manual` 检查最终安装文件的语法、metadata、页面范围及预览。它们不验证真实 Odoo 的 onchange 或键盘提交行为，后者需要人工测试。

## 发布构建

```bash
npm --prefix script run build
```

这是会写入生产静态目录的发布命令：Rspack 在 `script/dist/` 生成销售脚本 `duko-filler.user.js`（包含 metadata）及 `build-meta.json`，随后 npm 自动运行 `postbuild.cjs`，将这两个文件复制到 `server/public/script/`。加载构建配置本身不再写文件。采购脚本目前通过本地测试产物手动安装，尚未接入服务端下载入口。

server 只负责把这份静态复制产物作为下载文件提供；脚本安装并运行后不回连 server。根 `npm run railway:build` 会先构建 `script/`，因此 Railway 部署包含最新用户脚本下载产物。

## 安装与安全

当前手动测试使用 `script/dist/manual/` 中的两个 `.user.js` 文件，在 ScriptCat 中分别导入／新建脚本安装。先禁用此前匹配整个 `/odoo/*` 的旧 DUKO Quote Filler，避免重复面板和并发写入。两个新脚本的安装名称不同，可以同时启用；安装前检查 metadata 的匹配域和构建时间。

人工验收先测试少量追加行，再测试覆写：销售检查产品、数量和折扣；采购检查两列／三列 CSV、产品自动带出的单位及单价；两者都检查连续多行、产品不存在后的继续执行、已有行识别，以及跨模块导航后的停止写入。回退时禁用两个测试脚本并重新启用原脚本，刷新页面；脚本切换不会撤销已写入 Odoo 的行。

- 只在目标 Odoo 域名使用，不要扩展为宽泛的 `@match`。
- CSV 内容直接进入当前浏览器页面，不会按当前代码上传 DUKO server；Odoo 本身仍会接收用户最终写入的数据。
- 自动填表前核对当前报价单、现有行和 CSV。DOM 自动化不提供事务回滚，中途失败可能已写入部分行。
- Odoo 页面更新可能破坏选择器或 autocomplete 事件流程，应先用测试报价单验证。

## 与 Auto 的区别

| 项目 | `script/` | `auto/` |
| --- | --- | --- |
| 触发者 | 当前 Odoo 页面上的用户 | Railway server 派发任务 |
| 输入 | 手工粘贴 CSV | 持久报价任务或库存任务 |
| 通信 | 不连接 server | WebSocket 连接 server |
| 浏览器 | 用户当前标签页 | Playwright 持久 Chromium |
| 状态 | 当前页面内存 | 报价落 server SQLite；库存为 server 内存态 |
| 用途 | 临时、人工监督的 CSV 填表 | 远程排队报价和库存自动化 |
