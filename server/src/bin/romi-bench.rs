//! Benchmark-only fixture generator and DuckDB profiler.
//!
//! This binary is not part of the release package: it is gated behind the
//! `bench` Cargo feature and uses the same DuckDB crate, schema, and query SQL as
//! the Hub. It writes a normal romi database directly (no HTTP endpoint, no
//! arbitrary-SQL surface in the product), then can profile the exact statements
//! production runs.
//!
//! Generated datasets:
//!
//! * deterministic arithmetic pseudo-random values from `--seed`;
//! * one metric row per node per `--metric-interval`;
//! * one ping row per assigned probe per `--probe-interval`;
//! * configurable loss rate and uniform latency bounds;
//! * a traffic row per node with configurable progression;
//! * time-major (default), node-major, or unspecified physical insertion order;
//! * bulk `INSERT ... SELECT` chunks, so no large in-memory structures are built.

#[path = "../db/queries.rs"]
mod queries;
#[allow(dead_code)]
#[path = "../db/schema.rs"]
mod schema;

use std::path::Path;
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use argon2::password_hash::{PasswordHasher, SaltString};
use argon2::Argon2;
use duckdb::{params, AccessMode, Config, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};

const HASH_MOD: i64 = 1_000_003;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Order {
    Time,
    Node,
    None,
}

impl Order {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "time" => Ok(Order::Time),
            "node" => Ok(Order::Node),
            "none" => Ok(Order::None),
            other => bail!("--order must be time, node, or none (got {other})"),
        }
    }
}

struct SeedArgs {
    db: String,
    admin_password: String,
    nodes: i64,
    days: f64,
    metric_interval: i64,
    probes: i64,
    probe_interval: i64,
    loss_rate: f64,
    latency_min: i64,
    latency_max: i64,
    seed: i64,
    traffic_gb_per_day: f64,
    order: Order,
    end_ts: i64,
    dry_run: bool,
    force: bool,
    chunk_rows: i64,
    memory: String,
    threads: i64,
    temp: String,
}

struct SqlArgs {
    db: String,
    sql: String,
    settings: Vec<String>,
    write: bool,
    iterations: usize,
    memory: String,
    threads: i64,
    temp: String,
}

struct ProfileArgs {
    db: String,
    node: i64,
    windows: Vec<i64>,
    iterations: usize,
    memory: String,
    threads: i64,
    temp: String,
}

fn usage() -> &'static str {
    "romi-bench (development/benchmark only)\n\n\
     Usage:\n\
       romi-bench seed --db PATH [--nodes N] [--days D] [--metric-interval S]\n\
                       [--probes P] [--probe-interval S] [--loss-rate R]\n\
                       [--latency-min MS] [--latency-max MS] [--seed N]\n\
                       [--traffic-gb-per-day G] [--order time|node|none]\n\
                       [--end-ts UNIX] [--chunk-rows N] [--dry-run] [--force]\n\
                       [--memory SIZE] [--threads N] [--temp DIR]\n\
       romi-bench profile --db PATH [--node ID] [--windows 1,24,...] [--iterations N]\n\
                       [--memory SIZE] [--threads N] [--temp DIR]\n\
       romi-bench sql --db PATH --sql QUERY [--iterations N]\n\
                       [--memory SIZE] [--threads N] [--temp DIR]\n\n\
     Token convention for seeded nodes: plaintext `bench-token-<node_id>`, digest stored.\n"
}

fn flag_value(args: &[String], at: &mut usize) -> Result<String> {
    *at += 1;
    args.get(*at).cloned().ok_or_else(|| anyhow!("missing value for {}", args[*at - 1]))
}

fn parse_i64(value: &str, name: &str) -> Result<i64> {
    value.parse::<i64>().with_context(|| format!("{name}={value} is not an integer"))
}

fn parse_f64(value: &str, name: &str) -> Result<f64> {
    value.parse::<f64>().with_context(|| format!("{name}={value} is not a number"))
}

