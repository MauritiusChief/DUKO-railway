# Railway CLI Windows WSL 设置指南

在 Windows 11 上，尽管可以通过 npm 安装 Railway CLI，但安全策略通常会阻止其执行。推荐通过 WSL 2 运行 Railway CLI。

## 1. 安装 WSL 2

在 **管理员 PowerShell** 中执行：

```powershell
wsl --install -d Ubuntu
```

按提示重启系统。重启后会自动启动 Ubuntu，设置 Linux 用户名和密码。

安装完成后检查版本：

```bash
wsl -l -v
```

确保 Version 列为 `2`。若不是：

```powershell
wsl --set-version Ubuntu 2
```

之后日常在 **常规 PowerShell / Windows Terminal** 中输入 `wsl` 即可进入 Linux 环境。

## 2. 安装 Railway CLI

在 WSL 终端中使用官方安装脚本：

```bash
curl -fsSL agents.railway.com | sh
```

该脚本会自动检测 WSL 环境并完成安装。安装后可直接使用 `railway` 命令。

## 3. Railway 登录

```bash
railway login
```

会自动打开浏览器进行 OAuth 授权（通过 Windows 宿主机的浏览器完成）。按提示授权即可。

之后可在 WSL 终端中验证登录状态：

```bash
railway whoami
```

## 4. 配置 SSH（Volume 管理必需）

Railway CLI 管理 Volume 依赖 SSH 连接。若你未配置过 SSH，流程如下：

### 4.1 生成密钥对

```bash
ssh-keygen -t ed25519
```

- 提示保存位置：直接回车使用默认路径 `~/.ssh/id_ed25519`
- 提示 passphrase：直接回车留空（或输入你记得住的密码）

### 4.2 通过 Railway 自动注册公钥

```bash
railway ssh --project=<项目ID> --environment=production --service=<服务ID>
```

首次连接时会出现提示：

```
No SSH keys registered with Railway.
Key: <用户名>@<机器名> (SHA256:...)
> Register this SSH key with Railway? Yes
```

选择 **Yes**，Railway 自动将公钥上传到你的账户。

随后提示信任主机指纹：

```
The authenticity of host 'ssh.railway.com (...)' can't be established.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

输入 `yes` 并回车。

> 项目 ID 可在 `railway link` 后在 `railway.json` 中查看，也可通过 `railway project list` 和 `railway environment list` 获取。

之后 `railway volume browse /` 和 `railway ssh` 即可直接使用，无需重复配置。

## 5. 从 Windows 主机复制文件到 WSL

在 WSL 中，Windows 的各个盘符挂载在 `/mnt/` 下：

```bash
# 复制单个文件
cp /mnt/c/Users/<你的Windows用户名>/Downloads/Product-raw.csv ~/

# 复制整个目录
cp -r /mnt/c/Users/<你的Windows用户名>/path/to/dir ~/
```

此后可在 WSL 中使用 `railway volume browse /` 将文件上传到 Railway Volume 的 `/data` 目录。

## 6. 使用 Volume

### 6.1 TUI 文件浏览器

```bash
railway volume browse /
```

进入后导航到 `/data`，支持交互式上传、下载、删除文件。

### 6.2 进入远程 Shell

```bash
railway ssh
```

进入后可执行 `ls /data`、`node server/dist/refresh-data-cli.js` 等远程命令。

> 关于 `railway volume` 的更详细用法（`upload`、`download` 等子命令），请参阅 [Railway CLI 官方文档](https://docs.railway.com/cli)。

## 7. 本地刷新数据后上传到 Volume

若 `refresh-data-cli` 在 Railway 上因 embedding 生成等步骤耗时过长，可在本地完成刷新后再上传产物。详见 [RAILWAY_SETUP.md](./RAILWAY_SETUP.md#本地刷新后上传当-railway-远程刷新耗时过长时)。
