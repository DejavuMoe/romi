//! SQL text shared by the storage layer and the benchmark tooling.
//!
//! The benchmark binary includes this file directly so its `EXPLAIN ANALYZE`
//! output and direct timings describe exactly the statements production runs,
//! rather than a near-copy that can drift.

/// One node's metric history, thinned to one sample per `step` seconds.
///
/// Parameters: `?1` node id, `?2` window start, `?3` bucket width.
pub const METRICS_SQL: &str = "WITH history AS (
 SELECT ts, 1::BIGINT AS samples, cpu AS cpu_sum, mem_used::HUGEINT AS mem_sum,
        disk_used::HUGEINT AS disk_sum, net_rx::HUGEINT AS rx_sum, net_tx::HUGEINT AS tx_sum,
        tcp::HUGEINT AS tcp_sum, CASE WHEN tcp IS NULL THEN 0 ELSE 1 END AS tcp_samples, udp::HUGEINT AS udp_sum, CASE WHEN udp IS NULL THEN 0 ELSE 1 END AS udp_samples, procs::HUGEINT AS procs_sum, CASE WHEN procs IS NULL THEN 0 ELSE 1 END AS procs_samples, zram_used::HUGEINT AS zram_used_sum, CASE WHEN zram_used IS NULL THEN 0 ELSE 1 END AS zram_used_samples, swap_disk_used::HUGEINT AS swap_disk_used_sum, CASE WHEN swap_disk_used IS NULL THEN 0 ELSE 1 END AS swap_disk_used_samples, swapfile_used::HUGEINT AS swapfile_used_sum, CASE WHEN swapfile_used IS NULL THEN 0 ELSE 1 END AS swapfile_used_samples, swap_partition_used::HUGEINT AS swap_partition_used_sum, CASE WHEN swap_partition_used IS NULL THEN 0 ELSE 1 END AS swap_partition_used_samples
 FROM metric WHERE node_id=?1 AND ts>=?2
 UNION ALL
 SELECT ts, samples, cpu_sum, mem_sum, disk_sum, rx_sum, tx_sum, tcp_sum, tcp_samples, udp_sum, udp_samples, procs_sum, procs_samples, zram_used_sum, zram_used_samples, swap_disk_used_sum, swap_disk_used_samples, swapfile_used_sum, swapfile_used_samples, swap_partition_used_sum, swap_partition_used_samples
 FROM metric_hour WHERE node_id=?1 AND ts>=?2
 ) SELECT (MIN(ts)//?3)*?3, SUM(cpu_sum)/SUM(samples),
        CAST(TRUNC(SUM(mem_sum)/SUM(samples)) AS BIGINT),
        CAST(TRUNC(SUM(disk_sum)/SUM(samples)) AS BIGINT),
        CAST(TRUNC(SUM(rx_sum)/SUM(samples)) AS BIGINT),
        CAST(TRUNC(SUM(tx_sum)/SUM(samples)) AS BIGINT),
        CAST(TRUNC(SUM(tcp_sum)/NULLIF(SUM(tcp_samples),0)) AS BIGINT),
        CAST(TRUNC(SUM(udp_sum)/NULLIF(SUM(udp_samples),0)) AS BIGINT),
        CAST(TRUNC(SUM(procs_sum)/NULLIF(SUM(procs_samples),0)) AS BIGINT),
        CAST(TRUNC(SUM(zram_used_sum)/NULLIF(SUM(zram_used_samples),0)) AS BIGINT),
        CAST(TRUNC(SUM(swap_disk_used_sum)/NULLIF(SUM(swap_disk_used_samples),0)) AS BIGINT),
        CAST(TRUNC(SUM(swapfile_used_sum)/NULLIF(SUM(swapfile_used_samples),0)) AS BIGINT),
        CAST(TRUNC(SUM(swap_partition_used_sum)/NULLIF(SUM(swap_partition_used_samples),0)) AS BIGINT)
 FROM history GROUP BY ts//?3 ORDER BY 1";

/// One node's probe rows for a window, one row per sample.
///
/// Parameters: `?1` node id, `?2` window start, `?3` bucket width.
///
/// `//` rather than `/`: DuckDB's `/` is floating-point division, and a bucket
/// index that arrived as a float would make `bucket * step` a float too.
pub const PING_ROWS_SQL: &str = "WITH history AS (
 SELECT ts, task_id, latency, 1::BIGINT AS samples FROM ping_record WHERE node_id=?1 AND ts>=?2
 UNION ALL
 SELECT ts, task_id, latency, samples FROM ping_hour WHERE node_id=?1 AND ts>=?2
 ) SELECT ts//?3*?3, task_id, latency, CAST(SUM(samples) AS BIGINT) FROM history
 WHERE task_id IN (SELECT task_id FROM ping_node WHERE node_id=?1)
 GROUP BY 1,2,3 ORDER BY 1,2,3";

