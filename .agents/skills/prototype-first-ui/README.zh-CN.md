# Prototype-first UI

[English](README.md)

面向通用 AI Agent 的项目级设计能力系统。建立共享的视觉基础和组件规则，
用于 UI、网站、演示文稿、文档排版、图解、品牌视觉和数据看板。
保留原来的调用名称；3.0 起独立运行，不再依赖 Baoyu-Design。

一个技能入口，按任务读取对应能力；复用项目现有格式、组件和工具。
不捆绑编辑器、不要求专有产物运行时、不修改全局配置，也不强制安装外部设计技能。

## 能力范围

| 模式 | 产出 |
|---|---|
| `system` | 品牌基础、语义令牌、真实组件预览、组合规范和使用方法 |
| `prototype` / `explore` | 页面、应用、线框图与可操作的交互流程 |
| `compose` | 幻灯片、文档排版、海报、社交素材、图解与品牌视觉 |
| `visualize` | 数据可追溯、指标可核对的图表和看板 |
| `verify` / `sync` | 渲染审阅、导出验证和受控更新 |

生产 UI 保留审计、审批与实现门禁。独立设计产物按媒介验证，
不为幻灯片或海报虚构生产接口和 UI 审批提交。

## 依赖

- 支持文件读写的 AI Agent；执行检查时需要命令工具。
- 内置验证器需要 Python 3.9+，只用标准库；UI 提交门禁需要 Git。
- 视觉验证需要浏览器、原生运行时或对应格式的渲染器。
- 图片生成、原生格式导出和项目库按需使用；Node.js 仅用于 DOM 采集脚本的
  语法检查，或所选运行时，不是设计能力的通用前提。

## 安装

在目标项目目录运行，在安装器中选择**项目级安装**和所用 Agent：

```sh
npx skills add DejavuMoe/prototype-first-ui --skill prototype-first-ui --copy
```

也可以从 [GitHub Releases](https://github.com/DejavuMoe/prototype-first-ui/releases)
下载技能包，解压到 `<项目>/.agents/skills/prototype-first-ui/`，
或宿主的其他项目级技能目录。不要使用全局安装或用户主目录中的技能路径。
可选安装器需要 Node.js，手动解压不需要。

本仓库是技能的分发源码；开发本技能无需在自身目录再嵌套安装一份，
也无需安装到全局。不支持自动发现的 Agent 可以直接读取安装后的 `SKILL.md`。

## 使用

```text
$prototype-first-ui system
提取当前项目的字体、语义颜色与可复用组件，建立设计系统。
使用真实组件做预览，并说明页面、幻灯片与图表如何使用这套系统。

$prototype-first-ui compose
使用项目设计系统和已确认文案，制作六页可编辑的产品介绍幻灯片。
检查渲染结果，并明确导出能力的限制。
```

```text
$prototype-first-ui prototype

为文件管理器设计批量重命名流程，包含修改预览、文件名冲突和取消操作。
完成后展示原型供审阅。
```

审阅通过后：

```text
$prototype-first-ui implement

实现设计提交 <SHA> 中已批准的 designs/file-manager/index.html，
本次只实现批量重命名流程。
```

不支持命名调用的 Agent，可以直接读取安装目录中的 `SKILL.md`。
更多示例：[中文](references/prompts.zh-CN.md) · [English](references/prompts.en.md)。

## 工作流

生产 UI：审计 → 原型 → 审阅 → 批准 → 实现 → 验证。

| 模式 | 用途 |
|---|---|
| `audit` | 记录现有产品能力、接口和状态 |
| `explore` | 比较不同设计方向 |
| `prototype` | 创建或修改交互原型 |
| `approve` | 登记指定原型版本的批准 |
| `implement` | 实现已批准的功能 |
| `sync` | 同步原型与生产界面的差异 |
| `verify` | 检查内容、视觉、交互和无障碍 |
| `bootstrap` | 可选的仓库清理与本地历史重置，包含恢复快照 |

[技能指令](SKILL.md) · [工作流参考](references/workflow.md) ·
[发布指南](RELEASING.md) · [更新日志](CHANGELOG.md)

## 从 2.x 升级

审批记录改为项目自有的 `design-review.json`，不再读取 `_d_meta.json`。
实现门禁还会核对所有已登记原型依赖，包括图片等二进制资产。
按[迁移说明](references/design-review.md)处理旧项目；旧状态标记不会自动变成新批准。
原有 UI、文案和来源契约仍可使用，不需要安装上游技能。

上游调研与能力取舍见[设计来源说明](references/design-lineage.md)。
本次没有打包上游提示词、编辑器、字体或专有产物运行时。

## 许可证

[MIT](LICENSE)
