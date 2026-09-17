//! Backup, restore and compaction.
//!
//! # Format
//!
//! A backup is a gzipped tar holding one Parquet file per **persistent** table
//! plus a `manifest.json` that records the application schema version, the engine
//! that wrote it, and each member's row count and SHA-256.
//!
//! Sessions are deliberately absent. They are runtime/security state, not user
//! data: restoring must never revive a login that the operator revoked after the
//! archive was taken. A restored database creates an empty `session` table from
//! the current schema, and backup/restore transforms never touch login state
//! after activation.
//!
//! It is deliberately **not** a copy of the DuckDB file:
//!
//! * A live DuckDB file is only consistent together with its write-ahead log, so
//!   copying the file alone would silently drop the most recent commits.
//! * A restored database file would bring its own catalogue with it. An uploaded
//!   archive could then carry a view, a macro, or a table with a different shape,
//!   and every statement this hub issues afterwards would run against it.
//!
//! Restoring therefore reads the archive as *data*, into a schema this build
//! creates for itself, and never executes anything the archive contains.
//!
//! # Backup snapshot
//!
//! An export runs on a pooled reader inside one DuckDB read transaction, so every
//! table is read from the same MVCC snapshot. It is a normal read: the writer
//! keeps committing telemetry, queued writes are neither drained nor refused, the
//! database generation is not advanced, and no connected agent is disturbed. The
//! only barrier involved is the read side of the file-replacement gate, which
//! keeps the database file from being renamed underneath the transaction.
//!
//! # Restore ordering
//!
//! 1. The archive is validated member by member (paths, counts, sizes, digests,
//!    types) without reading a large member into memory.
//! 2. A complete new database is built in a scratch file: every persistent table
//!    is imported, the session table is forced empty, and row counts, column
//!    names/types and referential integrity are checked.
//! 3. The staging database is checkpointed and closed.
//! 4. Only then is the live file replaced, under the replacement barrier: readers
//!    stopped, writer's connection closed, original renamed aside, new file
//!    renamed into place and reopened.
//! 5. If step 4 fails at any point the original is renamed back and reopened, and
//!    the failure is reported. Once activation has reopened the new file, no
//!    further database mutation is required and nothing that can materially fail
//!    remains.
//!
//! # Archive limits
//!
//! The validator enforces all four resource dimensions explicitly: the compressed
//! upload size, the number of members, the expanded size of each member, and the
//! total expanded size. Members are streamed through a fixed 64 KiB buffer. An
//! archive built by this build has seven Parquet members plus the manifest, so
//! conservative limits reject a compression bomb, several individually valid
//! large members, or an archive with excessive member count before a staging
//! database is built.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64};
use std::sync::Arc;

use anyhow::{anyhow, ensure, Context, Result};
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use super::{
    checkpoint, open_connection, own_only, restrict, schema, Exclusive, Inner, ReaderPool, BACKUP_TABLES,
    MAX_ARCHIVE,
};

/// Bumped when the layout of the archive itself changes. Version 2 excludes the
/// `session` table; version 1 archives are not accepted.
const BACKUP_FORMAT: i64 = 2;
const KIND: &str = "romi-duckdb-backup";

/// The manifest is the only member held in memory; its size is bounded twice
/// (declared tar size and bytes actually read).
const MAX_MANIFEST: u64 = 1024 * 1024;
/// One Parquet member may not exceed this once expanded.
const MAX_MEMBER: u64 = 256 * 1024 * 1024;
/// Total expanded size across every member, including the manifest.
const MAX_TOTAL_EXPANDED: u64 = 1024 * 1024 * 1024;
/// Maximum member count. The format needs exactly `BACKUP_TABLES + manifest`;
/// a little headroom keeps the constant stable as tables are added.
const MAX_MEMBERS: usize = BACKUP_TABLES.len() + 1;

/// Every resource limit the archive validator applies. Tests lower these to
/// exercise each refusal with small fixtures instead of multi-megabyte archives.
#[derive(Clone, Copy, Debug)]
pub(super) struct ArchiveLimits {
    pub compressed: u64,
    pub members: usize,
    pub member: u64,
    pub total: u64,
    pub manifest: u64,
}

pub(super) const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = ArchiveLimits {
    compressed: MAX_ARCHIVE,
    members: MAX_MEMBERS,
    member: MAX_MEMBER,
    total: MAX_TOTAL_EXPANDED,
    manifest: MAX_MANIFEST,
};

/// Injected failure point for the backup transaction test: when it equals the
/// number of tables already exported, the next export fails. Test-only.
#[cfg(test)]
pub(super) static FAIL_AFTER_EXPORT: AtomicI64 = AtomicI64::new(-1);
/// Holds an in-progress snapshot after the first table, so a test can mutate the
/// live database and prove the remaining tables still read one snapshot.
/// Test-only.
#[cfg(test)]
pub(super) static TEST_BACKUP_HOLD_NANOS: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
pub(super) static TEST_BACKUP_ACTIVE: AtomicBool = AtomicBool::new(false);

