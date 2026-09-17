# romi 存储与容量基准（v0.3）

本阶段基准回答的是：**当历史真正变大时，romi 的内嵌 DuckDB 设计是否仍然可预测、可用？**
所有数字都来自本开发机的实际运行；不是产品保证，也不代表所有硬件/部署。

开发机：Intel Core Ultra 7 255H，16 逻辑核，30 GiB RAM，Linux 7.2.5，
DuckDB engine v1.5.5（crate `duckdb 1.10505.0`），Rust 1.98.0。
除特别说明外，Hub 使用产品默认配置运行，只改了 `--db-threads` 的对比项。

## 1. 基准工具

- `server/src/bin/romi-bench.rs`：benchmark-only Rust 工具，由 Cargo feature
  `bench` 控制，不进入 `make release`、`make package` 或发布包。
  - `seed`：用 DuckDB 批量 SQL 生成确定性的合法 romi 数据，支持节点数、历史
    天数、metrics 间隔、探测数、探测间隔、丢包率、延迟范围、流量增长、随机种子、
    物理插入顺序（`time`/`node`/`none`）和 chunk 行数；生成前打印估算行数，
    生成后打印实际行数和文件大小。
  - `profile`：在 DB 文件上直接执行生产历史查询的 `EXPLAIN ANALYZE` 和重复计时。
  - `sql`：benchmark-only 的 `EXPLAIN ANALYZE`/SQL 计时入口，用于验证优化假设，
    不是产品接口。
- `scripts/bench_analytics.py`：启动真实 release Hub，通过真实 HTTP 接口测量
  metric / ping / combined 历史窗口、reader 并发、查询期间 ingestion、备份/恢复/
  维护，并输出 JSON 与人类可读摘要。
- `scripts/bench.py`：保留 v0.2 的实时 ingestion/group-commit 基准；本阶段未改变其
  测量语义。

复现流程：

```sh
make release
make bench-fixture
python3 scripts/bench_analytics.py seed \
    --db /tmp/romi-large/bench.duckdb --nodes 500 --days 30 \
    --metric-interval 60 --probes 2 --probe-interval 60 \
    --loss-rate 0.01 --latency-min 5 --latency-max 250 \
    --seed 3003 --order time --out /tmp/romi-large/seed.json
python3 scripts/bench_analytics.py query \
    --db /tmp/romi-large/bench.duckdb --fixture-json /tmp/romi-large/seed.json \
    --windows 1,6,24,168,720,2160 --series metrics,ping,both \
    --query-iterations 2 --readers 1,3,4,6 --out /tmp/romi-large/queries.json
python3 scripts/bench_analytics.py ingest \
    --db /tmp/romi-large/bench.duckdb --fixture-json /tmp/romi-large/seed.json \
    --ingest-rate 400 --ingest-agents 50 --ingest-seconds 12 \
    --analytics-readers 2 --ingest-history-windows 24,720 --out /tmp/romi-large/ingest-400.json
python3 scripts/bench_analytics.py scale \
    --db /tmp/romi-large/bench.duckdb --fixture-json /tmp/romi-large/seed.json \
    --out /tmp/romi-large/scale.json
```

## 2. 实际测试数据集

| 数据集 | 节点 | 历史 | 探测 | metric interval | probe interval | metric 行 | ping_record 行 | DB 大小 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 100 | 7 d | 2 | 60 s | 60 s | 1,008,000 | 2,016,000 | 137 MB |
| Medium | 100 | 30 d | 2 | 60 s | 60 s | 4,320,000 | 8,640,000 | 532 MB |
| Large | 500 | 30 d | 2 | 60 s | 60 s | 21,600,000 | 43,200,000 | 2.7 GB |
| Very large | 500 | 90 d | 1 | 60 s | 60 s | 64,800,000 | 64,800,000 | 5.3 GB |
| Medium node-order | 100 | 30 d | 2 | 60 s | 60 s | 4,320,000 | 8,640,000 | 532 MB |

Stretch（1000 nodes × 30/90 d）本机未生成，未报告其数字。

## 3. 历史查询（真实 HTTP API）

所有窗口使用产品实际的 `GET /api/nodes/{id}/metrics`，`series=metrics|ping` 或
省略 `series` 为 combined；`step` 按 API 的 point budget 计算。每个
series/window 用多个节点、多次采样；这里只列关键窗口的 p50/p95。

### 3.1 Large（500 节点 × 30 天）

优化前（默认 `--db-threads 4`）：

| 查询 | 1 reader p50 | 4 readers p50 | 6 readers |
| --- | ---: | ---: | ---: |
| metrics 720 h | 62.5 ms | 133.2 ms | 130.3 ms + 71 个 503 |
| ping 720 h | 62.8 ms | 129.8 ms | 103.4 ms |
| combined 720 h | 124.3 ms | 258.3 ms | 224.5 ms |
| combined 2160 h | 122.4 ms | 217.2 ms | 199.5 ms |

优化后（默认 `--db-threads 8`）：

