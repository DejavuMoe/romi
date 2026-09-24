//! Storage tests.
//!
//! They cover the application's own behaviour -- identity allocation,
//! transactional deletion without cascading foreign keys, traffic folding, the
//! Parquet archive format, restore ordering, queue accounting and clean shutdown
//! -- plus the DuckDB facts this build depends on: MVCC reads, the maintenance
//! barrier, and the engine version and file-format checks.

use super::*;
use crate::auth::sha256;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Test-only writer delay, set by the group-commit accounting test. It makes the
/// writer hold the first batch job long enough for callers to queue behind it,
/// so a multi-job batch is deterministic instead of timing-dependent.
pub(super) static TEST_BATCH_HOLD_NANOS: AtomicU64 = AtomicU64::new(0);

fn db() -> Db {
    Db::open(":memory:").unwrap()
}

#[test]
fn saturated_history_readers_do_not_block_agent_credentials_or_live_metadata() {
    let db = db();
    let id = db.create_node(&Node::default(), "isolated-agent-token").unwrap();
    let pool = db.0.readers.read().unwrap().clone();
    let held: Vec<_> = pool.readers.iter().map(|r| r.conn.lock().unwrap()).collect();
    let other = db.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        send.send((other.node_by_token("isolated-agent-token").unwrap(), other.nodes().unwrap().len()))
            .unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(1));
    drop(held);
    reader.join().unwrap();
    assert_eq!(result.unwrap(), (Some(id), 1));
}

/// A real file, since several of these exist to exercise what happens to one.
/// Removed by the test that created it.
struct Scratch(String);

impl Scratch {
    fn new() -> Self {
        Self(
            std::env::temp_dir()
                .join(format!("romi-test-{}.duckdb", rand::random::<u64>()))
                .to_string_lossy()
                .into_owned(),
        )
    }

    fn copy(&self, suffix: &str) -> String {
        format!("{}{suffix}", self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        for suffix in ["", ".wal", ".copy", ".good", ".imported", ".jsonl", ".old", ".replaced"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0));
        }
        let _ = std::fs::remove_dir_all(format!("{}.tmp", self.0));
    }
}

fn node(db: &Db, reset_day: u32) -> i64 {
    let token = format!("token-{}", rand::random::<u32>());
    db.create_node(&Node { name: "n".into(), traffic_reset_day: reset_day, ..Default::default() }, &token)
        .unwrap()
}

fn probe(db: &Db, nodes: Vec<i64>) -> i64 {
    db.save_ping_task(&PingTask {
        id: 0,
        name: "cm".into(),
        target: "1.1.1.1:443".into(),
        interval: 60,
        nodes,
    })
    .unwrap()
}

// ---- engine and file format ----

/// The engine version is a fact about the binary, not a comment. The crate
/// numbering and the engine numbering are deliberately independent
/// (`duckdb 1.10505.0` vendors engine `v1.5.5`), so a mismatch has to be a test
/// failure rather than a surprise at an operator's first query.
#[test]
fn the_engine_is_the_version_this_build_was_tested_against() {
    let db = db();
    let reported = db.read(schema::engine_version).unwrap();
    assert_eq!(reported, ENGINE_VERSION);
    assert_eq!(db.engine_version(), ENGINE_VERSION);
}

/// The settings a small self-hosted hub needs, on the connection the hub
/// actually writes through -- and the extension machinery switched off, so a
/// query can never decide on its own to reach the network for an extension.
#[test]
fn the_engine_runs_with_the_configured_limits_and_no_autoloading() {
    let scratch = Scratch::new();
    let options = Options { memory_limit: "256MB".into(), threads: 2, ..Default::default() };
    let db = Db::open_with(&scratch.0, options).unwrap();
    let read = |name: &str| -> String {
        db.read(move |conn| {
            Ok(conn.query_row(
                "SELECT CAST(value AS VARCHAR) FROM duckdb_settings() WHERE name = ?1",
                [name],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap()
    };
    // DuckDB normalizes the spelling, so the value is compared against the
    // default's rendering rather than against the string that was passed in.
    let default_limit = Db::open(":memory:").unwrap().read(|conn| {
        Ok(conn.query_row(
            "SELECT CAST(value AS VARCHAR) FROM duckdb_settings() WHERE name='memory_limit'",
            [],
            |r| r.get::<_, String>(0),
        )?)
    });
    assert_ne!(read("memory_limit"), default_limit.unwrap());
    assert!(read("memory_limit").ends_with("MiB"), "{}", read("memory_limit"));
    assert_eq!(read("threads"), "2");
    assert_eq!(read("autoinstall_known_extensions"), "false");
    assert_eq!(read("autoload_known_extensions"), "false");
    assert_eq!(read("allow_community_extensions"), "false");
    assert_eq!(read("allow_unsigned_extensions"), "false");
    assert!(read("temp_directory").starts_with(&scratch.0), "{}", read("temp_directory"));

    // The spill directory and the database are owner-only: both hold the same
    // rows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &str| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&scratch.0), 0o600, "the database is the credential store");
        assert_eq!(mode(&format!("{}.tmp", scratch.0)), 0o700);
    }
}

/// The default worker cap follows the host up to eight. The benchmark measured
/// a materially faster large-history scan at eight workers while ingestion
/// correctness during concurrent analytics stayed unchanged; a smaller host
/// still uses all of its own cores rather than a fixed lower bound.
#[test]
fn the_default_worker_cap_tracks_cores_up_to_eight() {
    let expected = std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(2).min(8);
    assert_eq!(Options::default().threads, expected);
    assert!((1..=8).contains(&expected), "the cap stays inside DuckDB's supported range");
}

/// Restore builds its staging database with the large-table keys deferred, then
/// adds them after the bulk load. The final schema must expose the same primary
/// keys as a normally initialized database; otherwise a restore would publish a
/// database with weaker uniqueness than the product's own schema.
#[test]
fn the_staging_schema_defers_and_then_restores_the_large_table_keys() {
    let mut conn = open_connection(":memory:", &Options::default(), false).unwrap();
    schema::initialize_staging(&mut conn, env!("CARGO_PKG_VERSION")).unwrap();
    let primary_key = |conn: &Connection, table: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM duckdb_constraints()
             WHERE table_name=?1 AND constraint_type='PRIMARY KEY'",
            [table],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    };
    assert!(!primary_key(&conn, "metric"), "metric load must not pay index maintenance per row");
    assert!(!primary_key(&conn, "ping_record"));
    assert!(primary_key(&conn, "node"), "small tables keep their ordinary schema");

    schema::add_large_table_keys(&conn).unwrap();
    assert!(primary_key(&conn, "metric"));
    assert!(primary_key(&conn, "ping_record"));
    assert_eq!(
        schema::stored_version(&conn).unwrap(),
        Some(schema::SCHEMA_VERSION),
        "the staging database still gets the normal version row"
    );
}

/// A fresh file, a second start on the same file, and a file carrying a schema
/// this build does not know: one has to be created, one has to be reused, and one
/// has to be refused before anything is written to it.
#[test]
fn a_database_is_created_once_reopened_and_refuses_a_future_schema() {
    let scratch = Scratch::new();
    {
        let db = Db::open(&scratch.0).unwrap();
        node(&db, 1);
        assert_eq!(db.scalar("SELECT version FROM romi_schema WHERE id=1").unwrap(), schema::SCHEMA_VERSION);
        db.close().unwrap();
    }
    let head = std::fs::read(&scratch.0).unwrap();
    assert_eq!(&head[8..12], b"DUCK", "the file really is a DuckDB database");

    {
        // Repeated startup: the same database, not a second one beside it.
        let db = Db::open(&scratch.0).unwrap();
        assert_eq!(db.nodes().unwrap().len(), 1, "the rows survived the restart");
        assert_eq!(db.scalar("SELECT COUNT(*) FROM romi_schema").unwrap(), 1, "one version row, not two");
        db.close().unwrap();
    }

    // A schema from a future build. Refused before a statement runs against it,
    // and left exactly as it was: a build that cannot read a database must not
    // rewrite it either.
    {
        let db = Db::open(&scratch.0).unwrap();
        db.exec(&format!("UPDATE romi_schema SET version = {}", schema::SCHEMA_VERSION + 1)).unwrap();
        assert_eq!(
            db.scalar("SELECT version FROM romi_schema WHERE id=1").unwrap(),
            schema::SCHEMA_VERSION + 1,
            "the future version really is stored"
        );
        db.close().unwrap();
    }
    let refused = format!("{:#}", Db::open(&scratch.0).unwrap_err());
    assert!(refused.contains("高于"), "{refused}");
    let bytes = std::fs::read(&scratch.0).unwrap();
    assert_eq!(&bytes[8..12], b"DUCK", "and the file was not replaced by an empty one");

    // A DuckDB file that is not ours: tables but no schema record. Adopting it
    // would mean running every statement against columns nothing has verified.
    let foreign = Scratch::new();
    {
        let conn = open_connection(&foreign.0, &Options::default(), false).unwrap();
        conn.execute_batch("CREATE TABLE unrelated (a BIGINT)").unwrap();
        conn.execute_batch("CHECKPOINT").unwrap();
    }
    let refused = format!("{:#}", Db::open(&foreign.0).unwrap_err());
    assert!(refused.contains("romi"), "{refused}");

    // Not a database at all.
    let junk = Scratch::new();
    std::fs::write(&junk.0, b"this is not a database").unwrap();
    assert!(Db::open(&junk.0).is_err());
}

/// An existing file that is not a DuckDB database must be refused with one
/// concise generic error and left byte-for-byte alone: no migration path, no
/// format-specific handling, no silently creating an empty database beside it.
#[test]
fn a_foreign_file_is_refused_with_one_generic_error_and_left_alone() {
    let scratch = Scratch::new();
    let foreign = b"this is somebody else's file, not a database".repeat(4);
    std::fs::write(&scratch.0, &foreign).unwrap();

    let refused = format!("{:#}", Db::open(&scratch.0).unwrap_err());
    assert!(refused.contains("DuckDB"), "{refused}");
    assert!(refused.contains("romi"), "{refused}");
    assert!(!refused.contains("migrate") && !refused.contains("import"), "{refused}");
    assert_eq!(std::fs::read(&scratch.0).unwrap(), foreign, "the file is unchanged byte for byte");
}

/// One hub per database file, enforced before the engine is handed the path.
///
/// DuckDB locks the file, but POSIX advisory locks belong to a process, so a
/// second handle opened from the same process would silently become a second
/// independent database on the same path -- and the two would overwrite each
/// other. The `<db>.lock` file is what refuses it; the cross-process case is
/// covered by `scripts/smoke.py`, which starts a second hub against a live
/// database.
#[test]
fn a_second_writer_on_the_same_file_is_refused() {
    let scratch = Scratch::new();
    let first = Db::open(&scratch.0).unwrap();
    let refused = Db::open(&scratch.0).unwrap_err().to_string();
    assert!(refused.contains("已被另一个"), "{refused}");
    assert!(refused.contains(&scratch.0), "{refused}");

    // The refusal did not disturb the hub that holds the lock.
    first.set("shared", "yes").unwrap();
    assert_eq!(first.get("shared").as_deref(), Some("yes"));

    // And it is released with the process: a fresh handle after the holder is
    // gone opens the same database.
    first.close().unwrap();
    drop(first);
    let second = Db::open(&scratch.0).unwrap();
    assert_eq!(second.get("shared").as_deref(), Some("yes"));
}

/// The lock file is left beside the database, owner-only like the database and
/// the spill directory: it names the path, nothing more, but it is written under
/// the same umask as everything else.
#[cfg(unix)]
#[test]
fn the_lock_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let lock = format!("{}.lock", scratch.0);
    assert_eq!(std::fs::metadata(&lock).unwrap().permissions().mode() & 0o777, 0o600);
    drop(db);
}

// ---- settings, nodes and identity ----

#[test]
fn settings_round_trip_and_overwrite() {
    let db = db();
    assert_eq!(db.get("missing"), None);
    db.set("theme", "flexoki").unwrap();
    assert_eq!(db.get("theme").as_deref(), Some("flexoki"));
    db.set("theme", "default").unwrap();
    assert_eq!(db.get("theme").as_deref(), Some("default"));
}

/// Identifiers come from the monotonic allocator, so a deleted node's id is never
/// handed out again; deleting a node also sweeps its rows. The two together mean
/// a new node can never inherit a removed machine's history.
#[test]
fn deleting_a_node_takes_its_data_with_it_and_frees_no_id_for_reuse() {
    let db = db();
    let id = node(&db, 1);
    let task = probe(&db, vec![id]);
    db.accumulate(id, "b", Some((10, 10))).unwrap();
    db.insert_metric(id, 1, &serde_json::json!({"cpu": 1.0})).unwrap();
    db.insert_ping(id, task, 1, 42).unwrap();
    db.delete_node(id).unwrap();

    assert!(db.node(id).unwrap().is_none());
    assert_eq!(db.metrics(id, 0, 60).unwrap().len(), 0);
    assert!(!db.all_traffic().contains_key(&id));
    for table in ["traffic", "metric", "ping_record", "ping_node"] {
        assert_eq!(
            db.scalar(&format!("SELECT COUNT(*) FROM {table} WHERE node_id={id}")).unwrap(),
            0,
            "{table} still holds rows for the deleted node"
        );
    }

    let fresh = node(&db, 1);
    assert_ne!(fresh, id, "an id belonging to a deleted row is never issued again");
    assert!(db.ping_records(fresh, 0, 60).unwrap().0.is_empty(), "and it starts with no history");
}

/// The mirror of the sweep above, on the other key of the same table.
#[test]
fn deleting_a_probe_takes_its_history_with_it_and_frees_no_id_for_reuse() {
    let db = db();
    let id = node(&db, 1);
    let old = probe(&db, vec![id]);
    db.insert_ping(id, old, 1, 999).unwrap();
    db.delete_ping_task(old).unwrap();

    let fresh = probe(&db, vec![id]);
    assert_ne!(fresh, old, "a deleted probe's id is not reused");
    assert!(db.ping_records(id, 0, 60).unwrap().0.is_empty(), "and it starts with no history");
    assert_eq!(db.scalar("SELECT COUNT(*) FROM ping_record").unwrap(), 0);
}

/// The counters live in the database, and reopening only moves them forward: the
/// highest node and probe ids, once deleted, are not issued again after a restart.
#[test]
fn a_deleted_id_stays_retired_across_a_restart() {
    let scratch = Scratch::new();
    let (gone_node, gone_task) = {
        let db = Db::open(&scratch.0).unwrap();
        let id = node(&db, 1);
        let task = probe(&db, vec![id]);
        db.delete_ping_task(task).unwrap();
        db.delete_node(id).unwrap();
        db.close().unwrap();
        (id, task)
    };
    let db = Db::open(&scratch.0).unwrap();
    let fresh = node(&db, 1);
    assert!(fresh > gone_node, "node id {gone_node} was issued again as {fresh}");
    let task = probe(&db, vec![fresh]);
    assert!(task > gone_task, "probe id {gone_task} was issued again as {task}");
}

/// The archive carries rows, not counters. A node created after the backup was
/// taken disappears with the restore, and its id stays retired.
#[test]
fn a_restore_does_not_reissue_ids_created_after_the_backup() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let db = Db::open(&scratch.0).unwrap();
    let kept = node(&db, 1);
    db.backup_into(&copy).unwrap();
    let later = node(&db, 1);
    db.restore_from(&copy).unwrap();
    assert!(db.node(kept).unwrap().is_some());
    assert!(db.node(later).unwrap().is_none(), "the node made after the backup is gone");
    let fresh = node(&db, 1);
    assert!(fresh > later, "node id {later} was issued again as {fresh}");
    let _ = std::fs::remove_file(&copy);
}