/// What a backup holds. Returned to the panel after a backup or a restore, and
/// used by `check_backup`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupReport {
    pub format: i64,
    pub kind: String,
    pub schema: i64,
    pub engine: String,
    pub created_at: i64,
    pub bytes: u64,
    pub rows: BTreeMap<String, i64>,
}

impl BackupReport {
    pub fn total_rows(&self) -> i64 {
        self.rows.values().sum()
    }
}

/// What one maintenance run did.
#[derive(Serialize, Debug, Clone, Default)]
pub struct MaintenanceReport {
    /// Rows removed by retention.
    pub pruned: usize,
    /// Bytes actually returned to the filesystem, measured before and after.
    pub freed: i64,
    /// Bytes DuckDB reports as reusable inside the file.
    pub reusable: i64,
    /// Whether the file was rewritten. A checkpoint alone cannot shrink it.
    pub compacted: bool,
    /// Size on disk afterwards, main file plus log.
    pub size: i64,
    /// The connection generation after the operation.
    pub generation: u64,
}

/// The checkpoint/measurement half of maintenance, produced on the writer
/// connection without taking the replacement barrier. `rewrite` says whether a
/// second, replacing step is worth taking.
pub(super) struct MaintenancePlan {
    pub report: MaintenanceReport,
    pub rewrite: bool,
    checkpointed: i64,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: i64,
    kind: String,
    schema: i64,
    engine: String,
    created_at: i64,
    tables: BTreeMap<String, Member>,
}

#[derive(Serialize, Deserialize)]
struct Member {
    rows: i64,
    sha256: String,
    bytes: u64,
}

// ---- backup ----

