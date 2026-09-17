# romi 存储架构

romi 的生产持久化只有一种引擎：内嵌 DuckDB。服务端通过 crate
`duckdb = "=1.10505.0"` 从源码静态编译引擎 v1.5.5，不在目标机安装或查找
`libduckdb`，也不回退到任何其他数据库。

## 文件与启动

数据保存在 `--db` 指定的单个文件中（默认 `monitor.db`）。

- 路径不存在：创建新的 romi DuckDB 数据库。
- 路径存在且是有效的 romi DuckDB 数据库：直接打开。
- 路径存在但不是有效的 romi DuckDB 数据库：拒绝启动，只读取文件头 12 字节进行判断，
  不会加载整个文件，也不会改写、重命名或删除原文件。

DuckDB 只允许一个进程读写同一数据库文件。romi 另外持有 `<db>.lock` 排他锁，
以便用明确的中文错误拒绝第二个 Hub 进程，而不是转述引擎错误。数据库文件、
`<db>.wal`、spill 目录 `<db>.tmp` 与锁文件都限制为当前用户可读写（0600/0700）。

引擎在打开时显式关闭扩展自动安装/自动加载，并设置内存、线程、临时目录和
临时空间上限（默认线程数取机器核心数与 8 的较小值，实测这比固定 4 更适合
大历史扫描）；Parquet 备份格式静态编入二进制，运行时不需要联网获取扩展。

## 写入队列与 group commit

所有写操作通过一个有界通道提交给唯一的 writer 线程：

- 通道容量为 512。调用方在队列满时阻塞，而不是让内存中的未提交窗口无限增长。
- writer 每取一个 telemetry 任务后，继续取走已经排队的同类任务，最多 256 个，
  在**一个事务**中提交，然后逐条答复调用方。这就是 group commit。
- 调用方只有在 `COMMIT` 返回后才收到成功；事务失败会向该批每一条任务返回失败。
  已接受但未提交的写入只存在于进程队列中，断电丢失窗口有界，且 Agent 的下一份
  绝对值计数报告会补回。

操作分成四类语义：

| 类别 | 例子 | 行为 |
| --- | --- | --- |
| Batch | Agent 的 metric / last_seen | 与其他 telemetry 共享 group commit |
| Solo | 设置、节点、会话等配置写入 | 单独事务，错误不会连累其他写入 |
| Maintenance | 保留期清理、CHECKPOINT、测量可复用空间 | 不推进 generation，不清空/拒绝排队写入 |
| Replace | 恢复备份、真正值得做的压缩 | 停止 reader、排空并拒绝旧 generation 的排队写入、切换文件、推进 generation |

备份快照不是 Replace。它不经过 writer 队列，而是在 reader 连接的事务中读取；
因此下载备份不会拒绝任何已接受的 telemetry，也不会断开 Agent 或增加 generation。

## 读取与快照

三个 reader 连接共享一个池。历史查询在连接池上执行，并带 30 秒中断上限；
一个慢查询不会堵住 writer。备份导出同样使用 reader 连接和单个只读事务，
多张表来自同一个 MVCC 快照，并且在导出期间只持有文件替换栅栏的读侧，
不会把 writer 挡在后面。

## 标识与关系完整性

`node` 与 `ping_task` 的 id 来自 `romi_id` 单调分配表，在 writer 事务内通过
`UPDATE ... RETURNING` 原子分配。删除过的 id 不会被重新发放，因此删除节点后再新建
节点不会继承旧节点的历史。恢复/重建后 `resync_ids` 会把分配器推到已有最大 id 之后。

DuckDB 的外键不支持级联删除，且其检查看不到同一事务中先执行的子行删除。
romi 因此在应用事务内显式维护关系：删除节点时同时清空 traffic、metric、ping_node、
ping_record、ping_task 的关联，恢复时 `verify_relationships` 会在切换前拒绝任何孤儿。

## 备份格式与限制

备份是一个 gzip tar，包含：

- 每张持久表一个 Parquet 成员；
- 一个 `manifest.json`，记录应用 schema 版本、写入引擎、每张表的行数和 SHA-256。

`session` 表**不在备份中**。它是运行时安全状态，不是业务数据：恢复后的数据库
始终从当前 schema 创建一张空的 `session` 表，因此恢复不会复活管理员已经注销的登录。

读取备份时同时执行四个明确上限：压缩文件 ≤ 256 MiB、成员数 ≤ 8（7 张持久表加
manifest）、单个成员展开 ≤ 256 MiB、全部成员展开总量 ≤ 1 GiB。解压采用固定 64 KiB
缓冲流式写入磁盘，不会把大成员整体读进内存；manifest 是唯一允许驻留内存的成员，
且有独立上限。校验/路径检查/重复成员/摘要检查在任何 staging 数据库创建之前完成。
如果平台能提供空闲空间信息，构建 staging 数据库前还会做一次咨询性磁盘空间检查；
它不构成预留，最终仍以真实写入错误为准。

