# 部署与升级

Hub 与 Agent 支持 Debian（systemd）与 Alpine（OpenRC），安装器支持 `--init auto|systemd|openrc`；
平台矩阵与工件见[发布](release.md)。Hub/Agent 都以独立非 root 账号运行。Hub 仅监听回环，外部 HTTPS 由反向代理终止。
原生安装需要 shell、curl、sha256sum 和系统账号管理工具；GNU Hub 需要系统 libstdc++。
Agent Docker 镜像见下文「Agent Docker」一节；不提供 Hub Docker 交付，也不提供从可变 master 源码执行 `curl | sh` 的安装路径。

## 安装来源与校验

Hub 从发布包安装，Agent 从你的 Hub 安装。两者使用不同的来源校验方式。

### 安装 Hub

1. 从 GitHub Release 下载不可变的 release 资产；
2. 按[发布](release.md)验证 attestation 与 `SHA256SUMS`；
3. 在一个空目录中解压 `romi-hub-vX.Y.Z-<target>.tar.gz`；
4. 在解压目录运行 romi 自带的 Hub 安装器 `deploy/hub/install.sh --site https://hub.example.com`，命令示例见[快速开始](quick-start.md)。

安装器不下载源码或二进制，也不自行校验 attestation 或 `SHA256SUMS`；它检查 `release.json`（Hub 组件、公开发行、版本与 target）并运行两个二进制的 `--version`，拒绝 release candidate 与本地快照。
`--site` 必须是 `https://` 加域名（可带端口），不能是 IP、localhost，也不能带路径、查询或 userinfo。
Hub 默认监听 `127.0.0.1:28080`，可用 `--port` 修改（Nginx 的 `proxy_pass` 需同步）。
`--no-start` 不启动 Hub；在已运行的系统上，安装器仍会先停止 Hub 再切换 `current`，之后需手动 `systemctl start romi-hub` 或 `rc-service romi-hub start`。

### 接入 Agent

Hub 安装成功并配置了内置 Agent 分发后：

1. 管理员在面板创建节点或开启短期注册窗口；
2. 节点从**受信任的 Hub HTTPS 域名**下载 `/install.sh`；
3. 安装器从同一个 Hub 获取精确版本的 Agent；
4. 本地校验大小、SHA-256 与 `romi-agent --version`；
5. 按目标系统安装 systemd 或 OpenRC 服务，Agent 连接同一个 Hub。

这一步的真实性边界是 **Hub 的 HTTPS 证书和域名**。Hub 返回的 SHA-256 能证明传输和安装
物一致，但它和二进制来自同一个 Hub，不是独立的第三方签名。

## 文件系统布局

```text
/opt/romi/
    hub/                        # Hub 安装器拥有
        releases/
            <version>/
                romi-hub
                romi-agent
                VERSION
                release.json
        current -> releases/<version>/
    agent/                      # Agent 安装器拥有
        releases/
            <version>/
                romi-agent
                VERSION
                release.json
        current -> releases/<version>/
/var/lib/romi/
    romi.duckdb                 # 另有 romi.duckdb.wal 与 romi.duckdb.lock，见存储
    GeoLite2-Country.mmdb      # 可选，由后台下载
    tmp/                        # 0700，Hub 专用的 DuckDB 临时目录
    bootstrap-password          # 首次启动生成，0600
    distribution/
        <version>/
            romi-agent          # 本机目标，0640 root:romi
            distribution.json   # 0640 root:romi
            <target>/           # 其余目标各一个目录（0750），文件 0640，均为 root:romi
                romi-agent
                distribution.json
/etc/romi/
    hub.env                     # ROMI_SITE，0640 root:romi
    agent.env                   # Agent 的地址、令牌与间隔，0600
/etc/systemd/system/romi-hub.service 或 /etc/init.d/romi-hub
```

目录用途：

- 二进制和版本元数据在 `/opt/romi/<组件>/releases/<version>/`，只读、root 控制；
- Hub 和 Agent 各有独立的 `releases/` 与 `current`，因此同一台机器可以同时装两者，各自升级互不影响；
- DuckDB、可选 Country 数据库、临时目录和分发缓存位于 `/var/lib/romi/`，**绝不在 `/opt` 或版本目录内**；
- 安装或升级不移动、不覆盖数据库；
- 分发目录由 root 控制，Hub 进程只读；
- Agent 服务账号只获得运行所需的最小权限。