/// A refusal must leave nothing behind: not the task, and not a partial
/// assignment. DuckDB has no cascading foreign key, so every one of these is an
/// application check inside the same transaction as the write.
#[test]
fn invalid_probe_assignments_fail_without_partial_updates() {
    let db = db();
    let good = node(&db, 1);
    let existing = probe(&db, vec![good]);

    let save = |task: i64, nodes: Vec<i64>| {
        db.save_ping_task(&PingTask {
            id: task,
            name: "p".into(),
            target: "1.1.1.1:443".into(),
            interval: 60,
            nodes,
        })
    };

    let refused = save(0, vec![9_999]).unwrap_err().to_string();
    assert!(refused.contains("不存在"), "{refused}");
    assert_eq!(db.ping_tasks().unwrap().len(), 1, "the refused task was not stored");

    let refused = save(0, vec![good, good]).unwrap_err().to_string();
    assert!(refused.contains("重复"), "{refused}");
    assert_eq!(db.ping_tasks().unwrap().len(), 1);

    // An edit that names a node which is not there must leave the existing
    // assignment untouched rather than clearing it first.
    assert_eq!(db.ping_tasks_for(good).unwrap().len(), 1);
    assert!(save(existing, vec![9_999]).is_err());
    assert_eq!(db.ping_tasks_for(good).unwrap().len(), 1, "the old assignment survived the refusal");

    assert!(save(4_242, vec![good]).is_err());
}

/// The agent caps the probe list it will run and drops the remainder with nothing
/// but a line in its own journal. The hub knows the total, so the hub issues the
/// refusal.
#[test]
fn a_node_cannot_be_given_more_probes_than_the_agent_will_run() {
    let db = db();
    let id = node(&db, 1);
    let save = |task: i64, nodes: Vec<i64>| {
        db.save_ping_task(&PingTask {
            id: task,
            name: "p".into(),
            target: "1.1.1.1:443".into(),
            interval: 60,
            nodes,
        })
    };
    for _ in 0..Db::MAX_PROBES_PER_NODE {
        save(0, vec![id]).unwrap();
    }
    assert_eq!(db.ping_tasks_for(id).unwrap().len() as i64, Db::MAX_PROBES_PER_NODE);

    let refused = save(0, vec![id]).expect_err("one past the cap must be refused");
    assert!(refused.to_string().contains("探测任务"), "{refused}");
    assert_eq!(db.ping_tasks().unwrap().len() as i64, Db::MAX_PROBES_PER_NODE);
    assert_eq!(db.ping_tasks_for(id).unwrap().len() as i64, Db::MAX_PROBES_PER_NODE);

    let first = db.ping_tasks().unwrap()[0].id;
    save(first, vec![id]).expect("an existing probe can still be edited at the cap");
}

#[test]
fn nodes_can_be_reordered_atomically() {
    let db = db();
    let (a, b, c) = (node(&db, 1), node(&db, 1), node(&db, 1));
    let order = || db.nodes().unwrap().iter().map(|n| n.id).collect::<Vec<_>>();
    db.reorder_nodes(&[c, a, b]).unwrap();
    assert_eq!(order(), vec![c, a, b]);

    // Every rejected input leaves the existing order intact. The partial list
    // matters most: a stale tab would otherwise renumber around a node it never
    // saw.
    assert!(db.reorder_nodes(&[a, a, c]).is_err(), "duplicates");
    assert!(db.reorder_nodes(&[a, b]).is_err(), "a node left out");
    assert!(db.reorder_nodes(&[a, b, 9999]).is_err(), "an id that is not a node");
    assert_eq!(order(), vec![c, a, b]);
    let d = node(&db, 1);
    assert_eq!(order(), vec![c, a, b, d], "a new node goes to the end");
}

#[test]
fn partial_edits_keep_other_settings_and_live_counters() {
    let db = db();
    let id = node(&db, 1);
    let patch = |v| serde_json::from_value::<NodePatch>(v).unwrap();
    db.update_node(
        id,
        &patch(serde_json::json!({"public":false,"remark":"private","expires_at":"2030-01-01"})),
    )
    .unwrap();
    db.update_node(id, &patch(serde_json::json!({"price":20}))).unwrap();
    let n = db.node(id).unwrap().unwrap();
    assert!(!n.public);
    assert_eq!(n.remark, "private");
    assert_eq!(n.expires_at.as_deref(), Some("2030-01-01"));
    db.update_node(id, &patch(serde_json::json!({"price":0,"expires_at":null}))).unwrap();
    let n = db.node(id).unwrap().unwrap();
    assert_eq!(n.price, 0.0);
    assert_eq!(n.expires_at, None, "an explicitly cleared nullable field stays cleared");

    db.accumulate(id, "boot", Some((0, 0))).unwrap();
    db.accumulate(id, "boot", Some((120_000, 10_000))).unwrap();
    db.set_traffic(id, &TrafficPatch { month_tx: Some(3_000), ..Default::default() }).unwrap();
    let t = db.all_traffic().remove(&id).unwrap();
    assert_eq!((t.total_rx, t.total_tx, t.month_rx, t.month_tx), (120_000, 10_000, 120_000, 3_000));

    db.update_node(id, &patch(serde_json::json!({"traffic_reset_day":2}))).unwrap();
    db.set_traffic(id, &TrafficPatch { month_rx: Some(7_000), ..Default::default() }).unwrap();
    let t = db.all_traffic().remove(&id).unwrap();
    assert_eq!((t.month_rx, t.month_tx), (7_000, 0));
    db.exec(&format!("UPDATE traffic SET month_start='1999-01-01',month_tx=999 WHERE node_id={id}")).unwrap();
    db.set_traffic(id, &TrafficPatch { total_rx: Some(130_000), ..Default::default() }).unwrap();
    assert_eq!(db.all_traffic()[&id].month_tx, 0);
}

/// The country is derived from the address, so it must be dropped the moment the
/// address no longer matches -- and only then.
#[test]
fn a_country_outlives_a_reconnect_and_dies_with_the_address_it_came_from() {
    let db = db();
    let id = node(&db, 1);
    let facts = serde_json::json!({"hostname": "h"});
    let save = |ip: &str| db.save_facts(id, &facts, ip).unwrap();
    let stored = || db.node(id).unwrap().unwrap().country;

    assert!(save("198.51.100.4"), "a node with no country is owed a lookup");
    db.set_country(id, "US", "198.51.100.4").unwrap();
    assert!(!save("198.51.100.4"), "the same address asks nothing a second time");
    assert_eq!(stored(), "US");
    assert!(save("203.0.113.9"), "a new address is a new question");
    assert_eq!(stored(), "", "and the answer to the old one is gone");

    db.set_country(id, "US", "198.51.100.4").unwrap();
    assert_eq!(stored(), "", "an answer about an address the node has left is dropped");
    db.set_country(id, "JP", "203.0.113.9").unwrap();
    assert_eq!(stored(), "JP", "the answer about the address it is at now lands");
}

