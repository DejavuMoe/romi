# 安全策略

## 支持的版本

romi 目前处于测试版阶段，安全修复只进入最新的预发布版本和 `master`，旧版本不单独回补。

| 版本 | 安全修复 |
| --- | --- |
| 最新的 0.1.x 预发布 | 是 |
| 更早的版本 | 否，请升级 |

## 报告漏洞

请不要在公开的 Issue、讨论或 Pull Request 中披露漏洞。

通过 GitHub 私密漏洞报告提交：<https://github.com/DejavuMoe/romi/security/advisories/new>。
报告只对维护者可见，修复在私密分支中完成。

请尽量提供：

- 受影响的版本（`romi-hub --version` 或 `romi-agent --version`）；
- 部署方式：目标平台（如 `x86_64-unknown-linux-gnu`）、systemd / OpenRC / Agent Docker、反向代理及其配置；
- 复现步骤、实际影响，以及你认为的攻击前提（是否需要管理员登录、是否需要能访问 Hub 端口等）；
- 相关日志或请求。提交前去掉密码、会话 Cookie、节点令牌、注册 key 和生产数据库内容。

## 处理方式

项目由一人维护，不承诺固定的响应时限。收到报告后会先确认是否可复现，再按影响排序处理：
修复随新的预发布版本发布，同时发布 GitHub 安全公告；报告者愿意时在公告中致谢。
在修复发布之前，请不要公开细节。

## 范围

适用于本仓库交付的内容：Hub（认证、会话、权限、匿名公开页投影、API 与 WebSocket 限制）、Agent（令牌与上报）、
安装器与服务模板、备份与恢复，以及发布工件的完整性。

以下情况通常不作为漏洞处理：

- 违背[部署要求](docs/deployment.md)的环境，例如 Hub 端口不经 HTTPS 反向代理直接对公网开放，或在不受控网络中使用 Agent 的 insecure 模式；
- 需要管理员凭据才能进行的操作，除非它越过了文档写明的边界；
- 只存在于第三方依赖、在 romi 中不可触发的问题，请直接报告给上游；
- 社会工程、物理访问，以及对未更新系统组件的利用。

现有的安全机制与明确不保证的内容见[安全边界](docs/security-baseline.md)；
下载的发布工件应按[发布流程](docs/release.md)核对 attestation 与 SHA-256。

## Reporting in English

Please report vulnerabilities privately through GitHub Security Advisories:
<https://github.com/DejavuMoe/romi/security/advisories/new>. Do not open a public issue.
Only the latest 0.1.x pre-release receives security fixes. Remove passwords, session cookies,
node tokens and database contents from anything you attach.
