# 文档与提交结构消融

以下为 2026-09-22 的历史实验：只改变文档和历史组织，比较完整材料、仅归档淘汰材料、再重写当时契约三种状态。
67 份生产源文件逐字节不变；发布清单移除退出项目的外部版本锁文件，相关打包检查单独执行。

| 指标 | 完整材料 | 仅归档 | 当时契约 |
| --- | ---: | ---: | ---: |
| 项目文件 | 1147 | 535 | 538 |
| 项目 Markdown | 28 | 21 | 21 |
| Markdown 行数 | 2351 | 1870 | 1015 |
| Markdown 字符数 | 87195 | 68218 | 35026 |
| 设计文件 | 583 | 67 | 67 |
| 重复长段落副本 | 1 | 1 | 1 |

行数减少 56.8%，字符数减少 59.8%。保留的重复段落是开发入口命令，不为追求零重复而隐藏必要操作。
这些指标不证明模型理解速度或运行时性能；效果限于缩小阅读范围、明确事实归属和移除过时入口。

## 测量

入口为 `scripts/documentation_audit.py`，原始结果见 [documentation.json](documentation.json)。
行数/字符数覆盖根 README、AGENTS、三个组件 README 及 docs 下的 Markdown；统一为 UTF-8/LF，不含本报告、设计产物和第三方技能文档。
重复项按超过 80 字符的完整相同段落计数。总文件数包括候选源树中未忽略的文件。

基线来自整理前的恢复快照。仅归档变体使用快照中仍被保留的路径及其原始内容；当时的契约变体读取该轮工作树。
对照需要本地保存的基线指标 JSON 和工作树 ZIP；它们不随项目发布。

```sh
python scripts/documentation_audit.py check
python scripts/documentation_audit.py measure --baseline <baseline.json> --snapshot <working-tree.zip> --output <result.json>
```

## 提交组织

旧 master 可达历史为 99 个提交。新的 master 按以下五个交付阶段重建，使用实际作者和时间：

1. `chore: establish standalone romi runtime`
2. `docs: define product and data contracts`
3. `chore: define phased development and agent rules`
4. `design: establish approved interface contract`
5. `test: record documentation ablation and baseline checks`

这表示交付分组，不表示本次重新开发了已有源码。旧历史和标签只保存在恢复材料中，远端历史不受本地重建影响。
项目根许可证为 Dejavu Moe 的 MIT；第三方部分保留所需声明，许可文件不作为外部版本跟随门禁。
验证范围见 [验收状态](../readiness.md)。

## 2026-09-24 非代码文档审校

本轮基线是含待审查[代码导览](../codebase-guide.md)的**未提交工作树**。只修改 Markdown；既有原型、浏览器截图、JSON 观测和运行源码保持原样。将改动分成两个可区分的变体：先仅把架构页重复的总览图与模块清单收拢到代码导览，再修正其他文档的事实与时效表述。第二步是审校，不是单因素性能消融。
核对范围为仓库内 30 份 Markdown（包括入口、组件说明、设计说明、许可与历史实验）；另外 61 份文档/设计 JSON 通过语法解析，历史观测数据未改。

| 静态度量 | A：审校前 | B：只消除架构重复 | C：完整审校 |
| --- | ---: | ---: | ---: |
| 统计内 Markdown 文件 | 25 | 25 | 25 |
| Markdown 行数 | 1279 | 1258 | 1260 |
| Markdown 字符数 | 50028 | 49665 | 50014 |
| 重复长段落副本 | 1 | 1 | 1 |

B 比 A 少 21 行、363 字；C 比 A 少 19 行、14 字。审校所加的必要边界抵消了大部分字符减少，因此不能据此宣称整体阅读负担显著下降。计数由 `scripts/documentation_audit.py measure` 对同一工作树依次生成；脚本不把本实验报告计入 Markdown 度量。三次原始 JSON 保存在仓库外；A 是未提交状态，不是可由一个公开提交独立重建的基线。
重复长段落的唯一一处是根 README 与[测试](../testing.md)共有的 Linux 检查命令；两个入口都需要独立可复制的命令，因此保留。

| 清理点 | 对照的实现 |
| --- | --- |
| 架构页移除与导览重复的图和模块清单，并保留并发上限 | `server/src/main.rs`、`api.rs`、`db/mod.rs`、`notify.rs` |
| 将“ID 永不复用”改为进程内递增、启动/恢复后可能复用末尾 ID | `server/src/db/schema.rs::resync_ids`、`db/mod.rs::open_with`、`db/backup.rs` |
| 纠正恢复分片 4 MiB、Hub 单请求上限 8 MiB，以及 x86-64/aarch64 ELF 检查 | `admin/src/lib/api.ts`、`server/src/api.rs`、`distribution.rs` |
| 说明注册 key 在一小时窗口内可用于最多 100 个节点 | `server/src/api.rs::agent_register` |
| 将旧测试数字归入对应历史实验，不冒充当前候选结果 | [验收状态](../readiness.md)、[运行代码清理消融](runtime-cleanup.md) |

A 的本地链接检查和 `make check-docs` 通过；B 的本地链接检查通过；C 的本地链接检查、`make check-docs` 与 `git diff --check` 通过。C 的文档站检查覆盖 22 个页面、28 个本地路径/资源、中文搜索和窄屏布局。运行代码未修改；这些检查不证明业务功能、真实安装、远端 CI 或第三方许可内容。ID 跨重启复用是本轮发现的代码与原文档契约差异，本轮只修正文档，未修复代码。
