# romi — Omarchy 视觉原型 v2

一套界面，Flexoki Light 亮色与 Hackerman 暗色配对。本目录为设计提案，尚未替换运行中的应用。
第一版 A/B/C/D 已废弃，不再作为后续视觉或功能规划依据。

| 页面 | Flexoki Light | Hackerman |
| --- | --- | --- |
| 主机总览 | [查看](overview-flexoki.png) | [查看](overview-hackerman.png) |
| 历史与多节点比较 | [查看](history-flexoki.png) | [查看](history-hackerman.png) |
| 资产、通知与管理细节 | [查看](admin-flexoki-v2.png) | [查看](admin-hackerman-v2.png) |

## 本次确认

- 小型顶部导航、细线窗格、直角、等宽数字和少量强调色。
- 不使用大面积彩色侧栏、圆角卡片堆、阴影、玻璃或装饰插画。
- 主机展示、筛选与聚合；历史时间选择和多节点叠加/并排比较。
- 标签与批量设置；负载、流量、到期通知及投递记录。
- 普通网速与流量监控保留。原型不再包含主动探测、节点分组、HTTP 或证书监控。

## 范围与来源

完整功能边界和数据含义见 [BRIEF.md](BRIEF.md)。
真实主题色值、来源文件摘要及基本文字对比度见 [theme-reference.json](theme-reference.json)。
生成提示词见 [prompts.json](prompts.json)，管理图的定向修正提示词另存为 `admin-*-v2-prompt.txt`。

图像使用内置 ImageGen，先参考本机 Omarchy 主题预览生成亮色，再以亮色图及 Hackerman 预览生成配对暗色。
未安装或切换主题，未修改 `/usr/share/omarchy/` 或桌面配置。

所有主机、账号、时间、统计和通知均为示意，不含本机真实凭证。位图配色和曲线存在生成误差；
正式实现以 theme-reference 中色值、实际数据和 BRIEF 中语义为准。
管理图中的“恢复前确认”不提供一键清空全部数据功能。

这些图片展示了计划新增的标签、批量操作、多节点对比和负载通知；
应用代码尚未实施这些能力，也尚未删除现有主动 TCP 探测链路。下一步应按 BRIEF 完整实施并验证。
