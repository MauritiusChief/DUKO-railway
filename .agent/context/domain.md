# 领域语义

以下内容来自当前类型、数据处理服务和物料算法/测试；不是完整业务手册。

## SKU 与产品层级

- 普通 `itemName` 通常由 `colorCode + shapeTypeCode + shapeSizeCode` 组成；无颜色或无尺寸的型号允许对应字段为空。
- `Product-raw.csv` 是原始产品导出。实际刷新输入源为库存看板自动下载暂存的 `Product-raw-YYYY-MM-DD.csv`（UTC 日期，每次清理旧文件后只保留一个最新），CLI 自动选取后回退兼容历史固定名 `Product-raw.csv`。处理链依次生成 `Product.csv`、`Color.csv`、`Parts.csv`、`Items.csv`、`Exposed-Items.csv`、`Exposed-Color.csv`、`Exposed-Types.csv`。
- `Parts.csv` 表达“单一零件名 -> 共享零件名”。带 `/` 的共享编码可能拆成多个可查询零件；尺寸分数、复合模式、左右变体和双颜色兼容有专门规则。
- `Items.csv` 表达可售物品及其柜体、门和额外零件；`Exposed-Items` 是检索层，增加颜色、形状、尺寸、别名、描述与 `subItemsName`。
- `subItemsName` 非空表示组合物品，生成产品清单时需要拆为子项；高柜、烤箱柜、背板、带垃圾桶地柜及部分冰箱/洗碗机板由代码生成组合规则。
- 结构化字段在 SQLite 中查询；描述语义使用 BM25 和本地 384 维 embedding/LanceDB。向量距离越小越相似。
- `GD`、`TCR` 可无颜色；`GD`、`CBL`、`TUK`、`SD` 可无尺寸。
- 颜色 `29` 的部分配件映射到 `02`，颜色 `32` 的部分配件映射到 `12`；只对代码列出的 shape type 生效，不能概括为整色替换。
- `02`、`04` 被代码归为 UNIPACK；这会影响 layout 侧板生成。`Exposed-Items` 对 UNIPACK 描述的解析仍有代码注释标记为非最终形态。

## Layout 双轨

- 每面墙有独立的 `airBlocks` 和 `groundBlocks`。块按数组顺序从左向右累积宽度，不单独存绝对坐标。
- `wall_cabinet` 位于空中轨，`base_cabinet` 位于地面轨；`tall_cabinet` 与 `tall_appliance` 跨两轨。
- 同一个跨轨物品在两轨使用相同 `BlockItem.id`；清单按 id 去重。破坏该身份关系会造成重复计数或邻接判断错误。
- 一个 block 可含叠放物品。例如空中轨的高电器与其上方吊柜共享 block；高电器只有存在叠放吊柜时才生成 RRP 框料。
- `gap` 与 `stuffed_gap` 不进入产品清单，并使两侧视为未遮挡；`gaplike_item`（代码示例含 `VAL`）进入清单，但也不遮挡两侧。
- `filler` 进入清单，并在邻接/边缘 exposure 判断中近似透明；紧邻 `tall_appliance` 或 `base_appliance_need_top` 时会从原始产品行移除，以避免把框料误识别为 filler。
- `base_appliance_need_top` 生成 DWP；`base_appliance_without_top` 只参与遮挡；电器本体不作为可售产品行输出。
- `isVanity` 仅对 `base_cabinet` 有效。普通地柜邻接 vanity 时，普通柜相邻侧视为外露；vanity 侧仍按自身规则判断。
- `stuffed_gap` 与 `gaplike_item` 的更精确业务边界仍然在开发中，标记为**待确认**。

## Exposure

- 墙的 `exposedLeft`、`exposedRight`、`exposedBack` 分别表示左右边缘和背面是否外露。
- `connectedWallIds` 不参与物料算法的 exposure 判断；它不能替代三个 exposed 标志。
- 左右侧 exposure 还受相邻块影响：大开口、`stuffed_gap` 和 `gaplike_item` 不遮挡；普通柜或电器通常遮挡相邻侧；filler 在判断时被越过。
- `exposedBack=true` 会让 QR/CM 计入背边；`exposedBack=false` 时才计算相应的 SM 墙缝。
- 墙宽应分别等于空中轨和地面轨的块宽总和；不一致时算法返回 warning，但仍生成清单。

## 物料

- 原柜体/可售件之外，算法生成 DWP、RRP、BEP、VEP、WEP、PNL3696Q、TK、QR、SM、CM。
- DWP 是需台面的地面电器框侧；贴不外露墙边的一侧可省略。RRP 是高电器叠放吊柜时的框侧；无叠放吊柜不生成。
- 外露普通地柜侧用 BEP，vanity 地柜用 VEP，吊柜用 WEP，高柜及 RRP 框侧用 PNL3696Q。DWP 外露框侧在 UNIPACK 色用 PNL3696Q，其他颜色用 BEP。
- UNIPACK 色 `02/04` 的柜体美化侧板会跳过；缺色不等同 UNIPACK，仍生成无颜色前缀的物料并给需要颜色的分类 warning。
- TK、QR、SM、CM 按颜色分别累计英寸并以每根 96 英寸向上取整。TK 覆盖地柜、高柜和 filler 正面相互之间的缝隙；QR 覆盖物体与地面的接缝，SM 是背墙未外露时的竖向接缝，CM 是空中物体顶线/周边接缝。
- 计算常量为地柜高 34.5、普通地柜深 24、vanity 深 21、吊柜深 12、高柜/高电器深 24（单位英寸）。缺失高度默认：吊柜 30、叠放吊柜 15、高柜/高电器 96。
