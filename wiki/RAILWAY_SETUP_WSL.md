# WSL 可选操作环境

WSL 不是部署要求。Railway 从 Git 仓库构建时不依赖开发者电脑是否安装 WSL；Windows、macOS 或原生 Linux 都可以完成代码提交和 Railway 控制台配置。

只有在 Windows 上希望使用 Linux shell、Node.js 工具链或 Railway CLI 时，才需要考虑 WSL。安装与故障排查以 Microsoft 和 Railway 官方文档为准，不在本项目文档中固定某个发行版或过时安装流程。

## 官方资料

- [Microsoft: Install WSL](https://learn.microsoft.com/windows/wsl/install)
- [Microsoft: WSL 基本命令](https://learn.microsoft.com/windows/wsl/basic-commands)
- [Node.js 下载与安装](https://nodejs.org/en/download)
- [Railway CLI](https://docs.railway.com/guides/cli)
- [Railway 部署文档](https://docs.railway.com/guides/deployments)

## 推荐边界

- 仓库放在 WSL 的 Linux 文件系统中通常有更好的 Linux 工具性能；若继续使用 Windows 路径，也应避免同时由 Windows Node.js 与 WSL Node.js 修改同一套 `node_modules`。
- 在 WSL 内安装并使用 Node.js 20 或更高版本。依赖应在实际执行构建的环境里重新 `npm ci`，不要跨 Windows/WSL 复用含原生模块的 `node_modules`；本项目包含 `better-sqlite3` 等平台相关依赖。
- Railway CLI 登录凭据留在本机，不写入仓库。生产密钥在 Railway Variables 配置，不创建或读取实际 `.env` 来完成云端部署。
- 本地验证根构建应运行 `npm run railway:build`；本地启动需要满足 server 的环境变量校验。根目录没有普通 `build` 或 `start` 脚本。
- `auto/` 若在 Windows 桌面上以有头 Chromium 运行，不必迁入 WSL。WSL 图形应用、浏览器依赖和持久 profile 会增加额外复杂度，是否可用应按当前 WSL/Playwright 官方说明验证。

## 与 Railway 的关系

WSL 不会改变仓库的 Railway 配置：builder 仍是 Railpack，构建与启动仍由 `railway.json` 调用根脚本，Volume 仍需在 Railway 界面创建并挂载到 `/data`。完整生产配置见 [RAILWAY_SETUP.md](./RAILWAY_SETUP.md)。
