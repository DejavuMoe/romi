# 测试

验证必须对应实际源树与构建产物；历史记录不能替代修改后的检查。

## Windows 与 Linux

Windows 负责源码和 Git。Linux 检查使用 ext4 镜像：

```powershell
linux-task.ps1 -Mode build -Project (Get-Location).Path -Command 'make setup && make check-linux'
```

`make check-linux` 包含两端构建、lint/单测、Rust fmt/Clippy/测试、安装器和演练驱动离线检查。
它不需要 Git 元数据。`make check` 还运行修改临时 Git 仓库的发布检查，留给 Windows 或一次性 CI。

```powershell
python -X utf8 scripts/documentation_audit.py check
python -X utf8 scripts/release.py check
python -X utf8 scripts/package.py check
python -X utf8 scripts/test_release_matrix.py
```

只改前端时运行 `make frontend check-frontends`；Rust 局部修改运行对应 Cargo 测试，按影响扩展到集成检查。
文档站改动运行 `make check-docs`；它需要已安装的 Playwright Chromium，检查生成页面的站内链接、中文搜索和窄屏溢出。

## 浏览器和原生进程

首次在 Linux 安装锁定依赖和浏览器，然后运行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
make e2e
make smoke
```

`make e2e` 构建 Hub 后启动临时服务；已有精确产物可用 `ROMI_E2E_BIN_DIR=<目录> pnpm test:e2e`。
WSL 同步可能清除前端 dist，所以直接调用 Cargo 前先运行 `make frontend`。
每条 E2E 使用独立 Hub、数据库和回环随机端口；不使用现有实例或生产凭据。
图表故障测试只拦截指定请求，其余请求仍走真实 Hub。Agent 上报与历史计算分别由 smoke 和 Rust 测试覆盖。

重点包括会话、匿名隔离、保存/刷新、错误恢复、详情导航、资源缺样、复制、默认视图和移动导航。
桌面/移动 Chromium 模拟不等于真实 iOS/Safari、触摸硬件或读屏器验收。
真实 HTTPS、systemd/OpenRC、升级和备份恢复按 [发布](release.md) 的演练入口验证。

失败报告在 `playwright-report/`、`test-results/`，均不提交。截图和日志不得包含凭据、数据库或浏览器认证状态。
构建镜像中的报告只按明确需要复制到 Windows，不反向同步整个镜像。
