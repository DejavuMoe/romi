# romi v0.1.0

自托管的 Linux 主机监测：一个 Hub 汇集多台主机的资源、历史与 TCP 监测结果。

安装见[快速开始](https://github.com/DejavuMoe/romi/blob/v0.1.0/docs/quick-start.md)与[部署](https://github.com/DejavuMoe/romi/blob/v0.1.0/docs/deployment.md)。

## 下载与验证

```sh
gh attestation verify <文件> --repo DejavuMoe/romi
sha256sum --check --ignore-missing SHA256SUMS-<target>
```

## Agent 镜像

```sh
docker pull ghcr.io/dejavumoe/romi-agent:0.1.0
```
