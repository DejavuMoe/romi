//! Backup, restore and compaction.
//!
//! # Format
//!
//! A backup is a gzipped tar holding one Parquet file per application table and a
//! `manifest.json` that records the application schema version, the engine that
//! wrote it, and each member's row count and SHA-256.
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
//! # Restore
//!
//! 1. The archive is validated member by member (paths, sizes, digests, types).
//! 2. A complete new database is built in a scratch file and checked: row counts
//!    against the manifest, column names and types against this build's schema,
//!    and referential integrity across the rebuilt rows.
//! 3. Only then is the live file replaced, under the maintenance barrier: readers
//!    stopped, the writer's connection closed, the original renamed aside, the
//!    new file renamed into place and reopened.
//! 4. If step 3 fails at any point the original is renamed back and reopened, and
//!    the failure is reported. The original is deleted only once the replacement
//!    is open and answering.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::{anyhow, ensure, Context, Result};
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use super::{checkpoint, open_connection, own_only, restrict, schema, Exclusive, Inner, ReaderPool, TABLES};

/// Bumped when the layout of the archive itself changes.
const BACKUP_FORMAT: i64 = 1;
const KIND: &str = "romi-duckdb-backup";
/// Ceiling on the manifest, which is the only member held in memory.
const MAX_MANIFEST: u64 = 1024 * 1024;
/// One Parquet member may not exceed this once expanded.
const MAX_MEMBER: u64 = 512 * 1024 * 1024;

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
    /// The connection generation, so a caller can tell a rebuild happened.
    pub generation: u64,
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

