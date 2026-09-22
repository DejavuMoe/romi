//! The native DuckDB schema and its versioning mechanism.
//!
//! Three different versions have to be kept apart:
//!
//! * **The application schema version** ([`SCHEMA_VERSION`]) is stored in the
//!   `romi_schema` row inside the database and advanced by [`migrate`].
//! * **The DuckDB engine version** is whatever `library_version()` reports. A
//!   build refuses to run against a different major/minor engine than the one it
//!   was compiled and tested with, because query semantics are not frozen across
//!   engine releases.
//! * **The DuckDB storage format version** belongs to the engine and is checked
//!   by DuckDB itself when the file is opened; a file written by a newer storage
//!   format is rejected by the engine before any of our code runs.

use anyhow::{Context, Result};
use duckdb::Connection;

/// Revision of the native DuckDB schema.
///
/// Increment it and add a `migrate_to_N` step when a database already in service
/// has to change shape.
pub const SCHEMA_VERSION: i64 = 3;

/// Every application table, including runtime state. Used by diagnostics and
/// schema initialization.
pub const TABLES: [&str; 10] = [
    "setting",
    "node",
    "traffic",
    "metric",
    "metric_hour",
    "ping_task",
    "ping_node",
    "ping_record",
    "ping_hour",
    "session",
];

/// Tables a backup carries and a restore rebuilds. Sessions are runtime/security
/// state, never durable user data: a restored database always starts with an
/// empty `session` table, so restoring cannot revive a login that was revoked
/// after the archive was taken.
pub const BACKUP_TABLES: [&str; 9] = [
    "setting",
    "node",
    "traffic",
    "metric",
    "metric_hour",
    "ping_task",
    "ping_node",
    "ping_record",
    "ping_hour",
];

/// The engine release this build was compiled and tested against.
///
/// Read from `library_version()` rather than assumed from the crate version:
/// crate `1.10505.0` vendors engine `v1.5.5`, and the two numbering schemes are
/// deliberately independent.
pub const ENGINE_VERSION: &str = "v1.5.5";

/// Tables that carry an allocated (rather than imported) identity.
pub const ID_SOURCES: [&str; 2] = ["node", "ping_task"];

/// DDL, applied in one transaction to a database that has no `romi_schema` row.
///
/// Written for DuckDB's own type system:
///
/// * `BIGINT` for every column the application reads as `i64` -- identifiers,
///   byte counters, unix timestamps. `INTEGER` is 32-bit in DuckDB and would
///   silently truncate a lifetime counter or a post-2038 timestamp.
/// * `DOUBLE` for the columns that carry `f64` precision (`node.price`, and the
///   averaged `metric.cpu`).
/// * `BOOLEAN` for `node.public` and `node.notify`, so the API reads a real
///   boolean instead of converting an integer on the way out.
/// * A `PRIMARY KEY` becomes an ART index, which is what makes `metric` and
///   `ping_record` reject duplicates.
/// * No `ON DELETE CASCADE`: DuckDB's parser rejects it outright, and its
///   foreign-key check does not observe child deletes made earlier in the same
///   transaction. Relationships are therefore enforced by the application inside
///   one transaction -- see `Db::delete_node`, `Db::delete_ping_task` and
///   `Db::save_ping_task`, and `deleting_a_node_takes_its_data_with_it`.
/// * No foreign keys at all. A declaration that cannot cascade turns every
///   delete into a two-transaction dance, and DuckDB's own error message points
///   at its foreign key limitations; the application-level checks below are
///   tested to leave no orphan behind.
const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS setting (
  key   VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);