fn parse_seed(args: &[String]) -> Result<SeedArgs> {
    let mut parsed = SeedArgs {
        db: String::new(),
        admin_password: "romi-bench-password".into(),
        nodes: 100,
        days: 7.0,
        metric_interval: 60,
        probes: 2,
        probe_interval: 60,
        loss_rate: 0.01,
        latency_min: 5,
        latency_max: 250,
        seed: 1,
        traffic_gb_per_day: 10.0,
        order: Order::Time,
        end_ts: chrono::Utc::now().timestamp(),
        dry_run: false,
        force: false,
        chunk_rows: 2_000_000,
        memory: "4GB".into(),
        threads: 4,
        temp: String::new(),
    };
    let mut at = 0;
    while at < args.len() {
        let arg = args[at].as_str();
        match arg {
            "--db" => parsed.db = flag_value(args, &mut at)?,
            "--admin-password" => parsed.admin_password = flag_value(args, &mut at)?,
            "--nodes" => parsed.nodes = parse_i64(&flag_value(args, &mut at)?, "--nodes")?,
            "--days" => parsed.days = parse_f64(&flag_value(args, &mut at)?, "--days")?,
            "--metric-interval" => {
                parsed.metric_interval = parse_i64(&flag_value(args, &mut at)?, "--metric-interval")?
            }
            "--probes" => parsed.probes = parse_i64(&flag_value(args, &mut at)?, "--probes")?,
            "--probe-interval" => {
                parsed.probe_interval = parse_i64(&flag_value(args, &mut at)?, "--probe-interval")?
            }
            "--loss-rate" => parsed.loss_rate = parse_f64(&flag_value(args, &mut at)?, "--loss-rate")?,
            "--latency-min" => parsed.latency_min = parse_i64(&flag_value(args, &mut at)?, "--latency-min")?,
            "--latency-max" => parsed.latency_max = parse_i64(&flag_value(args, &mut at)?, "--latency-max")?,
            "--seed" => parsed.seed = parse_i64(&flag_value(args, &mut at)?, "--seed")?,
            "--traffic-gb-per-day" => {
                parsed.traffic_gb_per_day = parse_f64(&flag_value(args, &mut at)?, "--traffic-gb-per-day")?
            }
            "--order" => parsed.order = Order::parse(&flag_value(args, &mut at)?)?,
            "--end-ts" => parsed.end_ts = parse_i64(&flag_value(args, &mut at)?, "--end-ts")?,
            "--chunk-rows" => parsed.chunk_rows = parse_i64(&flag_value(args, &mut at)?, "--chunk-rows")?,
            "--dry-run" => parsed.dry_run = true,
            "--force" => parsed.force = true,
            "--memory" => parsed.memory = flag_value(args, &mut at)?,
            "--threads" => parsed.threads = parse_i64(&flag_value(args, &mut at)?, "--threads")?,
            "--temp" => parsed.temp = flag_value(args, &mut at)?,
            other => bail!("unknown seed argument: {other}"),
        }
        at += 1;
    }
    if parsed.db.is_empty() {
        bail!("seed requires --db PATH");
    }
    if parsed.nodes < 1 {
        bail!("--nodes must be positive");
    }
    if parsed.days <= 0.0 {
        bail!("--days must be positive");
    }
    if parsed.metric_interval < 1 || parsed.probe_interval < 1 {
        bail!("intervals must be at least one second");
    }
    if parsed.probes < 1 {
        bail!("--probes must be positive");
    }
    if !(0.0..=1.0).contains(&parsed.loss_rate) {
        bail!("--loss-rate must be between 0 and 1");
    }
    if parsed.latency_min < 0 || parsed.latency_max < parsed.latency_min {
        bail!("latency bounds must satisfy 0 <= min <= max");
    }
    if parsed.seed < 0 {
        bail!("--seed must be non-negative");
    }
    if parsed.chunk_rows < 1 {
        bail!("--chunk-rows must be positive");
    }
    if parsed.threads < 1 {
        bail!("--threads must be positive");
    }
    if parsed.temp.is_empty() {
        parsed.temp = format!("{}.bench-seed-tmp", parsed.db);
    }
    Ok(parsed)
}

