# romi Hub

Rust 服务端，负责 HTTP/WebSocket、认证、DuckDB、通知、本地国家库与 Agent 分发；内嵌管理端和公开页。
在仓库根运行 `make build`，产物为 `target/debug/romi-hub`；构建前需要 `make frontend` 生成的两端页面。
开发入口 `make dev-server` 使用回环 9911。

参数以 `--help` 为准：`--listen`（默认 `127.0.0.1:28080`）、`--db`（默认 `romi.db`）、`--site`（也可用 `ROMI_SITE`）、
`--db-memory`、`--db-threads`、`--db-temp`、`--distribution-dir` 和 `--bootstrap-password-file`。
数据库边界见[存储](../docs/storage.md)，鉴权和限额见[安全](../docs/security-baseline.md)，安装见[部署](../docs/deployment.md)。
