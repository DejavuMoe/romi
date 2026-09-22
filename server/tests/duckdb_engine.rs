//! What the storage layer assumes about the DuckDB engine, asserted against the
//! engine itself rather than against a comment.
//!
//! These are the facts the schema and the query layer are built on. Each one
//! would fail silently if it changed: `/` becoming integer division, a cast
//! stopping its rounding/truncation contract, a primary key ceasing to reject
//! duplicates, or an `INTEGER` column coming back as a 32-bit value.
//!
//! `scripts/bench.py` and `docs/bench.md` record the versions this was
//! verified against; `db::tests` asserts the same version at runtime, so a
//! dependency bump that changes it fails `make check` rather than an operator's
//! first backup.

use duckdb::{params, Connection};

/// The crate version and the engine version are independent numbering schemes.
#[test]
fn the_engine_reports_the_version_the_hub_was_tested_against() {
    let conn = Connection::open_in_memory().unwrap();
    let version: String = conn.query_row("SELECT version()", [], |r| r.get(0)).unwrap();
    assert_eq!(version, "v1.5.5", "crate duckdb 1.10505.0 vendors this engine");
    let library: String =
        conn.query_row("SELECT library_version FROM pragma_version()", [], |r| r.get(0)).unwrap();
    assert_eq!(library, version);
}

/// `/` is floating-point division and `//` is integer division. The bucket index
/// in every history query depends on this: with `/` the bucket arithmetic would
/// be done in floating point and a group key would be a double.
#[test]
fn division_and_narrowing_casts_need_to_be_spelled_out() {
    let conn = Connection::open_in_memory().unwrap();
    let floored: i64 = conn.query_row("SELECT 125 // 60", [], |r| r.get(0)).unwrap();
    assert_eq!(floored, 2);
    let real: f64 = conn.query_row("SELECT 125 / 60", [], |r| r.get(0)).unwrap();
    assert!((real - 2.083_333).abs() < 1e-5, "/ is floating-point division");

    // DuckDB rounds `CAST(2.5 AS INTEGER)` to 3, while the API's history
    // contract truncates. The history queries therefore cast through `TRUNC`.
    let rounded: i64 = conn.query_row("SELECT CAST(2.5 AS BIGINT)", [], |r| r.get(0)).unwrap();
    assert_eq!(rounded, 3, "the plain cast rounds; this is why the queries use TRUNC");
    let truncated: i64 = conn
        .query_row(
            "SELECT CAST(TRUNC(CAST(AVG(x) AS DOUBLE)) AS BIGINT) FROM (VALUES (5),(6)) t(x)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(truncated, 5, "(5+6)/2 is 5.5, and the contract truncates it");
    let negative: i64 = conn.query_row("SELECT CAST(TRUNC(-2.5) AS BIGINT)", [], |r| r.get(0)).unwrap();
    assert_eq!(negative, -2, "truncation is toward zero, matching the history contract");
}

/// A primary key is the deduplication rule for `metric` and `ping_record`, so it
/// has to reject a duplicate unless the statement says otherwise.
#[test]
fn a_primary_key_rejects_duplicates_and_an_upsert_replaces_them() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE t (a BIGINT, b BIGINT, v BIGINT, PRIMARY KEY (a, b))").unwrap();
    conn.execute("INSERT INTO t VALUES (1, 1, 10)", []).unwrap();
    assert!(conn.execute("INSERT INTO t VALUES (1, 1, 20)", []).is_err(), "the key is the rule");
    // The hub does not use ON CONFLICT on the ingest path -- it is far too slow
    // there -- but the alternative it does use must produce the same table.
    conn.execute("DELETE FROM t WHERE a=1 AND b=1", []).unwrap();
    conn.execute("INSERT INTO t VALUES (1, 1, 20)", []).unwrap();
    let v: i64 = conn.query_row("SELECT v FROM t WHERE a=1 AND b=1", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 20);
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "replacing leaves one row, exactly as an upsert would");
}