## 服务账号与服务文件

Hub 使用专用系统账号 `romi`，无交互 shell。Agent 使用专用系统账号 `romi-agent`，
同样无交互 shell。两者都不获得 Linux capabilities。

Hub 的服务文件来自 release 归档中的 `deploy/hub/romi-hub.service.in` 或 `romi-hub.openrc.in`。
Agent 使用 `install.sh` 内嵌的 unit 与 OpenRC 脚本；只有从 Agent 归档目录运行安装器时，systemd 才读取 `deploy/agent/romi-agent.service.in`。
systemd 下，安装器先对指向新版本目录的临时副本执行 `systemd-analyze verify`（如果可用），通过后才安装。
每次安装都按本次参数重写 `hub.env` 与服务文件。

Hub unit 监听 `127.0.0.1:<--port>`（默认 28080），并要求：

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
`ROMI_INTERVAL` 与可选的 `ROMI_IFACE` 注入非 root 的 Agent 进程。Agent unit 特别保留了 `/proc` 的完整可见性，
不设置 `ProtectProc=` / `ProcSubset=`，并使用 `ProtectHome=read-only` 而不是 `yes`，
以免隐藏单独挂载的 `/home` 文件系统导致磁盘总量错误。

## 首次管理员凭证

原生安装的 Hub 在数据库全新且配置了 `--bootstrap-password-file` 时：

- 生成高熵管理员密码；
- 用 `O_EXCL` 和 0600 权限原子写入配置路径；
- 绝不把密码写到 stdout 或 journal；
- 日志只说明凭证写到了哪里；
- 已存在的凭证文件不会被覆盖；
- 管理员在面板成功修改密码或用户名后，Hub 进程立即删除该文件（不是安装器删除，也不需要重装）。只改用户名时密码仍是这份 bootstrap 密码，删除前先记下。

首次登录的账号为 `admin`，密码用 `sudo cat /var/lib/romi/bootstrap-password` 读取（文件属 `romi`，权限 0600）。
数据库是全新的而旧的凭证文件仍在时，Hub 拒绝启动；重建数据库前先删除残留的该文件。

未配置该选项时（开发用），Hub 在终端打印一次性密码；原生安装器总是配置该选项。

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

    # 浏览器每片上传 4 MiB；Hub 单请求上限为 8 MiB，这里留出余量。
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

- 必须保留 `Host`（`proxy_set_header Host $host`），否则 Hub 看到的是代理上游地址，添加节点、批量注册与 Agent 注册都会被拒绝（403）；
- 传递 `X-Forwarded-Proto` 时第一项必须是 `https`；未传时按 `--site` 的 scheme 判断；
- 必须传递 `X-Forwarded-For`：Hub 只在对端是回环地址时采信它的最后一项，用于每地址的匿名实时连接配额和登录、注册限流；缺少时所有访客共用 127.0.0.1 的配额；
- WebSocket 必须支持升级，并设置足够长的空闲超时（`proxy_read_timeout 300s` 是保守起点）；
- 上传备份需要允许至少 8 MiB 的单次请求体；
- 覆盖 `/api/`、`/install.sh`、`/agent/`、WebSocket 和普通页面，无需额外 location 白名单；
- Agent 只信任二进制内置的公共 Web PKI 根证书（见[安全边界](security-baseline.md)），Hub 域名必须使用公共 CA 签发的证书。

使用 Cloudflare 或其他 CDN 时，保持 TLS 校验和 Host 语义不变，并用 Nginx realip（`set_real_ip_from`、`real_ip_header`）还原客户端地址，否则 `X-Forwarded-For` 的最后一项是 CDN 边缘地址；CDN 以 HTTP 回源时 `$scheme` 为 `http`，添加与安装节点会被拒绝。CDN 不是必需项。

## Agent 安装与更新

永久令牌模式（面板默认命令，`--interval` 取面板保存的上报间隔）：