fn parse_profile(args: &[String]) -> Result<ProfileArgs> {
    let mut parsed = ProfileArgs {
        db: String::new(),
        node: 1,
        windows: vec![1, 6, 24, 168, 720, 2_160],
        iterations: 5,
        memory: "512MB".into(),
        threads: 4,
        temp: String::new(),
    };
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--db" => parsed.db = flag_value(args, &mut at)?,
            "--node" => parsed.node = parse_i64(&flag_value(args, &mut at)?, "--node")?,
            "--windows" => {
                let text = flag_value(args, &mut at)?;
                parsed.windows =
                    text.split(',').map(|v| parse_i64(v.trim(), "--windows")).collect::<Result<Vec<_>>>()?;
            }
            "--iterations" => {
                let n = parse_i64(&flag_value(args, &mut at)?, "--iterations")?;
                parsed.iterations = n.max(1) as usize;
            }
            "--memory" => parsed.memory = flag_value(args, &mut at)?,
            "--threads" => parsed.threads = parse_i64(&flag_value(args, &mut at)?, "--threads")?,
            "--temp" => parsed.temp = flag_value(args, &mut at)?,
            other => bail!("unknown profile argument: {other}"),
        }
        at += 1;
    }
    if parsed.db.is_empty() {
        bail!("profile requires --db PATH");
    }
    if parsed.node < 1 {
        bail!("--node must be positive");
    }
    if parsed.temp.is_empty() {
        parsed.temp = format!("{}.bench-profile-tmp", parsed.db);
    }
    Ok(parsed)
}

fn parse_sql(args: &[String]) -> Result<SqlArgs> {
    let mut parsed = SqlArgs {
        db: String::new(),
        sql: String::new(),
        settings: Vec::new(),
        write: false,
        iterations: 3,
        memory: "512MB".into(),
        threads: 4,
        temp: String::new(),
    };
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--db" => parsed.db = flag_value(args, &mut at)?,
            "--sql" => parsed.sql = flag_value(args, &mut at)?,
            "--set" => parsed.settings.push(flag_value(args, &mut at)?),
            "--write" => parsed.write = true,
            "--iterations" => {
                let n = parse_i64(&flag_value(args, &mut at)?, "--iterations")?;
                parsed.iterations = n.max(1) as usize;
            }
            "--memory" => parsed.memory = flag_value(args, &mut at)?,
            "--threads" => parsed.threads = parse_i64(&flag_value(args, &mut at)?, "--threads")?,
            "--temp" => parsed.temp = flag_value(args, &mut at)?,
            other => bail!("unknown sql argument: {other}"),
        }
        at += 1;
    }
    if parsed.db.is_empty() || parsed.sql.is_empty() {
        bail!("sql requires --db PATH and --sql QUERY");
    }
    if parsed.temp.is_empty() {
        parsed.temp = format!("{}.bench-sql-tmp", parsed.db);
    }
    Ok(parsed)
}

