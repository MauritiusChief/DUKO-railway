# DUKO Chat 安装与启动指南

## 环境要求

- **Node.js** >= 18（推荐 20+）
- **npm**（随 Node.js 自带）
- **PM2**（生产环境推荐，可选）

## 1. 获取项目

```bash
git clone <repo-url> DUKO-quotheboss
cd DUKO-quotheboss
```

## 2. 安装依赖

```bash
cd server
npm install

cd ..\client
npm install

cd ..
```

## 3. 配置 API Key

```bash
copy server\.env.example server\.env
```

编辑 `server\.env`，将 `DEEPSEEK_API_KEY` 替换为你的真实 key：

```
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
PORT=3022
```

> API Key 获取地址：https://platform.deepseek.com/api_keys

## 4. 启动

### 方式 A：开发模式（前后端分离，推荐调试用）

开两个终端：

```bash
# 终端 1 - 后端
cd server
npm run dev
# 输出: Server running on http://localhost:3022

# 终端 2 - 前端
cd client
npm run dev
# 输出: http://localhost:5272
```

浏览器访问 `http://localhost:5272`。前端自动代理 `/api` 请求到后端 `:3022`。

### 方式 B：生产模式（单端口，推荐日常使用）

```bash
# 构建前端
cd client
npm run build

# 构建后端
cd ..\server
npm run build

# 启动服务
npm start
# 输出: Server running on http://localhost:3021
```

浏览器访问 `http://localhost:3021`。后端直接 serve 前端 + API，只需一个端口。

### 方式 C：PM2 守护进程（推荐长期运行）

```bash
# 全局安装 PM2（仅首次）
npm install -g pm2

# 构建（如已执行过可跳过）
cd client
npm run build

cd ..\server
npm run build

# 启动
cd ..
pm2 start ecosystem.config.cjs

# 设置开机自启
pm2 save
pm2 startup
```

常用 PM2 命令：

```bash
pm2 status          # 查看运行状态
pm2 logs duko-chat  # 查看日志
pm2 restart duko-chat
pm2 stop duko-chat
```

#### PM2 定时开关机（通过 Windows 任务计划）

项目已内置两个辅助脚本：

- `scripts\pm2_stop.ps1` — 关闭 `duko-chat` 服务
- `scripts\pm2_start.ps1` — 启动 `duko-chat` 服务

以下所有 `schtasks` 命令在 PowerShell 中**一行运行**。

**查看已有定时任务：**

```powershell
schtasks /Query /TN "PM2-Stop-DUKO" /V /FO LIST
schtasks /Query /TN "PM2-Start-DUKO" /V /FO LIST
# GUI：Win+R → taskschd.msc
```

**创建定时任务（每天触发）：**

```powershell
schtasks /Create /SC DAILY /TN "PM2-Stop-DUKO" /TR "powershell -ExecutionPolicy Bypass -NoProfile -File `"T:\he\path\to\DUKO-quotheboss\scripts\pm2_stop.ps1`"" /ST 17:30 /F
schtasks /Create /SC DAILY /TN "PM2-Start-DUKO" /TR "powershell -ExecutionPolicy Bypass -NoProfile -File `"T:\he\path\to\DUKO-quotheboss\scripts\pm2_start.ps1`"" /ST 08:30 /F
```

**排除周日（仅周一至周六）：**

```powershell
schtasks /Create /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /TN "PM2-Stop-DUKO" /TR "powershell -ExecutionPolicy Bypass -NoProfile -File `"T:\he\path\to\DUKO-quotheboss\scripts\pm2_stop.ps1`"" /ST 17:30 /F
schtasks /Create /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /TN "PM2-Start-DUKO" /TR "powershell -ExecutionPolicy Bypass -NoProfile -File `"T:\he\path\to\DUKO-quotheboss\scripts\pm2_start.ps1`"" /ST 08:30 /F
```

**删除定时任务：**

```powershell
schtasks /Delete /TN "PM2-Stop-DUKO" /F
schtasks /Delete /TN "PM2-Start-DUKO" /F
```

**手动测试运行：**

```powershell
schtasks /Run /TN "PM2-Stop-DUKO"
schtasks /Run /TN "PM2-Start-DUKO"
```

**修改触发时间：**

```powershell
schtasks /Change /TN "PM2-Stop-DUKO" /ST 18:00
```

**参数速查：**

| 参数 | 含义 |
|------|------|
| `/SC` | 频率：DAILY / WEEKLY |
| `/D` | 星期几，逗号分隔（仅 WEEKLY 有效） |
| `/TN` | 任务名称 |
| `/ST` | 触发时间，24 小时制 HH:MM |
| `/F` | 强制覆盖同名任务 |

**常见日程组合：**

| 需求 | 参数 |
|------|------|
| 排除周日 | `/SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT` |
| 仅工作日 | `/SC WEEKLY /D MON,TUE,WED,THU,FRI` |
| 仅周末 | `/SC WEEKLY /D SAT,SUN` |
| 日期范围 | `/SC DAILY /SD 2026/07/01 /ED 2026/08/31` |

## 5. 导入向量数据库（仅限管理员）

联网（内网）访问的 RAG 功能依赖本地向量数据库，首次使用前需导入 SKU 数据。

### 准备 Excel/CSV 文件

确保前几列包含以下字段（大小写不敏感）：

| 列名 | 说明 |
|------|------|
| Name | 产品名称 |
| Description | 产品描述 |
| Alias | 别名、常见误称 |

### 执行导入

```bash
cd server
npm run db:ingest -- "path\to\sku_data.xlsx"
```

示例输出：

```
Initializing vector database...
Ingesting data from: D:\data\sku_list.xlsx
Done. Imported 2500 records. Total in DB: 2500
```

> 首次运行时 `@huggingface/transformers` 会自动下载 embedding 模型（~23MB），需要网络连接。
> 导入完成后数据存储在 `server/src/data/sku.lance/`，已加入 `.gitignore`。

## 6. 局域网访问

1. 确保防火墙允许 `3021` 端口入站（生产环境）
2. 获取本机局域网 IP：

   ```bash
   ipconfig | findstr IPv4
   ```

3. 局域网内其他设备访问：`http://<本机IP>:3021`

### Windows 防火墙放行（管理员权限）

```powershell
New-NetFirewallRule -DisplayName "DUKO Chat" -Direction Inbound -Protocol TCP -LocalPort 3021 -Action Allow
```

### Windows 网络配置文件设为"专用"

公用网络配置文件的防火墙默认更严格，可能导致即使添加了放行规则也无法从局域网访问。需将当前 WiFi 网络设为专用：

1. 打开 **设置 → 网络和 Internet → Wi-Fi**
2. 点击当前连接的 Wi-Fi 名称旁的 **属性**
3. 将 **网络配置文件类型** 从"公用"改为"**专用**"

或通过 PowerShell（管理员权限）：

```powershell
Get-NetConnectionProfile | Where-Object {$_.NetworkCategory -eq 'Public'} | Set-NetConnectionProfile -NetworkCategory Private
```

## 7. 更新项目

```bash
git pull

# 重新构建
cd client
npm install
npm run build

cd ..\server
npm install
npm run build

# 重启（PM2）
pm2 restart duko-chat
```
