//! The agent side of the hub: one WebSocket per node carrying JSON-RPC 2.0
//! notifications. A single long-lived connection on which either end may speak
//! first, with self-describing frames readable via curl or a browser console.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::auth::client_ip;
use crate::{App, Shared};

/// How often a quiet agent is probed, and how long the hub waits for any frame
/// before abandoning the connection.
const HEARTBEAT: Duration = Duration::from_secs(30);
const SILENCE: Duration = Duration::from_secs(120);

/// Distinguishes one agent session on a node from the next. A connection can
/// remain nominally open for up to SILENCE, long enough for the agent to have
/// given up and reconnected; without this tag a late teardown would remove the
/// live session that replaced it.
static SESSION: AtomicU64 = AtomicU64::new(0);

/// One connected agent. Held in memory only, and rebuilt within one report
/// interval of a hub restart.
///
/// A single map, because "the node is online" and "the node has current figures"
/// are the same fact. Split across two, they required manual synchronisation at
/// every call site and diverged: the connection was recorded at the handshake
/// and the metrics at the first report, so a node that had connected but not yet
/// reported appeared offline for a whole `--interval`.
#[derive(Debug)]
pub struct Agent {
    /// Distinguishes one session on a node from the next; see [`release`].
    pub session: u64,
    /// Outbound channel, used to push probe assignments. Immutable, so the
    /// node-list snapshot can clone it without taking the report lock.
    pub tx: mpsc::Sender<String>,
    /// Set when this session is retired by rotation, deletion, replacement or
    /// restore. A report that already left the map must observe this after it
    /// takes the state lock; otherwise it would write after its session ended.
    retired: AtomicBool,
    /// Mutable report state. One mutex per Agent/session: different nodes never
    /// wait for each other, while reports for the same session are serialized
    /// across all their database writes.
    state: Mutex<AgentState>,
    /// Last published metrics have a short, independent lock. A slow database
    /// commit must not make a node-list request wait on every reporting Agent.
    published: Mutex<(serde_json::Value, i64)>,
}

/// The report state a connected Agent/session owns independently.
#[derive(Debug)]
pub(crate) struct AgentState {
    /// The latest report, or `Null` between connecting and the first one.
    pub metrics: serde_json::Value,
    pub last_seen: i64,
    /// Wall-clock minute this session has already accounted for. A history row
    /// is written when a report arrives past it.
    pub last_minute: i64,
    /// `(monotonic instant, total_rx, total_tx)` as of the last history row, so
    /// the next one carries the average rate over the interval. Without it a row
    /// would hold a single instantaneous reading -- a 1-in-60 sample of the
    /// minute it describes. See [`report`].
    ///
    /// An `Instant` rather than the wall clock the stamp comes from, because this
    /// is a duration. NTP stepping the clock backwards -- a fresh boot correcting
    /// itself, a restored snapshot -- makes a wall-clock difference negative, and
    /// the `.max(1)` guarding the division would then divide a whole minute of
    /// bytes by one second. The agent computes the same quantity against
    /// `std::time::Instant` for the same reason.
    pub mark: Option<(Instant, i64, i64)>,
    /// Running mean of the minute in progress, for the same reason.
    pub minute: Minute,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            metrics: serde_json::Value::Null,
            last_seen: 0,
            // The minute in progress rather than zero. Its row is already on
            // disk, written by the session this one replaces from the mean of a
            // whole minute; a reconnect's first report would otherwise overwrite
            // it with the single sample that opened the new session.
            last_minute: Utc::now().timestamp() / 60,
            mark: None,
            minute: Minute::default(),
        }
    }
}

impl Agent {
    pub fn new(session: u64, tx: mpsc::Sender<String>) -> Self {
        Self {
            session,
            tx,
            retired: AtomicBool::new(false),
            state: Mutex::new(AgentState::default()),
            published: Mutex::new((serde_json::Value::Null, 0)),
        }
    }

    /// The report state lock, with poison treated as recoverable: a malformed
    /// report must not make the node permanently unreadable.
    pub(crate) fn lock_state(&self) -> MutexGuard<'_, AgentState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A point-in-time clone for node views, without holding the lock across the
    /// rest of the panel's work.
    pub(crate) fn snapshot(&self) -> (serde_json::Value, i64) {
        self.published.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn publish(&self, state: &AgentState) {
        *self.published.lock().unwrap_or_else(|e| e.into_inner()) = (state.metrics.clone(), state.last_seen);
    }

    /// Marks the session retired without waiting. A report that already cloned
    /// the handle will observe this after it takes the state lock and abort.
    pub(crate) fn mark_retired(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    /// Retires the session and waits for any in-flight report to finish. The
    /// returned guard keeps the state locked, so the caller can perform the
    /// database mutation knowing no old report can interleave with it.
    pub(crate) fn retire_and_lock(&self) -> MutexGuard<'_, AgentState> {
        self.mark_retired();
        self.lock_state()
    }

    pub(crate) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }
}

/// Fields a history row carries as the mean of its minute rather than the single
/// reading that landed on the boundary. A 30-second spike between two samples is
/// real load that a point sample would report as idle.
///
/// `load` is absent because no history row carries it: it is a live figure read
/// from the report. `net_rx` and `net_tx` are absent because [`report`] fills
/// them from the accumulator, which is exact.
const MEAN_FLOAT: [&str; 1] = ["cpu"];
const MEAN_INT: [&str; 10] = [
    "mem_used",
    "swap_used",
    "disk_used",
    "tcp",
    "udp",
    "procs",
    "zram_used",
    "swap_disk_used",
    "swapfile_used",
    "swap_partition_used",
];

/// Running sums for the minute in progress, one slot per averaged field.
#[derive(Debug, Default)]
pub(crate) struct Minute {
    sums: [f64; MEAN_FLOAT.len() + MEAN_INT.len()],
    reports: f64,
    counts: [f64; MEAN_FLOAT.len() + MEAN_INT.len()],
}

impl Minute {
    fn add(&mut self, metrics: &serde_json::Value) {
        for (slot, key) in MEAN_FLOAT.iter().chain(&MEAN_INT).enumerate() {
            if let Some(value) = metrics.get(key).and_then(|v| v.as_f64()) {
                self.sums[slot] += value;
                self.counts[slot] += 1.0;
            }
        }
        self.reports += 1.0;
    }

