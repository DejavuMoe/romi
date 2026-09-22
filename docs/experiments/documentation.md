# 文档与提交结构消融

本实验只改变文档和历史组织，比较完整材料、仅归档淘汰材料、再重写当前契约三种状态。
67 份生产源文件逐字节不变；发布清单移除退出项目的外部版本锁文件，相关打包检查单独执行。

| 指标 | 完整材料 | 仅归档 | 当前契约 |
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

基线来自整理前的恢复快照。仅归档变体使用快照中仍被保留的路径及其原始内容；当前变体读取实际工作树。
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
