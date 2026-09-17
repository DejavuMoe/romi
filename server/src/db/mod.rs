//! DuckDB storage.
//!
//! # Concurrency
//!
//! DuckDB allows exactly one read-write process per database file, and within
//! that process it uses MVCC: many connections, one writer at a time. That maps
//! onto a hub directly, and this module implements it as three separate paths
//! rather than one global mutex.
//!
//! * **One writer thread** owns the writing connection. Every mutation is a
//!   closure sent down a bounded channel ([`WRITER_QUEUE`]) and answered after
//!   the commit, so a caller never learns of a write that did not happen. The
//!   thread takes one job, drains up to [`BATCH_OPS`] already-queued telemetry
//!   jobs behind it, and commits them in **one transaction** -- group commit.
//!   Filling the channel is the backpressure: `send` blocks rather than growing
//!   an unbounded queue.
//! * **A small pool of read connections** ([`READERS`]) serves the analytical
//!   queries. A reader never waits for the writer's transaction, and a long
//!   history query cannot park every other reader behind one connection lock.
//!   DuckDB's MVCC gives each query a consistent snapshot.
//! * **A maintenance barrier** (`RwLock`) excludes readers while the database
//!   file is replaced, and the writer thread drains and rejects everything
//!   already queued at that point.
//!
//! Nothing here blocks a Tokio core worker: the API layer calls these methods
//! from `spawn_blocking` (or `block_in_place` on the ingest path), and the
//! writer's own waiting happens on its own thread.
//!
//! # Durability
//!
//! A mutation is acknowledged only after `COMMIT` returns, and a batch whose
//! commit fails reports the failure to every job it carried. Accepted telemetry
//! that has not yet committed lives only in this process's queue; the maximum
//! uncommitted window is [`WRITER_QUEUE`] operations, and those are lost if the
//! process dies before the commit -- which is the same guarantee the agents'
//! next report repairs, since every report carries absolute counters.

//! # A statement cache is not safe here
//!
//! `Connection::prepare_cached` in `duckdb` 1.10505.0 returns a *stale or torn*
//! result once another connection has committed since the statement was last run.
//! Reproduced with the crate alone -- a reader holding a cached
//! `SELECT id, flag, n FROM t` sees `n = 232` after a writer sets `n = 999400`,
//! and keeps seeing it while a freshly prepared statement returns the committed
//! value. Every statement here is therefore prepared per use; the cost is one
//! plan per statement, which `docs/duckdb-migration.md` measures.
//! `server/tests/duckdb_engine.rs` keeps the reproduction.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::{Datelike, Local, NaiveDate, Utc};
use duckdb::{params, Config, Connection, InterruptHandle, OptionalExt};
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

mod backup;
mod legacy;
mod schema;
#[cfg(test)]
mod tests;

pub use backup::{BackupReport, MaintenanceReport};
pub use legacy::ImportReport;
pub use schema::{ENGINE_VERSION, TABLES};

/// Operations accepted from callers but not yet committed. Bounded: a caller
/// blocks here rather than letting the queue grow.
const WRITER_QUEUE: usize = 512;
/// The most operations one commit may carry. Bounds both the transaction and the
/// time a caller can spend waiting behind other work.
const BATCH_OPS: usize = 256;
/// Analytical read connections. Enough that a slow history query does not
/// serialize the panel behind itself, few enough that DuckDB's own threads are
/// not oversubscribed.
const READERS: usize = 3;
/// Wall-clock bound on a history query. A timed-out HTTP caller cannot cancel a
/// blocking task once it started, so the query itself is interrupted instead of
/// being left to run to completion.
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a graceful shutdown waits for accepted work to commit.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
/// Rows per commit when an offline import streams a legacy export in.
const IMPORT_BATCH: usize = 20_000;

/// Default memory ceiling. A hub is a long-running process on a small VPS, and
/// DuckDB sizes itself from the host otherwise.
const DEFAULT_MEMORY_LIMIT: &str = "512MB";
const DEFAULT_MAX_TEMP: &str = "2GB";

/// Reason a queued job was refused because the database underneath it changed.
const SUPERSEDED: &str = "数据库已被恢复或重建，这次写入没有执行；请重试";

// ---- the writer queue ----

type Payload = Box<dyn Any + Send>;
type Reply = SyncSender<Result<Payload>>;

/// What a job needs from its execution context.
enum Target<'a> {
    /// A connection: the batch transaction for [`Kind::Batch`], the writer's own
    /// connection in autocommit for [`Kind::Solo`].
    Conn(&'a Connection),
    /// The writer connection itself plus the queue, for an operation that
    /// replaces the database file.
    Exclusive(&'a mut Exclusive<'a>),
}

/// State a maintenance operation needs: the writer's connection, which it may
/// close and reopen on another file.
pub(crate) struct Exclusive<'a> {
    conn: &'a mut Option<Connection>,
}

/// How a job relates to other work.
#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    /// Telemetry. May share a commit with the jobs around it.
    Batch,
    /// Configuration. Runs alone, so a refusal it produces cannot roll back
    /// anyone else's write.
    Solo,
    /// Replaces the database file or reorganizes it. Runs with readers excluded.
    Exclusive,
}

struct Job {
    kind: Kind,
    /// The database generation this job was accepted against. A job whose
    /// generation is stale is refused instead of being applied to a database
    /// that replaced the one it was written for.
    generation: u64,
    run: Box<dyn for<'a> FnOnce(Target<'a>) -> Result<Payload> + Send>,
    reply: Reply,
}

/// One read connection and the handle that can cancel a query running on it.
struct Reader {
    conn: Mutex<Connection>,
    interrupt: Arc<InterruptHandle>,
}

struct ReaderPool {
    readers: Vec<Reader>,
    cursor: AtomicU64,
}

impl ReaderPool {
    fn new(prototype: &Connection) -> Result<Self> {
        let mut readers = Vec::with_capacity(READERS);
        for _ in 0..READERS {
            let conn = prototype.try_clone()?;
            let interrupt = conn.interrupt_handle();
            readers.push(Reader { conn: Mutex::new(conn), interrupt });
        }
        Ok(Self { readers, cursor: AtomicU64::new(0) })
    }

    /// A pool with no connections, held for the moment a maintenance operation
    /// has the database closed and is renaming files. Nothing can reach it: the
    /// gate is held exclusively for that whole window.
    fn empty() -> Self {
        Self { readers: Vec::new(), cursor: AtomicU64::new(0) }
    }

    /// Runs `f` on a free connection, waiting only if every one is busy.
    ///
    /// `timeout` bounds the work itself rather than the wait: the connection is
    /// interrupted if `f` has not returned by then, so a caller that gave up
    /// cannot leave a scan running for the rest of the day.
    fn query<T>(&self, timeout: Option<Duration>, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let n = self.readers.len();
        if n == 0 {
            anyhow::bail!("数据库正在切换文件，请稍后重试");
        }
        let start = self.cursor.fetch_add(1, Ordering::Relaxed) as usize % n;
        for offset in 0..n {
            let idx = (start + offset) % n;
            if let Ok(guard) = self.readers[idx].conn.try_lock() {
                return Self::run(&self.readers[idx], &guard, timeout, f);
            }
        }
        let idx = start;
        let guard = self.readers[idx].conn.lock().unwrap_or_else(|e| e.into_inner());
        Self::run(&self.readers[idx], &guard, timeout, f)
    }

    fn run<T>(
        reader: &Reader,
        conn: &Connection,
        timeout: Option<Duration>,
        f: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let Some(limit) = timeout else { return f(conn) };
        let (done, wait) = std::sync::mpsc::channel::<()>();
        let interrupt = reader.interrupt.clone();
        let watchdog = std::thread::spawn(move || {
            if wait.recv_timeout(limit).is_err() {
                interrupt.interrupt();
                true
            } else {
                false
            }
        });
        let out = f(conn);
        let _ = done.send(());
        let fired = watchdog.join().unwrap_or(false);
        if fired {
            // The interrupt may have landed after `f` returned. Draining it here
            // keeps it from cancelling whichever query gets this connection next.
            let _ = conn.execute_batch("SELECT 1");
        }
        out
    }
}

/// What the writer thread knows about the small relations its hot-path writes are
/// guarded by, so those guards cost a hash lookup instead of a query.
///
/// Measured in a release build, one row into a 20 000-row table: a plain insert
/// 97 us, the same insert with a correlated `WHERE EXISTS` 1.6 ms, and with
/// `ON CONFLICT DO UPDATE` 1.8 ms. Neither is affordable on the ingest path, and
/// neither is necessary: every mutation of `node`, `ping_node`, `ping_task`,
/// `metric` and `ping_record` runs on this one thread, so the answers are already
/// here.
///
/// The tables keep their primary keys. That is deliberate: the cache decides
/// *which statement* to run, and the key still decides whether an illegal row can
/// exist. A bug here surfaces as a refused transaction rather than as a silent
/// duplicate.
///
/// It is rebuilt from the database whenever a job fails or the file is replaced,
/// so a rolled-back batch cannot leave a stale answer behind.
#[derive(Default)]
struct Guard {
    nodes: HashSet<i64>,
    /// Every (node, task) assignment. Bounded by nodes times probes.
    assignments: HashSet<(i64, i64)>,
    /// node -> the newest minute a metric row was written for.
    minutes: HashMap<i64, i64>,
    /// (node, task) -> the newest stamp a probe result was filed for.
    stamps: HashMap<(i64, i64), i64>,
}

impl Guard {
    /// Rebuilds the cache from the database.
    fn load(conn: &Connection) -> Result<Self> {
        let mut guard = Guard::default();
        let mut stmt = conn.prepare("SELECT id FROM node")?;
        for row in stmt.query_map([], |r| r.get::<_, i64>(0))? {
            guard.nodes.insert(row?);
        }
        let mut stmt = conn.prepare("SELECT node_id, task_id FROM ping_node")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            guard.assignments.insert(row?);
        }
        // Only the newest stamp per key is needed: a later result always has a
        // later stamp, and anything older is treated as a possible duplicate.
        let mut stmt = conn.prepare("SELECT node_id, MAX(ts) FROM metric GROUP BY node_id")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (node, ts) = row?;
            guard.minutes.insert(node, ts);
        }
        let mut stmt =
            conn.prepare("SELECT node_id, task_id, MAX(ts) FROM ping_record GROUP BY node_id, task_id")?;
        for row in
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?
        {
            let (node, task, ts) = row?;
            guard.stamps.insert((node, task), ts);
        }
        Ok(guard)
    }

    /// Forgets everything about one task's assignments.
    fn forget_task(&mut self, task_id: i64) {
        self.assignments.retain(|(_, task)| *task != task_id);
        self.stamps.retain(|(_, task), _| *task != task_id);
    }

    /// Forgets everything about one node.
    fn forget_node(&mut self, node_id: i64) {
        self.nodes.remove(&node_id);
        self.assignments.retain(|(node, _)| *node != node_id);
        self.minutes.remove(&node_id);
        self.stamps.retain(|(node, _), _| *node != node_id);
    }
}

