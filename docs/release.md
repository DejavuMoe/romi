# 发布

版本源为根 `VERSION`，Hub/Agent 版本保持一致，标签为严格的 `vX.Y.Z`。发布需要明确授权。
不可覆盖已公开版本、标签或附件；新源历史不能冒用既有版本的验收记录。

## 工件

目标为 x86_64/aarch64 的 GNU 与 musl。GNU 在 Debian 12 基线构建，拒绝高于 GLIBC_2.36 的符号要求；musl 要求静态链接。
使用匹配 CPU 的原生 runner，固定构建镜像；manifest 记录版本、完整源提交、target、编译器、引擎及文件摘要。

每个目标交付 Hub/Agent 归档、release manifest 和校验文件。另有两种 CPU 的 Docker Agent 镜像归档。
Hub 归档包含受控分发所需的各目标 Agent；Agent 归档只包含对应 Agent。安装器、服务模板、项目 MIT 及必需的第三方声明随包提供。
不交付测试数据库、开发凭据或 benchmark 二进制。

## 一份工件贯穿验收与发布

1. CI 完成前端/Rust/脚本、smoke 和 E2E。
2. Linux platforms 验证四个平台及 Docker 宿主指标，上传已验证工件。
3. 在最终 master SHA 手动运行 Release，组合相同 SHA 的平台工件并验证发行形状。此步骤不发布。
4. Release Rehearsal 使用第 3 步的确定字节，验证 systemd、TLS、注册、重装与重启持久性。
5. 授权后推送同一提交的版本标签。工作流核对门禁与摘要，复用已验收归档，不重编译。
6. 发布 job 再核对身份，上传资产并生成 attestation；当前工作流发布为 Pre-release。

`python scripts/release_gate.py --repo DejavuMoe/romi --sha <完整提交>` 检查候选门禁。
失败、未完成、skipped、PR 或旧提交的成功不能替代当前候选。工件字节变更后需要重新演练。

## 验证入口

```sh
python3 scripts/release_matrix.py verify --directory ./release --commit <完整候选SHA>
```

单目标用 `scripts/release.py verify`，目标由 `ROMI_RELEASE_TARGET` 指定。
验证器检查路径、成员、规模、版本/提交、摘要和 Hub 内 Agent 的一致性。
SHA-256 证明完整性；GitHub attestation 绑定仓库和工作流身份，不是对软件绝对安全的保证。
下载后先按仓库验证 attestation，再校验所需归档的 SHA-256，最后解压到空目录。

本地 `make package` 是开发快照；`make release-candidate` 是本地候选，都不等于正式发布。
详细安装见 [部署](deployment.md)，数据回退见 [存储](storage.md)。第三方声明与原依赖版本不作为版本跟随门禁。