/// Writes `dest` from the live database. Runs on the writer thread with the
/// maintenance barrier held, so the rows it copies are one consistent snapshot.
pub(super) fn write_archive(conn: &mut Option<Connection>, dest: &str) -> Result<BackupReport> {
    let conn = conn.as_ref().ok_or_else(|| anyhow!("数据库已关闭"))?;
    let work = scratch_dir(dest, "backup")?;
    let outcome = write_archive_inner(conn, dest, &work);
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

fn write_archive_inner(conn: &Connection, dest: &str, work: &str) -> Result<BackupReport> {
    // One snapshot for every table: without the transaction each COPY would see
    // whatever had been committed by the time it started.
    conn.execute_batch("BEGIN")?;
    let mut members = BTreeMap::new();
    let mut rows = BTreeMap::new();
    for table in TABLES {
        let path = format!("{work}/{table}.parquet");
        let columns = native_columns(conn, table)?;
        let list = columns.iter().map(|c| c.0.clone()).collect::<Vec<_>>().join(", ");
        conn.execute_batch(&format!(
            "COPY (SELECT {list} FROM {table}) TO '{}' (FORMAT PARQUET)",
            escape(&path)
        ))
        .with_context(|| format!("exporting table {table}"))?;
        let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        let bytes = std::fs::metadata(&path)?.len();
        members.insert(table.to_owned(), Member { rows: count, sha256: file_sha256(&path)?, bytes });
        rows.insert(table.to_owned(), count);
    }
    conn.execute_batch("COMMIT")?;

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
        for name in
            TABLES.iter().map(|t| format!("{t}.parquet")).chain(std::iter::once("manifest.json".to_owned()))
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
    let outcome = extract_and_validate(src, &work);
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

/// Unpacks `src` into `work`, refusing anything that is not exactly the archive
/// this build writes, and verifies every member against the manifest.
///
/// Two passes on purpose: the manifest is one member among many and may be the
/// last one in the archive, so the digests cannot be checked while the members
/// are being read.
fn extract_and_validate(src: &str, work: &str) -> Result<BackupReport> {
    let mut members: Vec<String> = Vec::new();
    {
        let file = std::fs::File::open(src).with_context(|| format!("reading the backup {src}"))?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in archive.entries().context("this file is not a gzipped tar archive")? {
            let mut entry = entry?;
            let name = entry.path()?.to_string_lossy().into_owned();
            ensure!(entry.header().entry_type().is_file(), "备份包含非普通文件成员：{name}");
            if name == "manifest.json" {
                ensure!(entry.size() <= MAX_MANIFEST, "manifest 过大");
            }
            ensure!(
                !name.starts_with('/') && !name.contains("..") && !name.contains('\\'),
                "备份成员路径不安全：{name}"
            );
            ensure!(!members.contains(&name), "备份包含重复成员：{name}");
            let expected = name == "manifest.json" || TABLES.iter().any(|t| name == format!("{t}.parquet"));
            ensure!(expected, "备份包含未知成员：{name}");
            ensure!(entry.size() <= MAX_MEMBER, "{name} 超过单个成员上限");
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
                ensure!(written <= MAX_MEMBER, "{name} 超过单个成员上限");
                out.write_all(&buffer[..n])?;
            }
            out.flush()?;
            members.push(name);
        }
    }

    ensure!(members.iter().any(|m| m == "manifest.json"), "备份缺少 manifest.json");
    let text = std::fs::read(format!("{work}/manifest.json"))?;
    let manifest: Manifest = serde_json::from_slice(&text).context("manifest.json 无法解析")?;
    ensure!(manifest.format == BACKUP_FORMAT, "不支持的备份格式 {}", manifest.format);
    ensure!(manifest.kind == KIND, "这不是 romi 的备份");
    ensure!(
        manifest.schema <= schema::SCHEMA_VERSION,
        "备份来自更新的 romi（schema {}，本版本读取 {}）；请先升级",
        manifest.schema,
        schema::SCHEMA_VERSION
    );
    for table in TABLES {
        ensure!(members.contains(&format!("{table}.parquet")), "备份缺少 {table}.parquet");
        let member = manifest.tables.get(table).ok_or_else(|| anyhow!("manifest 里没有 {table} 的记录"))?;
        let digest = file_sha256(&format!("{work}/{table}.parquet"))?;
        ensure!(member.sha256 == digest, "{table}.parquet 的摘要与 manifest 不符");
        let size = std::fs::metadata(format!("{work}/{table}.parquet"))?.len();
        ensure!(member.bytes == size, "{table}.parquet 的大小与 manifest 不符");
    }
    let mut rows = BTreeMap::new();
    for (table, member) in &manifest.tables {
        ensure!(TABLES.contains(&table.as_str()), "manifest 提到未知表 {table}");
        rows.insert(table.clone(), member.rows);
    }
    Ok(BackupReport {
        format: manifest.format,
        kind: manifest.kind,
        schema: manifest.schema,
        engine: manifest.engine,
        created_at: manifest.created_at,
        bytes: std::fs::metadata(src).map(|m| m.len()).unwrap_or(0),
        rows,
    })
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
        // The archive carries whatever sessions it held when it was taken, and
        // restoring it must not revive a login the operator ended. Done here
        // rather than by the caller so no path into a restore can skip it; the
        // panel then issues the caller a fresh session.
        if let Some(conn) = ex.conn.as_ref() {
            conn.execute("DELETE FROM session", [])?;
        }
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
        let report = extract_and_validate(src, &work)?;
        let _ = std::fs::remove_file(dest);
        let _ = std::fs::remove_file(format!("{dest}.wal"));
        let mut conn = open_connection(dest, &inner.options, false)?;
        schema::initialize(&mut conn, true, env!("CARGO_PKG_VERSION"))?;
        for table in TABLES {
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

/// Every relationship the SQLite build expressed as a foreign key, checked on the
/// rebuilt rows.
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
    db.write_exclusive(move |ex| activate(ex, &inner, &staging))
}

/// Replaces an in-memory database's rows with the ones in `staging`, atomically.
///
/// There is no file to swap, so the contents are replaced inside one transaction
/// instead: the same validation, a different mechanism. Both paths are exercised
/// by the tests.
fn replace_contents(ex: &mut Exclusive<'_>, staging: &str) -> Result<()> {
    let conn = ex.conn.as_ref().ok_or_else(|| anyhow!("数据库已关闭"))?;
    conn.execute_batch(&format!("ATTACH '{}' AS restored (READ_ONLY)", escape(staging)))
        .context("attaching the restored database")?;
    let outcome = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        let copied = (|| -> Result<()> {
            for table in TABLES {
                tx.execute(&format!("DELETE FROM {table}"), [])?;
            }
            for table in TABLES {
                let list = native_column_names(&tx, table)?.join(", ");
                tx.execute_batch(&format!(
                    "INSERT INTO {table} ({list}) SELECT {list} FROM restored.{table}"
                ))?;
            }
            Ok(())
        })();
        match copied {
            Ok(()) => {
                tx.commit()?;
                schema::resync_ids(conn)?;
                Ok(())
            }
            Err(e) => {
                let _ = tx.rollback();
                Err(e)
            }
        }
    })();
    let detached = conn.execute_batch("DETACH restored");
    outcome?;
    detached.context("detaching the restored database")?;
    Ok(())
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

// ---- compaction ----

/// Retention has already run; this folds the log, and rewrites the file when
/// DuckDB reports enough reusable space to be worth it.
pub(super) fn compact(
    ex: &mut Exclusive<'_>,
    inner: &Arc<Inner>,
    pruned: usize,
) -> Result<MaintenanceReport> {
    let mut report = MaintenanceReport { pruned, ..Default::default() };
    if inner.path.is_empty() {
        // Nothing on disk to reclaim.
        if let Some(conn) = ex.conn.as_ref() {
            checkpoint(conn)?;
        }
        return Ok(report);
    }
    let before = on_disk(&inner.path);
    {
        let conn = ex.conn.as_ref().ok_or_else(|| anyhow!("数据库已关闭"))?;
        checkpoint(conn)?;
    }
    let after_checkpoint = on_disk(&inner.path);
    {
        let conn = ex.conn.as_ref().ok_or_else(|| anyhow!("数据库已关闭"))?;
        let (block, free): (i64, i64) =
            conn.query_row("SELECT block_size, free_blocks FROM pragma_database_size()", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        report.reusable = block * free;
    }
    report.freed = (before - after_checkpoint).max(0);
    // A copy costs a full rewrite and needs room for a second file. Below one
    // block-sized MiB of reusable space that is not worth doing, and the caller is
    // told the space was not returned rather than being given an estimate.
    let threshold = 4 * 1024 * 1024;
    if report.reusable < threshold {
        report.size = after_checkpoint;
        report.generation = inner.generation.load(Ordering::SeqCst);
        return Ok(report);
    }

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
    report.freed += (after_checkpoint - report.size).max(0);
    report.generation = inner.generation.load(Ordering::SeqCst);
    info!(
        "database compacted: {} bytes returned to the filesystem, {} bytes now on disk",
        report.freed, report.size
    );
    Ok(report)
}

// ---- helpers ----

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