/// How the engine was configured, and where its spill files go.
#[derive(Clone, Debug)]
pub struct Options {
    pub memory_limit: String,
    pub threads: i64,
    pub temp_directory: String,
    pub max_temp_size: String,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            memory_limit: DEFAULT_MEMORY_LIMIT.into(),
            threads: std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(2).min(4),
            temp_directory: String::new(),
            max_temp_size: DEFAULT_MAX_TEMP.into(),
        }
    }
}

pub(crate) struct Inner {
    /// The file this database lives in; empty for an in-memory database.
    path: String,
    /// Held from `open` until `close`, which is what makes the lock a lock.
    lock: Mutex<Option<std::fs::File>>,
    /// Shared with the job closures, which outlive a borrow of `Inner`.
    guard: Arc<Mutex<Guard>>,
    options: Options,
    sender: Mutex<Option<SyncSender<Job>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
    prototype: Mutex<Option<Connection>>,
    readers: RwLock<Arc<ReaderPool>>,
    /// Excludes readers while the file is replaced.
    gate: RwLock<()>,
    /// Advanced by every maintenance operation that replaces the file.
    generation: AtomicU64,
    queued: AtomicU64,
    committed: AtomicU64,
    refused: AtomicU64,
}

impl Inner {
    /// A handle to the writer's relationship cache, so a job closure can carry it
    /// without holding a borrow of `Inner` for its whole life.
    fn guard_handle(&self) -> Arc<Mutex<Guard>> {
        self.guard.clone()
    }

    /// Rebuilds the relationship cache from the database after a job or a commit
    /// failed. Anything else would let a rolled-back write leave a stale answer
    /// behind, and the next statement would be chosen from it.
    fn reload_guard(&self) {
        let Some(conn) =
            self.prototype.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|c| c.try_clone())
        else {
            return;
        };
        match conn.map_err(anyhow::Error::from).and_then(|conn| Guard::load(&conn)) {
            Ok(fresh) => *self.guard.lock().unwrap_or_else(|e| e.into_inner()) = fresh,
            Err(e) => error!("rebuilding the write guard failed: {e:#}"),
        }
    }
}

/// The storage engine. Cheap to clone: every clone shares one writer thread and
/// one read pool.
#[derive(Clone)]
pub struct Db(Arc<Inner>);

impl Db {
    /// The maximum number of probes one node may be assigned. See
    /// [`Db::save_ping_task`].
    pub const MAX_PROBES_PER_NODE: i64 = 64;

    pub fn open(path: &str) -> Result<Self> {
        Self::open_with(path, Options::default())
    }

    pub fn open_with(path: &str, options: Options) -> Result<Self> {
        let memory = path == ":memory:" || path.is_empty();
        // Held for the life of the process. DuckDB locks the database file too,
        // but POSIX advisory locks are per process, so a second hub started from
        // the same process -- or a test that opens the same file twice -- would
        // otherwise get a second, independent database at the same path. This is
        // the check that fails, and it fails before the file is touched.
        let lock = if memory { None } else { Some(exclusive_lock(path)?) };
        // Refused before the engine is handed the file. DuckDB would report a
        // generic "not a valid DuckDB database file" and an operator would have
        // no way to tell a legacy romi database from a corrupt one.
        if !memory {
            refuse_foreign_format(path)?;
        }

        let mut options = options;
        if options.temp_directory.is_empty() {
            options.temp_directory = if memory {
                std::env::temp_dir()
                    .join(format!("romi-spill-{}", std::process::id()))
                    .to_string_lossy()
                    .into_owned()
            } else {
                format!("{path}.tmp")
            };
        }
        std::fs::create_dir_all(&options.temp_directory)
            .with_context(|| format!("creating the spill directory {}", options.temp_directory))?;
        restrict_dir(&options.temp_directory);

        let conn = open_connection(path, &options, false)?;
        let engine = schema::engine_version(&conn)?;
        anyhow::ensure!(
            engine == ENGINE_VERSION,
            "DuckDB 引擎版本为 {engine}，本服务只验证过 {ENGINE_VERSION}；请安装匹配的构建"
        );
        if !memory {
            restrict(path);
        }
        let mut conn = conn;
        // Empty means a file the engine has just created. A file holding other
        // tables is not ours to initialize; `schema::initialize` refuses it.
        let fresh = schema::user_tables(&conn)? == 0;
        schema::initialize(&mut conn, fresh, env!("CARGO_PKG_VERSION"))?;
        // An imported database is stamped when it is built, so this only repairs
        // a counter that somehow lagged the rows -- cheap, and it removes the one
        // way a later insert could collide with an existing id.
        schema::resync_ids(&conn)?;
        checkpoint(&conn)?;

        let inner = Arc::new(Inner {
            path: if memory { String::new() } else { path.to_owned() },
            lock: Mutex::new(lock),
            guard: Arc::new(Mutex::new(Guard::load(&conn)?)),
            options,
            sender: Mutex::new(None),
            writer: Mutex::new(None),
            prototype: Mutex::new(Some(conn.try_clone()?)),
            readers: RwLock::new(Arc::new(ReaderPool::new(&conn)?)),
            gate: RwLock::new(()),
            generation: AtomicU64::new(0),
            queued: AtomicU64::new(0),
            committed: AtomicU64::new(0),
            refused: AtomicU64::new(0),
        });

        let (sender, queue) = sync_channel::<Job>(WRITER_QUEUE);
        // A weak handle, not a strong one: the writer must not keep the database
        // alive by itself. With a strong reference the thread would hold the
        // sender that is supposed to end it, and dropping the last `Db` would
        // leave a thread, a connection and a file lock behind.
        let writer_inner = Arc::downgrade(&inner);
        let handle = std::thread::Builder::new()
            .name("romi-db-writer".into())
            .spawn(move || writer_loop(Some(conn), writer_inner, queue))
            .context("spawning the database writer thread")?;
        *inner.sender.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
        *inner.writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
        info!(
            "duckdb {engine} open on {} ({} reader connections, memory_limit {}, temp {})",
            if memory { ":memory:" } else { path },
            READERS,
            inner.options.memory_limit,
            inner.options.temp_directory
        );
        Ok(Self(inner))
    }

    // ---- plumbing ----

    fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let _guard = self.0.gate.read().unwrap_or_else(|e| e.into_inner());
        let pool = self.0.readers.read().unwrap_or_else(|e| e.into_inner()).clone();
        pool.query(None, f)
    }

    /// A read whose work is bounded in time. Used by the history and
    /// data-page queries, which are the only ones whose cost grows with how much
    /// history an operator has kept.
    fn read_bounded<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let _guard = self.0.gate.read().unwrap_or_else(|e| e.into_inner());
        let pool = self.0.readers.read().unwrap_or_else(|e| e.into_inner()).clone();
        pool.query(Some(QUERY_TIMEOUT), f)
    }

    fn write<T: Send + 'static>(
        &self,
        kind: Kind,
        f: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (reply, rx) = sync_channel(1);
        let job = Job {
            kind,
            generation: self.0.generation.load(Ordering::SeqCst),
            run: Box::new(move |target| match target {
                Target::Conn(conn) => Ok(Box::new(f(conn)?) as Payload),
                Target::Exclusive(_) => unreachable!("a work job is never run exclusively"),
            }),
            reply,
        };
        self.0.queued.fetch_add(1, Ordering::Relaxed);
        let sent = self
            .0
            .sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .ok_or_else(|| anyhow!("数据库已关闭"))
            .and_then(|tx| tx.send(job).map_err(|_| anyhow!("数据库写入线程已退出")));
        if let Err(e) = sent {
            self.0.queued.fetch_sub(1, Ordering::Relaxed);
            return Err(e);
        }
        let out = await_reply(rx);
        if out.is_ok() {
            self.0.committed.fetch_add(1, Ordering::Relaxed);
        }
        out
    }

    /// Runs `f` with the readers stopped and the writer's connection in hand.
    /// See [`Exclusive`].
    fn write_exclusive<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Exclusive<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (reply, rx) = sync_channel(1);
        let job = Job {
            kind: Kind::Exclusive,
            generation: self.0.generation.load(Ordering::SeqCst),
            run: Box::new(move |target| match target {
                Target::Exclusive(ex) => Ok(Box::new(f(ex)?) as Payload),
                Target::Conn(_) => unreachable!("an exclusive job is never run on a batch"),
            }),
            reply,
        };
        self.0.queued.fetch_add(1, Ordering::Relaxed);
        let sent = self
            .0
            .sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .ok_or_else(|| anyhow!("数据库已关闭"))
            .and_then(|tx| tx.send(job).map_err(|_| anyhow!("数据库写入线程已退出")));
        if let Err(e) = sent {
            self.0.queued.fetch_sub(1, Ordering::Relaxed);
            return Err(e);
        }
        let out = await_reply(rx);
        if out.is_ok() {
            self.0.committed.fetch_add(1, Ordering::Relaxed);
        }
        out
    }

    /// The shared cache of relationships the ingest path is guarded by.
    fn guard(&self) -> Arc<Mutex<Guard>> {
        // `Arc<Inner>` is already shared; this returns a second handle to the
        // same mutex so a job closure can carry it.
        self.0.guard_handle()
    }

    /// Stops accepting work, drains what was already accepted, and returns once
    /// the writer has committed it.
    ///
    /// Failure policy: whatever the writer could not commit is reported here and
    /// logged, and the process still exits. Nothing is silently reported as
    /// written.
    pub fn close(&self) -> Result<()> {
        let sender = self.0.sender.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(sender);
        // Released here rather than at the end of the process so a test -- or a
        // supervisor restarting the hub in place -- can open the same file again
        // once this has returned.
        drop(self.0.lock.lock().unwrap_or_else(|e| e.into_inner()).take());
        let handle = self.0.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(handle) = handle else { return Ok(()) };
        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        while !handle.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if !handle.is_finished() {
            warn!(
                "database writer did not finish within {SHUTDOWN_GRACE:?}; pending writes are not committed"
            );
            return Ok(());
        }
        handle.join().map_err(|_| anyhow!("database writer thread panicked"))?;
        Ok(())
    }

    /// Counters that distinguish telemetry queued in memory from telemetry
    /// committed. `queued` is the bounded uncommitted window.
    pub fn queue_stats(&self) -> serde_json::Value {
        serde_json::json!({
            "queued": self.0.queued.load(Ordering::Relaxed),
            "committed": self.0.committed.load(Ordering::Relaxed),
            "superseded": self.0.refused.load(Ordering::Relaxed),
            "capacity": WRITER_QUEUE,
            "batch": BATCH_OPS,
        })
    }

    pub fn engine_version(&self) -> String {
        ENGINE_VERSION.to_owned()
    }

    // ---- settings ----

    pub fn get(&self, key: &str) -> Option<String> {
        self.read(|conn| {
            let mut stmt = conn.prepare("SELECT value FROM setting WHERE key = ?1")?;
            Ok(stmt.query_row([key], |r| r.get::<_, String>(0)).optional()?)
        })
        .ok()
        .flatten()
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let (key, value) = (key.to_owned(), value.to_owned());
        self.write(Kind::Solo, move |conn| {
            conn.prepare(
                "INSERT INTO setting (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            )?
            .execute(params![key, value])?;
            Ok(())
        })
    }

    // ---- nodes ----

    pub fn nodes(&self) -> Result<Vec<Node>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(&format!("SELECT {NODE_COLUMNS} FROM node ORDER BY sort, id"))?;
            let rows = stmt.query_map([], |r| Ok(row_to_node(r)))?;
            Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
        })
    }

    pub fn node(&self, id: i64) -> Result<Option<Node>> {
        self.read(|conn| {
            Ok(conn
                .prepare(&format!("SELECT {NODE_COLUMNS} FROM node WHERE id = ?1"))?
                .query_row([id], |r| Ok(row_to_node(r)))
                .optional()?)
        })
    }

    /// Creates a node and returns its id.
    ///
    /// Both rows or neither: `accumulate` reads the `traffic` row on every
    /// report, so a node lacking one cannot report. The id comes from the
    /// allocator rather than from a rowid, so an id freed by a deletion is not
    /// handed out again -- which is what the SQLite build relied on to keep a
    /// removed machine's history from being inherited (see `delete_node`).
    pub fn create_node(&self, n: &Node, token: &str) -> Result<i64> {
        let n = n.clone();
        let token = token.to_owned();
        let guard = self.guard();
        self.write(Kind::Solo, move |conn| {
            let tx = conn.unchecked_transaction()?;
            let id = alloc_id(&tx, "node")?;
            // A new node belongs at the end. The caller sends sort 0, which would
            // tie with whatever the last reorder placed first.
            tx.execute(
                "INSERT INTO node (id, name, token_hash, sort, public, price, currency, billing_cycle,
                                   expires_at, remark, traffic_limit, traffic_mode, traffic_reset_day,
                                   notify, created_at)
                 VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sort),-1)+1 FROM node),?4,?5,?6,?7,?8,?9,?10,?11,?12,false,?13)",
                params![
                    id,
                    n.name,
                    crate::auth::sha256(&token),
                    n.public,
                    n.price,
                    n.currency,
                    n.billing_cycle,
                    n.expires_at,
                    n.remark,
                    n.traffic_limit,
                    n.traffic_mode,
                    n.traffic_reset_day as i64,
                    Utc::now().timestamp()
                ],
            )?;
            tx.execute("INSERT INTO traffic (node_id) VALUES (?1)", [id])?;
            tx.commit()?;
            guard.lock().unwrap_or_else(|e| e.into_inner()).nodes.insert(id);
            Ok(id)
        })
    }

    /// How many nodes were created at or after `ts`. Bounds what one registration
    /// window can add; see `api::REGISTER_LIMIT`.
    pub fn nodes_created_since(&self, ts: i64) -> Result<i64> {
        self.read(|conn| {
            Ok(conn
                .prepare("SELECT COUNT(*) FROM node WHERE created_at >= ?1")?
                .query_row([ts], |r| r.get(0))?)
        })
    }

    /// Records that the node reported. Written on the same cadence as the metric
    /// row, so it costs one update per minute rather than one per report.
    pub fn touch_seen(&self, id: i64, ts: i64) -> Result<()> {
        self.write(Kind::Batch, move |conn| {
            conn.prepare("UPDATE node SET last_seen=?2 WHERE id=?1")?.execute(params![id, ts])?;
            Ok(())
        })
    }

    pub fn update_node(&self, id: i64, n: &NodePatch) -> Result<()> {
        // `expires_at` is a triple, not an option: omitted leaves the column
        // alone, an explicit null clears it. The flag is what carries the
        // difference into SQL.
        let (set_expiry, expiry) = (n.expires_at.is_some(), n.expires_at.clone().flatten());
        let (name, sort, public, price) = (n.name.clone(), n.sort, n.public, n.price);
        let (currency, cycle, remark) = (n.currency.clone(), n.billing_cycle.clone(), n.remark.clone());
        let (limit, mode, day, notify) =
            (n.traffic_limit, n.traffic_mode.clone(), n.traffic_reset_day, n.notify);
        self.write(Kind::Solo, move |conn| {
            conn.prepare(
                "UPDATE node SET name=COALESCE(?2,name), sort=COALESCE(?3,sort), public=COALESCE(?4,public),
                                 price=COALESCE(?5,price), currency=COALESCE(?6,currency),
                                 billing_cycle=COALESCE(?7,billing_cycle),
                                 expires_at=CASE WHEN ?8 THEN ?9 ELSE expires_at END,
                                 remark=COALESCE(?10,remark), traffic_limit=COALESCE(?11,traffic_limit),
                                 traffic_mode=COALESCE(?12,traffic_mode),
                                 traffic_reset_day=COALESCE(?13,traffic_reset_day),
                                 notify=COALESCE(?14,notify)
                 WHERE id=?1",
            )?
            .execute(params![
                id,
                name,
                sort,
                public,
                price,
                currency,
                cycle,
                set_expiry,
                expiry,
                remark,
                limit,
                mode,
                day.map(|d| d as i64),
                notify
            ])?;
            Ok(())
        })
    }

    pub fn set_expiry(&self, id: i64, date: &str) -> Result<()> {
        let date = date.to_owned();
        self.write(Kind::Solo, move |conn| {
            conn.execute("UPDATE node SET expires_at=?2 WHERE id=?1", params![id, date])?;
            Ok(())
        })
    }

    pub fn set_down_since(&self, id: i64, ts: i64) -> Result<()> {
        self.write(Kind::Solo, move |conn| {
            conn.execute("UPDATE node SET down_since=?2 WHERE id=?1", params![id, ts])?;
            Ok(())
        })
    }

    pub fn reorder_nodes(&self, ids: &[i64]) -> Result<()> {
        let unique: HashSet<_> = ids.iter().collect();
        if unique.len() != ids.len() {
            anyhow::bail!("node order contains duplicates");
        }
        let ids = ids.to_vec();
        self.write(Kind::Solo, move |conn| {
            let tx = conn.unchecked_transaction()?;
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM node", [], |r| r.get(0))?;
            if count as usize != ids.len() {
                anyhow::bail!("node order must include every node");
            }
            for (sort, id) in ids.iter().enumerate() {
                if tx.execute("UPDATE node SET sort=?2 WHERE id=?1", params![id, sort as i64])? != 1 {
                    anyhow::bail!("node order contains an unknown node");
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Deletes a node and every row that belongs to it, in one transaction.
    ///
    /// DuckDB has no `ON DELETE CASCADE` -- its parser rejects the clause and its
    /// foreign-key check does not observe child deletes made earlier in the same
    /// transaction -- so the cascade is written out here instead of being
    /// declared. The order matters: the child rows go first, and the whole thing
    /// is one transaction, so a failure leaves the node intact rather than
    /// half-deleted.
    ///
    /// `ping_record` and `metric` are keyed by `node_id`, and a fresh node now
    /// receives a **new** id from the allocator rather than reusing the deleted
    /// one, so the sweep is what keeps a removed machine's history from being
    /// inherited even before the rows are considered.
    pub fn delete_node(&self, id: i64) -> Result<()> {
        let guard = self.guard();
        self.write(Kind::Solo, move |conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM ping_record WHERE node_id = ?1", [id])?;
            tx.execute("DELETE FROM metric WHERE node_id = ?1", [id])?;
            tx.execute("DELETE FROM traffic WHERE node_id = ?1", [id])?;
            tx.execute("DELETE FROM ping_node WHERE node_id = ?1", [id])?;
            tx.execute("DELETE FROM node WHERE id = ?1", [id])?;
            tx.commit()?;
            guard.lock().unwrap_or_else(|e| e.into_inner()).forget_node(id);
            Ok(())
        })
    }

    /// Replaces a node's token, which immediately locks out the old one.
    pub fn reset_token(&self, id: i64, token: &str) -> Result<()> {
        let hash = crate::auth::sha256(token);
        self.write(Kind::Solo, move |conn| {
            conn.execute("UPDATE node SET token_hash=?2 WHERE id=?1", params![id, hash])?;
            Ok(())
        })
    }

    pub fn node_by_token(&self, token: &str) -> Result<Option<i64>> {
        let hash = crate::auth::sha256(token);
        self.read(move |conn| {
            Ok(conn
                .prepare("SELECT id FROM node WHERE token_hash = ?1")?
                .query_row([hash], |r| r.get::<_, i64>(0))
                .optional()?)
        })
    }

    /// Stores the slow-changing facts an agent sends on connect, and reports
    /// whether the node still requires a country lookup.
    ///
    /// A new address invalidates the previous country, so the two move together in
    /// one statement: `SET` reads the row as it was, so the comparison is against
    /// the stored address rather than the one being written.
    pub fn save_facts(&self, id: i64, f: &serde_json::Value, ip: &str) -> Result<bool> {
        // The same rule `api::agent_register` applies to the name it receives:
        // these values come from an unvouched machine, control characters break
        // the panel's rows, and the length must be bounded. Six of them -- os,
        // kernel, arch, virt, cpu_name, agent_version -- go straight into the
        // anonymous public frame, which is rebuilt and pushed to every viewer
        // every two seconds, so without a ceiling one node would determine that
        // frame's size.
        let s = |k: &str| {
            f.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .filter(|c| !c.is_control())
                .take(128)
                .collect::<String>()
        };
        let n = |k: &str| f.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        let ip = ip.to_owned();
        let hostname = s("hostname");
        let os = s("os");
        let kernel = s("kernel");
        let arch = s("arch");
        let virt = s("virt");
        let cpu_name = s("cpu_name");
        let (cores, mem, swap, disk) = (n("cpu_cores"), n("mem_total"), n("swap_total"), n("disk_total"));
        let agent_version = s("agent_version");
        let (ipv4, ipv6) = (s("ipv4"), s("ipv6"));
        self.write(Kind::Solo, move |conn| {
            conn.prepare(
                "UPDATE node SET hostname=?2, os=?3, kernel=?4, arch=?5, virt=?6, cpu_name=?7,
                                 cpu_cores=?8, mem_total=?9, swap_total=?10, disk_total=?11,
                                 agent_version=?12, ip=?13, ipv4=?14, ipv6=?15,
                                 country=CASE WHEN ip=?13 THEN country ELSE '' END
                 WHERE id=?1",
            )?
            .execute(params![
                id,
                hostname,
                os,
                kernel,
                arch,
                virt,
                cpu_name,
                cores,
                mem,
                swap,
                disk,
                agent_version,
                ip,
                ipv4,
                ipv6
            ])?;
            Ok(conn.prepare("SELECT country = '' FROM node WHERE id=?1")?.query_row([id], |r| r.get(0))?)
        })
    }

    /// Records the country a lookup returned, unless the node moved to another
    /// address while the lookup was outstanding.
    pub fn set_country(&self, id: i64, cc: &str, ip: &str) -> Result<()> {
        let (cc, ip) = (cc.to_owned(), ip.to_owned());
        self.write(Kind::Solo, move |conn| {
            conn.prepare("UPDATE node SET country=?2 WHERE id=?1 AND ip=?3")?.execute(params![id, cc, ip])?;
            Ok(())
        })
    }

    // ---- traffic ----

    /// Every node's counters in one query, because the node list renders a row per
    /// node and a query per node would queue the agents' writes behind it.
    ///
    /// The period counters are gated on the period they were written for. They
    /// restart lazily in `accumulate`, on the node's next report, so a node
    /// offline since before a boundary still holds the previous period's bytes on
    /// disk. This is the only reader, so the rule lives in one place.
    pub fn all_traffic(&self) -> HashMap<i64, Traffic> {
        let rows = self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT t.node_id, t.total_rx, t.total_tx, t.month_rx, t.month_tx, t.month_start,
                        t.day_rx, t.day_tx, t.day_start, n.traffic_reset_day
                 FROM traffic t JOIN node n ON n.id = t.node_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, i64>(9)?,
                ))
            })?;
            Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
        });
        let Ok(rows) = rows else {
            // A failed read here is not worth failing the page over; the caller
            // renders zeros and the log carries the reason.
            warn!("reading traffic failed");
            return HashMap::new();
        };
        let today = Local::now().date_naive();
        let day = today.to_string();
        rows.into_iter()
            .map(|(id, total_rx, total_tx, m_rx, m_tx, m_start, d_rx, d_tx, d_start, reset_day)| {
                // Zero rather than absent: a theme drawing a meter requires a
                // number.
                let current = |stored: &str, now: &str, rx: i64, tx: i64| {
                    if stored == now {
                        (rx, tx)
                    } else {
                        (0, 0)
                    }
                };
                let period = period_start(today, reset_day.max(1) as u32).to_string();
                let (month_rx, month_tx) = current(&m_start, &period, m_rx, m_tx);
                let (day_rx, day_tx) = current(&d_start, &day, d_rx, d_tx);
                (id, Traffic { total_rx, total_tx, month_rx, month_tx, month_start: period, day_rx, day_tx })
            })
            .collect()
    }

    /// Folds one report's raw kernel counters into the node's running totals.
    ///
    /// A changed boot_id, or a counter that moved backwards, means the kernel
    /// restarted its counting; the total must not follow it downward. `None`
    /// denotes a report carrying no readable counters at all.
    ///
    /// The read-modify-write runs inside the writer's transaction, so two
    /// connections reporting for the same node cannot interleave and lose a
    /// delta -- and no lock is held across a wait.
    pub fn accumulate(&self, node_id: i64, boot_id: &str, counters: Option<(i64, i64)>) -> Result<Traffic> {
        let boot_id = boot_id.to_owned();
        let guard = self.guard();
        self.write(Kind::Batch, move |conn| {
            if !guard.lock().unwrap_or_else(|e| e.into_inner()).nodes.contains(&node_id) {
                anyhow::bail!("节点 {node_id} 已不存在，这次上报没有计入");
            }
            accumulate_on(conn, node_id, &boot_id, counters)
        })
    }

    /// Allows the panel to correct a total, for example after moving a node to
    /// new hardware.
    ///
    /// The corrected month figures are stamped with the current period; otherwise
    /// they would belong to whichever period the row still held, `all_traffic`
    /// would read them back as zero, and the node's next report would restart the
    /// counter and discard the correction.
    pub fn set_traffic(&self, node_id: i64, p: &TrafficPatch) -> Result<()> {
        let (total_rx, total_tx, month_rx, month_tx) = (p.total_rx, p.total_tx, p.month_rx, p.month_tx);
        self.write(Kind::Solo, move |conn| {
            let reset_day: i64 =
                conn.query_row("SELECT traffic_reset_day FROM node WHERE id=?1", [node_id], |r| r.get(0))?;
            let period = period_start(Local::now().date_naive(), reset_day.max(1) as u32).to_string();
            conn.execute(
                "UPDATE traffic SET total_rx=COALESCE(?2,total_rx), total_tx=COALESCE(?3,total_tx),
                     month_rx=COALESCE(?4,CASE WHEN month_start=?6 THEN month_rx ELSE 0 END),
                     month_tx=COALESCE(?5,CASE WHEN month_start=?6 THEN month_tx ELSE 0 END), month_start=?6
                 WHERE node_id=?1",
                params![node_id, total_rx, total_tx, month_rx, month_tx, period],
            )?;
            Ok(())
        })
    }

    // ---- metrics ----

    pub fn insert_metric(&self, node_id: i64, ts: i64, m: &serde_json::Value) -> Result<()> {
        let f = |k: &str| m.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let n = |k: &str| m.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        let row = (
            f("cpu"),
            n("mem_used"),
            n("swap_used"),
            n("disk_used"),
            n("net_rx"),
            n("net_tx"),
            n("tcp"),
            n("udp"),
            n("procs"),
        );
        let guard = self.guard();
        self.write(Kind::Batch, move |conn| {
            let mut known = guard.lock().unwrap_or_else(|e| e.into_inner());
            // A report that was in flight when its node was deleted, or when a
            // restore replaced the database, must not create a row for a node
            // that is no longer there. `guard` knows because every deletion went
            // through this same thread.
            if !known.nodes.contains(&node_id) {
                return Ok(());
            }
            if known.minutes.get(&node_id) == Some(&ts) {
                // The minute this report describes has already been written --
                // the agent reconnected inside it -- so the row is replaced. The
                // primary key makes that the only legal way to write it twice.
                conn.prepare("DELETE FROM metric WHERE node_id=?1 AND ts=?2")?
                    .execute(params![node_id, ts])?;
            }
            conn.prepare(
                "INSERT INTO metric
                   (node_id, ts, cpu, mem_used, swap_used, disk_used, net_rx, net_tx, tcp, udp, procs)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            )?
            .execute(params![node_id, ts, row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8])?;
            let newest = known.minutes.entry(node_id).or_insert(ts);
            *newest = (*newest).max(ts);
            Ok(())
        })
    }

    /// History for one node, thinned to one sample every `step` seconds.
    ///
    /// Bucketed rather than filtered on a multiple of `step`: rows normally land
    /// on the minute, but nothing enforces it, and a filter would return nothing
    /// for a stamp falling between grid lines.
    ///
    /// Averaged over the bucket rather than sampled from it, and truncated rather
    /// than rounded: DuckDB's `CAST(double AS BIGINT)` rounds to nearest while
    /// SQLite's truncated, so the truncation is written out with `TRUNC` and the
    /// integer division with `//` -- `/` in DuckDB is floating-point division and
    /// would leave the bucket arithmetic to floating point.
    pub fn metrics(&self, node_id: i64, since: i64, step: i64) -> Result<Vec<serde_json::Value>> {
        self.read_bounded(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT (MIN(ts)//?3)*?3, AVG(cpu), CAST(TRUNC(AVG(mem_used)) AS BIGINT),
                        CAST(TRUNC(AVG(disk_used)) AS BIGINT),
                        CAST(TRUNC(AVG(net_rx)) AS BIGINT), CAST(TRUNC(AVG(net_tx)) AS BIGINT)
                 FROM metric WHERE node_id=?1 AND ts>=?2 GROUP BY ts//?3 ORDER BY (MIN(ts)//?3)*?3",
            )?;
            let rows = stmt.query_map(params![node_id, since, step], |r| {
                Ok(serde_json::json!({
                    "ts": r.get::<_, i64>(0)?, "cpu": r.get::<_, f64>(1)?,
                    "mem_used": r.get::<_, i64>(2)?, "disk_used": r.get::<_, i64>(3)?,
                    "net_rx": r.get::<_, i64>(4)?, "net_tx": r.get::<_, i64>(5)?,
                }))
            })?;
            Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
        })
    }

    /// Drops history beyond the retention window. Traffic totals live in their
    /// own table precisely so history can be pruned freely.
    pub fn prune(&self, keep_days: i64) -> Result<usize> {
        let cutoff = Utc::now().timestamp() - keep_days * 86_400;
        self.write(Kind::Solo, move |conn| {
            let tx = conn.unchecked_transaction()?;
            let a = tx.execute("DELETE FROM metric WHERE ts < ?1", [cutoff])?;
            let b = tx.execute("DELETE FROM ping_record WHERE ts < ?1", [cutoff])?;
            tx.commit()?;
            Ok(a + b)
        })
    }

    // ---- ping ----

    pub fn ping_tasks(&self) -> Result<Vec<PingTask>> {
        self.read(|conn| {
            let mut stmt = conn.prepare("SELECT id, name, target, interval FROM ping_task ORDER BY id")?;
            let mut tasks: Vec<PingTask> = stmt
                .query_map([], |r| {
                    Ok(PingTask {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        target: r.get(2)?,
                        interval: r.get(3)?,
                        nodes: Vec::new(),
                    })
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            drop(stmt);
            let mut stmt = conn.prepare("SELECT node_id FROM ping_node WHERE task_id=?1")?;
            for task in &mut tasks {
                task.nodes = stmt.query_map([task.id], |r| r.get(0))?.collect::<duckdb::Result<Vec<_>>>()?;
            }
            Ok(tasks)
        })
    }

    /// The assignments are replaced wholesale, so they run in one transaction:
    /// failing between the delete and the inserts would unassign every node from
    /// a probe the panel still lists them under.
    ///
    /// Every relationship the old foreign keys expressed is checked here instead,
    /// inside the same transaction: the node must exist, the assignment must not
    /// be repeated, and no node may end up over the agent's probe ceiling. Each
    /// refusal rolls the whole edit back, so a rejected task leaves no partial
    /// assignment behind.
    pub fn save_ping_task(&self, t: &PingTask) -> Result<i64> {
        let t = t.clone();
        let limit = Self::MAX_PROBES_PER_NODE;
        let guard = self.guard();
        self.write(Kind::Solo, move |conn| {
            let tx = conn.unchecked_transaction()?;
            let id = if t.id > 0 {
                if tx.execute(
                    "UPDATE ping_task SET name=?2, target=?3, interval=?4 WHERE id=?1",
                    params![t.id, t.name, t.target, t.interval],
                )? != 1
                {
                    anyhow::bail!("探测任务 {} 不存在", t.id);
                }
                t.id
            } else {
                let id = alloc_id(&tx, "ping_task")?;
                tx.execute(
                    "INSERT INTO ping_task (id, name, target, interval) VALUES (?1,?2,?3,?4)",
                    params![id, t.name, t.target, t.interval],
                )?;
                id
            };
            tx.execute("DELETE FROM ping_node WHERE task_id=?1", [id])?;
            let mut seen = HashSet::new();
            for node in &t.nodes {
                if !seen.insert(*node) {
                    anyhow::bail!("节点 {node} 被重复分配");
                }
                // The application-level replacement for the foreign key DuckDB
                // cannot cascade: naming the node turns a missing parent into
                // something the panel can show.
                if tx.query_row("SELECT COUNT(*) FROM node WHERE id=?1", [node], |r| r.get::<_, i64>(0))? == 0
                {
                    anyhow::bail!("节点 {node} 不存在");
                }
                tx.execute("INSERT INTO ping_node (task_id, node_id) VALUES (?1,?2)", params![id, node])?;
            }
            // Queried from the table after the rows are in rather than counted
            // from the request: an update replaces this task's own assignments,
            // so arithmetic on the way in would have to subtract them again.
            let crowded: Option<i64> = tx
                .query_row(
                    "SELECT node_id FROM ping_node GROUP BY node_id HAVING COUNT(*) > ?1 LIMIT 1",
                    [limit],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(node) = crowded {
                anyhow::bail!(
                    "节点 {node} 会被分配超过 {limit} 个探测任务，agent 最多只跑这么多，多出来的会被静默丢掉"
                );
            }
            tx.commit()?;
            let mut known = guard.lock().unwrap_or_else(|e| e.into_inner());
            known.forget_task(id);
            for node in &t.nodes {
                known.assignments.insert((*node, id));
            }
            Ok(id)
        })
    }

    /// Deletes a probe and the results filed under it, in one transaction.
    ///
    /// The sweep is what keeps a late result from being inherited: a new probe now
    /// receives a fresh id from the allocator rather than reusing the deleted one,
    /// and `insert_ping` refuses any result whose assignment is gone.
    pub fn delete_ping_task(&self, id: i64) -> Result<()> {
        let guard = self.guard();
        self.write(Kind::Solo, move |conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM ping_record WHERE task_id = ?1", [id])?;
            tx.execute("DELETE FROM ping_node WHERE task_id = ?1", [id])?;
            tx.execute("DELETE FROM ping_task WHERE id=?1", [id])?;
            tx.commit()?;
            guard.lock().unwrap_or_else(|e| e.into_inner()).forget_task(id);
            Ok(())
        })
    }

    /// The task list pushed to one agent.
    ///
    /// Ordered, because the agent keeps the first
    /// [`Self::MAX_PROBES_PER_NODE`] as its backstop against a hub requesting
    /// hundreds. Unordered, a list at that boundary could yield a different
    /// subset on each push, restarting half the timers each time.
    pub fn ping_tasks_for(&self, node_id: i64) -> Result<Vec<serde_json::Value>> {
        self.read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.target, t.interval FROM ping_task t
                 JOIN ping_node n ON n.task_id = t.id WHERE n.node_id = ?1 ORDER BY t.id",
            )?;
            let rows = stmt.query_map([node_id], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?, "target": r.get::<_, String>(1)?,
                    "interval": r.get::<_, i64>(2)?
                }))
            })?;
            Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
        })
    }

    /// Probe names keyed by id, for labelling one node's latency chart. Names
    /// only: targets and node assignments remain behind `Admin`, and only probes
    /// assigned to that node are named.
    pub fn ping_task_names(&self, node_id: i64) -> Result<serde_json::Value> {
        self.read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name FROM ping_task WHERE id IN (SELECT task_id FROM ping_node WHERE node_id=?1) ORDER BY id",
            )?;
            let rows = stmt.query_map([node_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            let mut names = serde_json::Map::new();
            for row in rows {
                let (id, name) = row?;
                names.insert(id.to_string(), serde_json::json!(name));
            }
            Ok(serde_json::Value::Object(names))
        })
    }

    /// Files one probe result, and only under a probe this node is assigned.
    ///
    /// The assignment is tested inside the statement because that is the only
    /// place it is atomic with the write. Two cases arrive without an assignment:
    /// a result already in flight when the panel deleted its probe, and a node
    /// token in the wrong hands -- every other write an agent can cause is
    /// bounded, while `task_id` is chosen by the reporter.
    pub fn insert_ping(&self, node_id: i64, task_id: i64, ts: i64, latency: i64) -> Result<()> {
        let guard = self.guard();
        self.write(Kind::Batch, move |conn| {
            let mut known = guard.lock().unwrap_or_else(|e| e.into_inner());
            // Only under a probe this node is assigned. Tested here rather than in
            // the statement because the assignment table is small and already
            // known: the `WHERE EXISTS` that replaces it costs sixteen times what
            // the insert does.
            if !known.assignments.contains(&(node_id, task_id)) {
                return Ok(());
            }
            let key = (node_id, task_id);
            if known.stamps.get(&key).is_some_and(|newest| *newest >= ts) {
                conn.prepare("DELETE FROM ping_record WHERE node_id=?1 AND ts=?2 AND task_id=?3")?
                    .execute(params![node_id, ts, task_id])?;
            }
            conn.prepare("INSERT INTO ping_record (node_id, task_id, ts, latency) VALUES (?1,?2,?3,?4)")?
                .execute(params![node_id, task_id, ts, latency])?;
            let newest = known.stamps.entry(key).or_insert(ts);
            *newest = (*newest).max(ts);
            Ok(())
        })
    }

    /// Probe results for one node, one sample per probe per `step` seconds: the
    /// bucket's median round trip, its range, and the proportion lost.
    ///
    /// [`PING_ROWS`] returns rows in time order, so a bucket is complete the
    /// moment the next opens and only one is held at a time.
    ///
    /// Returns the buckets and, alongside them, the proportion of the whole
    /// window each probe lost. The latter cannot be recovered from the former:
    /// [`close_bucket`] divides within each bucket and keeps only the quotient,
    /// so averaging those percentages would weight a bucket holding one sample
    /// equally with one holding twelve. Probes that lost nothing are omitted, as
    /// `loss` is per bucket.
    pub fn ping_records(
        &self,
        node_id: i64,
        since: i64,
        step: i64,
    ) -> Result<(Vec<serde_json::Value>, serde_json::Value)> {
        self.read_bounded(move |conn| {
            let mut stmt = conn.prepare(PING_ROWS)?;
            let mut rows = stmt.query(params![node_id, since, step])?;
            let mut out = Vec::new();
            // Per probe in the bucket being filled: what answered, and how many
            // did not.
            let mut open: Vec<(i64, Vec<i64>, i64)> = Vec::new();
            // Per probe across the whole window: how many were lost, out of how
            // many.
            let mut totals: HashMap<i64, (i64, i64)> = HashMap::new();
            let mut bucket = 0;
            while let Some(row) = rows.next()? {
                let (b, task, latency) =
                    (row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?);
                if b != bucket {
                    close_bucket(&mut out, &mut open, bucket * step);
                    bucket = b;
                }
                let seen = totals.entry(task).or_insert((0, 0));
                seen.1 += 1;
                let probe = match open.iter().position(|(id, ..)| *id == task) {
                    Some(at) => &mut open[at],
                    None => {
                        open.push((task, Vec::new(), 0));
                        open.last_mut().expect("just pushed")
                    }
                };
                // A timeout is stored as -1: excluded from the median and counted
                // instead.
                if latency < 0 {
                    probe.2 += 1;
                    seen.0 += 1;
                } else {
                    probe.1.push(latency);
                }
            }
            close_bucket(&mut out, &mut open, bucket * step);
            // Unrounded: the caller decides how to render it, and rounding here
            // would turn 0.14% into the 0% that denotes no loss at all.
            let loss: serde_json::Map<String, serde_json::Value> = totals
                .into_iter()
                .filter(|(_, (lost, _))| *lost > 0)
                .map(|(task, (lost, samples))| {
                    (task.to_string(), serde_json::json!(100.0 * lost as f64 / samples as f64))
                })
                .collect();
            Ok((out, serde_json::Value::Object(loss)))
        })
    }

    // ---- the database file itself ----

    /// The file this database is open on, empty for `:memory:`.
    pub fn file(&self) -> String {
        self.0.path.clone()
    }

    /// The retention window used by both `prune` and the data page. Stored as
    /// text by the settings form, so a missing or unparsable value falls back to
    /// the default rather than erroring.
    pub fn retention_days(&self) -> i64 {
        self.get("retention_days").and_then(|v| v.parse::<i64>().ok()).unwrap_or(7).clamp(1, 3_650)
    }

    /// What the panel's data page reads: how much space the file occupies, how
    /// much of that DuckDB reports as reusable, and how far back the history
    /// actually reaches.
    ///
    /// `oldest` against `retention` is the one pair here that can indicate a
    /// fault: history older than the window means `prune` has not been running.
    pub fn stats(&self) -> Result<serde_json::Value> {
        let retention = self.retention_days();
        let file = self.file();
        let engine = ENGINE_VERSION.to_owned();
        let options = self.0.options.clone();
        let counts = self.read_bounded(|conn| {
            let oldest: Option<i64> = conn.query_row(
                "SELECT MIN(ts) FROM (SELECT MIN(ts) AS ts FROM metric UNION ALL SELECT MIN(ts) AS ts FROM ping_record)",
                [],
                |r| r.get(0),
            )?;
            let mut rows = serde_json::Map::new();
            for table in TABLES {
                let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
                rows.insert(table.to_owned(), serde_json::json!(n));
            }
            let schema: Option<i64> = conn
                .query_row("SELECT version FROM romi_schema WHERE id=1", [], |r| r.get(0))
                .optional()?;
            // Reusable space inside the file, in bytes. DuckDB reports blocks;
            // the block size is the multiplier. Absent for an in-memory database.
            let (block, free) = if file.is_empty() {
                (0i64, 0i64)
            } else {
                conn.query_row("SELECT block_size, free_blocks FROM pragma_database_size()", [], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })?
            };
            Ok((oldest, serde_json::Value::Object(rows), schema, block, free))
        })?;
        let (oldest, rows, schema, block, free) = counts;
        Ok(serde_json::json!({
            "path": file,
            "engine": engine,
            "schema": schema,
            "size": bytes_of(&file),
            "wal": bytes_of(&format!("{file}.wal")),
            "free": block * free,
            "oldest": oldest,
            "retention": retention,
            "rows": rows,
            "memory_limit": options.memory_limit,
            "threads": options.threads,
            "temp_directory": options.temp_directory,
            "queue": self.queue_stats(),
        }))
    }

    /// Writes a consistent, data-only copy of the live database to `dest`.
    ///
    /// The format is a gzipped tar of one Parquet file per table plus a
    /// `manifest.json` describing the application schema version, the engine that
    /// wrote it, and the row count and SHA-256 of every member. It is not a copy
    /// of the database file: DuckDB's file is only consistent together with its
    /// WAL, and a restored catalogue would carry whatever the archive put there.
    /// See `db::backup`.
    pub fn backup_into(&self, dest: &str) -> Result<BackupReport> {
        let dest = dest.to_owned();
        self.write_exclusive(move |ex| backup::write_archive(ex.conn, &dest))
    }

    /// Validates an uploaded archive and reports what it holds. Nothing is built
    /// and nothing is touched: a caller that only wants to know whether a file is
    /// a usable backup can ask here.
    pub fn check_backup(&self, src: &str) -> Result<BackupReport> {
        backup::inspect(src)
    }

    /// Replaces the live database with an uploaded backup.
    ///
    /// The candidate is validated and rebuilt into a **new** database before the
    /// live one is touched, the switch happens under the maintenance barrier, and
    /// the previous file is kept until the new one is open and answering. On any
    /// failure the original is put back and remains the database in service.
    ///
    /// Every session in the restored file is dropped: a backup carries the
    /// session rows it held when it was taken, and restoring it must not revive
    /// logged-out logins.
    pub fn restore_from(&self, src: &str) -> Result<BackupReport> {
        let src = src.to_owned();
        let inner = self.0.clone();
        self.write_exclusive(move |ex| backup::restore(ex, &inner, &src))
    }

    /// Retention deletion, WAL checkpoint, and -- when the file still holds
    /// enough reusable space to be worth it -- a real compaction by copying the
    /// database into a fresh file and switching to it.
    ///
    /// `freed` is measured, never estimated: it is the difference between the
    /// bytes on disk before and after. `VACUUM` alone cannot produce it, because
    /// DuckDB documents that it does not reclaim space; only `CHECKPOINT` plus a
    /// copy does.
    pub fn maintenance(&self, keep_days: i64) -> Result<MaintenanceReport> {
        let pruned = self.prune(keep_days)?;
        let inner = self.0.clone();
        self.write_exclusive(move |ex| backup::compact(ex, &inner, pruned))
    }

    // ---- sessions ----

    pub fn create_session(&self, token_hash: &str, expires_at: i64) -> Result<()> {
        let hash = token_hash.to_owned();
        self.write(Kind::Solo, move |conn| {
            conn.execute(
                "INSERT INTO session (token_hash, expires_at) VALUES (?1, ?2)
                 ON CONFLICT (token_hash) DO UPDATE SET expires_at = excluded.expires_at",
                params![hash, expires_at],
            )?;
            Ok(())
        })
    }

    pub fn session_valid(&self, token_hash: &str) -> bool {
        let hash = token_hash.to_owned();
        self.read(move |conn| {
            Ok(conn
                .prepare("SELECT 1 FROM session WHERE token_hash=?1 AND expires_at > ?2")?
                .query_row(params![hash, Utc::now().timestamp()], |_| Ok(()))
                .optional()?
                .is_some())
        })
        .unwrap_or(false)
    }

    /// Live sessions, newest first. Expired rows are filtered here rather than
    /// left to `expire_sessions`, which sweeps only once an hour.
    pub fn sessions(&self) -> Result<Vec<(String, i64)>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT token_hash, expires_at FROM session WHERE expires_at > ?1 ORDER BY expires_at DESC",
            )?;
            let rows = stmt
                .query_map([Utc::now().timestamp()], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<duckdb::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn drop_session(&self, token_hash: &str) -> Result<()> {
        let hash = token_hash.to_owned();
        self.write(Kind::Solo, move |conn| {
            conn.execute("DELETE FROM session WHERE token_hash=?1", [hash])?;
            Ok(())
        })
    }

    /// Invalidates every login. Used when the admin password changes, and after a
    /// restore.
    pub fn drop_all_sessions(&self) -> Result<()> {
        self.write(Kind::Solo, move |conn| {
            conn.execute("DELETE FROM session", [])?;
            Ok(())
        })
    }

    pub fn expire_sessions(&self) -> Result<()> {
        self.write(Kind::Solo, move |conn| {
            conn.execute("DELETE FROM session WHERE expires_at <= ?1", [Utc::now().timestamp()])?;
            Ok(())
        })
    }

    /// Offline import of a legacy SQLite export. See `db::legacy`.
    pub fn import_legacy(export: &str, dest: &str) -> Result<ImportReport> {
        legacy::import(export, dest)
    }

    /// Runs one statement on the writer thread. Test-only: it exists so the tests
    /// can put a row into a state the public API has no reason to produce (a
    /// billing period that ended in 1999, a counter a reboot would have reset).
    /// No production path executes caller-supplied SQL, which is also why there
    /// is no route that reaches this.
    #[cfg(test)]
    pub(crate) fn exec(&self, sql: &str) -> Result<()> {
        let sql = sql.to_owned();
        self.write(Kind::Solo, move |conn| {
            conn.execute_batch(&sql)?;
            Ok(())
        })
    }

    /// The shared state, for the test that drives a failed file switch.
    #[cfg(test)]
    pub(crate) fn inner_handle(&self) -> Arc<Inner> {
        self.0.clone()
    }

    /// One scalar, read on a pooled connection. Test-only, like [`Db::exec`].
    #[cfg(test)]
    pub(crate) fn scalar(&self, sql: &str) -> Result<i64> {
        let sql = sql.to_owned();
        self.read(move |conn| Ok(conn.query_row(&sql, [], |r| r.get::<_, i64>(0))?))
    }
}