#[test]
fn facts_from_an_unvouched_machine_cannot_choose_their_own_length() {
    let db = db();
    let id = node(&db, 1);
    db.save_facts(id, &serde_json::json!({"os": "A".repeat(10_000), "hostname": "x\u{7}y"}), "ip").unwrap();
    let stored = db.node(id).unwrap().unwrap();
    assert_eq!(stored.os.chars().count(), 128);
    assert_eq!(stored.hostname, "xy", "control characters break the panel's rows");
}

#[test]
fn tokens_are_hashed_and_rotation_retires_the_old_one() {
    let db = db();
    let id = db.create_node(&Node { name: "n".into(), ..Default::default() }, "first-token").unwrap();

    // DuckDB allows one read-write process per file, so the check belongs here,
    // in the process that owns the database rather than in an external smoke
    // script.
    let stored: String = db
        .read(|conn| Ok(conn.query_row("SELECT token_hash FROM node WHERE id=?1", [id], |r| r.get(0))?))
        .unwrap();
    assert_eq!(stored, sha256("first-token"));
    assert_eq!(db.node_by_token(&stored).unwrap(), None, "a digest is not a credential");
    let node = serde_json::to_value(db.node(id).unwrap().unwrap()).unwrap();
    assert!(node.get("token").is_none() && node.get("token_hash").is_none());
    assert_eq!(db.node_by_token("first-token").unwrap(), Some(id));

    db.reset_token(id, "second-token").unwrap();
    assert_eq!(db.node_by_token("second-token").unwrap(), Some(id));
    assert_eq!(db.node_by_token("first-token").unwrap(), None, "the old token stops working");
}

// ---- traffic ----

#[test]
fn traffic_survives_a_reboot_instead_of_resetting() {
    let db = db();
    let id = node(&db, 1);

    let t = db.accumulate(id, "boot-a", Some((5_000, 3_000))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (0, 0), "the first report only sets the baseline");

    let t = db.accumulate(id, "boot-a", Some((9_000, 6_000))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (4_000, 3_000));

    let t = db.accumulate(id, "boot-b", Some((700, 400))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (4_000, 3_000), "a reboot must not reset the total");

    let t = db.accumulate(id, "boot-b", Some((1_700, 900))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (5_000, 3_500));
    assert_eq!((t.month_rx, t.month_tx), (5_000, 3_500));
}

#[test]
fn two_machines_sharing_one_token_cannot_inflate_the_total() {
    let db = db();
    let id = node(&db, 1);
    let (a, b) = (100_000_000_000, 80_000_000_000);

    db.accumulate(id, "boot-a", Some((a, a))).unwrap();
    let t = db.accumulate(id, "boot-a", Some((a + 1_000, a + 1_000))).unwrap();
    assert_eq!(t.total_rx, 1_000, "the real machine's own traffic still counts");

    for round in 0..3 {
        db.accumulate(id, "boot-b", Some((b + round, b + round))).unwrap();
        db.accumulate(id, "boot-a", Some((a + 1_000 + round, a + 1_000 + round))).unwrap();
    }
    let t = db.all_traffic()[&id].clone();
    assert!(t.total_rx < 10_000, "six swaps booked {} bytes, not a lifetime counter", t.total_rx);
}

#[test]
fn a_shrinking_reading_re_aligns_instead_of_re_counting_history() {
    let db = db();
    let id = node(&db, 1);
    db.accumulate(id, "boot-a", Some((10_000, 10_000))).unwrap();
    let t = db.accumulate(id, "boot-a", Some((12_000, 12_000))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_000, 2_000));

    let t = db.accumulate(id, "boot-a", Some((500, 500))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_000, 2_000), "a shrunken reading books nothing");

    let t = db.accumulate(id, "boot-a", Some((900, 900))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_400, 2_400), "counting resumes from the smaller baseline");

    let t = db.accumulate(id, "boot-b", Some((300, 300))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_400, 2_400));

    let t = db.accumulate(id, "boot-b", Some((100, 900))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_400, 3_000), "one direction shrinking does not cost the other");
}

/// A report with no readable counters must leave the baseline exactly as it was,
/// which is what keeps the next report from booking a lifetime counter.
#[test]
fn a_report_without_counters_changes_nothing() {
    let db = db();
    let id = node(&db, 1);
    db.accumulate(id, "boot-a", Some((1_000, 1_000))).unwrap();
    let t = db.accumulate(id, "boot-a", Some((3_000, 2_000))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_000, 1_000));

    let t = db.accumulate(id, "boot-a", None).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (2_000, 1_000), "no reading is not a reading of zero");

    let t = db.accumulate(id, "boot-a", Some((4_000, 2_500))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (3_000, 1_500), "counting resumes from the old baseline");
}

/// Signed 64-bit counters near the top of the range must clamp, not wrap.
#[test]
fn counters_saturate_instead_of_wrapping() {
    let db = db();
    let id = node(&db, 1);
    let huge = i64::MAX - 10;
    db.accumulate(id, "b", Some((0, 0))).unwrap();
    let t = db.accumulate(id, "b", Some((huge, huge))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (huge, huge));
    let t = db.accumulate(id, "b", Some((i64::MAX, i64::MAX))).unwrap();
    assert_eq!(t.total_rx, i64::MAX, "the total clamps rather than wrapping");
    assert!(t.total_rx > 0);
}

#[test]
fn day_and_month_restart_independently_while_the_total_keeps_climbing() {
    let db = db();
    let id = node(&db, 1);
    db.accumulate(id, "boot-a", Some((0, 0))).unwrap();
    let t = db.accumulate(id, "boot-a", Some((8_000, 4_000))).unwrap();
    assert_eq!((t.day_rx, t.day_tx), (8_000, 4_000));
    assert_eq!((t.month_rx, t.month_tx), (8_000, 4_000));

    db.exec(&format!("UPDATE traffic SET day_start='1999-01-01' WHERE node_id={id}")).unwrap();
    let t = db.accumulate(id, "boot-a", Some((9_500, 4_600))).unwrap();
    assert_eq!((t.day_rx, t.day_tx), (1_500, 600), "a new day counts only this report's delta");
    assert_eq!(t.month_rx, 9_500, "the month is not a day");
    assert_eq!(t.total_rx, 9_500, "and the total is neither");

    db.exec(&format!("UPDATE traffic SET month_start='1999-01-01' WHERE node_id={id}")).unwrap();
    let t = db.accumulate(id, "boot-a", Some((10_000, 4_700))).unwrap();
    assert_eq!((t.month_rx, t.month_tx), (500, 100), "a new period counts only this report's delta");
    assert_eq!((t.day_rx, t.day_tx), (2_000, 700), "the day carries on across a billing rollover");
    assert_eq!(t.total_rx, 10_000, "lifetime total is untouched by either rollover");
}

#[test]
fn a_node_that_went_quiet_before_a_boundary_reads_as_zero_this_period() {
    let db = db();
    let id = node(&db, 1);
    db.accumulate(id, "boot-a", Some((0, 0))).unwrap();
    db.accumulate(id, "boot-a", Some((8_000, 4_000))).unwrap();
    assert_eq!(db.all_traffic()[&id].day_rx, 8_000, "still today, so it still counts");

    db.exec(&format!(
        "UPDATE traffic SET day_start='1999-01-01', month_start='1999-01-01' WHERE node_id={id}"
    ))
    .unwrap();
    let t = db.all_traffic()[&id].clone();
    assert_eq!((t.day_rx, t.day_tx), (0, 0), "yesterday's bytes are not today's");
    assert_eq!((t.month_rx, t.month_tx), (0, 0), "last period's bytes are not this period's");
    assert_eq!(t.month_start, period_start(Local::now().date_naive(), 1).to_string());
    assert_eq!((t.total_rx, t.total_tx), (8_000, 4_000), "the lifetime total never resets");
}

#[test]
fn period_start_handles_short_months_and_wraparound() {
    let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day).unwrap();
    assert_eq!(period_start(d(2026, 3, 20), 15), d(2026, 3, 15));
    assert_eq!(period_start(d(2026, 3, 15), 15), d(2026, 3, 15));
    assert_eq!(period_start(d(2026, 3, 10), 15), d(2026, 2, 15));
    assert_eq!(period_start(d(2026, 1, 10), 15), d(2025, 12, 15));
    assert_eq!(period_start(d(2026, 2, 28), 31), d(2026, 2, 28));
    assert_eq!(period_start(d(2028, 2, 29), 31), d(2028, 2, 29));
}

#[test]
fn a_month_correction_is_stamped_with_the_period_it_was_made_in() {
    let db = db();
    let id = node(&db, 1);
    db.accumulate(id, "boot-a", Some((0, 0))).unwrap();
    db.exec(&format!("UPDATE traffic SET month_start='1999-01-01' WHERE node_id={id}")).unwrap();

    db.set_traffic(
        id,
        &TrafficPatch {
            total_rx: Some(4_000),
            total_tx: Some(2_000),
            month_rx: Some(300),
            month_tx: Some(100),
        },
    )
    .unwrap();
    let t = db.all_traffic().remove(&id).unwrap();
    assert_eq!((t.month_rx, t.month_tx), (300, 100), "the correction reads back as this period's");

    let t = db.accumulate(id, "boot-a", Some((500, 50))).unwrap();
    assert_eq!((t.month_rx, t.month_tx), (800, 150), "and the next report adds to it");
    assert_eq!((t.total_rx, t.total_tx), (4_500, 2_050));
}

// ---- metrics and history ----

/// The metric key is the deduplication rule. DuckDB has no `INSERT OR REPLACE`,
/// and its `ON CONFLICT` is far too slow for the ingest path (see `db::Guard`),
/// so the writer deletes the minute it is about to replace. Either way the table
/// ends up with one row per node per minute.
#[test]
fn a_repeated_metric_minute_replaces_rather_than_duplicates() {
    let db = db();
    let id = node(&db, 1);
    db.insert_metric(id, 600, &serde_json::json!({"cpu": 1.0, "mem_used": 10})).unwrap();
    db.insert_metric(id, 600, &serde_json::json!({"cpu": 9.0, "mem_used": 90})).unwrap();
    assert_eq!(db.scalar(&format!("SELECT COUNT(*) FROM metric WHERE node_id={id}")).unwrap(), 1);
    let rows = db.metrics(id, 0, 60).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["cpu"], 9.0);
    assert_eq!(rows[0]["mem_used"], 90);
}

/// A hub clock stepped back onto minutes it had already written -- NTP correcting
/// a fast clock -- replaces those rows instead of failing on the key.
#[test]
fn a_clock_stepping_back_replaces_minutes_already_written() {
    let db = db();
    let id = node(&db, 1);
    for ts in [600, 660, 720] {
        db.insert_metric(id, ts, &serde_json::json!({"cpu": 1.0})).unwrap();
    }
    db.insert_metric(id, 660, &serde_json::json!({"cpu": 7.0})).unwrap();
    assert_eq!(db.scalar(&format!("SELECT COUNT(*) FROM metric WHERE node_id={id}")).unwrap(), 3);
    assert_eq!(
        db.scalar(&format!("SELECT CAST(cpu AS BIGINT) FROM metric WHERE node_id={id} AND ts=660")).unwrap(),
        7
    );
}

