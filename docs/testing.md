# 测试

按改动范围选择下面的检查。命令在仓库根执行，浏览器测试需要 Playwright Chromium。

## Linux 检查

在 Linux 上安装锁定依赖并运行完整检查：

```sh
make setup && make check-linux
```

`make check-linux` 包含两端构建、lint/单测、Rust fmt/Clippy/测试、安装器和演练驱动离线检查，
以及版本同步（含[验收状态](readiness.md)中当前版本的小节）与第三方许可清单核对。
依赖变化后运行 `python3 scripts/third_party.py generate` 重新生成 `THIRD_PARTY_LICENSES.txt`，否则 `make check-licenses` 失败。
它不需要 Git 元数据。`make check` 还运行修改临时 Git 仓库的发布检查（`make check-release-scripts`），需要完整 Git 检出或一次性 CI 环境。
`documentation_audit.py check` 用 `git ls-files` 检查 `docs/`、根 README 与 AGENTS、组件 README、`THIRD_PARTY_NOTICES.md` 与设计 README 的本地链接，
也需在带 Git 元数据的检出中运行：

```sh
python3 scripts/release.py check
python3 scripts/test_release_matrix.py
python3 scripts/rehearse_release.py check
python3 scripts/package.py check
python3 scripts/documentation_audit.py check
```

只改前端时运行 `make frontend check-frontends`；Rust 局部修改运行对应 Cargo 测试，按影响扩展到集成检查。
文档站改动运行 `make check-docs`；它检查生成页面、站内链接与锚点、标志资源、中文搜索、移动导航，以及所有页面在明暗主题、320/390/768/1360px 下的横向溢出。

## 浏览器和原生进程

首次在 Linux 安装锁定依赖和浏览器，然后运行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
make e2e
make smoke
make live-capacity
```

`make e2e` 构建 Hub 后启动临时服务；已有精确产物可用 `ROMI_E2E_BIN_DIR=<目录> pnpm test:e2e`。
Hub 构建要求已生成的前端页面，直接调用 Cargo 前先运行 `make frontend`。
每条 E2E 使用独立 Hub、数据库和回环随机端口；不使用现有实例或生产凭据。
图表故障测试只拦截指定请求，其余请求仍走真实 Hub。Agent 上报与历史计算分别由 smoke 和 Rust 测试覆盖。
`make live-capacity` 用真实套接字检查实时连接的各类席位（数值见[架构](architecture.md)）以及关闭后席位回收；CI 对打包产物运行同一脚本，改动这些上限时本地先跑它。

重点包括会话、匿名隔离、保存/刷新、错误恢复、详情导航、资源缺样、复制、默认视图和移动导航。
桌面/移动 Chromium 模拟不等于真实 iOS/Safari、触摸硬件或读屏器验收。
真实 HTTPS 反向代理与 systemd 由 Release Rehearsal 验证，OpenRC 由 Linux platforms 的 musl 任务验证，见[发布](release.md)；
备份与恢复由 Rust 存储测试和 E2E 覆盖；跨版本升级没有自动演练。

失败报告在 `playwright-report/`、`test-results/`，均不提交。截图和日志不得包含凭据、数据库或浏览器认证状态。
