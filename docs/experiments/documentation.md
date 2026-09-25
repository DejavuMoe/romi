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

## 历史重建

实验结束后，项目历史按交付阶段重建，重建后的历史即现在的 `master`，根提交为 `chore: establish standalone romi runtime`。
重建前的历史与标签只保存在仓库外的恢复材料中，本页数字无法从公开历史独立复现。验证范围见 [验收状态](../readiness.md)。