/// A metric for a node that no longer exists is dropped rather than stored: the
/// row would outlive every reader that could attribute it, and a report in flight
/// across a restore would create exactly that.
#[test]
fn a_metric_for_a_node_that_is_gone_is_not_stored() {
    let db = db();
    let id = node(&db, 1);
    db.delete_node(id).unwrap();
    db.insert_metric(id, 600, &serde_json::json!({"cpu": 1.0})).unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric").unwrap(), 0);
}

/// The history read buckets on integer arithmetic.
///
/// DuckDB's `/` is floating-point division and its `CAST(double AS BIGINT)`
/// rounds rather than truncating, so both have to be written out explicitly: the
/// bucket index with `//` and the averaged integers with `TRUNC`. Getting this
/// wrong moves every sample onto a neighbouring grid line and rounds a byte
/// counter up by one.
#[test]
fn history_buckets_and_truncates_the_way_the_contract_says() {
    let db = db();
    let id = node(&db, 1);
    let sample = |cpu: f64, mem: i64| serde_json::json!({"cpu": cpu, "mem_used": mem, "disk_used": mem});
    db.insert_metric(id, 65, &sample(1.0, 5)).unwrap();
    db.insert_metric(id, 70, &sample(2.0, 6)).unwrap();
    db.insert_metric(id, 125, &sample(4.0, 1)).unwrap();
    let rows = db.metrics(id, 0, 60).unwrap();
    assert_eq!(rows.len(), 2, "65 and 70 share a bucket, 125 opens the next");
    assert_eq!(rows[0]["ts"], 60, "the stamp is the bucket's start, an integer");
    assert_eq!(rows[0]["cpu"], 1.5);
    // (5+6)/2 = 5.5, truncated to 5; a rounding cast would give 6.
    assert_eq!(rows[0]["mem_used"], 5, "averaged integers truncate, they do not round");
    assert_eq!(rows[1]["ts"], 120);
    assert_eq!(rows[1]["mem_used"], 1);

    let steps: Vec<i64> = rows.iter().map(|r| r["ts"].as_i64().unwrap()).collect();
    let mut sorted = steps.clone();
    sorted.sort_unstable();
    assert_eq!(steps, sorted, "the output order is deterministic");
}

/// Sample counts are uneven between buckets and the window's first bucket is
/// partial. Expected values are worked out by hand from the rows below.
#[test]
fn uneven_buckets_average_over_what_they_hold() {
    let db = db();
    let id = node(&db, 1);
    let at = |ts: i64, cpu: f64| {
        db.insert_metric(id, ts, &serde_json::json!({"cpu": cpu, "mem_used": cpu as i64})).unwrap()
    };
    at(10, 10.0);
    at(70, 1.0);
    at(80, 2.0);
    at(90, 6.0);
    let rows = db.metrics(id, 0, 60).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["cpu"], 10.0, "one sample is its own average");
    assert_eq!(rows[1]["cpu"], 3.0, "(1+2+6)/3");
    assert_eq!(rows[1]["mem_used"], 3);
}

/// A value past the 32-bit range and a timestamp past 2038 must survive the round
/// trip: DuckDB's `INTEGER` is 32-bit, so every counter column has to be `BIGINT`
/// and the tests have to prove it.
#[test]
fn values_beyond_32_bits_and_2038_survive() {
    let db = db();
    let id = node(&db, 1);
    let big = 5_000_000_000i64;
    let after_2038 = 4_102_444_800i64;
    db.accumulate(id, "b", Some((0, 0))).unwrap();
    let t = db.accumulate(id, "b", Some((big, big))).unwrap();
    assert_eq!((t.total_rx, t.total_tx), (big, big));
    assert_eq!(db.all_traffic()[&id].total_rx, big);

    db.insert_metric(id, after_2038, &serde_json::json!({"cpu": 1.0, "mem_used": big, "disk_used": big}))
        .unwrap();
    let rows = db.metrics(id, 0, 3_600).unwrap();
    assert_eq!(rows[0]["ts"], after_2038);
    assert_eq!(rows[0]["mem_used"], big);

    let task = probe(&db, vec![id]);
    db.insert_ping(id, task, after_2038, 12).unwrap();
    let (rows, _) = db.ping_records(id, 0, 3_600).unwrap();
    assert_eq!(rows[0]["ts"], after_2038);
    assert!(rows[0]["ts"].as_i64().unwrap() > i32::MAX as i64);
}

/// `price` is the one column that carries `f64` precision (it is a `DOUBLE`).
#[test]
fn fractional_price_keeps_its_precision() {
    let db = db();
    let id = db.create_node(&Node { name: "n".into(), price: 19.99, ..Default::default() }, "t").unwrap();
    assert_eq!(db.node(id).unwrap().unwrap().price, 19.99);
    let precise = 1.234_567_890_123_456_7_f64;
    db.update_node(id, &serde_json::from_value::<NodePatch>(serde_json::json!({"price": precise})).unwrap())
        .unwrap();
    assert_eq!(db.node(id).unwrap().unwrap().price, precise);
}

#[test]
fn prune_rolls_history_but_never_traffic_totals() {
    let db = db();
    let id = node(&db, 1);
    db.accumulate(id, "b", Some((100, 100))).unwrap();
    db.accumulate(id, "b", Some((900, 900))).unwrap();
    let old = Utc::now().timestamp() - 40 * 86_400;
    db.insert_metric(id, old, &serde_json::json!({"cpu": 1.0})).unwrap();
    db.insert_metric(id, Utc::now().timestamp(), &serde_json::json!({"cpu": 2.0})).unwrap();

    db.prune(30).unwrap();
    assert_eq!(db.metrics(id, 0, 60).unwrap().len(), 2);
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric").unwrap(), 1);
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric_hour").unwrap(), 1);
    assert_eq!(db.all_traffic()[&id].total_rx, 800);
}

#[test]
fn hourly_rollup_is_idempotent_and_preserves_weighted_metrics_and_exact_ping_medians() {
    let db = db();
    let id = node(&db, 1);
    let task = probe(&db, vec![id]);
    let start = (Utc::now().timestamp() - 40 * 86_400) / 7200 * 7200;
    // Unequal sample counts across hours catch an incorrect average/median of averages/medians.
    for (offset, cpu, latency) in
        [(0, 10.0, 1), (60, 20.0, 2), (120, 30.0, 3), (180, 40.0, -1), (3600, 100.0, 100)]
    {
        db.insert_metric(id, start + offset, &serde_json::json!({"cpu":cpu,"mem_used":5_000_000_001i64}))
            .unwrap();
        db.insert_ping(id, task, start + offset, latency).unwrap();
    }
    let metrics = db.metrics(id, 0, 7200).unwrap();
    let ping = db.ping_records(id, 0, 7200).unwrap();
    db.prune(30).unwrap();
    db.prune(30).unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric").unwrap(), 0);
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric_hour").unwrap(), 2);
    assert_eq!(db.metrics(id, 0, 7200).unwrap(), metrics);
    assert_eq!(db.ping_records(id, 0, 7200).unwrap(), ping);
    assert!(db.metrics(id, 0, 2700).unwrap().iter().all(|row| row["ts"].as_i64().unwrap() % 3600 == 0));
    assert!(db
        .ping_records(id, 0, 2700)
        .unwrap()
        .0
        .iter()
        .all(|row| row["ts"].as_i64().unwrap() % 3600 == 0));
    assert_eq!(ping.0[0]["latency"], 2);
    assert_eq!(ping.1[task.to_string()], 20.0);

    let archive = Scratch::new();
    db.backup_into(&archive.0).unwrap();
    let restored = super::Db::open(":memory:").unwrap();
    restored.restore_from(&archive.0).unwrap();
    assert_eq!(restored.metrics(id, 0, 7200).unwrap(), metrics);
    assert_eq!(restored.ping_records(id, 0, 7200).unwrap(), ping);
    restored.delete_node(id).unwrap();
    assert_eq!(restored.scalar("SELECT COUNT(*) FROM metric_hour").unwrap(), 0);
    assert_eq!(restored.scalar("SELECT COUNT(*) FROM ping_hour").unwrap(), 0);
}

#[test]
fn hourly_history_expires_after_a_year_and_unassigned_history_survives_reassignment() {
    let db = db();
    let id = node(&db, 1);
    let task = probe(&db, vec![id]);
    let old = (Utc::now().timestamp() - 40 * 86_400) / 3600 * 3600;
    db.insert_metric(id, old, &serde_json::json!({"cpu":1.0})).unwrap();
    db.insert_ping(id, task, old, 20).unwrap();
    db.prune(30).unwrap();
    db.save_ping_task(&PingTask {
        id: task,
        name: "test".into(),
        target: "localhost:80".into(),
        interval: 60,
        nodes: vec![],
    })
    .unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM ping_hour").unwrap(), 1);
    assert!(db.ping_records(id, 0, 3600).unwrap().0.is_empty());
    db.read(backup::verify_relationships).unwrap();
    db.exec("UPDATE metric_hour SET ts=0").unwrap();
    db.prune(30).unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric_hour").unwrap(), 0);
}

// ---- latency ----

/// A result for a probe this node is not assigned must not reach the table.
/// Counted directly from the table rather than through `ping_records`: that query
/// filters on the node's assignments, so a row written under a probe it does not
/// have is invisible to it, and an assertion made through it could not fail for
/// the write this test exists to prevent.
#[test]
fn a_result_for_a_probe_this_node_does_not_have_is_not_stored() {
    let db = db();
    let mine = node(&db, 1);
    let other = node(&db, 1);
    let rows = || db.scalar("SELECT COUNT(*) FROM ping_record");
    let task = probe(&db, vec![mine]);

    db.insert_ping(mine, task, 1, 42).unwrap();
    assert_eq!(rows().unwrap(), 1, "the node the probe is assigned to files its own result");

    db.insert_ping(other, task, 1, 42).unwrap();
    for invented in [7, 999_999, i64::from(i32::MAX) + 1] {
        db.insert_ping(mine, invented, 1, 42).unwrap();
    }
    assert_eq!(rows().unwrap(), 1, "nothing else reaches the table");

    db.delete_ping_task(task).unwrap();
    db.insert_ping(mine, task, 2, 42).unwrap();
    assert_eq!(rows().unwrap(), 0, "a late result for a deleted probe is dropped");
}

/// The same key arriving twice replaces the reading rather than adding a row.
#[test]
fn a_duplicate_probe_stamp_replaces_the_reading() {
    let db = db();
    let id = node(&db, 1);
    let task = probe(&db, vec![id]);
    db.insert_ping(id, task, 100, 42).unwrap();
    db.insert_ping(id, task, 100, 99).unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM ping_record").unwrap(), 1);
    assert_eq!(db.scalar("SELECT latency FROM ping_record").unwrap(), 99);
}

