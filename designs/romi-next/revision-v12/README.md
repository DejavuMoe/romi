# v12 界面契约

状态：v12 已批准并实施；当前工作副本含一处待审阅修订，两个受影响的界面标记为 needs-review。

待审阅的修订只增加两个控件，其余保持 v12：

- 节点编辑弹窗增加「公开状态页」显示/不显示选择，公开页因此只列出已发布的节点，管理列表保留「私有」标记；
- 安全页「账号与密码」增加「当前密码」，输入错误时就地拒绝并保留已填内容。

`node designs/romi-next/revision-v12/exercise-v13.cjs` 在浏览器中实际操作这两个控件，
并按 collector 格式采集两个界面的 DOM 文案到 `captures/v13-*.json`。

后台仅管理列表：ID/优先级、名称、两种 IP、Agent 版本、接入标识与编辑菜单。
IP 和标识整块可复制；图标紧邻值，桌面悬浮/聚焦显示，触屏常显淡色。各列首行对齐，安装入口集中在编辑菜单。
公开页保留卡片/列表，管理员保存默认视图。选择行、登录间距、移动导航和资源数字使用共享视觉规则。

入口为 `index.html` 与 `public.html`，使用 HTTP 预览；登录可用 admin/admin，仅检查非空。
服务端权限、凭据和安装行为不由原型模拟证明。

`node designs/romi-next/revision-v12/verify.cjs` 校验语法及保留的几何记录；该记录采集于 v12，未随本次修订重采。
截图在 `screenshots/`，观测在 `responsive-checks.json`、`interaction-checks.json`，文案清单位于上层目录。
旧浏览器记录只对应采集时的条件，修改后应重新验证。
