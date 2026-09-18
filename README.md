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
deploy/   romi 原生 Hub/Agent 安装器与 systemd 模板
scripts/  开发快照、公开发行、校验和集成测试
docs/     开发、发行、部署和安全说明
```

仓库：[DejavuMoe/romi](https://github.com/DejavuMoe/romi)，默认分支为 `master`。

## 开发环境

使用 [mise](https://mise.jdx.dev/) 管理开发工具，前端使用 pnpm workspace。
`mise.toml` 固定 Node.js **24.21.0**、pnpm **12.4.2** 和 Python **3.14.7**；
Rust **1.98.0** 及 rustfmt、Clippy 由 `rust-toolchain.toml` 定义，mise 自动读取。

本地开发环境为 Omarchy Linux，已通过 mise 同步上述工具版本。
还需要 Git、GNU Make，以及 **C/C++ 编译器**（`cc` 与 `c++`）：Hub 链接的 DuckDB 由
官方 crate 从源码编译。Agent 不需要 C++ 工具链。GitHub CI 使用 Ubuntu 24.04；公开发行构建固定在 Ubuntu 22.04（见发行文档）。

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
| `make check` | 前端构建、lint、测试，Rust fmt、Clippy、测试，版本/发行/安装器测试 |
| `make smoke` | 编译并验证登录、节点创建、Agent 上报、令牌换发、健康检查、DuckDB 单写者约束和 Agent 分发路由 |
| `make bench` | 对 release 二进制跑实时 ingestion / group-commit 基准（见 [docs/bench.md](docs/bench.md)） |
| `make bench-fixture` | 构建 benchmark-only 大历史 fixture/profiler（不进入发布包） |
| `make release` | 编译本机 release 二进制并记录构建输入 |
| `make package` | 生成带清单与 SHA-256 校验文件的本地开发快照包（非公开发行） |
| `make release-candidate` | 构建并完整验证一个绑定当前 HEAD、但不主张 Git 标签的公开候选目录 |
| `make release-package` | 用已存在且指向 HEAD 的 `TAG=vX.Y.Z` 做公开发行目录，本地不推送、不创建 Release |

集成测试使用临时回环实例和临时数据，结束后自动清理，不安装系统服务。

GitHub Actions 与本地使用同一份 mise 配置。CI 在推送 `master`、面向 `master` 的 PR 和手动触发时
执行检查，并校验、解压本地快照包，对包中实际二进制跑冒烟测试。公开发行工作流
[`release.yml`](.github/workflows/release.yml) 只在推送 `v*` 标签时进入发布任务；手动触发始终是
不发布的 dry-run。运行记录见 [GitHub Actions](https://github.com/DejavuMoe/romi/actions)。

## 运行与发行

本阶段源码版本为 **0.1.0**（根目录 `VERSION`）。romi 尚未创建 `v0.1.0` 标签，也尚未发布任何
GitHub Release。

原生部署只支持 Linux x86_64 GNU + systemd。公开发行构建固定在 Ubuntu 22.04（glibc 2.35），
实测 Hub 与 Agent 均最高需要 `GLIBC_2.34`；因此目标主机必须提供 glibc 2.34+ 与 systemd，
Ubuntu 22.04 及更新版本满足该基线，更老的发行版不在支持范围。Hub 安装器从已验证的 release
归档安装 `/opt/romi/current`，同时把同版本 Agent 放入本地分发；Hub 只在配置了合法
`--distribution-dir` 时启用 `GET /install.sh`、`GET /api/agent/distribution` 与
`GET /agent/vX.Y.Z/x86_64`。普通开发启动没有分发，这些路由返回 503。安装、systemd 加固、
首次管理员凭证、Nginx 反代与升级/备份说明见 [原生部署](docs/deployment.md)。

本地 release 构建产物为：

```text
target/release/romi-hub
target/release/romi-agent
```

Hub 默认监听 `127.0.0.1:28080`，默认数据库文件为 `romi.db`。Agent 使用后台创建或换发令牌时
展示的本地命令（也可以显式传参）：

```sh
ROMI_TOKEN='<token>' ./romi-agent --server 'https://hub.example.com' --interval 1
```

两个二进制都支持 `--version`，分别输出 `romi-hub X.Y.Z` 与 `romi-agent X.Y.Z`；该命令不读取
数据库、不建立网络连接。Agent 也接受 `ROMI_SERVER` / `ROMI_TOKEN` 环境变量。

发行分为两条独立、不可混用的路径：

- **开发快照**：`make package` 构建本机当前的源码、二进制与前端资源，生成
  `dist/romi-<源码摘要>-<Rust目标>.tar.gz`。它允许未打标签的源码状态，未签名，不代表公开
  Release；校验与运行见 [本地发行快照](docs/local-release.md)。
- **公开发行**：由 `vX.Y.Z` 标签触发，绑定一个不可变 Git commit，产出带 release manifest 和
  `SHA256SUMS` 的版本化归档，并在发布前完成解压、运行、冒烟与 GitHub artifact attestation。
  可先运行 `make release-candidate` 构建/验证一个不主张标签的候选目录；公开发行流程本身不手工
  执行。当前发布、校验和来源证明说明见 [发行与验证](docs/release.md)，端到端安装流程见
  [原生部署](docs/deployment.md)。

`make release` 只编译本机 release 二进制；`make release-package TAG=vX.Y.Z` 要求标签已经存在
且指向 HEAD，只做本地打包与验证，不推送、不创建 Release。

## 存储

数据保存在 `--db` 指定的单个 DuckDB 文件里（默认 `romi.db`）。启动时：

- 若该文件不存在则新建；若存在但不是有效的 romi DuckDB 数据库，会**拒绝启动且不改动该文件**；
- 同一文件同时只允许一个 Hub 进程读写（DuckDB 的限制），第二个进程会被 `<db>.lock` 拒绝；
- 可用 `--db-memory`（默认 512MB，**不是进程 RSS 上限**）、`--db-threads`（默认最多 8）、
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
