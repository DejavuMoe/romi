# 存储基准：SQLite → DuckDB

用 `scripts/bench.py` 在同一台机器、同一份数据、同一套负载下对两个构建各跑一遍。
复现：

```sh
make bench                                   # 当前（DuckDB）构建
git worktree add /tmp/romi-baseline HEAD      # SQLite 阶段的构建
cd /tmp/romi-baseline && cargo build --release --manifest-path server/Cargo.toml
python3 scripts/bench.py --bin-dir /tmp/romi-baseline/target/release --label sqlite
```

负载：20 个假 Agent 走真实 WebSocket 协议上报，历史为 20 节点 × 1 天分钟级明细
（28 800 条 metric + 57 600 条 ping_record + 2 个探测），4 个并发历史读者持续请求
`/api/nodes/{id}/metrics?hours=24`，测量窗口 20 s。两轮上报频率：每节点 2 s 一次
（设计工况，约 10 次/秒）与每节点 50 ms 一次（压力工况，约 400 次/秒）。

## 结果

| | SQLite 2 s | DuckDB 2 s | SQLite 50 ms | DuckDB 50 ms |
| --- | --- | --- | --- | --- |
| 提交的上报/秒 | 10.0 | 10.9 | 399 | 403 |
| 未提交队列峰值 | 不适用 | 1 | 不适用 | 2 |
| 小写入 p50 / p99（`POST /api/nodes`） | **1.06 / 2.22 ms** | 3.47 / 10.67 ms | **0.41 / 2.33 ms** | 3.41 / 7.33 ms |
| 小读取 p50（`GET /api/nodes`） | 0.40 ms | 0.42 ms | 0.42 ms | 0.78 ms |
| 历史查询 p50 / p95 / p99 | **6.23 / 12.80 / 16.69 ms** | 10.14 / 20.71 / 25.66 ms | **6.06 / 12.28 / 16.72 ms** | 9.76 / 19.74 / 25.07 ms |
| 历史查询条数（20 s） | 1 541 | 1 438 | 1 549 | 1 455 |
| 进程 RSS | 137 MB | 114 MB | 149 MB | 139 MB |
| CPU | 49.5 %（单核百分比） | 103 % | 51.6 % | 192 % |
| 数据库文件 | 2.9 MB | **11.3 MB** | 2.9 MB | 19.5 MB |
| 窗口内文件增长 | 12 kB | 257 kB | 12 kB | 8.4 MB |
| release 二进制 | **6.4 MB** | 29.7 MB | — | — |
| 累计流量与上报一致 | 是 | 是 | 是 | 是 |

单次操作成本（release，静止机器，`db::tests` 内测量，`cargo test --release`）：

| 操作 | 耗时 |
| --- | --- |
| 普通 INSERT（带主键索引，2 万行表内） | 97 µs |
| `ON CONFLICT DO UPDATE`（同上） | 1 847 µs |
| `ON CONFLICT DO NOTHING`（同上） | 1 692 µs |
| 带 `WHERE EXISTS` 的 INSERT | 1 636 µs |
| `accumulate`（一次上报的读改写 + 提交） | 1 106 µs |
| `insert_metric` | 507 µs |
| `insert_ping` | 399 µs |
| `all_traffic()`（节点列表读取） | 437 µs |

## 结论与回退

- **吞吐**：单写线程每次上报约 1.1 ms，因此本机摄取上限约 900 次/秒；400 次/秒时
  队列峰值为 2，说明远未触顶。设计工况（数百节点、每节点数秒一次上报，即几十到
  一两百次/秒）在能力之内，但**余量明显小于 SQLite 版本**（后者每次上报约 0.2 ms）。
- **压力上限**：把上报提到约 1000 次/秒（每节点 50 ms）时，Hub 会吃满 CPU 并在
  60 s 内不再响应 HTTP 请求；`scripts/bench.py --interval 0.02` 因此会超时退出。
  这是**实测到的回退**，不是推测：SQLite 版本在同一负载下仍以 0.4 ms 响应读写。
  该数值已写入「已知限制」，本轮没有继续优化。
- **延迟**：小写入 p50 从 1.06 ms 变为 3.47 ms（2 s 工况）、0.41 ms 变为 3.41 ms
  （50 ms 工况）；历史查询 p50 从约 6 ms 变为约 10 ms。两者都在面板可接受范围内。
- **内存**：RSS 相当（DuckDB 略低），但 CPU 高出一倍以上。
- **磁盘**：同样数据下 DuckDB 文件约为 SQLite 的 4 倍（11.3 MB vs 2.9 MB），
  压力工况下 20 s 内增长 8.4 MB（WAL），SQLite 为 12 kB。
- **体积**：release `monitor-hub` 从 6.4 MB 增至 29.7 MB（编入 DuckDB）。
- **正确性**：两种构建在两个工况下累计流量都与 Agent 上报的字节数完全一致
  （`accumulated.exact`）；压力工况下 `lost=780` 在两个构建上相同，那是测量脚本
  写入套接字但 Hub 尚未读走的在途上报，不是存储层丢失。

### 为什么慢

DuckDB 的 `ON CONFLICT` 与相关子查询在单行写入上比普通 INSERT 贵 17 倍以上，因此摄取
路径改用写线程私有的关系缓存（`db::Guard`）决定执行哪条语句，并把「同一分钟重写」
做成显式的 `DELETE` + `INSERT`。这一改动把 2 s 工况下的写入 p50 从无法用（>60 s 超时）
降到 3.47 ms，但单次上报仍要付一次事务提交加一次带索引 UPDATE 的代价。

### 没有做的比较

- 没有跑「DuckDB 更快」的分析型负载（大范围聚合、Parquet 直接扫描）。本表只包含
  Hub 真实执行的负载，因此结论只适用于这些负载。
- 没有测试网络存储、容器、musl、跨架构或更大数据量（>1 天历史、>20 节点）下的表现。
- 没有在 CI 机器上重复测量；上表全部来自本开发机一次运行，未经多次取中位数。