/// The rows behind the latency chart: one node's probe results over a window,
/// bucketed and in time order. Everything the chart draws is folded out of them
/// in [`close_bucket`].
///
/// `//` rather than `/`: DuckDB's `/` is floating-point division, and a bucket
/// index that arrived as a float would make `bucket * step` a float too.
pub const PING_ROWS: &str = "SELECT ts//?3, task_id, latency FROM ping_record
     WHERE node_id=?1 AND ts>=?2
           AND task_id IN (SELECT task_id FROM ping_node WHERE node_id=?1)
     ORDER BY ts";

/// Every column of `node`, in the order [`row_to_node`] reads them. Spelled out
/// rather than `SELECT *` so a schema change cannot silently shift a field into
/// the wrong slot.
const NODE_COLUMNS: &str = "id, name, token_hash, sort, public, price, currency, billing_cycle, \
     expires_at, remark, traffic_limit, traffic_mode, traffic_reset_day, hostname, os, kernel, arch, \
     virt, cpu_name, cpu_cores, mem_total, swap_total, disk_total, agent_version, ip, ipv4, ipv6, \
     country, last_seen, notify, down_since, created_at";

/// Ends the writer thread's loop: the queue is empty and no sender is left.
fn writer_loop(mut conn: Option<Connection>, inner: std::sync::Weak<Inner>, queue: Receiver<Job>) {
    let mut deferred: Option<Job> = None;
    loop {
        let first = match deferred.take() {
            Some(job) => job,
            None => match queue.recv() {
                Ok(job) => job,
                // Every sender is gone and the queue is drained: nothing accepted
                // is left uncommitted.
                Err(_) => break,
            },
        };
        // Held for the duration of one job or batch. It cannot fail while work is
        // pending -- the caller waiting for the reply owns a `Db` -- so this only
        // ends the loop once the last handle is gone.
        let Some(inner) = inner.upgrade() else { break };
        match first.kind {
            Kind::Batch => {
                let mut batch = vec![first];
                while batch.len() < BATCH_OPS {
                    match queue.try_recv() {
                        Ok(job) if job.kind == Kind::Batch => batch.push(job),
                        Ok(job) => {
                            deferred = Some(job);
                            break;
                        }
                        Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
                    }
                }
                run_batch(&mut conn, &inner, batch);
            }
            Kind::Solo => run_one(&conn, &inner, first),
            Kind::Exclusive => run_exclusive(&mut conn, &inner, &queue, first),
        }
        drop(inner);
    }
    if let Some(conn) = conn.as_ref() {
        // Folds the WAL into the main file so the next start does not have to
        // replay it. Best effort: the data is already committed.
        if let Err(e) = checkpoint(conn) {
            warn!("final checkpoint failed: {e:#}");
        }
    }
}

