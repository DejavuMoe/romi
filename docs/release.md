# 发布

版本源为根 `VERSION`，Hub/Agent 版本保持一致，标签为严格的 `vX.Y.Z`。发布需要明确授权，
不可覆盖已公开版本、标签或附件；新源历史不能冒用既有版本的验收记录。

## 工件

目标为 x86_64/aarch64 的 GNU 与 musl。GNU 在 Debian 12 基线构建，拒绝高于 GLIBC_2.36 的符号要求；musl 要求静态链接。
使用匹配 CPU 的原生 runner，固定构建镜像；manifest 记录版本、完整源提交、target、编译器、引擎及文件摘要。

每个目标交付 Hub/Agent 归档、release manifest（`romi-release-vX.Y.Z-<target>.json`）和 `SHA256SUMS-<target>`；
另有覆盖全部资产的 `SHA256SUMS`、两种 CPU 的 Docker Agent 镜像归档及其验收记录 `container-<arch>.json`。
同一对镜像归档推送到 `ghcr.io/dejavumoe/romi-agent`：`X.Y.Z` 与 `latest` 是包含两种 CPU 的索引，`X.Y.Z-amd64`/`X.Y.Z-arm64` 为单架构镜像。
Hub 归档包含受控分发所需的各目标 Agent；Agent 归档只包含对应 Agent。安装器、服务模板、项目 MIT 及必需的第三方声明随包提供。
不交付测试数据库、开发凭据或 benchmark 二进制。

## 版本准备

一次发布对应一个候选提交，候选提交必须同时包含：

1. `VERSION` 与各处同步的版本（`scripts/version.py check` 核对 Cargo 包名与版本、锁文件、`admin`/`web` 包清单，以及 `deploy/agent/compose.yml` 的镜像标签）；
2. [验收状态](readiness.md)中该版本的 `## vX.Y.Z` 小节，记录本地执行的检查、结果与未覆盖的范围。
   `scripts/version.py check` 在 CI 和打标签时都要求该小节存在且非空，漏写会让门禁失败；
3. 可选的发布说明 `docs/release-vX.Y.Z.md`，发布工作流从标签的检出读取。缺失时发布说明只包含版本、源提交和本页的指引。

这些文件必须在打标签之前提交。标签之后再修改会改变提交，使既有验收记录失效。

## 一份工件贯穿验收与发布

1. CI 完成前端/Rust/脚本、smoke 和 E2E。
2. Linux platforms 验证四个平台：逐个运行 smoke，musl 另做真实 OpenRC 安装演练，并验证 Docker 宿主指标，上传已验证工件。
3. 在最终 master SHA 手动运行 Release：用只存在于 runner 的临时标签组合相同 SHA 的平台工件，验证发行形状，
   并对 x86_64 GNU 包运行 smoke、live-capacity 与 E2E。此步骤不发布。
4. Release Rehearsal 使用第 3 步的确定字节，在 x86_64/aarch64 GNU 包上验证 systemd、Nginx/TLS、注册、同版本重装与重启持久性；
   不含跨版本升级与备份恢复。
5. 授权后推送同一提交的版本标签。工作流核对门禁与摘要，复用已验收归档，不重编译。
6. 发布 job 再核对身份，上传资产并生成 attestation，把已验收的镜像归档推送到 GHCR 并为镜像生成 attestation，
   全部完成后才把草稿发布为正式版本并标记为最新。

`python3 scripts/release_gate.py --repo DejavuMoe/romi --sha <完整提交>` 检查候选门禁（需要已登录的 `gh`）。
失败、未完成、skipped、PR 或旧提交的成功不能替代当前候选。工件字节变更后需要重新演练。

## 验证入口

下载后先验证 attestation，再校验 SHA-256，最后解压到空目录：

```sh
gh attestation verify <文件> --repo DejavuMoe/romi
gh attestation verify oci://ghcr.io/dejavumoe/romi-agent:X.Y.Z --repo DejavuMoe/romi
```

以下验证器都要在对应标签的源码检出中运行。全部资产（目录须恰好包含全部发行资产）：

```sh
python3 scripts/release_matrix.py verify --directory ./release --commit <完整SHA>
```

单个目标（目录只放该目标的文件）：

```sh
ROMI_RELEASE_TARGET=<target> python3 scripts/release.py verify <目录> --tag vX.Y.Z --commit <完整SHA>
```

单目标验证检查路径、成员、规模、版本/提交、摘要与 Hub 内 Agent 清单，可加 `--run-binaries`；
Hub 内各 Agent 与 Agent 归档逐字节一致、Docker 验收记录与镜像摘要一致，只由全量验证检查。
SHA-256 证明完整性；GitHub attestation 绑定仓库和工作流身份，不是对软件绝对安全的保证。

## 本地入口

| 命令 | 用途 |
| --- | --- |
| `make package` | 开发快照，见[本地开发快照](local-release.md) |
| `make release-candidate` | 本地公开形状候选：精确 `VERSION`、HEAD 与干净工作区，不创建标签 |
| `make release-package TAG=vX.Y.Z` | 为指向 HEAD 的既有标签打包，不推送 |
| `make release-rehearsal` | 远端不存在该标签时，在本检出临时打标签并打包，完成后删除 |
| `make systemd-rehearsal` | 真实 systemd 演练；只在没有 `/opt/romi`、`/var/lib/romi`、`/etc/romi` 的一次性主机上以 root 运行 |

这些入口都不等于正式发布。第三方许可清单须与锁定依赖一致（`make check-licenses`）。详细安装见[部署](deployment.md)。