    /// Replaces each averaged field with the mean of the reports folded in so
    /// far, keeping integers integral: `insert_metric` reads them with `as_i64`,
    /// which returns nothing for a value carrying a fraction.
    fn write_into(&self, row: &mut serde_json::Value) {
        let Some(obj) = row.as_object_mut() else { return };
        if self.reports == 0.0 {
            return;
        }
        for (slot, key) in MEAN_FLOAT.iter().chain(&MEAN_INT).enumerate() {
            if !obj.contains_key(*key) {
                continue;
            }
            if self.counts[slot] == 0.0 {
                continue;
            }
            let mean = self.sums[slot] / self.counts[slot];
            let mean = if slot < MEAN_FLOAT.len() { json!(mean) } else { json!(mean.round() as i64) };
            obj.insert((*key).to_owned(), mean);
        }
    }
}

#[derive(Deserialize)]
struct Rpc {
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

pub async fn handler(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, "missing token").into_response();
    };
    let Ok(Some(node_id)) = app.db.node_by_token(token) else {
        // The same response whether the token is malformed or merely unknown.
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    };
    let token = token.to_owned();
    let ip = client_ip(&headers, peer.ip()).to_string();

    upgrade
        .read_buffer_size(crate::api::SOCKET_BUFFER)
        .max_message_size(crate::api::MAX_FRAME)
        .max_frame_size(crate::api::MAX_FRAME)
        .on_upgrade(move |socket| async move {
            if let Err(e) = serve(app, node_id, token, ip, socket).await {
                debug!("node {node_id} disconnected: {e:#}");
            }
        })
}

/// Extracts the node token from `Authorization: Bearer <token>`.
pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").filter(|t| !t.is_empty())
}

fn activate(app: &App, node_id: i64, token: &str, session: u64, tx: mpsc::Sender<String>) -> Result<()> {
    // `agents_admin` serializes map-mutating operations that also change
    // credentials or database contents: activation, rotation, deletion and
    // restore. Reports do not take it, only the per-session state lock.
    let _admin = app.agents_admin.lock().unwrap_or_else(|e| e.into_inner());
    anyhow::ensure!(app.db.node_by_token(token)? == Some(node_id), "token revoked during upgrade");
    // Retire the previous session and wait out its in-flight report before the
    // replacement becomes visible, so reports for this node stay ordered across
    // a reconnect.
    let old = {
        let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
        agents.remove(&node_id)
    };
    {
        let _old_state = old.as_ref().map(|agent| agent.retire_and_lock());
        // Release the old state lock before taking the map lock: a node-list
        // snapshot can hold the map read lock while waiting on this session's
        // state, and taking map.write() here would invert that order.
    }
    let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
    agents.insert(node_id, Arc::new(Agent::new(session, tx)));
    Ok(())
}

async fn serve(app: Shared, node_id: i64, token: String, ip: String, mut socket: WebSocket) -> Result<()> {
    let (tx, mut rx) = mpsc::channel::<String>(16);
    let session = SESSION.fetch_add(1, Ordering::Relaxed);
    // Online from the handshake rather than the first report: a panel reporting
    // otherwise for a whole interval would describe the hub's bookkeeping rather
    // than the machine.
    activate(&app, node_id, &token, session, tx)?;
    drop(token);
    info!("node {node_id} connected from {ip}");

    // Send the probe list before the first report arrives.
    let _ = socket.send(Message::Text(ping_tasks_message(&app, node_id).into())).await;

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await; // The first tick completes immediately.
    let mut last_frame = Instant::now();

    let outcome = loop {
        tokio::select! {
            outbound = rx.recv() => match outbound {
                Some(text) => socket.send(Message::Text(text.into())).await?,
                None => break Ok(()),
            },
            // A machine that leaves the network without closing its socket would
            // leave this receive pending until the kernel abandons the TCP session
            // hours later, with the node reading online and its metrics frozen. A
            // ping every HEARTBEAT proves the path in both directions; any frame
            // in return, the pong included, counts as a sign of life.
            _ = heartbeat.tick() => {
                let quiet = last_frame.elapsed();
                if quiet > SILENCE {
                    break Err(anyhow::anyhow!("silent for {}s", quiet.as_secs()));
                }
                socket.send(Message::Ping(Vec::new().into())).await?;
            }
            inbound = socket.recv() => {
                last_frame = Instant::now();
                match inbound {
                // A report is a database write, and it is dispatched to the
                // blocking pool rather than run here or under `block_in_place`.
                // `block_in_place` hands the worker's core to another task but
                // keeps the *thread*: a few hundred reports a second across a few
                // dozen agents left no core free to answer the panel or the public
                // page at all. A blocking-pool thread does not belong to the
                // scheduler, so waiting on the writer costs the runtime nothing.
                Some(Ok(Message::Text(text))) => {
                    let (task_app, task_ip) = (app.clone(), ip.clone());
                    let outcome = tokio::task::spawn_blocking(move || {
                        dispatch(&task_app, node_id, session, &task_ip, &text)
                    })
                    .await
                    .unwrap_or_else(|e| Err(anyhow::anyhow!("report worker failed: {e}")));
                    match outcome {
                        Ok(true) => locate(app.clone(), node_id, ip.clone()),
                        Ok(false) => {}
                        Err(e) => warn!("node {node_id} sent an unusable message: {e:#}"),
                    }
                }
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Ok(_)) => {}
                Some(Err(e)) => break Err(e.into()),
                }
            }
        }
    };

    if release(&app, node_id, session) {
        info!("node {node_id} went offline");
    }
    outcome
}

/// Drops a node's connection state, but only while `session` is still the one
/// holding it. Returns whether anything was released.
///
/// A teardown can arrive up to SILENCE after the agent gave up, by which time a
/// reconnect may have installed a newer session under the same node id; clearing
/// that one would mark a node offline while it is reporting normally.
fn release(app: &App, node_id: i64, session: u64) -> bool {
    let removed = {
        let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
        match agents.get(&node_id) {
            Some(agent) if agent.session == session => agents.remove(&node_id),
            _ => None,
        }
    };
    match removed {
        Some(agent) => {
            agent.mark_retired();
            true
        }
        None => false,
    }
}

