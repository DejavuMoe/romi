# 开发指南

romi 的 Hub 和 Agent 使用 Rust，管理后台与公开页使用 React。先阅读[代码导览](codebase-guide.md)定位模块，检查命令见[测试](testing.md)。

## 准备环境

Linux 构建需要 C/C++ 编译器，DuckDB 从源码静态编译。Node.js、pnpm 和 Python 版本见 `mise.toml`，Rust 版本见 `rust-toolchain.toml`。

安装对应工具链后，在仓库根运行：

```sh
make setup
make check-linux
```

`make setup` 安装锁定的前端依赖并获取 Rust 依赖。首次构建 DuckDB 耗时较长；后续构建可复用产物。

## 本地运行

在三个终端分别启动 Hub、后台和公开页：

```sh
make dev-server  # Hub：http://127.0.0.1:9911
make dev-admin   # 后台：http://127.0.0.1:5173/admin/
make dev-web     # 公开页：http://127.0.0.1:5174
```

开发 Hub 首次启动时会打印初始管理员密码。两端开发服务器把 API 请求代理给 Hub。
创建节点和注册分发仍需要 HTTPS 域名入口；完整安装流程见[部署](deployment.md)，浏览器测试使用独立实例。

只修改文档时运行 `pnpm docs:dev`，在 `http://127.0.0.1:4312/` 预览。

## 修改与检查

| 改动 | 检查 |
| --- | --- |
| 文档正文 | 对照源码检查事实，运行 `python3 scripts/documentation_audit.py check` |
| 文档站 | `make check-docs`，检查构建、导航、搜索和响应式布局 |
| 前端或共享模块 | `make frontend check-frontends`，再运行受影响的 E2E |
| Hub 或 Agent | 对应 Cargo 测试、fmt、Clippy；完整检查用 `make check-linux` |
| 存储 | 覆盖事务、精度、并发、恢复失败和迁移场景 |
| 安装或打包 | 相关脚本自测；系统服务在一次性演练环境中验证 |

产品界面以 `designs/romi-next/` 的已批准原型为规格，原型、批准和实现分别提交。工作流工具在 `.agents/skills/prototype-first-ui/`；模拟数据和原型运行时不进入生产代码。VitePress 文档页面直接修改、构建和验证。

文档按主题维护，仓库内索引为 `docs/README.md`。一个事实只在对应文档详细说明，其他页面链接过去。

## 提交改动

较大的改动先开 Issue 讨论范围。提交使用 `type(scope): subject`，例如 `fix(agent): handle missing network counters`。每次提交围绕一个问题，说明相关验证和未覆盖范围。

默认分支是 `master`。PR 描述应说明修改前后的行为、复现或验证方法；截图、日志和测试数据不得包含凭据。
发布版本前按[发布流程](release.md)核对候选与工件。