```sh
tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT \
  && curl -fsSL 'https://hub.example.com/install.sh' -o "$tmp" \
  && sudo sh "$tmp" --server 'https://hub.example.com' --interval 3
```

安装器会交互式读取令牌，不把令牌放进命令行或 shell 历史。需要覆盖默认流量接口识别时，可追加
`--iface 'eth1'`（只统计指定接口）或 `--iface '-eth0'`（从默认集合排除接口）。该策略保存为
`ROMI_IFACE`；以后普通升级未提供 `--iface` 时自动保留，显式 `--iface ''` 才恢复默认识别。

安装完成后：

- `/etc/romi/agent.env` 为 `0600`；
- `/opt/romi/agent/releases/<version>/romi-agent` 为 root 控制的版本化二进制；
- `/opt/romi/agent/current` 原子切换到新版本，与 Hub 的 `current` 相互独立；
- service 通过 `EnvironmentFile` 注入令牌；
- 旧版本目录保留。

批量注册窗口模式：

```sh
tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT \
  && curl -fsSL 'https://hub.example.com/install.sh' -o "$tmp" \
  && sudo sh "$tmp" --server 'https://hub.example.com' \
       --register-key '<short-lived-key>'
```

注册密钥在一小时窗口内可供最多 100 台节点使用，每次注册换取各自的长期令牌；短期 key 会出现在自动化命令和 shell 历史中，长期令牌只写入
受保护 env 文件，不打印。

更新是显式的运维操作：重新运行安装器，并再次提供该节点的永久令牌（交互输入或 `--token-stdin`）；安装器不复用
`agent.env` 中的旧令牌。令牌遗失时在面板轮换令牌，旧连接随之断开。未传 `--interval` 时上报间隔恢复为 3 秒，`--iface` 则会保留。
romi 不实现自更新、Hub 触发的远程更新或远程命令执行。

## 升级与备份

升级前先在面板「数据」页做一次应用备份，再在**新 release 的解压目录**运行安装器，并重复首次安装时的 `--port` 与 `--init`：

```sh
sudo sh deploy/hub/install.sh --site https://hub.example.com
```

安装器依次验证新 release、安装新的版本目录与分发目录、重写 `hub.env` 与服务文件（`--distribution-dir` 指向新版本）、停止 Hub、原子切换 `current`，
再启动并轮询 `/healthz`。启动失败时不会自动回退。

只把 `current` 改回旧版本不能回退：旧 Hub 会因分发目录版本与自身不符而拒绝启动，数据库 schema 若已迁移也会被旧 Hub 拒绝打开（见[存储](storage.md)）。
回到旧版本需要用旧 release 的安装器重新安装，并恢复升级前的应用备份。

备份必须使用 romi 的一致性备份接口（面板「数据」页或 API），
不要直接复制正在运行的 DuckDB 文件、WAL 或 spill 目录；release 目录的版本化与数据库安全无关。

## 分发状态与配置

只有当 Hub 启动时配置了合法 `--distribution-dir`，才启用：

- `GET /install.sh`
- `GET /api/agent/distribution`
- `GET /agent/vX.Y.Z/<target>`

未配置时这些路由返回 503；无版本号的 `/agent/<target>` 在配置了分发时返回 404。启动时会校验本地分发的版本、目标、架构、文件名、大小、
SHA-256 和目标 CPU 对应的 ELF 架构（x86-64/aarch64）；任何一项不符都会让 Hub 拒绝启动，而不是提供未经验证的文件。
Hub 从不访问 GitHub 获取 Agent。

## Alpine / OpenRC

选择对应 CPU 的 `*-unknown-linux-musl` 归档，校验后在一个空目录中解压。
Alpine 安装 curl、ca-certificates 和 OpenRC 后，以 root 执行：

```sh
sh deploy/hub/install.sh --site https://hub.example.com --init openrc
rc-service romi-hub status
```

Agent 使用后台生成的安装步骤，安装脚本自动识别 Alpine 与 CPU；也可显式加 `--init openrc`。
OpenRC 服务由 supervise-daemon 管理，以 romi / romi-agent 账号运行，令牌从权限 0600 的
配置文件按字面读取，不作为 shell 脚本执行，也不放进进程命令行。
日志为 `/var/log/romi-hub.log` 与 `/var/log/romi-agent.log`，权限 0600；运维时配置系统日志轮转。
服务加入 default runlevel，`rc-service ... restart/stop` 管理生命周期。