/// Retires `node_id` (if connected), waits out its in-flight report, and runs
/// `f` while the session's state lock is held. The caller's database mutation
/// therefore cannot interleave with an old report, and a report that raced the
/// map removal observes `retired` and aborts.
pub(crate) fn retire_node_then<T>(app: &App, node_id: i64, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let _admin = app.agents_admin.lock().unwrap_or_else(|e| e.into_inner());
    let agent = {
        let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
        agents.remove(&node_id)
    };
    let _state = agent.as_ref().map(|agent| agent.retire_and_lock());
    f()
}

/// Retires every connected session and runs `f` (a database replacement) while
/// every session state lock is held. This guarantees:
///
/// * reports already in flight finish before the replacement starts;
/// * a report that had cloned its handle but not yet locked state observes
///   `retired` after the replacement and aborts;
/// * an old report cannot submit a fresh database write after the replacement.
pub(crate) fn retire_all_then<T>(app: &App, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let _admin = app.agents_admin.lock().unwrap_or_else(|e| e.into_inner());
    let agents: Vec<Arc<Agent>> = {
        let mut map = app.agents.write().unwrap_or_else(|e| e.into_inner());
        map.drain().map(|(_, agent)| agent).collect()
    };
    let mut guards = Vec::with_capacity(agents.len());
    for agent in &agents {
        guards.push(agent.retire_and_lock());
    }
    let outcome = f();
    drop(guards);
    outcome
}

/// Handles one inbound frame and reports whether the node is now owed a country
/// lookup. The lookup itself is an outbound request and happens off this path;
/// see `locate`.
fn dispatch(app: &App, node_id: i64, session: u64, ip: &str, text: &str) -> Result<bool> {
    let rpc: Rpc = serde_json::from_str(text)?;
    // The global map lock protects only membership/lookup. Clone the stable
    // per-session handle and release it before any database work, so reports
    // from different nodes never serialize on a global lock.
    let agent = {
        let agents = app.agents.read().unwrap_or_else(|e| e.into_inner());
        agents
            .get(&node_id)
            .filter(|agent| agent.session == session)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("retired agent session"))?
    };
    // One lock per session: reports for the same node stay ordered, different
    // nodes proceed concurrently. The retirement check comes after the lock, so
    // a delete/rotation/restore that removed the map entry cannot be overwritten
    // by a report that had already cloned the handle.
    let mut entry = agent.lock_state();
    anyhow::ensure!(!agent.is_retired(), "retired agent session");
    match rpc.method.as_str() {
        "hello" => return app.db.save_facts(node_id, &rpc.params, ip),
        "report" => {
            let outcome = report(app, node_id, rpc.params, &mut entry);
            agent.publish(&entry);
            outcome?;
        }
        "ping.result" => {
            let task_id = rpc.params.get("task_id").and_then(|v| v.as_i64()).unwrap_or(0);
            // A missing reading is not a reading of -1: `close_bucket` counts
            // every negative latency as a lost packet, so defaulting here would
            // render a malformed frame as an outage. The accumulator follows the
            // same rule for a counter it cannot read.
            let latency = rpc.params.get("latency_ms").and_then(|v| v.as_i64());
            if let (true, Some(latency)) = (task_id > 0, latency) {
                app.db.insert_ping(node_id, task_id, Utc::now().timestamp(), latency)?;
            }
        }
        other => debug!("node {node_id} sent unknown method {other}"),
    }
    Ok(false)
}

fn locate(app: Shared, node_id: i64, ip: String) {
    if let Some(cc) = app.geo.country(&ip) {
        if let Err(e) = app.db.set_country(node_id, &cc, &ip) {
            warn!("node {node_id}: storing local country failed: {e:#}");
        }
    }
}

/// Figures the hub folds into a report on the way out. They never arrive from an
/// agent and are therefore not part of the contract one must meet.
const OPTIONAL: [&str; 7] = [
    "zram_used",
    "zram_total",
    "zram_devices",
    "swap_disk_used",
    "swap_disk_total",
    "swapfile_used",
    "swap_partition_used",
];
const INJECTED: [&str; 4] = ["total_rx", "total_tx", "month_rx", "month_tx"];

/// Everything an agent must send, derived from the public view rather than
/// restated a third time: this list, `api::PUBLIC_METRICS` and the check below
/// must agree, and only one of them is an independent fact.
///
/// The measure is what the hub depends on, not what it stores. `uptime`,
/// `mem_total`, `swap_total` and `disk_total` never reach the `metric` table but
/// go straight to the browser, and the default theme blanks a node's entire live
/// view when one is absent. Derived from the stored columns instead, this list
/// left those four uncovered, so an agent renaming one blanked every card on the
/// page with nothing in any log to explain it.
///
/// Hub and agent ship as two binaries from two repositories, and every reader
/// here ends in `unwrap_or(0)`: a field the agent renames does not fail, it
/// records zero until someone examines that chart.
fn report_fields() -> impl Iterator<Item = &'static str> {
    ["boot_id", "net_rx_total", "net_tx_total"]
        .into_iter()
        .chain(crate::api::PUBLIC_METRICS.iter().copied().filter(|k| !INJECTED.contains(k)))
}

/// Those carrying a plain number. `boot_id` is a string and `load` an array of
/// three; each is checked separately.
fn numeric_fields() -> impl Iterator<Item = &'static str> {
    report_fields().filter(|k| !matches!(*k, "boot_id" | "load"))
}

/// Reports, once per connection, when a report omits fields the hub depends on.
/// A version number cannot serve here: an agent that renames a field carries a
/// higher version, not a lower one.
fn check_contract(node_id: i64, metrics: &serde_json::Value) {
    let missing: Vec<&str> =
        report_fields().filter(|k| !OPTIONAL.contains(k) && metrics.get(k).is_none()).collect();
    if !missing.is_empty() {
        warn!("node {node_id} reports without {missing:?}: those columns will read zero and the default theme will void this node's live view, so this agent and this hub are out of step");
    }
}

