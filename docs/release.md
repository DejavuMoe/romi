# romi 公开发行与验证

本文是 romi 公开发行的权威说明。它描述的是已提交的发行模型与工作流；在首个 `v0.1.0` 标签被
显式推送之前，仓库仍没有真实 GitHub Release。未配置本地 Agent 分发的开发启动仍会让
`/install.sh` 与版本化 `/agent/...` 路由返回 503；完整安装配置见 [原生部署](deployment.md)。

## 版本与标签模型

romi 只有一个发布版本源：

```text
根目录 VERSION       X.Y.Z
公开 Git 标签        vX.Y.Z
```

- `VERSION` 采用严格的 `MAJOR.MINOR.PATCH` 数字格式，带前导零、预发布后缀或前缀的版本会被拒绝。
- `server/Cargo.toml`、`agent/Cargo.toml` 与两份 `Cargo.lock` 的 romi 包版本必须等于 `VERSION`；
  Hub 与 Agent 始终使用同一个 romi 版本。
- `admin/package.json` 与 `web/package.json` 是私有前端包，不发布，因此使用占位版本 `0.0.0`，
  不冒充独立版本。
- 发布工作流在打包前执行 `python3 scripts/version.py check --tag "$TAG"`，并再次核对标签所指向的
  commit 与检出 commit 完全相同。
- 发布身份来自明确的标签和 commit，不来自 GitHub 的 "latest release" 概念。

当前准备版本是 `0.1.0`；本阶段不会创建 `v0.1.0` 标签，也不会创建真实 Release。

## 支持目标

本阶段只支持：`x86_64-unknown-linux-gnu`。

- 公开发行构建固定在 `ubuntu-22.04`，这是当前仍受支持的最老 GitHub 托管镜像；开发 CI 继续运行
  在 `ubuntu-24.04`。发布工作流会在该固定环境中实际执行发布出来的 Hub/Agent。
- Hub 使用官方 `duckdb` crate 的 `bundled` + `parquet` feature，DuckDB 编入二进制；它不是
  静态链接的 musl 二进制，仍依赖构建环境的 GNU C 运行库。
- 不声明 musl、aarch64 Hub、Alpine、macOS 或 Windows 支持。没有实际构建并运行验证的目标不会
  出现在本文或 release manifest 中。

受控构建实验将公开发行构建从 `ubuntu-24.04` 移到 `ubuntu-22.04`（glibc 2.35），使用同一
pinned Rust 1.98.0 工具链重新编译实际发行二进制：`romi-hub` 与 `romi-agent` 的最高 glibc
符号版本都实测为 `GLIBC_2.34`。没有实际测量符号要求的更低版本不会被声称支持；发布工作流会在
发布前重新测量并拒绝高于 `GLIBC_2.34` 的产物。Ubuntu 22.04 及更新版本满足该基线。

对固定 `ubuntu-22.04` 构建产物实测 `ldd`（发布工作流会在同一固定环境重新打印真实输出）：

- `romi-hub`：`linux-vdso.so.1`、`libstdc++.so.6`、`libgcc_s.so.1`、`libm.so.6`、
  `libc.so.6`、`ld-linux-x86-64.so.2`；**没有** `libduckdb`（引擎编入二进制）。
- `romi-agent`：`linux-vdso.so.1`、`libgcc_s.so.1`、`libc.so.6`、`ld-linux-x86-64.so.2`。

具体库文件名和路径随发行版与工具链版本变化；发布工作流在发布前打印真实 `ldd` 输出。

## 工件

一次公开发行只对应一个标签、一个 commit、一个目标：

```text
romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz
romi-agent-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz
romi-release-vX.Y.Z.json
SHA256SUMS
```

归档顶层固定包含二进制、许可证/来源说明、`VERSION`、`release.json` 和最小文档：

- Hub：`bin/romi-hub`、`bin/romi-agent`、根 `LICENSE`、`THIRD_PARTY_NOTICES.md`、
  `upstream.lock.json`、`VERSION`、`server/LICENSE`、`admin/LICENSE`、`web/LICENSE`、
  `README.md`、`docs/release.md`、`docs/deployment.md`、`docs/storage.md`、
  `deploy/hub/install.sh`、`deploy/hub/romi-hub.service.in`。
