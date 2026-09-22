# romi

Dejavu Moe 独立维护的 Linux 主机监测服务：Rust Hub、Linux Agent、内嵌 React 界面和 DuckDB。
项目采用 [MIT License](LICENSE)，分发时保留 [第三方声明](THIRD_PARTY_NOTICES.md)。

工具版本由 `mise.toml`、`rust-toolchain.toml` 和锁文件固定。在 Linux 运行 `make setup && make build`。
Windows 保存源码与 Git，Linux 构建使用 `linux-task.ps1 -Mode build -Project <repo> -Command 'make setup && make build'`。

[部署](docs/deployment.md)与[发布](docs/release.md)分别定义运行和交付入口；开发快照不等于公开发行。