/// Writes `dest` from the live database. The caller runs this on a reader
/// connection inside the read side of the replacement gate, so the rows it
/// copies are one consistent MVCC snapshot and the file cannot be renamed
/// underneath it.
pub(super) fn write_archive(conn: &Connection, dest: &str) -> Result<BackupReport> {
    let work = scratch_dir(dest, "backup")?;
    let outcome = write_archive_inner(conn, dest, &work);
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

fn write_archive_inner(conn: &Connection, dest: &str, work: &str) -> Result<BackupReport> {
    // One snapshot for every table: without the transaction each COPY would see
    // whatever had been committed by the time it started. `Transaction` rolls
    // back on drop, so an error in the middle leaves this connection clean and
    // immediately reusable for normal reads.
    let tx = conn.unchecked_transaction().context("starting the backup read transaction")?;
    let mut members = BTreeMap::new();
    let mut rows = BTreeMap::new();
    for (number, table) in BACKUP_TABLES.into_iter().enumerate() {
        #[cfg(test)]
        {
            if FAIL_AFTER_EXPORT.load(Ordering::Relaxed) == number as i64 {
                anyhow::bail!("injected backup export failure after {number} table(s)");
            }
            // Hold between statements of one read transaction: the first table
            // has established the MVCC snapshot, and a test mutating the live
            // database here proves later tables still see it.
            if number == 1 {
                let hold = TEST_BACKUP_HOLD_NANOS.load(Ordering::Relaxed);
                if hold > 0 {
                    TEST_BACKUP_ACTIVE.store(true, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_nanos(hold));
                    TEST_BACKUP_ACTIVE.store(false, Ordering::SeqCst);
                }
            }
        }
        #[cfg(not(test))]
        let _ = number;
        let path = format!("{work}/{table}.parquet");
        let columns = native_columns(&tx, table)?;
        let list = columns.iter().map(|c| c.0.clone()).collect::<Vec<_>>().join(", ");
        tx.execute_batch(&format!(
            "COPY (SELECT {list} FROM {table}) TO '{}' (FORMAT PARQUET)",
            escape(&path)
        ))
        .with_context(|| format!("exporting table {table}"))?;
        let count: i64 = tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        let bytes = std::fs::metadata(&path)?.len();
        members.insert(table.to_owned(), Member { rows: count, sha256: file_sha256(&path)?, bytes });
        rows.insert(table.to_owned(), count);
    }
    tx.commit()?;

    let report = BackupReport {
        format: BACKUP_FORMAT,
        kind: KIND.to_owned(),
        schema: schema::SCHEMA_VERSION,
        engine: super::ENGINE_VERSION.to_owned(),
        created_at: chrono::Utc::now().timestamp(),
        bytes: 0,
        rows,
    };
    let manifest = Manifest {
        format: report.format,
        kind: report.kind.clone(),
        schema: report.schema,
        engine: report.engine.clone(),
        created_at: report.created_at,
        tables: members,
    };
    std::fs::write(format!("{work}/manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;

    // Tar to a temporary name, then rename: a half-written archive is never
    // published under the name a download would pick up.
    let partial = format!("{dest}.partial");
    let _ = std::fs::remove_file(&partial);
    {
        let file = std::fs::File::create(&partial)?;
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        let mut tar = tar::Builder::new(encoder);
        for name in BACKUP_TABLES
            .iter()
            .map(|t| format!("{t}.parquet"))
            .chain(std::iter::once("manifest.json".to_owned()))
        {
            let path = format!("{work}/{name}");
            let mut file = std::fs::File::open(&path)?;
            let mut header = tar::Header::new_gnu();
            header.set_size(file.metadata()?.len());
            header.set_mode(0o644);
            header.set_mtime(0);
            header.set_cksum();
            tar.append_data(&mut header, &name, &mut file)?;
        }
        tar.into_inner()?.finish()?;
    }
    // The archive is the credential store: password hash, node token digests, the
    // GitHub client secret.
    own_only(&partial);
    std::fs::rename(&partial, dest)?;
    own_only(dest);
    let mut report = report;
    report.bytes = std::fs::metadata(dest)?.len();
    Ok(report)
}

/// Validates an archive without touching anything.
pub fn inspect(src: &str) -> Result<BackupReport> {
    let work = scratch_dir(src, "inspect")?;
    let outcome = extract_and_validate_with(src, &work, DEFAULT_ARCHIVE_LIMITS).map(|(report, _)| report);
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

/// Unpacks `src` into `work`, refusing anything that is not exactly the archive
/// this build writes, and verifies every member against the manifest.
///
/// Two passes on purpose: the manifest is one member among many and may be the
/// last one in the archive, so the digests cannot be checked while the members
/// are being read. No member larger than [`ArchiveLimits::manifest`] is ever
/// held in memory; all others stream to disk through a fixed buffer.
pub(super) fn extract_and_validate_with(
    src: &str,
    work: &str,
    limits: ArchiveLimits,
) -> Result<(BackupReport, u64)> {
    let compressed = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    ensure!(
        compressed <= limits.compressed,
        "备份文件 {} 超过 {} MiB 的上传上限",
        compressed / 1024 / 1024,
        limits.compressed / 1024 / 1024
    );
    let mut members: Vec<String> = Vec::new();
    let mut expanded_total = 0u64;
    {
        let file = std::fs::File::open(src).with_context(|| format!("reading the backup {src}"))?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let mut count = 0usize;
        for entry in archive.entries().context("this file is not a gzipped tar archive")? {
            let mut entry = entry?;
            count += 1;
            ensure!(count <= limits.members, "备份成员数超过上限 {}", limits.members);
            let name = entry.path()?.to_string_lossy().into_owned();
            ensure!(entry.header().entry_type().is_file(), "备份包含非普通文件成员：{name}");
            ensure!(
                !name.starts_with('/') && !name.contains("..") && !name.contains('\\'),
                "备份成员路径不安全：{name}"
            );
            let is_manifest = name == "manifest.json";
            ensure!(
                is_manifest || BACKUP_TABLES.iter().any(|t| name == format!("{t}.parquet")),
                "备份包含未知成员：{name}"
            );
            ensure!(!members.contains(&name), "备份包含重复成员：{name}");
            let member_limit = if is_manifest { limits.manifest } else { limits.member };
            ensure!(entry.size() <= member_limit, "{name} 超过单个成员上限");
            let path = format!("{work}/{name}");
            let mut out = std::fs::File::create(&path)?;
            let mut buffer = vec![0u8; 64 * 1024];
            let mut written = 0u64;
            loop {
                let n = entry.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                written += n as u64;
                ensure!(written <= member_limit, "{name} 超过单个成员上限");
                expanded_total =
                    expanded_total.checked_add(n as u64).ok_or_else(|| anyhow!("备份展开总量溢出"))?;
                ensure!(
                    expanded_total <= limits.total,
                    "备份展开总量超过 {} MiB 的上限",
                    limits.total / 1024 / 1024
                );
                out.write_all(&buffer[..n])?;
            }
            ensure!(written == entry.size(), "{name} 的实际大小与归档记录不符");
            out.flush()?;
            drop(out);
            members.push(name);
        }
    }

    ensure!(members.iter().any(|m| m == "manifest.json"), "备份缺少 manifest.json");
    let manifest_path = format!("{work}/manifest.json");
    ensure!(std::fs::metadata(&manifest_path)?.len() <= limits.manifest, "manifest 过大");
    let text = std::fs::read(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&text).context("manifest.json 无法解析")?;
    ensure!(manifest.format == BACKUP_FORMAT, "不支持的备份格式 {}", manifest.format);
    ensure!(manifest.kind == KIND, "这不是 romi 的备份");
    ensure!(
        manifest.schema <= schema::SCHEMA_VERSION,
        "备份来自更新的 romi（schema {}，本版本读取 {}）；请先升级",
        manifest.schema,
        schema::SCHEMA_VERSION
    );
    for table in manifest.tables.keys() {
        ensure!(BACKUP_TABLES.contains(&table.as_str()), "manifest 提到未知表 {table}");
    }
    let mut rows = BTreeMap::new();
    for table in BACKUP_TABLES {
        ensure!(members.contains(&format!("{table}.parquet")), "备份缺少 {table}.parquet");
        let member = manifest.tables.get(table).ok_or_else(|| anyhow!("manifest 里没有 {table} 的记录"))?;
        let path = format!("{work}/{table}.parquet");
        let digest = file_sha256(&path)?;
        ensure!(member.sha256 == digest, "{table}.parquet 的摘要与 manifest 不符");
        let size = std::fs::metadata(&path)?.len();
        ensure!(member.bytes == size, "{table}.parquet 的大小与 manifest 不符");
        rows.insert(table.to_owned(), member.rows);
    }
    Ok((
        BackupReport {
            format: manifest.format,
            kind: manifest.kind,
            schema: manifest.schema,
            engine: manifest.engine,
            created_at: manifest.created_at,
            bytes: std::fs::metadata(src).map(|m| m.len()).unwrap_or(0),
            rows,
        },
        expanded_total,
    ))
}

/// The names and types of one table as this build declares them.
fn native_columns(conn: &Connection, table: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(&format!("DESCRIBE SELECT * FROM {table}"))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
}

/// Column names only, in declaration order.
fn native_column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    Ok(native_columns(conn, table)?.into_iter().map(|(name, _)| name).collect())
}

// ---- restore ----

/// Rebuilds the uploaded archive into a fresh database, then switches to it.
pub(super) fn restore(ex: &mut Exclusive<'_>, inner: &Arc<Inner>, src: &str) -> Result<BackupReport> {
    let staging = scratch_file(&inner.path, "restoring");
    let outcome = (|| -> Result<BackupReport> {
        let report = build_staging(inner, src, &staging)?;
        activate(ex, inner, &staging)?;
        // Everything a restore has to change -- including session invalidation --
        // happened in the staging database. After activation there is nothing
        // left to mutate, so a successful restore cannot fail after the live
        // file has already been discarded.
        Ok(report)
    })();
    let _ = std::fs::remove_file(&staging);
    let _ = std::fs::remove_file(format!("{staging}.wal"));
    outcome
}

/// Builds and fully validates a new database at `dest` from the archive.
///
/// Everything that can fail happens here, while the live database is still
/// untouched.
fn build_staging(inner: &Arc<Inner>, src: &str, dest: &str) -> Result<BackupReport> {
    let work = scratch_dir(dest, "staging")?;
    let outcome = (|| -> Result<BackupReport> {
        let (report, expanded) = extract_and_validate_with(src, &work, DEFAULT_ARCHIVE_LIMITS)?;
        // Advisory, not a reservation: the archive's expanded size is known, and
        // a staging database usually needs a small multiple of the Parquet bytes.
        // If statvfs is unavailable this check is skipped; the write path still
        // reports a real failure if the filesystem fills up.
        let staging_dir = std::path::Path::new(dest).parent().and_then(|p| p.to_str()).unwrap_or(".");
        if let Some(free) = available_bytes(staging_dir) {
            let needed = expanded.saturating_mul(2).saturating_add(16 * 1024 * 1024);
            ensure!(
                free >= needed,
                "构建恢复 staging 数据库的可用磁盘空间不足：剩余 {free} 字节，预计至少需要 {needed} 字节"
            );
        }
        let _ = std::fs::remove_file(dest);
        let _ = std::fs::remove_file(format!("{dest}.wal"));
        let indexed_rows = report
            .rows
            .get("metric")
            .copied()
            .unwrap_or(0)
            .saturating_add(report.rows.get("ping_record").copied().unwrap_or(0));
        let mut staging_options = inner.options.clone();
        staging_options.memory_limit = staging_memory_limit(&inner.options.memory_limit, indexed_rows)?;
        let mut conn = open_connection(dest, &staging_options, false)?;
        // A restore rebuilds a fresh database; physical row order is not part of
        // the API. DuckDB otherwise buffers an ordered INSERT long enough to
        // preserve insertion order, which made representative medium/large
        // archives exceed the configured memory_limit while rebuilding
        // ping_record. Streaming keeps the staging build bounded.
        conn.execute_batch("SET preserve_insertion_order=false")
            .context("disabling insertion-order preservation for the restore staging build")?;
        schema::initialize_staging(&mut conn, env!("CARGO_PKG_VERSION"))?;
        for table in BACKUP_TABLES {
            let file = format!("{work}/{table}.parquet");
            // The archive is untrusted input. Comparing the Parquet schema with
            // the one this build declares means a member whose columns are
            // renamed, retyped or reordered is refused rather than coerced.
            let theirs = describe_parquet(&conn, &file)?;
            let ours = native_columns(&conn, table)?;
            for (name, kind) in &ours {
                match theirs.iter().find(|(n, _)| n == name) {
                    Some((_, their_kind)) if their_kind == kind => {}
                    Some((_, their_kind)) => {
                        anyhow::bail!("{table}.{name} 的类型是 {their_kind}，本版本要求 {kind}")
                    }
                    None => anyhow::bail!("{table} 的数据文件缺少列 {name}"),
                }
            }
            let list = ours.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>().join(", ");
            conn.execute_batch(&format!(
                "INSERT INTO {table} ({list}) SELECT {list} FROM read_parquet('{}')",
                escape(&file)
            ))
            .with_context(|| format!("rebuilding table {table}"))?;
            let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
            let claimed = report.rows.get(table).copied().unwrap_or(0);
            ensure!(count == claimed, "{table} 期望 {claimed} 行，实际装入 {count} 行");
        }
        // The large-table keys were deferred during the load; build them now
        // that the archive's rows are all present. A duplicate makes this fail,
        // which is the right outcome before activation.
        schema::add_large_table_keys(&conn)?;
        // Restore transformation, performed before validation/checkpoint while
        // this is still a scratch database. The format carries no session rows,
        // and this makes the empty state deliberate rather than incidental.
        conn.execute("DELETE FROM session", [])?;
        verify_relationships(&conn)?;
        schema::resync_ids(&conn)?;
        checkpoint(&conn)?;
        drop(conn);
        restrict(dest);
        Ok(report)
    })();
    let _ = std::fs::remove_dir_all(&work);
    if outcome.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    outcome
}

fn describe_parquet(conn: &Connection, file: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(&format!("DESCRIBE SELECT * FROM read_parquet('{}')", escape(file)))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
}

/// Every relationship the application enforces, checked on the rebuilt rows.
///
/// DuckDB cannot declare a cascading foreign key, so the hub enforces these in
/// the application instead; this is where a backup that would introduce an orphan
/// is caught, before it becomes the live database.
pub(super) fn verify_relationships(conn: &Connection) -> Result<()> {
    let checks = [
        ("traffic 指向不存在的节点", "SELECT COUNT(*) FROM traffic t LEFT JOIN node n ON n.id=t.node_id WHERE n.id IS NULL"),
        ("metric 指向不存在的节点", "SELECT COUNT(*) FROM metric m LEFT JOIN node n ON n.id=m.node_id WHERE n.id IS NULL"),
        ("ping_node 指向不存在的节点", "SELECT COUNT(*) FROM ping_node p LEFT JOIN node n ON n.id=p.node_id WHERE n.id IS NULL"),
        ("ping_node 指向不存在的探测", "SELECT COUNT(*) FROM ping_node p LEFT JOIN ping_task t ON t.id=p.task_id WHERE t.id IS NULL"),
        ("ping_record 指向不存在的节点", "SELECT COUNT(*) FROM ping_record r LEFT JOIN node n ON n.id=r.node_id WHERE n.id IS NULL"),
        (
            "ping_record 指向不存在的分配",
            "SELECT COUNT(*) FROM ping_record r LEFT JOIN ping_node p ON p.node_id=r.node_id AND p.task_id=r.task_id WHERE p.node_id IS NULL",
        ),
        ("有节点没有 traffic 行", "SELECT COUNT(*) FROM node n LEFT JOIN traffic t ON t.node_id=n.id WHERE t.node_id IS NULL"),
        ("node.token_hash 重复", "SELECT COUNT(*) FROM (SELECT token_hash FROM node GROUP BY token_hash HAVING COUNT(*) > 1)"),
    ];
    for (what, sql) in checks {
        let n: i64 = conn.query_row(sql, [], |r| r.get(0))?;
        ensure!(n == 0, "备份校验失败：{what}（{n} 行）");
    }
    Ok(())
}

/// Switches the process over to `staging`, which is a complete database.
///
/// For a file-backed hub this renames the original aside, renames the new file
/// into place and reopens; the original is renamed back if anything fails. For an
/// in-memory hub there is no file to swap, so the contents are replaced inside one
/// transaction instead -- the same validation, a different mechanism, and both are
/// exercised by the tests.
fn activate(ex: &mut Exclusive<'_>, inner: &Arc<Inner>, staging: &str) -> Result<()> {
    if inner.path.is_empty() {
        return replace_contents(ex, staging);
    }
    let live = inner.path.clone();
    let aside = format!("{live}.replaced");
    let _ = std::fs::remove_file(&aside);
    let _ = std::fs::remove_file(format!("{aside}.wal"));

    // Every handle on the old file is closed first: the writer's connection, the
    // prototype, and the read pool. Renaming underneath an open database is how a
    // restore ends up with two writers on two different inodes.
    let mut writer = ex.conn.take();
    *inner.prototype.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let previous = {
        let mut guard = inner.readers.write().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *guard, Arc::new(ReaderPool::empty()))
    };
    drop(writer.take());
    // The gate is held exclusively, so no reader can still hold a clone; dropping
    // this closes the last connection to the old file.
    drop(previous);

    // 1. Move the original aside. A failure here has not changed the live path at
    //    all, so reopening is the whole recovery and no data was ever at risk.
    if let Err(e) = std::fs::rename(&live, &aside) {
        return match reopen(inner, Some(&mut *ex.conn)) {
            Ok(()) => Err(anyhow!("无法移开当前数据库（{e}）；原库未被改动")),
            Err(re) => Err(anyhow!("无法移开当前数据库（{e}），且重新打开它也失败（{re:#}）")),
        };
    }

    // 2. Publish the new file. Failing here leaves the original beside it, and it
    //    is renamed back rather than deleted.
    if let Err(e) = std::fs::rename(staging, &live) {
        let _ = std::fs::rename(&aside, &live);
        return match reopen(inner, Some(&mut *ex.conn)) {
            Ok(()) => Err(anyhow!("发布新数据库失败（{e}）；已回滚到原数据库")),
            Err(re) => Err(anyhow!("发布新数据库失败（{e}），且回滚后重新打开原库失败（{re:#}）")),
        };
    }

    // 3. Reopen on the new file. This is the last step that can fail, and it is
    //    the one that must leave the hub on its original data if it does.
    match reopen(inner, Some(&mut *ex.conn)) {
        Ok(()) => {
            let _ = std::fs::remove_file(&aside);
            let _ = std::fs::remove_file(format!("{aside}.wal"));
            info!("database at {live} replaced; the previous file was removed after the switch");
            Ok(())
        }
        Err(e) => {
            warn!("opening the restored database failed ({e:#}); restoring the original file");
            let _ = std::fs::remove_file(&live);
            let _ = std::fs::remove_file(format!("{live}.wal"));
            let mut rollback = std::fs::rename(&aside, &live).context("renaming the original database back");
            if rollback.is_ok() {
                rollback = reopen(inner, Some(&mut *ex.conn));
            }
            match rollback {
                Ok(()) => Err(anyhow!("恢复失败，已回滚到原数据库：{e:#}")),
                Err(re) => Err(anyhow!("恢复失败且回滚也失败：{e:#}；回滚错误：{re:#}")),
            }
        }
    }
}

/// Switch to a database built by a test, so the rollback after a failed reopen is
/// exercised rather than described. Test-only.
#[cfg(test)]
pub(super) fn activate_for_test(db: &super::Db, staging: &str) -> Result<()> {
    let inner = db.inner_handle();
    let staging = staging.to_owned();
    db.write_replace(move |ex| activate(ex, &inner, &staging))
}

/// Replaces an in-memory database's rows with the ones in `staging`, atomically.
///
/// There is no file to swap, so the contents are replaced inside one transaction
/// instead: the same validation, a different mechanism. `staging` already has no
/// session rows, so copying every persistent table and leaving `session` empty
/// completes the restore transform before the transaction commits.
fn replace_contents(ex: &mut Exclusive<'_>, staging: &str) -> Result<()> {
    let conn = ex.conn.as_ref().ok_or_else(|| anyhow!("数据库已关闭"))?;
    conn.execute_batch(&format!("ATTACH '{}' AS restored (READ_ONLY)", escape(staging)))
        .context("attaching the restored database")?;
    let outcome = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        let copied = (|| -> Result<()> {
            for table in schema::TABLES {
                tx.execute(&format!("DELETE FROM {table}"), [])?;
            }
            for table in BACKUP_TABLES {
                let list = native_column_names(&tx, table)?.join(", ");
                tx.execute_batch(&format!(
                    "INSERT INTO {table} ({list}) SELECT {list} FROM restored.{table}"
                ))?;
            }
            // All fallible mutations happen before the commit: activation must not
            // be followed by another step that can fail.
            schema::resync_ids(&tx)?;
            Ok(())
        })();
        match copied {
            Ok(()) => {
                tx.commit()?;
                Ok(())
            }
            Err(e) => {
                let _ = tx.rollback();
                Err(e)
            }
        }
    })();
    // DETACH is release of a temporary attachment, not part of the restore's
    // durability contract; a failure to detach must not turn a committed restore
    // into a reported failure.
    match outcome {
        Ok(()) => {
            if let Err(e) = conn.execute_batch("DETACH restored") {
                warn!("detaching the restored scratch database failed: {e:#}");
            }
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("DETACH restored");
            Err(e)
        }
    }
}

