# 当前 UI 能力与状态

本文只记录现有源码的能力。界面规格和生产映射见[界面实现](implementation.md)，检查范围见 [验收状态](../readiness.md)。

## 用户与页面

匿名访客查看已公开节点；管理员管理节点、探测、通知、凭据和数据。

| Surface ID | 生产入口 | 操作 | 证据 |
| --- | --- | --- | --- |
| public | `/` | 概览与按状态筛选、按名称/地区/系统搜索、卡片/列表切换、站点默认视图、节点搜索面板（`/`、⌘K 或 Ctrl+K）、中英文与明暗切换、地球与昼夜图、进入详情/登录；状态页未公开时显示登录提示 | `web/src/App.tsx`、`Fleet.tsx`、`Globe.tsx`、`DayMap.tsx`、`Palette.tsx`、`Shell.tsx` |
| node-detail | `/node/{id}`、`/admin/node/{id}` | 资源（CPU、RAM/ZRAM/Swap、磁盘、进程、TCP/UDP）、监测（逐任务延迟、范围与丢包，可削峰）与流量（上传/下载）三个页签，各自时间窗；图表/表格、同步十字线与拖选缩放；实时指标与系统信息；登录后显示地址与备注；返回/深链 | `web/src/components/NodeDetail.tsx` |
| login | `/admin/` 未登录态 | 账号密码（唯一登录方式）、错误提示 | `admin/src/components/Login.tsx`、`auth.rs` |
| nodes | `/admin/nodes` | 名称/IP/标识搜索、状态筛选、管理列表、双栈 IP 复制、Agent 版本、优先级、新建/编辑/删除、带宽/协议可用性、安装、轮换、流量修正、账单 | `sections/nodes.tsx`、`sections/node-forms.tsx` |
| registration | 节点页弹窗 | 开启/关闭注册窗口、复制短期命令、有效期 | `useRegisterWindow`、`RegisterDialog` |
| probes | `/admin/ping` | 新增/编辑/删除 host:port、间隔、节点指派 | `sections/probes.tsx`；`api::save_ping_task` |
| notifications | `/admin/notify` | Telegram/Webhook、模板预览、按渠道测试、未保存禁用测试、阈值、节点离线开关 | `sections/notify.tsx`；`notify.rs` |
| data | `/admin/data` | 数据统计、下载备份、上传恢复、取消、维护确认与周期配置 | `sections/data.tsx`；`api::db_*` |
| security | `/admin/security` | 修改账号/密码（需当前密码；改名也须同时设置至少 12 位的新密码）、会话撤销；会话列表读取失败在卡片内提示并可重试 | `sections/security.tsx`；`auth.rs` |
| settings | `/admin/settings` | 站点名、分钟保留期、公开页及默认视图、连续在线阈值、本地 GeoLite Country 更新 | `sections/settings.tsx`；`api::save_settings`、`geo.rs` |

## 领域对象与权限

详情的资源与流量页对访客提供 1 小时、6 小时、24 小时和 7 天窗口，登录后增加 30 天、90 天和 1 年；监测页对所有用户最多提供 24 小时。实际返回的桶宽由 Hub 决定，浏览器按页面像素提供点数预算。

节点包含身份、排序、公开性、静态硬件事实、在线态、最新指标、累计流量、账单与到期信息。
节点的 `public` 字段由编辑弹窗的「公开状态页」显示/不显示选择控制，管理列表同时保留「私有」标记。
探测对象包含名称、目标、间隔和节点集合；公开历史只给名称和结果，不公开探测目标/指派管理接口。
通知设置的凭据只返回已配置标记；未输入表示保持，清除是明确动作。

## 状态矩阵

