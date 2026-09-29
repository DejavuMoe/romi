# 界面实现契约

已批准的界面为 v15「晨昏」。规格在 `designs/romi-next/revision-v15/`：`public.html` 是状态页，`index.html` 是管理面板，`system.html` 是视觉规范。状态和源文件映射由 `designs/romi-next/ui-contract.json` 管理。
v15 分批实施：状态页 `/` 已按 v15 实现；节点详情与管理面板仍是 v14 的布局（侧栏与顶栏、管理列表、560px 弹窗与手机贴底面板、历史图表），颜色、圆角和字号已随共享令牌换成 v15，随后逐页迁移。

v15 的共享规则（`styles/theme.css`、`styles/controls.css`、`styles/public.css`）：

- 字号只取 11/12/13/14/16/18/24/32/48/64px，正文 14px，写在 `body` 上，`rem` 保持浏览器默认；圆角只取 4/6/10/16/20px 与全圆；系统无衬线字体，数字为表格数字；
- 明暗两套调色板，强调色浅色 `#5a44ee`、深色 `#8e7dff`；旧的 `--primary`、`--border` 等名称指向 v15 令牌；
- 控件桌面 36px、紧凑 30px，触屏或 767px 以下不低于 44px；一种焦点样式：2px 描边、2px 偏移；
- 弹窗打开时，滚动条槽位换成等宽的右内边距，遮罩覆盖整个窗口，页面不移动；槽宽由 `shared/gutter.ts` 在页面空闲时测量；
- 减少动画时停止呼吸点与环境动画，地球静止但照常绘制；
- 界面文字以中文为源，经 `T()` 取英文（`shared/i18n.ts`、`shared/locale-en.ts`）。语言跟随浏览器，可在顶栏切换并保存在本机；`<html lang>` 随之更新。

状态页的组成：

- 概览：在线数、可按状态筛选的四个状态块、全队实时速率与累计流量；有国家/地区的节点标在地球上，颜色表示状态，流线粗细随流量；悬停或键盘聚焦可查看节点并进入详情；
- 节点卡片/列表：CPU（含近三分钟走势，由页面收到的推送累积）、内存、磁盘、上下行速率、本期流量与按当前速度预计的用量、价格、到期、连续在线；按名称、地区或系统搜索；
- 顶栏：站点名、节点搜索面板（`/` 或 ⌘K）、语言、主题、后台入口；页脚：实时连接状态、节点与国家/地区数、时区和按当前日照绘制的昼夜地图；
- 状态页未公开且未登录时，显示登录提示，背景为缓慢转动的地球。

| 界面 | 生产位置 | 验收重点 |
| --- | --- | --- |
| 状态页 | `web/src/App.tsx`、`components/Fleet.tsx`、`Globe.tsx`、`DayMap.tsx`、`Palette.tsx`、`Shell.tsx`、`components/ui/`、`lib/globe.ts`、`shared/geo.ts`、`shared/land.ts` | 匿名隔离、状态筛选与搜索、卡片/列表、中英文、地球与昼夜图、关闭页 |
| 默认视图 | `server/src/api.rs`、两端设置/页面 | cards/list 服务端保存，访客切换不写回 |
| 历史详情（v14 布局） | `web/src/components/NodeDetail.tsx` | 六类图表、缺样留空、RAM/ZRAM/Swap、KPI |
| 管理列表（v14 布局） | `admin/src/components/sections/nodes.tsx`、`node-forms.tsx` | ID/优先级、地址、版本、复制、编辑菜单、首行对齐 |
| 登录/导航（v14 布局） | `Login.tsx`、`Navigation.tsx` | 会话、焦点、滚动锁定不抖动；退出后回到登录表单 |
| 监测/通知/数据/安全/设置（v14 布局） | `sections/probes.tsx`、`notify.tsx`、`data.tsx`、`security.tsx`、`settings.tsx` | 勾选、面板间距、复选行、错误位不留空洞 |

生产不引用原型运行库或模拟接口。权限和分发前置条件以 Hub 为准；`node-{id}` 不等于认证令牌。
回归入口：

- `e2e/approved-v15.spec.mjs`：状态页在中英文、明暗主题下加载，英文页不留中文，不出现后台数据；320–1440 不溢出；手机控件 ≥44px；字号与圆角在刻度上，标记与文字居中；地球绘制、转动，减少动画时静止；关闭页；跳转链接、焦点与搜索面板；状态筛选与搜索；
- `e2e/approved-v14.spec.mjs`：节点详情与后台 320–1440 不溢出、手机控件 ≥44px、后台列表首行对齐、2px 焦点、弹窗标题栏与手机贴底面板；
- `e2e/approved-v12.spec.mjs`、`e2e/approved-v13.spec.mjs`、`e2e/public.spec.mjs`、`e2e/admin.spec.mjs`、`e2e/visual-contract.spec.mjs`；
- `shared/i18n.test.ts`：每个传给 `T()` 的中文文本都有英文条目，占位符一致。

当前验证范围见 [验收状态](../readiness.md)。