/// Editing a probe replaces its assignments but not what the writer knows about
/// the results already filed, so a repeated stamp after the edit still replaces
/// the reading instead of failing on the key.
#[test]
fn a_duplicate_probe_stamp_after_an_edit_still_replaces_the_reading() {
    let db = db();
    let id = node(&db, 1);
    let task = probe(&db, vec![id]);
    db.insert_ping(id, task, 100, 42).unwrap();
    db.save_ping_task(&PingTask {
        id: task,
        name: "edited".into(),
        target: "1.1.1.1:443".into(),
        interval: 30,
        nodes: vec![id],
    })
    .unwrap();
    db.insert_ping(id, task, 100, 99).unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM ping_record").unwrap(), 1);
    assert_eq!(db.scalar("SELECT latency FROM ping_record").unwrap(), 99);
}

/// The chart folds one bucket at a time out of rows already in time order, so
/// this exercises the whole contract at once: medians for odd and even sample
/// counts, an all-failed bucket yielding no latency, the band only when the
/// values differ, and a whole-window loss computed from total failures over total
/// samples rather than from the average of bucket percentages.
#[test]
fn latency_buckets_keep_their_medians_bands_and_window_loss() {
    let db = db();
    let id = node(&db, 1);
    let task = |name: &str| {
        db.save_ping_task(&PingTask {
            id: 0,
            name: name.into(),
            target: "1.1.1.1:443".into(),
            interval: 60,
            nodes: vec![id],
        })
        .unwrap()
    };
    let odd = task("odd");
    let even = task("even");
    let dead = task("dead");

    for (i, latency) in [10, 30, 50].iter().enumerate() {
        db.insert_ping(id, odd, 10 + i as i64, *latency).unwrap();
    }
    db.insert_ping(id, even, 10, 10).unwrap();
    db.insert_ping(id, even, 11, 40).unwrap();
    db.insert_ping(id, odd, 70, -1).unwrap();
    db.insert_ping(id, even, 70, 20).unwrap();
    db.insert_ping(id, even, 71, 20).unwrap();
    db.insert_ping(id, even, 72, -1).unwrap();
    db.insert_ping(id, dead, 70, -1).unwrap();

    let (rows, loss) = db.ping_records(id, 0, 60).unwrap();
    let row = |task: i64, ts: i64| {
        rows.iter()
            .find(|r| r["task_id"] == task && r["ts"] == ts)
            .unwrap_or_else(|| panic!("no row for task {task} at {ts}"))
            .clone()
    };
    let first = row(odd, 0);
    assert_eq!(first["latency"], 30, "odd sample counts take the middle value");
    assert_eq!(first["band"], serde_json::json!([10, 50]));
    let second = row(odd, 60);
    assert_eq!(second["latency"], serde_json::Value::Null, "an entirely failed bucket has no latency");
    assert_eq!(second["loss"], 100);
    assert!(second.get("band").is_none(), "no answers, no band");

    let e0 = row(even, 0);
    assert_eq!(e0["latency"], 25, "even sample counts take the integer mean of the middle two");
    assert!(e0.get("loss").is_none(), "a bucket that lost nothing omits the key");

    // Whole-window loss, not the mean of the buckets: even lost 1 of 5 samples
    // overall, where the per-bucket figures would be 0% and 33%.
    let overall = loss[&even.to_string()].as_f64().unwrap();
    assert!((overall - 20.0).abs() < 0.001, "{overall}");
    let dead_loss = loss[&dead.to_string()].as_f64().unwrap();
    assert!((dead_loss - 100.0).abs() < 0.001, "{dead_loss}");
}

/// A probe taken off a node stops appearing in its history immediately, and comes
/// back with its samples when it is reassigned.
#[test]
fn a_probe_taken_off_a_node_stops_appearing_in_its_history() {
    let db = db();
    let id = node(&db, 1);
    let assign = |nodes: Vec<i64>, task| {
        db.save_ping_task(&PingTask {
            id: task,
            name: "cm".into(),
            target: "1.1.1.1:443".into(),
            interval: 60,
            nodes,
        })
        .unwrap()
    };
    let task = probe(&db, vec![id]);
    db.insert_ping(id, task, 100, 42).unwrap();
    assert_eq!(db.ping_records(id, 0, 60).unwrap().0.len(), 1, "an assigned probe draws");

    assign(vec![], task);
    assert!(db.ping_records(id, 0, 60).unwrap().0.is_empty(), "an unassigned one does not");

    assign(vec![id], task);
    assert_eq!(db.ping_records(id, 0, 60).unwrap().0.len(), 1, "and it comes back with its history");

    assert_eq!(db.ping_task_names(id).unwrap()[&task.to_string()], "cm");
    let other = node(&db, 1);
    assert!(
        db.ping_task_names(other).unwrap().as_object().is_some_and(|m| m.is_empty()),
        "a node the probe was never assigned to must not learn its name"
    );
}

#[test]
fn ping_tasks_round_trip_with_their_node_assignments() {
    let db = db();
    let (a, b) = (node(&db, 1), node(&db, 1));
    let id = db
        .save_ping_task(&PingTask {
            id: 0,
            name: "cf".into(),
            target: "1.1.1.1:443".into(),
            interval: 60,
            nodes: vec![a, b],
        })
        .unwrap();
    assert_eq!(db.ping_tasks_for(a).unwrap().len(), 1);
    assert_eq!(db.ping_tasks().unwrap()[0].nodes.len(), 2);

    db.save_ping_task(&PingTask {
        id,
        name: "cf".into(),
        target: "1.1.1.1:443".into(),
        interval: 30,
        nodes: vec![a],
    })
    .unwrap();
    assert_eq!(db.ping_tasks_for(b).unwrap().len(), 0);
    assert_eq!(db.ping_tasks().unwrap()[0].interval, 30);
}

// ---- sessions ----

#[test]
fn sessions_expire_and_can_be_revoked() {
    let db = db();
    let now = Utc::now().timestamp();
    db.create_session(&sha256("a"), now + 3_600).unwrap();
    db.create_session(&sha256("b"), now - 1).unwrap();
    assert!(db.session_valid(&sha256("a")));
    assert!(!db.session_valid(&sha256("b")), "an expired session is not valid");
    assert_eq!(db.sessions().unwrap().len(), 1, "and it is not listed");

    db.drop_session(&sha256("a")).unwrap();
    assert!(!db.session_valid(&sha256("a")));

    db.create_session(&sha256("c"), now + 3_600).unwrap();
    db.drop_all_sessions().unwrap();
    assert!(db.sessions().unwrap().is_empty());
    db.expire_sessions().unwrap();
}

// ---- the database file, backup and restore ----

/// `oldest` is what the data page compares against the retention window, so it
/// must span both history tables rather than whichever happens to have rows.
#[test]
fn stats_report_the_earliest_history_row_and_the_window_it_is_kept_for() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let id = node(&db, 1);
    let now = Utc::now().timestamp();

    assert_eq!(db.stats().unwrap()["oldest"], serde_json::Value::Null, "no history, no start");
    assert_eq!(db.stats().unwrap()["retention"], 30, "an unset window is the default");
    assert_eq!(db.stats().unwrap()["engine"], ENGINE_VERSION);
    assert_eq!(db.stats().unwrap()["schema"], schema::SCHEMA_VERSION);

    db.insert_metric(id, now - 3 * 86_400, &serde_json::json!({"cpu": 1.0})).unwrap();
    assert_eq!(db.stats().unwrap()["oldest"], now - 3 * 86_400);

    let task = probe(&db, vec![id]);
    db.insert_ping(id, task, now - 9 * 86_400, 12).unwrap();
    assert_eq!(db.stats().unwrap()["oldest"], now - 9 * 86_400);

    db.set("retention_days", "9999").unwrap();
    assert_eq!(db.stats().unwrap()["retention"], 3_650, "a stored window is still clamped");
}

/// Deleted rows leave reusable blocks inside the file. Only a copy returns them
/// to the filesystem, and only a measured difference may be reported as freed.
///
/// The fixture is a few dozen nodes carrying long remarks rather than hundreds of
/// thousands of history rows: what is measured is the file size before and after,
/// and this reaches the same size in a fraction of the time the engine needs to
/// insert that many small rows one at a time.
#[test]
fn maintenance_reclaims_space_and_reports_only_what_it_measured() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let filler = "x".repeat(128 * 1024);
    let mut doomed = Vec::new();
    for i in 0..48 {
        doomed.push(
            db.create_node(
                &Node { name: format!("n{i}"), remark: filler.clone(), ..Default::default() },
                &format!("token-{i}"),
            )
            .unwrap(),
        );
    }
    db.exec("CHECKPOINT").unwrap();
    let fat = std::fs::metadata(&scratch.0).unwrap().len() as i64;
    assert!(fat > 4 * 1024 * 1024, "the fixture has to be worth rewriting: {fat}");

    for id in &doomed {
        db.delete_node(*id).unwrap();
    }
    assert_eq!(db.prune(0).unwrap(), 0, "nothing in the history tables was old enough to prune");

    let report = db.maintenance(0).map_err(|e| format!("{e:#}")).unwrap();
    assert!(report.compacted, "the deleted rows leave enough space to be worth rewriting");
    assert!(report.freed > 0, "a rewrite after deleting that much has to return space");
    let now_on_disk = std::fs::metadata(&scratch.0).unwrap().len() as i64;
    assert!(now_on_disk < fat, "{now_on_disk} should be smaller than {fat}");
    assert_eq!(report.size, now_on_disk, "the reported size is the file that is there");
    assert!(db.nodes().unwrap().is_empty());

    // The database still works afterwards: this is the file that was reopened.
    let kept = node(&db, 1);
    db.insert_metric(kept, Utc::now().timestamp(), &serde_json::json!({"cpu": 1.0})).unwrap();
    assert_eq!(db.metrics(kept, 0, 60).unwrap().len(), 1);
}

/// A small deletion must not trigger a full rewrite, and the report must say so
/// rather than claim space it did not return.
#[test]
fn maintenance_leaves_a_small_database_alone() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let report = db.maintenance(7).unwrap();
    assert!(!report.compacted);
    assert_eq!(report.freed, 0);
    assert_eq!(report.pruned, 0);
}

/// A hub capped at 64 MiB for normal service must still be able to restore a
/// bulky history archive. Restore temporarily derives a larger staging ceiling
/// from the archive's indexed row count; without that, DuckDB's primary-key
/// index build fails at the service limit before the archive can be validated.
#[test]
fn a_low_memory_hub_restores_a_history_larger_than_its_service_limit() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    // Seed the history and take the archive with a normal-sized engine; the
    // regression is the restore path when the hub is then capped at 64 MiB.
    {
        let seed_options = Options { memory_limit: "512MB".into(), threads: 1, ..Default::default() };
        let seed = Db::open_with(&scratch.0, seed_options).unwrap();
        let id = node(&seed, 1);
        let task = probe(&seed, vec![id]);
        seed.exec(&format!(
            "INSERT INTO ping_record (node_id, task_id, ts, latency)
             SELECT {id}, {task}, i, 42 FROM range(0, 1500000) s(i)"
        ))
        .unwrap();
        let report = seed.backup_into(&copy).unwrap();
        assert_eq!(report.rows["ping_record"], 1_500_000);
        seed.close().unwrap();
    }
    let options = Options { memory_limit: "64MB".into(), threads: 1, ..Default::default() };
    let db = Db::open_with(&scratch.0, options).unwrap();

    let restored = db.restore_from(&copy).unwrap();
    assert_eq!(restored.rows["ping_record"], 1_500_000);
    assert_eq!(db.scalar("SELECT COUNT(*) FROM ping_record").unwrap(), 1_500_000);
    assert_eq!(
        db.scalar(
            "SELECT COUNT(*) FROM duckdb_constraints()
             WHERE table_name='ping_record' AND constraint_type='PRIMARY KEY'"
        )
        .unwrap(),
        1,
        "the deferred staging key must be present in the restored database"
    );
    let _ = std::fs::remove_file(&copy);
}