/// One transaction for the whole batch, then one reply per job.
///
/// The replies go out only after `COMMIT` returns: a caller that was told its
/// write succeeded has a committed row behind it. A batch whose commit fails
/// reports the failure to every job it carried -- telemetry is re-sent by the
/// agent on its next report, and the alternative, acknowledging a write that did
/// not happen, is the one outcome that must not occur.
fn run_batch(conn: &mut Option<Connection>, inner: &Inner, jobs: Vec<Job>) {
    let generation = inner.generation.load(Ordering::SeqCst);
    let mut live = Vec::with_capacity(jobs.len());
    for job in jobs {
        if job.generation != generation {
            inner.refused.fetch_add(1, Ordering::Relaxed);
            answer(inner, &job.reply, Err(anyhow!(SUPERSEDED)));
        } else {
            live.push(job);
        }
    }
    if live.is_empty() {
        return;
    }
    let Some(conn) = conn.as_mut() else {
        for job in live {
            answer(inner, &job.reply, Err(anyhow!("数据库已关闭")));
        }
        return;
    };
    let mut results: Vec<(Reply, Result<Payload>)> = Vec::with_capacity(live.len());
    let mut failure = None;
    match conn.transaction() {
        Ok(tx) => {
            for job in live {
                let outcome = (job.run)(Target::Conn(&tx));
                if let Err(e) = &outcome {
                    // The transaction is now poisoned, so the rest of the batch
                    // shares this failure rather than reporting a success that
                    // cannot be committed.
                    failure = Some(format!("{e:#}"));
                    results.push((job.reply, Err(anyhow!(failure.clone().unwrap()))));
                } else {
                    results.push((job.reply, outcome));
                }
            }
            match failure {
                Some(reason) => {
                    let _ = tx.rollback();
                    inner.reload_guard();
                    let rolled_back = results.len();
                    for (reply, _) in results {
                        let _ = reply.send(Err(anyhow!("{reason}")));
                    }
                    inner.queued.fetch_sub(rolled_back as u64, Ordering::Relaxed);
                    error!("a telemetry batch rolled back ({reason}); {rolled_back} operation(s) were not written");
                }
                None => match tx.commit() {
                    Ok(()) => {
                        let done = results.len() as u64;
                        for (reply, result) in results {
                            let _ = reply.send(result);
                        }
                        inner.queued.fetch_sub(done, Ordering::Relaxed);
                        inner.committed.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => {
                        let reason = format!("commit failed: {e:#}");
                        error!("{reason}");
                        inner.reload_guard();
                        let lost = results.len() as u64;
                        for (reply, _) in results {
                            let _ = reply.send(Err(anyhow!("{reason}")));
                        }
                        inner.queued.fetch_sub(lost, Ordering::Relaxed);
                    }
                },
            }
        }
        Err(e) => {
            let reason = format!("could not open a transaction: {e:#}");
            for job in live {
                answer(inner, &job.reply, Err(anyhow!("{reason}")));
            }
        }
    }
}

fn run_one(conn: &Option<Connection>, inner: &Inner, job: Job) {
    if job.generation != inner.generation.load(Ordering::SeqCst) {
        inner.refused.fetch_add(1, Ordering::Relaxed);
        answer(inner, &job.reply, Err(anyhow!(SUPERSEDED)));
        return;
    }
    let Some(conn) = conn.as_ref() else {
        answer(inner, &job.reply, Err(anyhow!("数据库已关闭")));
        return;
    };
    let reply = job.reply;
    let outcome = (job.run)(Target::Conn(conn));
    if outcome.is_err() {
        inner.reload_guard();
    }
    answer(inner, &reply, outcome);
}

/// Sends one job's answer and closes it out of the accepted-but-unanswered count.
/// Every path that finishes a job goes through here, so `queued` means exactly
/// what it says: work this process has taken responsibility for and not yet
/// committed or refused.
fn answer(inner: &Inner, reply: &Reply, outcome: Result<Payload>) {
    let _ = reply.send(outcome);
    inner.queued.fetch_sub(1, Ordering::Relaxed);
}

/// A maintenance operation, with the readers stopped and everything already
/// queued refused.
///
/// The drain is what keeps a write that was accepted before the switch from
/// landing in the database that replaced it. The generation bump afterwards is
/// the backstop: a job submitted while the switch was running carries the old
/// generation and is refused rather than applied to a database it was not written
/// for. Nothing straddles the switch.
fn run_exclusive(conn: &mut Option<Connection>, inner: &Inner, queue: &Receiver<Job>, job: Job) {
    let _gate = inner.gate.write().unwrap_or_else(|e| e.into_inner());
    let mut refused = 0u64;
    while let Ok(pending) = queue.try_recv() {
        refused += 1;
        let _ = pending.reply.send(Err(anyhow!(SUPERSEDED)));
    }
    inner.refused.fetch_add(refused, Ordering::Relaxed);
    if refused > 0 {
        inner.queued.fetch_sub(refused.min(inner.queued.load(Ordering::Relaxed)), Ordering::Relaxed);
        warn!("{refused} queued write(s) were refused because the database is being replaced");
    }
    let reply = job.reply;
    let mut ex = Exclusive { conn };
    let outcome = (job.run)(Target::Exclusive(&mut ex));
    // Whatever the database now contains, the relationship cache describes the
    // one it replaced.
    inner.reload_guard();
    inner.generation.fetch_add(1, Ordering::SeqCst);
    answer(inner, &reply, outcome);
}

/// Waits for one job's reply.
fn await_reply<T: 'static>(rx: Receiver<Result<Payload>>) -> Result<T> {
    let payload = rx.recv().map_err(|_| anyhow!("数据库写入线程在答复前退出"))??;
    payload.downcast::<T>().map(|boxed| *boxed).map_err(|_| anyhow!("数据库答复类型不匹配"))
}