## 恢复顺序与回滚

恢复按以下顺序执行，把可能失败的工作放在旧库被永久丢弃之前。staging 数据库先以
不带 `metric` / `ping_record` primary key 的形式建表并批量装入，再通过
`ALTER TABLE ... ADD PRIMARY KEY` 构建 ART 索引；这避免 DuckDB 在逐行写入时维护
大索引而超出正常服务的 memory limit。恢复会根据归档行数临时提高 staging 的
DuckDB memory limit，并在主机内存预算不足时返回明确错误，而不是让进程被 OOM kill：

1. 校验归档（成员、路径、数量、展开大小、类型、摘要）。
2. 在 scratch 文件中构建完整的新数据库，逐表导入并校验行数、列名和类型。
3. 在同一 staging 数据库中执行恢复变换：清除 session 表、校验关系、重置 id 分配器。
4. CHECKPOINT 并关闭 staging 数据库。
5. 在替换栅栏内激活：关闭旧库所有连接，原文件改名为 `.replaced`，staging 改名到正式路径。
6. 重新打开全部读写连接后返回成功。激活成功后恢复不再需要任何数据库变更。

原文件只在新文件成功打开后才删除；改名发布失败或新文件打开失败都会把原文件改名回来
并重新打开。因此失败的恢复仍然留在原数据库上。内存数据库则在一个事务里替换所有持久表，
且所有可失败步骤在 `COMMIT` 之前完成。

## 维护

`POST /api/db/maintenance` 与 `Db::maintenance()`：

1. 按保留天数删除过期历史（不触碰累计流量）。
2. 执行 `CHECKPOINT`，把 WAL 折入主文件。
3. 读取 `pragma_database_size()` 的可复用空间。
4. 仅当可复用空间超过阈值时，复制到新文件并切换（Replace 语义）。
5. 报告实测 `freed`（磁盘字节差）、`reusable`、`compacted` 和文件大小。

DuckDB 没有面向磁盘回收的收缩语义，因此接口和文案不使用其他数据库的重量级回收名称。

## 历史查询与容量

历史查询（`Db::metrics` / `Db::ping_records`）在同一节点 id 上过滤后按时间分桶。
DuckDB 默认的 `index_scan_percentage = 0.001`、`index_scan_max_count = 2048` 使
每节点返回超过约两千行的窗口不走 ART 索引，而是走顺序扫描并靠 ts zone map 剪裁
时间范围。v0.3 的 profiling 与容量测量详见 [存储基准](bench.md)。

v0.2 的默认 DuckDB worker 上限从 4 提升到 8（仍不超过机器核心数）：在大历史
扫描中，100 节点 × 30 天和 500 节点 × 30 天的单请求延迟明显下降，而并发 ingestion
仍保持 exact。`--db-threads` 仍可显式覆盖。

物理 row group 顺序对 zone-map 剪枝影响很大：node-major 数据在同样 SQL 下快约
2–4 倍。生产写入是按分钟交错不同节点的 append-only 模式，本阶段没有引入周期性
全表排序、聚簇或分析副本；这项测量作为后续产品决策的证据保留。

## 监控与关闭

`GET /api/db` 的 `queue` 字段暴露 writer 队列诊断：

- `queued_ops_current` / `queue_capacity`
- `accepted_ops_total` / `committed_ops_total` / `refused_ops_total` / `failed_ops_total`
- `transactions_total` / `batch_transactions_total` / `batch_ops_total`
- `max_batch_size` / `average_batch_size`
- `queue_wait_us_*` 与 `transaction_us_*`

`committed_ops_total` 按操作计数，不按事务计数；一个包含 N 条 telemetry 的 group commit
同时贡献 N 个 committed operation 和 1 个 batch transaction。被 generation 失效拒绝或
执行失败的任务不会计入已提交。

`Db::close()` 先停止接受新工作，然后确定性地等待 writer 排空已接受任务并完成最终
CHECKPOINT；随后等待所有进行中的 reader，关闭 prototype/reader/writer 连接，最后释放
`<db>.lock`。关闭返回成功后，不再有活动存储句柄使用该文件，同一路径可以立即重新打开。
如果 writer 无法结束，关闭会等待而不是返回一个“成功但仍有未完成写入”的结果；
硬终止由进程 supervisor 负责。

最后一个 `Db` 句柄被直接 drop（没有显式 close）时也执行同一段排空/关闭顺序，因此
implicit drop 不会比优雅关闭更早释放文件锁。