/// The whole path: take a copy, change the live database, restore the copy, and
/// confirm the change is gone while the database remains usable.
#[test]
fn a_backup_restores_the_database_it_was_taken_from() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let db = Db::open(&scratch.0).unwrap();
    let kept =
        db.create_node(&Node { name: "backed-up".into(), ..Default::default() }, "token-kept").unwrap();
    let task = probe(&db, vec![kept]);
    db.insert_ping(kept, task, 1_700_000_000, 12).unwrap();
    db.insert_metric(kept, 1_700_000_000, &serde_json::json!({"cpu": 3.0})).unwrap();
    db.accumulate(kept, "boot", Some((10, 10))).unwrap();
    db.accumulate(kept, "boot", Some((1_010, 1_010))).unwrap();
    db.set("site_name", "before").unwrap();
    db.create_session(&sha256("live-session"), Utc::now().timestamp() + 3_600).unwrap();
    let report = db.backup_into(&copy).unwrap();
    assert_eq!(report.schema, schema::SCHEMA_VERSION);
    assert!(report.rows["node"] >= 1 && report.rows["metric"] == 1);

    // Everything after the copy must disappear on restore.
    db.delete_node(kept).unwrap();
    let after = db.create_node(&Node { name: "after".into(), ..Default::default() }, "token-after").unwrap();
    db.set("site_name", "after").unwrap();

    let inspected = db.check_backup(&copy).unwrap();
    assert_eq!(inspected.rows["node"], report.rows["node"]);

    let restored = db.restore_from(&copy).unwrap();
    assert_eq!(restored.rows["node"], report.rows["node"]);
    let back = db.nodes().unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].name, "backed-up");
    assert_eq!(back[0].id, kept, "the identifiers in the backup are preserved");
    assert_eq!(db.node_by_token("token-kept").unwrap(), Some(kept));
    assert!(db.node_by_token("token-after").unwrap().is_none(), "the row made after the copy is gone");
    assert_eq!(db.get("site_name").as_deref(), Some("before"));
    assert_eq!(db.metrics(kept, 0, 60).unwrap()[0]["cpu"], 3.0);
    assert_eq!(db.all_traffic()[&kept].total_rx, 1_000);
    assert_eq!(db.ping_records(kept, 0, 60).unwrap().0.len(), 1);
    assert!(!db.session_valid(&sha256("live-session")), "sessions do not survive a restore");
    assert!(db.sessions().unwrap().is_empty());

    // The connection remains the hub's: it can write, and the identity allocator
    // is past the ids the backup brought in.
    let next = node(&db, 1);
    assert!(next > back[0].id, "a new id cannot collide with a restored one: {next}");
    let _ = after;
    assert_eq!(db.engine_version(), ENGINE_VERSION);
    let _ = std::fs::remove_file(&copy);
}

/// A restore into an in-memory database takes the other activation path: there is
/// no file to rename, so the rows are replaced inside one transaction.
#[test]
fn an_in_memory_database_restores_by_replacing_its_rows() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let live = Db::open(&scratch.0).unwrap();
    let kept = live.create_node(&Node { name: "kept".into(), ..Default::default() }, "kept").unwrap();
    live.set("site_name", "backup").unwrap();
    live.backup_into(&copy).unwrap();
    live.delete_node(kept).unwrap();
    live.set("site_name", "live").unwrap();

    let memory = db();
    memory.restore_from(&copy).map_err(|e| format!("{e:#}")).unwrap();
    assert_eq!(memory.nodes().unwrap().len(), 1);
    assert_eq!(memory.nodes().unwrap()[0].id, kept);
    assert_eq!(memory.get("site_name").as_deref(), Some("backup"));
    assert_eq!(node(&memory, 1), kept + 1, "the allocator moved past the restored ids");
    let _ = std::fs::remove_file(&copy);
}

/// Everything that makes an upload not a backup of this hub. Each case must be
/// caught before the live database is touched.
#[test]
fn restore_refuses_anything_that_is_not_a_backup_of_this_hub() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let kept = db.create_node(&Node { name: "live".into(), ..Default::default() }, "live-token").unwrap();
    let good = scratch.copy(".good");
    db.backup_into(&good).unwrap();
    let bad = scratch.copy(".copy");

    std::fs::write(&bad, b"this is not a database at all").unwrap();
    assert!(db.check_backup(&bad).is_err(), "not a gzipped tar");
    assert!(db.restore_from(&bad).is_err());

    // A member whose path escapes the extraction directory.
    let escaped = build_archive(&[("../../etc/passwd", b"x".to_vec())]);
    std::fs::write(&bad, &escaped).unwrap();
    assert!(db.check_backup(&bad).is_err(), "a path that escapes is refused");

    // A member that is not part of the format.
    let extra = build_archive(&[("notes.txt", b"hello".to_vec())]);
    std::fs::write(&bad, &extra).unwrap();
    assert!(db.check_backup(&bad).is_err(), "an unknown member is refused");

    // A tampered Parquet member: the manifest digest is what catches it. The
    // member is rewritten inside the archive rather than the archive being
    // corrupted, so what is being tested is the digest and not gzip's checksum.
    let tampered = tamper_member(&good, "metric.parquet");
    std::fs::write(&bad, &tampered).unwrap();
    let refused = db.check_backup(&bad).unwrap_err().to_string();
    assert!(
        refused.contains("摘要")
            || refused.contains("gzip")
            || refused.contains("manifest")
            || refused.contains("成员")
            || refused.contains("parquet")
            || refused.contains("Parquet"),
        "{refused}"
    );

    // A manifest from a newer build.
    let manifest =
        br#"{"format":3,"kind":"romi-duckdb-backup","schema":9999,"engine":"v9","created_at":0,"tables":{}}"#;
    let newer = build_archive(&[("manifest.json", manifest.to_vec())]);
    std::fs::write(&bad, &newer).unwrap();
    let refused = db.check_backup(&bad).unwrap_err().to_string();
    assert!(refused.contains("9999") || refused.contains("缺少"), "{refused}");

    // None of that may have disturbed the live database.
    assert_eq!(db.nodes().unwrap().len(), 1);
    assert_eq!(db.nodes().unwrap()[0].id, kept);
    assert_eq!(db.node_by_token("live-token").unwrap(), Some(kept));
    let _ = std::fs::remove_file(&good);
}

/// A failure *before* the switch must leave the original in service. The failure
/// is injected where a real one happens: the original cannot be moved aside, so
/// the switch never starts.
#[test]
fn a_failed_switch_before_the_swap_leaves_the_original_in_service() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let kept = db.create_node(&Node { name: "live".into(), ..Default::default() }, "live-token").unwrap();
    let copy = scratch.copy(".copy");
    db.backup_into(&copy).unwrap();

    // `<db>.replaced` is where the original is moved to. A non-empty directory
    // there makes that rename fail, which is the first thing the switch does.
    let blocked = scratch.copy(".replaced");
    std::fs::create_dir_all(&blocked).unwrap();
    std::fs::write(format!("{blocked}/occupied"), b"x").unwrap();

    let refused = db.restore_from(&copy);
    assert!(refused.is_err(), "the switch must fail rather than half-happen");
    assert!(refused.unwrap_err().to_string().contains("原库"), "and say the original is intact");

    let nodes = db.nodes().unwrap();
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].id, kept);
    assert_eq!(db.node_by_token("live-token").unwrap(), Some(kept));
    let fresh = node(&db, 1);
    assert!(fresh > kept, "the database is still writable after the failed switch");
    assert_eq!(db.get("site_name"), None);
    let _ = std::fs::remove_dir_all(&blocked);
    let _ = std::fs::remove_file(&copy);
}

/// A failure *during* the switch: the new file is published and then cannot be
/// opened. The original has to come back, and the hub has to keep working.
#[test]
fn a_failed_reopen_after_the_swap_rolls_back_to_the_original() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let kept = db.create_node(&Node { name: "live".into(), ..Default::default() }, "live-token").unwrap();
    db.set("site_name", "original").unwrap();

    // A staging file that renames into place and then fails to open: a DuckDB
    // path whose contents are not a database.
    let staging = crate::db::backup::scratch_file(&scratch.0, "corrupt");
    std::fs::write(&staging, b"not a duckdb file at all, but named like one").unwrap();
    let refused = crate::db::backup::activate_for_test(&db, &staging);
    assert!(refused.is_err(), "reopening a corrupt file must fail");

    let nodes = db.nodes().unwrap();
    assert_eq!(nodes.len(), 1, "the original rows are back");
    assert_eq!(nodes[0].id, kept);
    assert_eq!(db.get("site_name").as_deref(), Some("original"));
    assert_eq!(db.node_by_token("live-token").unwrap(), Some(kept));
    assert!(node(&db, 1) > kept, "and the database is writable");
    let _ = std::fs::remove_file(&staging);
}

/// A backup of an empty database is the case that passes trivially, so the round
/// trip above covers a populated one; this covers the other direction, that an
/// empty archive restores to an empty database rather than to a broken one.
#[test]
fn an_empty_database_round_trips() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let db = Db::open(&scratch.0).unwrap();
    db.backup_into(&copy).unwrap();
    let report = db.restore_from(&copy).unwrap();
    assert!(report.rows.values().all(|n| *n == 0));
    assert!(db.nodes().unwrap().is_empty());
    assert_eq!(node(&db, 1), 1, "the allocator starts from one again");
    let _ = std::fs::remove_file(&copy);
}

// ---- the writer queue ----

/// Queued work is committed before `close` returns, and the counters distinguish
/// what was merely accepted from what reached the disk.
#[test]
fn accepted_writes_are_committed_before_close() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let id = node(&db, 1);
    for i in 0..500 {
        db.insert_metric(id, 60 * i, &serde_json::json!({"cpu": 1.0})).unwrap();
    }
    let stats = db.queue_stats();
    assert_eq!(stats["queued_ops_current"], 0, "every accepted write has been answered");
    assert_eq!(stats["committed_ops_total"], stats["accepted_ops_total"], "every accepted write committed");
    assert_eq!(stats["refused_ops_total"], 0);
    assert_eq!(stats["failed_ops_total"], 0);
    assert!(stats["committed_ops_total"].as_u64().unwrap() >= 500);
    db.close().unwrap();

    // The rows are in the file, not in the process that wrote them.
    let reopened = Db::open(&scratch.0).unwrap();
    assert_eq!(reopened.metrics(id, 0, 60).unwrap().len(), 500);
    reopened.close().unwrap();
}

