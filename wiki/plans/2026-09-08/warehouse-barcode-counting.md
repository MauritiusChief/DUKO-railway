# 仓库条形码点数

状态：已实现。实施偏差见文末「实施记录」。

## 目标

在 DUKO 中实现面向 Android Chrome 的仓库扫码点数功能：每次确认录入必须取得一个型号序列号和一个产品序列号；产品序列号全局唯一；数据由服务端 SQLite 持久化，不再依赖浏览器 localStorage。

功能覆盖：

1. 新增仅能使用扫码页的 `warehouse` 用户角色。
2. 维护型号序列号与 SKU 的一对一映射，以及所有产品扫码记录。
3. 支持手机后置摄像头拍照扫码；单张图片最多接受一个型号序列号与一个产品序列号。
4. 为管理员和经理提供扫码记录管理、映射维护、日期聚合及 JSON 导入。

## 非目标

- 不写入 Odoo，不修改现有库存 CSV、库存看板或 auto worker。
- 不直接读取浏览器 localStorage；原型数据只能先由原型页面导出 JSON，再导入正式系统。
- 不引入持续显示摄像头预览、第三方扫码 SDK 或手机振动。
- 本阶段不提供 JSON 导出、盘点任务/批次、目标数量或差异计算。

## 已核验现状

- 客户端是 React 18/Vite SPA，生产时由 Express 从 `client/dist/` 提供；路由事实源为 `client/src/App.tsx`。
- 服务端使用 `users.sqlite` 保存账户、`sku.sqlite` 保存全局 SKU/库存域数据。`sku.sqlite` 适合保存全局仓库数据，且当前 SKU refresh 仅替换其既有业务表，不会整体删除数据库文件。
- 当前角色为 `admin | manager | user`，用户表已有版本化迁移基础；所有受保护 API 在 `server/src/index.ts` 统一认证后挂载。
- 原型 `experiment/warehouse_count_helper_cn.html` 已验证：
  - 型号格式为 `^[A-Z]{2}-[A-Z]{2}-\d{6}$`，例如 `DK-CA-002919`。
  - 产品格式为 `^[A-Z]{2}-[A-Z0-9]{8}-\d{6}$`，例如 `DK-P0016073-347836`。
  - `BarcodeDetector` 可对拍摄图片返回多个 `rawValue`，原型已有无预览的 `input[type=file][capture=environment]` 入口。
- 根目录已有 `ecosystem.config.cjs`：PM2 从 `server/` 运行 `dist/index.js`，监听 `3023`；没有其他 PM2 文档或配置。

## 已确认业务规则

1. 型号序列号与 SKU 一一对应。
2. 未知型号不阻止扫码录入：创建 `型号序列号 -> 型号序列号` 的映射作为 SKU 占位。管理员或经理随后将映射右侧改为实际 SKU。
3. 每次录入都必须扫描到两个条码，顺序不限；服务端成功写入后前端清空本轮状态。
4. 产品序列号全局唯一，不允许重复。重复时显示原记录的 SKU、型号与扫描时间，不振动。
5. 管理页编辑一条扫描记录的型号序列号，任何时候都只影响该记录，不同步修改其他扫描记录或全局映射。
6. 管理员和经理可以删除扫描记录，无额外审计表。
7. 扫描时间以 UTC 保存；日期/时段控件按使用设备本地时区生成查询边界并转换为 UTC。因此不同时区使用者可能看到不同的“某日”汇总，这是接受的行为。

## 数据设计

在 `sku.sqlite` 增加且仅增加以下两张仓库业务表。

### `model_seri_num_mappings`

| 列 | 规则 |
| --- | --- |
| `model_seri_num` | 型号序列号，主键，规范化为大写 |
| `sku` | 非空、大小写不敏感唯一；新型号时等于 `model_seri_num`，表示待确认占位 |
| `created_at` / `updated_at` | 服务端 UTC ISO-8601 时间 |

不单设“占位”布尔列：`sku === model_seri_num` 即为占位映射。汇总和扫码页在该情况下显示型号序列号，并标记“待确认 SKU”。

### `product_seri_num_records`

| 列 | 规则 |
| --- | --- |
| `product_seri_num` | 产品序列号，主键；不增加独立数值 ID |
| `model_seri_num` | 非空外键，引用 `model_seri_num_mappings.model_seri_num` |
| `scanned_at` | 服务端 UTC ISO-8601 时间 |