fn run_sql(args: &SqlArgs) -> Result<serde_json::Value> {
    let conn = if args.write {
        open_connection(&args.db, &args.memory, args.threads, &args.temp)?
    } else {
        open_read_only(&args.db, &args.memory, args.threads, &args.temp)?
    };
    for setting in &args.settings {
        conn.execute_batch(&format!("SET {setting}"))
            .with_context(|| format!("applying benchmark setting {setting}"))?;
    }
    let upper = args.sql.trim_start().to_ascii_uppercase();
    let is_query = ["SELECT", "WITH", "PRAGMA", "EXPLAIN", "DESCRIBE", "SUMMARIZE", "SHOW"]
        .iter()
        .any(|prefix| upper.starts_with(prefix));
    if !is_query {
        conn.execute_batch(&args.sql).context("executing benchmark SQL")?;
        return Ok(json!({"db": args.db, "sql": args.sql, "executed": true}));
    }
    let mut direct = None;
    let mut sample = Vec::new();
    if !upper.starts_with("EXPLAIN") {
        let (rows, mut times) = time_query(&conn, &args.sql, args.iterations)?;
        direct = Some(json!({
            "rows": rows,
            "p50_ms": percentile(&mut times, 0.50),
            "p95_ms": percentile(&mut times, 0.95),
        }));
        let mut stmt = conn.prepare(&args.sql)?;
        let columns = 4;
        let mut result = stmt.query([])?;
        while sample.len() < 20 {
            let Some(row) = result.next()? else { break };
            let mut values = Vec::new();
            for column in 0..columns {
                if let Ok(value) = row.get::<_, String>(column) {
                    values.push(value);
                }
            }
            sample.push(values);
        }
    }
    let plan = if upper.starts_with("EXPLAIN") {
        let mut stmt = conn.prepare(&args.sql)?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            for column in 0..4 {
                if let Ok(value) = row.get::<_, String>(column) {
                    if !value.is_empty() {
                        out.push(value);
                    }
                }
            }
        }
        out
    } else {
        explain(&conn, &args.sql)?
    };
    Ok(json!({
        "db": args.db,
        "sql": args.sql,
        "direct": direct,
        "sample": sample,
        "plan": plan,
    }))
}

fn open_seed_connection(args: &SeedArgs) -> Result<Connection> {
    open_connection(&args.db, &args.memory, args.threads, &args.temp)
}

fn open_connection(path: &str, memory: &str, threads: i64, temp: &str) -> Result<Connection> {
    std::fs::create_dir_all(temp).with_context(|| format!("creating temp directory {temp}"))?;
    let config = Config::default()
        .with("memory_limit", memory)?
        .with("threads", threads.to_string())?
        .with("temp_directory", temp)?
        .with("max_temp_directory_size", "32GB")?
        .with("autoinstall_known_extensions", "false")?
        .with("autoload_known_extensions", "false")?
        .with("allow_community_extensions", "false")?
        .with("allow_unsigned_extensions", "false")?;
    Connection::open_with_flags(path, config).with_context(|| format!("opening {path}"))
}

fn open_read_only(path: &str, memory: &str, threads: i64, temp: &str) -> Result<Connection> {
    std::fs::create_dir_all(temp).ok();
    let config = Config::default()
        .with("memory_limit", memory)?
        .with("threads", threads.to_string())?
        .with("temp_directory", temp)?
        .with("max_temp_directory_size", "32GB")?
        .with("autoinstall_known_extensions", "false")?
        .with("autoload_known_extensions", "false")?
        .with("allow_community_extensions", "false")?
        .with("allow_unsigned_extensions", "false")?
        .access_mode(AccessMode::ReadOnly)?;
    Connection::open_with_flags(path, config).with_context(|| format!("opening {path} read-only"))
}

fn remove_fixture_files(db: &str, temp: &str) {
    for suffix in ["", ".wal", ".lock"] {
        let _ = std::fs::remove_file(format!("{db}{suffix}"));
    }
    let _ = std::fs::remove_dir_all(temp);
}

fn estimated_rows(args: &SeedArgs) -> (i64, i64) {
    let seconds = (args.days * 86_400.0) as i64;
    let metric_samples = (seconds / args.metric_interval).max(1);
    let ping_samples = (seconds / args.probe_interval).max(1);
    (args.nodes * metric_samples, args.nodes * args.probes * ping_samples)
}

fn hash_expr(parts: &[String], seed: i64) -> String {
    let mut expr = String::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            expr.push_str(" + ");
        }
        expr.push_str(&format!("({part} + {seed}) * {}", 7_919 + index as i64 * 1_000_003));
    }
    format!("(({expr}) % {HASH_MOD})")
}

