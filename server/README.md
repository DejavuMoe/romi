# romi Hub

`romi-hub` 是 romi 的单二进制服务端：内嵌 admin 后台与公开状态页资源，通过 HTTP/WebSocket
接收 Agent 上报，并使用内嵌 DuckDB 保存数据。

## 当前状态

- 当前源码版本为 `0.1.0`（根目录 [`VERSION`](../VERSION)）；romi 尚未创建公开发行标签。
- Hub 默认监听 `127.0.0.1:28080`，默认数据库为 `romi.db`。
- 原生安装只支持 Linux x86_64 GNU + systemd；Hub 安装器从 release 归档安装
  `/opt/romi/current`，同时建立本地 Agent 分发。
- 未配置 `--distribution-dir` 时，`GET /install.sh`、`GET /api/agent/distribution` 与
  `GET /agent/vX.Y.Z/x86_64` 返回 503；配置合法分发后只提供精确版本和架构的 Agent。
- `GET /healthz` 是免认证、轻量的健康接口，供安装器和反向代理使用。
- 公开发行工件与 provenance 说明见 [docs/release.md](../docs/release.md)，部署说明见
  [docs/deployment.md](../docs/deployment.md)。

## 构建与运行

在仓库根执行：

```sh
mise exec -- make setup
mise exec -- make build
target/debug/romi-hub --listen 127.0.0.1:28080 --db .local/romi.db
```

release 构建与开发快照：

```sh
make release          # target/release/romi-hub
make package          # dist/ 下的本地开发快照，不等于公开 Release
make release-candidate  # 公开发行形状的本地候选，不创建标签
```

Hub 链接的 DuckDB 由官方 `duckdb` crate 的 `bundled` feature 从源码编译，因此本机需要
C/C++ 工具链（`cc`、`c++`）；目标机不需要安装外部 DuckDB，但需要与构建 ABI 匹配的
GNU C/C++ 运行库（实测依赖见 [发行与验证](../docs/release.md)）。

常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--listen <addr>` | `127.0.0.1:28080` | 监听地址；默认回环 |
| `--db <path>` | `romi.db` | DuckDB 数据库文件 |
| `--themes <dir>` | 数据库旁的 `themes/` | 第三方主题目录 |
| `--site <url>` | 空 | 反向代理后的外部 HTTPS 域名；也可用 `ROMI_SITE` |
| `--db-memory <size>` | `512MB` | DuckDB 内存上限，不是进程 RSS 上限 |
| `--db-threads <n>` | 最多 8 | DuckDB worker 线程 |
| `--db-temp <dir>` | `<db>.tmp` | DuckDB spill 目录 |
| `--allow-custom-themes` | 关闭 | 信任外部主题 JavaScript 与后台同源运行 |
| `--distribution-dir <dir>` | 空 | 校验并服务一个本地 romi Agent 分发；空则路由返回 503 |
| `--bootstrap-password-file <file>` | 空 | 首次启动把管理员凭证以 0600 原子写入该文件，不打印到 stdout |
| `--version` | — | 输出 `romi-hub X.Y.Z` 后退出，不读数据库、不联网 |

日志级别可用环境变量 `ROMI_LOG` 覆盖（默认 `romi_hub=info,tower_http=warn`）。

## 相关文档

- [根 README](../README.md)：产品概览、开发入口与检查命令。
- [存储设计](../docs/storage.md)：DuckDB 引擎、写入队列、备份与恢复。
- [安全基线](../docs/security-baseline.md)：当前已实现的认证、隐私与发行边界。
- [发行与验证](../docs/release.md)：VERSION、标签、manifest、SHA256SUMS 与 provenance。

## 许可与来源

romi Hub 使用 MIT 许可证（见仓库根 `LICENSE` 与 [`server/LICENSE`](LICENSE)），基于 stqfdyr
的 `monitor-probe/monitor` 导入并重命名；原始版权与许可证保留在
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 与
[upstream.lock.json](../upstream.lock.json) 中。`docs/upstream/` 下的旧文档与安装脚本只是归档
参考，不是当前产品手册或安装入口。
