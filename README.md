# DUKO Railway

DUKO Railway 是面向橱柜报价流程的内部工具：从文本或图片提取 SKU，检索和拆解产品，识别 layout 并生成物料清单，再将经人工确认的报价与库存任务交给本地 Odoo 自动化 worker。关键业务决定仍由员工确认。

## 当前拓扑

```text
浏览器
  └─ HTTPS/SSE ─> Railway 上的 Express 服务（同端口提供 React 静态文件和 /api）
                    ├─ SQLite：用户、历史、trace、报价任务、SKU 结构化数据
                    ├─ LanceDB：384 维 SKU 向量
                    ├─ DeepSeek / OpenRouter：文本与多模态 Agent
                    └─ WebSocket /api/auto/connect
                         └─ 本地 auto worker ─> Playwright ─> Odoo

ScriptCat 用户脚本 ─> Odoo 页面；构建产物由 server 提供下载
```

Railway 构建顺序为 `client`、`script`、`server`，生产环境由 `server` 提供 `client/dist`。Node.js 要求 `>=20`。

## 目录

| 路径 | 用途 |
| --- | --- |
| `client/` | React、Vite、Zustand 前端 |
| `server/` | Express API、Agent、数据处理、SQLite/LanceDB |
| `auto/` | 连接服务端并操作 Odoo 的 Playwright worker |
| `script/` | 注入 Odoo 页面的 ScriptCat/Tampermonkey 脚本 |
| `.agent/context/` | 由代码支持的领域、外部系统和数据安全背景 |
| `.agent/skills/` | 按改动类型触发的代理检查清单 |
| `wiki/` | 随代码维护的架构、功能、运维和计划文档 |

`experiment/` 和本地数据目录不属于生产源码。

## 快速开发

各子项目独立管理依赖，没有根 workspace。先参考 `server/.env.example` 和 `auto/.env.example` 配置本地环境；不要提交 `.env`。

```bash
npm --prefix client ci
npm --prefix server ci
npm --prefix script ci
npm --prefix auto ci
```

分别启动前后端：

```bash
npm --prefix server run dev
npm --prefix client run dev
```

需要本地 worker 时另行执行：

```bash
npm --prefix auto run init-session
npm --prefix auto run dev
```

SKU 数据处理使用 `DB_DIR` 指向的目录：

```bash
npm --prefix server run db:process
npm --prefix server run db:ingest
```

## 验证

```bash
npm --prefix server test
npm --prefix client run build
npm --prefix server run build
npm --prefix script run build
npm --prefix auto run build
npm run railway:build
```

按改动范围执行最小相关集合；合并前对受影响的全部子项目执行构建。`db:process`、`db:ingest` 和 worker 流程会读写数据或访问外部系统，不属于无副作用验证。

## 文档

- [项目 Wiki](wiki/README.md)：架构、功能、运维和实施计划。
- [代理协作规则](AGENTS.md)：事实优先级、工作流和文档影响检查。
- [代理上下文](.agent/context/README.md)：领域语义、外部系统和数据安全。

领域知识不再写入 `wiki/domain.md`，统一维护在 `.agent/context/domain.md`。仓库不维护 backlog；待办、缺陷和需求统一使用 [GitHub Issues](https://github.com/MauritiusChief/DUKO-railway/issues)。

## 数据安全

- 只读取 `.env.example` 了解配置结构；禁止读取、记录或提交实际 `.env`、API key、JWT secret、worker token 和 Odoo 登录态。
- `dev_data/`、`simvolume_data/`、`auto/data/`、SQLite/WAL、LanceDB、CSV、日志和浏览器 profile 都按敏感运行数据处理，不进入提交或测试夹具。
- 图片、客户输入、报价、库存、历史和 LLM trace 可能含业务数据；发送到外部模型、写日志或制作复现材料前先最小化和脱敏。
- 数据重建、导入、Odoo 写入和库存下载均可能产生副作用，执行前确认环境、`DB_DIR`、备份和人工授权。

详见 [.agent/context/data-safety.md](.agent/context/data-safety.md)。
