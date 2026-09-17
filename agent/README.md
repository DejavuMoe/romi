# romi Agent

`romi-agent` 是 romi 的 Linux 主机采集与探测进程。它读取本机 `/proc` 与文件系统
统计，通过 WebSocket 向 romi Hub 上报事实与实时指标。

## 当前状态

- 当前源码版本为 `0.1.0`（根目录 [`VERSION`](../VERSION)），romi 尚未创建公开发行标签。
- 支持目标只有 Linux x86_64 GNU + systemd。没有 musl、aarch64、OpenRC 或自动更新。
- Hub 配置了合法本地分发时，`GET /install.sh` 提供 romi 自带安装器，节点从该 Hub 下载精确
  版本的 Agent 并校验大小/SHA-256/`--version`；开发启动没有分发时该路由返回 503。
- 公开 release 工件、校验和与 GitHub provenance 的定义见
  [docs/release.md](../docs/release.md)；完整安装与升级说明见
  [docs/deployment.md](../docs/deployment.md)。

## 构建与检查

开发工具由根目录 `mise.toml`、`rust-toolchain.toml` 和 `agent/Cargo.lock` 固定。在仓库根执行：

```sh
mise exec -- make setup
mise exec -- make build
mise exec -- make check
```

只构建 Agent 时：

```sh
cargo build --locked --manifest-path agent/Cargo.toml
cargo test --locked --manifest-path agent/Cargo.toml
cargo clippy --locked --manifest-path agent/Cargo.toml --all-targets -- -D warnings
```

release 路径：

```sh
cargo build --locked --release --manifest-path agent/Cargo.toml
```

产物为 `target/release/romi-agent`。Agent 不链接 DuckDB，也不需要 C++ 工具链，但它是动态
链接的 GNU/Linux 程序（依赖系统 `libc` 与 `libgcc_s`），不是 musl 静态文件。

## 安装

在 Hub 后台创建节点后，复制安装命令到目标节点：

```sh
tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT \
  && curl -fsSL 'https://hub.example.com/install.sh' -o "$tmp" \
  && sudo sh "$tmp" --server 'https://hub.example.com'
```

安装器会安全提示输入一次性显示的节点令牌，将其写入 `/etc/romi/agent.env`（0600），并把
版本化二进制安装到 `/opt/romi/releases/<version>/romi-agent`。systemd 服务通过
`EnvironmentFile` 注入 `ROMI_SERVER`、`ROMI_TOKEN` 和 `ROMI_INTERVAL`，`ExecStart` 中不含
令牌。更新是显式操作：对可信的新 Hub 重新运行安装器即可；不会后台自更新。

## 直接运行

从本仓开发或手工调试时，也可以直接运行二进制：

```sh
ROMI_TOKEN='<token>' target/release/romi-agent --server https://hub.example.com
```

这里仅用于开发调试；原生安装不会把令牌放进 `ExecStart` 或安装命令（`--token` CLI 参数仍保留，
但服务 unit 不使用它）。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--server <url>` | 必填 | Hub 基础 URL；也可用环境变量 `ROMI_SERVER` |
| `--token <token>` | 必填 | 节点令牌；也可用环境变量 `ROMI_TOKEN` |
| `--interval <secs>` | `1` | 上报间隔，限制在 1–3600 秒；也可用 `ROMI_INTERVAL` |
| `--insecure` | 关闭 | 允许向非回环 Hub 使用明文 `ws://`，仅用于确实没有 TLS 的地址 |
| `--version` | — | 输出 `romi-agent X.Y.Z` 后退出，不读数据库、不联网 |
| `-h`, `--help` | — | 显示用法 |

## 安全行为

- 令牌通过 WebSocket `Authorization` 请求头发送，不放查询参数，避免进入反向代理访问日志。
- 默认拒绝向非回环地址建立明文 `ws://` 连接；`--insecure` 会显式放弃该保护。
- Agent 不写数据文件、不保存跨重启状态；流量累计由 Hub 负责。
- 原生安装中的永久令牌只存在于 root 可读的 `0600` env 文件，由 systemd 注入进程环境；
  安装命令和 unit 文件都不包含令牌。
- Agent 不自更新、不执行 Hub 发来的命令；安装与升级由本地管理员显式执行。
- 退出或连接失败时按现有重连/退避逻辑运行。

## 上报协议

线上字段的权威定义是本仓 `agent/src/collect.rs` 中的 `Facts` 与 `Metrics` 结构体，以及
`server/src/agent_ws.rs` 中的会话与消息处理：

- `Facts` 在连接建立时上报一次：主机名、系统、内核、架构、虚拟化类型、CPU 型号与核数、
  内存/磁盘总量、本机 IPv4 / IPv6。
- `Metrics` 每 `--interval` 秒上报：CPU、负载、内存、swap、磁盘、网卡速率与内核累计
  计数器、TCP/UDP 连接数、进程数、运行时间。
- `net_rx_total` / `net_tx_total` 是内核生命周期计数器，原样上报；`boot_id` 来自
  `/proc/sys/kernel/random/boot_id`，是 Hub 判断主机重启的依据，不应删除或改写。
- Agent 上报的 `agent_version` 来自同步后的 romi 版本，因此公开发行中的 Agent 会报告
  `0.1.0` 这类 romi 版本，而不是继承的旧名版本。

## 许可与来源

romi Agent 使用 MIT 许可证（见仓库根 `LICENSE` 与 [`agent/LICENSE`](LICENSE)），基于 stqfdyr
的 `monitor-probe/agent` 导入并重命名；原始版权与许可证保留在
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 和
[upstream.lock.json](../upstream.lock.json) 中。`docs/upstream/` 下的旧文档只是归档参考，
不是当前安装或协议权威。
