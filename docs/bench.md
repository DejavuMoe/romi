# 性能测试

下面的工具用于测量上报、历史查询与维护开销。使用 ext4、固定输入和 release 二进制，每次只改变一个因素。
100/500 节点是预设测试规模，实际容量取决于硬件、历史量和查询负载。

| 工具 | 用途 |
| --- | --- |
| `scripts/bench.py` | 实时上报、group commit、CPU/RSS 和 API 时延；默认 20 个节点 |
| `scripts/bench_analytics.py` | 确定性历史、真实 HTTP 查询、读写并发、备份/恢复与维护；默认 100 个节点 |
| `scripts/design_ablation.py` | 单因素 Hub 消融：100/500 节点、各重复 3 次、只在 ext4 上运行；需要 `--features bench` 构建的 Hub，开关为 `ROMI_BENCH_BATCH_OPS`、`ROMI_BENCH_PUSH_MS`、`ROMI_BENCH_NO_SNAPSHOT_CACHE` |
| `scripts/design_baseline.py` | 对已验证的基线发行运行同一组端到端负载检查 |
| `scripts/rollup_ablation.py` | 分钟明细与小时汇总的查询对比，使用生产 schema/SQL；需要与引擎同版本的 Python duckdb 1.5.5 |
| `scripts/check_live_capacity.py` | 真实套接字检查实时连接席位与关闭后回收 |
| `scripts/ci_ablation.py` | 在新 runner 上测量完整 CI 门禁与诊断消融 |
| `scripts/frontend_ablation.mjs` | 当前格式化函数与本地基线版本的差分检查 |
| `server/src/bin/romi-bench.rs` | bench feature 下的数据生成与 SQL profile，不进入发行二进制 |
| `scripts/documentation_audit.py` | 文档规模与重复度、本地链接；文档消融时确认生产源码未变。不测运行性能，也不校验文档与源码的语义一致 |

```sh
make bench            # 先构建 release，再对 target/release 运行 scripts/bench.py
make bench-fixture
python3 scripts/bench.py --help
python3 scripts/bench_analytics.py --help
```

运行前固定节点数、历史时长、上报/探测间隔、查询窗口、随机种子、插入顺序、并发与存储位置。
基线和变体至少重复三次；保存原始数据，报告中位数、离散程度、失败和超时，不挑选最好的一次。
结果包含源码/二进制摘要、工具链、硬件、文件系统、输入规模、正确性、错误数、延时与资源使用。
影响精度、样本覆盖或恢复时，先证明正确性再比较性能；不同源提交或输入不混为同一组结果。

`bench.py` 与 `bench_analytics.py` 默认把临时数据库放在系统临时目录；测量时用 `TMPDIR`（`bench_analytics.py` 另有 `--work-dir`、`--db`）指向 ext4 路径（如 `.local/` 或构建镜像）。