/// Data committed before an unclean stop has to be there afterwards: the write
/// ahead log is the engine's guarantee, and the hub must not depend on its own
/// clean shutdown to keep rows.
#[test]
fn committed_rows_survive_an_unclean_stop() {
    let scratch = Scratch::new();
    {
        let db = Db::open(&scratch.0).unwrap();
        let id = db.create_node(&Node { name: "kept".into(), ..Default::default() }, "token").unwrap();
        db.accumulate(id, "boot", Some((0, 0))).unwrap();
        db.accumulate(id, "boot", Some((4_096, 2_048))).unwrap();
        db.insert_metric(id, 60, &serde_json::json!({"cpu": 2.0})).unwrap();
        db.set("before_crash", "yes").unwrap();
        // No `close`: the final checkpoint never runs, exactly as after a kill.
    }
    let reopened = Db::open(&scratch.0).unwrap();
    assert_eq!(reopened.get("before_crash").as_deref(), Some("yes"));
    let nodes = reopened.nodes().unwrap();
    assert_eq!(nodes.len(), 1);
    assert_eq!(reopened.all_traffic()[&nodes[0].id].total_rx, 4_096);
    assert_eq!(reopened.metrics(nodes[0].id, 0, 60).unwrap().len(), 1);
    reopened.close().unwrap();
}

/// A write accepted before the database is replaced must not land in the
/// database that replaced it.
#[test]
fn a_write_queued_across_a_restore_does_not_land_in_the_restored_database() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let db = Db::open(&scratch.0).unwrap();
    let kept = db.create_node(&Node { name: "kept".into(), ..Default::default() }, "kept-token").unwrap();
    db.backup_into(&copy).unwrap();
    let doomed = node(&db, 1);
    db.insert_metric(doomed, 60, &serde_json::json!({"cpu": 1.0})).unwrap();

    db.restore_from(&copy).unwrap();
    assert!(db.node(doomed).unwrap().is_none(), "the node made after the copy is gone");
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric").unwrap(), 0);
    // A late write for the node that no longer exists is dropped, not orphaned.
    db.insert_metric(doomed, 120, &serde_json::json!({"cpu": 1.0})).unwrap();
    assert_eq!(db.scalar("SELECT COUNT(*) FROM metric").unwrap(), 0);
    assert_eq!(db.nodes().unwrap()[0].id, kept);
    let _ = std::fs::remove_file(&copy);
}

// ---- new phase tests: snapshot backup, limits, queue accounting, shutdown ----

/// Resets every test-only writer/backup hook even if an assertion fails, so one
/// failed test cannot slow or break the next one.
struct ResetTestHooks;

impl Drop for ResetTestHooks {
    fn drop(&mut self) {
        TEST_BATCH_HOLD_NANOS.store(0, Ordering::Relaxed);
        crate::db::backup::TEST_BACKUP_HOLD_NANOS.store(0, Ordering::Relaxed);
        crate::db::backup::FAIL_AFTER_EXPORT.store(-1, Ordering::Relaxed);
    }
}

fn wait_until(mut done: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A snapshot export must not take the replacement path: no queued telemetry is
/// refused, the generation does not move, and every table is read from one MVCC
/// snapshot even while a writer mutation commits between exports.
#[test]
fn a_snapshot_export_does_not_refuse_telemetry_and_reads_one_mvcc_snapshot() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let db = Db::open(&scratch.0).unwrap();
    let id = node(&db, 1);
    db.insert_metric(id, 60, &serde_json::json!({"cpu": 1.0})).unwrap();
    db.touch_seen(id, 60).unwrap();

    let before = db.queue_stats();
    let refused_before = before["refused_ops_total"].as_u64().unwrap();
    let _reset = ResetTestHooks;
    crate::db::backup::TEST_BACKUP_HOLD_NANOS.store(400_000_000, Ordering::Relaxed);

    let backup_db = db.clone();
    let backup_path = copy.clone();
    let worker = std::thread::spawn(move || backup_db.backup_into(&backup_path));
    wait_until(
        || crate::db::backup::TEST_BACKUP_ACTIVE.load(Ordering::SeqCst),
        "the snapshot to reach its hold point",
    );

    // Accepted while the snapshot transaction is open: normal telemetry, not a
    // replacement, so it must commit rather than be marked superseded.
    db.insert_metric(id, 120, &serde_json::json!({"cpu": 2.0})).unwrap();
    db.set("snapshot_probe", "yes").unwrap();
    // A multi-table mutation between two exports. A single MVCC snapshot means
    // the report below sees the state before this delete for every table.
    db.delete_node(id).unwrap();
    crate::db::backup::TEST_BACKUP_HOLD_NANOS.store(0, Ordering::Relaxed);

    let report = worker.join().unwrap().unwrap();
    assert_eq!(report.rows["node"], 1, "the snapshot predates the delete");
    assert_eq!(report.rows["traffic"], 1);
    assert_eq!(report.rows["metric"], 1, "and predates the telemetry committed during the hold");
    assert!(!report.rows.contains_key("session"), "session is not a backup table");
    let after = db.queue_stats();
    assert_eq!(
        after["refused_ops_total"].as_u64().unwrap(),
        refused_before,
        "a backup snapshot must never mark accepted telemetry superseded"
    );
    assert_eq!(after["queued_ops_current"], 0);

    // The live database remains writable afterwards, and the archive restores
    // as a consistent database.
    let fresh = node(&db, 1);
    db.insert_metric(fresh, 180, &serde_json::json!({"cpu": 3.0})).unwrap();
    let inspected = db.check_backup(&copy).unwrap();
    assert_eq!(inspected.format, 3);
    let restored = Db::open(":memory:").unwrap();
    restored.restore_from(&copy).map_err(|e| format!("{e:#}")).unwrap();
    assert_eq!(restored.nodes().unwrap().len(), 1, "the snapshot was internally consistent");
    assert_eq!(restored.metrics(1, 0, 60).unwrap().len(), 1);
    let _ = std::fs::remove_file(&copy);
}

/// If an export fails after `BEGIN`, rollback-on-drop must leave the reader
/// connection immediately reusable: no open transaction, and normal storage
/// operations continue.
#[test]
fn a_failed_backup_rolls_back_and_leaves_the_pool_reusable() {
    let scratch = Scratch::new();
    let copy = scratch.copy(".copy");
    let db = Db::open(&scratch.0).unwrap();
    let id = node(&db, 1);
    let _reset = ResetTestHooks;
    // Fail when the first table has been exported and the next begins: that is
    // unambiguously inside the transaction.
    crate::db::backup::FAIL_AFTER_EXPORT.store(1, Ordering::Relaxed);
    let refused = db.backup_into(&copy);
    assert!(refused.is_err(), "the injected export failure must surface");
    assert!(!std::path::Path::new(&copy).exists(), "a failed backup publishes nothing");

    // Normal reads and writes still work.
    db.set("after_failed_backup", "yes").unwrap();
    assert_eq!(db.get("after_failed_backup").as_deref(), Some("yes"));
    db.insert_metric(id, 60, &serde_json::json!({"cpu": 1.0})).unwrap();

    crate::db::backup::FAIL_AFTER_EXPORT.store(-1, Ordering::Relaxed);
    // The failed transaction ran on one pooled reader. `backup_into` cycles the
    // pool, so repeating the export proves every reader -- including the one
    // that failed -- can start a transaction again. A leaked `BEGIN` would make
    // one of these fail.
    for _ in 0..(READERS + 1) {
        db.backup_into(&copy).map_err(|e| format!("{e:#}")).unwrap();
    }
    assert!(db.check_backup(&copy).is_ok());
    let _ = std::fs::remove_file(&copy);
}

