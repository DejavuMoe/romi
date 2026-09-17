# romi

轻量、自托管的服务器监控工具。通过 Linux Agent 采集主机指标，由 Rust 服务端统一存储、展示和管理。

- 实时查看 CPU、内存、磁盘、网络流量与在线状态。
- 配置 TCP 延迟探测、流量统计和通知。
- 管理后台与公开状态页分别开发，构建后嵌入服务端二进制。
- 使用内嵌 DuckDB 保存数据，无需额外数据库服务；同一数据库文件同时只允许一个 Hub 进程读写。
- 节点默认私有，公开状态页需要显式开启；节点令牌仅在创建和换发时展示。

## 项目结构

```text
server/   Rust 服务端、API、WebSocket 和 DuckDB 存储
admin/    React 管理后台
agent/    Linux 采集与探测 Agent
web/      React 公开状态页
scripts/  打包、校验和集成测试
docs/     开发、发行和安全说明
```

仓库：[DejavuMoe/romi](https://github.com/DejavuMoe/romi)，默认分支为 `master`。

## 开发环境

使用 [mise](https://mise.jdx.dev/) 管理开发工具，前端使用 pnpm workspace。
`mise.toml` 固定 Node.js **24.21.0**、pnpm **12.4.2** 和 Python **3.14.7**；
Rust **1.98.0** 及 rustfmt、Clippy 由 `rust-toolchain.toml` 定义，mise 自动读取。

本地开发环境为 Omarchy Linux，已通过 mise 同步上述工具版本。
还需要 Git、GNU Make，以及 **C/C++ 编译器**（`cc` 与 `c++`）：Hub 链接的 DuckDB 由
官方 crate 从源码编译。Agent 不需要 C++ 工具链。GitHub CI 使用 Ubuntu 24.04。

```sh
git clone git@github.com:DejavuMoe/romi.git
cd romi
mise trust
mise install node pnpm python rust
mise exec -- make setup
mise exec -- make build
```

已在 shell 中启用 mise 的情况下，可以直接使用下文的 `make` 和 `pnpm` 命令；
未启用时，在命令前加上 `mise exec --`。

前端依赖统一记录在根目录的 `pnpm-lock.yaml`，安装时使用 `--frozen-lockfile`。
Rust 保留 `server/Cargo.lock` 和 `agent/Cargo.lock`，构建时使用 `--locked`。

## 本地开发

完成首次构建后，在三个终端分别启动服务：

```sh
make dev-server
make dev-admin
make dev-web
```

| 入口 | 地址 |
| --- | --- |
| 服务端 | http://127.0.0.1:9911 |
| 内嵌管理后台 | http://127.0.0.1:9911/admin/ |
| 管理后台热更新 | http://127.0.0.1:5173/admin/ |
| 公开页热更新 | http://127.0.0.1:5174/ |

首次启动时，管理员应急密码显示在服务端终端。数据库和本地主题目录位于 `.local/`，不会提交到 Git。

两个前端开发服务器将 API 和 WebSocket 请求代理到服务端。跨应用导航使用服务端已构建的页面；
需要另一应用的热更新时，打开它对应的开发端口。修改前端后，重新运行 `make build` 更新内嵌资源。

也可以单独运行前端任务：

```sh
pnpm --filter @romi/admin build
pnpm --filter @romi/web test
```

节点创建和批量注册要求 HTTPS 域名入口；普通 localhost HTTP 下相关操作会禁用。
测试这些流程时，需要配置可信的 HTTPS 反向代理并正确传递 Host 和 X-Forwarded-Proto。
后端保持回环监听，避免被外部请求直接访问。

## 检查与构建

| 命令 | 用途 |
| --- | --- |
| `make setup` | 安装锁定的前端与 Rust 依赖 |
| `make check` | 前端构建、lint、测试，Rust fmt、Clippy、测试及打包拒绝检查 |
| `make smoke` | 编译并验证登录、节点创建、Agent 上报、令牌换发、主题限制和 DuckDB 单写者约束 |
| `make bench` | 对 release 二进制跑存储基准（见 [docs/bench.md](docs/bench.md)） |
| `make release` | 编译本机 release 二进制并记录构建输入 |
| `make package` | 生成带清单与 SHA-256 校验文件的本地快照包 |

集成测试使用临时回环实例和临时数据，结束后自动清理，不安装系统服务。

GitHub Actions 与本地使用同一份 mise 配置，在推送 `master`、面向 `master` 的 PR 和手动触发时运行。
CI 除了执行检查，还会校验并解压发行包，测试包中的实际二进制。
运行记录见 [GitHub Actions](https://github.com/DejavuMoe/romi/actions)。

## 运行与发行

服务端与 Agent 二进制分别位于：

```text
target/release/monitor-hub
target/release/monitor-agent
```

服务端默认监听 `127.0.0.1:28080`。更换监听地址需显式传入 `--listen`。
Agent 使用后台创建或换发时给出的本地运行命令；关闭凭证窗口后，令牌不能再次读回。

`make package` 的输出位于 `dist/`。快照包记录源码、工具链、二进制和前端资源摘要，
当前支持构建机对应的 Linux 架构与 ABI，尚未提供跨架构静态包、镜像和自动安装服务。
在线安装入口暂未启用，发行快照也尚未签名。

校验和运行步骤见 [本地发行说明](docs/local-release.md)。

## 存储

数据保存在 `--db` 指定的单个 DuckDB 文件里（默认 `monitor.db`）。启动时：

- 若该文件不存在则新建；若存在但不是有效的 romi DuckDB 数据库，会**拒绝启动且不改动该文件**；
- 同一文件同时只允许一个 Hub 进程读写（DuckDB 的限制），第二个进程会被 `<db>.lock` 拒绝；
- 可用 `--db-memory`（默认 512MB，**不是进程 RSS 上限**）、`--db-threads`（默认最多 4）、
  `--db-temp`（默认 `<db>.tmp`）调整引擎资源。

引擎版本、写入队列与 group commit、备份快照、恢复顺序与维护语义见
[docs/storage.md](docs/storage.md)。

## 安全与数据

- 节点令牌以 SHA-256 摘要存储，管理端列表和实时数据不返回令牌或摘要。
- 新节点默认私有，公开页需在设置中开启。
- 国家查询默认关闭；开启后会将节点连接 IP 发送给 ipinfo.io。
- 默认只使用内嵌主题。`--allow-custom-themes` 会允许外部主题代码与后台同源运行，只应加载可信代码。
- 升级前备份数据库。数据库迁移不可直接降级，回退程序时需要恢复对应版本的备份。

当前实现与已验证范围见 [安全基线](docs/security-baseline.md)。生产部署前仍需完成服务权限、
TLS 反向代理和备份恢复验证。

## 许可证与致谢

作者：**Dejavu Moe**。

```text
Copyright (c) 2026 Dejavu Moe
```

romi 使用 [MIT 许可证](LICENSE)。项目基于 stqfdyr 的
[monitor](https://github.com/monitor-probe/monitor)、
[agent](https://github.com/monitor-probe/agent) 和
[monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default)，保留原作者版权和许可证。

第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，
源码来源与固定提交记录见 [upstream.lock.json](upstream.lock.json)。
