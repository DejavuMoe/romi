# romi 本地开发快照

本地快照用于开发与测试：在开发机执行 `make package`，命令会先从本仓构建两个前端与 Rust release
二进制，记录源码文件摘要、工具链与二进制摘要，再生成
`dist/romi-<源码摘要>-<Rust目标>.tar.gz` 及相邻 `.sha256` 文件。

本地快照与公开发行是两种不同的信任模型：

- 快照允许来自未打标签、甚至未提交的源码状态，只要构建记录与当前源码、二进制和生成资源一致；
- 不创建 Release，不签名，`manifest.json` 中 `kind` 固定为 `local-snapshot`、`signed` 为 false；
- 公开发行必须绑定一个 `vX.Y.Z` 标签和一个完整 commit，定义见 [发行与验证](release.md)。

修改源码、二进制或前端资源后直接运行打包脚本会拒绝旧构建记录，需重新 `make package`。

## 包内容

当前快照包使用 romi 名称：

- `bin/romi-hub` 与 `bin/romi-agent` 来自本仓构建；
- 包含 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`upstream.lock.json`、组件许可证；
- 包含 `web/dist`、主题元数据、两份 Cargo 锁文件、pnpm 锁文件与工具链版本记录；
- `manifest.json` 记录全部负载文件摘要、源码文件摘要与构建工具链；它不是完整 SBOM 或依赖许可证
  审计。

快照只适用于构建机对应的 Linux 架构/ABI。它不是跨平台 musl 发行版，也不是 `docs/release.md`
描述的公开目标产物。

## 校验后运行

在可信开发机取得归档 SHA-256，再通过你信任的渠道传给目标机器。用本仓脚本校验归档，传入完整
的可信摘要：

```sh
python3 scripts/package.py verify /path/to/romi-snapshot.tar.gz --sha256 '<EXPECTED_SHA256>'
mkdir romi-snapshot
# 只有上一步成功后再解压；不要覆盖已有数据目录。
tar -xzf /path/to/romi-snapshot.tar.gz -C romi-snapshot
cd romi-snapshot
mkdir data
./bin/romi-hub --db data/romi.db
```

Hub 默认只监听 `127.0.0.1:28080`。生产 HTTPS 反向代理、服务用户和 systemd 安装需另行配置；
本命令不会配置系统服务。Agent 使用后台首次创建或显式换发时展示的令牌：

```sh
ROMI_TOKEN='<token>' ./bin/romi-agent --server 'https://hub.example.com'
```

Agent 也接受 `ROMI_SERVER` 环境变量。后台给出的本地命令使用 `./romi-agent`。

包内 Hub 链接由官方 `duckdb 1.10505.0` crate（bundled，DuckDB engine v1.5.5）从源码编译进的
引擎，因此目标机**不需要**安装外部 libduckdb；但仍需要构建环境对应的 GNU C/C++ 运行库。
实际动态链接结果以 `ldd` 实测为准，见 [发行与验证](release.md) 和发布工作流记录的检查输出。

同目录的 `.sha256` 适合检查传输损坏，**不能独立证明来源真实性**。本阶段快照没有签名，没有开放
Hub 在线分发；远程仓库为 `DejavuMoe/romi`（`master`），GitHub CI 会校验并解压快照、测试包中
二进制。公开发行的 integrity/provenance 说明见 [发行与验证](release.md)。
