# SQLite → DuckDB 迁移记录

本文件记录这次存储引擎替换的决策、边界、验证结果与遗留限制，并随实现更新。
它不是提案：仓库里已无 SQLite 依赖，Hub 的生产持久化只有 DuckDB。

## 1. 版本

| 项目 | 值 |
| --- | --- |
| Rust crate | `duckdb = "=1.10505.0"`，features `bundled` + `parquet` |
| 内置引擎 | DuckDB **v1.5.5**（`SELECT version()` / `pragma_version()`） |
| crate 与引擎编号 | 互不相同：`1.10505.0` 打包 `1.5.5`；运行时用 `db::ENGINE_VERSION` 断言 |
| 应用 schema 版本 | `romi_schema.version`，当前 **1** |
| 备份格式版本 | `manifest.json` 的 `format: 1` |

引擎版本不符时 Hub 拒绝启动（`schema::engine_version`），所以升级 crate 必须同时
更新 `ENGINE_VERSION` 并重跑 `make check`。

DuckDB 的 **存储格式版本** 由引擎自己校验：更新的存储格式在打开阶段就被引擎拒绝，
我们的代码不会运行。这一点无法用伪造文件测试，因此没有对应断言。

## 2. 为什么必须换掉哪些 SQLite 假设

- `INTEGER` 在 DuckDB 是 32 位。所有 id、字节计数器、时间戳列都是 `BIGINT`；
  `tests::values_beyond_32_bits_and_2038_survive` 用 5 GiB 计数器和 2100 年时间戳验证。
- `/` 是浮点除法，`CAST(double AS BIGINT)` **四舍五入**（SQLite 截断）。
  历史查询因此显式写 `ts // step` 与 `CAST(TRUNC(...) AS BIGINT)`；
  `tests::history_buckets_and_truncates_the_way_the_contract_says` 锁住这个契约。
- 没有 `WITHOUT ROWID`；`PRIMARY KEY` 变成 ART 索引，这正好是 `metric`/`ping_record`
  的去重规则，但代价见第 5 节。
- 没有 `ON DELETE CASCADE`（解析器直接拒绝），而且父行删除时的外键检查**看不到同一
  事务中先删掉的子行**。两条都由 `server/tests/duckdb_engine.rs` 断言。
- 没有 `setval`，行号也不再由 rowid 分配。见第 4 节。
- `INSERT OR REPLACE`、`PRAGMA user_version`、`sqlite_master`、`wal_checkpoint`、
  `VACUUM`（SQLite 语义）全部消失。

## 3. 并发、批处理与持久性

`Db` 由一个写线程、一个三连接读池和一道维护栅栏组成。

- **单写线程**拥有唯一的写连接。每个写操作是一个闭包，经容量 512 的有界通道投递，
  **提交之后**才回复调用者。写入线程取一个任务后会再吸干已排队的、最多 256 个遥测
  任务，用**一个事务**提交（group commit）。通道满即背压：生产者阻塞而不是让队列增长。
- **读池**（3 个 `try_clone` 连接）服务历史与面板查询，各自独立，长查询不会串行化
  摄取；DuckDB 的 MVCC 给每条查询一个一致快照。历史查询另加 30 s 看门狗，超时用
  `InterruptHandle` 打断，避免已放弃的 HTTP 调用留下无人取消的扫描。
- **维护栅栏**（`RwLock`）在换文件时排空并拒绝队列中已接受的写，并在之后递增
  generation；携带旧 generation 的任务会被拒绝而不是写进新库。
- **持久性**：只有 `COMMIT` 返回后调用者才得到成功。已接受但未提交的遥测只存在于
  进程内队列，上限 512 条；进程崩溃会丢掉它们，但下一次上报带的是绝对值计数器，
  会重新补上。`/api/db` 的 `queue.queued` 就是这段窗口，`committed` 是已提交数。
- 关闭时 `Db::close()` 丢弃发送端、等待队列排空并 join 写线程，再由写线程做最后一次
  `CHECKPOINT`；失败会在日志中报告，不会被吞掉。

写路径**不使用** `prepare_cached`：crate 1.10505.0 的语句缓存在其他连接提交后会返回
被撕裂的数据（写 999400、读回 232，见 `duckdb_engine.rs` 的复现）。每条语句按需
prepare，代价见第 8 节。

## 4. 标识分配

`SELECT MAX(id)+1` 不安全，DuckDB 也没有 `setval`，因此 id 由一张表分配：

```sql
UPDATE romi_id SET next = next + 1 WHERE name = 'node' RETURNING next - 1
```

