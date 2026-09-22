# romi 视觉方向与功能对照

> 已被用户否定，仅作为历史稿。当前方向及功能边界以 [Omarchy v2 规范](../2026-09-17-omarchy-v2/BRIEF.md) 为准；不得据此继续加入分组或主动网络探测。

研究日期：2026-09-17。基于当前 romi 源码、正在运行的本地界面、VPS.Gift 实际页面、Komari 官方 README 截图及官方文档/源码。
本目录仅包含设计提案和生成图，没有修改应用 UI，也没有停止本地服务。

## 图像与选择

每组两张：横向图覆盖 12 个产品区域；竖向图放大公开概览、节点管理及一次性凭证控件。

| 方向 | 整体图 | 放大图 | 适合的偏好 |
| --- | --- | --- | --- |
| A 钴蓝信号 | [全产品](a-cobalt-atlas.png) | [页面细节](a-cobalt-detail.png) | 最直接的监控工作台、清楚的蓝白对比 |
| B 赤陶账本 | [全产品](b-clay-atlas.png) | [页面细节](b-clay-detail.png) | 个性更强、重视清单密度与成本信息 |
| C 墨绿网格 | [全产品](c-forest-atlas.png) | [页面细节](c-forest-detail-v2.png) | 长期使用的克制感、深绿与薄荷白 |
| D 夜航茄紫 | [全产品](d-night-atlas.png) | [页面细节](d-night-detail.png) | 暗色优先、偏工程操作台 |

12 个区域：公开概览、节点详情、节点管理、TCP 延迟、通知、数据维护、主题、安全、站点设置、登录、凭证/续费、移动端。
Agent 没有独立图形界面，体现在节点接入、在线状态和指标展示；没有虚构 Agent 桌面应用。

图像由内置 ImageGen 生成，非网页截图。原生横图约 1672×941，竖图约 1086×1448，并非 4K 导出。
完整原始提示词在 [prompts.json](prompts.json)，细节图提示词在对应 `*-detail-prompt.txt`。
图中数值、日期、节点和控制文案为示意，部分小字、曲线/汇总计算和字段名称不能当作实现规格。
个别生成图保留轻微渐变或插画倾向；落地统一采用纯色与准确文案。主题包实际是 tar.gz，不能按生成图中的 ZIP/JSON 字样实现。
C 图的修正版将虚构命令改成真实二进制名称，但示意字段仍不是完整可执行安装命令。
部分图把管理导航与“公开概览”放在一起：这是登录后的运营视角；匿名公开页应仅显示公开导航，权限由后端继续控制。
生成图里出现的筛选、批量选择、分页或全局历史汇总是交互提案，不表示当前代码已经具备这些功能。

## 当前视觉判断

romi 的基础布局整齐，但品牌、状态语义与阅读密度尚未形成一套统一规范。

- `web/src/index.css` 的 primary、destructive、ok、warn 与 chart 系列都是灰阶；`admin/src/index.css` 使用彩色状态与另一套色值。
  这会让两个应用看起来不属于同一套系统，也削弱异常识别。
- 公开页现有节点卡对长名称截断明显。表格密度和卡片密度应可选，标题优先完整显示两行。
- 节点详情中 CPU、内存、网络与磁盘的大图纵向堆叠，桌面首屏很难同时比较四项指标。
  建议宽屏 2×2、窄屏单列，图例与单位固定，缺失数据用“—”。
- 管理台以配置页面为主，缺少“今天需要处理什么”的入口与一致的批量操作、筛选和状态反馈。
  新增能力前，先让已有流量阈值、到期信息和在线状态更容易被发现。
- 一次性令牌、恢复数据库、删除节点等关键交互需统一危险操作、说明、确认和完成状态。
- 不靠颜色单独传达状态；同一状态始终配合文字与图标。图表用不同线型配合颜色。

建议设计基线：两种阅读密度；共享语义色值；一致的 4/8px 间距；桌面正文 14–16px；表格约 14px；
关键数值使用等宽数字；触摸主要控件约 44px；状态变化不让整张卡持续闪动。

## 参考的使用边界