- 为 `scanned_at DESC`、`model_seri_num` 建索引；产品序列号主键已覆盖重复检查与精确筛选。
- `initSkuDB()` 必须启用 `PRAGMA foreign_keys = ON`；否则 SQLite 不会执行下述外键约束或级联更新。
- 映射表修改型号序列号时，外键使用 `ON UPDATE CASCADE`，以维持全局映射和已有记录的一致性。这不是“编辑某条扫描记录”：后者仅更新该条记录，且绝不触发批量修改。
- 扫描记录修改到不存在的型号时，先在同一事务创建 `型号 -> 型号` 占位映射，再更新该记录。
- 映射表不提供删除入口，避免产生无映射的扫描记录；扫描记录的删除不删除映射。

## 权限与认证

1. 角色扩展为 `admin | manager | warehouse | user`，并在 `users.sqlite` 增加新的幂等迁移，重建旧 CHECK 约束。
2. 管理员账户管理可将非管理员设置为 `user`、`manager` 或 `warehouse`；不得授予或修改 `admin`。
3. `warehouse` 只可访问 `/warehouse-scan` 及录入一组扫码记录所需 API；首页和其他业务 API 均由服务端返回 403。
4. `manager`、`admin` 可访问扫码页、映射维护与 `/warehouse-manage`；`user` 无仓库访问权。
5. 认证中间件在验证 JWT 后读取当前数据库用户与角色，角色降级或删除账号后立即生效，不延续现有 access token 中最多 15 分钟的旧权限。

## API 方案

新增 `server/src/routes/warehouse.ts` 并在全局认证后注册。所有输入经 Zod 校验、服务端规范化和数据库事务处理；不相信客户端提供的 SKU、时间或操作者。

| 接口 | 权限 | 行为 |
| --- | --- | --- |
| `POST /api/warehouse/scans` | warehouse/manager/admin | 提交型号和产品序列号；必要时建占位映射；写入成功返回记录及当前 SKU |
| `GET /api/warehouse/mappings` | manager/admin | 查询映射及待确认项 |
| `PATCH /api/warehouse/mappings/:modelSeriNum` | manager/admin | 修改 SKU 或全局映射型号；保证一对一关系 |
| `GET /api/warehouse/scans` | manager/admin | 三列交集筛选、UTC 时间范围、分页及扫描记录列表 |
| `PATCH /api/warehouse/scans/:productSeriNum` | manager/admin | 仅修改该记录的型号或产品序列号 |
| `DELETE /api/warehouse/scans/:productSeriNum` | manager/admin | 删除指定扫描记录，需前端确认 |
| `GET /api/warehouse/summary` | manager/admin | 按时间范围汇总 `SKU（或型号占位）` 与数量 |
| `POST /api/warehouse/imports/validate` | manager/admin | 校验 JSON、返回导入预览与映射冲突 |
| `POST /api/warehouse/imports` | manager/admin | 按经确认的替换或合并决策，在事务中写入数据 |

`POST /api/warehouse/scans` 对重复产品序列号返回 `409` 和原记录摘要。该端点应使用专用、有上限的扫码限流，避免通用 API 每 15 分钟 500 次的限制阻断约 1,000 条现场点数，同时仍保留防滥用保护。

## 扫码页面

新建 `WarehouseScanPage.tsx` 和独立移动端 CSS。

1. 页面仅保留大号“扫描条码”按钮、当前型号/产品/SKU 状态、确认录入、清空本轮和结果提示。
2. 点击按钮触发后置相机图片捕获，不在页面显示持续摄像头画面。
3. 使用 feature detection 初始化浏览器 `BarcodeDetector`；未提供该 API、相机权限失败或未识别时展示可操作的错误信息。
4. 每次图片解码先收集全部条码：只接受至多一个符合型号格式的值和至多一个符合产品格式的值。额外条码、两个同类型有效值或格式外条码均使整次扫码无效，不改变本轮已扫描值。
5. 当本次识别恰好只有一个有效序列号，且当前待录入的型号与产品序列号均已有内容时，先清空两项及本轮 SKU 状态，再填入本次扫描值。该规则用于在尚未写入时发现两码错误匹配后，开始下一件的重新扫描。
6. 两种序列号可一次拍到，也可分两次拍到；只有两者均已得到且通过服务端写入后，才完成一条记录并清空页面。
7. 经理和管理员在此页额外看到映射编辑入口；仓库角色只能看到映射结果及待确认提示，不能改映射。

## 管理页面

新建 `WarehouseManagePage.tsx` 和独立 CSS，仅限经理和管理员。