- Agent：`bin/romi-agent`、根 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`upstream.lock.json`、
  `VERSION`、`agent/LICENSE`、`README.md`、`docs/release.md`、`docs/deployment.md`、
  `deploy/agent/install.sh`、`deploy/agent/romi-agent.service.in`。
- `release.json` 记录组件、版本、标签、commit、目标三元组和（Hub 的）DuckDB 引擎版本。

Hub 归档同时携带同一版本的 Agent 二进制，供已验证的 Hub 安装器建立本地 Agent 分发；
Hub 运行时不访问 GitHub 获取 Agent。归档中不允许出现 `romi-bench` 或其他 benchmark-only
产物、开发基准数据、临时路径或私有文件。
`bin/romi-hub`、`bin/romi-agent` 的 `--version` 必须在不读数据库、不联网的情况下分别输出
`romi-hub X.Y.Z` 和 `romi-agent X.Y.Z`。

## release manifest

整次发行只有一个机器可读 manifest，例如：

```json
{
  "format": 1,
  "project": "romi",
  "kind": "public-release",
  "version": "0.1.0",
  "tag": "v0.1.0",
  "commit": "<完整 40 位 Git SHA>",
  "target": "x86_64-unknown-linux-gnu",
  "artifacts": [
    {
      "component": "hub",
      "target": "x86_64-unknown-linux-gnu",
      "filename": "romi-hub-v0.1.0-x86_64-unknown-linux-gnu.tar.gz",
      "sha256": "<64 位十六进制>",
      "size": 12345678
    },
    {
      "component": "agent",
      "target": "x86_64-unknown-linux-gnu",
      "filename": "romi-agent-v0.1.0-x86_64-unknown-linux-gnu.tar.gz",
      "sha256": "<64 位十六进制>",
      "size": 2345678
    }
  ],
  "build": {
    "rustc": "rustc 1.98.0 (...)",
    "rustc_host": "x86_64-unknown-linux-gnu",
    "duckdb_engine": "v1.5.5",
    "source_commit": "<完整 Git SHA>",
    "source_tag": "v0.1.0"
  },
  "integrity": {"algorithm": "sha256", "file": "SHA256SUMS"},
  "provenance": {
    "mechanism": "github-attestation",
    "repository": "DejavuMoe/romi",
    "subjects": "all published release files"
  }
}
```

同一输入生成的 manifest 是确定性的：排序键、固定缩进和换行。归档的打包帧也被固定，但 romi
**不声称**在任意机器上重新编译会得到逐 bit 相同的二进制；这里使用 "可追溯"（traceable），
而不是未经证明的 "可复现"（reproducible）。

## SHA256SUMS 与完整性

`SHA256SUMS` 使用标准 `sha256sum` 格式，按文件名排序，覆盖两个归档和 manifest 本身。
校验命令：

```sh
sha256sum --check SHA256SUMS
```

本仓校验器还会检查：

- release manifest、`SHA256SUMS` 与实际文件三者一致；
- 文件集合完全匹配，缺少、多余、改名或目标/版本不一致都会失败；
- 归档成员路径安全、无重复成员、无路径穿越或超限负载；
- `bin/romi-bench` 等 benchmark-only 二进制不存在；
- 解压后二进制 `--version` / `--help` 的身份与版本正确。

这里的 SHA-256 证明的是**完整性/一致性**：文件没有损坏，manifest 与校验和没有互相矛盾。
如果 SHA-256 和文件都来自同一个 GitHub Release 渠道，它不能单独证明发布者身份，也不是签名。

## 来源证明（provenance）与签名