/// Hands out the next id for `name`, atomically and inside the caller's
/// transaction.
///
/// `UPDATE ... RETURNING` rather than `SELECT MAX(id) + 1`: two concurrent
/// callers cannot be handed the same id, and an id belonging to a deleted row is
/// never issued again. DuckDB has no `setval`, so a sequence could not be moved
/// past the ids an import or a restore brought in -- this row can.
fn alloc_id(conn: &Connection, name: &str) -> Result<i64> {
    let id: Option<i64> = conn
        .prepare("UPDATE romi_id SET next = next + 1 WHERE name = ?1 RETURNING next - 1")?
        .query_row([name], |r| r.get(0))
        .optional()?;
    id.ok_or_else(|| anyhow!("identity source {name} is missing"))
}

/// One node's counters, folded the same way for every caller.
fn accumulate_on(
    conn: &Connection,
    node_id: i64,
    boot_id: &str,
    counters: Option<(i64, i64)>,
) -> Result<Traffic> {
    let (
        prev_boot,
        last_rx,
        last_tx,
        mut total_rx,
        mut total_tx,
        mut month_rx,
        mut month_tx,
        month_start,
        mut day_rx,
        mut day_tx,
        day_start,
        reset_day,
    ) = conn
        .prepare(
            "SELECT t.boot_id, t.last_rx, t.last_tx, t.total_rx, t.total_tx, t.month_rx, t.month_tx,
                    t.month_start, t.day_rx, t.day_tx, t.day_start, n.traffic_reset_day
             FROM traffic t JOIN node n ON n.id = t.node_id WHERE t.node_id=?1",
        )?
        .query_row([node_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, i64>(11)?,
            ))
        })?;

    // Only bytes this hub observed a counter climb through are booked.
    // Without a baseline under this exact boot there is nothing to subtract
    // from, and a bare reading represents the machine's entire history.
    //
    // The baseline can be missing in three ways, all handled identically. A
    // first report has none. A reading that shrank under the same boot lost
    // one -- an interface included in the sum has disappeared -- so the
    // reading is the remainder of that history and booking it would count it
    // twice. A changed boot_id means the counters restarted or,
    // indistinguishably from here, that a second machine shares the token.
    //
    // A fourth case: no reading at all. The row is left exactly as it was,
    // since writing zero would realign the baseline to zero and book the next
    // report's lifetime counter as a single delta.
    let (d_rx, d_tx) = match counters {
        None => (0, 0),
        Some(_) if prev_boot.is_empty() || prev_boot != boot_id => {
            // Logged in either case: on a healthy node this is a reboot,
            // while one every few seconds indicates two machines sharing a
            // token.
            if !prev_boot.is_empty() {
                info!("node {node_id} reports a new boot; re-aligning");
            }
            (0, 0)
        }
        Some((rx, tx)) => ((rx.saturating_sub(last_rx)).max(0), (tx.saturating_sub(last_tx)).max(0)),
    };
    // Saturating rather than a plain `+`: the release profile disables
    // overflow checks, so a total near i64::MAX would wrap to a large
    // negative -- a lifetime figure that has decreased.
    total_rx = total_rx.saturating_add(d_rx);
    total_tx = total_tx.saturating_add(d_tx);
    month_rx = month_rx.saturating_add(d_rx);
    month_tx = month_tx.saturating_add(d_tx);
    day_rx = day_rx.saturating_add(d_rx);
    day_tx = day_tx.saturating_add(d_tx);

    // Both boundaries are calendar dates -- the day a provider resets an
    // allowance, the day a person means by "today" -- so both follow the
    // hub's local timezone rather than UTC.
    let period = period_start(Local::now().date_naive(), reset_day.max(1) as u32).to_string();
    if month_start != period {
        // A new billing period restarts the month counter but not the total.
        month_rx = d_rx;
        month_tx = d_tx;
    }
    let today = Local::now().date_naive().to_string();
    if day_start != today {
        day_rx = d_rx;
        day_tx = d_tx;
    }

    if let Some((rx, tx)) = counters {
        conn.prepare(
            "UPDATE traffic SET boot_id=?2, last_rx=?3, last_tx=?4, total_rx=?5, total_tx=?6,
                            month_rx=?7, month_tx=?8, month_start=?9, day_rx=?10, day_tx=?11,
                            day_start=?12 WHERE node_id=?1",
        )?
        .execute(params![
            node_id, boot_id, rx, tx, total_rx, total_tx, month_rx, month_tx, period, day_rx, day_tx, today
        ])?;
    }
    Ok(Traffic { total_rx, total_tx, month_rx, month_tx, month_start: period, day_rx, day_tx })
}

