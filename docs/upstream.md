# 上游来源与导入边界

2026-09-17 按引用研究固定下列提交，未追随之后的 main/latest：

| 上游 | 完整提交 | romi 映射 |
| --- | --- | --- |
| https://github.com/monitor-probe/monitor | `4147b8f8323bced199f108c5a1bf3df8bc08d87b` | 原 `web-admin/` → `admin/`，其余应用源码 → `server/` |
| https://github.com/monitor-probe/agent | `633ca139a87df9dcebde78894e9807aa388d076c` | `agent/` |
| https://github.com/monitor-probe/monitor-theme-default | `c71d8260d841c97e909649383b5be0eb156c527b` | `web/` |

导入方式为指定提交的 `git archive` 源码快照，整个项目只有根 `.git`；没有子模块、
嵌套仓库，也没有声称保留完整上游历史。原始提交和许可证摘要保存在 `upstream.lock.json`。
未来更新应先对照两个上游 SHA 的差异，再按上述映射审查合入；不能直接使用 subtree pull。

初始化适配：

- 根 Makefile 统一安装、前端构建、Rust 编译、检查和开发命令。
- 初次导入保留 npm 锁文件；现已通过 `pnpm import` 迁移为根 pnpm workspace 和统一锁文件。
  原有前端依赖版本及 integrity 校验保持一致。Rust 仍保留两份 Cargo 锁文件，共用根 `target/` 编译缓存。
- 管理端嵌入路径改为 `../admin/dist`；`make frontend` 将 `web/` 的本地构建产物、主题元数据、预览图
  放到 `server/target/theme`。`build.rs` 只检查文件，不下载或构建前端。
- 删除上游 latest 二进制转发代码及其专用测试；romi 只从已安装的本地分发提供版本化
  `/agent/vX.Y.Z/x86_64`，未配置分发时相关路由返回 503。
- 原三个 `.github/`、上游安装脚本、Dockerfile 和主题下载脚本归档到 `docs/upstream/`，
  只用于对照，不能作为 romi 的安装或发布入口。romi 自有 `.github/workflows/release.yml` 只在
  推送 `v*` 标签时发布，构建任务与被手动触发的 dry-run 保持只读。
- 两个 Vite 入口使用原生代理访问 Hub 提供的另一应用页面，修复开发模式跨应用导航落到自身 SPA 的问题。
  代理规则依据 [Vite server.proxy](https://vite.dev/config/server-options.html#server-proxy)，未添加插件或前端依赖。
- v0.4A 起，公开 Rust 包名/二进制统一为 `romi-hub` / `romi-agent`，版本源切换为根 `VERSION`
  并同步 Cargo 版本；对外环境变量使用 `ROMI_SERVER` / `ROMI_TOKEN` / `ROMI_LOG`。Cookie 名、
  `monitor_session` 等内部标识的改名不属于本阶段公开产品身份，不提供旧二进制名兼容符号或别名。

许可证正文保留，`admin/LICENSE` 从其原仓库复制。根 MIT 许可证增加 Dejavu Moe 版权声明。
`THIRD_PARTY_NOTICES.md` 不是全量依赖许可证审计结果。

上游测试中的 `HISTORY_GATE` 为进程全局共享；并行测试曾出现 `NoPermits`。
根 `make check` 对服务端采用 `--test-threads=1`，保留闸门并发限制断言，不改生产限流。
