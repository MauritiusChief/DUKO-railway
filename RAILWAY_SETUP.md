# Railway 部署设置说明

## 前置条件

- GitHub 仓库已包含本项目的所有代码
- Railway 账号已就绪
- 已准备好 `Product-raw.csv` 文件

## 1. 导入项目到 Railway

1. 登录 [Railway Dashboard](https://railway.app)
2. 点击 **New Project** → **Deploy from GitHub repo**
3. 选择本仓库
4. 区域选择 **US East**（全美用户）或 **US West**（西海岸用户偏多）

## 2. 添加 Volume（持久化数据）

1. 在项目页面，点击 **+ Add** → **Volume**
2. 挂载路径设为 `/data`
3. 大小根据 CSV 数据量估算（建议至少 2 GB）

## 3. 配置环境变量

在 Service → **Variables** 中添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `NODE_ENV` | `production` | 生产模式 |
| `DB_DIR` | `/data` | 数据持久化目录 |
| `AUTO_PROCESS` | `false` | 不自动执行数据处理 |
| `AUTO_INGEST` | `false` | 不自动导入数据 |
| `CHAT_LOG` | `false` | 不写对话日志 |
| `DEEPSEEK_API_KEY` | `sk-...` | DeepSeek API 密钥 |
| `OPENROUTER_API_KEY` | `sk-or-...` | OpenRouter API 密钥 |
| `OPENROUTER_MODEL` | `qwen/qwen3.7-plus` | 默认模型 |
| `JWT_ACCESS_SECRET` | (随机字符串) | Access Token 签名密钥 |
| `JWT_REFRESH_SECRET` | (另一随机字符串) | Refresh Token 签名密钥 |
| `ADMIN_USERNAME` | (管理员用户名) | 管理员账号 |
| `ADMIN_PASSWORD` | (强密码，≥8位) | 管理员密码 |

> 不要手动设置 `PORT`，Railway 会自动注入。

## 4. 部署

项目根目录已配置 `railway.json`（Nixpacks 构建器）。Railway 会自动：

1. 构建 client（Vite）
2. 构建 script（rspack）
3. 构建 server（TypeScript）
4. 启动 Express 服务

首次部署后，服务应能启动（首页可打开），但 SKU 数据尚未加载。

## 5. 上传 Product-raw.csv 到 Volume

通过 Railway CLI 的 `railway volume browse /` 命令（TUI 文件管理器）将本地 `Product-raw.csv` 上传到 Volume 的 `/data` 目录。

1. 确保已安装 Railway CLI 并完成 SSH 配置
2. 执行 `railway volume browse /`
3. 在 TUI 中导航至 `/data`
4. 上传 `Product-raw.csv`

> **Windows 用户**：需在 WSL 中安装 Railway CLI，详见 [RAILWAY_SETUP_WSL.md](./RAILWAY_SETUP_WSL.md)。
>
> 关于 `railway volume` 的更多用法，请参阅 [Railway CLI 官方文档](https://docs.railway.com/cli)。

## 6. 运行数据刷新

在 Railway Shell 中执行：

```bash
# 确认环境变量
echo $DB_DIR

# 运行完整数据刷新管线
node server/dist/refresh-data-cli.js
```

该命令依次执行：
- 清洗 Product-raw.csv → Product.csv
- 衍生 Color.csv、Parts.csv、Items.csv
- 生成 Exposed-Items.csv、Exposed-Color.csv、Exposed-Types.csv
- 导入 SQLite (`/data/sku.sqlite`)
- 导入 LanceDB (`/data/sku.lance/`)
- 加载全部引用表
- 预热 BM25 索引

成功后输出各项记录数汇总。

### 本地刷新后上传（当 Railway 远程刷新耗时过长时）

若 `refresh-data-cli` 在 Railway 上因 embedding 生成等步骤耗时过久（如超过 30 分钟），可在本地完成刷新，再将产物上传到 Volume：

1. **准备本地环境**

   ```bash
   export DB_DIR=./local_data
   mkdir -p $DB_DIR
   cp /path/to/Product-raw.csv $DB_DIR/
   ```

2. **本地运行刷新**

   ```bash
   # 确保依赖已安装
   npm run build
   node server/dist/refresh-data-cli.js
   ```

3. **上传产物到 Railway Volume**

   刷新完成后，`DB_DIR` 下生成的关键产物：

   | 文件/目录 | 说明 | 必须上传 |
   |-----------|------|:---:|
   | `sku.sqlite` + `-wal` + `-shm` | SKU 结构化数据 | ✅ |
   | `sku.lance/` | LanceDB 向量库 | ✅ |
   | `Product-raw.csv` ~ `Exposed-Types.csv` 等中间 CSV | 已入 SQLite，可选保留 | ❌ |
   | `users.sqlite` | 由 Web Service 启动时自动创建 | ❌ 无需上传 |

   使用 `railway volume browse /` 进入 Volume TUI，导航至 `/data`，仅上传 `sku.sqlite*` 和 `sku.lance/` 目录即可。

4. **重启 Railway Web Service**（在 Dashboard 中点击 Redeploy）

   服务启动时会自动创建 `users.sqlite` 并从环境变量中初始化管理员账号。

## 7. 重启服务

数据刷新完成后，重启 Web Service 使运行中的进程重新加载最新 SQLite 和 LanceDB 数据：

1. 在 Railway Dashboard 中点击服务旁的 **Redeploy** 或 **Restart**
2. 等待服务重新变为 Healthy

## 8. 验证清单

部署完成后逐项检查：

- [ ] 首页可打开（显示登录页面）
- [ ] 管理员可以登录
- [ ] 登录后 cookie refresh 正常（无需频繁重新登录）
- [ ] `/api/script/download` 可下载 Tampermonkey 脚本
- [ ] SKU 搜索返回真实结果（测试 `/api/check-exposed`）
- [ ] Table parse 功能可用
- [ ] Product generation 可用
- [ ] Image parse 可用
- [ ] Chat 中的产品查询工具可用
- [ ] 重新部署后 `/data` 下数据未丢失（Volume 持久化验证）
- [ ] 服务重启后用户和 SKU 数据未丢失

## 常见问题

### 数据刷新失败
- 确认 `Product-raw.csv` 已放入 `/data`
- 确认文件编码为 UTF-8
- 在 Shell 中检查 `ls -la /data/` 确认文件存在
- 查看命令输出中的具体错误信息

### 服务启动失败
- 检查环境变量是否全部配置
- 确认 `JWT_ACCESS_SECRET` 和 `JWT_REFRESH_SECRET` 不同且非示例值
- 确认 `ADMIN_PASSWORD` 长度 ≥ 8 位

### 绑定自定义域名
部署稳定后，在 Railway Dashboard → Settings → Custom Domain 中添加域名，并按提示配置 DNS（CNAME 记录）。
