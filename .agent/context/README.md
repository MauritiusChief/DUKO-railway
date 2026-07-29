# Agent Context

本目录保存跨任务复用、由当前代码支持且不易从目录名直接看出的背景：

- [domain.md](domain.md)：SKU、layout、exposure 与物料语义。
- [external-systems.md](external-systems.md)：Railway、LLM、Hugging Face 与 Odoo 边界。
- [data-safety.md](data-safety.md)：敏感数据、持久化位置和操作防护。

维护原则：

- 以代码、测试、配置 schema 和 `.env.example` 为依据，不读取实际 `.env`。
- 只记录稳定语义；架构、API 和运维步骤写 GitHub Wiki，实施任务写 Issue 或 `wiki/plans/`。
- 不确定结论明确标“待确认”，代码变化后及时删除过时内容。
