# AGENTS.md

本文件适用于整个仓库。更具体且与当前代码一致的局部说明可补充本规则，但不得降低安全要求。

## 事实优先级

发生冲突时按以下顺序判断：

1. 当前代码、测试、配置 schema 与 `.env.example`。
2. 用户在当前任务中的明确要求。
3. `.agent/context/` 中已核验并注明来源的背景。
4. GitHub Wiki 中的当前架构、接口和运维文档。
5. `wiki/plans/` 中的计划，只能说明意图，不能证明现状。
6. 注释、历史文档和推测。

## 开始工作

1. 阅读 `git status`，保留他人改动，不回退无关文件。
2. 根据路径映射阅读相关代码、测试、Wiki 与 `.agent/context/`。
3. 检查对应 skill 的触发条件，只加载与任务有关的清单。
4. 明确外部调用、持久化数据、认证、日志和迁移风险。
5. 选择最小正确改动，并确定可重复、无副作用的验证方式。

## 结束工作

1. 执行受影响范围的测试、类型检查或构建，记录未执行项及原因。
2. 检查 `git diff` 和 `git status`，确认没有密钥、运行数据、生成物或范围外修改。
3. 执行 Wiki 强制影响检查并同步必要文档。
4. 若发现后续工作，创建或建议 GitHub Issue，不新增 backlog 文件。
5. 总结行为变化、文件、验证结果、风险和待确认项；仅在用户明确要求时提交。

## Wiki 强制影响检查

每次代码、配置、流程或文档变更结束前都回答：

- 是否改变系统拓扑、组件责任或数据流？
- 是否改变 API、WebSocket/SSE 协议、认证、配置项或外部系统交互？
- 是否改变部署、运维、数据刷新、故障恢复或安全边界？
- 是否实现或推翻现有计划中的决策？

任一答案为“是”时，同步对应 Wiki 页面；跨文件实施方案写入 `wiki/plans/YYYY-MM-DD/<topic>.md`。纯领域语义只更新 `.agent/context/domain.md`。若任务范围不允许修改 Wiki，明确报告所需更新，不得默认为“无影响”。

## 路径到文档映射

| 代码路径 | 必读/应同步文档 |
| --- | --- |
| `client/` | Wiki 前端/用户流程页；API 使用变化同时检查接口页 |
| `server/src/routes/`、`server/src/validation/` | Wiki API/协议页 |
| `server/src/agents/`、`server/src/llm/`、`server/src/tools/` | Wiki Agent/LLM 页；`.agent/context/domain.md` |
| `server/src/services/sku-*`、`server/src/process-cli.ts`、`server/src/ingest-cli.ts` | Wiki 数据管线/运维页；`.agent/context/domain.md`、`data-safety.md` |
| `server/src/types/layout.ts`、layout Agent/路由/物料服务 | Wiki layout 页；`.agent/context/domain.md` |
| `server/src/db/`、认证/trace/history | Wiki 数据模型/安全页；`.agent/context/data-safety.md` |
| `auto/`、`server/src/services/ws-*`、`server/src/routes/auto-worker.ts` | Wiki Odoo 自动化/协议/运维页；`.agent/context/external-systems.md` |
| `script/` | Wiki ScriptCat/Odoo 集成页；`.agent/context/external-systems.md` |
| `railway.json`、根构建脚本、部署配置 | Wiki 部署/运维页；根 `README.md` |
| `.agent/**`、`AGENTS.md` | `.agent/context/README.md`、`.agent/skills/README.md`；必要时根 `README.md` |

Wiki 页面尚不存在时创建主题明确的页面。

## 计划规范

- 只有需要多人协调或分阶段实施+审阅的工作才写计划，可单人/单会话完成的工作或无需分阶段审阅的工作无需计划。
- 路径固定为 `wiki/plans/YYYY-MM-DD/<topic>.md`；日期用创建日，`topic` 使用小写 kebab-case。
- 计划包含目标、非目标、已核验现状、方案、风险、验证、发布/回滚和关联 Issue。
- 计划不是事实来源或待办队列；实现后更新状态和偏差，稳定结论回写主题 Wiki 或 `.agent/context/`。

## Issue 规范

- GitHub Issues 是唯一 backlog。
- 一个 Issue 描述一个可验收结果，包含背景、范围/非范围、验收标准、风险或依赖。
- 缺陷附最小复现、期望/实际结果和脱敏证据；数据或安全问题不得粘贴敏感原文。
- PR、计划和代码注释用 Issue 链接关联；已完成项关闭 Issue，不复制到文档清单。

## Context 与 Skills

- `.agent/context/` 只保存跨任务有用、非显然且可由代码验证的稳定背景；架构细节属于 Wiki，临时判断属于 Issue/计划。
- 代码支持但存在边界不清的领域规则写入 `domain.md` 并标“待确认”。
- 外部服务、信任边界和运行依赖写入 `external-systems.md`；数据分类与操作防护写入 `data-safety.md`。
- `.agent/skills/` 只写可执行步骤，不复制架构或领域事实；触发条件见 `.agent/skills/README.md`。
- 文档改动触发 `documentation-maintenance`。

## 测试命令

```bash
npm --prefix server test
npm --prefix client run build
npm --prefix server run build
npm --prefix script run build
npm --prefix auto run build
npm run railway:build
```

服务端测试使用 Vitest。仓库当前没有前端、script 或 auto 的测试脚本，以各自 build 作为静态验证。数据命令和浏览器自动化有副作用，不为“验证”而运行。

## 安全

- 只读取 `.env.example`，禁止读取实际 `.env` 或输出环境变量全集。
- 禁止提交密钥、token、cookie、客户资料、报价、库存 CSV、数据库、向量库、日志、trace、截图或浏览器 profile。
- 外部模型输入最小化；调试输出和测试夹具必须脱敏，图片不得以 base64 写入 trace 或 Issue。
- 执行数据重建、数据库写入、Odoo 写入、库存下载、生产命令前取得明确授权并确认目标环境。
- 不绕过认证、输入校验、限流或人工确认；安全行为变化必须有测试并同步 Wiki。