| 查询 | 1 reader p50 | 3 readers p50 | 4 readers p50 | 6 readers |
| --- | ---: | ---: | ---: | ---: |
| metrics 720 h | 39.0 ms | 69.2 ms | 76.7 ms | 83.9 ms + 53 个 503 |
| ping 720 h | 43.4 ms | 61.4 ms | 68.9 ms | 90.2 ms |
| combined 720 h | 82.2 ms | 124.9 ms | 144.0 ms | 122.5 ms |
| combined 2160 h | 74.9 ms | 129.9 ms | 123.1 ms | 139.1 ms |

同样的数据集、同样的 readers/iterations 下，single-reader combined 30-day
从 124.3 ms 降到 82.2 ms，4-reader combined 从 258.3 ms 降到 144.0 ms。
所有测量都是进程已启动、OS page cache 已热的 warm 运行；没有把 cold/reopen
运行当作同一分布。

### 3.2 Very large（500 节点 × 90 天）

| 查询 | 1 reader p50/p95 | 3 readers p50/p95 | 4 readers p50/p95 | 6 readers |
| --- | ---: | ---: | ---: | ---: |
| metrics 720 h | 45.1 / 48.4 ms | 85.3 / 107.4 ms | 121.6 / 162.8 ms | 169.9 / 362.4 ms + 56 个 503 |
| metrics 2160 h | 122.5 / 125.8 ms | 230.2 / 310.2 ms | 290.0 / 413.6 ms | 256.1 / 303.9 ms |
| ping 2160 h | 56.7 / 59.7 ms | 62.7 / 227.4 ms | 86.4 / 241.8 ms | 114.9 / 298.1 ms |
| combined 2160 h | 178.9 / 179.6 ms | 303.8 / 416.4 ms | 465.1 / 661.1 ms | 299.9 / 386.2 ms |

6 readers 时约 1/3 请求返回 503，因为产品 `HISTORY_GATE` 固定为 4；这不是数据库
错误，而是已有的 backpressure 语义。reader pool 仍是 3，未按基准请求扩大。

## 4. 测量前 profiling：真正的瓶颈

`EXPLAIN ANALYZE` 显示 metric 和 ping 查询即使在 `node_id=... AND ts>=...` 条件下
也会选择 `TABLE_SCAN`（Sequential Scan），并扫描整张表后过滤 node_id：

- DuckDB 默认 `index_scan_percentage = 0.001`、`index_scan_max_count = 2048`。
  单节点 30 天返回 1,441 个 bucket，但原始扫描行数是 43,200（metric）或
  86,400（ping），远高于默认会走 ART 索引的上限；优化器因此选择顺序扫描。
- 对 metric 的每节点 30 天查询，计划是 `TABLE_SCAN` + `HASH_GROUP_BY`。扫描成本
  随 **整张表** 的行数增长，而不是随该节点的 43,200 行增长。
- 因此首要瓶颈是“按 node_id 过滤的整表扫描”，不是 JSON 序列化，也不是
  `AVG/TRUNC` 表达式。

相关实验：

- 显式 `CREATE INDEX metric(node_id)` / `ping_record(node_id)` 后，提高
  `index_scan_percentage` 能强制 `INDEX_SCAN`，但 30 天聚合从约 12 ms 变成约
  101 ms：索引扫描的 row-id fetch 比向量化顺序扫描更慢。已拒绝。
- `SUM(...)//COUNT(*)` 替代 `TRUNC(AVG(...))`：在 medium 上 p50 12.60 ms vs
  12.35 ms，差异在噪声范围内。无收益，未采用。
- 拆分固定 SQL 表达式、减少重复 bucket 表达式：medium p50 基本不变。未采用。

### 4.1 物理 row group 顺序的实验

用完全相同的行数、只改 seed 的物理插入顺序（`--order node`），并直接执行同一
生产 SQL：

| 查询 | time-major | node-major | 改善 |
| --- | ---: | ---: | ---: |
| metric 720 h | 11.9 ms | 2.9 ms | ~4.1× |
| ping 720 h | 17.2 ms | 7.3 ms | ~2.4× |
| metric 2160 h | 11.8 ms | 3.0 ms | ~3.9× |
| ping 2160 h | 17.7 ms | 7.9 ms | ~2.2× |

这说明 zone-map 对 `node_id` 的剪枝非常有效，但生产 writer 是**按分钟交错写入不同
节点**的 append-only 模式，不会自然形成 node-major row group。要利用该收益，需要
周期性全表排序/聚簇或新的分析副本，维护和生命周期成本本阶段没有实施；这里只记录
测量证据，留待后续阶段做明确产品决策。未引入任何持久 rollup 表。

## 5. Ping 路径的 SQL 化实验

当前 ping 查询把原始行取回 Rust，在 `close_bucket` 中做 median/band/loss 折叠。
原型 SQL 用 `MEDIAN + MIN/MAX + SUM` 一次聚合：

