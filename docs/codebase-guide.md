# 代码导览

本文介绍 Hub、Agent、前端和数据库之间的数据流，并列出主要源码入口。安装与日常操作见[快速开始](quick-start.md)和[使用指南](guide.md)；并发上限、存储实现与字段含义分别见[架构](architecture.md)、[存储](storage.md)和[领域规则](domain.md)。

## 1. 系统边界与运行形态

romi 采用一个 Rust Hub 管理多个 Linux Agent。Hub 内嵌管理后台、公开状态页和 DuckDB；Agent 读取本机事实与指标，并执行 Hub 指派的 TCP 连接探测。非目标见[需求](requirements.md)。默认监听 `127.0.0.1:28080`，对外访问由 HTTPS 反向代理接入。

Agent 通过 WebSocket 上报；Hub 将实时状态保存在内存，持久数据交给 DuckDB 写入线程。浏览器订阅实时快照，历史与配置通过 HTTP 查询。通知模块读取节点状态并发送到 Telegram 或 Webhook。

| 代码位置 | 主要责任 |
| --- | --- |
| `agent/src/collect.rs`、`agent/src/main.rs` | Linux 采集、WebSocket 上报、重连与 TCP 探测 |
| `server/src/main.rs`、`agent_ws.rs` | 启动、路由、Agent 身份、报告顺序与实时状态 |
| `server/src/api.rs`、`auth.rs` | HTTP 权限、节点与设置、登录和会话 |
| `server/src/frontend.rs` | 内嵌页面、静态资源缓存与安全响应头 |
| `server/src/db/` | DuckDB schema、单 writer、历史查询、备份恢复与维护 |
| `server/src/notify.rs`、`geo.rs`、`distribution.rs` | 通知、本地国家库、已验证 Agent 分发 |
| `admin/`、`web/`、`shared/`、`styles/` | 后台、公开页、共享客户端契约、文案翻译与样式 |

Hub 的 `App` 持有数据库、连接中的 Agent、按公开/管理受众分开的快照、查询准入、通知队列与 GeoLite 状态。`agents` 和浏览器快照是进程内状态；节点配置、历史、累计流量与设置在 DuckDB 中。Hub 重启后 Agent 重连并重新提供实时数据，已提交的累计量不依赖内存快照。

## 2. 前端与浏览器数据流

| 入口 | 职责 | 源码 |
| --- | --- | --- |
| `/`、`/node/{id}` | 公开状态与节点历史；登录后可查看私有节点 | `web/src/App.tsx`、`web/src/components/` |
| `/admin/`、`/admin/node/{id}` | 账号登录、节点管理与同一套详情组件 | `admin/src/App.tsx`、`Navigation.tsx` |
| `/admin/nodes`、`ping`、`notify`、`data`、`security`、`settings` | 节点、探测、通知、数据、账号与站点设置 | `admin/src/components/sections/` |

页面操作见[日常使用](guide.md)，接口与错误状态见[界面能力](ui/capabilities.md)，布局和组件映射见[界面实现](ui/implementation.md)。

### 浏览器数据与失败处理

页面加载时并行请求 `/api/me`（身份与站点配置）和 `/api/nodes`（初始节点列表），并连接 `/api/ws`。Hub 定时推送一份按受众生成的节点快照；WebSocket 失败时页面每 5 秒轮询，并尝试重新连接。会话被撤销或公开页被关闭后，服务端停止原连接，客户端重新读取身份或转登录页。详情历史按当前标签调用 `/api/nodes/{id}/metrics?hours=&points=&series=`；切换窗口会取消旧请求，避免旧数据覆盖新窗口。图表缩放保存开始与结束时间，刷新时保持这段时间；未缩放时窗口随当前时间移动。共享 `shared/http.ts` 保留 HTTP 状态码，且对 `204 No Content` 不尝试解析 JSON。

