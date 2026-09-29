# v12 界面契约

状态：已被 `revision-v14` 取代。v12 含 v13 修订：节点可见性、当前密码确认、无障碍、只用账号密码登录与会话列表的失败状态；v14 在其内容上收敛了视觉。

`node designs/romi-next/revision-v12/exercise-v13.cjs` 在浏览器中实际操作节点可见性与当前密码两个控件，
并按 collector 格式采集两个界面的 DOM 文案到 `captures/v13-*.json`。

后台仅管理列表：ID/优先级、名称、两种 IP、Agent 版本、接入标识与编辑菜单。
IP 和标识整块可复制；图标紧邻值，桌面悬浮/聚焦显示，触屏常显淡色。各列首行对齐，安装入口集中在编辑菜单。
公开页保留卡片/列表，管理员保存默认视图。选择行、登录间距、移动导航和资源数字使用共享视觉规则。

入口为 `index.html` 与 `public.html`，使用 HTTP 预览；登录可用 admin/admin，仅检查非空。
服务端权限、凭据和安装行为不由原型模拟证明。

`node designs/romi-next/revision-v12/verify.cjs` 校验语法及保留的几何记录；几何记录采集于 v12。
截图在 `screenshots/`，观测在 `responsive-checks.json`、`interaction-checks.json`，文案清单位于上层目录。
旧浏览器记录只对应采集时的条件，修改后应重新验证。
