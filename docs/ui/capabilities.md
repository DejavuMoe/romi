# 当前 UI 能力与状态

本文只记录现有源码的能力。界面规格和生产映射见 [UI 契约](implementation.md)，检查范围见 [验收状态](../readiness.md)。

## 用户与页面

匿名访客查看已公开节点；管理员管理节点、探测、通知、凭据和数据。

| Surface ID | 生产入口 | 操作 | 证据 |
| --- | --- | --- | --- |
| public | `/` | 查看汇总、卡片/列表切换、站点默认视图、明暗切换、进入详情/登录 | `web/src/App.tsx`、`Summary.tsx`、`NodeCard.tsx`、`NodeList.tsx` |
| node-detail | `/node/{id}`、`/admin/node/{id}` | CPU、RAM/ZRAM/Swap、磁盘、进程、网络与 TCP/UDP 历史、时间窗、返回/深链 | `web/src/components/NodeDetail.tsx` |
| login | `/admin/` 未登录态 | 账号密码、可选 GitHub 登录、错误提示 | `admin/src/components/Login.tsx`、`auth.rs` |
| nodes | `/admin/` | 名称/IP/标识搜索、状态筛选、管理列表、双栈 IP 复制、Agent 版本、优先级、新建/编辑/删除、带宽/协议可用性、安装、轮换、流量修正、账单 | `Admin.tsx` 的 Nodes/CreateNode/NodeForm/BillingForm/InstallDialog |
| registration | 节点页弹窗 | 开启/关闭注册窗口、复制短期命令、有效期 | `useRegisterWindow`、`RegisterDialog` |
| probes | `/admin/ping` | 新增/编辑/删除 host:port、间隔、节点指派 | `Admin.tsx` 的 Ping；`api::save_ping_task` |
| notifications | `/admin/notify` | Telegram/Webhook、模板预览、按渠道测试、未保存禁用测试、阈值、节点离线开关 | `Admin.tsx` 的 Notify/OfflineNodes；`notify.rs` |
| data | `/admin/data` | 数据统计、下载备份、上传恢复、取消、维护确认与周期配置 | `Admin.tsx` 的 Data；`api::db_*` |
| security | `/admin/security` | GitHub 配置/允许用户、修改账号/密码、会话撤销 | `Admin.tsx` 的 Security/Sessions；`auth.rs` |
| settings | `/admin/settings` | 站点名、分钟保留期、公开页及默认视图、连续在线阈值、本地 GeoLite Country 更新 | `Admin.tsx` 的 SettingsTab/GeoSettings；`api::save_settings`、`geo.rs` |

## 领域对象与权限

节点包含身份、排序、公开性、静态硬件事实、在线态、最新指标、累计流量、账单与到期信息。
IP/主机名/备注和凭据相关管理字段不向匿名快照公开。公开历史最多七天，管理员可查询一年。
探测对象包含名称、目标、间隔和节点集合；公开历史只给名称和结果，不公开探测目标/指派管理接口。
通知设置的凭据只返回已配置标记；未输入表示保持，清除是明确动作。

## 状态矩阵

| 流程 | Loading / Ready / Empty | Error / Retry | Disabled / Permission / Offline | Progress / Cancel |
| --- | --- | --- | --- | --- |
| 节点/公开页 | 首次加载、节点列表、无节点 | 请求错误与轮询回退 | 未连接/离线；匿名不可见节点不可直链读取 | WS 关闭后重连 |
| 节点详情 | 骨架、历史图、无历史 | 首次失败重试；刷新失败保留旧图 | 节点不存在或未公开 | 切页停止轮询 |
| 登录/会话 | 登录中、已登录 | 密码/网络错误 | 会话撤销退出；GitHub 未配置不可使用 | 提交按钮忙态 |
| 节点创建/安装 | 创建、一次性令牌、安装命令 | 保存/复制错误 | 非 HTTPS 域名或分发缺失时禁止 provisioning | 弹窗取消；令牌轮换确认 |
| 探测 | 加载、任务、无任务 | 失败不可伪装成空表；重试 | 管理员权限；节点可选 | 保存忙态、删除确认 |
| 通知/设置/安全 | 加载与已配置值 | 加载重试、保存/测试错误 | 秘密脱敏、允许用户空则拒绝 | 保存/发送中 |
| 数据 | 统计、无明细 | 备份/恢复/维护失败 | 管理员与数据库维护门限 | 分片进度、AbortController 取消、恢复确认 |

## 接口映射

| 操作 | HTTP / WS | 失败语义 |
| --- | --- | --- |
| 页面身份 / 实时列表 | GET `/api/me`、GET `/api/nodes`、WS `/api/ws` | 401 改变访问状态；网络错误不等于空数据 |
| 节点历史 | GET `/api/nodes/{id}/metrics?hours=&points=&series=` | 权限、窗口上限、并发拒绝 |
| 登录/注销 | POST `/api/auth/login`（username/password）、POST `/api/auth/logout` | 会话 Cookie；204 不解析 JSON |
| 节点变更 | POST `/api/nodes`、PUT/DELETE `/api/nodes/{id}`、PUT `/api/nodes/order` | 部分字段更新、删除级联/退休连接 |
| 令牌/流量 | POST `/api/nodes/{id}/token`、PUT `/api/nodes/{id}/traffic` | 单次展示；空输入不得清零累计量 |
| 注册窗口 | POST/DELETE `/api/register-window` | 短期 key，关闭后交换失败 |
| 探测 | GET/POST `/api/ping-tasks`、DELETE `/api/ping-tasks/{id}` | 目标/间隔/节点验证 |
| 通知/设置 | GET/PUT `/api/settings`、POST `/api/notify/test?channel=telegram` | 整份 patch 先验证；敏感值不回显 |
| 会话 | GET `/api/sessions`、DELETE `/api/sessions/{id}` | 当前会话撤销后的页面恢复 |
| 数据 | GET `/api/db`、GET `/api/db/backup`、POST `/api/db/restore`、POST `/api/db/maintenance` | 有界上传、并发门限、恢复回滚 |
| GeoLite | GET/POST/DELETE `/api/geolite` | 管理权限、单任务、进度、取消、失败保留旧库 |

## 交互、可访问性与限制

当前使用 React、原生表单与 Radix 弹窗；有可见焦点、明暗主题、减少动画样式。
节点排序保留拖动/方向键；移动端可以编辑非负整数优先级。列表/卡片选择在详情往返时保留。
已存在桌面/移动 Chromium E2E；不代表真实 iOS、Safari 或屏幕阅读器已验证。
生产界面按桌面/移动布局、明暗主题、键盘焦点与取消进行验证；具体矩阵以对应运行记录为准。
未知：长期移动网络断续、真实 iOS/Safari 和读屏器表现。外部主题入口已移除。

文案依据现有中文领域术语与实际接口，没有获准的营销/品牌宣传文案。
