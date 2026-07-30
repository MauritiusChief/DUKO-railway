# 数据与搜索

## 数据目录

所有数据库和业务 CSV 由 `DB_DIR` 定位。显式配置优先；Railway 必须使用 `DB_DIR=/data` 并将 Volume 挂载到同一路径。本地未配置时，开发运行默认使用仓库根的 `dev_data/`，生产式运行默认使用 `simvolume_data/`。

## 三类检索存储

### `sku.sqlite`

这是结构化 SKU 和引用数据的权威查询层：

- `exposed_items` 保存产品代码、颜色、形状类型、尺寸、别名、子项和描述。
- `exposed_colors`、`exposed_types` 提供代码对照。
- `items`、`parts` 保存产品与部件映射。
- `products` 保存预测库存、可用库存和现有库存数量。
- `inventory_results` 保存最近 20 次成功库存识别的全局共享结果（执行人、查询参数、分类统计与完整分类 JSON）。
- `sku_refresh_metadata` 单例记录最后一次完整 SKU 刷新的成功时间与来源，供 Chat Agent 提示库存数据新鲜度。

结构化 CRUD、过滤、精确查找、组件与库存查询都使用 SQLite。数据库启用 WAL 和 `synchronous=NORMAL`。

### `sku.lance/`

LanceDB 是嵌入式文件数据库，只负责 384 维语义向量搜索。Embedding 由 `onnx-community/all-MiniLM-L6-v2-ONNX` 在 server 本地生成，采用 mean pooling 和归一化；模型首次使用时由 Transformers.js 下载并缓存。

### 内存 BM25

BM25 描述索引从 `sku.sqlite` 全量读取并在进程启动时预热。它不单独持久化，重启后重建。若运行时替换了 SKU 数据，也必须确保索引按代码流程刷新，否则内存搜索可能与 SQLite 不一致。

## 搜索组合

- 形状搜索对形状类型和尺寸代码及其别名计算编辑距离，并支持颜色筛选。
- 描述搜索使用 BM25 对描述文本排序。
- overlap 搜索取形状与描述候选交集。
- structured 搜索支持形状和描述的布尔过滤树、颜色限定及向量语义查询。
- 子产品解析按 `subItemsName` 在 SQLite 批量精确匹配，只展开直接子项，递归深度为 1。

## CSV 处理与导入

启动开关含义：

- `AUTO_PROCESS=true`：启动时执行原始产品 CSV 清洗/处理，生成 exposed 数据。
- `AUTO_INGEST=true`：当 `sku.sqlite` 的主表为空时，从 `DB_DIR/Exposed-Items.csv` 导入 SQLite 和 LanceDB，并加载引用表。

默认都为 `false`。生产开启前应确认 Volume 中输入文件齐全并保留备份。向量全量替换会 drop/recreate LanceDB 表；结构化主表也使用事务性全量替换。两个存储没有跨数据库原子事务，因此中途失败可能造成版本不一致，需要重新完整导入。

## 库存数据流

库存看板有两种输入：用户上传 CSV，或由 auto worker 从 Odoo 下载 CSV。server 在内存中清洗、按可用库存阈值筛选，再请求 worker 查询近期库存移动并按出库量分为警告、提醒和信息。

自动下载模式在取得 CSV 后会同时做两件事：进入库存识别链路；把该 CSV 以 `Product-raw-YYYY-MM-DD.csv`（UTC 日期）暂存到 `DB_DIR`，并删除旧的 `Product-raw*.csv`，保证最终只剩一个最新文件，供管理员择机手动重建 SKU 数据（见下）。上传模式不暂存文件。暂存失败只记日志，不阻断本次识别。

分类成功完成后，结果写入 `sku.sqlite` 的 `inventory_results` 表（全局共享，保留最近 20 条，按完成时间倒序裁剪）；写入失败会使该库存 job 失败。库存历史通过 `GET /api/inventory/results`（摘要）与 `GET /api/inventory/results/:id`（完整分类）查询，仅 manager/admin 可访问。

库存 job 本身（运行态、原始 CSV、趋势中间结果）仍只存在于 `server/src/services/inventory.ts` 的内存 Map；终态超过约一小时清理，服务重启丢失。分类结果不再写浏览器 localStorage；前端默认加载最新一条历史，运行期可切换历史。

## 手动 SKU 数据刷新

完整 SKU 数据刷新（清洗派生 CSV、重建 `sku.sqlite` 引用表、重建 LanceDB 向量）不由库存下载自动触发，而由管理员择机手动执行：

1. 库存看板的自动下载把最新 CSV 暂存为 `DB_DIR/Product-raw-YYYY-MM-DD.csv`。
2. 管理员在非工作时间运行 `node server/dist/refresh-data-cli.js`，CLI 自动选取最新一份 `Product-raw-*.csv`（回退兼容历史固定名 `Product-raw.csv`）。
3. 刷新成功后 CLI 在 `sku_refresh_metadata` 记录最后成功刷新时间与 `source='manual-cli'`。
4. 需重启 Web Service 以重载进程内 BM25/LanceDB 句柄/颜色等缓存——CLI 进程内预热的索引不会自动注入运行中的 Web 进程。

完整刷新仍逐表事务性全量替换 SQLite 引用表、drop/recreate LanceDB 表，没有跨库原子发布；中途失败可能留下半替换状态，需重新完整刷新。刷新只操作 SKU 数据表，不会清除 `inventory_results` 或 `sku_refresh_metadata`。

## 一致性与备份

完整业务备份至少应包含 `users.sqlite`、`sku.sqlite`、`sku.lance/` 和需要保留的 CSV。SQLite 使用 WAL，不能在持续写入时只普通复制主 `.sqlite` 文件。应停止写入后复制完整目录，或使用 SQLite 在线备份生成一致快照；详细步骤与 Railway Volume 注意事项见 [Railway 部署](../RAILWAY_SETUP.md)。
