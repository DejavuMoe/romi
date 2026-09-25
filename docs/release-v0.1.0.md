# romi v0.1.0

romi 的第一个公开测试版（Pre-release）：自托管的 Linux 主机监测，一个 Hub 汇集多台主机的资源、历史与 TCP 监测结果。
功能和数据格式仍可能调整，请在可以重装的主机上试用，升级前先备份。

## 包含的能力

- **监测**：CPU、负载、RAM/ZRAM/Swap、磁盘、网络速率与累计流量、连接与进程；上报间隔 3–60 秒，默认 3 秒。
- **历史**：分钟明细默认保留 30 天（可设 1–3650 天），小时历史 365 天；缺样留空，累计流量不随清理减少。
- **TCP 监测**：由指定节点探测 `host:port`，记录延迟与丢包，间隔 5–3600 秒。
- **通知**：Telegram 与 Webhook；离线/恢复、流量阈值、到期与自动续期、后台登录提醒。
- **管理后台**：节点列表与搜索筛选、账单与流量、可用带宽、批量注册窗口、令牌轮换、备份/恢复、数据库维护、会话管理、本地 GeoLite2 Country 库。
- **公开状态页**：默认关闭；开放后提供卡片与列表视图，匿名访客看不到地址、备注与凭据。
- **界面**：桌面与移动、明暗主题，终端风格的等宽界面，320px 起可用。

## 平台与工件

- Hub 与 Agent：`x86_64` / `aarch64`，`unknown-linux-gnu`（glibc ≥ 2.36）与 `unknown-linux-musl`（静态链接）；systemd 或 OpenRC。
- Agent Docker 镜像归档：`x86_64` 与 `aarch64`。
- 每个目标附 release manifest 与 `SHA256SUMS-<target>`，另有覆盖全部资产的 `SHA256SUMS`；所有资产带 GitHub attestation。
- 每个归档与 Agent 镜像（`/licenses/`）都附带 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与 `THIRD_PARTY_LICENSES.txt`。

## 安装与验证

```sh
gh attestation verify <文件> --repo DejavuMoe/romi
sha256sum --check --ignore-missing SHA256SUMS-<target>
```

逐步安装见[快速开始](https://github.com/DejavuMoe/romi/blob/v0.1.0/docs/quick-start.md)，
完整说明见[部署](https://github.com/DejavuMoe/romi/blob/v0.1.0/docs/deployment.md)。Hub 需要 HTTPS 反向代理与公共 CA 证书。

## 已知限制

- Agent 只信任内置的公共 Web PKI 根证书，私有 CA 或自签名证书的 Hub 无法接入。
- 在「安全」页修改账号名时，需要同时设置新密码。
- 节点菜单里的「账单与流量」只包含价格、币种、周期与到期；流量校正在「编辑节点」中。
- 不提供 Hub 的 Docker 交付，也没有自动更新；升级需重新运行安装器。
- 浏览器测试使用桌面与移动 Chromium，未在真实 iOS/Safari 设备与读屏器上验证。

已验证的范围与未覆盖的环境见[验收状态](https://github.com/DejavuMoe/romi/blob/v0.1.0/docs/readiness.md)。

## 从早期构建升级

早期构建（`0.0.1`）的数据库在首次启动时自动从 schema 2 迁移到 3，请先保留一份备份。
本地登录账号为 `admin`，自动化调用 `/api/auth/login` 需要带 `username`；GitHub 登录与外部主题已移除。
详见[部署 · Hub 升级边界](https://github.com/DejavuMoe/romi/blob/v0.1.0/docs/deployment.md#hub-升级边界)。