| 流程 | Loading / Ready / Empty | Error / Retry | Disabled / Permission / Offline | Progress / Cancel |
| --- | --- | --- | --- | --- |
| 节点/公开页 | 首次加载、节点列表、无节点、无匹配结果 | 请求错误与重试；轮询回退 | 在线/重连中/离线/未连接；实时连接断开时显示提示条，卡片视图同时淡化；匿名不可见节点不可直链读取；状态页未公开时显示登录提示 | WS 关闭后重连 |
| 节点详情 | 骨架、历史图、无历史 | 首次失败重试；刷新失败保留旧图 | 节点不存在或未公开 | 切页停止轮询 |
| 登录/会话 | 登录中、已登录 | 密码/网络错误 | 会话撤销退出 | 提交按钮忙态 |
| 节点创建/安装 | 创建、一次性令牌、安装命令 | 保存/复制错误 | 非 HTTPS 域名或分发缺失时禁止 provisioning | 弹窗取消；令牌轮换确认 |
| 探测 | 加载、任务、无任务 | 失败不可伪装成空表；重试 | 管理员权限；节点可选 | 保存忙态、删除确认 |
| 通知/设置/安全 | 加载与已配置值 | 加载重试、保存/测试错误 | 秘密脱敏；有未保存修改时禁用测试；修改账号/密码须填写当前密码，错误就地提示 | 保存/发送中 |
| 数据 | 统计、无明细 | 备份/恢复/维护失败 | 管理员权限；归档和分片有大小限制 | 分片进度、AbortController 取消、恢复确认 |

## 接口映射

| 操作 | HTTP / WS | 失败语义 |
| --- | --- | --- |
| 页面身份 / 实时列表 | GET `/api/me`、GET `/api/nodes`、WS `/api/ws` | 401 改变访问状态；网络错误不等于空数据 |
| 节点历史 | GET `/api/nodes/{id}/metrics?hours=&points=&series=` | 权限、窗口上限、并发拒绝 |
| 登录/注销 | POST `/api/auth/login`（username/password）、POST `/api/auth/logout` | 会话 Cookie；返回 `{"ok":true}` |
| 节点变更 | POST `/api/nodes`、PUT/DELETE `/api/nodes/{id}`、PUT `/api/nodes/order` | 部分字段更新、删除级联/退休连接 |
| 令牌/流量 | POST `/api/nodes/{id}/token`、PUT `/api/nodes/{id}/traffic` | 单次展示；空输入不得清零累计量 |
| 注册窗口 | POST/DELETE `/api/register-window` | 短期 key，关闭后交换失败；关闭返回 204，不解析 JSON |
| 探测 | GET/POST `/api/ping-tasks`、DELETE `/api/ping-tasks/{id}` | 目标/间隔/节点验证 |
| 通知/设置 | GET/PUT `/api/settings`、POST `/api/notify/test`（`channel` 为 `telegram` 或 `webhook`，不带时测试全部已配置渠道） | 整份 patch 先验证；敏感值不回显 |
| 会话 | GET `/api/sessions`、DELETE `/api/sessions/{id}` | 当前会话撤销后的页面恢复；撤销返回 204 |
| 数据 | GET `/api/db`、GET `/api/db/backup`、POST `/api/db/restore`、POST `/api/db/maintenance` | 有界上传、并发门限、恢复回滚 |
| GeoLite | GET/POST/DELETE `/api/geolite` | 管理权限、单任务、进度、取消（返回 204）、失败保留旧库 |

## 交互、可访问性与限制

当前使用 React、原生表单控件、Radix 弹窗/下拉/提示、SVG 历史图，以及 canvas 地球与昼夜图；有可见焦点、明暗主题、减少动画样式。
节点详情的历史页签按 ARIA tabs 实现：整组只占一个 Tab 停留点，方向键与 Home/End 切换并环绕、焦点跟随，页签与面板通过 `aria-controls`/`aria-labelledby` 互指。
公开卡片的链接只含节点名，点击卡片任意处都进入详情；状态、资源与账单数字作为卡片自身文字朗读，不被 `aria-label` 覆盖。
状态块是可按下的按钮，卡片/列表是单选组；搜索面板用方向键选择、Enter 打开、Esc 关闭。
公开页的列表/卡片选择在详情往返时保留；节点顺序规则见[领域规则](../domain.md)。
浏览器回归的范围与未覆盖项见[验收状态](../readiness.md)。

文案依据现有中文领域术语与实际接口；英文文本见 `shared/locale-en.ts`。状态页与当前节点详情的文案使用中英文词条；管理面板自身文案仍以中文为主，共享状态名和时长随所选语言切换，英文环境下可能混排。