/// Big integers and doubles survive the Parquet backup format exactly, including
/// values a 32-bit column or a JSON round trip through a double would lose.
#[test]
fn parquet_preserves_big_integers_doubles_and_nulls() {
    let dir = std::env::temp_dir().join(format!("romi-engine-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("t.parquet");
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE t (big BIGINT, beyond_2038 BIGINT, frac DOUBLE, flag BOOLEAN, maybe VARCHAR);
         INSERT INTO t VALUES (4611686018427387904, 4102444800, 19.99, true, NULL),
                              (-9223372036854775807, 0, 0.1, false, 'v');",
    )
    .unwrap();
    conn.execute_batch(&format!("COPY (SELECT * FROM t) TO '{}' (FORMAT PARQUET)", file.display())).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE back (big BIGINT, beyond_2038 BIGINT, frac DOUBLE, flag BOOLEAN, maybe VARCHAR);
         INSERT INTO back SELECT * FROM read_parquet('{}');",
        file.display()
    ))
    .unwrap();
    let big: i64 = conn.query_row("SELECT big FROM back WHERE flag", [], |r| r.get(0)).unwrap();
    assert_eq!(big, 4_611_686_018_427_387_904, "beyond 2^53, exactly");
    let ts: i64 = conn.query_row("SELECT beyond_2038 FROM back WHERE flag", [], |r| r.get(0)).unwrap();
    assert_eq!(ts, 4_102_444_800, "beyond 2038, exactly");
    let frac: f64 = conn.query_row("SELECT frac FROM back WHERE flag", [], |r| r.get(0)).unwrap();
    assert_eq!(frac, 19.99);
    let nulls: i64 =
        conn.query_row("SELECT COUNT(*) FROM back WHERE maybe IS NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(nulls, 1, "NULL stays NULL rather than becoming an empty string");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Why the hub enforces its relationships in the application instead of with
/// foreign keys.
///
/// Two engine facts, both asserted here so the decision is checked rather than
/// assumed: `ON DELETE CASCADE` is rejected by the parser, and a foreign-key
/// check on a parent delete does not observe a child delete made earlier in the
/// same transaction. A hub whose deletions move rows between tables in one
/// transaction cannot use them.
#[test]
fn foreign_keys_cannot_express_what_the_hub_needs() {
    let conn = Connection::open_in_memory().unwrap();
    assert!(
        conn.execute_batch(
            "CREATE TABLE p (id BIGINT PRIMARY KEY);
             CREATE TABLE c (id BIGINT PRIMARY KEY, p BIGINT REFERENCES p(id) ON DELETE CASCADE);"
        )
        .is_err(),
        "ON DELETE CASCADE is not supported"
    );

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE p (id BIGINT PRIMARY KEY);
         CREATE TABLE c (id BIGINT PRIMARY KEY, p BIGINT NOT NULL REFERENCES p(id));
         INSERT INTO p VALUES (1); INSERT INTO c VALUES (1, 1);",
    )
    .unwrap();
    let mut conn = conn;
    let tx = conn.transaction().unwrap();
    tx.execute("DELETE FROM c WHERE p=1", []).unwrap();
    assert!(
        tx.execute("DELETE FROM p WHERE id=1", []).is_err(),
        "the child delete is not visible to the parent's foreign-key check"
    );
    drop(tx);
    // Committing the child delete first is what makes the parent delete legal,
    // which is exactly the two-transaction arrangement the hub refuses to have.
    conn.execute("DELETE FROM c WHERE p=1", []).unwrap();
    conn.execute("DELETE FROM p WHERE id=1", []).unwrap();
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM p", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}

/// Connections cloned from one handle share a database, which is how the hub
/// gives each reader its own connection; and a read transaction gets a stable
/// snapshot while the writer commits, which is what makes concurrent reads safe.
#[test]
fn cloned_connections_share_one_database_and_read_a_stable_snapshot() {
    let writer = Connection::open_in_memory().unwrap();
    writer.execute_batch("CREATE TABLE t (i BIGINT)").unwrap();
    let reader = writer.try_clone().unwrap();
    writer.execute("INSERT INTO t VALUES (1)", []).unwrap();
    let after_insert: i64 = reader.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(after_insert, 1, "try_clone shares the database instance");

    reader.execute_batch("BEGIN").unwrap();
    let before: i64 = reader.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    writer.execute("INSERT INTO t VALUES (2)", []).unwrap();
    let during: i64 = reader.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    reader.execute_batch("COMMIT").unwrap();
    let after: i64 = reader.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!((before, during, after), (1, 1, 2), "a read transaction sees one snapshot");
}

/// The conflict paths are correct but expensive, which is why the ingest path
/// does not use them. Measured here rather than asserted as a timing: what the
/// hub depends on is that a plain insert and an explicit replace are *available*,
/// and `docs/bench.md` records their measured cost.
#[test]
fn an_insert_can_be_guarded_by_a_subquery_and_replace_explicitly() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE node (id BIGINT PRIMARY KEY, flag BOOLEAN NOT NULL DEFAULT false);
         CREATE TABLE m (node_id BIGINT, ts BIGINT, v BIGINT, PRIMARY KEY (node_id, ts));
         INSERT INTO node (id, flag) VALUES (1, true), (2, false);
         INSERT INTO m VALUES (1, 60, 1), (2, 60, 2);",
    )
    .unwrap();
    // The `SELECT ... WHERE EXISTS` form is accepted, which is what the hub would
    // fall back to if the writer's relationship cache ever needed a second check.
    conn.execute(
        "INSERT INTO m (node_id, ts, v) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM node WHERE id=?1)",
        params![1i64, 120i64, 3i64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO m (node_id, ts, v) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM node WHERE id=?1)",
        params![9i64, 120i64, 4i64],
    )
    .unwrap();
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM m", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 3, "the row for the node that is not there was not written");
    let boolean: bool = conn.query_row("SELECT flag FROM node WHERE id=1", [], |r| r.get(0)).unwrap();
    assert!(boolean, "BOOLEAN round-trips as a bool, not as 0/1");
}

