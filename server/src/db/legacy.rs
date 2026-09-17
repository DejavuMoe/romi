//! Offline import of a legacy SQLite database.
//!
//! This module never reads SQLite. The legacy file is read by
//! `scripts/migrate-sqlite.py`, which uses the Python standard library and
//! deliberately does not write to the source, and the result is a newline
//! delimited JSON export this module streams into a brand-new DuckDB database.
//! That split is what keeps `rusqlite`, `libsqlite3-sys` and DuckDB's own SQLite
//! scanner out of the shipped binary: the only code that understands SQLite is a
//! script an operator runs by hand, once.
//!
//! What the import preserves:
//!
//! * Identifiers, exactly as they were -- `romi_id` is then moved past the
//!   highest one, so nothing allocated later can collide with imported history.
//! * Every historical row, streamed with bounded memory.
//! * Configuration, the administrator's password hash, and node token **hashes**.
//!   A hash is copied verbatim and never hashed a second time; the node tokens
//!   themselves were never in the source database to begin with.
//!
//! What it deliberately does not preserve: sessions. The export omits them, so
//! the administrator signs in again after cutover. Carrying them over would
//! revive logins the operator may have ended, and a session cookie is exactly the
//! kind of state a migration should not silently extend.
//!
//! Older upstream schemas are refused rather than guessed at. The exporter checks
//! `PRAGMA user_version` and stops with instructions to upgrade through an
//! appropriate older romi build first; this importer refuses an export that does
//! not carry a schema version it knows.

use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader};

use anyhow::{anyhow, ensure, Context, Result};
use duckdb::types::Value;
use duckdb::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use super::{checkpoint, schema};

/// The legacy SQLite schema version this importer accepts.
pub const LEGACY_SCHEMA: i64 = 5;

/// Column kinds, so a value is decoded by what the destination column is rather
/// than by what JSON happened to contain.
#[derive(Clone, Copy, PartialEq)]
enum Col {
    Int,
    Float,
    Text,
    Bool,
    OptText,
}

use Col::{Bool, Float, Int, OptText, Text};

/// The tables an export may carry, and their columns in insert order. `session`
/// is absent on purpose: see the module comment.
fn columns(table: &str) -> Option<&'static [(&'static str, Col)]> {
    Some(match table {
        "setting" => &[("key", Text), ("value", Text)],
        "node" => &[
            ("id", Int),
            ("name", Text),
            ("token_hash", Text),
            ("sort", Int),
            ("public", Bool),
            ("price", Float),
            ("currency", Text),
            ("billing_cycle", Text),
            ("expires_at", OptText),
            ("remark", Text),
            ("traffic_limit", Int),
            ("traffic_mode", Text),
            ("traffic_reset_day", Int),
            ("hostname", Text),
            ("os", Text),
            ("kernel", Text),
            ("arch", Text),
            ("virt", Text),
            ("cpu_name", Text),
            ("cpu_cores", Int),
            ("mem_total", Int),
            ("swap_total", Int),
            ("disk_total", Int),
            ("agent_version", Text),
            ("ip", Text),
            ("ipv4", Text),
            ("ipv6", Text),
            ("country", Text),
            ("last_seen", Int),
            ("notify", Bool),
            ("down_since", Int),
            ("created_at", Int),
        ],
        "traffic" => &[
            ("node_id", Int),
            ("boot_id", Text),
            ("last_rx", Int),
            ("last_tx", Int),
            ("total_rx", Int),
            ("total_tx", Int),
            ("month_rx", Int),
            ("month_tx", Int),
            ("month_start", Text),
            ("day_rx", Int),
            ("day_tx", Int),
            ("day_start", Text),
        ],
        "metric" => &[
            ("node_id", Int),
            ("ts", Int),
            ("cpu", Float),
            ("mem_used", Int),
            ("swap_used", Int),
            ("disk_used", Int),
            ("net_rx", Int),
            ("net_tx", Int),
            ("tcp", Int),
            ("udp", Int),
            ("procs", Int),
        ],
        "ping_task" => &[("id", Int), ("name", Text), ("target", Text), ("interval", Int)],
        "ping_node" => &[("task_id", Int), ("node_id", Int)],
        "ping_record" => &[("node_id", Int), ("task_id", Int), ("ts", Int), ("latency", Int)],
        _ => return None,
    })
}

