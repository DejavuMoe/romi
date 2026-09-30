# 功能范围

romi 由一个 Hub 和多个 Linux Agent 组成。Hub 内嵌管理后台、公开状态页与 DuckDB，不依赖外部数据库；Agent 在被监测主机上采集指标并执行 TCP 探测。

## 监测与历史

- CPU、负载、RAM、ZRAM、Swap、磁盘、网络、进程数、连接数与系统运行时长。
- 分钟明细与小时历史，缺少样本的区间留空，累计流量不随历史清理而减少。
- 从指定节点探测 TCP 目标，记录延迟与丢包。探测不包含 HTTP 状态码和页面内容检查。

## 节点与通知

- 节点搜索、在线状态筛选、展示优先级、账单与到期日、流量额度和可用带宽。
- 单节点安装、批量注册窗口、令牌换发；从自己的 Hub 安装精确版本的 Agent。
- Telegram 与 Webhook，支持离线、恢复、流量、到期和后台登录提醒。
- 公开页默认关闭，开放后可按节点控制可见性；匿名响应隐藏管理地址与凭据。

状态页支持卡片和列表、中英文、明暗主题，适配桌面与移动端。管理后台目前以中文为主。操作说明见[日常使用](guide.md)，具体字段规则见[节点、流量与告警](domain.md)。

## 平台与限制

支持 Linux x86_64 / ARM64、GNU / musl、systemd / OpenRC；Agent 另有 Docker 镜像。Hub 的 HTTPS 由反向代理提供，Agent 验证公共 CA 证书。安装要求见[部署](deployment.md)。

不提供远程终端、任意命令执行、文件管理、自动更新、多租户、分布式存储或 Hub Docker。只提供内置主题，不加载第三方主题。

## 开发验收索引

以下编号用于关联实现与测试，不代表当前分支已经通过验收。历史检查记录见[验证记录](readiness.md)。

| ID | 检查范围 | 实现参考 |
| --- | --- | --- |
| R-01 | Linux 指标；上报间隔为 3–60 秒整数，默认 3 秒 | `agent/src/collect.rs`、`agent/src/main.rs` |
| R-02 | 分钟/小时历史、缺样、累计量 | [存储](storage.md) |
| R-03 | TCP host:port、节点指派、5–3600 秒探测间隔、延迟与丢包 | `server/src/api.rs`、Agent 测试 |
| R-04 | 总流量与本期流量、四种用量模式、重启后的累计 | [领域规则](domain.md)、`shared/format.ts` |
| R-05 | 通知渠道、离线/恢复、流量、到期与续期、后台登录 | `server/src/notify.rs` |
| R-06 | 节点管理、账单、带宽、协议、安装、注册窗口与令牌 | `admin/src/components/sections/` |
| R-07 | 公开页与节点默认值、匿名字段过滤 | API 认证测试、公开页 E2E |
| R-08 | HTTPS Hub 分发精确版本 Agent | `server/src/distribution.rs`、`deploy/` |
| R-09 | CPU/ABI、初始化系统、Docker 宿主指标 | 平台矩阵与安装演练 |
| R-10 | 有界备份/恢复、失败保留原库、不恢复旧会话 | `server/src/db/backup.rs` |
| R-11 | 请求、连接、任务、队列与归档上限 | [架构](architecture.md)、[性能测试](bench.md) |
| R-12 | 明暗主题、320px 起适配、键盘与触摸操作 | [界面能力](ui/capabilities.md)、浏览器检查 |
