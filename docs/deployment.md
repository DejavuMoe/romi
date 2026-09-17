# romi 原生部署（Linux x86_64 GNU + systemd）

本文描述 v0.4B 的受支持部署路径。支持范围只有：

- `x86_64-unknown-linux-gnu`
- systemd
- Hub 监听回环地址，外部 HTTPS 由反向代理终止
- Agent 运行在独立非 root 服务账号下

运行时基线以 Ubuntu 24.04（glibc 2.39）构建的发布二进制实测为准：

- `romi-hub` 最高需要 `GLIBC_2.38`；
- `romi-agent` 最高需要 `GLIBC_2.34`。

因此 Hub 主机必须提供 glibc 2.38+ 和 systemd；Agent 主机必须提供 glibc 2.34+ 和 systemd。
Ubuntu 24.04 及更新版本满足 Hub 基线；更老的发行版、musl、aarch64、Alpine、macOS、Windows、
Docker 和 Kubernetes 不在本阶段支持范围内。发布工作流会在发布前重新打印并校验这两个符号版本，
防止 runner 或工具链变化悄悄提高基线。

也不提供 `curl | sh` 从可变 `master` 源码开始的安装方式。

## 信任边界

有两种不同的信任层级，不要混淆。

### 1. 更安全的发行安装

1. 从 GitHub Release 下载不可变的 release 资产；
2. 用绑定 `DejavuMoe/romi` 的 GitHub attestation 验证来源；
3. 用 `SHA256SUMS` 验证完整性；
4. 解压 `romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz`；
5. 在解压目录运行 romi 自带的 Hub 安装器。

```sh
# 示例（下载后先按 docs/release.md 验证 attestation 与 SHA256SUMS）
tar -xzf romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz -C romi-hub
sudo sh romi-hub/deploy/hub/install.sh --site https://hub.example.com
```

安装器不会下载源码或二进制；它只消费已经验证过的 release 归档。

### 2. Hub 到节点的 Agent provisioning

Hub 安装成功并配置了内置 Agent 分发后：

1. 管理员在面板创建节点或开启短期注册窗口；
2. 节点从**受信任的 Hub HTTPS 域名**下载 `/install.sh`；
3. 安装器从同一个 Hub 获取精确版本的 Agent；
4. 本地校验大小、SHA-256 与 `romi-agent --version`；
5. 安装 systemd 服务，Agent 连接同一个 Hub。

这一步的真实性边界是 **Hub 的 HTTPS 证书和域名**。Hub 返回的 SHA-256 能证明传输和安装
物一致，但它和二进制来自同一个 Hub，不是独立的第三方签名。

## 文件系统布局

```text
/opt/romi/
    releases/
        <version>/
            romi-hub
            romi-agent
            VERSION
            release.json
    current -> releases/<version>/
/var/lib/romi/
    romi.duckdb
    themes/
    tmp/
    bootstrap-password          # 首次启动生成，0600；修改密码后自动删除
    distribution/
        <version>/
            romi-agent          # 0640 root:romi
            distribution.json   # 0640 root:romi
/etc/romi/
    hub.env                     # ROMI_SITE，0640 root:romi
```

关键不变量：

- 二进制和版本元数据在 `/opt/romi/releases/<version>/`，只读、root 控制；
- DuckDB、主题、临时目录和分发缓存位于 `/var/lib/romi/`，**绝不在 `/opt` 或版本目录内**；
- 升级只切换 `current` 符号链接，不移动、不覆盖数据库；
- 旧版本目录保留，便于人工检查和显式回退；
- 分发目录由 root 控制，Hub 进程只读；
- Agent 服务账号只获得运行所需的最小权限。

## 服务账号与 systemd

Hub 使用专用系统账号 `romi`，无交互 shell。Agent 使用专用系统账号 `romi-agent`，
同样无交互 shell。两者都不获得 Linux capabilities。

unit 文件来自 release 归档中的 romi 自带模板：

- `deploy/hub/romi-hub.service.in`
- `deploy/agent/romi-agent.service.in`

安装器会按实际路径生成并安装 unit，然后执行 `systemd-analyze verify`（如果可用）。

Hub unit 保持监听 `127.0.0.1:28080`，并要求：

- `EnvironmentFile=-/etc/romi/hub.env`（提供 `ROMI_SITE`）；
- `--bootstrap-password-file /var/lib/romi/bootstrap-password`；
- `--distribution-dir /var/lib/romi/distribution/<version>`；
- `ReadWritePaths=/var/lib/romi`；
- `ProtectSystem=strict`、`ProtectHome=yes`、`PrivateTmp=yes`、`NoNewPrivileges=yes`；
- 空的 `CapabilityBoundingSet=` / `AmbientCapabilities=`；
- `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK`：`AF_NETLINK` 是
  `getifaddrs`/地址发现和部分名称解析路径所需的地址族，而不是任意网络访问放宽。