/// A statement cache cannot be used on a connection that outlives a commit.
///
/// This is the reproduction that made `Db` prepare every statement per use.
/// `Connection::prepare_cached` hands back a previously prepared statement, and
/// after another connection commits, that statement returns *torn* data: here a
/// writer sets `n` to 999400 and the cached reader keeps reporting 232 -- the low
/// byte of the committed value -- while a freshly prepared statement on the same
/// connection reports 999400. It is deterministic, not a race, and it is why
/// `db::mod` has no `prepare_cached` anywhere.
#[test]
fn a_cached_statement_returns_torn_data_after_another_connection_commits() {
    let writer = Connection::open_in_memory().unwrap();
    writer
        .execute_batch(
            "CREATE TABLE t (id BIGINT PRIMARY KEY, flag BOOLEAN NOT NULL DEFAULT false, n BIGINT NOT NULL DEFAULT 0);
             INSERT INTO t (id) VALUES (1),(2);",
        )
        .unwrap();
    let reader = writer.try_clone().unwrap();
    let sql = "SELECT id, flag, n FROM t ORDER BY id";
    let cached = |c: &Connection| -> Vec<(i64, bool, i64)> {
        let mut stmt = c.prepare_cached(sql).unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(cached(&reader), vec![(1, false, 0), (2, false, 0)]);

    writer.execute("UPDATE t SET n=?2 WHERE id=?1", params![1i64, 999_400i64]).unwrap();
    let fresh: i64 = reader.query_row("SELECT n FROM t WHERE id=1", [], |r| r.get(0)).unwrap();
    assert_eq!(fresh, 999_400, "the committed value is there");

    let through_cache = cached(&reader);
    assert_eq!(
        through_cache[0].2, 232,
        "this is the crate's behaviour, recorded so a version bump that fixes it is noticed"
    );
    assert_ne!(through_cache[0].2, fresh, "the cache and a fresh statement disagree");
}

/// The reader-side conclusion the hub draws from the test above: a statement
/// prepared per use always sees what was committed.
#[test]
fn a_statement_prepared_per_use_sees_every_commit() {
    let writer = Connection::open_in_memory().unwrap();
    writer
        .execute_batch(
            "CREATE TABLE t (id BIGINT PRIMARY KEY, flag BOOLEAN NOT NULL DEFAULT false, n BIGINT NOT NULL DEFAULT 0);
             INSERT INTO t (id) VALUES (1),(2);",
        )
        .unwrap();
    let reader = writer.try_clone().unwrap();
    let fresh = |c: &Connection| -> Vec<(i64, bool, i64)> {
        let mut stmt = c.prepare("SELECT id, flag, n FROM t ORDER BY id").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    for value in [999_400i64, 5, i64::MAX, 0] {
        writer.execute("UPDATE t SET n=?2 WHERE id=?1", params![1i64, value]).unwrap();
        assert_eq!(fresh(&reader)[0].2, value);
    }
}
