# 验证记录与适用范围

验证结果只适用于执行时的源树、构建产物和环境；历史记录不能替代当前候选的检查。

| 记录 | 能证明的范围 |
| --- | --- |
| [文档消融](experiments/documentation.md) | 2026-09-22 的文档/历史整理，以及本次非代码文档审校的静态度量和文档站检查 |
| [运行代码清理消融](experiments/runtime-cleanup.md) | 对应基线与变体的构建、E2E、截图和格式化输出比较 |
| [v12 界面契约](ui/implementation.md) | 已批准规格、生产位置和采集时的浏览器观测；不代表后续源码已复测 |

## 2026-09-25 代码审查修复

本轮按代码审查结果修改存储、安全、前端和安装路径，检查在 Debian WSL2 构建镜像执行，Git 与源码在 Windows。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `make check-linux` | 通过 | 脚本、前端、fmt、Clippy；Hub 167、引擎 9、Agent 26 |
| `make e2e` | 60 通过 | 桌面/移动 Chromium；含新增的响应头、登录页轮询与借用控件样式 |
| `scripts/test_installers.py` | 11 通过 | 含 Hub/Agent 同机共存回归 |
| `scripts/platform_build.py --target x86_64-unknown-linux-musl` | 构建与 smoke 通过 | 一次性容器内的 musl 静态链接检查、GLIBC 基线与 smoke |
| OpenRC 安装演练 | 部分通过，见下 | 一次性特权容器内的真实 OpenRC 安装与上报 |
| 原型校验 | 通过 | `content_audit.py check`、`validate_workflow.py` 四项、`verify.cjs` |

OpenRC 演练覆盖到：Hub 安装并健康、引导密码轮换、登录、创建节点、Agent 安装并上报实时指标、`agent.env` 为 0600，全部在新的 `/opt/romi/<组件>/` 布局下通过。
它在同版本重装的服务停止步骤超时，原因是 Docker Desktop 下 supervise-daemon 的 cgroup 清理（OpenRC 报 `bounded cleanup timed out`），不是 Hub 未退出：
同一容器内的 smoke 对 Hub 发送 SIGTERM 并在 5 秒内回收成功，存储层的 `close_drains_accepted_writes_and_releases_the_lock_last` 也通过。
重装与重启这一段仍以 CI 的 Ubuntu runner 为准，本地未验证。

界面改动只完成到原型阶段，两个受影响界面标记 needs-review，生产代码未实现。
systemd/Nginx/TLS 演练需要一次性 root 主机，本轮未执行；真实 iOS、Safari、读屏器和真实服务器部署同样未覆盖。

新候选的本地检查按[测试](testing.md)执行；发布还需绑定候选 SHA、工件摘要、CI 与安装演练，见[发布](release.md)。历史浏览器观测不证明真实 iOS、Safari、读屏器或真实服务器部署。