1. 顶部提供本地日期整日或本地时间区间选择；客户端把边界转换为 UTC ISO 时间传给 API，页面时间使用 `toLocaleString()` 显示。
2. 顶部汇总表固定两列：`SKU/型号序列号` 和数量。未确认映射显示型号序列号。
3. 扫描记录表默认折叠，显示 SKU（只读）、型号序列号、产品序列号、扫描时间与操作。SKU、型号、产品的三个文本筛选按交集处理。
4. 扫描记录支持逐行编辑型号和产品序列号，以及删除；编辑型号不传播到任何其他扫描记录。
5. 映射表作为另一个默认折叠区域，专门维护 SKU 与型号序列号的全局一对一关系，并突出 `SKU = 型号序列号` 的待确认项。

## JSON 导入

导入只接受 `experiment/warehouse_count_helper_cn.html` 已导出的单一 JSON 文件，由管理页读取文件文本并提交给服务端，不新增文件上传中间件。必须兼容原型实际导出的以下结构：

```json
{
  "app": "warehouse-count-helper",
  "version": 1,
  "exportedAt": "2026-09-08T08:30:00.000Z",
  "formats": {
    "model": "^[A-Z]{2}-[A-Z]{2}-\\d{6}$",
    "product": "^[A-Z]{2}-[A-Z0-9]{8}-\\d{6}$"
  },
  "records": [
    {
      "id": "原型本地 ID",
      "sku": "SKU-001",
      "model": "DK-CA-002919",
      "product": "DK-P0016073-347836",
      "createdAt": "2026-09-08T08:30:00.000Z",
      "updatedAt": ""
    }
  ]
}
```

导入流程：

1. 校验根对象的 `app = warehouse-count-helper`、`version = 1` 和 `records` 数组；`formats`、`exportedAt` 仅作原型元数据保留，不以其中正则替代服务端固定校验规则。
2. 对每个原型记录严格验证 `model`、`product` 和 `createdAt`；`id` 与 `updatedAt` 没有正式表对应列，导入时忽略。
3. 从每条记录的 `sku + model` 自动推导 `model_seri_num_mappings`：`model` 写入 `model_seri_num`；有 SKU 时写入 `sku`；SKU 为空时写入 `model -> model` 占位映射。
4. 将 `product` 写入 `product_seri_num_records.product_seri_num`，`model` 写入 `model_seri_num`，`createdAt` 原样规范化为 UTC 后写入 `scanned_at`。
5. 在导入预检中验证推导后的型号/SKU 一对一关系、产品序列号唯一性，以及每条扫描记录都有对应映射。
6. 用户选择“替换”或“合并”。替换模式在完整校验通过后，于单一事务中清空并写入两表；任一错误均不改变现有数据。
7. 合并模式跳过已存在且内容完全相同的产品序列号；产品序列号内容不同或任一型号/SKU 映射冲突时不自动覆盖，先显示冲突并要求选择保留现有或采用导入映射后再提交。

## 本地 PM2 与手机测试

PM2 只负责常驻运行构建后的 Express 服务。本地手机测试限定为电脑与手机处于同一可信 Wi-Fi，服务不通过公网隧道暴露。

### 准备

1. 使用隔离的本地测试数据目录和测试账号，不连接生产 Railway Volume，也不执行数据处理、数据库重建或 Odoo 自动化。
2. 在仓库根目录分别构建客户端和服务端：

```powershell
npm --prefix client run build
npm --prefix server run build
```

3. 使用现有 PM2 配置启动，PM2 的 `cwd` 已指向 `server/`：

```powershell
pm2 start ecosystem.config.cjs --only duko-advance
pm2 status
pm2 logs duko-advance
```

4. 本机先访问 `http://127.0.0.1:3023`，确认登录页和静态资源可用。不要执行 `pm2 save`，避免把本地测试服务注册为开机常驻任务。

### 在同一 Wi-Fi 测试

1. 确认电脑和手机连接同一可信 Wi-Fi，且该 Wi-Fi 未启用客户端隔离。
2. 查看电脑局域网 IPv4 地址，并在手机 Android Chrome 打开：

```powershell
Get-NetIPAddress -AddressFamily IPv4
```

```text
http://<电脑局域网 IPv4>:3023
```

3. Windows 防火墙只在“专用网络”配置文件开放入站 TCP `3023`；排查步骤见 [Windows 局域网手机测试](../../windows-lan-mobile-testing.md)。
4. 手机首次使用扫码入口时允许 Chrome 相机权限；测试完成后关闭 PM2 服务并移除临时防火墙规则。

### 手机验收用例

