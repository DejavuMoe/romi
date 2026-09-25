# 产品需求

romi 是单 Hub、多 Agent 的 Linux 主机监测服务。需求 ID 用于连接任务、实现和验收，不代表检查已经通过。

| ID | 产品契约 | 主要依据 |
| --- | --- | --- |
| R-01 | CPU、内存、磁盘、网络、进程、连接数和运行时长；上报间隔 3–60 秒整数，默认 3 秒 | `agent/src/collect.rs`、`agent/src/main.rs` |
| R-02 | 分钟/小时历史保留、缺样留空、累计量不因清理减少 | `server/src/db/`、[存储](storage.md) |
| R-03 | TCP host:port 监测、指定节点、间隔 5–3600 秒、延迟和丢包 | `server/src/api.rs`、Agent 监测测试 |
| R-04 | 总流量、本期流量及四种用量计算模式；重启不重复累计 | [领域规则](domain.md)、`shared/format.ts` |
| R-05 | Telegram/Webhook、离线/恢复、流量和到期通知 | `server/src/notify.rs`、管理通知页 |
| R-06 | 管理列表、地址复制、优先级、账单、协议可用性、安装及令牌轮换 | `admin/src/components/Admin.tsx` |
| R-07 | 公开页默认关闭、新节点默认公开；匿名响应不含管理地址和凭据 | 认证/API 测试、公开页 E2E |
| R-08 | 从可信 HTTPS Hub 安装精确版本的已验证 Agent | `server/src/distribution.rs`、`deploy/` |
| R-09 | GNU/musl、x86_64/ARM64、systemd/OpenRC；Agent Docker 观测宿主机 | 平台矩阵与安装演练 |
| R-10 | 有界备份/恢复；验证前不替换数据库，不恢复旧登录会话 | `server/src/db/backup.rs` |
| R-11 | 请求、连接、任务、队列和归档有界；容量按实际环境测量 | [架构](architecture.md)、[基准](bench.md) |
| R-12 | 桌面/移动、明暗、键盘/触摸可用；320px 起保持核心操作可达 | [UI 能力](ui/capabilities.md)、浏览器检查 |

辅助能力包括账号密码登录、会话管理、本地 GeoLite Country 数据库、手动维护和默认关闭的周期维护。
只提供内置主题及明暗模式。公开页支持卡片/列表，站点默认视图由管理员保存。

非目标：远程终端、任意命令执行、文件管理、自动更新、多租户、分布式存储、Hub Docker。
数据格式变化需要迁移和回退决策；已发布工件不覆盖。
