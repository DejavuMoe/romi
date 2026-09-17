# 本地安全与发行基线

> 本文保留第一轮本地安全验证记录。v0.4A 已将版本源、公开二进制名和公开发行边界统一为
> `VERSION`、`romi-hub`、`romi-agent`，公开发行说明见 [发行与验证](release.md)；本节以下
> 内容除非另有说明，仍描述当前实现。

第一轮安全验证在本地完成，未上传代码、发布镜像或签名。
后续已配置 `git@github.com:DejavuMoe/romi.git`、默认分支 `master` 和 GitHub Actions 测试工作流；
远程 CI 随后在 master 推送中实际运行。本轮新增改动未推送，因此没有对应的远端 CI 结果。
保持原始 Agent 协议，没有升级应用依赖或重做 UI。前端锁文件现已迁移至 pnpm workspace，
保留已锁定的应用依赖版本和 integrity；mise 配置使本地与 CI 使用相同开发工具版本。

## 节点凭证

- 高熵节点令牌通过 `auth::sha256` 在数据库创建、换发和认证入口统一转换。
  `node.token_hash` 只存摘要，摘要本身不能作为原令牌登录。
- 创建返回 `{id, token}`，换发返回 `{token}`，注册接口仍返回新令牌文本；这些响应均为 `no-store`。
  `Node` 类型和管理/公开 REST、WebSocket 快照均不包含令牌或摘要。
- 后台将新令牌保存在当次窗口的内存状态中，关闭即丢弃；重新打开需要显式换发。
  本地命令对 URL 和凭证作 POSIX shell 引号处理，不再执行上游安装脚本。
- WebSocket 激活时重新认证；每条 hello/report/ping 消息先查全局会话表，再只锁该会话自己的
  报告状态。换发、删除、连接替换与恢复会先退休旧会话、等待正在进行的报告结束，并在旧会话
  状态锁内执行凭据/数据变更；因此退休连接中的排队消息不能修改后继节点状态，也不能越过恢复。
  已开始的合法写入会先完成，随后换发/恢复返回。
- 备份归档不包含 `session` 表，恢复后的数据库始终是一张空会话表；恢复不会复活已注销登录。
  注册窗口密钥、OAuth/通知等秘密仍使整个数据库及备份具有敏感性。
  本阶段没有将短期注册窗口密钥改为摘要，也没有完成密码学擦除或全盘取证验证。

## 默认隐私与主题

- 未设置 `public_page=on` 时，匿名节点 API、历史与实时 WebSocket 不可读。
  新节点（包括批量注册）默认私有；既有节点显式公开标记保留，但整个公开页须显式开启。
- `country_lookup` 默认关闭，只接受 on/off；在调度和实际发送处检查，关闭时不调用 ipinfo。
  开启后按原有连接/重试时机查询国家，会披露节点连接 IP；关闭不撤回已经发出的请求。
- 服务端默认监听回环。已有显式 `--listen` 参数不被改写。
- 默认忽略磁盘主题的页面、元数据和预览图，上传、更新、删除接口在产生副作用前返回 403。
  后台显示相同限制；通过 API 设置不能打开这项权限。
- `--allow-custom-themes` 是部署者显式授权，同源第三方主题会获得与管理后台相同的浏览器源权限。
  它不提供 origin 隔离；仅用于已经审查并信任的代码。

默认运行仍可能按显式配置访问 OAuth、通知 webhook/Telegram 和 Agent 的探测目标。
本轮没有声称全面断网、封禁内网探测或审计所有出站 URL。

## 本地快照与公开发行边界

`make package` 构建并记录当前源码、工具链、`romi-hub`/`romi-agent` 二进制以及生成后的前端资源，
再生成本地开发快照归档。`manifest.json` 的 `kind` 为 `local-snapshot`、`signed` 为 false，允
许未打标签的源码状态；校验器拒绝摘要不符、路径穿越、重复/非普通文件及超量负载，记录完成后替换
生成主题也会被拒绝。详见 [本地发行说明](local-release.md)。

公开发行由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 定义，与本
地快照分离：

- 版本源为根 `VERSION`，公开标签必须是 `v<VERSION>`，Hub 与 Agent 的 Cargo 包版本必须一致；
- 只支持 `x86_64-unknown-linux-gnu`，要求在 CI 中构建、解压、执行 `--version` 并跑现有 smoke；
- release manifest 绑定一个完整 commit、目标三元组、rustc 和 DuckDB engine；
- `SHA256SUMS` 与 manifest 相互校验，只证明完整性与一致性，不冒充签名；
- 正常 CI/构建任务保持 `contents: read`；只有标签发布任务获得 `contents: write`，并单独获得
  `id-token: write` / `attestations: write` 用于 GitHub 官方 attestation；
- 不引入长期私钥；attestation 验证必须绑定 `DejavuMoe/romi`。

v0.4B 已在此发行链上实现原生部署：Hub 安装器只消费已验证 release，安装
`/opt/romi/releases/<version>` 与 `/opt/romi/current`，并用同一 release 的 Agent 二进制建立
root 控制的本地分发。Hub 在配置合法 `--distribution-dir` 后，才提供 `/install.sh`、公开元数据
和精确版本的下载 URL；未配置时这些路由返回 503。Hub 从不访问 GitHub 获取 Agent，Agent 不
自更新、不执行远程命令。首次管理员凭证在原生安装下写入 0600 文件而非 journal；`/healthz` 是
免认证轻量健康接口。完整部署与信任边界见 [原生部署](deployment.md)。

## 当前存储安全基线

存储引擎为内嵌 DuckDB，详见 [存储架构](storage.md)。本节是当前生效的条目：

- `node.token_hash` 存 SHA-256 摘要；摘要是凭据验证入口，但摘要本身不能作为代理令牌使用。
  存储层断言在 Rust 测试 `db::tests::tokens_are_hashed_and_rotation_retires_the_old_one`：
  DuckDB 只允许一个进程读写同一文件，跨进程读取已不可能，也不再需要。
- 文件保护对象为 DuckDB 的实际文件名：数据库本体、`<db>.wal`、spill 目录 `<db>.tmp`、
  锁文件 `<db>.lock`，全部 0600/0700。
- 单写者约束：`<db>.lock` 用 `File::try_lock` 排他持有，第二个 Hub 进程会被拒绝并说明原因；
  `scripts/smoke.py` 用真实第二个进程验证这一点。
- 运行时禁用扩展自动安装与自动加载（`autoinstall_known_extensions`、
  `autoload_known_extensions`、`allow_community_extensions`、`allow_unsigned_extensions`
  均为 false）。Parquet 静态编入二进制，不需要下载任何扩展。
- 没有新增任何用户可控的 SQL 入口；`Db::exec`/`Db::scalar` 只在 `#[cfg(test)]` 下存在。
- 备份格式为「数据归档」（tar.gz + 每个持久表一个 Parquet + manifest 摘要），不包含 `session`；
  恢复先完整校验并在临时文件中重建、清空会话并校验关系，全部通过后才在替换栅栏内切换，
  失败回滚到原文件。上传大小上限、成员数量/展开总量、路径校验、`no-store` 与 0600 权限不变。
- 启动只读 12 字节文件头判断格式；不是有效 romi DuckDB 数据库的现有文件会被拒绝，且不会被修改。
- `memory_limit` 只约束 DuckDB 自身缓冲，**不是进程 RSS 上限**。
