# 手工 CSV Quote Filler

`script/` 是独立的 Tampermonkey/ScriptCat 用户脚本，用于人在 Odoo 报价页面上手工粘贴 CSV 并逐行填入产品与数量。它不是 auto worker，也不连接 DUKO server 的 API、SSE 或 WebSocket。

## 使用模型

脚本在匹配 `https://dukouserp.com/odoo/*` 的页面加载后注入浮动面板。用户粘贴 CSV、在页面上确认操作，脚本直接通过浏览器 DOM 驱动当前已登录的 Odoo 页面：

- 解析 CSV 文本并展示待写入项目（`productName,quantity[,discount]`；折扣为百分数，空值不触碰 Odoo 折扣）。
- 读取现有报价行以辅助核验。
- 逐行点击 “Add a product”，使用 Odoo autocomplete 选择产品、填写数量，并按需填入折扣。
- 对找不到的产品进行清理并汇总未填项目。

它依赖当前 Odoo DOM 选择器和用户已有登录态。没有 server 任务记录、远程确认、断线重试、SQLite 持久化或库存 worker 能力。

## 构建产物

```bash
cd script
npm ci
npm run build
```

构建流程为：

1. Rspack 从 `index.ts` 打包到 `script/dist/duko-filler.user.js`。
2. 构建时间写入 `server/public/script/build-meta.json`，并注入 bundle 常量。
3. `postbuild.cjs` 为 bundle 添加 Tampermonkey/ScriptCat metadata header。
4. 最终脚本复制到 `server/public/script/duko-filler.user.js`。

server 只负责把这份静态复制产物作为下载文件提供；脚本安装并运行后不回连 server。根 `npm run railway:build` 会先构建 `script/`，因此 Railway 部署包含最新用户脚本下载产物。

## 安装与安全

从应用提供的脚本下载入口安装，或使用本地 `script/dist/duko-filler.user.js` 测试。安装前应检查 metadata 的匹配域和构建时间。

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