fn run_seed(args: &SeedArgs) -> Result<serde_json::Value> {
    let (metric_rows, ping_rows) = estimated_rows(args);
    if args.dry_run {
        return Ok(json!({
            "dry_run": true,
            "config": seed_config_json(args),
            "estimated_metric_rows": metric_rows,
            "estimated_ping_record_rows": ping_rows,
        }));
    }
    if Path::new(&args.db).exists() && !args.force {
        bail!("{} already exists; pass --force to replace it", args.db);
    }
    remove_fixture_files(&args.db, &args.temp);

    let started = Instant::now();
    let mut conn = open_seed_connection(args)?;
    schema::initialize(&mut conn, true, env!("CARGO_PKG_VERSION"))?;

    insert_nodes_and_metadata(&conn, args)?;
    insert_history_chunked(&conn, args)?;
    schema::resync_ids(&conn)?;
    conn.execute_batch("CHECKPOINT")?;

    let actual_metric: i64 = conn.query_row("SELECT COUNT(*) FROM metric", [], |r| r.get(0))?;
    let actual_ping: i64 = conn.query_row("SELECT COUNT(*) FROM ping_record", [], |r| r.get(0))?;
    let actual_nodes: i64 = conn.query_row("SELECT COUNT(*) FROM node", [], |r| r.get(0))?;
    let actual_tasks: i64 = conn.query_row("SELECT COUNT(*) FROM ping_task", [], |r| r.get(0))?;
    drop(conn);
    let file_bytes = std::fs::metadata(&args.db).map(|m| m.len()).unwrap_or(0);
    let generation_seconds = started.elapsed().as_secs_f64();
    let _ = std::fs::remove_dir_all(&args.temp);

    Ok(json!({
        "db": args.db,
        "admin_password": args.admin_password,
        "config": seed_config_json(args),
        "estimated_metric_rows": metric_rows,
        "estimated_ping_record_rows": ping_rows,
        "actual_metric_rows": actual_metric,
        "actual_ping_record_rows": actual_ping,
        "actual_node_rows": actual_nodes,
        "actual_ping_task_rows": actual_tasks,
        "file_bytes": file_bytes,
        "generation_seconds": generation_seconds,
        "engine": schema::ENGINE_VERSION,
        "schema": schema::SCHEMA_VERSION,
        "token_pattern": "bench-token-{node_id}",
    }))
}

fn seed_config_json(args: &SeedArgs) -> serde_json::Value {
    json!({
        "nodes": args.nodes,
        "days": args.days,
        "metric_interval_s": args.metric_interval,
        "probes_per_node": args.probes,
        "probe_interval_s": args.probe_interval,
        "loss_rate": args.loss_rate,
        "latency_min_ms": args.latency_min,
        "latency_max_ms": args.latency_max,
        "seed": args.seed,
        "traffic_gb_per_day": args.traffic_gb_per_day,
        "order": match args.order { Order::Time => "time", Order::Node => "node", Order::None => "none" },
        "end_ts": args.end_ts,
        "chunk_rows": args.chunk_rows,
        "memory": args.memory,
        "threads": args.threads,
    })
}