它在写线程的事务内执行，天然串行；导入与恢复后用 `schema::resync_ids` 把它推到
`MAX(id)+1`，所以**导入/恢复的 id 保持不变，之后新建的 id 不会与之冲突**。删除过的
id 不再复用——这比 SQLite 的 rowid 复用更安全，删除节点时仍然显式清掉子行。

## 5. 关系与去重（应用层强制）

DuckDB 的 `ON DELETE CASCADE` 不可用、同事务级联删除不可能，因此**没有声明任何外键**，
而在同一事务里显式完成：

| 行为 | 位置 |
| --- | --- |
| 删除节点：`ping_record` → `metric` → `traffic` → `ping_node` → `node` | `Db::delete_node` |
| 删除探测：`ping_record` → `ping_node` → `ping_task` | `Db::delete_ping_task` |
| 保存探测：校验节点存在、拒绝重复分配、超过 64 个探测即整体回滚 | `Db::save_ping_task` |
| 遥测守卫：节点/分配是否存在的判断 | 写线程的关系缓存 `Guard` |

`Guard` 是写线程私有的小缓存（节点集合、`(node, task)` 分配、每个节点的最新分钟、
每个探测的最新时间戳），开机时从库里加载，任何任务失败或换库后整体重建。它决定
**执行哪条语句**，而表上的主键仍然决定一行是否合法。

去重：
- `metric`：同一 `(node_id, ts)` 已写过（重连落在同一分钟）时先 `DELETE` 再 `INSERT`，
  否则一次普通 `INSERT`。
- `ping_record`：`(node_id, ts, task_id)` 同理，用每个探测的最新时间戳判断。

之所以不写 `ON CONFLICT`：release 构建实测普通 INSERT 97 µs/行，
`ON CONFLICT DO UPDATE` 1847 µs/行、`DO NOTHING` 1692 µs/行，
带 `WHERE EXISTS` 的插入 1636 µs/行（2 万行表格内单行插入）。守卫把常见路径
保持在普通 INSERT 上。

## 6. 备份、恢复与维护

**备份**是 gzip tar：每张表一个 Parquet 文件加 `manifest.json`（格式版本、应用 schema、
引擎版本、每个成员的行数与 SHA-256）。它不是数据库文件拷贝——DuckDB 文件只有连同
WAL 才一致，而直接还原目录会执行归档自带的 catalog 定义。备份在维护栅栏内做，
因此是一次一致快照；下载响应仍是 `Cache-Control: no-store`，文件权限 0600。

**恢复**分三步：先校验（成员路径、大小、摘要、Parquet 列名与类型对比本版本 schema）、
再在一个临时文件里**重建**一个完整数据库（行数、关系、id 全部核对），最后在栅栏内
切换文件：关闭所有连接 → 原名改到 `<db>.replaced` → 新文件就位 → 重新打开。任何一步
失败都会把原文件改回来并重新打开；只有全部成功后才删除旧文件。**归档里的 SQL 永远
不会被执行**，会话表在切换后清空，调用方重新登录。

**维护**（`POST /api/db/vacuum`，保持路由不变）：

1. 按 `retention_days` 删除历史；
2. `CHECKPOINT` 折叠 WAL；
3. 读 `pragma_database_size()` 的 `free_blocks * block_size`；
4. 可复用空间超过 4 MiB 时，用 `COPY FROM DATABASE` 复制到新文件并走同一套切换流程。

返回的 `freed` 是**实测**的磁盘差值，不是估算；空间不足时不重写，`compacted: false`、
`freed: 0`。DuckDB 的 `VACUUM` 文档明确说它不回收空间，所以这里不假装它回收。

## 7. 离线迁移（唯一允许读 SQLite 的地方）

```sh
# 1. 停掉旧 Hub，导出（只读打开源库，不改动源文件）
python3 scripts/migrate-sqlite.py --source /var/lib/romi/romi.db --out /tmp/romi-legacy.jsonl

# 2. 导入成一个全新的 DuckDB 文件（目标必须不存在）
target/debug/monitor-hub --import-legacy /tmp/romi-legacy.jsonl --db /var/lib/romi/romi.duckdb

# 3. 用新库启动
target/debug/monitor-hub --db /var/lib/romi/romi.duckdb
```

- 只支持**评审过的 schema 5**。更老的 schema 会带说明被拒绝：v1–v4 的 token 列含义
  变更过两次（先是明文 token，后是它的 SHA-256），猜错会导致所有 agent 无法认证或把
  摘要当凭证存下来。请先用对应的旧版 romi 升级，再导出。
