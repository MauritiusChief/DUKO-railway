# 数据安全

## 数据分类

| 数据 | 典型位置 | 要求 |
| --- | --- | --- |
| 密钥与凭据 | 实际 `.env`、Railway variables | 禁止读取、输出、提交；只参考 `.env.example` |
| Odoo 会话 | `auto/data/browser-profile/` | 视同账号凭据，不复制、不打包 |
| 用户与业务记录 | `users.sqlite` 及 WAL/SHM | 含账号哈希、输入、历史、笔记、trace、报价任务 |
| SKU 与库存数据 | CSV、`sku.sqlite`、`sku.lance/`、上传内容 | 可能含内部目录、库存和销售信息 |
| 客户内容 | 文本、图片、报价号、清单、快照 | 发送模型、写日志、Issue 前最小化和脱敏 |
| 日志与 trace | 日志目录、trace SQLite | 可能复现提示词、工具结果和用户数据 |

## 持久化与边界

- `DB_DIR` 优先决定 SQLite、LanceDB 和 CSV 目录；开发默认 `dev_data/`，生产式运行默认 `simvolume_data/`，部署可指向 Railway Volume。
- `users.sqlite` 不只保存用户，还保存解析历史、笔记、trace 和报价任务；删除或替换前必须确认影响范围。
- `sku.sqlite` 保存结构化 SKU/引用表，`sku.lance/` 保存 embedding。两者应与生成它们的 CSV 版本一致。
- `TRACE_LOG` 和 `CHAT_LOG` 会扩大数据留存；启用前确认必要性、访问权限和清理策略；当前为了开发方便已全部启用。
- 图片允许经 API 处理，清单图片和 layout 原始图片会发送给 OpenRouter；不得把 base64 图片放入 Issue、文档或持久 trace。
- Access Token 和多项业务缓存保存在浏览器 `localStorage`，不是 HttpOnly 数据。共享浏览器切换账号时，笔记、报价草稿、库存结果、当前清单和 layout 可能残留；登出不能视为已清除这些业务数据。

## 安全操作清单

1. 不读取实际 `.env`，不运行会打印完整环境变量或请求体的命令。
2. 默认使用合成、最小、脱敏夹具；不得从本地数据库或 CSV 抽取真实记录做测试。
3. 数据处理前确认 `DB_DIR` 的解析结果和输入文件，必要时做可恢复备份。
4. `db:process` 会重写派生 CSV；`db:ingest` 和构建后的 `node server/dist/refresh-data-cli.js` 会改写 SQLite/LanceDB 或完整重建数据；不得作为普通测试运行。
5. 对日志、错误和截图做字段级脱敏；API key、JWT、worker token、cookie、密码哈希和客户标识不得出现。
6. 完成后用 `git status`/`git diff` 检查 `.env`、数据库、WAL/SHM、CSV、日志、profile 和构建产物未进入变更。

## 恢复原则

- 不把 SQLite 文件与其 WAL/SHM 随意拆开复制；先停止写入并使用数据库支持的备份方式。
- 数据管线失败时保留原始 `Product-raw.csv` 和上一个一致版本，不用半成品覆盖可用数据。
- SQLite 与 LanceDB 导入不是代码中声明的跨库原子事务；中途失败后应从可信输入完整重建并核对计数。
- 具体生产备份、保留期限和恢复演练流程当前未在仓库定义，标记为**待确认**。
