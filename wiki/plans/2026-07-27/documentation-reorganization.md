# Agent 文档体系重构

状态：已实施

## 目标

- 建立根 `README.md` 和 `AGENTS.md`。
- 将当前架构、功能、开发和运维指南集中到 `wiki/`。
- 将代码难以快速推断的领域语义放入 `.agent/context/`。
- 将可重复执行的 Agent 工作流放入 `.agent/skills/`。
- 将后续实施计划统一存入日期目录，并以 GitHub Issues 作为唯一 backlog。

## 非目标

- 不改变应用代码、运行拓扑、API、认证或数据模型。
- 不把旧计划直接转换为当前架构事实。
- 不创建 `wiki/domain.md` 或 wiki backlog。

## 已核验现状

- 仓库由 `client`、`server`、`auto` 和 `script` 四个独立 Node.js 子项目组成。
- Railway 根构建只包含 `client`、`script` 和 `server`；`auto` 在外部机器运行。
- 原 `.agent/` 中的计划均已实现或被当前代码取代。
- 原根 `PLAN.md`、`TODO.md`、Railway 文档和 `script/MIGRATION_PLAN.md` 混有过时事实。

## 实施结果

- 新增根 README、Agent 协作规范、context 和 skills。
- 新增按实际项目结构组织的完整 Wiki。
- Railway 文档移入 `wiki/` 并按当前配置重写。
- 删除旧计划、旧 TODO 和被替代的迁移文档。
- 文档更新检查纳入 `AGENTS.md` 和 `documentation-maintenance` skill。

## 风险与控制

- 文档可能随代码漂移：每项工作结束前强制执行 Wiki 影响检查。
- context 与 Wiki 可能重复：领域语义只写 `.agent/context/domain.md`，架构事实只写 Wiki。
- 外部平台事实无法由仓库证明：注明待确认，并以官方文档或维护者确认为准。

## 验证结果

- 所有 Markdown 相对链接均存在。
- 文档命令已与各 `package.json`、`railway.json` 和 `.env.example` 核对。
- `npm --prefix server test` 通过：2 个测试文件、67 项测试。
- client、server、script、auto build 均通过。
- `npm run railway:build` 通过。
- `git diff --check` 通过，工作区未加入 `.env`、数据库、日志或生成数据。
- `npm ci` 报告现有依赖漏洞：client 3 项、script 9 项、server 7 项；本次纯文档任务未自动升级依赖。

## 发布与回滚

这是纯文档变更，不需要运行期发布步骤。若部分说明不准确，应基于当前代码修正文档，不恢复旧计划作为事实来源。

## 关联 Issue

无。此重构由当前文档整理任务直接实施。