fn insert_nodes_and_metadata(conn: &Connection, args: &SeedArgs) -> Result<()> {
    let total_bytes = (args.traffic_gb_per_day * 1_000_000_000.0 * args.days) as i64;
    {
        let tx = conn.unchecked_transaction()?;
        {
            let mut node_stmt = tx.prepare(
                "INSERT INTO node (id, name, token_hash, sort, created_at, last_seen)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            let mut traffic_stmt = tx.prepare(
                "INSERT INTO traffic (node_id, boot_id, total_rx, total_tx, month_rx, month_tx, day_rx, day_tx)
                 VALUES (?1, '', ?2, ?2, ?2, ?2, 0, 0)",
            )?;
            for node in 1..=args.nodes {
                let plaintext = format!("bench-token-{node}");
                let digest = hex::encode(Sha256::digest(plaintext.as_bytes()));
                node_stmt.execute(params![
                    node,
                    format!("bench-{node}"),
                    digest,
                    node,
                    args.end_ts - (args.days * 86_400.0) as i64,
                    args.end_ts
                ])?;
                traffic_stmt.execute(params![node, total_bytes])?;
            }
        }
        {
            let mut task_stmt =
                tx.prepare("INSERT INTO ping_task (id, name, target, interval) VALUES (?1, ?2, ?3, ?4)")?;
            for task in 1..=args.probes {
                task_stmt.execute(params![
                    task,
                    format!("bench-probe-{task}"),
                    "1.1.1.1:443",
                    args.probe_interval
                ])?;
            }
        }
        if args.probes > 0 {
            tx.execute_batch(&format!(
                "INSERT INTO ping_node (task_id, node_id)
                 SELECT a.task, b.node FROM range(1, {}) a(task), range(1, {}) b(node)",
                args.probes + 1,
                args.nodes + 1
            ))?;
        }
        tx.execute_batch(
            "INSERT INTO setting (key, value) VALUES
               ('retention_days', '3650'),
               ('public_page', 'off'),
               ('theme', 'default'),
               ('country_lookup', 'off')
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )?;
        // A deterministic, benchmark-only administrator credential. Hashing
        // still goes through Argon2 with a real salt; this merely removes the
        // "read one-time password from the log" step from repeated benchmark
        // restarts. It is never written into a release database by the product.
        let salt = SaltString::encode_b64(b"romi-bench-salt!").map_err(|e| anyhow!("benchmark salt: {e}"))?;
        let hash = Argon2::default()
            .hash_password(args.admin_password.as_bytes(), &salt)
            .map_err(|e| anyhow!("benchmark password hash: {e}"))?
            .to_string();
        tx.execute(
            "INSERT INTO setting (key, value) VALUES ('admin_password_hash', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![hash],
        )?;
        tx.commit()?;
    }
    Ok(())
}

fn insert_history_chunked(conn: &Connection, args: &SeedArgs) -> Result<()> {
    let seconds = (args.days * 86_400.0) as i64;
    let metric_samples = (seconds / args.metric_interval).max(1);
    let ping_samples = (seconds / args.probe_interval).max(1);
    match args.order {
        Order::Time => {
            let metric_chunk = (args.chunk_rows / args.nodes).max(1);
            let mut s0 = 0i64;
            while s0 < metric_samples {
                let s1 = (s0 + metric_chunk).min(metric_samples);
                insert_metric_slice(conn, args, s0, s1, 1, args.nodes + 1, true)?;
                s0 = s1;
            }
            let ping_chunk = (args.chunk_rows / (args.nodes * args.probes).max(1)).max(1);
            let mut s0 = 0i64;
            while s0 < ping_samples {
                let s1 = (s0 + ping_chunk).min(ping_samples);
                insert_ping_slice_time(conn, args, s0, s1)?;
                s0 = s1;
            }
        }
        Order::Node => {
            let metric_chunk = (args.chunk_rows / metric_samples).max(1);
            let mut n0 = 1i64;
            while n0 <= args.nodes {
                let n1 = (n0 + metric_chunk).min(args.nodes + 1);
                insert_metric_slice(conn, args, 0, metric_samples, n0, n1, false)?;
                n0 = n1;
            }
            let ping_chunk = (args.chunk_rows / (ping_samples * args.probes).max(1)).max(1);
            let mut n0 = 1i64;
            while n0 <= args.nodes {
                let n1 = (n0 + ping_chunk).min(args.nodes + 1);
                insert_ping_slice_node(conn, args, n0, n1)?;
                n0 = n1;
            }
        }
        Order::None => {
            insert_metric_slice(conn, args, 0, metric_samples, 1, args.nodes + 1, false)?;
            insert_ping_slice_none(conn, args, 0, ping_samples)?;
        }
    }
    Ok(())
}

