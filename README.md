# romi

自托管 Linux 主机监测：CPU、RAM/ZRAM/Swap、磁盘、网络、历史、TCP 监测和基础通知。
Rust Hub 使用内嵌 DuckDB，管理后台与公开页随二进制交付。Agent 只采集和探测，不执行远程命令。

romi 由 Dejavu Moe 独立维护。需求、版本和发布节奏由本仓库定义，不以其他项目的版本或提交作为开发基线。
项目采用 [MIT License](LICENSE)；随代码分发的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 使用

- [部署](docs/deployment.md)：systemd/OpenRC、HTTPS、Agent 安装、升级和备份。
- [代码导览](docs/codebase-guide.md)：现有功能、界面交互、业务数据流和数据库；其余入口见[文档导航](docs/README.md)。
- [开发流程](docs/engineering.md)：工作阶段、检查与提交约定。
- [发布流程](docs/release.md)：平台矩阵、候选工件与发布门禁。

Hub/Agent 支持 Linux x86_64、ARM64，以及 GNU/glibc、musl；Agent 另有 Docker 交付。
公开页默认关闭，新增节点默认公开。管理端只使用管理列表；公开页支持卡片/列表，默认视图由管理员保存。

## 开发

Windows 是源码和 Git 的唯一工作区，Debian WSL2 是可丢弃的 Linux 构建环境。
工具链由 `mise.toml`、`rust-toolchain.toml` 和锁文件确定。

```powershell
linux-task.ps1 -Mode build -Project (Get-Location).Path -Command 'make setup && make check-linux'
```

原生 Linux 环境可在仓库根运行 `make setup && make check-linux`。
开发入口是 `make dev-server`、`make dev-admin`、`make dev-web`，分别监听回环的 9911、5173、5174 端口。
文档网站复用 `docs/` 中的正文：`pnpm docs:dev` 在 `127.0.0.1:4312` 预览，`make check-docs` 构建并检查站内链接、搜索和移动布局。
DuckDB 的 bundled 构建需要 C/C++ 编译器。浏览器检查见 [testing](docs/testing.md)。

| 目录 | 责任 |
| --- | --- |
| `server/` | Hub、权限、HTTP/WebSocket、DuckDB、通知与分发 |
| `agent/` | Linux 采集、连接恢复与 TCP 监测 |
| `admin/` / `web/` | 管理后台 / 公开状态页 |
| `shared/` / `styles/` | 共享契约、格式化与视觉规则 |
| `deploy/` / `scripts/` / `e2e/` | 安装、构建验证、发布与浏览器回归 |
| `docs/` | 当前产品和工程事实、VitePress 文档网站 |
| `designs/romi-next/` | 当前已批准的界面契约 |
