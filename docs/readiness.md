# 初始化验收（2026-09-17）

> 本文为第一阶段历史记录。后续安全与发行改动以 [安全基线](security-baseline.md) 为准。

当前状态：可以开始本地开发。不是生产发布或完整安全验收。

| 项目 | 实际验证 |
| --- | --- |
| 源码 | 三个固定 SHA 的全部原始跟踪文件均可在四个应用目录或 `docs/upstream/` 对应找到 |
| 许可与依赖锁定 | 四个组件 LICENSE 的 SHA-256 与原始来源一致；两份 Cargo.lock、两份 package-lock.json 字节未变 |
| 工具链 | Rust 1.98.0、Node.js 24.21.0、npm 11.19.0 |
| 前端 | admin/web TypeScript + Vite 构建、oxlint 和现有 Node 测试均通过 |
| Rust | rustfmt、clippy `-D warnings`；server 98、agent 19 项测试全部通过 |
| Debug | `CARGO_NET_OFFLINE=true make smoke` 通过 |
| Release | `CARGO_NET_OFFLINE=true make release`、`python3 scripts/smoke.py --release` 通过 |
| 进程联通 | 临时回环 Hub：API 登录、创建节点、本仓 Agent WebSocket 实时指标、断开后离线状态均通过 |
| 资源 | 服务端返回的两个 HTML 与本地 dist 一致，引用的 JS/CSS 可用；上游分发路由返回 503 |
| 浏览器 | Codex 内置浏览器 1280×720：9911 的公开页和后台登录页可见，登录链接跳转正确，观察到的 error/warn 日志为空 |
| 实时代理 | 5173 与 5174 的 `/api/ws` 均实际接收到连续两帧节点数据 |
| 开发入口 | 5173/admin 与 5174 可见；修复并复测 5174→后台、5173→公开页→后台的导航，观察到的 error/warn 日志为空 |

复现命令见根 README / Makefile。浏览器检查仅覆盖上述入口与导航，
不代表后台所有功能、移动端或其他浏览器已经测试。
Vite 终端在页面切换/断开期间出现过 `ws proxy EPIPE`；补验确认两条代理均能连续收帧。
临时 WebSocket 客户端等待关闭握手时未自行退出，数据流验证改为收帧后显式结束探测进程；
本轮没有修改或完整验收上游的连接关闭行为。完整登录和节点/Agent 链路由 Python 进程 smoke 验证。
测试节点国家字段预置为 ZZ，避免本轮联通检查调用 ipinfo；没有验证第三方接口。

`make check` 串行运行服务端测试，原因是上游测试共用静态 HISTORY_GATE，
并行时观察到 `history_queries_past_the_gate_are_refused_rather_than_queued` 因 NoPermits 失败。
根命令保留原有并发边界断言，没有修改生产闸门。

未完成、留待下一阶段：

- romi 自有远程仓库、CI 托管、发行清单、签名、跨架构构建、镜像与安装器。
- 依赖/资源的全量许可证检查与安全审计。
- 令牌摘要迁移、默认私有、第三方外联策略、主题同源信任、安装权限、完整兼容性及恢复测试。
- UI 与内部命名的统一品牌化、功能定制、性能测量。

本轮没有推送、发布或安装系统服务。开发和浏览器验证进程均已在结束前停止。
Git 根仓库已创建，文件将作为首批变更保留；首次提交因本机 GPG 等待解锁而取消，未禁用签名。
