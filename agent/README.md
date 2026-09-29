# romi Agent

Linux 主机采集和 TCP 监测进程，通过鉴权 WebSocket 连接 Hub；非目标见[需求](../docs/requirements.md)。

```sh
cargo test --locked --manifest-path agent/Cargo.toml
cargo build --locked --release --manifest-path agent/Cargo.toml
```

配置使用 `--server` / `ROMI_SERVER`、`--token` / `ROMI_TOKEN`、`--interval` / `ROMI_INTERVAL` 和 `--iface` / `ROMI_IFACE`；
`--insecure` 只允许到远程 Hub 的明文 `ws://`，`--version` 打印版本后退出。上报间隔范围见需求 R-01；接口过滤、计数 epoch、宿主挂载和地址选择以采集测试为准。
对外连接始终验证 TLS。安装器在终端或标准输入读取令牌，不将永久令牌放进命令参数。

安装、Docker 宿主观测及更新见[部署](../docs/deployment.md)，计数含义见[领域规则](../docs/domain.md)。