[VPS.Gift](https://vps.gift/) 的页面署名是 nezha-dash。值得借鉴的是总览、资源、价格/剩余天数和标签的直接呈现，
以及搜索/视图切换。公开页面无法证明其后台启用了哪些功能，因此功能对比另据哪吒官方资料。

[Komari 官方 README](https://github.com/komari-monitor/komari) 提供了首页、后台、历史、终端和主题市场截图。
本次看到的首页示例有高密度节点卡、搜索和视图选择，同时包含较强背景图；可以借鉴信息组织，不必采用背景图和透明材质。
社区主题风格不能代表整个 Komari 产品只有一种固定视觉。

[mono-color-skill](https://github.com/yanliudesign/mono-color-skill) 仅作为研究材料，未安装或执行其技能/脚本。
它强调中性底材、少量有明确职责的颜色、强弱排版和主动留白；“单色”并不意味着黑白灰。
本提案将这些原则转为应用设计：中性色承载数据、品牌色建立导航和重点、强调色用于明确动作。
监控所需的正常/警告/错误语义色作为例外保留，图表不使用纸张颗粒、印刷网点或错位效果。

## romi 已有功能

| 范围 | 已有内容 | 主要实现 |
| --- | --- | --- |
| 采集与实时状态 | CPU、负载、内存/swap、磁盘、网速/累计流量、TCP/UDP 连接数、进程数、运行时长及基础系统信息 | `agent/src/collect.rs`、`server/src/agent_ws.rs` |
| 公开页与详情 | 卡片总览、明暗模式、单节点资源历史、时间范围、TCP 延迟曲线和探测失败比例 | `web/src/App.tsx`、`web/src/components/NodeDetail.tsx` |
| 节点资产 | 名称/IP 搜索、排序、公开/私有、备注、费用/币种/周期/到期、额度与月重置、流量修正 | `admin/src/components/Admin.tsx`、`server/src/db.rs` |
| 接入与认证 | 节点创建、短期批量注册窗口、一次性令牌、换发和旧连接退役、令牌摘要存储 | `server/src/api.rs`、`server/src/agent_ws.rs` |
| 网络探测 | TCP 目标与端口、探测间隔、节点分配、历史曲线；图中的“丢”来自探测失败，不等于 ICMP 包丢失测量 | `agent/src/main.rs`、`server/src/api.rs` |
| 通知 | Telegram、可定制 Webhook、测试发送、离线/恢复、流量阈值、到期及登录提醒 | `server/src/notify.rs` |
| 数据维护 | SQLite、保留期、备份下载、上传恢复、清理/VACUUM、schema 迁移 | `server/src/db.rs`、`server/src/api.rs` |
| 管理安全 | 应急密码、GitHub OAuth、登录会话查看/吊销、默认私有与回环监听 | `server/src/auth.rs`、`server/src/main.rs` |
| 主题与设置 | 内嵌主题、明暗模式、站点设置；外部主题需服务端显式允许；国家查询默认关闭 | `server/src/frontend.rs`、`server/src/agent_ws.rs` |
| 工程交付 | monorepo、pnpm/mise、已实际通过的 GitHub CI、本地快照与摘要校验 | 根 Makefile、`.github/workflows/ci.yml` |

费用/续费是资产记录，不是支付平台；注册窗口不是自动更新；备份恢复不是高可用或集群。

## 对比与缺口

| 能力 | romi 当前 | 参考证据与判断 |
| --- | --- | --- |
| 主机指标/历史 | 已有核心流程 | 哪吒、Komari 也有；现在的主要差距是整理、可见性与操作效率 |
| 分组/标签/批量管理 | 后台有搜索和拖动排序，缺少完整分组/标签、批量操作和公开页筛选 | [哪吒分组](https://nezha.wiki/guide/group.html) 已有服务器和通知分组；建议优先补齐日常管理能力 |
| 服务监控 | TCP 探测 | [哪吒服务监控](https://nezha.wiki/guide/services.html) 有 HTTP/ICMP/TCP 及 HTTPS 证书监控；[Komari 任务模型](https://github.com/komari-monitor/komari/blob/main/database/models/pingTask.go) 包含 ICMP/TCP/HTTP。Komari 证书到期能力本次未确认 |
| 通用资源告警 | 现有固定类型提醒，尚无 CPU/内存等通用条件规则 | [哪吒通知规则](https://nezha.wiki/guide/notifications.html) 支持多类指标阈值与窗口；[Komari 通知模型](https://github.com/komari-monitor/komari/blob/main/database/models/notification.go) 含指标、阈值、窗口占比及流量报告 |
| 告警事件与维护 | 缺少完整事件历史、通知投递结果和维护/静默计划 | 这是 romi 自身可操作性的改进建议，不声称两个参照产品都具备相同实现 |
| 身份与协作 | 管理员级权限、GitHub OAuth、会话管理；没有 TOTP/RBAC | [Komari 2FA](https://github.com/komari-monitor/komari/blob/main/web/api/admin/2fa.go) 已有实现；[哪吒多用户](https://nezha.wiki/guide/user.html) 已有相应管理。个人使用阶段不必先做复杂团队体系 |
| 安装与更新 | 本地构建/包校验可用，在线安装入口关闭，发行签名和正式服务安装未完成 | [Komari 安装](https://www.komari.wiki/install/quick-start) 提供脚本和 Docker；应优先让 romi 有可校验的发布与接入流程 |
| 远程运维 | 不提供远程终端/任意命令/任务执行 | [哪吒 README](https://github.com/nezhahq/nezha)、[Komari README](https://github.com/komari-monitor/komari) 展示相关能力；这会扩大 Agent 权限，不建议为追平竞品而默认加入 |
| 主题市场/插件生态 | 有受控主题入口，没有成熟市场 | Komari 展示主题市场与扩展；先完成一个一致好用的自带主题即可 |

## 建议顺序

1. 先选一组完整视觉：统一品牌、状态语义、节点卡/表格、图表和移动端，同时完善接入与空状态。
2. 再做分组/标签、公开页搜索/排序、批量设置，以及实际需要的 HTTP/证书监控。
3. 补通用阈值告警、事件历史和静默管理；逐步完善身份保护和正式发行。
4. 终端、远程执行、DDNS、隧道、复杂插件市场等按实际需求另行决定。

我优先推荐 A 作为主方向；若希望差异化与长期阅读更强，选 C。喜欢高密度资产清单选 B，习惯暗色工程后台选 D。
最终应选同一个体系覆盖前台和后台，再由它派生明暗主题，而非把四种品牌语言拼在一起。