fn report(app: &App, node_id: i64, mut metrics: serde_json::Value, entry: &mut AgentState) -> Result<()> {
    // Missing fields remain compatible with older agents, while malformed values
    // must not become a live frame that can crash a browser. Counter validation
    // is separate: a missing or null kernel reading must not alter its
    // baseline.
    let number = |v: &serde_json::Value| v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0);
    anyhow::ensure!(metrics.is_object(), "report must be an object");
    for key in numeric_fields() {
        anyhow::ensure!(
            metrics.get(key).is_none_or(|v| v.is_null() && OPTIONAL.contains(&key) || number(v)),
            "invalid report field {key}"
        );
    }
    if let Some(load) = metrics.get("load") {
        anyhow::ensure!(
            load.as_array().is_some_and(|v| v.len() == 3 && v.iter().all(number)),
            "invalid load"
        );
    }
    let now = Utc::now().timestamp();
    // Read once, alongside the wall clock: the stamp is a point in time taken
    // from `now`, while the rate below is a duration taken from this.
    let tick = Instant::now();
    // A placeholder rather than the empty string, which `accumulate` reads as
    // the absence of a baseline. An agent sending no boot_id -- an older build,
    // or a host without the file -- would otherwise realign on every report and
    // never book a byte.
    let boot_id = metrics.get("boot_id").and_then(|v| v.as_str()).filter(|b| !b.is_empty()).unwrap_or("-");
    // No reading is not a reading of zero; see `accumulate`. Anything that is
    // not a non-negative i64 is likewise no reading -- a u64 beyond the signed
    // range, a float, or a negative value. Negatives are rejected above and must
    // not survive here either: `accumulate` stores whatever it receives as the
    // next baseline, and a negative baseline would make the following report's
    // delta the counter plus its magnitude.
    let counter = |k: &str| metrics.get(k).and_then(|v| v.as_i64()).filter(|n| *n >= 0);
    let counters = counter("net_rx_total").zip(counter("net_tx_total"));
    let traffic = app.db.accumulate(node_id, boot_id, counters)?;

    // The UI displays the hub's accumulated figures, so they are folded into the
    // live payload while the raw kernel counters remain a wire-protocol detail.
    if let Some(obj) = metrics.as_object_mut() {
        obj.insert("total_rx".into(), json!(traffic.total_rx));
        obj.insert("total_tx".into(), json!(traffic.total_tx));
        obj.insert("month_rx".into(), json!(traffic.month_rx));
        obj.insert("month_tx".into(), json!(traffic.month_tx));
    }

    let minute = now / 60;
    let first = entry.last_seen == 0;
    if first {
        check_contract(node_id, &metrics);
    }
    // History holds one row per minute; the live view receives every report.
    let store = entry.last_minute != minute;
    entry.metrics = metrics.clone();
    entry.last_seen = now;
    entry.minute.add(&metrics);

    // The stored row summarises the interval since the previous row rather than
    // the instant it is stamped with: the network rate from the totals this hub
    // observed climb, every other averaged field from the mean of the reports in
    // between. This is what makes the chart integrate to the totals beside it.
    // The live view retains the report as it arrived.
    let row = store.then(|| {
        let mut row = metrics.clone();
        entry.minute.write_into(&mut row);
        if let (Some((since, rx0, tx0)), Some(obj)) = (entry.mark, row.as_object_mut()) {
            let elapsed = tick.saturating_duration_since(since).as_secs().max(1) as i64;
            obj.insert("net_rx".into(), json!((traffic.total_rx - rx0).max(0) / elapsed));
            obj.insert("net_tx".into(), json!((traffic.total_tx - tx0).max(0) / elapsed));
        }
        entry.last_minute = minute;
        entry.mark = Some((tick, traffic.total_rx, traffic.total_tx));
        entry.minute = Minute::default();
        row
    });
    // A session that has just started measures the next row's rate from its own
    // first report; without a mark the row would carry the agent's instantaneous
    // reading rather than the average over the interval.
    entry.mark.get_or_insert((tick, traffic.total_rx, traffic.total_tx));

    if let Some(row) = &row {
        app.db.insert_metric(node_id, minute * 60, row)?;
    }
    // "Offline since" is read from this column, so a session ending before its
    // first minute boundary must still leave a mark.
    app.db.touch_seen(node_id, now)?;
    Ok(())
}

fn ping_tasks_message(app: &App, node_id: i64) -> String {
    let tasks = app.db.ping_tasks_for(node_id).unwrap_or_default();
    json!({"jsonrpc": "2.0", "method": "ping.tasks", "params": tasks}).to_string()
}