fn insert_metric_slice(
    conn: &Connection,
    args: &SeedArgs,
    s0: i64,
    s1: i64,
    n0: i64,
    n1: i64,
    time_order: bool,
) -> Result<()> {
    let hash = hash_expr(&["n".into(), "s".into()], args.seed);
    let order = if time_order { "ORDER BY s, n" } else { "ORDER BY n, s" };
    let sql = format!(
        "INSERT INTO metric (node_id, ts, cpu, mem_used, swap_used, disk_used, net_rx, net_tx, tcp, udp, procs)
         SELECT n, {end_ts} - s * {interval},
                CAST(((h * 31 + 7) % 10000) AS DOUBLE) / 100.0,
                536870912 + ((h * 17) % 1000000),
                (h * 11) % 1000000,
                10737418240 - ((h * 13) % 5000000000),
                1024 + ((h * 7) % 10000000),
                512 + ((h * 19) % 5000000),
                10 + ((h * 23) % 1000),
                5 + ((h * 29) % 500),
                50 + ((h * 37) % 500)
         FROM (
             SELECT n, s, {hash} AS h
             FROM range({n0}, {n1}) a(n), range({s0}, {s1}) b(s)
         ) q
         {order}",
        end_ts = args.end_ts,
        interval = args.metric_interval,
    );
    conn.execute_batch(&sql).context("bulk-inserting metric rows")?;
    Ok(())
}

fn insert_ping_slice_time(conn: &Connection, args: &SeedArgs, s0: i64, s1: i64) -> Result<()> {
    let hash = hash_expr(&["p.node_id".into(), "p.task_id".into(), "s".into()], args.seed);
    let loss_per_10k = (args.loss_rate * 10_000.0).round() as i64;
    let width = args.latency_max - args.latency_min + 1;
    let sql = format!(
        "INSERT INTO ping_record (node_id, task_id, ts, latency)
         SELECT node_id, task_id, ts,
                CASE WHEN (h % 10000) < {loss} THEN -1
                     ELSE {lat_min} + (h % {width}) END
         FROM (
             SELECT p.node_id AS node_id, p.task_id AS task_id,
                    {end_ts} - s * {interval} AS ts, {hash} AS h
             FROM ping_node p, range({s0}, {s1}) b(s)
         ) q
         ORDER BY ts, node_id, task_id",
        loss = loss_per_10k,
        lat_min = args.latency_min,
        width = width,
        end_ts = args.end_ts,
        interval = args.probe_interval,
    );
    conn.execute_batch(&sql).context("bulk-inserting ping rows (time order)")?;
    Ok(())
}

fn insert_ping_slice_node(conn: &Connection, args: &SeedArgs, n0: i64, n1: i64) -> Result<()> {
    let hash = hash_expr(&["p.node_id".into(), "p.task_id".into(), "s".into()], args.seed);
    let loss_per_10k = (args.loss_rate * 10_000.0).round() as i64;
    let width = args.latency_max - args.latency_min + 1;
    let sql = format!(
        "INSERT INTO ping_record (node_id, task_id, ts, latency)
         SELECT node_id, task_id, ts,
                CASE WHEN (h % 10000) < {loss} THEN -1
                     ELSE {lat_min} + (h % {width}) END
         FROM (
             SELECT p.node_id AS node_id, p.task_id AS task_id,
                    {end_ts} - s * {interval} AS ts, {hash} AS h
             FROM ping_node p, range(0, {samples}) b(s)
             WHERE p.node_id >= {n0} AND p.node_id < {n1}
         ) q
         ORDER BY node_id, task_id, ts",
        loss = loss_per_10k,
        lat_min = args.latency_min,
        width = width,
        end_ts = args.end_ts,
        interval = args.probe_interval,
        samples = (args.days * 86_400.0) as i64 / args.probe_interval,
    );
    conn.execute_batch(&sql).context("bulk-inserting ping rows (node order)")?;
    Ok(())
}

fn insert_ping_slice_none(conn: &Connection, args: &SeedArgs, _s0: i64, _s1: i64) -> Result<()> {
    let hash = hash_expr(&["p.node_id".into(), "p.task_id".into(), "s".into()], args.seed);
    let loss_per_10k = (args.loss_rate * 10_000.0).round() as i64;
    let width = args.latency_max - args.latency_min + 1;
    let sql = format!(
        "INSERT INTO ping_record (node_id, task_id, ts, latency)
         SELECT p.node_id, p.task_id, {end_ts} - s * {interval},
                CASE WHEN ({hash}) % 10000 < {loss} THEN -1
                     ELSE {lat_min} + (({hash}) % {width}) END
         FROM ping_node p, range(0, {samples}) b(s)",
        end_ts = args.end_ts,
        interval = args.probe_interval,
        samples = (args.days * 86_400.0) as i64 / args.probe_interval,
        loss = loss_per_10k,
        lat_min = args.latency_min,
        width = width,
    );
    conn.execute_batch(&sql).context("bulk-inserting ping rows (unspecified order)")?;
    Ok(())
}