/// Hourly aggregation used by maintenance and the controlled storage experiment.
pub const ROLL_METRICS_SQL: &str = "INSERT INTO metric_hour
                 SELECT node_id, ts//3600*3600, COUNT(*), SUM(cpu), SUM(mem_used),
                        SUM(disk_used), SUM(net_rx), SUM(net_tx), SUM(tcp), COUNT(tcp), SUM(udp), COUNT(udp), SUM(procs), COUNT(procs), SUM(zram_used), COUNT(zram_used), SUM(swap_disk_used), COUNT(swap_disk_used), SUM(swapfile_used), COUNT(swapfile_used), SUM(swap_partition_used), COUNT(swap_partition_used)
                 FROM metric WHERE ts < ?1 AND ts >= ?2 GROUP BY node_id, ts//3600
                 ON CONFLICT (node_id,ts) DO UPDATE SET
                   samples=metric_hour.samples+excluded.samples, cpu_sum=metric_hour.cpu_sum+excluded.cpu_sum,
                   mem_sum=metric_hour.mem_sum+excluded.mem_sum, disk_sum=metric_hour.disk_sum+excluded.disk_sum,
                   rx_sum=metric_hour.rx_sum+excluded.rx_sum, tx_sum=metric_hour.tx_sum+excluded.tx_sum, tcp_sum=COALESCE(metric_hour.tcp_sum,0)+COALESCE(excluded.tcp_sum,0), tcp_samples=metric_hour.tcp_samples+excluded.tcp_samples, udp_sum=COALESCE(metric_hour.udp_sum,0)+COALESCE(excluded.udp_sum,0), udp_samples=metric_hour.udp_samples+excluded.udp_samples, procs_sum=COALESCE(metric_hour.procs_sum,0)+COALESCE(excluded.procs_sum,0), procs_samples=metric_hour.procs_samples+excluded.procs_samples, zram_used_sum=COALESCE(metric_hour.zram_used_sum,0)+COALESCE(excluded.zram_used_sum,0), zram_used_samples=metric_hour.zram_used_samples+excluded.zram_used_samples, swap_disk_used_sum=COALESCE(metric_hour.swap_disk_used_sum,0)+COALESCE(excluded.swap_disk_used_sum,0), swap_disk_used_samples=metric_hour.swap_disk_used_samples+excluded.swap_disk_used_samples, swapfile_used_sum=COALESCE(metric_hour.swapfile_used_sum,0)+COALESCE(excluded.swapfile_used_sum,0), swapfile_used_samples=metric_hour.swapfile_used_samples+excluded.swapfile_used_samples, swap_partition_used_sum=COALESCE(metric_hour.swap_partition_used_sum,0)+COALESCE(excluded.swap_partition_used_sum,0), swap_partition_used_samples=metric_hour.swap_partition_used_samples+excluded.swap_partition_used_samples";

/// Hourly aggregation used by maintenance and the controlled storage experiment.
pub const ROLL_PINGS_SQL: &str = "INSERT INTO ping_hour
                 SELECT node_id, ts//3600*3600, task_id, latency, COUNT(*)
                 FROM ping_record WHERE ts < ?1 AND ts >= ?2 GROUP BY node_id, ts//3600, task_id, latency
                 ON CONFLICT (node_id,ts,task_id,latency) DO UPDATE SET samples=ping_hour.samples+excluded.samples";