/// Turns one finished bucket into a row per probe, stamped with the bucket's
/// start so every series lands on the same grid.
///
/// Median rather than mean: one SYN retransmit is tens of milliseconds and would
/// drag a mean, and it is the reading that is wrong rather than the link.
///
/// `latency` is null when an entire bucket timed out. `loss` is the percentage
/// that did, included only when non-zero -- a healthy day is 2,880 rows, and
/// `"loss":0` on each would add 29 kB of nothing. Rounded up, so that the absence
/// of a `loss` key means no timeouts occurred.
fn close_bucket(out: &mut Vec<serde_json::Value>, open: &mut Vec<(i64, Vec<i64>, i64)>, ts: i64) {
    // Ordered by probe rather than by which answered first in this bucket, since
    // the chart shades its lines by arrival order.
    open.sort_unstable_by_key(|(task, ..)| *task);
    for (task, mut answered, lost) in open.drain(..) {
        answered.sort_unstable();
        let middle = match answered.len() {
            0 => None,
            n if n % 2 == 1 => Some(answered[n / 2]),
            n => Some((answered[n / 2 - 1] + answered[n / 2]) / 2),
        };
        let mut row = serde_json::json!({"task_id": task, "ts": ts, "latency": middle});
        // Only when the bucket actually varied. At the hour and six-hour windows a
        // bucket holds one sample, and a band would be a zero-height ribbon under
        // every line.
        if let (Some(lo), Some(hi)) = (answered.first(), answered.last()) {
            if hi > lo {
                row["band"] = serde_json::json!([lo, hi]);
            }
        }
        if lost > 0 {
            let total = answered.len() as i64 + lost;
            row["loss"] = ((100 * lost + total - 1) / total).into();
        }
        out.push(row);
    }
}

