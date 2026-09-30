# 文档

第一次使用从[快速开始](quick-start.md)安装 Hub 和 Agent，之后按[日常使用](guide.md)配置公开页、监测与通知。

## 使用与运维

| 文档 | 内容 |
| --- | --- |
| [快速开始](quick-start.md) | 安装 Hub、登录、接入第一台主机 |
| [日常使用](guide.md) | 查看节点、流量与历史，配置监测和通知，开放状态页 |
| [部署与升级](deployment.md) | HTTPS 代理、系统服务、Agent Docker、升级与故障排查 |
| [功能范围](requirements.md) | 支持的指标、平台与功能限制 |
| [节点、流量与告警](domain.md) | 在线状态、账期、累计量与提醒规则 |
| [存储、备份与恢复](storage.md) | 历史保留、数据库参数、备份限制和恢复流程 |
| [安全](security-baseline.md) | 身份验证、匿名访问、凭据与传输 |

## 开发与维护

| 文档 | 内容 |
| --- | --- |
| [开发指南](engineering.md) | 本地环境、开发服务器与贡献约定 |
| [测试](testing.md) | 按改动范围选择检查，运行浏览器与集成测试 |
| [代码导览](codebase-guide.md) | 模块、业务流程、接口与数据库表 |
| [运行架构](architecture.md) | 请求、连接、队列与并发限制 |
| [界面能力](ui/capabilities.md) · [界面约束](product/constraints.md) · [界面实现](ui/implementation.md) | 页面行为、交互规则与源码位置 |
| [性能测试](bench.md) | 负载生成、容量测量与对照实验 |
| [发布流程](release.md) · [本地快照](local-release.md) | 构建、验证与打包 |
| [验证记录](readiness.md) | 特定版本执行过的检查与未覆盖范围 |
| [许可与标志](legal.md) | MIT、第三方组件与 romi 标志 |

本目录也是 VitePress 站点的内容源。在仓库根运行 `pnpm docs:dev`，打开 `http://127.0.0.1:4312/`；修改后运行 `make check-docs`。
