# 验证状态

验证分为本地源码检查、候选工件验收和远端发布，不能互相替代。

文档/历史整理的记录见 [文档消融](experiments/documentation.md)。当前代码清理变体的范围、产物摘要和验证结果见 [清理消融](experiments/runtime-cleanup.md)。

- Windows：发布工具 15 项检查通过；本地快照拒绝篡改/危险路径/过期资源检查通过。
- Windows：发布矩阵离线测试 1 项通过。
- Debian WSL2：`make frontend check-frontends` 通过，含两端构建、类型、共享/前端单元检查及 lint，0 告警。
- 文档的本地链接、规模和源码一致性由 `scripts/documentation_audit.py` 生成记录，见 [文档消融](experiments/documentation.md)。
- 代码清理变体：48/48 E2E、16 张基线截图相等、110,033 次格式化输出差分通过。
- 当前 v12 原型文件保持不变；`docs/ui/v12-*.json` 的既有观测不代表新的远端 CI 或发布门禁。

运行代码的完整回归入口见 [测试](testing.md)。新候选仍需绑定自己的 SHA、二进制摘要和 CI/演练结果。
本次文档维护及代码清理没有执行真实手机、真实服务器重装、四平台发行或远端发布；已发布工件没有被覆盖。