/// Pushes the current probe list to every connected agent, so a panel edit takes
/// effect without waiting for a reconnect.
pub fn push_ping_tasks(app: &App) {
    let connected: Vec<(i64, mpsc::Sender<String>)> = app
        .agents
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(id, agent)| (*id, agent.tx.clone()))
        .collect();
    for (node_id, sender) in connected {
        // The queue carries only these messages, so a full one indicates an agent
        // that has stopped reading its socket. It is dropped within SILENCE and
        // reconnects onto the current list; what must not happen is the panel
        // reporting a push that never occurred.
        if sender.try_send(ping_tasks_message(app, node_id)).is_err() {
            warn!("node {node_id} is not draining its queue; it gets the new probe list when it reconnects");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, Node, PingTask};

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn node(app: &App) -> i64 {
        app.db
            .create_node(&Node { name: "n".into(), traffic_reset_day: 1, ..Default::default() }, "tok")
            .unwrap()
    }

    /// A connected agent, the precondition for filing any report: the session
    /// holds the node's live state.
    fn connect(app: &App) -> (i64, mpsc::Receiver<String>) {
        let id = node(app);
        let (tx, rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Arc::new(Agent::new(1, tx)));
        (id, rx)
    }

    /// The stable handle for a connected fixture node.
    fn agent(app: &App, id: i64) -> Arc<Agent> {
        app.agents.read().unwrap().get(&id).cloned().expect("fixture node is connected")
    }

    /// Locks one session's state for a test assertion or fixture edit.
    fn with_state<R>(app: &App, id: i64, f: impl FnOnce(&mut AgentState) -> R) -> R {
        let agent = agent(app, id);
        let mut state = agent.lock_state();
        f(&mut state)
    }

    fn live_metrics(app: &App, id: i64) -> serde_json::Value {
        with_state(app, id, |state| state.metrics.clone())
    }

    fn report_json(boot: &str, rx: i64, tx: i64) -> String {
        json!({
            "jsonrpc": "2.0", "method": "report",
            "params": {"boot_id": boot, "cpu": 12.5, "load": [0.5, 0.4, 0.3],
                       "mem_used": 100, "net_rx_total": rx, "net_tx_total": tx}
        })
        .to_string()
    }

    // Existing metric tests exercise a currently active fixture session.
    fn dispatch(app: &App, id: i64, ip: &str, text: &str) -> Result<bool> {
        let existing = app.agents.read().unwrap().get(&id).map(|agent| agent.session);
        let session = match existing {
            Some(session) => session,
            None => {
                let (tx, _rx) = mpsc::channel(1);
                let session = 1;
                app.agents.write().unwrap().insert(id, Arc::new(Agent::new(session, tx)));
                session
            }
        };
        super::dispatch(app, id, session, ip, text)
    }

    fn report(app: &App, id: i64, metrics: serde_json::Value) -> Result<()> {
        let handle = agent(app, id);
        let mut state = handle.lock_state();
        let outcome = super::report(app, id, metrics, &mut state);
        handle.publish(&state);
        outcome
    }

    #[test]
    fn a_live_snapshot_does_not_wait_for_an_in_flight_report_commit() {
        let (tx, _) = mpsc::channel(1);
        let agent = Arc::new(Agent::new(1, tx));
        let mut held = agent.lock_state();
        held.metrics = json!({"cpu": 12.5});
        held.last_seen = 123;
        agent.publish(&held);
        let other = agent.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || send.send(other.snapshot()).unwrap());
        let snapshot = receive.recv_timeout(Duration::from_secs(1));
        drop(held);
        reader.join().unwrap();
        assert_eq!(snapshot.unwrap(), (json!({"cpu":12.5}), 123));
    }

    #[test]
    fn retired_frames_cannot_mutate_a_replacement_session() {
        let app = app();
        let (id, _held) = connect(&app);
        super::dispatch(&app, id, 1, "ip", &report_json("boot", 100, 10)).unwrap();
        app.agents.write().unwrap().remove(&id);
        app.db.reset_token(id, "replacement").unwrap();
        activate(&app, id, "replacement", 2, mpsc::channel(1).0).unwrap();
        let before = app.db.all_traffic()[&id].total_rx;
        for frame in [
            report_json("boot", 50000, 10),
            json!({"method":"hello","params":{"hostname":"stale"}}).to_string(),
            json!({"method":"ping.result","params":{"task_id":1,"latency_ms":1}}).to_string(),
        ] {
            assert!(super::dispatch(&app, id, 1, "stale-ip", &frame).is_err());
        }
        assert_eq!(app.db.all_traffic()[&id].total_rx, before);
        assert_ne!(app.db.node(id).unwrap().unwrap().hostname, "stale");
        assert!(live_metrics(&app, id).is_null());
        super::dispatch(&app, id, 2, "ip", &report_json("boot", 200, 20)).unwrap();
        assert!(!live_metrics(&app, id).is_null());
    }

    #[test]
    fn activation_rechecks_a_token_revoked_after_handshake() {
        let app = app();
        let id = app.db.create_node(&Node { name: "n".into(), ..Default::default() }, "old").unwrap();
        assert_eq!(app.db.node_by_token("old").unwrap(), Some(id));
        app.db.reset_token(id, "new").unwrap();
        assert!(activate(&app, id, "old", 1, mpsc::channel(1).0).is_err());
        assert!(app.agents.read().unwrap().is_empty());
        activate(&app, id, "new", 2, mpsc::channel(1).0).unwrap();
        assert_eq!(app.agents.read().unwrap()[&id].session, 2);
    }

    #[test]
    fn country_lookup_is_not_scheduled_without_opt_in() {
        let app = std::sync::Arc::new(app());
        // No Tokio runtime: a spawn here would fail, proving the default gate is before spawning.
        locate(app.clone(), i64::MAX, "127.0.0.1".into());
        app.db.set("country_lookup", "off").unwrap();
        locate(app.clone(), i64::MAX, "127.0.0.1".into());
        assert!(app.geo.country("127.0.0.1").is_none());
    }

    #[test]
    fn malformed_reports_leave_the_last_good_frame_and_counters_untouched() {
        let app = app();
        let (id, _held) = connect(&app);
        dispatch(&app, id, "ip", &report_json("boot", 1_000, 500)).unwrap();
        let good = live_metrics(&app, id);
        for bad in [json!({"load":null}), json!({"load":[1,"bad",3]}), json!({"cpu":"bad"}), json!([])] {
            assert!(report(&app, id, bad).is_err());
            assert_eq!(live_metrics(&app, id), good);
        }
        dispatch(&app, id, "ip", &report_json("boot", 2_000, 600)).unwrap();
        assert_eq!(app.db.all_traffic()[&id].total_rx, 1_000);
    }

    /// The lifetime total must never decrease, and must never book bytes nobody
    /// moved. The two figures behind it arrive from another repository's binary
    /// and are the only report fields that mutate state outliving the
    /// connection.
    #[test]
    fn a_hostile_counter_can_neither_inflate_the_total_nor_wrap_it() {
        let app = app();
        let (id, _held) = connect(&app);
        let total = || app.db.all_traffic()[&id].total_rx;

        // Both counters, always: `report` pairs them, so omitting one makes the
        // pair unreadable and every assertion below pass for that reason rather
        // than the one under test.
        let send = |boot: &str, rx: serde_json::Value| {
            report(&app, id, json!({"boot_id": boot, "net_rx_total": rx, "net_tx_total": 0}))
        };

        // A negative reading is rejected and, critically, does not survive as the
        // baseline the next report subtracts from, which would make that report's
        // delta its own value plus 5 GB.
        assert!(send("b", json!(-5_000_000_000i64)).is_err());
        send("b", json!(1_000)).unwrap();
        assert_eq!(total(), 0, "a node that moved nothing books nothing");

        // Nor does a u64 beyond the signed range, which `as_i64` cannot read: no
        // reading, so the baseline is unchanged.
        send("b", json!(u64::MAX)).unwrap();
        send("b", json!(2_000)).unwrap();
        assert_eq!(total(), 1_000, "only the 1 000 bytes this hub watched climb");

        // The total saturates rather than wrapping. A plain `+=` would wrap to
        // i64::MIN in release builds, where overflow checks are disabled,
        // producing a lifetime figure that has decreased.
        app.db
            .set_traffic(id, &crate::db::TrafficPatch { total_rx: Some(i64::MAX - 10), ..Default::default() })
            .unwrap();
        send("c", json!(0)).unwrap();
        send("c", json!(i64::MAX)).unwrap();
        assert_eq!(total(), i64::MAX, "the total clamps; it never goes backwards");
    }

    /// The contract check is what makes a cross-repository rename visible.
    /// Derived from the columns the hub stores, it missed four fields that never
    /// reach the `metric` table but do reach the browser; the default theme
    /// blanks a node's entire live view if one is absent, so the drift surfaced
    /// as empty cards and no log output.
    #[test]
    fn the_contract_covers_every_field_the_browser_needs_not_just_the_stored_ones() {
        let fields: Vec<&str> = report_fields().collect();
        for needed in ["uptime", "mem_total", "swap_total", "disk_total"] {
            assert!(fields.contains(&needed), "{needed} reaches the theme, so a rename has to warn");
        }
        // boot_id and the two kernel counters extend the contract beyond the
        // public view; the four the hub folds in are not the agent's
        // responsibility.
        for injected in INJECTED {
            assert!(!fields.contains(&injected), "{injected} is the hub's own, not part of the contract");
        }
        assert!(fields.contains(&"boot_id") && fields.contains(&"net_rx_total"));
        // The numeric list is the same list minus the two that are not plain
        // numbers, so neither can drift from the other.
        let numeric: Vec<&str> = numeric_fields().collect();
        assert_eq!(numeric.len(), fields.len() - 2);
        assert!(!numeric.contains(&"load") && !numeric.contains(&"boot_id"));
    }

    /// A burst of reports within one minute: each advances the live view and the
    /// running totals, while history takes one row on the minute boundary.
    #[test]
    fn a_burst_of_reports_moves_the_live_view_but_writes_one_history_row() {
        let app = app();
        let (id, _held) = connect(&app);
        let minute = Utc::now().timestamp() / 60 * 60;
        // A session already running when this minute opened: the first report of
        // a new one lands within a minute already accounted for, which is the
        // reconnect case below.
        with_state(&app, id, |state| state.last_minute -= 1);

        dispatch(&app, id, "1.2.3.4", &report_json("boot-a", 1_000, 500)).unwrap();
        dispatch(&app, id, "1.2.3.4", &report_json("boot-a", 3_000, 1_500)).unwrap();

        let (metrics, last_minute) = {
            let handle = agent(&app, id);
            let state = handle.lock_state();
            (state.metrics.clone(), state.last_minute)
        };
        assert_eq!(metrics["cpu"], 12.5);
        // The first report establishes the baseline, so only the second counts.
        assert_eq!(metrics["total_rx"], 2_000);
        assert_eq!(metrics["total_tx"], 1_000);
        assert_eq!(metrics["month_rx"], 2_000);
        assert_eq!(last_minute, minute / 60, "the minute already written is remembered");

        // History rows are keyed by (node, ts), so counting them proves nothing on
        // its own: reports a second apart collapse onto one row with or without
        // the minute gate. The stamp is what demonstrates it.
        let rows = app.db.metrics(id, 0, 60).unwrap();
        assert_eq!(rows.len(), 1, "a minute of reports is one row");
        assert_eq!(rows[0]["ts"], minute, "stamped on the minute, not on the report");
        // Written on the same branch, and the offline badge is measured from it.
        assert!(app.db.node(id).unwrap().unwrap().last_seen >= minute, "last_seen is written too");
    }

    /// A history row describes the minute preceding it rather than the instant it
    /// is stamped with: the network rate from the totals the hub observed climb,
    /// everything else from the mean of the reports in between.
    #[test]
    fn a_history_row_describes_its_whole_minute_not_one_instant() {
        let app = app();
        let (id, _held) = connect(&app);
        let burst = |rx: i64, instant: i64, cpu: f64, mem: i64| {
            json!({"jsonrpc": "2.0", "method": "report",
                   "params": {"boot_id": "boot-a", "net_rx_total": rx, "net_tx_total": 0,
                              // What the agent measured over its own last second.
                              "net_rx": instant, "net_tx": 0, "cpu": cpu, "mem_used": mem}})
            .to_string()
        };

        // Busy for half the minute, then idle. The first reading is also the
        // traffic baseline: nothing is booked until a second arrives.
        dispatch(&app, id, "ip", &burst(1_000, 0, 100.0, 100)).unwrap();
        // Rewind the bookkeeping by a minute so the next report crosses the
        // boundary with a minute of elapsed time behind it. The mark is an
        // `Instant` precisely because a wall-clock difference can be negative when
        // NTP steps the clock; reverting the field to a timestamp fails to
        // compile.
        with_state(&app, id, |state| {
            state.last_minute -= 1;
            state.mark = Some((Instant::now() - Duration::from_secs(60), 0, 0));
        });
        // 60 MB arrived and the machine was busy for half the minute; by the next
        // sample both have ended.
        dispatch(&app, id, "ip", &burst(1_000 + 60_000_000, 0, 0.0, 201)).unwrap();

        let row = &app.db.metrics(id, 0, 60).unwrap()[0];
        assert_eq!(row["net_rx"], 1_000_000, "60 MB over 60 s is 1 MB/s, not the agent's 0");
        assert_eq!(row["cpu"], 50.0, "the mean of the minute, not the idle second it ended on");
        // Integers remain integral: the column is read with as_i64, which returns
        // nothing for the 150.5 the raw mean would produce.
        assert_eq!(row["mem_used"], 151);
        // The live view still shows the instantaneous reading, which is its
        // purpose.
        assert_eq!(live_metrics(&app, id)["net_rx"], 0);
    }

    /// A reconnect arrives mid-minute, and that minute's row already holds the
    /// mean of the preceding session. Replacing it with the single sample that
    /// opened the new session would stop the chart integrating to the totals
    /// printed beside it.
    #[test]
    fn a_reconnect_leaves_the_minute_it_lands_in_alone() {
        let app = app();
        let (id, _held) = connect(&app);
        with_state(&app, id, |state| state.last_minute -= 1);
        dispatch(&app, id, "ip", &report_json("boot-a", 1_000, 500)).unwrap();
        let before = app.db.metrics(id, 0, 60).unwrap();
        assert_eq!(before.len(), 1, "the running session wrote the row for this minute");

        // The socket drops and the agent returns within the same minute.
        let (tx, _rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Arc::new(Agent::new(2, tx)));
        let loud = json!({"jsonrpc": "2.0", "method": "report",
                          "params": {"boot_id": "boot-a", "cpu": 99.0, "net_rx_total": 9_000,
                                     "net_tx_total": 4_500}})
        .to_string();
        dispatch(&app, id, "ip", &loud).unwrap();

        assert_eq!(app.db.metrics(id, 0, 60).unwrap(), before, "the row keeps the minute it described");
        // The bytes are still booked; only the history row is left untouched.
        assert_eq!(live_metrics(&app, id)["total_rx"], 8_000);
    }

    /// An agent sending no boot_id -- an older build, or a host without the file
    /// -- still has its traffic accumulated. Reading the empty string as the
    /// absence of a baseline would realign on every report and book nothing
    /// indefinitely, with no outward sign.
    #[test]
    fn traffic_accumulates_for_an_agent_that_sends_no_boot_id() {
        let app = app();
        let (id, _held) = connect(&app);
        let report = |rx: i64| {
            json!({"jsonrpc": "2.0", "method": "report",
                   "params": {"cpu": 1.0, "net_rx_total": rx, "net_tx_total": 0}})
            .to_string()
        };
        dispatch(&app, id, "ip", &report(1_000)).unwrap();
        dispatch(&app, id, "ip", &report(3_000)).unwrap();
        assert_eq!(live_metrics(&app, id)["total_rx"], 2_000);

        // A report with no counters books nothing and, crucially, leaves the
        // baseline unchanged so the next one is a delta.
        let blind = json!({"jsonrpc": "2.0", "method": "report", "params": {"cpu": 1.0}}).to_string();
        dispatch(&app, id, "ip", &blind).unwrap();
        dispatch(&app, id, "ip", &report(4_000)).unwrap();
        assert_eq!(
            live_metrics(&app, id)["total_rx"],
            3_000,
            "a missing reading must not re-baseline the counter to zero"
        );
    }

    #[test]
    fn hello_stores_the_facts_and_the_observed_address() {
        let app = app();
        let id = node(&app);
        let hello = json!({
            "jsonrpc": "2.0", "method": "hello",
            "params": {"hostname": "vps-1", "os": "Debian 12", "cpu_cores": 4, "mem_total": 2048}
        });
        dispatch(&app, id, "198.51.100.4", &hello.to_string()).unwrap();

        let n = app.db.node(id).unwrap().unwrap();
        assert_eq!(n.hostname, "vps-1");
        assert_eq!(n.cpu_cores, 4);
        assert_eq!(n.ip, "198.51.100.4");
    }

    #[test]
    fn ping_results_are_recorded_and_bad_ones_ignored() {
        let app = app();
        let id = node(&app);
        // Assigned probes: a result is readable only through a node's current
        // assignments.
        let probe = |name: &str| {
            app.db
                .save_ping_task(&PingTask {
                    id: 0,
                    name: name.into(),
                    target: "1.1.1.1:443".into(),
                    interval: 60,
                    nodes: vec![id],
                })
                .unwrap()
        };
        let (one, two) = (probe("one"), probe("two"));
        let result = |task, latency| {
            json!({"jsonrpc": "2.0", "method": "ping.result",
                   "params": {"task_id": task, "latency_ms": latency}})
            .to_string()
        };
        dispatch(&app, id, "ip", &result(one, 42)).unwrap();
        // The rejected results carry task ids of their own: a bare count would be
        // satisfied by the key collapsing them onto a valid row.
        dispatch(&app, id, "ip", &result(two, 15)).unwrap();
        dispatch(&app, id, "ip", &result(0, 42)).unwrap(); // no such task
        dispatch(&app, id, "ip", &result(-1, 42)).unwrap(); // nor this one
                                                            // A frame carrying no reading. Defaulting to -1 would file it as a lost
                                                            // packet, rendering a malformed frame as an outage.
        dispatch(
            &app,
            id,
            "ip",
            &json!({"jsonrpc": "2.0", "method": "ping.result",
                                         "params": {"task_id": one}})
            .to_string(),
        )
        .unwrap();

        // Sorted rather than indexed: both rows land in the same second and the
        // query orders by timestamp.
        let mut seen: Vec<(i64, i64)> = app
            .db
            .ping_records(id, 0, 60)
            .unwrap()
            .0
            .iter()
            .map(|r| (r["task_id"].as_i64().unwrap(), r["latency"].as_i64().unwrap()))
            .collect();
        seen.sort();
        assert_eq!(seen, vec![(one, 42), (two, 15)], "each real task keeps its own result, and only those");
    }

    #[test]
    fn the_token_is_read_from_the_authorization_header_only() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h), None, "no header means no token");
        h.insert("authorization", "Bearer abc123".parse().unwrap());
        assert_eq!(bearer(&h), Some("abc123"));
        h.insert("authorization", "abc123".parse().unwrap());
        assert_eq!(bearer(&h), None, "a bare value is not a bearer token");
        h.insert("authorization", "Bearer ".parse().unwrap());
        assert_eq!(bearer(&h), None, "an empty token is not accepted");
    }

    #[test]
    fn a_late_teardown_leaves_the_reconnected_session_alone() {
        let app = app();
        let id = node(&app);
        let live = || app.agents.read().unwrap().contains_key(&id);
        // release() reads the session tag rather than the channel, so a dropped
        // receiver changes nothing.
        let connect = |session| {
            let (tx, _) = mpsc::channel(1);
            app.agents.write().unwrap().insert(id, Arc::new(Agent::new(session, tx)));
        };

        // The ordinary case: the session ending is the one on record.
        connect(1);
        assert!(release(&app, id, 1));
        assert!(!live(), "its own teardown clears the node");

        // The race: the agent gave up and reconnected while the old socket was
        // half-open, so session 2 is live when session 1 unwinds.
        connect(1);
        connect(2);
        assert!(!release(&app, id, 1), "a stale session must release nothing");
        assert!(live(), "the reconnected agent stays online");
        assert!(app.agents.read().unwrap().contains_key(&id), "and keeps receiving probe pushes");
    }

    fn wait_until(mut done: impl FnMut() -> bool, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The global map protects membership only. One node's report lock must not
    /// block another node, while reports for the same session stay serialized.
    #[test]
    fn different_nodes_report_concurrently_and_the_same_node_stays_ordered() {
        let app = std::sync::Arc::new(app());
        let (a, _ra) = connect(&app);
        let b = app
            .db
            .create_node(&Node { name: "b".into(), traffic_reset_day: 1, ..Default::default() }, "tok-b")
            .unwrap();
        let (tx_b, _rb) = mpsc::channel(2);
        app.agents.write().unwrap().insert(b, Arc::new(Agent::new(1, tx_b)));
        // Simulate one report for A already inside its critical section.
        let a_handle = agent(&app, a);
        let guard = a_handle.lock_state();

        let (b_done_tx, b_done_rx) = std::sync::mpsc::channel();
        let app_b = app.clone();
        let b_thread = std::thread::spawn(move || {
            let out = dispatch(&app_b, b, "ip", &report_json("boot-b", 100, 10));
            b_done_tx.send(()).unwrap();
            out
        });
        assert!(
            b_done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "node B must not wait behind node A's report lock"
        );
        b_thread.join().unwrap().unwrap();

        let (a_done_tx, a_done_rx) = std::sync::mpsc::channel();
        let app_a = app.clone();
        let a_thread = std::thread::spawn(move || {
            let out = dispatch(&app_a, a, "ip", &report_json("boot-a", 100, 10));
            a_done_tx.send(()).unwrap();
            out
        });
        assert!(
            a_done_rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "two reports for one session must be mutually exclusive"
        );
        drop(guard);
        assert!(
            a_done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the same-node report should proceed once the lock is released"
        );
        a_thread.join().unwrap().unwrap();
    }

    /// A delete that races an in-flight report must wait for that report and
    /// then refuse it; the retired session cannot write again.
    #[test]
    fn delete_retires_an_in_flight_session_without_being_undone() {
        let app = std::sync::Arc::new(app());
        let (id, _rx) = connect(&app);
        let handle = agent(&app, id);
        let guard = handle.lock_state();

        let app_delete = app.clone();
        let deleter = std::thread::spawn(move || {
            crate::agent_ws::retire_node_then(&app_delete, id, || app_delete.db.delete_node(id))
        });
        wait_until(|| app.agents.read().unwrap().is_empty(), "the session to leave the map");
        assert!(
            super::dispatch(&app, id, 1, "ip", &report_json("boot", 500, 5)).is_err(),
            "a late report must be refused"
        );

        drop(guard);
        deleter.join().unwrap().unwrap();
        assert!(app.db.node(id).unwrap().is_none(), "the delete was not undone");
        assert!(super::dispatch(&app, id, 1, "ip", &report_json("boot", 900, 9)).is_err());
    }

    /// Rotation drains the old session before the token changes, and the old
    /// session cannot write into the replacement.
    #[test]
    fn rotation_drains_the_old_session_before_changing_the_token() {
        let app = std::sync::Arc::new(app());
        let (id, _rx) = connect(&app);
        let handle = agent(&app, id);
        let guard = handle.lock_state();

        let app_rotate = app.clone();
        let rotator = std::thread::spawn(move || {
            crate::agent_ws::retire_node_then(&app_rotate, id, || {
                app_rotate.db.reset_token(id, "replacement-token")
            })
        });
        wait_until(|| app.agents.read().unwrap().is_empty(), "the session to leave the map");
        assert!(
            super::dispatch(&app, id, 1, "ip", &report_json("boot", 900, 9)).is_err(),
            "the retired session must not write"
        );

        drop(guard);
        rotator.join().unwrap().unwrap();
        assert!(app.db.node_by_token("tok").unwrap().is_none(), "the old token is revoked");
        assert_eq!(app.db.node_by_token("replacement-token").unwrap(), Some(id));

        let (tx, _rx) = mpsc::channel(2);
        activate(&app, id, "replacement-token", 2, tx).unwrap();
        assert!(super::dispatch(&app, id, 1, "ip", &report_json("stale", 100, 1)).is_err());
        super::dispatch(&app, id, 2, "ip", &report_json("fresh", 200, 2)).unwrap();
    }

    /// Restore retires every session before the file switch, so an old report
    /// cannot submit a fresh write into the restored database.
    #[test]
    fn restore_retires_every_session_before_switching_the_database() {
        let app = std::sync::Arc::new(app());
        let (id, _rx) = connect(&app);
        let backup = std::env::temp_dir().join(format!("romi-agent-restore-{}.db", rand::random::<u64>()));
        app.db.backup_into(backup.to_str().unwrap()).unwrap();
        // A node created after the archive must disappear on restore, proving
        // the switch really happened while the sessions were paused.
        let after_backup = app
            .db
            .create_node(
                &Node { name: "after".into(), traffic_reset_day: 1, ..Default::default() },
                "tok-after-backup",
            )
            .unwrap();

        let handle = agent(&app, id);
        let guard = handle.lock_state();
        let app_restore = app.clone();
        let source = backup.clone();
        let restorer = std::thread::spawn(move || {
            crate::agent_ws::retire_all_then(&app_restore, || {
                app_restore.db.restore_from(source.to_str().unwrap())
            })
            .map(|_| ())
        });
        wait_until(|| app.agents.read().unwrap().is_empty(), "all sessions to leave the map");
        assert!(
            super::dispatch(&app, id, 1, "ip", &report_json("boot", 900, 9)).is_err(),
            "an old report must not start a write during the replacement"
        );

        drop(guard);
        restorer.join().unwrap().unwrap();
        assert!(app.db.node(after_backup).unwrap().is_none(), "the restored file replaced the live one");
        assert!(app.agents.read().unwrap().is_empty(), "no session survives a restore");
        assert!(super::dispatch(&app, id, 1, "ip", &report_json("boot", 1_000, 10)).is_err());
        let _ = std::fs::remove_file(&backup);
    }

    #[test]
    fn junk_from_an_agent_is_rejected_without_taking_the_connection_down() {
        let app = app();
        let id = node(&app);
        assert!(dispatch(&app, id, "ip", "not json").is_err());
        // Unknown methods are ignored.
        assert!(dispatch(&app, id, "ip", r#"{"method":"whatever"}"#).is_ok());
    }
}