/// Each archive resource limit is enforced independently. Limits are lowered
/// here so the fixtures stay tiny.
#[test]
fn the_archive_validator_enforces_member_count_size_and_total_limits() {
    let scratch = Scratch::new();
    let archive_path = scratch.copy(".limits");
    let work = std::env::temp_dir().join(format!("romi-limits-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&work).unwrap();
    let limits = |compressed, members, member, total| crate::db::backup::ArchiveLimits {
        compressed,
        members,
        member,
        total,
        manifest: 1024,
    };
    let write = |members: &[(&str, Vec<u8>)]| {
        std::fs::write(&archive_path, build_archive(members)).unwrap();
    };
    let check = |limits| {
        crate::db::backup::extract_and_validate_with(&archive_path, work.to_str().unwrap(), limits)
            .unwrap_err()
            .to_string()
    };

    // Compressed upload ceiling.
    write(&[("setting.parquet", vec![0u8; 64])]);
    assert!(check(limits(8, 8, 1024, 1024)).contains("上传上限"));
    // Member count ceiling.
    write(&[("setting.parquet", vec![0u8; 4]), ("node.parquet", vec![0u8; 4])]);
    assert!(check(limits(1024, 1, 1024, 1024)).contains("成员数"));
    // Per-member expanded ceiling.
    write(&[("setting.parquet", vec![0u8; 32])]);
    assert!(check(limits(1024, 8, 16, 1024)).contains("单个成员上限"));
    // Total expanded ceiling: each member is valid on its own, the sum is not.
    write(&[("setting.parquet", vec![0u8; 32]), ("node.parquet", vec![0u8; 32])]);
    assert!(check(limits(1024, 8, 64, 48)).contains("展开总量"));
    // Duplicate member.
    write(&[("setting.parquet", vec![0u8; 4]), ("setting.parquet", vec![0u8; 4])]);
    assert!(check(limits(1024, 8, 1024, 1024)).contains("重复"));
    // Unknown member and path traversal are refused before anything is built.
    write(&[("notes.txt", vec![0u8; 4])]);
    assert!(check(limits(1024, 8, 1024, 1024)).contains("未知"));
    write(&[("../outside.parquet", vec![0u8; 4])]);
    assert!(check(limits(1024, 8, 1024, 1024)).contains("路径不安全"));
    let _ = std::fs::remove_dir_all(&work);
    let _ = std::fs::remove_file(&archive_path);
}

/// One batch transaction with N telemetry jobs commits N operations and one
/// transaction. The writer is held briefly so the jobs queue deterministically.
#[test]
fn one_batch_counts_every_operation_and_one_transaction() {
    let db = db();
    let id = node(&db, 1);
    let _reset = ResetTestHooks;
    let before = db.queue_stats();
    TEST_BATCH_HOLD_NANOS.store(200_000_000, Ordering::Relaxed);

    let writers: Vec<_> = (0..8)
        .map(|i| {
            let db = db.clone();
            std::thread::spawn(move || db.insert_metric(id, 100 + i, &serde_json::json!({"cpu": 1.0})))
        })
        .collect();
    for writer in writers {
        writer.join().unwrap().unwrap();
    }
    TEST_BATCH_HOLD_NANOS.store(0, Ordering::Relaxed);
    let after = db.queue_stats();
    let delta = |key: &str| after[key].as_u64().unwrap() - before[key].as_u64().unwrap();
    assert_eq!(delta("batch_transactions_total"), 1);
    assert_eq!(delta("batch_ops_total"), 8);
    assert_eq!(delta("committed_ops_total"), 8, "one committed operation per telemetry job");
    assert_eq!(delta("transactions_total"), 1, "the whole group commit is one transaction");
    assert_eq!(after["queued_ops_current"], 0);
    assert!(after["max_batch_size"].as_u64().unwrap() >= 8);
    assert_eq!(after["average_batch_size"].as_f64().unwrap(), 8.0);
    assert!(after["transaction_us_total"].as_u64().unwrap() > 0);
}

/// One failing job does not take the telemetry sharing its group commit with it:
/// the batch is rolled back and replayed job by job, and only the job at fault
/// fails.
#[test]
fn one_failing_job_does_not_roll_back_its_batch_neighbours() {
    let db = db();
    let id = node(&db, 1);
    let _reset = ResetTestHooks;
    let before = db.queue_stats();
    TEST_BATCH_HOLD_NANOS.store(200_000_000, Ordering::Relaxed);

    let writers: Vec<_> = (0..6)
        .map(|i| {
            let db = db.clone();
            std::thread::spawn(move || db.insert_metric(id, 600 + i * 60, &serde_json::json!({"cpu": 1.0})))
        })
        .collect();
    let failing = {
        let db = db.clone();
        std::thread::spawn(move || db.write_batch(|_| -> Result<()> { anyhow::bail!("refused on purpose") }))
    };
    for writer in writers {
        writer.join().unwrap().unwrap();
    }
    assert!(failing.join().unwrap().is_err(), "the job at fault still reports its failure");
    TEST_BATCH_HOLD_NANOS.store(0, Ordering::Relaxed);

    assert_eq!(db.scalar(&format!("SELECT COUNT(*) FROM metric WHERE node_id={id}")).unwrap(), 6);
    let after = db.queue_stats();
    let delta = |key: &str| after[key].as_u64().unwrap() - before[key].as_u64().unwrap();
    assert_eq!(delta("committed_ops_total"), 6);
    assert_eq!(delta("failed_ops_total"), 1);
    assert_eq!(after["queued_ops_current"], 0);
}

/// A queued job whose database generation became stale is refused, never
/// counted as committed.
#[test]
fn a_generation_change_refuses_queued_work_without_counting_it_committed() {
    let db = db();
    let id = node(&db, 1);
    let _reset = ResetTestHooks;
    let before = db.queue_stats();
    TEST_BATCH_HOLD_NANOS.store(300_000_000, Ordering::Relaxed);
    let writer_db = db.clone();
    let writer = std::thread::spawn(move || writer_db.insert_metric(id, 1, &serde_json::json!({"cpu": 1.0})));
    wait_until(
        || db.queue_stats()["queued_ops_current"].as_u64().unwrap() > 0,
        "the telemetry job to be accepted",
    );
    db.inner_handle().generation.fetch_add(1, Ordering::SeqCst);
    assert!(writer.join().unwrap().is_err(), "a superseded job must not report success");
    TEST_BATCH_HOLD_NANOS.store(0, Ordering::Relaxed);

    let after = db.queue_stats();
    assert_eq!(
        after["refused_ops_total"].as_u64().unwrap() - before["refused_ops_total"].as_u64().unwrap(),
        1
    );
    assert_eq!(after["committed_ops_total"], before["committed_ops_total"]);
    assert_eq!(after["queued_ops_current"], 0);
}

/// `close` refuses new work, drains accepted work, and releases the custom lock
/// only after the writer and reader handles are done. While it is closing, a
/// second hub cannot take the file; afterwards it can.
#[test]
fn close_drains_accepted_writes_and_releases_the_lock_last() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    let id = node(&db, 1);
    let _reset = ResetTestHooks;
    TEST_BATCH_HOLD_NANOS.store(400_000_000, Ordering::Relaxed);
    let writer_db = db.clone();
    let writer = std::thread::spawn(move || writer_db.insert_metric(id, 1, &serde_json::json!({"cpu": 1.0})));
    wait_until(|| db.queue_stats()["queued_ops_current"].as_u64().unwrap() > 0, "the write to be accepted");

    let closer = db.clone();
    let closing = std::thread::spawn(move || closer.close());
    wait_until(|| db.inner_handle().closed.load(Ordering::SeqCst), "close to start");
    assert!(Db::open(&scratch.0).is_err(), "the lock must still be held while close drains the writer");

    closing.join().unwrap().unwrap();
    writer.join().unwrap().unwrap();
    assert!(db.set("after_close", "refused").is_err(), "a closed handle accepts no work");

    let reopened = Db::open(&scratch.0).unwrap();
    assert_eq!(reopened.scalar("SELECT COUNT(*) FROM metric").unwrap(), 1, "the accepted write committed");
    reopened.close().unwrap();
}

/// Format detection reads a fixed-size header, never the whole file. A large
/// sparse foreign file is refused immediately and left at its original length.
#[test]
fn format_detection_does_not_depend_on_file_size() {
    let scratch = Scratch::new();
    let mut file = std::fs::File::create(&scratch.0).unwrap();
    std::io::Write::write_all(&mut file, b"not a duckdb file at all").unwrap();
    let bytes = 4u64 * 1024 * 1024 * 1024;
    file.set_len(bytes).unwrap();
    drop(file);

    let started = Instant::now();
    let refused = format!("{:#}", Db::open(&scratch.0).unwrap_err());
    assert!(refused.contains("romi"), "{refused}");
    assert!(started.elapsed() < Duration::from_secs(5), "a header read must not scan four GiB");
    assert_eq!(std::fs::metadata(&scratch.0).unwrap().len(), bytes, "the file was not modified");
}

// ---- helpers ----

/// Builds a gzipped tar from in-memory members, for the negative restore cases.
fn build_archive(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let encoder = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
        let mut tar = tar::Builder::new(encoder);
        for (name, data) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            {
                let gnu = header.as_gnu_mut().unwrap();
                let bytes = name.as_bytes();
                gnu.name[..bytes.len()].copy_from_slice(bytes);
            }
            header.set_cksum();
            tar.append(&header, data.as_slice()).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }
    out
}

/// Rewrites one member of a gzipped tar with a single flipped byte, leaving the
/// archive itself well formed.
fn tamper_member(src: &str, member: &str) -> Vec<u8> {
    let file = std::fs::File::open(src).unwrap();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut out = Vec::new();
    {
        let encoder = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let name = entry.path().unwrap().to_string_lossy().into_owned();
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
            if name == member {
                let at = data.len() / 2;
                data[at] ^= 0xff;
            }
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, &name, data.as_slice()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }
    out
}

#[test]
fn v7_metadata_continuity_and_nullable_history_survive_storage() {
    let db = db();
    let node: Node = serde_json::from_value(serde_json::json!({"name":"v7"})).unwrap();
    assert!(node.public);
    let id = db.create_node(&node, "v7-token").unwrap();
    db.update_node(
        id,
        &NodePatch {
            priority: Some(123),
            bandwidth_up: Some(500.0),
            bandwidth_down: Some(2500.0),
            has_ipv6: Some(true),
            traffic_unit: Some("TB".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let n = db.node(id).unwrap().unwrap();
    assert_eq!(n.priority, 123);
    assert_eq!(n.bandwidth_down, 2500.0);
    assert_eq!(n.traffic_unit, "TB");
    assert!(n.has_ipv6);
    db.touch_seen(id, 1000).unwrap();
    db.touch_seen(id, 1300).unwrap();
    assert_eq!(db.node(id).unwrap().unwrap().online_since, 1000);
    db.touch_seen(id, 1601).unwrap();
    assert_eq!(db.node(id).unwrap().unwrap().online_since, 1601);
    db.touch_seen(id, 1500).unwrap();
    assert_eq!(db.node(id).unwrap().unwrap().last_seen, 1601);
    let now = Utc::now().timestamp() / 3600 * 3600;
    db.insert_metric(id, now - 7200, &serde_json::json!({"cpu":20,"zram_used":null,"swap_disk_used":null}))
        .unwrap();
    db.insert_metric(id,now-7140,&serde_json::json!({"cpu":40,"zram_used":12,"swap_disk_used":50,"swapfile_used":40,"swap_partition_used":10,"tcp":5,"udp":2,"procs":9})).unwrap();
    let raw = db.metrics(id, now - 7200, 3600).unwrap();
    assert_eq!(raw[0]["zram_used"], 12);
    assert_eq!(raw[0]["swap_disk_used"], 50);
    db.prune(0).unwrap();
    let rolled = db.metrics(id, now - 7200, 3600).unwrap();
    assert_eq!(rolled, raw);
}

#[test]
fn v2_upgrade_preserves_private_nodes_and_old_history() {
    let path = Scratch::new();
    let copy = path.copy(".v2.tgz");
    let id;
    {
        let db = Db::open(&path.0).unwrap();
        id = db
            .create_node(
                &Node { name: "private legacy".into(), traffic_reset_day: 1, ..Default::default() },
                "upgrade-token",
            )
            .unwrap();
        db.insert_metric(id, 60, &serde_json::json!({"cpu":33})).unwrap();
        db.write(Kind::Solo,|conn|{
            for column in ["priority","bandwidth_up","bandwidth_down","has_ipv4","has_ipv6","online_since","traffic_unit"] {conn.execute_batch(&format!("ALTER TABLE node DROP COLUMN {column}"))?;}
            for column in ["zram_used","swap_disk_used","swapfile_used","swap_partition_used"] {conn.execute_batch(&format!("ALTER TABLE metric DROP COLUMN {column}"))?;}
            for column in ["tcp","udp","procs","zram_used","swap_disk_used","swapfile_used","swap_partition_used"] {conn.execute_batch(&format!("ALTER TABLE metric_hour DROP COLUMN {column}_sum; ALTER TABLE metric_hour DROP COLUMN {column}_samples"))?;}
            conn.execute_batch("UPDATE romi_schema SET version=2")?;Ok(())
        }).unwrap();
        db.backup_into(&copy).unwrap();
        use std::io::Read;
        let mut archive =
            tar::Archive::new(flate2::read::GzDecoder::new(std::fs::File::open(&copy).unwrap()));
        let mut members = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let name = entry.path().unwrap().to_string_lossy().into_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "manifest.json" {
                let mut m: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                m["schema"] = serde_json::json!(2);
                bytes = serde_json::to_vec(&m).unwrap();
            }
            members.push((name, bytes));
        }
        std::fs::write(
            &copy,
            build_archive(
                &members.iter().map(|(name, bytes)| (name.as_str(), bytes.clone())).collect::<Vec<_>>(),
            ),
        )
        .unwrap();
    }
    let db = Db::open(&path.0).unwrap();
    let n = db.node(id).unwrap().unwrap();
    assert!(!n.public);
    assert_eq!(n.priority, 0);
    assert_eq!(n.traffic_unit, "GB");
    assert_eq!(db.node_by_token("upgrade-token").unwrap(), Some(id));
    db.restore_from(&copy).unwrap();
    assert!(!db.node(id).unwrap().unwrap().public);
    let metrics = db.metrics(id, 0, 60).unwrap();
    assert_eq!(metrics[0]["cpu"], 33.0);
    assert!(metrics[0]["zram_used"].is_null());
    std::fs::remove_file(copy).unwrap();
}