公开发布工作流使用 GitHub 官方 [`actions/attest`](https://github.com/actions/attest)
生成 build provenance attestation：

- 只授予发布任务 `id-token: write`、`attestations: write` 和创建 Release 所需的
  `contents: write`；构建/测试任务保持 `contents: read`。
- 使用短时 OIDC 证书与 Sigstore，不引入长期私钥，也不在仓库保存 release 私钥。
- attestation 绑定到 `DejavuMoe/romi`，主题为工作流实际上传的全部发布文件：
  两个归档、release manifest 和 `SHA256SUMS`。
- 验证必须绑定仓库，例如：

```sh
gh attestation verify romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz --repo DejavuMoe/romi
gh attestation verify romi-agent-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz --repo DejavuMoe/romi
```

provenance 证明的是「该 digest 由本仓库该工作流构建」；它不是对软件本身安全性的背书，也不是
第三方 PGP/minisign 签名。romi 当前没有独立于 GitHub/Sigstore 的长期发布签名密钥。若未来需要
离线或跨平台验证，应单独设计签名密钥生命周期，而不是复用 `SHA256SUMS` 冒充签名。

## 发布工作流

`.github/workflows/release.yml` 是 romi 自有发行工作流。

### 手动 dry-run

`workflow_dispatch` 永远是非发布模式：构建并验证 `release-candidate` 目录，上传为临时 GitHub
Actions artifact，不创建 release，不需要 `contents: write`、`id-token` 或 `attestations` 权限。
它使用与公开模式相同的解压、`--version`、smoke 与 manifest 校验，只是 `kind` 为
`release-candidate` 且不主张标签。Hub/Agent 安装器会拒绝 `kind != public-release` 的归档，
候选目录只用于发布前验证，不用于生产安装。

### 标签发布

只有推送 `v*` 标签才会进入发布任务。发布前工作流必须依次完成：

1. 检出标签对应的完整 commit（`fetch-depth: 0`，`persist-credentials: false`）。
2. 安装锁定工具链和依赖（mise、`pnpm install --frozen-lockfile`、`cargo ... --locked`）。
3. 运行 `make check` 和 `make smoke`。
4. 用 `make release` 构建 release 二进制。
5. 用被 `--locked` 固定的依赖图编译 DuckDB bundled/parquet。
6. 生成版本化归档、manifest 和 `SHA256SUMS`。
7. 解压、检查成员、执行 `--version`，并对解压出的二进制跑现有 smoke 套件。
8. 重新核验标签、commit、manifest、校验和、目标三元组和 benchmark 排除。
9. 在独立发布任务中生成 GitHub attestation。
10. 先创建 draft Release、上传全部资产，最后一步才发布；失败不会公开一个半成品 Release。

普通 CI（`.github/workflows/ci.yml`）继续只负责代码质量，不获得 release/attestation 权限。
所有外部 Action 固定完整 commit SHA，不使用 `@main`、`@v4` 等可变引用。

### 本地候选与手工验证

不创建标签也能验证公开发行形状：

```sh
make release-candidate
python3 scripts/release.py verify dist/release --commit "$(git rev-parse HEAD)" --run-binaries
```

如果确实已在本地创建并指向 HEAD 的标签，也可以：

```sh
make release-package TAG=v0.1.0
```

这两个命令都不推送、不创建 GitHub Release。真实发布只能由远端标签推送触发，或在未来经明确
审查后手工执行等价的发布步骤。

## 许可与 SBOM 边界

两个归档都携带根 MIT 许可证、导入来源说明、对应组件许可证和 `upstream.lock.json`。
`THIRD_PARTY_NOTICES.md` 说明来源与内嵌 DuckDB；它**不是**完整 SBOM，也不是对全部 Rust/JS
传递依赖的许可证审计。当前没有引入额外 SBOM 工具链；若未来加入，应作为独立可维护的发行工件
生成并同样纳入 manifest 和校验。

## 分发与原生部署

v0.4B 起，原生 Hub 安装器从 release 归档安装 `/opt/romi/current` 与本地 Agent 分发；
完整文件系统布局、systemd 加固、首次管理员凭证、反向代理和升级/备份要求见
[原生部署](deployment.md)。

- 未配置 `--distribution-dir` 时，`GET /install.sh`、`GET /api/agent/distribution` 和
  `GET /agent/vX.Y.Z/x86_64` 返回 503；
- 配置合法本地分发后，Hub 只从内存提供该精确版本的 Agent，不提供可变的 `/agent/x86_64`；
- Hub 不抓取 GitHub Release，Agent 不自动下载、不自更新；
- 所有安装/更新都是显式本地管理员操作。
