# romi

[![CI](https://github.com/DejavuMoe/romi/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DejavuMoe/romi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

自托管的 Linux 主机监测。一个 Hub 汇集多台主机的 CPU、负载、RAM/ZRAM/Swap、磁盘、网络、连接与进程，
保存分钟与小时历史，执行 TCP 监测并通过 Telegram 或 Webhook 发送通知。

- **Hub**：Rust 单文件二进制，内嵌 DuckDB、管理后台和公开状态页，不依赖外部数据库。
- **Agent**：每台主机一个，只采集和探测，不执行远程命令；从你的 Hub 按精确版本安装。
- **平台**：Linux x86_64 / ARM64，GNU 或 musl，systemd 或 OpenRC；Agent 另有 Docker 镜像。

> [!WARNING]
> romi 目前是 **0.1.x 测试版**，以 GitHub Pre-release 发布。功能和数据格式仍可能调整，请在可以重装的主机上试用，升级前先备份。

## 快速开始

1. 从 [Releases](https://github.com/DejavuMoe/romi/releases) 下载对应平台的 Hub 归档，用 `gh attestation verify` 与 `SHA256SUMS` 验证；
2. 解压后运行 `sudo sh deploy/hub/install.sh --site https://hub.example.com`；
3. 用 Nginx 等反向代理为该域名提供 HTTPS（需要公共 CA 证书），代理到 `127.0.0.1:28080`；
4. 打开 `/admin/` 登录，添加节点，在被监测的主机上运行面板给出的安装命令。

逐步说明见[快速开始](docs/quick-start.md)，完整的安装、升级、备份与 Agent Docker 用法见[部署](docs/deployment.md)。

## 文档

| 主题 | 入口 |
| --- | --- |
| 功能范围与非目标 | [需求](docs/requirements.md) |
| 安装、反向代理、升级与备份 | [部署](docs/deployment.md) |
| 数据库、历史保留与恢复 | [存储](docs/storage.md) |
| 安全机制与边界 | [安全边界](docs/security-baseline.md) |
| 发布工件与验证 | [发布](docs/release.md) |
| 已验证的范围 | [验收状态](docs/readiness.md) |
| 全部文档 | [文档导航](docs/README.md) |

## 开发

需要 Linux 与 C/C++ 编译器（DuckDB 从源码编译）。Node.js、pnpm、Python 的版本固定在 `mise.toml`，Rust 固定在 `rust-toolchain.toml`，推荐用 [mise](https://mise.jdx.dev/) 安装：

```sh
make setup        # 安装锁定的前端依赖并获取 Rust 依赖
make check-linux  # 构建、lint、单元测试、fmt、Clippy、Rust 测试与脚本自测
make e2e          # 桌面/移动 Chromium 端到端测试（先运行 pnpm exec playwright install chromium）
```

开发服务器：`make dev-server`、`make dev-admin`、`make dev-web`，分别监听回环的 9911、5173、5174 端口。
文档站：`pnpm docs:dev` 在 `127.0.0.1:4312` 预览，`make check-docs` 构建并检查。

| 目录 | 责任 |
| --- | --- |
| `server/` | Hub：权限、HTTP/WebSocket、DuckDB、通知与分发 |
| `agent/` | Linux 采集、连接恢复与 TCP 监测 |
| `admin/` / `web/` | 管理后台 / 公开状态页 |
| `shared/` / `styles/` | 共享契约、格式化与视觉规则 |
| `deploy/` / `scripts/` / `e2e/` | 安装、构建验证、发布与浏览器回归 |
| `docs/` | 产品与工程文档，也是 VitePress 文档站的内容源 |
| `designs/romi-next/` | 当前已批准的界面规格 |

工作阶段、检查选择与提交约定见[开发流程](docs/engineering.md)和[测试](docs/testing.md)。

## 反馈与贡献

- 问题与建议：[GitHub Issues](https://github.com/DejavuMoe/romi/issues)，请使用对应模板。
- 安全漏洞：按 [SECURITY.md](SECURITY.md) 私密报告，不要公开提交。
- 代码改动请先开 Issue 说明问题与方案，界面改动需要先经过原型确认，见[开发流程](docs/engineering.md)。

## 许可

romi 由 Dejavu Moe 独立维护，以 [MIT](LICENSE) 协议发布。发布的二进制包含的第三方组件及其许可见
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)，概览见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
