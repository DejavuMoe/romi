# 快速开始

从发布包安装一个 Hub，再把第一台主机接入。每一步的细节与原理见[部署](deployment.md)。

::: warning 测试版
romi 目前是 0.1.x 测试版，以 GitHub Pre-release 发布。请在可以重装的主机上试用，并定期导出备份。
:::

## 准备

- 一台运行 Hub 的 Linux 主机：x86_64 或 ARM64；Debian 12 这类 glibc ≥ 2.36 的 systemd 发行版，或 Alpine（OpenRC）。建议从 1 GiB 内存起步。
- 一个解析到该主机的域名，以及公共 CA 签发的证书（例如 Let's Encrypt）。Agent 只信任公共 CA；面板也只在 HTTPS 域名下允许添加节点。
- 一个反向代理，下文以 Nginx 为例。Hub 只监听回环地址，不要把它的端口直接暴露到公网。
- `curl`、`sha256sum`；验证来源时还需要 [GitHub CLI](https://cli.github.com/)。

## 1. 下载并验证

在 [Releases](https://github.com/DejavuMoe/romi/releases) 选择版本与目标平台。以 x86_64 GNU 为例，把 `vX.Y.Z` 换成实际版本：

```sh
gh release download vX.Y.Z --repo DejavuMoe/romi \
  --pattern 'romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz' \
  --pattern 'SHA256SUMS-x86_64-unknown-linux-gnu'
gh attestation verify romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz --repo DejavuMoe/romi
sha256sum --check --ignore-missing SHA256SUMS-x86_64-unknown-linux-gnu
```

Alpine 选择 `*-unknown-linux-musl` 归档；ARM64 选择 `aarch64-*`。

## 2. 安装 Hub

```sh
mkdir romi-hub
tar -xzf romi-hub-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz -C romi-hub
sudo sh romi-hub/deploy/hub/install.sh --site https://hub.example.com
```

`--site` 是用户访问面板的 HTTPS 地址。安装器创建 `romi` 服务账号、安装服务，并等 `/healthz` 返回健康后才结束。
安装器自动识别 systemd 或 OpenRC，也可用 `--init` 显式指定。

## 3. 配置 HTTPS 反向代理

把域名的 443 端口代理到 `127.0.0.1:28080`，保留 `Host`、传递 `X-Forwarded-Proto`，并允许 WebSocket 升级。
完整的 Nginx 配置与要求见[部署 · 反向代理](deployment.md#反向代理-nginx)。

## 4. 登录

打开 `https://hub.example.com/admin/`，账号为 `admin`，首次密码在 Hub 主机上读取：

```sh
sudo cat /var/lib/romi/bootstrap-password
```

登录后在「安全」页修改密码，Hub 会随即删除这个文件。

## 5. 接入第一台主机

在「节点」页选择「添加节点」。创建后会弹出安装对话框，给出安装命令和只显示这一次的节点令牌。
在要监测的主机上运行该命令，按提示输入令牌；几秒后节点显示为在线。

一次接入多台主机时，用「批量注册」开启一小时的注册窗口，每台主机用同一条命令换取各自的令牌。

## 接下来

- 公开状态页默认关闭，在「设置」中开放，并选择默认的卡片或列表视图。
- 在「通知」中配置 Telegram 或 Webhook，按节点打开离线提醒。
- 在「数据」中下载一次备份；升级前同样先备份，见[部署 · 升级与备份](deployment.md#升级与备份-回滚)。
- 遇到问题请先看[部署](deployment.md)，再到 [Issues](https://github.com/DejavuMoe/romi/issues) 反馈；安全问题见[安全策略](https://github.com/DejavuMoe/romi/blob/master/SECURITY.md)。
