# romi Web（默认公开状态页 / 主题参考实现）

`web/` 是 romi 内置的公开状态页，同时作为第三方主题的参考实现：React + Vite，构建产物在
Hub 编译时嵌入 `romi-hub`。当前源码版本为 `0.1.0`，尚未创建公开发行标签，也没有独立的主题
Release 或下载入口。

## 开发

先在仓库根启动本地 Hub；监听 `127.0.0.1:9911` 时无需额外配置：

```sh
make dev-server
```

另开终端启动 Vite 开发服务器，Vite 将 `/api` 与 WebSocket 代理至 Hub：

```sh
pnpm --filter @romi/web dev --host 127.0.0.1 --port 5174 --strictPort
```

构建与检查：

```sh
pnpm --filter @romi/web build
pnpm --filter @romi/web lint
pnpm --filter @romi/web test
```

`make frontend` 会把 `web/dist`、`web/theme.json` 和预览图放到 `server/target/theme`，再随
Hub 一起编译。公开发行中的 Hub 二进制已经包含这些资源；`GET /install.sh` 与
`GET /agent/{arch}` 仍返回 503，本项目没有远程主题安装或分发入口。

## 主题包

一个可安装主题是一个目录，名字必须与 `theme.json` 的 `short` 相同：

```text
<themes-dir>/<short>/
├── theme.json
├── preview.png        # 可选，面板上的预览图
└── dist/
    └── index.html
```

`theme.json` 的字段均为字符串：

| 字段 | 含义 |
|---|---|
| `name` | 显示名称 |
| `short` | 唯一短名，限字母、数字、`-`、`_`，取 `default` 则顶替 Hub 内置的那份 |
| `description` | 简介 |
| `version` | 主题版本 |
| `author` | 作者 |
| `url` | 源码地址 |

将目录复制到 Hub 的 `--themes` 位置，在后台「主题」页切换，无需重启。该路径仍然是本地、
手动的开发/部署行为，不涉及 `/install.sh` 或 GitHub Release 自动安装。

## 主题契约

主题是纯静态 SPA，只能依赖下列同源接口：

| 接口 | 用途 |
|---|---|
| `GET /api/me` | 站点名、登录状态、公开页开关 |
| `GET /api/nodes` | 节点列表、实时指标和累计流量 |
| `GET /api/nodes/{id}/metrics` | 历史指标和延迟记录 |
| `GET /api/ws` | 每 2 秒推送一次节点快照的 WebSocket |

`metrics` 的三个查询参数都可省：

- `hours=N` 窗口宽度。**匿名上限 168，登录后 2160**，超出静默 clamp——降采样限的是响应行数，
  这个上限限的是 Hub 扫描多少行。
- `points=W` 调用方画得下的点数，只会让 Hub 抽得更稀，不会更密。
- `series=metrics|ping` 只取要画的那一半，省掉的那半原本占响应的三分之一到三分之二。

探测曲线的名字在响应的 `probes` 里随样本一起下发，匿名可读，所以画延迟图不需要第二个请求，
也不需要管理员身份。

整个窗口的丢包率在响应的 `loss` 里，按探测 id 给出百分比，没丢包的探测不出现。**不要拿样本
行里的 `loss` 自己平均**：那一个是所在桶的百分比，除数已经丢了，而各桶样本数天然不等——窗口
首尾两桶本来就是残缺的，探测启停、节点掉线、Agent 跳过一轮都会再造几个。十三次里丢一次，
平均桶百分比会算出 50%。

匿名访问 `GET /api/nodes` 仅返回 `public=1` 的节点，响应中不含 `ip`、`hostname`、`remark`。
字段定义以 Hub 的 `server/src/api.rs` 为准。

未知路径回落到主题的 `dist/index.html`，客户端路由可用。`/admin/*` 由 Hub 内置后台接管，
不属于主题契约。

本主题用 `/node/{id}` 作为详情页。Hub 的回落对它够用，但**Hub 前面若有按路径做正向白名单的
反代或 WAF，得把这个前缀放行**：从列表点进去只是 pushState，边缘看不见，刷新详情页才会真的
请求 `/node/{id}`，症状是「点进去正常，一刷新就被拦」。

## 许可与来源

本主题使用 MIT 许可证（见仓库根 `LICENSE` 与 [`web/LICENSE`](LICENSE)），基于 stqfdyr 的
`monitor-probe/monitor-theme-default` 导入并统一到 romi；原始版权和许可证保留在
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 与
[upstream.lock.json](../upstream.lock.json)。旧上游自动化只保留在 `docs/upstream/` 作为历史参考。