Agent unit 使用 `EnvironmentFile=/etc/romi/agent.env`，`ExecStart` 中**不包含**服务器地址
或令牌；systemd 以 root 读取 0600 的 env 文件，再把 `ROMI_SERVER`、`ROMI_TOKEN`、
`ROMI_INTERVAL` 注入非 root 的 Agent 进程。Agent unit 特别保留了 `/proc` 的完整可见性，
不设置 `ProtectProc=` / `ProcSubset=`，并使用 `ProtectHome=read-only` 而不是 `yes`，
以免隐藏单独挂载的 `/home` 文件系统导致磁盘总量错误。

## 首次管理员凭证

原生安装的 Hub 在数据库全新且配置了 `--bootstrap-password-file` 时：

- 生成高熵管理员密码；
- 用 `O_EXCL` 和 0600 权限原子写入配置路径；
- 绝不把密码写到 stdout 或 journal；
- 日志只说明凭证写到了哪里；
- 已存在的凭证文件不会被覆盖；
- 管理员在面板修改密码后，安装器自动删除该文件。

在没有该选项的交互式开发场景中，仍会像原行为一样在终端打印一次性密码；原生安装器不会
使用这条路径。

## 健康检查

Hub 提供轻量免认证接口：

```text
GET /healthz
```

- 健康：`200 {"status":"ok"}`
- 存储关闭/不可用：`503 {"status":"unavailable"}`

它只执行一次 `SELECT 1` 并确认 writer 队列仍在接受工作，不扫描遥测、不读取设置、不返回
构建或凭证信息。安装器不会把 `systemctl start` 的退出码当成成功，而是轮询该接口。

## 反向代理（Nginx）

Hub 只监听回环地址，外部必须通过 TLS 反向代理访问。直接 Hub 端口不得对公网可达，否则
客户端可以绕过代理伪造 `X-Forwarded-Proto` 和 `Host`。

Nginx 的核心配置：

```nginx
server {
    listen 443 ssl http2;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    # 现有备份按 8 MiB 分块上传；这里留出余量给请求头。
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:28080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

要求：

- 必须保留 `Host`（`proxy_set_header Host $host`），否则面板会把代理地址当成外部入口；
- 必须传递 `X-Forwarded-Proto: https`；
- WebSocket 必须支持升级，并设置足够长的空闲超时（`proxy_read_timeout 300s` 是保守起点）；
- 上传备份需要允许至少 8 MiB 的单次请求体；
- 覆盖 `/api/`、`/install.sh`、`/agent/`、WebSocket 和普通页面，无需额外 location 白名单；
- Agent 首次连接使用 `wss://`，证书必须被节点信任；任何安装路径都不使用 `curl -k`。

如果使用 Cloudflare 或其他 CDN，保持 TLS 校验和 Host 语义不变；Cloudflare 不是必需项。

## Agent 安装与更新

永久令牌模式（面板默认命令）：

```sh
tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT \
  && curl -fsSL 'https://hub.example.com/install.sh' -o "$tmp" \
  && sudo sh "$tmp" --server 'https://hub.example.com'
```

安装器会交互式读取令牌，不把令牌放进命令行或 shell 历史。安装完成后：

- `/etc/romi/agent.env` 为 `0600`；
- `/opt/romi/releases/<version>/romi-agent` 为 root 控制的版本化二进制；
- `/opt/romi/current` 原子切换到新版本；
- service 通过 `EnvironmentFile` 注入令牌；
- 旧版本目录保留。

批量注册窗口模式：

```sh
tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT \
  && curl -fsSL 'https://hub.example.com/install.sh' -o "$tmp" \
  && sudo sh "$tmp" --server 'https://hub.example.com' \
       --register-key '<short-lived-key>'
```

注册密钥短期有效、单次换取节点令牌，但会出现在自动化命令和 shell 历史中；永久令牌只写入
受保护 env 文件，不打印。

更新是显式的 operator 操作：重新运行安装器即可。romi 不实现静默自更新、后台 updater、
Hub 触发的远程更新或任意远程命令执行。

## 升级与备份/回滚

`sudo sh deploy/hub/install.sh --site https://hub.example.com` 在已安装系统上就是升级：

1. 验证新 release；
2. 安装新的版本目录；
3. 停止 Hub；
4. 原子切换 `current`；
5. 启动并通过 `/healthz` 验证。

新版本启动失败时，安装器不会自动回退。旧二进制仍在 `/opt/romi/releases/`，但数据库应用
schema 可能已经被新版本迁移；**不要在没有兼容备份的情况下盲目切回旧二进制**。

备份必须使用 romi 的一致性备份接口（面板「数据」页或 API），
不要直接复制正在运行的 DuckDB 文件、WAL 或 spill 目录。升级前建议先做一次应用备份；
release 目录的版本化与数据库安全无关。

## 分发状态与配置

只有当 Hub 启动时配置了合法 `--distribution-dir`，才启用：

- `GET /install.sh`
- `GET /api/agent/distribution`
- `GET /agent/vX.Y.Z/x86_64`

未配置时这些路由返回 503。启动时会校验本地分发的版本、目标、架构、文件名、大小、
SHA-256 和 x86-64 ELF 头；任何一项不符都会让 Hub 拒绝启动，而不是提供未经验证的文件。
Hub 从不访问 GitHub 获取 Agent，也不提供可变的 `/agent/x86_64` 别名。
