# 界面实现契约

当前已批准并实施的界面为 v12 加 v13 修订。规格在 `designs/romi-next/revision-v12/`，状态和源文件映射由 `designs/romi-next/ui-contract.json` 管理。
v13 修订新增两个控件：节点编辑弹窗的「公开状态页」显示/不显示选择，以及安全页修改账号或密码时必填的「当前密码」。
同一修订还把历史页签改为完整的 ARIA tabs（方向键、Home/End、页签与面板互指），并移除公开卡片上覆盖内容的 `aria-label`。

| 界面 | 生产位置 | 验收重点 |
| --- | --- | --- |
| 管理列表 | `admin/src/components/Admin.tsx` | ID/优先级、地址、版本、复制、编辑菜单、首行对齐 |
| 登录/导航 | `Login.tsx`、`Navigation.tsx` | 间距、会话、焦点、滚动锁定不抖动 |
| 公开卡片/列表 | `web/src/components/NodeCard.tsx`、`NodeList.tsx` | 匿名隔离、资源条、单位和视图上下文 |
| 默认视图 | `server/src/api.rs`、两端设置/页面 | cards/list 服务端保存，访客切换不写回 |
| 监测/选择行 | `Admin.tsx`、共享 CSS | 勾选、窄屏列收敛、单一复选标记 |
| 历史详情 | `web/src/components/NodeDetail.tsx` | 六类图表、缺样留空、RAM/ZRAM/Swap、KPI |

生产不引用原型运行库或模拟接口。权限和分发前置条件以 Hub 为准；`node-{id}` 不等于认证令牌。
回归入口为 `e2e/approved-v12.spec.mjs`、`e2e/approved-v13.spec.mjs`、`e2e/public.spec.mjs`、`e2e/admin.spec.mjs` 和 `e2e/visual-contract.spec.mjs`。
保留的浏览器观测见 [布局](v12-responsive.json)、[导航](v12-navigation.json)、[复制与选择行](v12-interactions.json)。
这些记录不替代修改后的检查。当前验证范围见 [验收状态](../readiness.md)。
