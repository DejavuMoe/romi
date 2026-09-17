//! SQL text shared by the storage layer and the benchmark tooling.
//!
//! The benchmark binary includes this file directly so its `EXPLAIN ANALYZE`
//! output and direct timings describe exactly the statements production runs,
//! rather than a near-copy that can drift.

/// One node's metric history, thinned to one sample per `step` seconds.
///
/// Parameters: `?1` node id, `?2` window start, `?3` bucket width.
pub const METRICS_SQL: &str = "SELECT (MIN(ts)//?3)*?3, AVG(cpu), CAST(TRUNC(AVG(mem_used)) AS BIGINT),
        CAST(TRUNC(AVG(disk_used)) AS BIGINT),
        CAST(TRUNC(AVG(net_rx)) AS BIGINT), CAST(TRUNC(AVG(net_tx)) AS BIGINT)
 FROM metric WHERE node_id=?1 AND ts>=?2 GROUP BY ts//?3 ORDER BY (MIN(ts)//?3)*?3";

/// One node's probe rows for a window, one row per sample.
///
/// Parameters: `?1` node id, `?2` window start, `?3` bucket width.
///
/// `//` rather than `/`: DuckDB's `/` is floating-point division, and a bucket
/// index that arrived as a float would make `bucket * step` a float too.
pub const PING_ROWS_SQL: &str = "SELECT ts//?3, task_id, latency FROM ping_record
     WHERE node_id=?1 AND ts>=?2
           AND task_id IN (SELECT task_id FROM ping_node WHERE node_id=?1)
     ORDER BY ts";