fn row_to_node(r: &duckdb::Row<'_>) -> Node {
    let s = |i: usize| r.get::<_, String>(i).unwrap_or_default();
    let n = |i: usize| r.get::<_, i64>(i).unwrap_or(0);
    Node {
        id: n(0),
        name: s(1),
        public: r.get::<_, bool>(4).unwrap_or(false),
        sort: n(3),
        price: r.get::<_, f64>(5).unwrap_or(0.0),
        currency: s(6),
        billing_cycle: s(7),
        expires_at: r.get::<_, Option<String>>(8).unwrap_or(None),
        remark: s(9),
        traffic_limit: n(10),
        traffic_mode: s(11),
        traffic_reset_day: n(12).clamp(0, u32::MAX as i64) as u32,
        hostname: s(13),
        os: s(14),
        kernel: s(15),
        arch: s(16),
        virt: s(17),
        cpu_name: s(18),
        cpu_cores: n(19),
        mem_total: n(20),
        swap_total: n(21),
        disk_total: n(22),
        agent_version: s(23),
        ip: s(24),
        ipv4: s(25),
        ipv6: s(26),
        country: s(27),
        last_seen: n(28),
        notify: r.get::<_, bool>(29).unwrap_or(false),
        down_since: n(30),
    }
}

/// Opens the engine with the limits a small self-hosted hub needs, and with the
/// extension machinery switched off.
///
/// `autoinstall_known_extensions` and `autoload_known_extensions` are disabled
/// because nothing here needs to fetch or load an extension at runtime: Parquet
/// is compiled in by the `parquet` feature of the crate. Left on, a query that
/// mentioned an extension would reach the network on its own.
fn open_connection(path: &str, options: &Options, read_only: bool) -> Result<Connection> {
    let mut config = Config::default()
        .with("memory_limit", &options.memory_limit)?
        .with("threads", options.threads.to_string())?
        .with("temp_directory", &options.temp_directory)?
        .with("max_temp_directory_size", &options.max_temp_size)?
        .with("autoinstall_known_extensions", "false")?
        .with("autoload_known_extensions", "false")?
        .with("allow_community_extensions", "false")?
        .with("allow_unsigned_extensions", "false")?;
    if read_only {
        config = config.access_mode(duckdb::AccessMode::ReadOnly)?;
    }
    let conn = if path == ":memory:" || path.is_empty() {
        Connection::open_in_memory_with_flags(config)
    } else {
        Connection::open_with_flags(path, config)
    }
    .with_context(|| format!("opening the DuckDB database at {path}"))?;
    Ok(conn)
}

/// Folds the write-ahead log into the main file. DuckDB documents `CHECKPOINT` as
/// the statement that reclaims space after deletions; it is also what keeps the
/// WAL from growing across a long run.
pub(crate) fn checkpoint(conn: &Connection) -> Result<()> {
    conn.execute_batch("CHECKPOINT").context("checkpointing the duckdb database")?;
    Ok(())
}

/// A scratch path for `kind`, on the same filesystem as the database when there
/// is one and inside the temporary directory when there is not.
///
/// A database path is a *prefix* here, never a directory: `format!("{base}.x")`
/// on an in-memory hub, whose base is the temporary directory, produces `/tmp.x`
/// -- a path in the root directory, which is writable by nobody.
pub(crate) fn scratch_beside(beside: &str, kind: &str) -> String {
    let name = format!("{kind}-{}", &crate::auth::random_token()[..16]);
    if beside.is_empty() {
        std::env::temp_dir().join(name).to_string_lossy().into_owned()
    } else {
        format!("{beside}.{name}")
    }
}

/// Takes an exclusive advisory lock on `<path>.lock`, or explains who holds it.
///
/// The lock is released when the process exits, including on a crash, because the
/// kernel owns it rather than the file's contents.
fn exclusive_lock(path: &str) -> Result<std::fs::File> {
    let lock = format!("{path}.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock)
        .with_context(|| format!("opening the lock file {lock}"))?;
    own_only(&lock);
    if let Err(e) = file.try_lock() {
        let _ = file.unlock();
        anyhow::bail!(
            "{path} 已被另一个 romi 进程打开（{e}）；DuckDB 只允许一个进程读写同一个数据库文件，\
             请先停掉它，或为这个实例换一个 --db 路径"
        );
    }
    Ok(file)
}

/// Refuses a `--db` file this build cannot open, before the engine touches it.
///
/// The extension does not identify the format: an operator's `romi.db` may be the
/// SQLite database of the previous build, and silently creating a second, empty
/// DuckDB database beside it would look like every node disappeared. Nothing is
/// renamed, deleted or overwritten here.
fn refuse_foreign_format(path: &str) -> Result<()> {
    let Ok(head) = std::fs::read(path) else { return Ok(()) };
    if head.is_empty() {
        return Ok(());
    }
    if head.starts_with(b"SQLite format 3\0") {
        anyhow::bail!(
            "{path} 是旧版 SQLite 数据库，本版本已改用 DuckDB，不会自动转换，也不会改动该文件。\n\
             请先停掉旧 Hub，然后按 docs/duckdb-migration.md 的三步迁移：\n  \
             python3 scripts/migrate-sqlite.py --source {path} --out /tmp/romi-legacy.jsonl\n  \
             monitor-hub --import-legacy /tmp/romi-legacy.jsonl --db <新的 DuckDB 路径>\n  \
             再用 --db <新的 DuckDB 路径> 启动"
        );
    }
    if head.len() < 12 || &head[8..12] != b"DUCK" {
        anyhow::bail!("{path} 既不是 SQLite 数据库，也不是 DuckDB 数据库；拒绝在此路径上创建新库");
    }
    Ok(())
}

/// Restricts the database file and its write-ahead log to their owner.
///
/// DuckDB writes the WAL beside the database, and the spill directory holds
/// materialized intermediates of the same rows; neither carries SQLite's `-wal`
/// and `-shm` names, so each path is restricted explicitly.
pub(crate) fn restrict(path: &str) {
    for file in [path.to_owned(), format!("{path}.wal")] {
        own_only(&file);
    }
}

pub(crate) fn restrict_dir(path: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub(crate) fn own_only(file: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = file;
}

fn bytes_of(file: &str) -> i64 {
    if file.is_empty() {
        return 0;
    }
    std::fs::metadata(file).map(|m| m.len() as i64).unwrap_or(0)
}

/// One node's stored configuration and last known facts.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Node {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub price: f64,
    #[serde(default = "usd")]
    pub currency: String,
    #[serde(default = "monthly")]
    pub billing_cycle: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub remark: String,
    /// Monthly allowance in bytes; 0 means unmetered.
    #[serde(default)]
    pub traffic_limit: i64,
    /// How the allowance is counted: sum, max, up or down.
    #[serde(default = "sum")]
    pub traffic_mode: String,
    #[serde(default = "one")]
    pub traffic_reset_day: u32,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub kernel: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub virt: String,
    #[serde(default)]
    pub cpu_name: String,
    #[serde(default)]
    pub cpu_cores: i64,
    #[serde(default)]
    pub mem_total: i64,
    #[serde(default)]
    pub swap_total: i64,
    #[serde(default)]
    pub disk_total: i64,
    #[serde(default)]
    pub agent_version: String,
    #[serde(default)]
    pub ip: String,
    /// Reported by the agent from its own interfaces, unlike `ip`, which is
    /// merely the address the agent's connection originated from.
    #[serde(default)]
    pub ipv4: String,
    #[serde(default)]
    pub ipv6: String,
    /// ISO 3166-1 alpha-2 for `ip`, uppercase, or empty when unknown.
    #[serde(default)]
    pub country: String,
    /// Unix seconds of the node's last report, written once a minute alongside
    /// the metric row. Zero for a node that has never reported.
    #[serde(default)]
    pub last_seen: i64,
    /// Whether going offline and coming back are announced. See `notify`.
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub down_since: i64,
}

/// Omitted settings stay unchanged. An explicit null clears the expiry date.
#[derive(Deserialize, Default)]
pub struct NodePatch {
    pub name: Option<String>,
    pub sort: Option<i64>,
    pub public: Option<bool>,
    pub price: Option<f64>,
    pub currency: Option<String>,
    pub billing_cycle: Option<String>,
    #[serde(default, deserialize_with = "expiry_patch")]
    pub expires_at: Option<Option<String>>,
    pub remark: Option<String>,
    pub traffic_limit: Option<i64>,
    pub traffic_mode: Option<String>,
    pub traffic_reset_day: Option<u32>,
    pub notify: Option<bool>,
}

fn expiry_patch<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Deserialize, Default)]
pub struct TrafficPatch {
    pub total_rx: Option<i64>,
    pub total_tx: Option<i64>,
    pub month_rx: Option<i64>,
    pub month_tx: Option<i64>,
}
fn usd() -> String {
    "USD".into()
}
fn monthly() -> String {
    "monthly".into()
}
fn sum() -> String {
    "sum".into()
}
fn one() -> u32 {
    1
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Traffic {
    pub total_rx: i64,
    pub total_tx: i64,
    pub month_rx: i64,
    pub month_tx: i64,
    pub month_start: String,
    pub day_rx: i64,
    pub day_tx: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PingTask {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub target: String,
    #[serde(default)]
    pub interval: i64,
    #[serde(default)]
    pub nodes: Vec<i64>,
}

/// Start of the billing period containing `today`, given a reset day of month.
/// A reset day past the end of a short month lands on that month's last day.
pub fn period_start(today: NaiveDate, reset_day: u32) -> NaiveDate {
    let day = reset_day.clamp(1, 31);
    let clamped = |y: i32, m: u32| {
        let last =
            NaiveDate::from_ymd_opt(if m == 12 { y + 1 } else { y }, if m == 12 { 1 } else { m + 1 }, 1)
                .unwrap()
                .pred_opt()
                .unwrap()
                .day();
        NaiveDate::from_ymd_opt(y, m, day.min(last)).unwrap()
    };
    let this = clamped(today.year(), today.month());
    if today >= this {
        this
    } else if today.month() == 1 {
        clamped(today.year() - 1, 12)
    } else {
        clamped(today.year(), today.month() - 1)
    }
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").field("path", &self.0.path).field("engine", &ENGINE_VERSION).finish()
    }
}