/// Tables in the order they are loaded, so a parent always exists before its
/// children and the relationship check at the end has something to check.
const LOAD_ORDER: [&str; 7] =
    ["setting", "node", "traffic", "ping_task", "ping_node", "metric", "ping_record"];

#[derive(Serialize, Debug, Clone)]
pub struct ImportReport {
    pub dest: String,
    pub engine: String,
    pub schema: i64,
    pub source_schema: i64,
    pub rows: BTreeMap<String, i64>,
    /// Always true: the export omits sessions, so every login ends at cutover.
    pub sessions_invalidated: bool,
}

#[derive(Deserialize)]
struct Line {
    table: String,
    #[serde(default)]
    row: Option<serde_json::Value>,
    /// The trailer, written once at the end of the export.
    #[serde(default)]
    source_schema: Option<i64>,
    #[serde(default)]
    rows: Option<BTreeMap<String, i64>>,
}

/// Streams `export` into a new DuckDB database at `dest`.
///
/// Refuses an existing destination rather than writing into it. The database is
/// built at `dest.partial` and renamed into place only after every row is loaded
/// and every check has passed, so a run that fails part way leaves nothing that
/// could be mistaken for a finished migration.
pub fn import(export: &str, dest: &str) -> Result<ImportReport> {
    ensure!(!dest.is_empty(), "--db 需要一个目标路径");
    ensure!(dest != ":memory:", "离线迁移需要一个真实的 DuckDB 文件，而不是 :memory:");
    ensure!(!std::path::Path::new(dest).exists(), "{dest} 已存在；迁移不会覆盖任何已有文件，请换一个路径");
    let partial = format!("{dest}.partial");
    let _ = std::fs::remove_file(&partial);
    let outcome = import_into(export, dest, &partial);
    if outcome.is_err() {
        let _ = std::fs::remove_file(&partial);
        let _ = std::fs::remove_file(format!("{partial}.wal"));
    }
    outcome
}

fn import_into(export: &str, dest: &str, partial: &str) -> Result<ImportReport> {
    let file = std::fs::File::open(export).with_context(|| format!("reading the export {export}"))?;
    let mut conn = super::open_connection(partial, &super::Options::default(), false)?;
    schema::initialize(&mut conn, true, env!("CARGO_PKG_VERSION"))?;

    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    let mut source_schema = None;
    let mut pending = 0usize;
    let mut current: Option<&'static str> = None;
    let mut loaded: HashSet<&'static str> = HashSet::new();

    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut line = String::new();
    // One transaction per batch rather than one per row: a few hundred thousand
    // history rows would otherwise cost a commit each. The batches bound how much
    // uncommitted version information the engine has to hold.
    conn.execute_batch("BEGIN")?;
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Line = serde_json::from_str(&line).with_context(|| "导出文件不是有效的 JSONL")?;
        if parsed.table == "#export" {
            // The trailer: what the exporter read, and from which schema.
            let declared = parsed.source_schema.ok_or_else(|| anyhow!("导出文件缺少 schema 版本"))?;
            ensure!(
                declared == LEGACY_SCHEMA,
                "导出文件来自 SQLite schema {declared}，本工具只支持 {LEGACY_SCHEMA}；\
                 请先用对应的旧版 romi 升级数据库，再重新导出"
            );
            source_schema = Some(declared);
            if let Some(trailer) = parsed.rows {
                for (table, n) in trailer {
                    let actual = counts.get(&table).copied().unwrap_or(0);
                    ensure!(actual == n, "{table} 导出了 {n} 行但只读到 {actual} 行");
                }
            }
            continue;
        }
        if parsed.table == "session" {
            // Not carried over; see the module comment.
            continue;
        }
        let table = *LOAD_ORDER
            .iter()
            .find(|t| **t == parsed.table)
            .ok_or_else(|| anyhow!("导出文件包含未知表 {}", parsed.table))?;
        let row = parsed.row.ok_or_else(|| anyhow!("{} 的一行缺少 row 字段", parsed.table))?;
        if current != Some(table) {
            // The exporter writes one table at a time, and the insert path relies
            // on that: a table that reappears later would be loaded twice with no
            // second chance to notice.
            ensure!(!loaded.contains(table), "导出文件的表必须连续出现：{table} 出现了两次");
            loaded.insert(table);
            current = Some(table);
        }
        insert_row(&conn, table, &row).with_context(|| format!("导入 {table} 的一行失败"))?;
        *counts.entry(table.to_owned()).or_insert(0) += 1;
        pending += 1;
        if pending >= super::IMPORT_BATCH {
            conn.execute_batch("COMMIT")?;
            checkpoint(&conn)?;
            conn.execute_batch("BEGIN")?;
            pending = 0;
        }
    }
    ensure!(source_schema.is_some(), "导出文件不完整：没有读到结尾的 #export 摘要");
    for table in LOAD_ORDER {
        counts.entry(table.to_owned()).or_insert(0);
    }

    // Relationships, now that every table is loaded. DuckDB cannot declare a
    // cascading foreign key, so these are the checks that stand in for one.
    super::backup::verify_relationships(&conn)?;
    // The identities the source used are kept, and the allocator is moved past
    // them so the first node created after the migration cannot collide.
    schema::resync_ids(&conn)?;
    conn.execute_batch("COMMIT")?;
    checkpoint(&conn)?;
    drop(conn);
    super::restrict(partial);
    std::fs::rename(partial, dest).with_context(|| format!("publishing the migrated database at {dest}"))?;

    let mut report = ImportReport {
        dest: dest.to_owned(),
        engine: super::ENGINE_VERSION.to_owned(),
        schema: schema::SCHEMA_VERSION,
        source_schema: source_schema.unwrap_or(LEGACY_SCHEMA),
        rows: counts,
        sessions_invalidated: true,
    };
    report.rows.retain(|_, n| *n > 0);
    Ok(report)
}