/// Opens every handle again on `inner.path`, after the file there changed.
///
/// `writer` is the barrier's own connection slot: the switch took the connection
/// out of it, and a hub that cannot write after a restore has not been restored.
fn reopen(inner: &Arc<Inner>, writer: Option<&mut Option<Connection>>) -> Result<()> {
    let conn = open_connection(&inner.path, &inner.options, false)?;
    let engine = schema::engine_version(&conn)?;
    ensure!(
        engine == super::ENGINE_VERSION,
        "恢复后的数据库由 DuckDB {engine} 写入，本版本只验证过 {}",
        super::ENGINE_VERSION
    );
    let version = schema::stored_version(&conn)?.ok_or_else(|| anyhow!("恢复后的数据库缺少 schema 记录"))?;
    ensure!(version <= schema::SCHEMA_VERSION, "恢复后的数据库 schema {version} 高于本版本");
    restrict(&inner.path);
    let prototype = conn.try_clone()?;
    let writer_conn = conn.try_clone()?;
    let pool = ReaderPool::new(&conn)?;
    *inner.prototype.lock().unwrap_or_else(|e| e.into_inner()) = Some(prototype);
    *inner.readers.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(pool);
    if let Some(slot) = writer {
        *slot = Some(writer_conn);
    }
    Ok(())
}

