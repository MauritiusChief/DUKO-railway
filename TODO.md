## 已完成

1. addItem 和 editItem 需要允许添加多个选项供用户选择，或者留空提示完全无信息，xxx search agent 允许提供多种选项的提示词
2. 主 agent search budget 减少，dispatch 也加上预算限制
3. 形状代码对照表 Exposed-Types 需要清洗，或者先导出 Types 表再人工改出 Exposed-Types
3. 1. 说不定可以改造 sku-exposed, 分区以辅助理解

- 玻璃门得提示，用户要求的玻璃门如果在仓库里没有才需要定制
- main agent 提示词需要科普 PNL 相关概念
  - Filler 96“ 的概念也要科普（以防万一吧）
- 正在解析时，禁用发送按钮
- 改动解析结果框，形状型号和形状尺寸混合，以兼容只买零件的情况
- 修颜色匹配通配不仅限于 RD 的 bug
- 提示 main agent 并行指令批量搜索者
- batch search 疑似根本没并行，需排查
- 支持大小写不敏感
- 支持一次上传多个图片
- 有些 Agent 已经过时了（或者完全是过度设计，压根没用到），需要删掉
- 解析新清单时清空对话框
- chat panel 发消息会有竞态问题导致bug
- N/A 占位处理逻辑分散在各个 agent 中，需要优化
- N/A 逻辑当前是强行覆盖住，需要更合理的矫正手段，不会因为点了一下就强制要求了
- 检查欧式 UT 为啥只有 BxxF, 没有上半部分
- searchSkuStructured 工具的描述过时，现在 vector query 仅用来排序了，不再过滤
- 日志发现 evaluateShapeLeaf 函数出错，Cannot read properties of undefined (reading 'length')，和 search-structured 与 executeSearchSkuStructured 有关
  - 因为缺少 trace，不知道为何触发。可以添加大量 test case 来测试。
- 管理员总览全员历史记录功能
- 管理员修改密码功能

## 未完成

- 改用 deepseek 解析图片
- 不要每次都传输图片，改为通过工具调用，看完之后就从消息中移除
- budget tool 也需要改，搜索工具预算也要改
- 已创建墙、已更新 property 等信息被当作助手消息了，得删除。

- 每次去 layout-recognize 或 debug, 以及再回到主页面时都需要重新登录，很烦人
- ScriptCat 覆写模式不会检查数量
- 前端和后端各自有一份 layout 用的推挤逻辑，看看如何统一
- layout-recognzie 各个 block 需要允许定义 base 或 vanity
- layout-recognzie 需要在墙已经建好之后再连接不同的墙
- layout-recognzie 允许改自动滑动方向

- 发现 railway web 的 console 可以管理 `/data` 目录，应该不需要用到 railway cli 来管理 volume 了。
  - 但疑似缺少新建目录功能，需要调整 refresh cli 来配合
  - console 可以管理 `/data` 的话，那整个 wsl 都变成可选了
- 还有个指挥者 agent，看怎么处理