-- Identity allocation. A table rather than a CREATE SEQUENCE because DuckDB has
-- no `setval`: a sequence cannot be advanced past the highest id a restore
-- brought in, and `nextval` would then hand out ids that already exist.
-- `UPDATE ... RETURNING` is atomic, and it runs inside the writer's transaction,
-- so two allocations can never collide. `next` is the next id to hand out.
CREATE TABLE IF NOT EXISTS romi_id (
  name VARCHAR PRIMARY KEY,
  next BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  id            BIGINT PRIMARY KEY,
  name          VARCHAR NOT NULL,
  -- Only a SHA-256 digest of a high-entropy agent credential.
  token_hash    VARCHAR NOT NULL UNIQUE,
  sort          BIGINT  NOT NULL DEFAULT 0,
  public        BOOLEAN NOT NULL DEFAULT false,
  price         DOUBLE  NOT NULL DEFAULT 0,
  currency      VARCHAR NOT NULL DEFAULT 'USD',
  billing_cycle VARCHAR NOT NULL DEFAULT 'monthly',
  -- Nullable: absent is "no expiry date", which is not the same as an empty
  -- string, and the panel clears it with an explicit null.
  expires_at    VARCHAR,
  remark        VARCHAR NOT NULL DEFAULT '',
  traffic_limit BIGINT  NOT NULL DEFAULT 0,
  traffic_mode  VARCHAR NOT NULL DEFAULT 'sum',
  traffic_reset_day BIGINT NOT NULL DEFAULT 1,
  hostname VARCHAR NOT NULL DEFAULT '', os VARCHAR NOT NULL DEFAULT '',
  kernel   VARCHAR NOT NULL DEFAULT '', arch VARCHAR NOT NULL DEFAULT '',
  virt     VARCHAR NOT NULL DEFAULT '', cpu_name VARCHAR NOT NULL DEFAULT '',
  cpu_cores BIGINT NOT NULL DEFAULT 0, mem_total BIGINT NOT NULL DEFAULT 0,
  swap_total BIGINT NOT NULL DEFAULT 0, disk_total BIGINT NOT NULL DEFAULT 0,
  agent_version VARCHAR NOT NULL DEFAULT '', ip VARCHAR NOT NULL DEFAULT '',
  ipv4 VARCHAR NOT NULL DEFAULT '', ipv6 VARCHAR NOT NULL DEFAULT '',
  -- ISO 3166-1 alpha-2, looked up from `ip` once per address; empty until the
  -- lookup answers.
  country VARCHAR NOT NULL DEFAULT '',
  last_seen BIGINT NOT NULL DEFAULT 0,
  notify BOOLEAN NOT NULL DEFAULT false,
  down_since BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  priority BIGINT NOT NULL DEFAULT 0,
  traffic_unit VARCHAR NOT NULL DEFAULT 'GB',
  bandwidth_up DOUBLE NOT NULL DEFAULT 0, bandwidth_down DOUBLE NOT NULL DEFAULT 0,
  has_ipv4 BOOLEAN NOT NULL DEFAULT true, has_ipv6 BOOLEAN NOT NULL DEFAULT false,
  online_since BIGINT NOT NULL DEFAULT 0
);

-- Monotonic byte counters that survive both agent reboots and hub restarts.
CREATE TABLE IF NOT EXISTS traffic (
  node_id  BIGINT PRIMARY KEY,
  boot_id  VARCHAR NOT NULL DEFAULT '',
  last_rx  BIGINT NOT NULL DEFAULT 0,
  last_tx  BIGINT NOT NULL DEFAULT 0,
  total_rx BIGINT NOT NULL DEFAULT 0,
  total_tx BIGINT NOT NULL DEFAULT 0,
  month_rx BIGINT NOT NULL DEFAULT 0,
  month_tx BIGINT NOT NULL DEFAULT 0,
  month_start VARCHAR NOT NULL DEFAULT '',
  day_rx   BIGINT NOT NULL DEFAULT 0,
  day_tx   BIGINT NOT NULL DEFAULT 0,
  day_start VARCHAR NOT NULL DEFAULT ''
);

-- One row per node per minute. The primary key is the deduplication rule the
-- ingest path relies on: a report landing on a minute already written replaces
-- that minute instead of adding a second row.
CREATE TABLE IF NOT EXISTS metric (
  node_id BIGINT NOT NULL,
  ts      BIGINT NOT NULL,
  cpu     DOUBLE NOT NULL,
  mem_used BIGINT NOT NULL, swap_used BIGINT NOT NULL, disk_used BIGINT NOT NULL,
  net_rx BIGINT NOT NULL, net_tx BIGINT NOT NULL,
  tcp BIGINT NOT NULL, udp BIGINT NOT NULL, procs BIGINT NOT NULL,
  zram_used BIGINT, swap_disk_used BIGINT, swapfile_used BIGINT, swap_partition_used BIGINT,
  PRIMARY KEY (node_id, ts)
);

