# 文档导航

按任务选择入口，不需要顺序阅读整个目录。产品事实、执行步骤和验证结果分别维护。
本目录也是 VitePress 站点的内容源；在仓库根运行 `pnpm docs:dev` 可本地阅读，不另存一份正文。

| 要解决的问题 | 推荐入口 |
| --- | --- |
| 第一次安装与接入 | [快速开始](quick-start.md) |
| 产品包含什么，什么不做 | [需求](requirements.md) |
| 一篇读懂现有功能、界面、业务流和数据库 | [代码导览](codebase-guide.md) |
| 并发和资源边界 | [架构](architecture.md) |
| 字段、权限、计费和状态语义 | [领域规则](domain.md) |
| 数据库、历史、备份和迁移 | [存储](storage.md) |
| 界面能力与实现映射 | [UI 能力](ui/capabilities.md)、[产品约束](product/constraints.md)、[UI 契约](ui/implementation.md) |
| 如何分阶段实施和提交 | [工程流程](engineering.md) |
| 改动后跑什么检查 | [测试](testing.md) |
| 如何安装、升级和恢复 | [部署](deployment.md) |
| 如何交付同一份已验收工件 | [发布](release.md)、[本地快照](local-release.md) |
| 安全机制与边界、报告漏洞 | [安全](security-baseline.md)、[SECURITY.md](https://github.com/DejavuMoe/romi/blob/master/SECURITY.md) |
| 第三方许可 | [许可](legal.md)、[THIRD_PARTY_LICENSES.txt](https://github.com/DejavuMoe/romi/blob/master/THIRD_PARTY_LICENSES.txt) |
| 如何做容量实验 | [基准方法](bench.md) |
| 验证记录与适用范围 | [验收状态](readiness.md) |
| 文档与历史结构实验 | [文档消融](experiments/documentation.md) |
| 运行代码、资源和界面保持性 | [清理消融](experiments/runtime-cleanup.md) |

代码和测试是行为依据，当前已批准设计在 `designs/romi-next/`。旧任务过程和淘汰方案不作为开发入口。
