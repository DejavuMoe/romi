# 界面实现契约

当前已批准并实施的界面为 v14。规格在 `designs/romi-next/revision-v14/`：`index.html` 与 `public.html` 是两个应用，`system.html` 是视觉规范。状态和源文件映射由 `designs/romi-next/ui-contract.json` 管理。
v14 在 v12 与其后修订（节点可见性、当前密码、ARIA 页签、移除 GitHub 登录、会话列表失败状态）的内容上收敛视觉，不增删功能和文案：

- 方正、无阴影：`styles/theme.css` 用不分层的全局规则把圆角和阴影置零，任何工具类都无法重新引入；层次靠 1px 线条与底色；
- 汇总条、KPI 与信息网格连续平铺，格子共用 1px 分隔线，数字贴底；节点卡片是分区面板，资源三格平铺，用量条 4px；
- 整个界面使用等宽字体，数据为表格数字；字号以 13px 为正文、12px 为说明；
- 一种焦点样式：2px 描边；控件桌面 32px，触屏或 767px 以下 44px；只保留 120ms 的颜色与边框过渡；
- 面板统一 16px 内边距；次要按钮为透明描边，主按钮为实心；表头与字段标签为 12px 常规字重；复选项整行可点，手机上整行不低于 44px。

| 界面 | 生产位置 | 验收重点 |
| --- | --- | --- |
| 管理列表 | `admin/src/components/sections/nodes.tsx`、`node-forms.tsx` | ID/优先级、地址、版本、复制、编辑菜单、首行对齐 |
| 登录/导航 | `Login.tsx`、`Navigation.tsx` | 间距、会话、焦点、滚动锁定不抖动 |
| 公开卡片/列表 | `web/src/components/NodeCard.tsx`、`NodeList.tsx` | 匿名隔离、资源条、单位和视图上下文 |
| 默认视图 | `server/src/api.rs`、两端设置/页面 | cards/list 服务端保存，访客切换不写回 |
| 监测/选择行 | `sections/probes.tsx`、共享 CSS | 勾选、窄屏列收敛、单一复选标记、操作按钮同行右对齐 |
| 通知/数据/安全/设置 | `sections/notify.tsx`、`data.tsx`、`security.tsx`、`settings.tsx` | 面板间距、数据库数字平铺、复选行、错误位不留空洞 |
| 历史详情 | `web/src/components/NodeDetail.tsx` | 六类图表、缺样留空、RAM/ZRAM/Swap、KPI |

生产不引用原型运行库或模拟接口。权限和分发前置条件以 Hub 为准；`node-{id}` 不等于认证令牌。
回归入口为 `e2e/approved-v14.spec.mjs`（公开页、登录与全部后台页面：两种主题下无圆角与阴影、320–1440 不溢出、手机控件 ≥44px；后台列表首行对齐、等宽字体与 2px 焦点）、`e2e/approved-v12.spec.mjs`、`e2e/approved-v13.spec.mjs`、`e2e/public.spec.mjs`、`e2e/admin.spec.mjs` 和 `e2e/visual-contract.spec.mjs`。
v12 时期保留的浏览器观测见 [布局](v12-responsive.json)、[导航](v12-navigation.json)、[复制与选择行](v12-interactions.json)，采集于 v14 之前。
这些记录不替代修改后的检查。当前验证范围见 [验收状态](../readiness.md)。