// ---- maintenance ----

/// Checkpoints the live database, measures reusable space, and decides whether a
/// rewrite is worth it. Runs on the writer connection in autocommit, without the
/// replacement barrier: queued telemetry is neither drained nor refused.
pub(super) fn plan_maintenance(
    conn: &Connection,
    inner: &Arc<Inner>,
    pruned: usize,
) -> Result<MaintenancePlan> {
    let mut report = MaintenanceReport { pruned, ..Default::default() };
    report.generation = inner.generation.load(Ordering::SeqCst);
    if inner.path.is_empty() {
        // Nothing on disk to reclaim.
        checkpoint(conn)?;
        return Ok(MaintenancePlan { report, rewrite: false, checkpointed: 0 });
    }
    let before = on_disk(&inner.path);
    checkpoint(conn)?;
    let after_checkpoint = on_disk(&inner.path);
    let (block, free): (i64, i64) =
        conn.query_row("SELECT block_size, free_blocks FROM pragma_database_size()", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    report.reusable = block * free;
    report.freed = (before - after_checkpoint).max(0);
    report.size = after_checkpoint;
    // A copy costs a full rewrite and needs room for a second file. Below one
    // block-sized MiB of reusable space that is not worth doing, and the caller is
    // told the space was not returned rather than being given an estimate.
    let threshold = 4 * 1024 * 1024;
    let rewrite = report.reusable >= threshold;
    Ok(MaintenancePlan { report, rewrite, checkpointed: after_checkpoint })
}

/// Performs the replacing half of maintenance: copy the live database into a
/// fresh file and switch to it. Only called when [`plan_maintenance`] decided a
/// rewrite is worth it, and therefore only when queued writes may be refused.
pub(super) fn apply_maintenance(
    ex: &mut Exclusive<'_>,
    inner: &Arc<Inner>,
    plan: MaintenancePlan,
) -> Result<MaintenanceReport> {
    let MaintenancePlan { mut report, checkpointed, .. } = plan;
    let staging = scratch_file(&inner.path, "compacting");
    let outcome = (|| -> Result<()> {
        let conn = ex.conn.as_ref().ok_or_else(|| anyhow!("数据库已关闭"))?;
        let _ = std::fs::remove_file(&staging);
        let current: String = conn.query_row("SELECT current_database()", [], |r| r.get(0))?;
        conn.execute_batch(&format!("ATTACH '{}' AS compacted", escape(&staging)))?;
        // Quoted: the database name is derived from the file name, which for an
        // operator's `romi-prod.db` is not a bare identifier.
        let copied = conn.execute_batch(&format!("COPY FROM DATABASE {} TO compacted", quote(&current)));
        // Detached whether or not the copy worked: a failed copy must not leave
        // the staging file attached to the live database.
        let detached = conn.execute_batch("DETACH compacted");
        copied.context("compacting the database into a new file")?;
        detached.context("detaching the compacted file")?;
        checkpoint(conn)?;
        activate(ex, inner, &staging)
    })();
    let _ = std::fs::remove_file(&staging);
    let _ = std::fs::remove_file(format!("{staging}.wal"));
    outcome?;

    report.compacted = true;
    report.size = on_disk(&inner.path);
    report.freed += (checkpointed - report.size).max(0);
    // `run_replace` advances the generation after this returns; reporting the
    // post-operation value makes the figure consistent with what callers see.
    report.generation = inner.generation.load(Ordering::SeqCst) + 1;
    info!(
        "database compacted: {} bytes returned to the filesystem, {} bytes now on disk",
        report.freed, report.size
    );
    Ok(report)
}

// ---- helpers ----

/// A temporary memory ceiling for the staging database.
///
/// The service `memory_limit` is sized for normal query/ingest operation, but a
/// restore rebuilds bulk history and materializes the primary-key ART indexes in
/// one place. Restoring a medium archive under the default 512 MiB failed before
/// even the row counts could be validated. The staging build therefore gets a
/// ceiling derived from the archive's indexed row counts: a bounded base plus a
/// conservative per-row allowance. If even that does not fit the host memory
/// budget, restore refuses with an actionable error instead of being OOM-killed.
fn staging_memory_limit(configured: &str, indexed_rows: i64) -> Result<String> {
    const BASE: u64 = 256 * 1024 * 1024;
    const PER_ROW: u64 = 64;
    let configured = parse_size(configured).unwrap_or(BASE);
    let needed = BASE.saturating_add((indexed_rows.max(0) as u64).saturating_mul(PER_ROW));
    let system_cap = system_memory_bytes().map(|bytes| bytes.saturating_mul(3) / 4).unwrap_or(u64::MAX);
    let cap = system_cap.max(configured);
    ensure!(
        needed <= cap,
        "恢复这个归档需要约 {} MiB 的 staging 内存，但本机可用预算约 {} MiB；\
         请释放内存、在更大的主机上恢复，或提高 --db-memory",
        needed / 1024 / 1024,
        cap / 1024 / 1024
    );
    let chosen = configured.max(needed).min(cap);
    if chosen > configured {
        warn!(
            "restore staging uses a temporary memory_limit of {} MiB (configured {}); \
             the primary-key build for {} indexed history rows needs more than normal service",
            chosen / 1024 / 1024,
            configured / 1024 / 1024,
            indexed_rows
        );
    }
    Ok(format!("{}MiB", chosen / 1024 / 1024))
}

/// Parse a DuckDB size string such as `512MB`, `2GiB`, or `64M`.
fn parse_size(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(text.len());
    let number: f64 = text[..split].parse().ok()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    let unit = text[split..].trim().to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "b" => 1.0,
        "kb" | "kib" | "k" => 1024.0,
        "mb" | "mib" | "m" => 1024.0 * 1024.0,
        "gb" | "gib" | "g" => 1024.0 * 1024.0 * 1024.0,
        "tb" | "tib" | "t" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * multiplier) as u64)
}

