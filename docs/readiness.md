# 验证记录

本页保存版本候选执行过的检查。结果只适用于当时的源码和产物，不表示当前开发分支已经通过同样的检查。

## 记录规则

- 每次发版在本页新增一个 `## vX.Y.Z` 小节，新版本在上，旧版本的小节保留不改。
  当前 `VERSION` 的小节缺失或为空会让版本门禁失败，见[发布](release.md)。
- 小节记录发版前在本地实际执行的检查、结果和未覆盖的范围，不写未执行的检查，也不预填结果。
- 小节随候选提交一起提交，因此不写候选提交自身的 SHA：版本标签指向的提交就是它适用的源树。
- CI、Linux platforms、Release 与 Release Rehearsal 的结果以 GitHub 上同一提交的运行记录为准（查询方法见[发布](release.md)），不复制到本页。

## v0.2.0

2026-10-01 执行。构建和运行时检查在 Debian Linux 的 ext4 工作区执行；需要 Git 元数据或修改临时 Git 仓库的发布工具检查在 Windows 检出中执行。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `make check-linux` | 通过 | 脚本、版本与许可、两端前端 lint/单测、fmt、Clippy；Hub 171、DuckDB 引擎 9、Agent 26 项测试通过，1 项手动基准按设计忽略 |
| `ROMI_E2E_BIN_DIR=target/release pnpm test:e2e` | 115 通过，5 跳过 | 重新构建 release Hub；桌面 1280×900、移动 390×844 Chromium；真实 Hub 的登录、匿名隔离、数据和设置回归，以及 v15 详情、导航、检查器、三步接入、注册列表、精确计数；窄屏系统字体回退、长站点名和导航点击区域 |
| `make smoke` | 通过 | release Hub/Agent：登录、节点、DuckDB 单写锁、凭据轮换、真实 Agent 指标与版本化分发 |
| `make live-capacity` | 通过 | 真实套接字席位上限、超额拒绝与关闭后回收 |
| `make check-docs` | 通过 | 文档构建、站内链接、明暗/响应式布局、搜索与移动导航 |
| 发布脚本与文档链接检查 | 通过 | 发布工具 15 项自测、发布矩阵、演练标签、归档防护与项目文档本地链接；未推送或创建版本标签 |
| UI 契约与文案清单 | 通过 | 5 个 surface 的结构/映射；额外采集生产 DOM 的 498 条字符串并分类审查，70 条提示为运行状态或数据属性 |
| 原型/生产渲染与详情补测 | 通过 | 1440×900、390×844 截图对照；详情在中英文 320/390/768/1440px 无溢出，实时曲线、图表/表格、十字线、缩放、刷新失败与重试 |

未覆盖：

- 同一候选提交的远端 CI、四个平台、候选组装与 Release Rehearsal；这些结果需由该提交的实际工作流提供。
- 真实服务器部署、真实 iOS/Safari、触摸硬件与读屏器。
- 浏览器接入流程中的 Agent 上报和分发可用性使用合成状态；真实 Agent 上报与分发由 release smoke 检查。跨版本升级、四平台发行和 GHCR 发布未在本候选执行。
- 监测、通知、数据、安全和站点设置的页面主体保留既有布局与中文文案；v15 后台迁移覆盖登录、导航和节点管理流程。

## v0.1.0

2026-09-25 执行。Linux 检查在 Debian WSL2 的 ext4 构建镜像中运行；需要 Git 元数据或会修改临时 Git 仓库的脚本在 Windows 检出中运行。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `make check-linux` | 通过 | 脚本自测、版本同步、第三方许可清单（419 个组件）、两端前端 lint/单测、fmt、Clippy；Rust 测试 Hub 170、DuckDB 引擎 9、Agent 26（另 1 项手动基准按设计忽略） |
| `make smoke` | 通过 | release 二进制：登录、创建节点、私有默认值、DuckDB 单写锁、令牌轮换、Agent 上报、健康检查与版本化 Agent 分发 |
| `make e2e` | 88 通过，2 项按设计跳过 | 桌面 1280×900 与移动 390×844 Chromium；公开页、登录与全部后台页面的 v14 视觉契约、弹窗与手机底部面板 |
| `make check-docs` | 通过 | 22 个页面、23 个站内路径与资源、中文搜索、320/390/1360px 无横向溢出 |
| `make live-capacity` | 通过 | 真实套接字：单地址 4 个、匿名 64 个、管理员预留 32 个实时连接，关闭后席位回收 |
| `scripts/release.py check` 等发布脚本（Windows） | 通过 | 发布工具 15 项自测、发布矩阵、演练标签只在本地、快照安全检查 |
| `scripts/documentation_audit.py check`（Windows） | 通过 | 项目文档本地链接 |
| `scripts/publish_image.py` 对本地 registry | 通过 | 发布演练产出的两个镜像归档：架构核对、单架构推送、合成含 linux/amd64 与 linux/arm64 的索引并输出摘要 |
| `validate_workflow.py contract --phase implemented` | 通过 | 3 个界面契约；32 条内容审查提示为已复核的数据属性标识 |

未覆盖：

- 真实服务器上的完整部署（systemd、Nginx 与公共 CA 证书）。Release Rehearsal 在 CI 的一次性 runner 上演练 systemd、TLS、注册、重装与重启；真实 VPS 部署由维护者另行测试。
- 向 GHCR 的实际推送与镜像 attestation 只在打标签的发布 job 中发生，本地只对临时 registry 演练。
- OpenRC 安装由 Linux platforms 工作流的 musl 任务验证，本地未重复。
- 100/500 节点的容量基准未在本候选重跑，方法见[容量基准](bench.md)。
- 真实 iOS/Safari 设备、触摸硬件与读屏器。