- medium 30 天原始 DB 计时：raw p50 17.3 ms，`MEDIAN` 聚合 p50 12.3 ms。
- 但 DuckDB `MEDIAN(BIGINT)` 返回 `DOUBLE`；当 latency 接近 `2^53`/`i64::MAX`
  时会丢精度，甚至 `CAST(... AS BIGINT)` 直接报越界。现有 Rust 折叠使用整数
  运算，语义是精确的。
- 用 `list_sort`/`list_filter` 实现精确整数 median 的 SQL 版本 p50 17.6 ms，
  并不比原路径快。
- 结论：**保留 Rust fold**，不为了约 20–30% 的 DB 时间而牺牲大 latency 值的
  精确 median 语义。

## 6. Ingestion 与 analytics 并发

Large 数据集（500 节点 × 30 天），50 个真实 Agent WebSocket 连接，2 个 analytics
reader，12 s 窗口。结果：

| `--db-threads` | 目标 reports/s | 实际 offered/s | exact 累计流量 | 平均 batch | batch tx | 历史查询 p50 | 轻量 `/api/nodes` p50 (p99) | refused/failed |
| ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | :---: |
| 4（旧默认） | 100 | 97.6 | 是 | 17.4 | 89 | 5.65 ms | 1.13 (14.4) ms | 0 / 0 |
| 4（旧默认） | 400 | 399.2 | 是 | 12.8 | 441 | 5.68 ms | 1.23 (27.7) ms | 0 / 0 |
| 8（新默认） | 100 | 96.2 | 是 | 17.1 | 85 | 5.92 ms | 1.33 (29.2) ms | 0 / 0 |
| 8（新默认） | 400 | 400.0 | 是 | 16.4 | 344 | 5.86 ms | 1.10 (48.0) ms | 0 / 0 |

结论：4→8 线程在 analytics 并发下没有破坏 ingestion 正确性；`exact` 累计流量为真，
没有 refused/failed。更多 analytics 并发会让 writer 队列出现更长的等待，但已接受
的 telemetry 仍然提交。

## 7. 容量指导（仅本机测量）

**可用容量示例**

- 500 节点 × 30 天：21.6M metric + 43.2M ping_record，DB 2.7 GB；单 reader
  30 天 combined p50 约 82 ms；4 readers 约 144 ms；同时 400 reports/s ingestion
  仍保持 exact。
- 500 节点 × 90 天：64.8M metric + 64.8M ping_record，DB 5.3 GB；单 reader
  90 天 combined p50 约 179 ms；4 readers p99 约 661 ms；RSS 约 700 MB。
- 100 节点 × 30 天：13M 行，DB 532 MB；30 天 combined 单 reader 约 34 ms。

**第一个瓶颈**

1. 历史查询是整表顺序扫描（取决于总行数），不是按节点数据量扫描。总行数增大时，
   `HISTORY_GATE` 之外的 4 个请求会把 CPU/内存带宽吃满，这是本机看到的第一瓶颈。
2. 本机四个并发 90 天请求时 p99 已达到几百毫秒到 1 秒，部分请求因 gate 返回 503。
3. 恢复 staging 需要比正常服务更高的临时 DuckDB memory limit：默认 512 MiB
   在本机无法重建 100×30 天（13M 行）历史。v0.3 的恢复路径现在根据归档行数提出
   临时 staging 上限，并在主机内存预算不足时返回明确错误；这是恢复操作特有的，
   不会改变正常服务的 `--db-memory` 语义。

**不是保证**

上述数字只代表本机单次运行，没有跨机、没有多次中位数，也没有 1000+ 节点 stretch
配置。产品保证应保守地按相同量级打折，并以 operator 的实际 `--db-memory`、
`--db-threads` 和 retention 为准。

## 8. 备份 / 恢复 / 维护扩展

`scale` 模式在同一台临时数据库上执行：维护 → 下载备份 → 用隐藏的 chunked HTTP
上传恢复到新的临时 Hub → 校验行数。

| 数据集 | 备份归档 | 备份耗时 | 恢复耗时 | 恢复后验证 | 维护（CHECKPOINT/体检） |
| --- | ---: | ---: | ---: | ---: | ---: |
| Medium | 10.4 MB | 0.50 s | 6.5 s | 4.32M metric + 8.64M ping | 0.005 s，未重写 |
| Large | 22.9 MB | 2.14 s | 46.0 s | 21.6M metric + 43.2M ping | 0.006 s，未重写 |
| Very large | 63.3 MB | 7.39 s | 108.7 s | 64.8M metric + 64.8M ping | 0.014 s，未重写 |

结论：

- 现有 256 MiB 压缩备份上限在实测到的最大的 5.3 GB / 129.6M 行数据集上仍然
  合理（63.3 MB），本阶段不修改该限制；没有把上限盲目放大。
- 恢复时间随行数增长（medium 6.5 s → large 46 s → very large 109 s），主要成本
  是解包、重建表和构建 primary-key ART 索引。
- 恢复的 staging 数据库在构建期间需要临时更高的 DuckDB 内存上限；恢复成功后
  临时文件删除，正常 live handle 重新按配置的 `--db-memory` 运行。
- backup/restore 的语言语义、manifest 和 archive member 限制没有改变。
