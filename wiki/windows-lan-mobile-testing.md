# Windows 局域网手机测试

本页用于排查 Windows 电脑以 PM2 运行 DUKO 后，Android 手机或 iOS 17+ iPhone 在同一可信 Wi-Fi 内无法访问本地测试页面的问题。

## 适用范围

- 电脑和手机连接同一可信 Wi-Fi。
- PM2 运行根目录 `ecosystem.config.cjs` 中的 `duko-advance` 服务。
- 客户端和服务端已构建；Express 在 `3023` 提供页面和 `/api`，不需要启动 Vite 的 `5273` 开发服务器。
- 使用测试账号和隔离的本地数据目录，不连接生产数据或运行 Odoo 自动化。

## 启动与本机检查

从仓库根目录构建并启动：

```powershell
npm --prefix client run build
npm --prefix server run build
pm2 start ecosystem.config.cjs --only duko-advance
pm2 status
pm2 logs duko-advance
```

先在电脑浏览器访问 `http://127.0.0.1:3023`。本机无法打开时，先从 `pm2 logs duko-advance` 排查服务启动、数据库目录和配置错误。

确认服务正在监听 `3023`：

```powershell
Get-NetTCPConnection -LocalPort 3023 -State Listen
```

预期监听地址包含 `0.0.0.0:3023` 或电脑的局域网 IPv4，而不应只监听 `127.0.0.1:3023`。

## 连接手机

1. 在 Windows 终端查看 Wi-Fi 网卡的 IPv4 地址：

```powershell
Get-NetIPAddress -AddressFamily IPv4
```

优先选择常见的私有局域网地址，例如 `192.168.x.x`、`10.x.x.x` 或 `172.16.x.x` 到 `172.31.x.x`；不要使用 `127.0.0.1`、虚拟网卡、VPN 或断开网络的地址。

2. 确认手机与电脑使用相同 Wi-Fi 名称，关闭手机移动数据和电脑 VPN 后重试，避免请求走到其他网络。
3. 在手机 Android Chrome，或 iOS 17+ 的 Safari/Chrome 打开：

```text
http://<电脑局域网 IPv4>:3023
```

4. 点击扫码后通过系统照片选择器拍照或选图。Android Chrome 与 iOS 浏览器均应能完成此流程；iPhone 不要求安装 Chrome。条码解码在服务端完成，手机只上传压缩后的照片。
5. iOS 验收至少覆盖 Safari、实际仓库标签、拍照及照片库中的 HEIC/JPEG 图片。Chrome on iOS 可作为可选的额外回归浏览器。

## Windows 网络和防火墙

### 网络配置文件

本地测试 Wi-Fi 应为 Windows “专用”网络，而不是“公用”网络。先查看当前配置：

```powershell
Get-NetConnectionProfile
```

如果 Wi-Fi 显示为 `Public`，在 Windows 设置的 Wi-Fi 网络属性中将其改为“专用网络”，仅限已知且可信的测试 Wi-Fi。

### 临时开放端口

若本机可打开、手机无法打开，且服务确实监听 `3023`，以管理员 PowerShell 添加仅限专用网络的临时入站规则：

```powershell
New-NetFirewallRule -DisplayName "DUKO local phone test" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3023 -Profile Private
```

测试结束后删除该规则：

```powershell
Remove-NetFirewallRule -DisplayName "DUKO local phone test"
```

不要创建适用于 `Public` 或 `Any` 配置文件的规则。

## Wi-Fi 路由器限制

即使手机和电脑连接同一 Wi-Fi，以下路由器功能仍可能阻断设备之间的访问：

- AP isolation、Client isolation、无线客户端隔离。
- Guest Wi-Fi/访客网络。
- 手机和电脑分别连接主网络与访客网络。
- 企业 Wi-Fi 的设备间访问限制。

关闭客户端隔离或改用允许设备互访的可信 Wi-Fi 后重试。不要为测试关闭整个 Windows 防火墙或降低路由器对其他网络的隔离策略。

## 常见症状

| 症状 | 优先检查 |
| --- | --- |
| 电脑本机也打不开页面 | `pm2 status`、`pm2 logs duko-advance`、构建是否完成、`3023` 监听状态 |
| 手机显示无法连接 | IPv4 是否正确、同一 Wi-Fi、VPN/移动数据、Windows 专用网络防火墙规则、客户端隔离 |
| 手机能打开页面但登录/API 失败 | 手机访问的是 `3023` 而不是 Vite `5273`；检查 PM2 日志和测试账号 |
| 手机能登录但无法拍照或选图 | 系统照片/相机权限、浏览器是否为当前版本、重新打开扫码页 |
| 手机登录后扫码一直显示“图片处理失败，请重试” | `pm2 logs duko-advance` 查 `[barcode-decode]` 行定位：`wasm init failed`/`decode threw` 为解码 worker 问题，`pixel pipeline error` 为像素转换或投递问题，`task timeout` 为解码超时；同时确认 `server/dist` 已重新构建且 `pm2 restart duko-advance` 已执行（新旧前后端必须同时更新，旧服务端没有解码端点，前端会统一显示该文案） |
| 日志出现 `pixel pipeline error: Found invalid value in transferList` | PM2 下 sharp 输出内存不可 transfer，像素必须复制到自行分配的 `ArrayBuffer` 后再投递 worker（当前实现已处理；回退旧的直接 transfer/slice 写法会在 PM2 下复现），见 [仓库扫码](./server/warehouse-scan.md) |
| 解码慢或提示“解码繁忙” | 单张通常应在数秒内返回；持续繁忙检查是否多人同时扫码、PM2 进程内存与 CPU，必要时重启服务 |
| 页面报 `crypto.randomUUID is not a function` | 纯 HTTP 局域网访问不是安全上下文，`crypto.randomUUID` 不可用（localhost/HTTPS 才有）；涉及该 API 的代码需准备降级路径后才能做局域网验收 |
| 端口规则已添加仍不可达 | 路由器客户端隔离、第三方安全软件、防火墙规则是否限于错误的网络配置文件 |

## 停止测试

```powershell
pm2 delete duko-advance
```

不要执行 `pm2 save`。若创建了临时防火墙规则，按上文删除；测试数据与生产数据保持隔离。
