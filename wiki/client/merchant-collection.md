# 商家信息采集

## 当前状态

阶段 2 已实现 `/merchant-collection` 搜索页面，阶段 3 已实现所选商家官网首页提取，阶段 4 已实现人工确认、IndexedDB 本地名录和 CSV 备份；页面仅允许 `admin` 和 `manager`。Google 候选和未确认的官网提取草稿只保存在 React 组件内存中，刷新、离开页面或重新搜索都会丢弃。

人工确认后的记录只保存在当前 origin 和浏览器 profile 的 IndexedDB，不写入服务端数据库，也不会跨设备或随账号同步。

## 入口与权限

- `client/src/App.tsx` 使用 `RoleGuard allowedRoles={['admin', 'manager']}` 保护页面。
- 清单主页仅对 admin/manager 显示“商家采集”入口。
- 前端 guard 用于页面体验；服务端路由仍独立执行相同角色校验。

## 搜索表单

页面要求三个字段：

- 商家类别或服务：1～200 个字符，例如 `kitchen cabinet stores`。页面提示不要把经纬度写入查询词。
- 中心坐标：`纬度, 经度` 格式，只接受连续 48 州近似包围框内的中心点。
- 矩形半宽：大于 0 且不超过 50 km。输入 `10` 表示向东、西、南、北各约延伸 10 km。

客户端先执行与服务端一致的基础校验，再通过 `fetchWithAuth` 提交 JSON。请求进行中禁用输入；离开页面会用 `AbortController` 取消在途请求。客户端校验失败、开始新搜索或服务端返回不可识别数据时不会继续显示上一轮结果。

## 临时结果

结果区显示：

- 去重后的结果数和成功读取页数。
- 商家名称、Place ID、地址、坐标、电话、官网、营业状态和 Google Maps 链接。
- `possiblyTruncated` 对应的“范围内可能还有其他商家”提示。
- 后续页失败时服务端返回的 `partial` 和固定警告。
- 无结果、加载、网络失败和 API 错误状态。

官网和 Google Maps URL 即使来自 Google 也按不可信输入处理：页面只把合法 `http:`/`https:` URL 渲染为外链，并使用新窗口隔离属性。当前不会自动访问商家官网。

桌面使用结果表格；窄屏保持原生表格语义并允许横向滚动。Google Maps attribution 始终位于结果区底部，同时提供搜索排序因素说明链接。

## 官网首页提取

只有 Google 结果提供合法 `http:`/`https:` 官网 URL 时才可勾选。用户可以选择全部有官网商家或逐行选择，再点击“抓取所选官网首页”：

- 客户端最多同时发送 3 个 `POST /api/merchant-websites/extract` 请求。
- 每行显示等待、抓取中、成功或失败状态；失败行可单独重试。
- 用户可取消当前批次；离开页面、开始新搜索或提交无效新搜索也会取消在途请求和待处理队列。
- 成功草稿可展开查看邮箱、电话、页面标题、meta description、canonical URL 和清洗正文；正文被服务端截断时显示 50 KiB 提示。
- “静态首页未发现”只表示当前不执行 JavaScript、也不访问 Contact/About 等其他页面，不能据此断言商家没有联系方式。

官网提取结果仍是未经人工核实的草稿，不会自动覆盖 Google 字段或进入本地名录。

## 本地名录

数据库名为 `duko-merchant-collection`，schema 版本为 1：

- `merchants` store 使用 `placeId` 作为 `keyPath`，保存人工确认后的独立 `MerchantRecord`，不持久化 Google 原始响应。
- `meta` store 保存最近导入、导出时间等非敏感状态。
- 空名录只浏览时不会留下数据库；首次保存记录或确认 CSV 导入时才创建。
- 记录正文每次写入都重新检查 50 KiB UTF-8 上限；URL、字段长度和数组项数量也在写入层统一校验。

临时候选点击“核实并纳入”后先进入编辑表单，用户确认才写入。命中已有 Place ID 时显示“已收录”，用户主动点击“核实并合并”后，候选和官网草稿的非空字段进入编辑表单，空字段不清除原记录。本地表格的“编辑”是显式编辑路径，允许用户清空字段。保存使用 `updatedAt` 比较，其他标签页已修改同一记录时拒绝旧草稿覆盖。

页面显示 `navigator.storage.estimate()` 返回的整个站点估算用量和配额，并允许用户主动调用 `navigator.storage.persist()`；浏览器拒绝持久存储不会阻止功能。IndexedDB 不会因登出自动删除，共享浏览器的其他使用者可能看到数据；清除站点数据、无痕窗口结束、profile 损坏或设备故障仍会删除名录。

## CSV 备份

CSV 使用 Papa Parse 解析和生成，不使用手工逗号拆分：

- 导出范围只有 IndexedDB 本地名录，使用固定表头、UTF-8 BOM、标准双引号和 CRLF；`emails`、`socialLinks` 用 JSON 字符串数组编码。
- 以 `=`, `+`, `-`, `@`、制表符或回车开头的单元格由 Papa Parse 添加公式防护；原始前导单引号会额外转义，重新导入自己的备份时可还原。
- 导入文件最大 5 MiB、最多 5000 条数据行，必须包含非空 `placeId`；字段长度、HTTP(S) URL、数组格式和 50 KiB 正文限制与编辑保存一致。
- 同一文件重复 Place ID 会按物理文件行号报错，多行引号单元格也计入行号。
- 导入先预览新增、更新、无变化和错误；存在任一错误时不能应用。确认后所有 patch 在单个 IndexedDB transaction 中按 Place ID 合并，异常会 abort，不会部分提交。
- 已有记录只被导入行的非空字段更新；空字段不清除本地值。长正文会形成合法多行 CSV 单元格，应使用支持标准 CSV 引号规则的软件打开。

CSV 是本地名录的必要备份和设备迁移路径，不是服务端备份。

## 后续阶段边界

阶段 5 仅执行授权环境试运行和最终发布核对。Google 候选和官网提取草稿在用户确认保存前仍不能被视为已收录商家。

## 验证

客户端使用 Vitest 覆盖 IndexedDB 首次创建、显式清空、Place ID upsert、空字段合并、事务前校验、并发编辑冲突、50 KiB 限制，以及 CSV 多行、重复行、JSON 数组、URL、公式和单引号往返。运行：

```bash
npm --prefix client test
npm --prefix client run build
```
