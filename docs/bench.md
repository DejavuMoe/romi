# 容量与消融实验

容量测量使用 ext4、固定输入和真实 release 二进制，不以代码行数、单次计时或 tmpfs 推导性能。
每次只改变一个因素；100/500 节点是测试规模，不是所有硬件的服务承诺。

| 工具 | 用途 |
| --- | --- |
| `scripts/bench.py` | 实时上报、group commit、CPU/RSS 和 API 时延 |
| `scripts/bench_analytics.py` | 确定性历史、真实 HTTP 查询、读写并发、备份/恢复与维护 |
| `server/src/bin/romi-bench.rs` | bench feature 下的数据生成与 SQL profile，不进入发行二进制 |
| `scripts/documentation_audit.py` | 文档规模与重复度、本地链接；文档消融时确认生产源码未变。不测运行性能，也不校验文档与源码的语义一致 |

```sh
make release
make bench            # scripts/bench.py 针对 target/release
make bench-fixture
python3 scripts/bench.py --help
python3 scripts/bench_analytics.py --help
```

运行前固定节点数、历史时长、上报/探测间隔、查询窗口、随机种子、插入顺序、并发与存储位置。
基线和变体至少重复三次；保存原始数据，报告中位数、离散程度、失败和超时，不挑选最好的一次。
结果包含源码/二进制摘要、工具链、硬件、文件系统、输入规模、正确性、错误数、延时与资源使用。
影响精度、样本覆盖或恢复时，先证明正确性再比较性能；不同源提交或输入不混为同一组结果。

临时数据库和日志留在 `.local/` 或构建镜像。长期引用的实验放入 `docs/experiments/`，只保留可复现结论和必要证据。
