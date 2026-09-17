# romi 本地发行快照

在开发机执行 `make package`。命令先从本仓构建两个前端与 Rust release 二进制，
记录源码文件摘要、工具链与二进制摘要，再生成 `dist/romi-<源码摘要>-<Rust目标>.tar.gz`
及相邻 `.sha256` 文件。没有 Git 提交也能建立源码快照对应关系；改动源码或二进制后
直接运行打包脚本会拒绝旧构建记录，需重新 `make package`。

当前包仅适用于构建机对应的 Linux 架构/ABI。它不是跨平台 musl 发行版。
包内 `bin/monitor-hub` 与 `bin/monitor-agent` 均来自本仓构建，内部名称暂沿用上游。
`web/dist`、主题元数据与许可证也包含在包中。`manifest.json` 记录全部负载文件摘要，
以及源码文件与构建工具链记录；它不是完整 SBOM 或依赖许可证审计。

## 校验后运行

在可信开发机取得归档 SHA-256，再通过你信任的渠道传给目标机器。
用本仓脚本校验归档，传入完整的可信摘要：

```sh
python3 scripts/package.py verify /path/to/romi-snapshot.tar.gz --sha256 '<EXPECTED_SHA256>'
mkdir romi-snapshot
# 只有上一步成功后再解压；不要覆盖已有数据目录。
tar -xzf /path/to/romi-snapshot.tar.gz -C romi-snapshot
cd romi-snapshot
mkdir data
./bin/monitor-hub --db data/romi.db
```

服务端默认只监听 `127.0.0.1:28080`。生产 HTTPS 反向代理、服务用户和 systemd 安装
需另行配置；本命令不会配置系统服务。Agent 使用后台首次创建或显式换发时展示的令牌，
在 `bin/` 下执行后台给出的本地运行命令。

同目录的 `.sha256` 适合检查传输损坏，**不能独立证明来源真实性**。
本阶段包没有签名，没有开放 Hub 在线分发，没有把上游 latest 用作回退。
远程仓库已确定为 `DejavuMoe/romi`（`master`），GitHub CI 已配置构建及包内二进制测试。
确定独立信任的发布密钥后，再接入签名和自动安装。
现有第三方依赖各自的许可证仍然适用，公开发行前必须补全实际打包依赖的声明。