CREATE TABLE IF NOT EXISTS ping_task (
  id       BIGINT PRIMARY KEY,
  name     VARCHAR NOT NULL,
  target   VARCHAR NOT NULL,
  interval BIGINT NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS ping_node (
  task_id BIGINT NOT NULL,
  node_id BIGINT NOT NULL,
  PRIMARY KEY (task_id, node_id)
);

-- Key order follows the only query there is: one node, one time window, every
-- probe. Launching the key at `node_id` lets the chart seek to the node and then
-- read its window in time order, which is what allows the fold in
-- `Db::ping_records` to hold one bucket at a time.
CREATE TABLE IF NOT EXISTS ping_record (
  node_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
  ts BIGINT NOT NULL, latency BIGINT NOT NULL,
  PRIMARY KEY (node_id, ts, task_id)
);

CREATE TABLE IF NOT EXISTS session (
  token_hash VARCHAR PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

-- Weighted aggregates preserve the contribution of partially populated hours.
CREATE TABLE IF NOT EXISTS metric_hour (
  node_id BIGINT NOT NULL, ts BIGINT NOT NULL,
  samples BIGINT NOT NULL CHECK (samples > 0),
  cpu_sum DOUBLE NOT NULL,
  -- Parquet preserves DECIMAL(38,0) exactly; HUGEINT would export as DOUBLE.
  mem_sum DECIMAL(38,0) NOT NULL, disk_sum DECIMAL(38,0) NOT NULL,
  rx_sum DECIMAL(38,0) NOT NULL, tx_sum DECIMAL(38,0) NOT NULL,
  tcp_sum DECIMAL(38,0), tcp_samples BIGINT NOT NULL DEFAULT 0,
  udp_sum DECIMAL(38,0), udp_samples BIGINT NOT NULL DEFAULT 0,
  procs_sum DECIMAL(38,0), procs_samples BIGINT NOT NULL DEFAULT 0,
  zram_used_sum DECIMAL(38,0), zram_used_samples BIGINT NOT NULL DEFAULT 0,
  swap_disk_used_sum DECIMAL(38,0), swap_disk_used_samples BIGINT NOT NULL DEFAULT 0,
  swapfile_used_sum DECIMAL(38,0), swapfile_used_samples BIGINT NOT NULL DEFAULT 0,
  swap_partition_used_sum DECIMAL(38,0), swap_partition_used_samples BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, ts)
);

-- Exact integer-latency histogram per hour. Keeping counts, rather than a
-- median of medians, preserves medians, min/max and weighted loss after rollup.
CREATE TABLE IF NOT EXISTS ping_hour (
  node_id BIGINT NOT NULL, ts BIGINT NOT NULL, task_id BIGINT NOT NULL,
  latency BIGINT NOT NULL, samples BIGINT NOT NULL CHECK (samples > 0),
  PRIMARY KEY (node_id, ts, task_id, latency)
);

-- Application schema metadata, one row. Separate from the DuckDB engine version
-- and from the engine's storage format version, both of which the engine owns.
CREATE TABLE IF NOT EXISTS romi_schema (
  id         BIGINT PRIMARY KEY,
  version    BIGINT NOT NULL,
  engine     VARCHAR NOT NULL,
  written_by VARCHAR NOT NULL,
  updated_at BIGINT NOT NULL
);
"#;

/// True when `table` exists in the main schema of the attached database.
pub fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='main' AND table_name=?1",
        [table],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// How many tables the main schema holds. Zero means a file the engine has just
/// created, which is the only case that may be initialized from scratch: a file
/// with *other* tables and no `romi_schema` row is somebody else's database.
pub fn user_tables(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM information_schema.tables
         WHERE table_schema='main' AND table_catalog=current_database()",
        [],
        |r| r.get(0),
    )?)
}