匿名与管理视图包含的字段见[安全边界](security-baseline.md)。权限由 Hub 的会话与节点可见性检查决定，隐藏界面按钮不能代替它。

## 3. 业务流程与数据流

### 3.1 首次启动、认证与节点接入

1. Hub 打开/初始化数据库并在首次启动生成本地管理员密码；开发运行时打印一次，服务安装写入权限 `0600` 的文件（见[部署](deployment.md#首次管理员凭证)）。管理员密码以 Argon2 摘要保存于 `setting`。
2. 登录同时核对账号与密码，这是唯一的登录方式；会话与限流规则见[安全边界](security-baseline.md)。
3. 添加节点时 Hub 原子创建 `node` 与 `traffic` 行，按分配器取得 ID，返回只显示一次的长期令牌；安装命令不把长期令牌放进 shell 命令行，安装器在节点本机读取它。注册窗口是另一入口，短期 key 换取各自长期令牌。
4. Hub 仅在启动时载入通过版本、大小、SHA-256、ELF 架构及路径检查的本地 Agent 分发，分发路由见[部署](deployment.md#分发状态与配置)。安装器下载元数据和二进制后再次核对哈希，可安装 systemd 或 OpenRC 服务。
5. Agent 使用 `Authorization: Bearer` 建立 `/api/agent/ws`。Hub 再查摘要并激活唯一节点会话；连接时即视为在线。轮换令牌、删除节点或恢复数据库会退休旧会话，等待在途报告完成，避免旧连接继续写入。

### 3.2 采集、累计与历史

Agent 的 `hello` 上报主机名、OS/内核/架构、CPU、容量、版本及本机双栈地址。Hub 将这些较慢变化的事实写到 `node`。报告包含 CPU/负载、RAM、ZRAM、普通 Swap、磁盘、网络速率与绝对计数、连接数、进程数和系统 uptime。Agent 从 Linux `/proc`、`/sys` 与挂载信息读取，不保存计费累计量；`--iface` 可选指定或排除网卡。

Hub 验证上报字段后，按单节点会话锁串行处理：在 `traffic` 中比较同一计数 epoch 的绝对 `rx/tx`，把非负增量计入终身、本期和当天计数；首次上报、重启、接口集合变化或计数回退只重建基线。没有有效计数时不会写一个伪零基线。账期与用量模式见[领域规则](domain.md)。

每份有效报告刷新实时内存快照、`node.last_seen` 与连续在线起点。跨过分钟边界时，Hub 从该会话累积的报告生成分钟行：CPU/内存等用采样均值，网络速率由 Hub 的累计量变化计算；每节点每分钟最多一行，实时页仍显示最新一份报告。查询历史时合并 `metric` 与 `metric_hour`，按返回的桶宽做加权平均；没有样本的时间段保留空白。保留期与汇总见[存储](storage.md)，历史准入与窗口见[架构](architecture.md)。

### 3.3 TCP 监测与通知

管理员保存探测目标、间隔与节点指派。面板在提交前就地校验间隔，Hub 同样拒绝越界值。Hub 校验 `host:port`（IPv6 使用 `[地址]:port`）和每节点任务上限，在一个事务内替换任务指派，并立刻向在线 Agent 推送。Agent 保留未变化任务的计时器，先解析 DNS 再尝试最多 3 个地址；TCP 握手延迟按毫秒记录。连接失败写 `-1` 作为丢包，DNS 解析超时则没有样本。Hub 只接受该节点仍被指派任务的结果，写入 `ping_record`；历史桶以整数延迟分布计算中位数、范围和丢包率，不能将失败当作 0 ms。

通知扫描读取连接状态及本期流量，告警规则见[领域规则](domain.md#tcp-探测与告警)。队列满或尝试耗尽会记录警告并放弃，因此界面“已排队”不能等同外部送达；后台的“发送测试”直接尝试目标渠道并报告其错误。

### 3.4 国家库、备份与维护

GeoLite Country 下载由管理员指定 HTTPS 直链，成功后原子替换数据库同目录的 `GeoLite2-Country.mmdb`，按连接来源 IP 更新国家代码；限制见[部署](deployment.md#国家-地区数据库)。进度可查询，下载可取消，失败保留旧库。

恢复上传以 4 MiB 分片顺序发送；取消或离开数据页会在分片边界停止，最后一个分片发出后不可取消，因此“已取消”只在 Hub 未收到最后分片时出现。恢复成功清除旧会话、给当前操作人新会话，并让 Agent 重新鉴权连接。备份内容、恢复顺序与维护步骤见[存储](storage.md)，周期维护见[领域规则](domain.md)。

## 4. HTTP / WebSocket 契约索引

| 受众 | 接口 | 作用与权限要点 |
| --- | --- | --- |
| 浏览器访客 / 管理员 | `GET /api/me`、`GET /api/nodes`、`WS /api/ws` | 身份、可见节点和实时快照；公开页关闭时匿名列表/流拒绝，管理会话失效时流断开 |
| 浏览器访客 / 管理员 | `GET /api/nodes/{id}/metrics` | 逐节点历史；匿名只能读公开节点，窗口与并发受限 |
| 登录 | `POST /api/auth/login`、`POST /api/auth/logout` | 账号密码登录与注销 |
| 管理员 | `POST /api/nodes`、`PUT/DELETE /api/nodes/{id}`、`PUT /api/nodes/order`、`POST /api/nodes/{id}/token`、`PUT /api/nodes/{id}/traffic` | 节点、排序、令牌与流量校正；添加与换发令牌另需 HTTPS 域名入口 |
| 管理员 | `POST/DELETE /api/register-window`、`GET/POST /api/ping-tasks`、`DELETE /api/ping-tasks/{id}` | 注册窗口及探测任务 |
| 管理员 | `GET/PUT /api/settings`、`GET /api/sessions`、`DELETE /api/sessions/{id}`、`POST /api/notify/test`、`GET/POST/DELETE /api/geolite` | 设置、会话、渠道测试和国家库 |
| 管理员 | `GET /api/db`、`GET /api/db/backup`、`POST /api/db/restore`、`POST /api/db/maintenance` | 数据统计、备份、恢复与维护 |
| Agent / 安装器 | `WS /api/agent/ws`、`POST /api/agent/register`、`GET /api/agent/distribution`、`GET /install.sh`、`GET /agent/v{version}/{target}` | 节点令牌、短期注册 key 和已验证本地分发；无版本的 `GET /agent/{arch}` 只提示改用版本化地址；另有 `GET /healthz` 健康检查 |

实时连接中，单个来源地址超限返回 429，匿名或管理总席位用尽返回 503；浏览器关闭时立即归还席位。其余上限见[架构](architecture.md)，路由细节和失败状态以 `server/src/main.rs`、`api.rs` 为准。

## 5. DuckDB 数据库设计

### 5.1 表与关系

生产持久化是单个 `--db` 指定的 DuckDB 文件；schema、引擎与备份格式见[存储](storage.md)。下表覆盖十张应用表和两张内部元数据表。

| 表 | 主键 / 关键字段 | 作用与关系 |
| --- | --- | --- |
| `setting` | `key`、`value` | 站点、账号密码摘要、通知、保留与注册窗口等键值设置；部分值属于凭据，应保护数据库文件 |
| `romi_id` | `name`、`next` | 为 `node`、`ping_task` 分配 ID；每次打开和恢复数据库时按现存最大 ID 重同步 |
| `romi_schema` | 固定 `id=1`、`version`、`engine`、`written_by` | 应用 schema 元数据和写入版本 |
| `node` | `id`、唯一 `token_hash`；配置、账单、硬件事实、地址、`last_seen`、`online_since` | 节点主表；长期令牌只存 SHA-256 摘要，地址和备注只供管理态 |
| `traffic` | `node_id`；`boot_id`、上次绝对计数、终身/本期/当天双向累计、周期起点 | 与节点一对一；独立于历史保留期 |
| `metric` | `(node_id, ts)`；CPU、RAM/Swap/ZRAM、磁盘、网络速率、连接/进程 | 每节点每分钟最多一行；只有四个 Swap 来源字段可为 `NULL`，表示旧 Agent 或读取失败 |
| `metric_hour` | `(node_id, ts)`；`samples`、各指标加权和与有效样本数 | 过期分钟数据的小时摘要；大整数和用 `DECIMAL(38,0)` 保证 Parquet 往返精度 |
| `ping_task` | `id`；名称、目标、间隔 | TCP 探测定义 |
| `ping_node` | `(task_id, node_id)` | 任务与执行节点的多对多指派 |
| `ping_record` | `(node_id, ts, task_id)`；`latency` | 探测样本，`-1` 为连接失败 |
| `ping_hour` | `(node_id, ts, task_id, latency)`；`samples` | 每小时按整数延迟计数的分布，可重建中位数、范围和丢包 |
| `session` | `token_hash`、`expires_at` | 登录安全状态，运行库内存在，但不进入备份 |

DuckDB 没有在这些表上声明外键级联。`Db::create_node` 同事务写 `node` 与 `traffic`；`Db::save_ping_task` 核对节点及指派、一次替换全部关联；删除节点/探测任务时在同一事务显式清除其历史与关联。恢复在切换前校验孤儿关系。`metric` 与 `ping_record` 的复合主键负责去重；配置的“未传字段”与“显式清空”由补丁语义区分，例如 `expires_at: null` 才清除到期日。
ID 分配规则见[存储](storage.md#标识与关系完整性)，`a_deleted_id_stays_retired_across_a_restart` 与 `a_restore_does_not_reissue_ids_created_after_the_backup` 覆盖它。

### 5.2 读写与文件生命周期

所有变更经单 writer 队列，同类遥测合入一个事务，提交成功才答复调用者；短元数据读使用独立连接，历史/备份使用分析 reader。实时节点列表来自 Agent 的最近发布副本和已提交配置，避免慢查询堵住页面。写入队列、替换栅栏、文件锁、启动检查与关闭顺序见[存储](storage.md)。

## 6. 代码核对入口与审查重点

| 需要核对的事实 | 源码及现有回归入口 |
| --- | --- |
| 页面路径、状态与交互 | `web/src/App.tsx`、`web/src/components/`、`admin/src/App.tsx` 与 `Navigation.tsx`（后台外壳与导航）、`admin/src/components/Admin.tsx`（分区路由）、`admin/src/components/sections/`（各页面）；`e2e/public.spec.mjs`、`admin.spec.mjs`、`navigation.spec.mjs`、`hardening.spec.mjs`、`visual-contract.spec.mjs`、`approved-v12.spec.mjs` 至 `approved-v15.spec.mjs` |
| Agent 报告与探测 | `agent/src/collect.rs`、`agent/src/main.rs`、`server/src/agent_ws.rs`；各文件内 Rust 单元测试 |
| API 权限、节点、认证 | `server/src/main.rs`、`server/src/api.rs`、`server/src/auth.rs`、`server/src/frontend.rs`；对应模块测试 |
| 累计、查询、schema、备份 | `server/src/db/mod.rs`、`schema.rs`、`queries.rs`、`backup.rs`；`server/src/db/tests.rs`、`server/tests/duckdb_engine.rs` |
| 通知、国家库、分发 | `server/src/notify.rs`、`geo.rs`、`distribution.rs`；对应模块测试与 `deploy/agent/install.sh` |

审查时特别区分三个边界：**在线连接状态**与**告警离线判定**使用不同宽限；**实时速率**与**账期累计**来自不同计算；**API 支持的字段**不必然有后台操作入口。