- 导出脚本用 Python 标准库 `sqlite3`，以 `mode=ro` 打开，先跑 `PRAGMA integrity_check`，
  按表流式写入 JSONL（`<out>.partial` 完成后才改名）。整数以 JSON 整数写出，
  Rust 侧 `serde_json` 精确解析 i64，因此 `i64::MAX` 级别的计数器不会经过 double。
- 导入器只读 JSONL，逐行严格按目标列类型解码：不匹配就报错并删除半成品，
  **不会把转换失败写成 0**。目标文件先生成为 `<dest>.partial`，全部校验通过后才改名。
- **token_hash 原样复制**，绝不二次哈希；密码哈希、配置、历史行、id 全部保留。
- **会话不迁移**：导出时统计但跳过 `session` 表，导入后为空，所有人重新登录。
- 源 SQLite 文件在任何失败路径下都不被修改（`scripts/test-legacy-migration.py` 逐字节比对）。

## 8. 实测数据

完整表格见 [`bench.md`](bench.md)。要点（release，同一台机器，同一负载）：

- 一次上报（`accumulate`，含事务提交）约 **1.1 ms**，SQLite 版本约 0.2 ms；单写线程
  因此支撑约 900 次上报/秒，400 次/秒时队列峰值为 2。
- 把上报压到约 1000 次/秒时 Hub 会吃满 CPU 且不再响应 HTTP（**实测回退**）；
  SQLite 版本在同一负载下仍以 0.4 ms 响应。
- 历史查询 p50 约 10 ms（SQLite 约 6 ms）；RSS 相当；CPU 高约一倍。
- 同样数据下数据库文件约为 SQLite 的 4 倍；release 二进制 29.7 MB vs 6.4 MB。
- 两种构建在两个工况下累计流量都与实际上报字节完全一致；没有丢失遥测。

## 9. 安全配置

- `memory_limit`（默认 512MB）、`threads`（默认 min(核数,4)）、`temp_directory`
  （默认 `<db>.tmp`）、`max_temp_directory_size`（默认 2GB）在打开时通过 `Config`
  设置，可用 `--db-memory/--db-threads/--db-temp` 覆盖并在启动时校验。
  `memory_limit` **不是进程 RSS 上限**，它只约束 DuckDB 自己的缓冲。
- `autoinstall_known_extensions=false`、`autoload_known_extensions=false`、
  `allow_community_extensions=false`、`allow_unsigned_extensions=false`：运行时不会
  因为某条语句而下载或加载扩展。Parquet 由 crate 的 `parquet` feature 静态编入。
- 没有用户可控的 SQL 入口；`Db::exec`/`scalar` 是 `#[cfg(test)]`。
- 数据库、`<db>.wal`、spill 目录、`<db>.lock`、备份归档全部 0600/0700
  （`own_only`/`restrict_dir`），并且**不假设** SQLite 的 `-wal`/`-shm` 文件名。
- `<db>.lock` 用 `File::try_lock` 排他占用，第二个 Hub 进程（或同进程第二个句柄）
  会带说明被拒绝。

## 10. 已知限制

- 一个数据库文件同时只能有一个读写进程（DuckDB 本身如此）。要横向扩展需要另一种
  架构，本次没有做。
- 非 debug/release 之外的目标（musl、跨架构、容器）没有构建或测试过。
- `Guard` 的正确性依赖“所有 `node`/`ping_node`/`ping_task`/`metric`/`ping_record`
  的写入都经过写线程”这一条；绕过 `Db` 直接改库会让它过期。
- 表级 `VACUUM`（`vacuum_rebuild_indexes`）没有使用；压缩走复制。
- 旧的 SQLite 备份**不能**直接恢复：先用旧二进制恢复，再走第 7 节。
- **摄取上限**：单写线程每次上报约 1.1 ms，本机实测约 900 次/秒封顶；把负载压到
  约 1000 次/秒时 Hub 会吃满 CPU 并停止响应 HTTP（`scripts/bench.py --interval 0.02`
  会超时）。设计工况（数十到一两百次/秒）之内没有问题，但余量小于 SQLite 版本。
  本轮没有继续优化这条路径。
- 打包二进制依赖系统 C++ 运行库（`libstdc++`/`libgcc_s`），不是完全静态链接；
  musl 与跨架构构建未验证。
- Amazon/远端对象存储、DuckLake、MotherDuck、Quack、PostgreSQL 都没有引入。