fn sample_step(hours: i64, points: Option<i64>) -> i64 {
    const SAMPLES: i64 = 1_440;
    let budget = points.unwrap_or(SAMPLES).clamp(60, SAMPLES);
    60 * ((hours * 60 + budget - 1) / budget).max(1)
}

fn bind_ints(sql: &str, node: i64, since: i64, step: i64) -> String {
    sql.replace("?1", &node.to_string()).replace("?2", &since.to_string()).replace("?3", &step.to_string())
}

fn percentile(values: &mut [f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let at = ((values.len() - 1) as f64 * q).round() as usize;
    values[at]
}

fn time_query(conn: &Connection, sql: &str, iterations: usize) -> Result<(usize, Vec<f64>)> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows_seen = 0usize;
    let mut times = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let mut rows = stmt.query([])?;
        let mut count = 0usize;
        while rows.next()?.is_some() {
            count += 1;
        }
        times.push(started.elapsed().as_secs_f64() * 1_000.0);
        rows_seen = rows_seen.max(count);
    }
    Ok((rows_seen, times))
}

fn explain(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("EXPLAIN ANALYZE {sql}"))?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        // EXPLAIN/EXPLAIN ANALYZE exposes a small key/value result. Probe a few
        // columns so both the One-Column and key/value layouts work.
        for column in 0..4 {
            if let Ok(value) = row.get::<_, String>(column) {
                if !value.is_empty() {
                    out.push(value);
                }
            }
        }
    }
    Ok(out)
}

fn run_profile(args: &ProfileArgs) -> Result<serde_json::Value> {
    let conn = open_read_only(&args.db, &args.memory, args.threads, &args.temp)?;
    let now = chrono::Utc::now().timestamp();
    let mut windows = Vec::new();
    for &hours in &args.windows {
        let since = now - hours * 3_600;
        let step = sample_step(hours, None);
        let metric_sql = bind_ints(queries::METRICS_SQL, args.node, since, step);
        let ping_sql = bind_ints(queries::PING_ROWS_SQL, args.node, since, step);
        let (metric_rows, mut metric_times) = time_query(&conn, &metric_sql, args.iterations)?;
        let (ping_rows, mut ping_times) = time_query(&conn, &ping_sql, args.iterations)?;
        windows.push(json!({
            "hours": hours,
            "step_s": step,
            "metrics": {
                "direct_rows": metric_rows,
                "direct_p50_ms": percentile(&mut metric_times, 0.50),
                "direct_p95_ms": percentile(&mut metric_times, 0.95),
                "plan": explain(&conn, &metric_sql)?,
            },
            "ping": {
                "direct_raw_rows": ping_rows,
                "direct_p50_ms": percentile(&mut ping_times, 0.50),
                "direct_p95_ms": percentile(&mut ping_times, 0.95),
                "plan": explain(&conn, &ping_sql)?,
            },
        }));
    }
    Ok(json!({
        "db": args.db,
        "node": args.node,
        "engine": schema::engine_version(&conn)?,
        "plan": "EXPLAIN ANALYZE and direct query timing; ping direct rows are pre-fold raw rows",
        "windows": windows,
    }))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print!("{}", usage());
        return Ok(());
    };
    let rest = &args[1..];
    let value = match command {
        "seed" => run_seed(&parse_seed(rest)?)?,
        "profile" => run_profile(&parse_profile(rest)?)?,
        "sql" => run_sql(&parse_sql(rest)?)?,
        "-h" | "--help" | "help" => {
            print!("{}", usage());
            return Ok(());
        }
        other => bail!("unknown command {other}\n\n{}", usage()),
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