/// Total physical memory, when the host can report it. Linux hubs are the
/// target, where this is a cheap syscall; unknown hosts skip the budget check
/// and let DuckDB report an allocation failure.
#[cfg(unix)]
fn system_memory_bytes() -> Option<u64> {
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if pages <= 0 || page <= 0 {
        return None;
    }
    Some((pages as u64).saturating_mul(page as u64))
}

#[cfg(not(unix))]
fn system_memory_bytes() -> Option<u64> {
    None
}

/// Advisory free space for the filesystem holding `path`, in bytes.
///
/// `statvfs` is a snapshot, not a reservation: another writer can consume the
/// space between this check and the rename. It is still useful to reject an
/// archive whose expanded size plainly cannot fit before building a staging
/// database. `None` means the platform cannot answer and the check is skipped.
#[cfg(unix)]
fn available_bytes(path: &str) -> Option<u64> {
    use std::ffi::CString;
    let path = CString::new(path).ok()?;
    // SAFETY: `statvfs` initializes the struct on success; on failure the zeroed
    // value is never read.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(path.as_ptr(), &mut stats) };
    if rc != 0 {
        return None;
    }
    // `f_frsize` is the fragment size on Linux; some filesystems report zero
    // there and expect `f_bsize` instead.
    let unit = if stats.f_frsize > 0 { stats.f_frsize as u64 } else { stats.f_bsize as u64 };
    (stats.f_bavail as u64).checked_mul(unit)
}

#[cfg(not(unix))]
fn available_bytes(_: &str) -> Option<u64> {
    None
}

fn on_disk(file: &str) -> i64 {
    bytes_of(file) + bytes_of(&format!("{file}.wal"))
}

fn bytes_of(file: &str) -> i64 {
    std::fs::metadata(file).map(|m| m.len() as i64).unwrap_or(0)
}

fn file_sha256(path: &str) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// A scratch directory beside the database, so a backup or a rebuild lands on a
/// filesystem with room for it. Created owner-only.
fn scratch_dir(beside: &str, kind: &str) -> Result<String> {
    let path = super::scratch_beside(beside, kind);
    std::fs::create_dir_all(&path)?;
    super::restrict_dir(&path);
    Ok(path)
}

/// A scratch file name beside the database. The file itself is not created: the
/// callers each create it themselves and refuse to do so over an existing one.
pub(crate) fn scratch_file(beside: &str, kind: &str) -> String {
    format!("{}.duckdb", super::scratch_beside(beside, kind))
}

/// A double-quoted identifier.
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Single-quoted SQL literal. Paths here are built from a random token and a path
/// the operator supplied, so a quote is escaped rather than assumed absent.
fn escape(path: &str) -> String {
    path.replace('\'', "''")
}
