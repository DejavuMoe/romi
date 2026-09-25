---
layout: home

hero:
  name: romi
  text: 自托管的 Linux 主机监测
  tagline: 一个 Hub 汇集多台主机的资源、历史与 TCP 监测结果。Rust 单文件二进制，内嵌 DuckDB，不依赖外部数据库。
  actions:
    - theme: brand
      text: 快速开始
      link: /quick-start
    - theme: alt
      text: 部署文档
      link: /deployment
    - theme: alt
      text: GitHub
      link: https://github.com/DejavuMoe/romi

features:
  - title: 实时与历史
    details: CPU、负载、RAM/ZRAM/Swap、磁盘、网络、连接与进程。分钟明细默认保留 30 天，小时历史 365 天，缺样留空而不画成 0。
    link: /requirements
  - title: TCP 监测与通知
    details: 由指定节点探测 host:port 的延迟与丢包；离线与恢复、流量阈值、到期和登录通过 Telegram 或 Webhook 提醒。
    link: /codebase-guide
  - title: 管理后台与公开页
    details: 节点、账单与流量、批量注册、备份与维护集中在一个后台；公开页默认关闭，开放后匿名访客看不到地址与凭据。
    link: /ui/capabilities
  - title: 可验证的安装
    details: GNU/musl、x86_64/ARM64，systemd 或 OpenRC，另有 Agent Docker 镜像。发布包带 GitHub attestation 与 SHA-256，Agent 从你的 Hub 按精确版本安装。
    link: /deployment
  - title: 有界的资源与数据
    details: 请求、连接、队列与归档都有上限；备份与恢复先完整校验再替换数据库，失败保留原库。
    link: /storage
  - title: 安全边界清楚
    details: Hub 只监听回环，由 HTTPS 反向代理对外；Agent 只采集和探测，不执行远程命令。
    link: /security-baseline
---

## 当前状态

romi 处于 **0.1.x 测试版**，以 GitHub Pre-release 发布：功能和数据格式仍可能调整，升级前请先备份。
已验证的范围与未覆盖的环境见[验收状态](readiness.md)，问题与建议请提交到 [GitHub Issues](https://github.com/DejavuMoe/romi/issues)。

romi 由 Dejavu Moe 独立维护，以 [MIT 协议](legal.md)开源。