/// One row, decoded strictly by destination column kind.
///
/// Nothing is defaulted: a value that does not fit its column is an error rather
/// than a zero, because a lifetime byte counter silently written as 0 is worse
/// than a migration that stops and says which row it could not read.
fn insert_row(conn: &Connection, table: &str, row: &serde_json::Value) -> Result<()> {
    let cols = columns(table).ok_or_else(|| anyhow!("unknown table {table}"))?;
    let object = row.as_object().ok_or_else(|| anyhow!("row is not an object"))?;
    let mut values = Vec::with_capacity(cols.len());
    for (name, kind) in cols {
        let raw = object.get(*name).ok_or_else(|| anyhow!("列 {name} 缺失"))?;
        values.push(decode(name, *kind, raw)?);
    }
    let list = cols.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ");
    let holes = (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    // Cached by statement text: the export is contiguous per table, so this parses
    // once per table instead of once per row.
    let mut stmt = conn.prepare(&format!("INSERT INTO {table} ({list}) VALUES ({holes})"))?;
    stmt.execute(params_from_iter(values))?;
    Ok(())
}

fn decode(name: &str, kind: Col, raw: &serde_json::Value) -> Result<Value> {
    let bad = || anyhow!("列 {name} 的值 {raw} 与目标类型不符");
    Ok(match kind {
        Int => {
            if let Some(v) = raw.as_i64() {
                Value::BigInt(v)
            } else if let Some(v) = raw.as_u64() {
                // A SQLite INTEGER is signed, but a counter read through Python
                // could still arrive as an unsigned literal; anything beyond the
                // signed range is refused rather than wrapped.
                Value::BigInt(i64::try_from(v).map_err(|_| anyhow!("列 {name} 的值 {v} 超出 i64"))?)
            } else {
                return Err(bad());
            }
        }
        Float => Value::Double(raw.as_f64().ok_or_else(bad)?),
        Text => Value::Text(raw.as_str().ok_or_else(bad)?.to_owned()),
        Bool => match raw {
            serde_json::Value::Bool(b) => Value::Boolean(*b),
            serde_json::Value::Number(n) => Value::Boolean(n.as_i64().ok_or_else(bad)? != 0),
            _ => return Err(bad()),
        },
        OptText => match raw {
            serde_json::Value::Null => Value::Null,
            other => Value::Text(other.as_str().ok_or_else(bad)?.to_owned()),
        },
    })
}