/// The stored application schema version, or `None` when this file has no
/// `romi_schema` row (a fresh file, or not a romi database at all).
pub fn stored_version(conn: &Connection) -> Result<Option<i64>> {
    if !table_exists(conn, "romi_schema")? {
        return Ok(None);
    }
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM romi_schema", [], |r| r.get(0))?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.query_row("SELECT version FROM romi_schema WHERE id=1", [], |r| r.get(0))?))
}

/// The engine release serving this connection, from the engine itself.
pub fn engine_version(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT library_version FROM pragma_version()", [], |r| r.get(0))?)
}

/// Brings an empty database to [`SCHEMA_VERSION`], or advances one already in
/// service. Runs in a single transaction: a failure leaves the file exactly as it
/// was, which is what lets a restore build a candidate and discard it.
///
/// `fresh` is true only when the database holds no tables at all, which is how a
/// brand-new file receives the current schema directly rather than the history of
/// how it was reached.
pub fn initialize(conn: &mut Connection, fresh: bool, written_by: &str) -> Result<()> {
    initialize_with_ddl(conn, fresh, written_by, DDL)
}

/// Creates the same schema as [`initialize`], but leaves the primary keys off
/// `metric` and `ping_record`.
///
/// Restore uses this because DuckDB maintains a primary-key ART index
/// incrementally during `INSERT`; on a medium/large history that index
/// maintenance exceeded a 512 MB `memory_limit` before the row count was even
/// validated. Loading the bulk tables first and adding their keys with
/// [`add_large_table_keys`] afterwards keeps the staging build bounded while
/// producing the same final schema.
pub fn initialize_staging(conn: &mut Connection, written_by: &str) -> Result<()> {
    let ddl = DDL
        .replace(",\n  PRIMARY KEY (node_id, ts)", "")
        .replace(",\n  PRIMARY KEY (node_id, ts, task_id)", "")
        .replace(",\n  PRIMARY KEY (node_id, ts, task_id, latency)", "");
    anyhow::ensure!(
        !ddl.contains("PRIMARY KEY (node_id, ts)") && !ddl.contains("PRIMARY KEY (node_id, ts, task_id)"),
        "staging DDL did not defer the large-table primary keys"
    );
    initialize_with_ddl(conn, true, written_by, &ddl)
}

/// Adds the keys [`initialize_staging`] deferred, after the bulk rows exist.
///
/// DuckDB supports `ALTER TABLE ... ADD PRIMARY KEY` and builds the ART index
/// after the load. A duplicate row in an archive makes this fail, which is the
/// correct outcome: a backup that cannot satisfy the product's own uniqueness
/// rules must not become the live database.
pub fn add_large_table_keys(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "ALTER TABLE metric ADD PRIMARY KEY (node_id, ts);
         ALTER TABLE metric_hour ADD PRIMARY KEY (node_id, ts);
         ALTER TABLE ping_record ADD PRIMARY KEY (node_id, ts, task_id);
         ALTER TABLE ping_hour ADD PRIMARY KEY (node_id, ts, task_id, latency);",
    )
    .context("adding the large history primary keys to the staging database")?;
    Ok(())
}

fn initialize_with_ddl(conn: &mut Connection, fresh: bool, written_by: &str, ddl: &str) -> Result<()> {
    let from = stored_version(conn)?;
    if let Some(v) = from {
        anyhow::ensure!(
            v <= SCHEMA_VERSION,
            "数据库 schema 版本为 {v}，高于本服务支持的 {SCHEMA_VERSION}；请先升级 romi"
        );
    } else if !fresh {
        // Tables but no version row: a DuckDB file this application did not
        // write. Refused rather than adopted, because every statement that
        // follows assumes column names and types it cannot verify here -- and
        // adopting it would mean writing our schema into somebody else's file.
        anyhow::bail!(
            "这不是 romi 的 DuckDB 数据库：文件里已经有 {} 张表，却没有 romi_schema 版本记录；             请换一个空的 --db 路径",
            user_tables(conn)?
        );
    }
    let tx = conn.transaction()?;
    tx.execute_batch(ddl).context("creating the romi DuckDB schema")?;
    for name in ID_SOURCES {
        // 1 is the first id this build hands out; an import or a restore moves it.
        tx.execute("INSERT INTO romi_id (name, next) VALUES (?1, 1) ON CONFLICT (name) DO NOTHING", [name])?;
    }
    let from = from.unwrap_or(SCHEMA_VERSION);
    if from < SCHEMA_VERSION {
        migrate(&tx, from)?;
    }
    stamp(&tx, written_by)?;
    tx.commit()?;
    Ok(())
}

