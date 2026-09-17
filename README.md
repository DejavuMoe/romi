# romi

自托管服务器探针，基于 monitor-probe 的 MIT 源码构建。
已完成开发环境和第一轮本地安全改造，可构建带校验清单的本地发行快照。
GitHub Actions 测试流程已配置；签名和自动安装尚未接入。当前安全边界见 [安全基线](docs/security-baseline.md)。

```text
server/   Rust Hub、SQLite、API、WebSocket、嵌入式静态页面
admin/    React 管理后台，访问 /admin/
agent/    Linux 指标采集与网络探测 Agent
web/      React 公开状态页，访问 /
scripts/  本地集成验证
docs/     上游来源、初始化验收与后续开发边界
```

来源：[monitor](https://github.com/monitor-probe/monitor)、
[agent](https://github.com/monitor-probe/agent)、
[默认主题](https://github.com/monitor-probe/monitor-theme-default)。
精确提交与许可摘要见 [upstream.lock.json](upstream.lock.json)，导入映射见 [docs/upstream.md](docs/upstream.md)。

## 仓库与持续集成

主仓库：[DejavuMoe/romi](https://github.com/DejavuMoe/romi)，默认分支 `master`。
SSH 地址：`git@github.com:DejavuMoe/romi.git`。

[GitHub Actions CI](.github/workflows/ci.yml) 在推送 `master`、向 `master` 发起或更新 PR，
以及手动触发时运行。流程使用 Ubuntu 24.04、项目固定的 Rust/Node.js 和 npm 11.19.0，执行：

1. `make setup`：安装锁定依赖。
2. `make check`：前端构建/lint/测试、Rust fmt/clippy/测试和打包拒绝检查。
3. `make package`：构建 release 二进制及快照包，校验归档摘要。
4. 解压本次归档，以 `scripts/smoke.py --bin-dir` 验证包内二进制的实际运行。

工作流只授予 `contents: read`，官方 Actions 固定完整提交 SHA，不发布 Release 或镜像。
本地检查成功不代表远程 CI 已通过；远程执行结果以 [Actions 页面](https://github.com/DejavuMoe/romi/actions) 为准。

## 工具链与初始化

Linux，Rust **1.98.0**（`rust-toolchain.toml`）、Node.js **24.21.0**（`.node-version`）、
npm **11.19.0**、GNU Make、Python 3、C 编译器/链接器。SQLite 使用 Rust 依赖内置源码。
本轮保留组件原始锁文件；所有 Cargo 命令使用 `--locked`，前端用 `npm ci`。

```sh
make setup
make build
make check
make smoke
```

`make setup` 需要访问 npm/crates.io；首次使用精确 Rust 工具链需要 rustup 下载。
`make build` 从本地 `admin/` 和 `web/` 构建资源，再编译服务端与 Agent。
不会下载上游主题或上游 Agent 成品。修改前端后重新 `make build` 才会更新服务端内嵌资源。

```sh
make release
python3 scripts/smoke.py --release
make package
```

发布模式的本机二进制在 `target/release/monitor-hub` 和 `target/release/monitor-agent`。
`make package` 生成带源码/工具链/产物清单的 `dist/romi-*.tar.gz` 与 `.sha256`。
构建记录同时绑定生成后的前端资源，拒绝打包期间替换的负载。校验和运行见 [本地发行](docs/local-release.md)。
当前只保证本机 Linux 构建，未建立跨架构 musl、镜像、签名或在线发行流程。

## 开始开发

在项目根目录的三个终端分别运行：

```sh
make dev-server
make dev-admin
make dev-web
```

- 服务端：http://127.0.0.1:9911；嵌入式后台：http://127.0.0.1:9911/admin/
- 后台热更新：http://127.0.0.1:5173/admin/
- 公开页热更新：http://127.0.0.1:5174/
- 两个 Vite 开发服务将 `/api`（含 WebSocket）代理到 9911，均只绑定回环地址。
- 跨应用页面由 9911 的已构建资源提供：5174 的 `/admin/` 走 Hub，5173 的非 `/admin/` 路径走 Hub。
  每个端口只对自身应用提供 HMR；修改另一应用后需要重新 `make build`，或打开它自己的开发端口。
- 首次启动的应急管理员密码只在服务端终端显示。数据库与主题目录放在被 Git 忽略的 `.local/`。
- `Ctrl+C` 停止对应进程，没有安装 systemd/OpenRC 服务或修改系统代理。

上游的节点创建/注册要求 HTTPS 域名入口，纯 localhost HTTP 下这些按钮会被拒绝。
正式开发这些流程时需要本地可信 HTTPS 反向代理，保留 Host 并正确设置 X-Forwarded-Proto；
不要公开暴露可伪造代理头的后端。`make smoke` 仅在临时回环实例上模拟代理请求以验证 API，
自动创建临时凭证和私有节点，验证摘要存储、换发和重连；国家查询默认关闭，结束后清理进程与数据。

运行自己的 Agent（服务器中已有节点时）：

```sh
read -rsp 'Node token: ' MONITOR_TOKEN; echo
export MONITOR_TOKEN
MONITOR_SERVER=http://127.0.0.1:9911 ./target/debug/monitor-agent
unset MONITOR_TOKEN
```

`/install.sh` 与 `/agent/{arch}` 当前明确返回 **503**。后台现在给出本地二进制运行命令，
创建与换发的令牌仅在当次对话框显示，关闭后无法读回；Node API 和 WebSocket 不返回令牌或摘要。
独立可信发行链路完成前请从源码构建，不使用 `docs/upstream/` 中的历史安装脚本。

## 下一阶段

1. 完成首次签名提交/推送与 GitHub CI 实际运行，再接入正式发行版本、独立签名与安装验证。
2. 补齐部署服务用户与 systemd 规范、注册窗口凭证策略、全量依赖许可/安全审计。
3. 增加兼容性与迁移/备份回归，再开始功能定制及有测量依据的性能优化。

节点令牌现在只存 SHA-256 摘要；新节点默认私有，公开状态页需显式开启。
国家查询默认关闭，开启后会向 ipinfo.io 发送节点连接 IP。
默认只服务本仓内置主题；仅在明确接受同源脚本信任风险时使用 `--allow-custom-themes`。
原生服务端默认监听 `127.0.0.1:28080`，容器或远程绑定需显式 `--listen`。
这不是完整安全审计，也不代表可以直接对公网部署。
当前 UI、Cookie、数据库字段、环境变量和二进制内部名称尚未统一品牌化。

## 许可

MIT。原作者版权保留，见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