1. 仓库角色登录后只能使用扫码页，直接输入其他业务 URL 会被拒绝。
2. 依次扫描已映射型号和新产品，确认后得到一条记录且页面清空。
3. 扫描未知型号和新产品，成功写入 `型号 -> 型号` 占位映射；经理随后改为实际 SKU，汇总即时改用 SKU。
4. 一张图片含一个型号和一个产品时可填充两项；含额外或不符合格式条码时不写入也不替换本轮状态。
5. 重扫已有产品序列号时得到重复提示，记录数量不变。
6. 以两个不同设备时区验证同一 UTC 记录的本地显示和按日汇总边界符合已确认语义。
7. 使用替换、合并、映射冲突和重复产品序列号 JSON 分别验证预览、确认和事务回滚。

测试完成后停止本地进程：

```powershell
pm2 delete duko-advance
```

## 实施顺序与验证

1. 完成角色迁移、认证即时角色读取和前后端守卫。
2. 创建两张表、数据访问函数、格式规范化、事务及数据库测试。
3. 完成仓库 API、权限测试、重复/并发写入测试与专用限流。
4. 实现扫码页，并先以手工构造的 API 请求验证状态机和重复处理。
5. 实现管理页、UTC 查询、汇总和逐行编辑语义。
6. 实现 JSON 校验、冲突预览及替换/合并事务。
7. 执行 `npm --prefix server test`、`npm --prefix client run build`、`npm --prefix server run build`，再按本计划进行 PM2 手机验收。
8. 同步 `wiki/server/auth-and-persistence.md`、`wiki/server/data-and-search.md`、`wiki/client/README.md`，并新增仓库扫码专题文档，记录 API、权限、占位映射、UTC 和 JSON 契约。

## 风险与回滚

- 扫码记录和 JSON 包含仓库业务数据；不得写入日志、Git、Issue 或测试夹具。导入前端预览只展示必要字段。
- 映射型号的全局重命名会因外键级联修改关联记录，应在 UI 明确显示影响数量并二次确认；单条扫描记录编辑没有此行为。
- 替换导入会清空全部仓库数据，必须显示记录数和不可逆确认；任何校验或写入失败都由事务回滚。
- 局域网测试依赖 Windows 防火墙、同一网段和 Wi-Fi 客户端隔离设置；排查时只开放专用网络的 TCP `3023`，测试结束后删除临时规则。
- 回滚代码时保留新增 SQLite 表和业务数据；旧服务会忽略未知表。若未来需要删除这两张表，应先备份一致的 SQLite 数据库文件并获得明确的数据删除授权。

## 实施记录（2026-09-09）

已按「实施顺序与验证」完成步骤 1-6 与 8（文档同步：`wiki/server/auth-and-persistence.md`、`wiki/server/data-and-search.md`、`wiki/client/README.md` 及新增专题页 `wiki/server/warehouse-scan.md`）。与计划的偏差和补充决定：

1. **认证**：`authenticateToken` 每请求从 `users.sqlite` 读取当前用户与角色已落地；顺带让 `/api/auth/refresh` 也以数据库为准签发新 token（计划只要求中间件）。删除账号现在即刻终止会话，原「删除账号可能继续刷新会话」的高风险边界已消除；修改密码仍不撤销已签发 token（接受到自然过期）。
2. **前端守卫**：原 `AuthGuard` 已删除，业务路由统一改用 `RoleGuard` 角色列表；角色不匹配时 `warehouse` 引导到扫码页、其余跳 `/login`（实施中调整，替代原「跳回主页」行为）。仓库角色登录后默认进入扫码页。
3. **筛选语义**（计划未指定）：管理页三列文本筛选为大小写不敏感子串匹配；时间边界为含端点的 UTC 比较。
4. **接口补充决定**：`PATCH /mappings/:modelSeriNum` 的 `sku` 与 `newModelSeriNum` 严格二选一；`GET /mappings` 返回 `record_count` 供重命名前显示影响数量；合并导入中现有占位映射自动升级为导入 SKU，不算映射冲突。
5. **测试**：按用户决定未编写 vitest 自动化测试（原步骤 2/3 的「数据库测试」「权限测试」未以测试套件形式落地），改为每个阶段以一次性临时库冒烟脚本验证（构建产物外、验证后删除），共覆盖数据层语义、schema 行为与导入事务回滚；HTTP 层行为留待步骤 7 真机验收。步骤 7（三个构建命令后的 PM2 本地启动、同 Wi-Fi 手机验收用例 1-7、测试后 `pm2 delete` 且不 `pm2 save`）已由使用者手动执行。
6. **扫码轮次替换**（2026-09-09 后续决定）：合法结果与本轮已填同类型槽位冲突时，不再丢弃当前图片；改为丢弃旧轮次，并以当前图片识别到的一个或两个合法序列号重建本轮。格式外、多码或未识别等无效图片仍不改变本轮。