/// Writes the current version and the engine that wrote it.
fn stamp(conn: &Connection, written_by: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO romi_schema (id, version, engine, written_by, updated_at) VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET version=excluded.version, engine=excluded.engine,
             written_by=excluded.written_by, updated_at=excluded.updated_at",
        duckdb::params![SCHEMA_VERSION, ENGINE_VERSION, written_by, chrono::Utc::now().timestamp()],
    )?;
    Ok(())
}

/// Applies every step between `from` and [`SCHEMA_VERSION`].
///
/// Steps run in ascending order on a version that predates them, and each one is
/// written to be harmless if the shape it expects is already there -- a database
/// an operator restored from a backup taken mid-upgrade must not be left
/// unusable.
fn migrate(conn: &Connection, from: i64) -> Result<()> {
    anyhow::ensure!(from <= SCHEMA_VERSION, "database schema is newer than this server");
    // Version 2 adds the empty hourly tables through the idempotent DDL above.
    if from < 3 {
        conn.execute_batch("ALTER TABLE node ADD COLUMN IF NOT EXISTS traffic_unit VARCHAR DEFAULT 'GB';
ALTER TABLE node ADD COLUMN IF NOT EXISTS priority BIGINT DEFAULT 0;
ALTER TABLE node ADD COLUMN IF NOT EXISTS bandwidth_up DOUBLE DEFAULT 0;
ALTER TABLE node ADD COLUMN IF NOT EXISTS bandwidth_down DOUBLE DEFAULT 0;
ALTER TABLE node ADD COLUMN IF NOT EXISTS has_ipv4 BOOLEAN DEFAULT true;
ALTER TABLE node ADD COLUMN IF NOT EXISTS has_ipv6 BOOLEAN DEFAULT false;
ALTER TABLE node ADD COLUMN IF NOT EXISTS online_since BIGINT DEFAULT 0;
ALTER TABLE metric ADD COLUMN IF NOT EXISTS zram_used BIGINT;
ALTER TABLE metric ADD COLUMN IF NOT EXISTS swap_disk_used BIGINT;
ALTER TABLE metric ADD COLUMN IF NOT EXISTS swapfile_used BIGINT;
ALTER TABLE metric ADD COLUMN IF NOT EXISTS swap_partition_used BIGINT;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS tcp_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS tcp_samples BIGINT DEFAULT 0;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS udp_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS udp_samples BIGINT DEFAULT 0;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS procs_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS procs_samples BIGINT DEFAULT 0;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS zram_used_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS zram_used_samples BIGINT DEFAULT 0;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS swap_disk_used_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS swap_disk_used_samples BIGINT DEFAULT 0;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS swapfile_used_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS swapfile_used_samples BIGINT DEFAULT 0;
ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS swap_partition_used_sum DECIMAL(38,0); ALTER TABLE metric_hour ADD COLUMN IF NOT EXISTS swap_partition_used_samples BIGINT DEFAULT 0;")?;
    }
    Ok(())
}

/// Moves an identity source past every id a restore brought in.
///
/// Called with the highest id present in `table`; the next allocation is that
/// plus one. `MAX` over an empty table is NULL, which leaves the counter at 1.
pub fn resync_ids(conn: &Connection) -> Result<()> {
    for name in ID_SOURCES {
        conn.execute(
            &format!(
                "UPDATE romi_id SET next = COALESCE((SELECT MAX(id) FROM {name}), 0) + 1 WHERE name = ?1"
            ),
            [name],
        )?;
    }
    Ok(())
}