## Agent Docker（Linux 宿主机）

镜像发布在 GHCR，同一标签包含 x86_64 与 ARM64，拉取前可验证来源：

```sh
gh attestation verify oci://ghcr.io/dejavumoe/romi-agent:X.Y.Z --repo DejavuMoe/romi
docker pull ghcr.io/dejavumoe/romi-agent:X.Y.Z
```

无法访问 GHCR 时，下载发布资产中的 `romi-agent-vX.Y.Z-docker-<arch>.tar.gz`（`<arch>` 为 `x86_64` 或 `aarch64`）并校验，
用 `docker load --input <归档>` 导入，再 `docker tag romi-agent:X.Y.Z ghcr.io/dejavumoe/romi-agent:X.Y.Z`。

`compose.yml` 取自与发布标签对应的源码 `deploy/agent/compose.yml`。将它放在一个专用目录，在同目录创建 `agent.env`（权限 0600）：

```dotenv
ROMI_SERVER=https://hub.example.com
ROMI_TOKEN=<node-token>
ROMI_INTERVAL=3
```

执行 `docker compose up -d`。`image:` 固定到一个版本标签，不跟随 `latest`；
升级时把它改为新版本，拉取后重建容器。

host network/PID/UTS 与 `/:/host:ro` 用于读取宿主机真实指标。容器为 UID 65534，根文件系统只读，
capabilities 全部移除，no-new-privileges 开启，默认内存限制 64 MiB、PID 限制 32；
不需要 privileged 或 Docker socket。移除这些宿主视图后，采集结果不再代表完整的宿主机指标。
Docker Desktop 的宿主视图是它的 Linux VM，不代表 Windows/macOS 的物理宿主。

## 资源

建议 Hub 从 1 GiB RAM 起配置，并随历史规模、并发查询与备份/恢复实测调整；DuckDB 参数与默认值见[存储](storage.md)。
原生安装器不提供 `--db-memory`、`--db-threads`，手工修改的服务文件与 `hub.env` 会在下次安装时被覆盖；日志级别由环境变量 `ROMI_LOG` 控制。
连接与并发上限见[架构](architecture.md)，容量测量方法见[容量基准](bench.md)。

### 国家/地区数据库

后台设置页可保存 HTTPS Country MMDB 直链并更新、取消或重试；仅接受 Country 类型，下载上限 32 MiB、总超时 120 秒，格式完整验证后原子替换，失败保留旧库。查询完全本地进行。

## 故障排查

先区分 Hub 服务、反向代理和 Agent 三处连接，再查看对应日志。

| 现象 | 检查方向 |
| --- | --- |
| 域名返回 502 | 在 Hub 主机请求 `curl -fsS http://127.0.0.1:28080/healthz`；使用自定义端口时同步修改命令与代理配置 |
| 面板能打开，但无法添加节点 | 检查浏览器地址是否为 HTTPS 域名，以及代理是否保留 `Host`、传递 `X-Forwarded-Proto` |
| 安装命令不可用或返回 503 | 检查 Hub 启动参数中的 `--distribution-dir`；分发文件必须与 Hub 版本匹配 |
| Agent 一直未连接 | 检查节点到 Hub 的网络、域名解析、公共 CA 证书、令牌和 WebSocket 代理配置 |
| WebSocket 频繁断开 | 检查代理的升级头与读超时，确认 Hub 或 Agent 服务没有反复重启 |
| 恢复被拒绝 | 按错误检查备份格式、版本、大小和磁盘空间，限制见[存储](storage.md#备份格式与限制) |

systemd 部署可查看最近的服务日志：

```sh
sudo journalctl -u romi-hub -n 100 --no-pager
sudo journalctl -u romi-agent -n 100 --no-pager
```

OpenRC 使用 `rc-service romi-hub status` / `rc-service romi-agent status` 检查服务，日志位置见 [Alpine / OpenRC](#alpine-openrc)。反馈问题前去掉日志中的令牌、注册 key 和其他凭据。
