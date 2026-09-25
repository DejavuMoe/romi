//! The panel and public-status HTTP surface.

use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Local, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::debug;

use crate::agent_ws::Agent;
use crate::auth::{
    authed, client_ip, current_session, hash_password, issue_session, issued_at, random_token, with_cookies,
};
use crate::db::{Node, NodePatch, PingTask, Traffic, TrafficPatch};
use crate::{agent_ws, App, Shared};

/// Present only on requests carrying a valid session. Handlers taking it cannot
/// be reached unauthenticated, so the check cannot be omitted.
pub struct Admin;

impl FromRequestParts<Shared> for Admin {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, app: &Shared) -> Result<Self, Self::Rejection> {
        if authed(app, &parts.headers) {
            Ok(Admin)
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

fn fail(e: impl std::fmt::Display) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
}

fn bad(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, message.to_owned()).into_response()
}

// ---- read paths, shared between the panel and the public page ----

/// Everything a report may expose under `metrics` on the public page: the agent
/// contract minus the raw kernel counters, which are a wire-protocol detail
/// disclosing a machine's entire lifetime traffic, plus the four figures the hub
/// folds in itself. The panel sees the report as it arrived.
pub(crate) const PUBLIC_METRICS: [&str; 25] = [
    "zram_used",
    "zram_total",
    "swap_disk_used",
    "swap_disk_total",
    "swapfile_used",
    "swap_partition_used",
    "zram_devices",
    "uptime",
    "cpu",
    "load",
    "mem_total",
    "mem_used",
    "swap_total",
    "swap_used",
    "disk_total",
    "disk_used",
    "net_rx",
    "net_tx",
    "tcp",
    "udp",
    "procs",
    "total_rx",
    "total_tx",
    "month_rx",
    "month_tx",
];

/// One node as the UI consumes it: stored config, live metrics and the hub's
/// accumulated traffic in a single object.
fn node_view(node: &Node, current: Option<&Agent>, traffic: &Traffic, full: bool) -> Value {
    // One lock and one clone per connected node. The rest of this view is built
    // without touching the per-session report lock.
    let snapshot = current.map(|agent| agent.snapshot());
    let live_metrics = snapshot.as_ref().map(|(metrics, _)| metrics);
    // The three capacities arrive twice: once in `Facts`, sent at the handshake
    // and stored, and again in every `Metrics`. A machine that gains a disk while
    // the agent is running -- the agent re-reads its mount table every sample so
    // that it appears -- then has a stored figure that is stale until the next
    // reconnect, possibly days away. Using the report while a node is connected
    // keeps every consumer of this view on one number: the card reads the live
    // metrics and the detail page reads these, and they previously showed the
    // same machine two different capacities. Offline, the stored figure is all
    // there is. No floor is applied: a host whose swap has just been disabled
    // reports zero and means it. A node connected but not yet reporting holds
    // `Null`, where `get` returns nothing and the stored figure stands.
    let live = |key: &str, stored: i64| {
        live_metrics.and_then(|m| m.get(key).and_then(serde_json::Value::as_i64)).unwrap_or(stored)
    };
    let mut view = json!({
        "id": node.id,
        "name": node.name,
        // A country rather than an address: it indicates which region a node sits
        // in, which is what a status page conveys, without locating it. The
        // address it was derived from remains behind the panel.
        "country": node.country,
        "sort": node.sort,
        "priority": node.priority,
        "traffic_unit": node.traffic_unit,
        "bandwidth_up": node.bandwidth_up,
        "bandwidth_down": node.bandwidth_down,
        "has_ipv4": node.has_ipv4,
        "has_ipv6": node.has_ipv6,
        "online_since": node.online_since,
        "public": node.public,
        "online": current.is_some(),
        // The live entry while connected, the stored one afterwards. Zero means
        // connected but not yet reporting, which is not a timestamp, so it falls
        // back to the stored value and "offline since" survives the gap.
        "last_seen": snapshot.as_ref().map(|(_, seen)| *seen).filter(|t| *t > 0).unwrap_or(node.last_seen),
        "metrics": snapshot.as_ref().map(|(metrics, _)| metrics.clone()).unwrap_or(Value::Null),
        "os": node.os,
        "kernel": node.kernel,
        "arch": node.arch,
        "virt": node.virt,
        "cpu_name": node.cpu_name,
        "cpu_cores": node.cpu_cores,
        "mem_total": live("mem_total", node.mem_total),
        "swap_total": live("swap_total", node.swap_total),
        "disk_total": live("disk_total", node.disk_total),
        "agent_version": node.agent_version,
        "price": node.price,
        "currency": node.currency,
        "billing_cycle": node.billing_cycle,
        "expires_at": node.expires_at,
        "traffic_limit": node.traffic_limit,
        "traffic_mode": node.traffic_mode,
        "traffic_reset_day": node.traffic_reset_day,
        "total_rx": traffic.total_rx,
        "total_tx": traffic.total_tx,
        "month_rx": traffic.month_rx,
        "month_tx": traffic.month_tx,
        "month_start": traffic.month_start,
        // Of the same nature as the month and lifetime figures beside it, which
        // the public page already shows, so this one is public as well.
        "day_rx": traffic.day_rx,
        "day_tx": traffic.day_tx,
    });
    // An allowlist rather than a denylist: the agent ships from its own
    // repository, so a field added there would otherwise reach anonymous visitors
    // the day it is released. No address, hostname or note may ever do so.
    if !full {
        if let Some(m) = view["metrics"].as_object_mut() {
            m.retain(|k, _| PUBLIC_METRICS.contains(&k.as_str()));
        }
    }
    // Private fields stay in the panel; credentials are absent from both views.
    if full {
        view["hostname"] = json!(node.hostname);
        view["ip"] = json!(node.ip);
        view["ipv4"] = json!(node.ipv4);
        view["ipv6"] = json!(node.ipv6);
        view["remark"] = json!(node.remark);
        view["notify"] = json!(node.notify);
    }
    view
}

fn visible_nodes(app: &App, full: bool) -> Result<Vec<Value>, anyhow::Error> {
    // One traffic query and one lock for the whole list, since this is what every
    // visitor to the public page loads.
    let nodes = app.db.nodes()?;
    let traffic = app.db.all_traffic();
    // Clone the handles under the map lock and release it before taking any
    // per-session report lock: report state and map mutation must never wait in
    // opposite orders.
    let connected: Vec<(i64, std::sync::Arc<Agent>)> = {
        let agents = app.agents.read().unwrap_or_else(|e| e.into_inner());
        agents.iter().map(|(id, agent)| (*id, agent.clone())).collect()
    };
    let none = Traffic::default();
    Ok(nodes
        .iter()
        .filter(|n| full || n.public)
        .map(|n| {
            let current = connected.iter().find(|(id, _)| *id == n.id).map(|(_, agent)| agent.as_ref());
            let mut view = node_view(n, current, traffic.get(&n.id).unwrap_or(&none), full);
            view["online_grace_minutes"] =
                json!(app.db.get("online_grace_minutes").and_then(|v| v.parse::<i64>().ok()).unwrap_or(5));
            view
        })
        .collect())
}

pub async fn nodes(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let full = authed(&app, &headers);
    if !full && !app.public_page() {
        return (StatusCode::UNAUTHORIZED, "sign-in required").into_response();
    }
    // The same rendered frame the browser streams receive, for the same reason:
    // otherwise every visitor would rebuild every node's row from storage and
    // the current per-agent session state.
    ([(axum::http::header::CONTENT_TYPE, "application/json")], live_snapshot(&app, full).as_str().to_owned())
        .into_response()
}

#[derive(Deserialize)]
pub struct Window {
    #[serde(default = "default_hours")]
    hours: i64,
    /// How many points the caller can draw. Absent means the full budget.
    points: Option<i64>,
    /// Which half the caller will draw, `metrics` or `ping`. Each tab draws one,
    /// and the other accounted for a third to two thirds of every response. Absent
    /// means both.
    series: Option<String>,
}

fn default_hours() -> i64 {
    6
}

/// How many history windows are built concurrently.
///
/// `PUBLIC_HOURS` bounds what one request costs; this bounds how many may run,
/// closing the same gap the password-verification gate closes on the anonymous
/// login path. DuckDB history reads now use the dedicated reader pool rather than
/// the writer connection, but large windows still scan enough rows to compete for
/// CPU and memory bandwidth. The measured capacity work in `docs/bench.md` keeps
/// four requests as the admission ceiling while the reader pool remains three.
///
/// Refused rather than queued: admitting an unbounded backlog would preserve the
/// same expensive work and only move the overload later.
///
/// The scan stays in `spawn_blocking`: DuckDB work is synchronous, and keeping it
/// off Tokio's runtime prevents analytical reads from occupying async executor
/// threads. The permit is held across that await, so "in flight" measures the
/// actual blocking work rather than the number of runtime workers.
pub(crate) const HISTORY_SLOTS: usize = 4;

/// Slots reserved for the signed-in operator, on top of the anonymous ceiling
/// above. Without them a busy status page answers the operator's own history
/// request with "try again", which is exactly when the charts are wanted.
pub(crate) const ADMIN_HISTORY_SLOTS: usize = 2;

pub async fn metrics(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(w): Query<Window>,
) -> Response {
    let full = authed(&app, &headers);
    if !readable(&app, full, id) {
        return (StatusCode::UNAUTHORIZED, "sign-in required").into_response();
    }
    // After the two point lookups above, so an unauthorised caller is told so
    // rather than asked to retry later.
    let Ok(_permit) = app.history_gate[usize::from(full)].try_acquire() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many history queries in flight, try again")
            .into_response();
    };
    let hours = w.hours.clamp(1, if full { ADMIN_HOURS } else { PUBLIC_HOURS });
    let since = Utc::now().timestamp() - hours * 3_600;
    let step = sample_step(hours, w.points);
    let wants = |name: &str| w.series.as_deref().is_none_or(|s| s == name);
    let (want_metrics, want_ping) = (wants("metrics"), wants("ping"));
    // Off the runtime, for the reason given in `db_stats` below: this reads every
    // probe result the node has retained within the window and can occupy a
    // reader-pool slot for the duration. That route is behind `Admin` and cheaper
    // than this one, which anyone can reach.
    //
    // It is also what makes the gate above effective: the permit is held across
    // an await, so exactly four callers are inside it at once rather than however
    // many worker threads happen to exist.
    let query_app = app.clone();
    let built = tokio::task::spawn_blocking(move || {
        // Probe names accompany the samples they label, so the page needs no
        // second request. Names only: targets and assignments remain behind
        // `Admin`. Skipped when probes were not requested, since the resources tab
        // has nothing to label and this still costs a reader-pool query.
        let probes = if want_ping {
            query_app.db.ping_task_names(id).unwrap_or_else(|_| json!({}))
        } else {
            json!({})
        };
        let metrics = if want_metrics { query_app.db.metrics(id, since, step)? } else { vec![] };
        // `loss` is per probe across the whole window, alongside the per-bucket
        // `loss` on the rows. Both are required and neither replaces the other:
        // the row figure is what a tooltip reads, while the window figure is the
        // only one that can be accurate, since the denominators it divides by are
        // gone by the time the rows are built. Additive, so a theme unaware of it
        // continues to work.
        let (ping, loss) =
            if want_ping { query_app.db.ping_records(id, since, step)? } else { (vec![], json!({})) };
        anyhow::Ok(json!({"metrics": metrics, "ping": ping, "probes": probes, "loss": loss}))
    })
    .await;
    match built.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
        Ok(body) => Json(body).into_response(),
        Err(e) => fail(e),
    }
}

/// Widest history window each audience may request.
///
/// The thinning below bounds the response, not the scan behind it: `hours=2160`
/// returns 320 rows after reading every probe result the node has retained. At a
/// month of retention that measured 224 ms of analytical work, growing with
/// `retention_days` and competing for the bounded reader pool plus CPU/memory
/// bandwidth.
///
/// The public ceiling is a week because that is the widest chart the themes
/// draw. The signed-in operator may query the year of hourly history.
const PUBLIC_HOURS: i64 = 24 * 7;
const ADMIN_HOURS: i64 = 24 * 365;

/// Seconds between the samples a window is drawn from.
///
/// Thinning exists for what the screen cannot draw rather than as a convention:
/// where the samples fit, every one is sent. A chart of a hundred points reads
/// as a hundred samples taken, which for a probe is a claim about the network.
/// Whole minutes, matching the grid the metric rows sit on.
///
/// `points` is what the caller reports it can draw, and can only lower the
/// budget: `SAMPLES` is the hub's ceiling rather than the caller's, set at a day
/// of minutes so the widest charted probe window returns intact.
// ponytail: the budget is per series, so a response is SAMPLES × (1 + probes) --
// bounded by how many probes the admin created, not by the caller. Four probes
// at a day is ~90 kB gzipped; if that list ever grows long, scale SAMPLES by
// the probe count.
fn sample_step(hours: i64, points: Option<i64>) -> i64 {
    const SAMPLES: i64 = 1_440;
    let budget = points.unwrap_or(SAMPLES).clamp(60, SAMPLES);
    // Rounded up, or the budget would not be one: a window that does not divide
    // evenly would keep the finer step and exceed it. `i64::div_ceil` is still
    // unstable, and both operands are positive here.
    60 * ((hours * 60 + budget - 1) / budget).max(1)
}

/// Guards a per-node read: the panel sees everything, while the public page sees
/// only nodes explicitly published. `full` is the caller's own `authed`, passed
/// in because the handler also needs it for the window ceiling.
fn readable(app: &App, full: bool, id: i64) -> bool {
    full || (app.public_page() && app.db.node(id).ok().flatten().is_some_and(|n| n.public))
}

/// Per-connection read buffer for both WebSocket surfaces. The 128 KiB default
/// would be tens of megabytes across a few hundred agents, for frames a few
/// hundred bytes long.
pub const SOCKET_BUFFER: usize = 4 * 1024;

/// Largest frame either socket accepts, matching the 64 KiB cap on the HTTP
/// body. That limit is a tower layer and never applies here, where the default
/// ceiling is 64 MiB -- reachable with a node's own token, for content that is
/// stored and then served to every viewer of the public page.
///
/// Both halves are set wherever this is used. `max_message_size` alone bounds
/// the assembled message, but tungstenite buffers each *frame* whole before the
/// message length is known, and its own frame default is 16 MiB; a sender that
/// never sets FIN could therefore hold that much per connection against a limit
/// that reads as 64 KiB.
pub const MAX_FRAME: usize = 64 * 1024;

/// How long one rendered snapshot is reused. Just under the push interval, so
/// every tick rebuilds once and no viewer receives a stale frame twice.
fn push_interval() -> std::time::Duration {
    #[cfg(feature = "bench")]
    if let Some(ms) = std::env::var("ROMI_BENCH_PUSH_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        return std::time::Duration::from_millis(ms.clamp(500, 5000));
    }
    std::time::Duration::from_secs(2)
}

/// The payload every browser stream sends, built at most once per tick however
/// many tabs are watching: the public page is anonymous, so a per-connection
/// build would make viewer count a multiplier on database work. Two slots,
/// because the admin view carries fields the public one must never expose.
fn live_snapshot(app: &App, full: bool) -> Utf8Bytes {
    let now = Utc::now().timestamp_millis();
    let slot = usize::from(full);
    let mut cache = app.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    // A cached frame's age must be non-negative. A wall clock can step backwards
    // -- NTP correcting a fresh boot -- and against a bare upper bound the
    // resulting negative reads as young, pinning the panel to a stale frame until
    // real time catches up.
    #[cfg(feature = "bench")]
    let reuse = std::env::var_os("ROMI_BENCH_NO_SNAPSHOT_CACHE").is_none();
    #[cfg(not(feature = "bench"))]
    let reuse = true;
    let ttl = push_interval().as_millis() as i64 - 100;
    if reuse && (0..ttl).contains(&now.saturating_sub(cache[slot].0)) {
        return cache[slot].1.clone();
    }
    let nodes = visible_nodes(app, full).unwrap_or_default();
    // `admin` is included so the panel's first fetch and its stream share one
    // cached frame.
    let payload = Utf8Bytes::from(json!({"nodes": nodes, "admin": full}).to_string());
    cache[slot] = (now, payload.clone());
    payload
}

/// Drops the cached frames so the next push rebuilds. Without it a node just
/// added in the panel would disappear from the list until the frame expires.
pub(crate) fn invalidate_snapshot(app: &App) {
    for slot in app.snapshot.lock().unwrap_or_else(|e| e.into_inner()).iter_mut() {
        slot.0 = 0;
    }
}

/// What one tick of a browser stream may send: the admin frame while the session
/// that opened it remains live, the public frame while the status page remains
/// open to anonymous callers, and nothing once either ceases to hold.
///
/// Both are checked every tick rather than at the handshake alone, because a
/// socket outlives both answers. The admin frame contains private node metadata,
/// so it must stop when its session is revoked. Tokens are never included in
/// either frame. The public frame is what an operator withdraws by
/// switching the status page off, and a socket opened a minute earlier would
/// continue sending it for as long as the tab stayed open: `live_ws` refuses new
/// anonymous connections from that moment and `nodes` answers them 401, leaving
/// this the only remaining route. Whatever the handshake tested must be tested
/// here as well.
fn stream_audience(app: &App, session: Option<&str>) -> Option<bool> {
    match session {
        Some(hash) => app.db.session_valid(hash).then_some(true),
        None => app.public_page().then_some(false),
    }
}

/// Anonymous streams one client may hold at once. Enough for a few tabs, or a
/// household behind one address; far short of the 64 public seats, so no single
/// caller can take them all and close the status page to everyone else.
const VIEWERS_PER_CLIENT: usize = 4;

/// The unit a client is counted in. An IPv6 host is handed a whole /64 and can
/// open each stream from a fresh address in it, so counting addresses would
/// count nothing.
fn viewer_key(ip: std::net::IpAddr) -> std::net::IpAddr {
    match ip.to_canonical() {
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

/// One anonymous stream's claim on its client's allowance, released on drop --
/// including when the upgrade never completes and the closure holding it is
/// discarded.
pub(crate) struct ViewerSeat {
    app: Shared,
    key: std::net::IpAddr,
}

impl ViewerSeat {
    fn take(app: &Shared, ip: std::net::IpAddr) -> Option<Self> {
        let key = viewer_key(ip);
        let mut held = app.anonymous_viewers.lock().unwrap_or_else(|e| e.into_inner());
        let count = held.entry(key).or_default();
        if *count >= VIEWERS_PER_CLIENT {
            return None;
        }
        *count += 1;
        Some(Self { app: app.clone(), key })
    }
}

impl Drop for ViewerSeat {
    fn drop(&mut self) {
        let mut held = self.app.anonymous_viewers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = held.get_mut(&self.key) {
            *count -= 1;
            // Emptied entries are removed, or the map would grow by one key for
            // every address that ever opened the status page.
            if *count == 0 {
                held.remove(&self.key);
            }
        }
    }
}

/// Live stream for the browser. Each connection runs its own timer -- simpler to
/// reason about than a fan-out channel -- over a shared snapshot, so a timer
/// costs no more than a send.
pub async fn live_ws(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // The digest rather than the result: signing out must reach a stream already
    // running, and only the row it names can report whether it has.
    let session = current_session(&headers).filter(|hash| app.db.session_valid(hash));
    if session.is_none() && !app.public_page() {
        return (StatusCode::UNAUTHORIZED, "sign-in required").into_response();
    }
    // Only the anonymous side is counted per client: a session is already an
    // identity, and the operator's own seats are the reserved pool.
    let seat = match session {
        Some(_) => None,
        None => match ViewerSeat::take(&app, crate::auth::client_ip(&headers, peer.ip())) {
            Some(seat) => Some(seat),
            None => {
                return (StatusCode::TOO_MANY_REQUESTS, "too many live views from this address")
                    .into_response();
            }
        },
    };
    let Ok(permit) = app.viewer_gate[usize::from(session.is_some())].clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "live viewer capacity reached").into_response();
    };
    upgrade
        .read_buffer_size(SOCKET_BUFFER)
        .write_buffer_size(SOCKET_BUFFER)
        .max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| async move {
            let (_permit, _seat) = (permit, seat);
            stream_live(app, socket, session).await;
        })
}

async fn stream_live(app: Shared, mut socket: WebSocket, session: Option<String>) {
    let mut ticker = tokio::time::interval(push_interval());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // Closed rather than downgraded to the public frame, which would
                // leave the panel rendering a list with every admin field
                // missing. The close allows a client to re-query /api/me and
                // determine its current state.
                let Some(full) = stream_audience(&app, session.as_deref()) else { break };
                if !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        socket.send(Message::Text(live_snapshot(&app, full)))
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    break;
                }
            }
            // Read as well as written. Neither page ever sends on this socket, so
            // anything but a ping is the end of it: a close frame, a dropped
            // connection, or a client that has no business talking here. Without
            // this read a closed tab kept its seat until a later send happened to
            // fail, and a ping was never answered -- the reply is queued by the
            // read and flushed by the next send.
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break,
            },
        }
    }
}

// ---- panel write paths ----

/// Names all three causes. A reverse proxy that does not preserve Host forwards
/// its own upstream address, which is an IP and therefore never an https domain
/// entry, while the admin reading this is already on the domain -- so the first
/// clause alone would point them in the wrong direction. The third is `--site`,
/// the one input to this decision that nothing about the request reveals: a hub
/// started with `--site https://198.51.100.7` refuses every provisioning call
/// from an otherwise valid https domain entry. `main` warns about that at
/// startup; this is for whoever reads the panel rather than the journal.
const PROVISIONING_DENIED: &str = "请通过 HTTPS 域名访问面板后添加或安装节点；\
     如果已经是域名访问，检查反向代理是否透传了 Host 与 X-Forwarded-Proto（见 README 的反代配置）；\
     两者都没问题就检查 hub 的启动参数 --site，它必须是 https:// 加域名，不能是 IP、不能带路径";

pub(crate) fn https_domain(site: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(site).ok()?;
    (url.scheme() == "https"
        && url.domain().is_some_and(|d| d != "localhost" && !d.ends_with(".localhost"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

/// Host and the proxy's scheme describe this request; --site must not turn an IP
/// entry point into a domain entry point. The listener remains behind the trusted
/// reverse proxy, which must preserve Host and set X-Forwarded-Proto.
///
/// Every refusal names which half failed. Without that, a proxy configured with a
/// bare `proxy_pass` -- nginx then forwards `Host: 127.0.0.1:28080`, as does
/// Apache under its default `ProxyPreserveHost Off` -- is indistinguishable from
/// a genuine IP entry point: provisioning stops working across an upgrade, the
/// message implicates the address bar, and nothing records the header actually
/// responsible.
fn provisioning_allowed(app: &App, headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        debug!("provisioning refused: the request carries no readable Host header");
        return false;
    };
    let forwarded = crate::forwarded_proto(headers);
    let https = forwarded.map_or_else(|| app.site.starts_with("https://"), |scheme| scheme == "https");
    if !https || (!app.site.is_empty() && https_domain(&app.site).is_none()) {
        debug!(
            "provisioning refused: not an https domain entry (X-Forwarded-Proto={forwarded:?}, --site={:?}); \
             a TLS-terminating proxy has to send X-Forwarded-Proto: https",
            app.site
        );
        return false;
    }
    let Some(url) = https_domain(&format!("https://{host}")) else {
        debug!(
            "provisioning refused: Host {host:?} is not an https domain entry; a reverse proxy that does \
             not preserve Host sends its own upstream address here -- nginx needs \
             `proxy_set_header Host $host`, Apache `ProxyPreserveHost On`"
        );
        return false;
    };
    let expected = url.origin().ascii_serialization();
    let allowed =
        headers.get(header::ORIGIN).is_none_or(|origin| origin.to_str().ok() == Some(expected.as_str()));
    if !allowed {
        debug!("provisioning refused: Origin {:?} is not {expected}", headers.get(header::ORIGIN));
    }
    allowed
}

/// Range and sign limits every stored node must satisfy, or the reason it does
/// not. Shared because both writers must enforce them: the create path formerly
/// accepted a whole `Node` unchecked, leaving the values the update path refuses
/// reachable by another route, and an out-of-range reset day remained harmless
/// only because `period_start` clamps what it reads.
fn valid_expiry(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok_and(|date| {
        value.len() == 10 && !value.starts_with("0000") && date.format("%Y-%m-%d").to_string() == value
    })
}

fn node_limits(reset_day: Option<u32>, price: Option<f64>, limit: Option<i64>) -> Option<&'static str> {
    if reset_day.is_some_and(|d| !(1..=31).contains(&d)) {
        return Some("reset day must be from 1 to 31");
    }
    if price.is_some_and(|v| !v.is_finite() || v < 0.0) || limit.is_some_and(|v| v < 0) {
        return Some("price and traffic limit must be non-negative");
    }
    None
}

pub async fn me(State(app): State<Shared>, headers: HeaderMap) -> Json<Value> {
    Json(json!({
        "authed": authed(&app, &headers),
        "site_name": app.db.get("site_name").unwrap_or_else(|| "Monitor".into()),
        "public_page": app.public_page(),
        "public_default_view": app.db.get("public_default_view").filter(|v| v == "list").unwrap_or_else(|| "cards".into()),
        "can_provision": provisioning_allowed(&app, &headers),
        // The hub's own public URL when one was given, which is what belongs in an
        // install command -- not whichever address this
        // browser used, which behind a proxy may be a loopback port. Empty by
        // default, in which case the browser's address is the only one available
        // and the panel falls back to its own origin.
        "site": app.site,
        // Public, non-secret distribution identity. The panel uses this to
        // avoid offering an install command while the Hub has no validated
        // Agent artifact to serve.
        "distribution": app.distribution.as_ref().map(|d| json!({
            "version": d.version,
            "architecture": d.architecture,
            "target": d.target,
        })),
    }))
}

/// A cheap liveness/readiness result for the installer and reverse proxy.
/// It performs a single trivial query through the reader pool and confirms
/// the writer queue is still accepting; it never scans telemetry, never reads
/// a setting, and carries no credential or build information.
pub async fn healthz(State(app): State<Shared>) -> Response {
    let body =
        if app.db.health().is_ok() { json!({"status": "ok"}) } else { json!({"status": "unavailable"}) };
    let status = if body["status"] == "ok" { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    let mut response = ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response();
    *response.status_mut() = status;
    response
}

/// Public metadata for the configured Agent distribution.
#[derive(Deserialize, Default)]
pub struct DistributionQuery {
    target: Option<String>,
}

pub async fn agent_distribution(
    State(app): State<Shared>,
    Query(query): Query<DistributionQuery>,
) -> Response {
    let Some(distribution) = &app.distribution else {
        return crate::distribution_unavailable();
    };
    let Some(distribution) =
        distribution.select(query.target.as_deref().unwrap_or(distribution.target.as_str()))
    else {
        return (StatusCode::NOT_FOUND, "no such romi Agent target").into_response();
    };
    (
        [
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::CONTENT_TYPE, "application/json".to_owned()),
        ],
        Json(distribution.metadata()),
    )
        .into_response()
}

/// The romi Agent installer embedded in this Hub build. It is served only when
/// a local distribution has passed startup validation; it contains no mutable
/// URL and fetches the exact version advertised by this same Hub.
pub async fn agent_install_script(State(app): State<Shared>) -> Response {
    if app.distribution.is_none() {
        return crate::distribution_unavailable();
    }
    (
        [
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8".to_owned()),
            (header::CONTENT_DISPOSITION, "inline; filename=\"install.sh\"".to_owned()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        ],
        crate::distribution::INSTALL_SCRIPT,
    )
        .into_response()
}

/// The immutable versioned Agent binary URL. The bytes were validated and
/// loaded at startup, so this route never performs a file or network lookup.
pub async fn agent_binary(
    State(app): State<Shared>,
    Path((version, arch)): Path<(String, String)>,
) -> Response {
    let Some(distribution) = &app.distribution else {
        return crate::distribution_unavailable();
    };
    let Some(distribution) = distribution.select(&arch) else {
        return (StatusCode::NOT_FOUND, "no such romi Agent target").into_response();
    };
    if version != distribution.version {
        return (StatusCode::NOT_FOUND, "no such romi Agent artifact").into_response();
    }
    let bytes = distribution.binary();
    let length = bytes.len().to_string();
    (
        [
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_owned()),
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, length),
            (header::ETAG, format!("\"{}\"", distribution.sha256)),
            (header::HeaderName::from_static("x-romi-agent-version"), distribution.version.clone()),
            (header::HeaderName::from_static("x-romi-agent-sha256"), distribution.sha256.clone()),
        ],
        bytes,
    )
        .into_response()
}

/// The pre-release architecture-only alias is deliberately not served. A
/// missing distribution still answers 503 so the disabled state is uniform;
/// with a distribution configured callers are told to use the versioned URL.
pub async fn agent_binary_alias(State(app): State<Shared>, Path(_arch): Path<String>) -> Response {
    if app.distribution.is_none() {
        return crate::distribution_unavailable();
    }
    (StatusCode::NOT_FOUND, "use the versioned Agent URL /agent/vX.Y.Z/<target>").into_response()
}

/// Runs one storage call on a blocking thread.
///
/// Every write waits for the writer thread's commit, and during a maintenance
/// operation it waits for the barrier; a history read waits for a free connection.
/// None of that belongs on a Tokio core worker, so the mutation routes hand the
/// call to `spawn_blocking` the same way the history and data-page routes already
/// do. Indexed point reads (`Db::get`, `Db::session_valid`) stay inline: they are
/// single-row lookups on a pool that short work does not queue behind.
async fn storage<T, F>(app: &Shared, f: F) -> Result<T, anyhow::Error>
where
    T: Send + 'static,
    F: FnOnce(&crate::db::Db) -> Result<T, anyhow::Error> + Send + 'static,
{
    let db = app.db.clone();
    match tokio::task::spawn_blocking(move || f(&db)).await {
        Ok(outcome) => outcome,
        Err(e) => Err(anyhow::anyhow!("数据库任务失败：{e}")),
    }
}

fn metadata_error(priority: Option<i64>, up: Option<f64>, down: Option<f64>) -> Option<&'static str> {
    if priority.is_some_and(|v| !(0..=999999).contains(&v)) {
        return Some("priority must be an integer from 0 to 999999");
    }
    if [up, down].into_iter().flatten().any(|v| !v.is_finite() || !(0.0..=1_000_000.0).contains(&v)) {
        return Some("bandwidth must be from 0 to 1000000 Mbps");
    }
    None
}

pub async fn create_node(
    _: Admin,
    State(app): State<Shared>,
    headers: HeaderMap,
    body: Result<Json<Node>, JsonRejection>,
) -> Response {
    if !provisioning_allowed(&app, &headers) {
        return (StatusCode::FORBIDDEN, PROVISIONING_DENIED).into_response();
    }
    let Ok(Json(mut node)) = body else { return bad("invalid node") };
    if node.name.trim().is_empty() {
        return bad("name is required");
    }
    if let Some(message) =
        node_limits(Some(node.traffic_reset_day), Some(node.price), Some(node.traffic_limit))
    {
        return bad(message);
    }
    if let Some(message) =
        metadata_error(Some(node.priority), Some(node.bandwidth_up), Some(node.bandwidth_down))
    {
        return bad(message);
    }
    if !matches!(node.traffic_unit.as_str(), "GB" | "TB") {
        return bad("invalid traffic unit");
    }
    if node.expires_at.as_deref().is_some_and(|date| !valid_expiry(date)) {
        return bad("expiry must be a valid YYYY-MM-DD date");
    }
    node.name = node.name.trim().to_owned();
    let token = random_token();
    let issued = token.clone();
    match storage(&app, move |db| db.create_node(&node, &issued)).await {
        // Reveal once. Neither the raw token nor its hash belongs in node views.
        Ok(id) => {
            invalidate_snapshot(&app);
            ([(axum::http::header::CACHE_CONTROL, "no-store")], Json(json!({"id": id, "token": token})))
                .into_response()
        }
        Err(e) => fail(e),
    }
}

// ---- automatic registration ----

/// How long a registration window stays open.
///
/// Provisioning a batch of machines takes minutes, and the window expires on its
/// own rather than depending on someone returning to close it.
const REGISTER_WINDOW: i64 = 3600;

/// How many nodes one window may register.
///
/// Without it, whoever holds the key for the hour could fill the node table. A
/// hundred is well beyond a plausible batch and well short of a problem.
const REGISTER_LIMIT: i64 = 100;

/// Exchanges a registration key for a node token, so a batch of machines can be
/// provisioned with one command rather than one panel visit each.
///
/// No session stands behind this route: the caller is an unauthenticated
/// provisioning script on a machine that has never contacted the hub. A key
/// issued by the panel, valid only within [`REGISTER_WINDOW`], serves in place of
/// a session. Distribution routes are enabled only when the Hub was started
/// with a validated local Agent distribution (see `docs/deployment.md`).
///
/// One request costs two setting reads, a `COUNT` and an `INSERT`. It makes no
/// outbound request, and the router's 64 KiB body limit bounds the name.
pub async fn agent_register(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    // Preserve the plain-text registration protocol for shell clients. The
    // Agent installer exchanges this one-time key for a permanent token.
    name: String,
) -> Response {
    if !provisioning_allowed(&app, &headers) {
        return (StatusCode::FORBIDDEN, PROVISIONING_DENIED).into_response();
    }
    let ip = client_ip(&headers, peer.ip());
    // Counted separately from the sign-in page: a batch install started with a
    // stale key is a misconfigured deploy rather than an attack on the panel, and
    // a shared counter would lock the operator out of their own hub for LOCKOUT.
    if app.registrations.locked(ip) {
        return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, try again later").into_response();
    }
    // One answer for both "no window is open" and "that key is wrong": the
    // difference is only useful to someone who has neither.
    let closed = || (StatusCode::FORBIDDEN, "registration is closed").into_response();
    let window = match storage(&app, |db| {
        Ok((
            db.get("register_until").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
            db.get("register_key"),
        ))
    })
    .await
    {
        Ok(window) => window,
        Err(e) => return fail(e),
    };
    let (until, key) = window;
    let Some(key) = key.filter(|k| !k.is_empty() && Utc::now().timestamp() < until) else {
        return closed();
    };
    if agent_ws::bearer(&headers) != Some(key.as_str()) {
        // Only an incorrect key counts against the address. With the window
        // closed there is no secret to guess, and counting then would let anyone
        // lock an address they name in `X-Forwarded-For` out of the sign-in page.
        app.registrations.record_failure(ip);
        return closed();
    }
    // The name comes from a machine not yet vouched for: control characters would
    // break the panel's rows, and the length must be bounded. `chars()` rather
    // than bytes, so the cut falls on a character boundary.
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(64).collect();
    let name = if name.is_empty() { "unnamed".to_owned() } else { name };
    // Field defaults live in `Node`'s serde attributes and nowhere else.
    // `Node::default()` is a different set of values -- private, reset day 0 --
    // and a node registered here must match one added through the panel.
    let node = match serde_json::from_value::<Node>(json!({ "name": name })) {
        Ok(node) => node,
        Err(e) => return fail(e),
    };
    let token = random_token();
    let issued = token.clone();
    // The window's node budget is enforced inside the insert's transaction: a
    // batch of scripts starting together would each pass a separate count.
    let cap = Some((until - REGISTER_WINDOW, REGISTER_LIMIT));
    match storage(&app, move |db| db.create_node_within(&node, &issued, cap)).await {
        Ok(_) => {
            app.registrations.clear(ip);
            invalidate_snapshot(&app);
            ([(axum::http::header::CACHE_CONTROL, "no-store")], token).into_response()
        }
        Err(e) if e.to_string().contains(crate::db::REGISTRATION_FULL) => {
            (StatusCode::FORBIDDEN, crate::db::REGISTRATION_FULL).into_response()
        }
        Err(e) => fail(e),
    }
}

/// Opens a registration window with a fresh key. Any previous key stops working
/// the moment this returns.
pub async fn open_register(_: Admin, State(app): State<Shared>, headers: HeaderMap) -> Response {
    if !provisioning_allowed(&app, &headers) {
        return (StatusCode::FORBIDDEN, PROVISIONING_DENIED).into_response();
    }
    let key = random_token();
    let until = (Utc::now().timestamp() + REGISTER_WINDOW).to_string();
    let (written_key, written_until) = (key.clone(), until.clone());
    match storage(&app, move |db| {
        db.set("register_key", &written_key)?;
        db.set("register_until", &written_until)
    })
    .await
    {
        Ok(()) => Json(json!({"register_key": key, "register_until": until})).into_response(),
        Err(e) => fail(e),
    }
}

/// Closes the window early, before the hour elapses.
pub async fn close_register(_: Admin, State(app): State<Shared>) -> Response {
    match storage(&app, |db| {
        db.set("register_key", "")?;
        db.set("register_until", "0")
    })
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

pub async fn update_node(
    _: Admin,
    State(app): State<Shared>,
    Path(id): Path<i64>,
    body: Result<Json<NodePatch>, JsonRejection>,
) -> Response {
    let Ok(Json(mut node)) = body else { return bad("invalid node") };
    if let Some(name) = &mut node.name {
        *name = name.trim().to_owned();
        if name.is_empty() {
            return bad("name is required");
        }
    }
    if let Some(message) = node_limits(node.traffic_reset_day, node.price, node.traffic_limit) {
        return bad(message);
    }
    if node.expires_at.as_ref().and_then(|value| value.as_deref()).is_some_and(|date| !valid_expiry(date)) {
        return bad("expiry must be a valid YYYY-MM-DD date");
    }
    if node.traffic_unit.as_deref().is_some_and(|s| !matches!(s, "GB" | "TB")) {
        return bad("invalid traffic unit");
    }
    if let Some(message) = metadata_error(node.priority, node.bandwidth_up, node.bandwidth_down) {
        return bad(message);
    }
    match storage(&app, move |db| db.update_node(id, &node)).await {
        Ok(true) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        // Reported, not swallowed: a panel editing a node another tab deleted
        // would otherwise say "已保存" for a change that went nowhere.
        Ok(false) => (StatusCode::NOT_FOUND, "no such node").into_response(),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
pub struct NodeOrder {
    ids: Vec<i64>,
}

/// The list must name every node exactly once, checked inside the transaction
/// that renumbers rather than here: re-reading the node list first would only
/// race the write it guards.
pub async fn reorder_nodes(_: Admin, State(app): State<Shared>, Json(order): Json<NodeOrder>) -> Response {
    match storage(&app, move |db| db.reorder_nodes(&order.ids)).await {
        Ok(()) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        // Every failure here indicates a malformed list from the caller.
        Err(e) => bad(&e.to_string()),
    }
}

pub async fn delete_node(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    // The token is checked only at the handshake, so deleting the row does not
    // end a connection already open on it; retiring the session does. The agent
    // must not keep reporting under an id, and a report already in flight must
    // not land after the delete. `retire_node_then` waits out the in-flight
    // report and holds its state lock across the database delete; the helper's
    // admin gate also serializes this against activation and token rotation.
    let owner = app.clone();
    let result =
        storage(&app, move |db| crate::agent_ws::retire_node_then(&owner, id, || db.delete_node(id))).await;
    match result {
        Ok(()) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => fail(e),
    }
}

/// Issues a fresh token, invalidating the old one immediately.
///
/// Always an explicit action: rotate a token believed to have leaked, then
/// reinstall the agent. Reading the install command does not pass through here.
///
/// Behind the same https-domain entry check as creating a node, and for the same
/// reason: this hands back a long-lived node credential in the response body, so
/// an operator who reached the panel over plain http would put it on the wire in
/// clear. Creating a node was gated from the start; this route returns the same
/// kind of secret and was not.
pub async fn reset_token(
    _: Admin,
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if !provisioning_allowed(&app, &headers) {
        return (StatusCode::FORBIDDEN, PROVISIONING_DENIED).into_response();
    }
    let token = random_token();
    let issued = token.clone();
    let exists = storage(&app, move |db| Ok(db.node(id)?.is_some())).await.unwrap_or(false);
    if !exists {
        return (StatusCode::NOT_FOUND, "no such node").into_response();
    }
    // The admin gate in `retire_node_then` serializes this rotation against
    // activation, so an upgrade that checked the old token cannot install a
    // session between the token change and the session retirement.
    let owner = app.clone();
    let result = storage(&app, move |db| {
        crate::agent_ws::retire_node_then(&owner, id, || db.reset_token(id, &issued))
    })
    .await;
    invalidate_snapshot(&app);
    match result {
        Ok(()) => {
            ([(axum::http::header::CACHE_CONTROL, "no-store")], Json(json!({"token": token}))).into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn patch_traffic(
    _: Admin,
    State(app): State<Shared>,
    Path(id): Path<i64>,
    Json(p): Json<TrafficPatch>,
) -> Response {
    if [p.total_rx, p.total_tx, p.month_rx, p.month_tx].into_iter().flatten().any(|v| v < 0) {
        return bad("traffic must be non-negative");
    }
    match storage(&app, move |db| db.set_traffic(id, &p)).await {
        Ok(true) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        Ok(false) => (StatusCode::NOT_FOUND, "no such node").into_response(),
        Err(e) => fail(e),
    }
}

pub async fn ping_tasks(_: Admin, State(app): State<Shared>) -> Response {
    match storage(&app, |db| db.ping_tasks()).await {
        Ok(tasks) => Json(json!({"tasks": tasks})).into_response(),
        Err(e) => fail(e),
    }
}

/// A probe target the agent can resolve: `host:port`, with an IPv6 literal
/// bracketed as a URL writes one.
///
/// A bare `contains(':')` admitted three forms that never connect: a bare IPv6
/// address, which is all colons; `:443` with no host; and `host:` with no port.
/// The agent's `lookup_host` errors on each, `tcp_ping` returns -1, and the chart
/// draws a probe at 100% loss indefinitely with nothing in any log identifying
/// the target as the cause.
fn valid_target(target: &str) -> bool {
    let (host, port) = match target.strip_prefix('[') {
        Some(rest) => match rest.split_once("]:") {
            Some(pair) => pair,
            None => return false,
        },
        // Unbracketed, so the last colon is the port separator; anything still
        // containing a colon is an IPv6 address that required brackets.
        None => match target.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, port),
            _ => return false,
        },
    };
    !host.is_empty() && port.parse::<u16>().is_ok_and(|p| p > 0)
}

pub async fn save_ping_task(_: Admin, State(app): State<Shared>, Json(mut task): Json<PingTask>) -> Response {
    // Trimmed into the stored value rather than a discarded copy: what reaches
    // the agent is `task.target`, and a trailing space from a paste passes
    // `valid_target` while `lookup_host` rejects the stored string outright,
    // leaving the probe reporting -1 indefinitely. The name is trimmed for the
    // same reason, as it travels to the public page as a chart label.
    task.name = task.name.trim().to_owned();
    task.target = task.target.trim().to_owned();
    if task.name.is_empty() || task.target.is_empty() {
        return bad("name and target are required");
    }
    // A TCP probe requires an explicit port; a bare host would silently never
    // connect.
    if !valid_target(&task.target) {
        return bad("target must be host:port, for example 1.1.1.1:443 or [2606:4700:4700::1111]:443");
    }
    // Refused rather than clamped, for the reason `setting_error` gives for
    // `retention_days`: the agent clamps this again on arrival, so an
    // out-of-range value never fails but silently becomes a different number
    // while the panel still displays what was entered. Below the floor that
    // number is 5 seconds, the fastest probe available, run by every node the
    // task is assigned to; the panel reaches 0 simply by having its interval
    // field cleared.
    if !(5..=3_600).contains(&task.interval) {
        return bad("interval must be from 5 to 3600 seconds");
    }
    match storage(&app, move |db| db.save_ping_task(&task)).await {
        Ok(id) => {
            agent_ws::push_ping_tasks(&app);
            Json(json!({"id": id})).into_response()
        }
        // Every failure here originates with the caller: a node id that does not
        // exist, or more probes on one node than the agent will run. The same
        // reasoning as `reorder_nodes`.
        Err(e) => bad(&e.to_string()),
    }
}

pub async fn delete_ping_task(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    match storage(&app, move |db| db.delete_ping_task(id)).await {
        Ok(()) => {
            agent_ws::push_ping_tasks(&app);
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => fail(e),
    }
}

/// Settings the panel may read. Secrets are deliberately excluded: the client can
/// set the GitHub secret but never read it back.
const READABLE_SETTINGS: &[&str] = &[
    "site_name",
    "public_page",
    "public_default_view",
    "admin_username",
    "maintenance_days",
    "online_grace_minutes",
    "geolite_url",
    "retention_days",
];

// ---- the database itself ----

/// The largest single request the two upload routes accept, and the reason they
/// sit outside the router's 64 KiB body limit. It is twice the 4 MiB the panel
/// sends, so the chunk size remains the panel's concern alone and requires no
/// negotiated handshake.
///
/// **This, not the two ceilings below, is what a reverse proxy must pass.** A
/// backup of any size arrives 4 MiB at a time, so `client_max_body_size` no
/// longer tracks the size of the database.
pub const MAX_CHUNK: usize = 8 * 1024 * 1024;

/// Whole-file ceilings, one per route, checked against the declared `total` on
/// the first request rather than by counting bytes as they arrive, so an
/// oversized upload is refused before a byte is sent.
///
/// The backup ceiling is shared with the archive validator (`db::MAX_ARCHIVE`),
/// so the HTTP limit and the storage limit cannot drift apart. Restoring copies
/// the file into a staging database and then replaces the live one; that is
/// bounded work appropriate for a small self-hosted hub.
pub const MAX_RESTORE: u64 = crate::db::MAX_ARCHIVE;

/// One request of an upload: `total` is the whole file, `offset` where this piece
/// belongs within it.
///
/// There is no upload id, session or server-side bookkeeping: the state of an
/// upload is the length of the file on disk. A piece continues an upload only if
/// it begins exactly where the last ended, `offset = 0` truncates whatever an
/// interrupted attempt left behind, and nothing is ever left to collect.
#[derive(Deserialize)]
pub struct Chunk {
    offset: u64,
    total: u64,
}

/// Appends one piece to `path`, returning the file's length afterwards; the
/// caller compares that against `total` to determine completion.
///
/// A piece lands whole or not at all -- a failure truncates back to where it
/// began -- so retrying one always aligns on the same offset.
///
/// ponytail: strictly sequential, one round trip per chunk. Concurrent pieces
/// would require pwrite, a commit step and a hash to prove there are no gaps,
/// and would save about a second on a 6.7 MB backup.
async fn receive(path: &str, chunk: &Chunk, max: u64, body: axum::body::Body) -> Result<u64, anyhow::Error> {
    if chunk.total == 0 || chunk.total > max {
        anyhow::bail!("文件必须在 1 字节到 {} MiB 之间", max / 1024 / 1024);
    }
    if chunk.offset > chunk.total {
        anyhow::bail!("分片位置越过了文件末尾");
    }

    let mut options = std::fs::OpenOptions::new();
    // Only the first piece may create the file, and it truncates: whatever an
    // interrupted upload left behind is overwritten rather than accumulated.
    if chunk.offset == 0 {
        options.write(true).create(true).truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!("这次上传已经不在了，请从头开始")
        }
        Err(e) => return Err(e.into()),
    };

    let already = file.metadata()?.len();
    if already != chunk.offset {
        anyhow::bail!("分片接不上：已经收到 {already} 字节，这一片却从 {} 开始", chunk.offset);
    }

    match append(&mut file, chunk, body).await {
        Ok(received) => Ok(chunk.offset + received),
        Err(e) => {
            // Undo a partially written piece so a retry aligns again.
            let _ = file.set_len(chunk.offset);
            Err(e)
        }
    }
}

/// Streams one request body onto the end of `file`. The byte count is checked
/// here as well as by the route's body limit: these are the only paths on the hub
/// that write a caller's bytes to disk, so they do not depend on a layer that
/// could be reordered away.
async fn append(
    file: &mut std::fs::File,
    chunk: &Chunk,
    body: axum::body::Body,
) -> Result<u64, anyhow::Error> {
    use std::io::Write;
    use std::pin::Pin;

    let mut stream = body.into_data_stream();
    let mut received = 0u64;
    while let Some(piece) =
        std::future::poll_fn(|cx| futures_core::Stream::poll_next(Pin::new(&mut stream), cx)).await
    {
        let piece = piece?;
        received += piece.len() as u64;
        if chunk.offset + received > chunk.total {
            anyhow::bail!("这一片超出了声明的文件大小");
        }
        file.write_all(&piece)?;
    }
    Ok(received)
}

/// A scratch file beside the database, so the copy lands on the same filesystem
/// the database has room on. The random component keeps two concurrent calls
/// apart, since the copy refuses an existing file.
fn scratch_path(app: &App, kind: &str) -> String {
    // Beside the database, so the copy lands on a filesystem that has room for
    // it; inside the temporary directory when the hub is in memory. See
    // `db::scratch_beside`, which is also what the restore's own scratch files
    // use -- two spellings of this rule is how the in-memory case was wrong once
    // already.
    crate::db::scratch_beside(&app.db.file(), kind)
}

/// The data page's figures.
///
/// Off the runtime, like the three routes below: `stats` counts every row of
/// `metric` and `ping_record`, which is a scan of each and grows with
/// `retention_days`. It reads a pooled connection rather than the writer's, so a
/// slow count delays other reads instead of the agents' reports -- but it is
/// still seconds of work on a large history, which is why it is not on a Tokio
/// core worker.
pub async fn db_stats(_: Admin, State(app): State<Shared>) -> Response {
    match tokio::task::spawn_blocking(move || app.db.stats()).await {
        Ok(Ok(stats)) => Json(stats).into_response(),
        Ok(Err(e)) => fail(e),
        Err(e) => fail(anyhow::anyhow!(e)),
    }
}

/// Returns a consistent, data-only archive of the whole database.
///
/// The copy is data-only (one Parquet member per persistent table plus a
/// manifest), written while a reader transaction sees one MVCC snapshot. Normal
/// telemetry keeps committing and no Agent is disconnected; only a file
/// replacement waits behind the read side of the gate. The copy is then unlinked
/// while still open, so it exists only for the duration of this response. The
/// format is documented in `db::backup`.
pub async fn db_backup(_: Admin, State(app): State<Shared>) -> Response {
    let path = scratch_path(&app, "backup");
    // Off the runtime: this reads every table inside one reader transaction and
    // only holds the read side of the replacement gate, so the archive is one
    // consistent snapshot without blocking normal writes.
    let copied = {
        let (app, path) = (app.clone(), path.clone());
        tokio::task::spawn_blocking(move || app.db.backup_into(&path)).await
    };
    if let Err(e) = copied.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
        let _ = std::fs::remove_file(&path);
        return fail(e);
    }
    let opened = tokio::fs::File::open(&path).await;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&path);
    match opened {
        Ok(file) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
                (header::CONTENT_LENGTH, size.to_string()),
                // The entire credential store: no shared cache may retain a copy.
                (header::CACHE_CONTROL, "no-store".to_owned()),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"romi-{}.tar.gz\"", Local::now().format("%Y%m%d-%H%M%S")),
                ),
            ],
            axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file)),
        )
            .into_response(),
        Err(e) => fail(e),
    }
}

/// Replaces the live database with an uploaded backup, one chunk per request.
///
/// The upload streams to a file beside the database and is validated in full
/// before a single page is copied; see `Db::check_backup`. The archive contains
/// no session rows and the staging database starts with an empty `session`
/// table, so restoring cannot revive a login that was revoked after the archive
/// was taken. The caller is issued a fresh session after the switch.
pub async fn db_restore(
    _: Admin,
    State(app): State<Shared>,
    Query(chunk): Query<Chunk>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    // One fixed path, which is what allows the file's own length to constitute
    // the entire protocol.
    // ponytail: one upload in flight per hub. Two started simultaneously land on
    // this same name, and equal-sized chunks align their offsets, so they splice
    // rather than collide. The cost is a failed upload; distinguishing them would
    // require the upload id the protocol deliberately omits.
    let path = format!("{}.upload", app.db.file());
    let received = match receive(&path, &chunk, MAX_RESTORE, body).await {
        Ok(received) => received,
        Err(e) => return bad(&format!("{e:#}")),
    };
    if received < chunk.total {
        return Json(json!({"received": received})).into_response();
    }

    // Moved off the upload name before a byte is read. Splicing costs an upload;
    // what it must not cost is the live database, which without this it could:
    // the other upload would continue appending through its own handle while
    // the archive is validated and the staging database is built, and a file
    // that passed every gate could then be copied over in a different state.
    // Afterwards the other upload's next chunk finds nothing and is told to
    // restart, which is the error it already has for an upload that disappeared.
    //
    // ponytail: the rename itself is not covered by a test. What it changes is
    // which path is open during the read, and reaching that would require a
    // second upload landing inside the copy. What is verified afterwards is that
    // neither name is left behind, in
    // `a_finished_restore_leaves_no_scratch_file_behind`.
    let source = scratch_path(&app, "restoring");
    if let Err(e) = std::fs::rename(&path, &source) {
        let _ = std::fs::remove_file(&path);
        return bad(&format!("上传收齐了却取不到文件：{e}"));
    }

    let outcome = restore(&app, &source).await;
    let _ = std::fs::remove_file(&source);
    match outcome {
        Ok(report) => {
            // Agents authenticate at the handshake, and the tokens they hold may
            // now belong to different nodes, or to none. Dropping the senders ends
            // those loops; each reconnects against the restored database.
            invalidate_snapshot(&app);
            let cookie = match issue_session(&app, &headers) {
                Ok(cookie) => cookie,
                Err(e) => return fail(e),
            };
            with_cookies(Json(json!({"ok": true, "restored": report})), [cookie])
        }
        Err(e) => bad(&format!("{e:#}")),
    }
}

/// Validates the upload and, only once it is a complete database, switches to it.
///
/// The whole thing is one storage call: validating a 256 MiB upload is not
/// runtime work, the rebuild reads and writes the whole file, and the switch
/// itself closes and reopens every connection. `retire_all_then` pauses every
/// connected session and lets its in-flight report finish before the file is
/// replaced, so no old agent write can outlive the restore. The archive carries
/// no session rows and the staging database starts with an empty session table,
/// so the restored data cannot revive a logged-out login.
async fn restore(app: &Shared, path: &str) -> Result<crate::db::BackupReport, anyhow::Error> {
    let (app, source) = (app.clone(), path.to_owned());
    tokio::task::spawn_blocking(move || {
        crate::agent_ws::retire_all_then(&app, || app.db.restore_from(&source))
    })
    .await?
}

/// Drops history beyond the retention window, checkpoints, and rewrites the file
/// when DuckDB reports enough reusable space to justify a copy.
///
/// The operation reports what was actually returned to the filesystem --
/// measured, not estimated -- and says whether the file was rewritten at all.
pub async fn db_maintenance(_: Admin, State(app): State<Shared>) -> Response {
    let keep = app.db.retention_days();
    let app = app.clone();
    let done = tokio::task::spawn_blocking(move || app.db.maintenance(keep)).await;
    match done.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
        Ok(result) => Json(json!({
            "pruned": result.pruned,
            "freed": result.freed,
            "reusable": result.reusable,
            "compacted": result.compacted,
            "size": result.size,
        }))
        .into_response(),
        Err(e) => fail(e),
    }
}

/// Every live session, with the caller's own marked.
///
/// `id` is the stored SHA-256 of the session token rather than the token itself:
/// it identifies a row without being presentable as a cookie.
pub async fn sessions(_: Admin, State(app): State<Shared>, headers: HeaderMap) -> Response {
    let mine = current_session(&headers);
    match storage(&app, |db| db.sessions()).await {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(hash, expires_at)| {
                    json!({
                        "current": mine.as_deref() == Some(hash.as_str()),
                        "created_at": issued_at(expires_at),
                        "id": hash,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => fail(e),
    }
}

/// Deleting a row that no longer exists is not an error: two panels open on the
/// same list both achieve the requested sign-out.
pub async fn delete_session(_: Admin, State(app): State<Shared>, Path(id): Path<String>) -> Response {
    match storage(&app, move |db| db.drop_session(&id)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

pub async fn settings(_: Admin, State(app): State<Shared>) -> Json<Value> {
    let mut out = serde_json::Map::new();
    for key in READABLE_SETTINGS {
        out.insert((*key).to_owned(), json!(app.db.get(key).unwrap_or_default()));
    }
    for (key, default) in [
        ("admin_username", "admin"),
        ("maintenance_days", "0"),
        ("online_grace_minutes", "5"),
        ("public_default_view", "cards"),
    ] {
        out.insert(key.into(), json!(app.db.get(key).unwrap_or_else(|| default.into())));
    }
    // The one readable key with a default that also rejects the empty string:
    // `setting_error` below refuses "" and `save_settings` writes nothing when any
    // key fails, so a hub where this was never set returned "" here and then
    // rejected the entire settings form, naming a field that was never edited.
    // `retention_days()` already holds the default `prune` and the data page read,
    // so it answers here as well.
    out.insert("retention_days".into(), json!(app.db.retention_days().to_string()));
    // Read-only here. A window is opened and closed through its own route, so the
    // key is always one the hub generated, and `save_settings` continues to refuse
    // both names.
    for key in ["register_key", "register_until"] {
        out.insert(key.into(), json!(app.db.get(key).unwrap_or_default()));
    }
    crate::notify::settings(&app, &mut out);
    Json(Value::Object(out))
}

/// Why one setting cannot be stored, or `None` when it can.
///
/// Separate from the write below because every key is validated before any is
/// written: changing the password drops every session, and a 400 raised
/// afterwards -- on a later key, in whatever order the map iterates -- carries no
/// Set-Cookie, signing the admin out of every device through a password change
/// the UI reported as rejected.
fn setting_error(_app: &App, key: &str, value: &Value) -> Option<String> {
    // Settings are stored as text. A caller sending the natural JSON type --
    // `{"public_page": false}`, `{"retention_days": 7}` -- was formerly skipped by
    // a bare `continue`, so nothing was written while the response reported
    // success.
    let Some(value) = value.as_str() else { return Some(format!("{key} must be a string")) };
    match key {
        "public_default_view" if !matches!(value, "cards" | "list") => {
            Some("public default view must be cards or list".into())
        }
        "public_page" if !matches!(value, "on" | "off") => Some(format!("{key} must be on or off")),

        // Housekeeping clamps whatever it reads, so an unparsable value would be
        // stored, echoed back, and silently mean 7 days indefinitely.
        "retention_days" if !value.parse::<i64>().is_ok_and(|d| (1..=3_650).contains(&d)) => {
            Some("retention days must be a number from 1 to 3650".into())
        }
        "admin_username"
            if value.is_empty()
                || value.len() > 64
                || !value.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) =>
        {
            Some("account must contain 1-64 letters, digits, dots, underscores or hyphens".into())
        }
        "maintenance_days" if !matches!(value, "0" | "7" | "30" | "90" | "180") => {
            Some("invalid maintenance period".into())
        }
        "online_grace_minutes" if !value.parse::<u32>().is_ok_and(|n| (1..=60).contains(&n)) => {
            Some("online grace must be 1-60 minutes".into())
        }
        "geolite_url" if !value.is_empty() && !crate::geo::valid_url(value) => {
            Some("GeoLite URL must be an HTTPS URL without credentials".into())
        }
        "admin_password" if value.len() < 12 => Some("password must be at least 12 characters".into()),
        "admin_password" => None,
        // Consumed by `save_settings`, never stored: it is the proof that the
        // caller knows the password they are replacing.
        CURRENT_PASSWORD if value.is_empty() => Some("current password is required".into()),
        CURRENT_PASSWORD => None,
        k if k.starts_with("notify_") => crate::notify::setting_error(k, value),
        k if READABLE_SETTINGS.contains(&k) => None,
        _ => Some(format!("unknown setting: {key}")),
    }
}

/// Field carrying the caller's existing password. Verified and discarded; it is
/// never written to `setting`.
const CURRENT_PASSWORD: &str = "current_password";

/// Settings whose change has to be proven with the current password.
///
/// Both of them are the credential itself: together they are the whole local
/// sign-in. A session is not proof of the password -- one left open on an
/// unattended machine, or lifted from a browser, would otherwise be enough to
/// lock the operator out of their own hub.
const CREDENTIAL_SETTINGS: [&str; 2] = ["admin_password", "admin_username"];

pub async fn save_settings(
    _: Admin,
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(map) = body.as_object() else { return bad("expected an object") };
    for (key, value) in map {
        if let Some(message) = setting_error(&app, key, value) {
            return bad(&message);
        }
    }
    // Before anything is written, and before the expensive verification below,
    // so a patch that changes a credential without offering proof costs nothing.
    if map.keys().any(|key| CREDENTIAL_SETTINGS.contains(&key.as_str())) {
        let Some(offered) = map.get(CURRENT_PASSWORD).and_then(Value::as_str) else {
            return (StatusCode::BAD_REQUEST, "current password is required").into_response();
        };
        // The same gate the sign-in page holds: argon2 saturates a core, and
        // this route is reachable by anyone holding a session.
        let Ok(_permit) = app.password_gate.try_acquire() else {
            return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, try again later").into_response();
        };
        if !crate::auth::password_matches(&app, offered) {
            return (StatusCode::FORBIDDEN, "current password is incorrect").into_response();
        }
    }
    // Set when the password changed, so the caller receives a fresh session rather
    // than being logged out by their own change.
    // Owned before the first await: the request body is borrowed by `map`, and a
    // reference into it cannot cross into a blocking task.
    // The proof is dropped here: it was verified above and has no stored form.
    let entries: Vec<(String, String)> = map
        .iter()
        .filter(|(key, _)| key.as_str() != CURRENT_PASSWORD)
        .map(|(key, value)| (key.clone(), value.as_str().unwrap_or_default().to_owned()))
        .collect();
    let mut reissued = String::new();
    for (key, value) in entries {
        if key == "maintenance_days" {
            if let Err(e) = app.db.set("maintenance_last", &Utc::now().timestamp().to_string()) {
                return fail(e);
            }
        }
        // Changing the password logs out every existing session; the caller
        // receives a replacement.
        if key == "admin_password" || key == "admin_username" {
            let changed = storage(&app, move |db| {
                if key == "admin_password" {
                    let h = hash_password(&value)?;
                    db.set("admin_password_hash", &h)?;
                } else {
                    db.set("admin_username", &value)?;
                }
                db.drop_all_sessions()
            })
            .await;
            match changed.and_then(|()| issue_session(&app, &headers)) {
                Ok(cookie) => {
                    // The operator has chosen a password; the one-time
                    // bootstrap file has served its purpose and must not
                    // remain on disk.
                    app.discard_bootstrap_credential();
                    reissued = cookie;
                }
                Err(e) => return fail(e),
            }
            continue;
        }
        if let Err(e) = storage(&app, move |db| db.set(&key, &value)).await {
            return fail(e);
        }
    }
    invalidate_snapshot(&app);
    with_cookies(Json(json!({"ok": true})), [reissued])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::sha256;
    use crate::db::Db;

    fn domain_headers() -> HeaderMap {
        HeaderMap::from_iter([
            (header::HOST, "monitor.example.com".parse().unwrap()),
            (header::HeaderName::from_static("x-forwarded-proto"), "https".parse().unwrap()),
        ])
    }

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    #[test]
    fn v7_metadata_bounds_reject_invalid_priority_and_bandwidth() {
        assert!(valid_expiry("2024-02-29"));
        for date in ["2023-02-29", "2024-2-01", "0000-01-01", ""] {
            assert!(!valid_expiry(date));
        }
        assert!(metadata_error(Some(0), Some(0.0), Some(1_000_000.0)).is_none());
        assert!(metadata_error(Some(999999), None, None).is_none());
        for p in [-1, 1000000] {
            assert!(metadata_error(Some(p), None, None).is_some());
        }
        for b in [-1.0, f64::NAN, f64::INFINITY, 1_000_001.0] {
            assert!(metadata_error(None, Some(b), None).is_some());
        }
        assert!(serde_json::from_value::<NodePatch>(json!({"priority":1.5})).is_err());
    }

    #[tokio::test]
    async fn private_defaults_and_theme_denials_are_enforced_at_the_api() {
        let app = std::sync::Arc::new(app());
        assert!(!app.public_page());
        assert_eq!(nodes(State(app.clone()), HeaderMap::new()).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(stream_audience(&app, None), None);
        {
            let key = "public_page";
            assert!(setting_error(&app, key, &json!("yes")).is_some());
            assert!(setting_error(&app, key, &json!("on")).is_none());
            assert!(setting_error(&app, key, &json!("off")).is_none());
        }
        let created = create_node(
            Admin,
            State(app.clone()),
            domain_headers(),
            Ok(Json(serde_json::from_value(json!({"name": "private"})).unwrap())),
        )
        .await;
        assert_eq!(created.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let body = axum::body::to_bytes(created.into_body(), 4096).await.unwrap();
        let issued: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(app.db.node_by_token(issued["token"].as_str().unwrap()).unwrap(), issued["id"].as_i64());
        assert!(app.db.node(issued["id"].as_i64().unwrap()).unwrap().unwrap().public);
    }

    #[tokio::test]
    async fn provisioning_requires_the_current_https_domain_entry() {
        let no_site = app();
        let mut state = app();
        state.site = "https://monitor.example.com".into();
        let app = std::sync::Arc::new(state);
        let good = domain_headers();
        assert!(provisioning_allowed(&app, &good));
        let mut plain = good.clone();
        plain.insert("x-forwarded-proto", "http".parse().unwrap());
        assert!(
            !provisioning_allowed(&app, &plain),
            "--site cannot override an explicitly plaintext request"
        );
        for host in ["127.0.0.1:9911", "[::1]:9911", "198.51.100.1", "2130706433", "localhost"] {
            let mut headers = good.clone();
            headers.insert(header::HOST, host.parse().unwrap());
            let node = serde_json::from_value(json!({"name":"blocked"})).unwrap();
            assert_eq!(
                create_node(Admin, State(app.clone()), headers.clone(), Ok(Json(node))).await.status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                open_register(Admin, State(app.clone()), headers.clone()).await.status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                agent_register(
                    State(app.clone()),
                    ConnectInfo("127.0.0.1:1".parse().unwrap()),
                    headers,
                    "blocked".into()
                )
                .await
                .status(),
                StatusCode::FORBIDDEN
            );
        }
        let mut headers = good.clone();
        headers.insert(header::ORIGIN, "http://127.0.0.1:9911".parse().unwrap());
        assert!(!provisioning_allowed(&app, &headers));
        assert!(app.db.nodes().unwrap().is_empty());
        assert!(app.db.get("register_key").is_none());
        headers = good;
        headers.remove("x-forwarded-proto");
        assert!(!provisioning_allowed(&no_site, &headers));
        for site in [
            "http://monitor.example.com",
            "https://198.51.100.1",
            "https://user@monitor.example.com",
            "https://monitor.example.com/path",
        ] {
            assert!(https_domain(site).is_none());
        }
    }

    /// Whatever this accepts is pushed to every assigned agent and passed directly
    /// to `lookup_host`. Forms it cannot resolve return -1 indefinitely, which the
    /// chart draws as a probe losing every packet, so the check must match what
    /// the error message claims.
    #[test]
    fn a_probe_target_must_be_something_the_agent_can_resolve() {
        // Each of these causes `lookup_host` to return an error, verified against
        // it: a bare IPv6 address is all colons, and the other two omit the half
        // the message requires.
        for bad in
            ["2606:4700:4700::1111", ":443", "example.com:", "1.1.1.1", "1.1.1.1:0", "[::1]:x", "[::1]"]
        {
            assert!(!valid_target(bad), "{bad}");
        }
        for good in ["1.1.1.1:443", "[2606:4700:4700::1111]:443", "example.com:80", "[::1]:1"] {
            assert!(valid_target(good), "{good}");
        }
    }

    /// The check above is meaningful only if it runs on the stored string: what
    /// reaches the agent is the stored value, and `lookup_host` rejects
    /// `"1.1.1.1:443 "` outright -- the permanent -1 `valid_target` exists to
    /// prevent, reachable through a check that passed.
    #[tokio::test]
    async fn a_probe_target_is_stored_as_the_string_that_was_checked() {
        let app = std::sync::Arc::new(app());
        let save = |name: &str, target: &str| {
            let task = PingTask {
                id: 0,
                name: name.to_owned(),
                target: target.to_owned(),
                interval: 60,
                nodes: vec![],
            };
            save_ping_task(Admin, State(app.clone()), Json(task))
        };
        assert_eq!(save(" 探测 ", "1.1.1.1:443 ").await.status(), StatusCode::OK);
        let stored = &app.db.ping_tasks().unwrap()[0];
        assert_eq!(stored.target, "1.1.1.1:443", "the agent gets this string, not the one that was checked");
        assert_eq!(stored.name, "探测", "and it labels an anonymous chart");
        // Trimming must not turn a blank entry into a saved row.
        assert_eq!(save("   ", "   ").await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.ping_tasks().unwrap().len(), 1);
    }

    /// The same rule as `retention_days`, applied to the other value this hub
    /// clamps downstream: an out-of-range value must fail, or it silently becomes
    /// a different one. Below the floor that value is 5 seconds, the fastest probe
    /// available, and the panel reaches 0 simply by clearing its interval field,
    /// since `Number("")` is 0.
    #[tokio::test]
    async fn a_probe_interval_out_of_range_is_refused_rather_than_clamped() {
        let app = std::sync::Arc::new(app());
        let save = |interval| {
            let task = PingTask {
                id: 0,
                name: "probe".into(),
                target: "1.1.1.1:443".into(),
                interval,
                nodes: vec![],
            };
            save_ping_task(Admin, State(app.clone()), Json(task))
        };
        for refused in [0, -1, 4, 3_601, i64::MAX] {
            assert_eq!(save(refused).await.status(), StatusCode::BAD_REQUEST, "{refused}");
        }
        assert!(app.db.ping_tasks().unwrap().is_empty(), "a refused interval must not store a probe");

        // Both ends of the range still save, storing exactly what was sent.
        for ok in [5, 60, 3_600] {
            assert_eq!(save(ok).await.status(), StatusCode::OK, "{ok}");
        }
        let stored: Vec<i64> = app.db.ping_tasks().unwrap().iter().map(|t| t.interval).collect();
        assert_eq!(stored, vec![5, 60, 3_600]);
    }

    /// The entire chunked-upload protocol: an upload is only ever as long as what
    /// has landed, so a piece continues it, restarts it, or is refused.
    #[tokio::test]
    async fn a_chunk_continues_an_upload_only_where_the_last_one_ended() {
        let path = std::env::temp_dir().join(format!("monitor-chunk-{}", std::process::id()));
        let path = path.to_str().unwrap();
        let piece = |offset, total| Chunk { offset, total };
        let body = |bytes: &'static [u8]| axum::body::Body::from(bytes);

        // Two pieces in order, with the length indicating where the next begins.
        assert_eq!(receive(path, &piece(0, 6), 1024, body(b"abc")).await.unwrap(), 3);
        assert_eq!(receive(path, &piece(3, 6), 1024, body(b"def")).await.unwrap(), 6);
        assert_eq!(std::fs::read(path).unwrap(), b"abcdef");

        // A gap, a rewind and an overshoot all produce the same refusal.
        assert!(receive(path, &piece(9, 12), 1024, body(b"xyz")).await.is_err());
        assert!(receive(path, &piece(3, 12), 1024, body(b"xyz")).await.is_err());
        assert!(receive(path, &piece(6, 7), 1024, body(b"toolong")).await.is_err());
        // None of them modified the file, so the upload can continue.
        assert_eq!(std::fs::metadata(path).unwrap().len(), 6);

        // The ceiling is checked against the declared total, before any bytes
        // arrive.
        assert!(receive(path, &piece(0, 4096), 1024, body(b"a")).await.is_err());
        assert!(receive(path, &piece(0, 0), 1024, body(b"")).await.is_err());

        // Starting over truncates whatever an interrupted attempt left behind.
        assert_eq!(receive(path, &piece(0, 2), 1024, body(b"hi")).await.unwrap(), 2);
        assert_eq!(std::fs::read(path).unwrap(), b"hi");
        std::fs::remove_file(path).unwrap();
    }

    /// Both scratch names a restore uses sit beside the live database, and one left
    /// behind is what the next upload fails on: `receive` refuses a first chunk
    /// that does not align with an existing file.
    ///
    /// This does not cover the rename in `db_restore`, which changes which path is
    /// open during the copy and would require a second upload landing inside it.
    /// It covers the part that outlives the request, which is what a later edit
    /// could silently drop.
    #[tokio::test]
    async fn a_finished_restore_leaves_no_scratch_file_behind() {
        let dir = std::env::temp_dir().join(format!("monitor-restore-{}", &random_token()[..16]));
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("live.db").to_string_lossy().into_owned();
        let app = std::sync::Arc::new(App::for_test(Db::open(&live).unwrap()));
        node(&app, "kept", true);

        // What a restore actually receives: a backup of a hub database.
        let copy = format!("{live}.copy");
        app.db.backup_into(&copy).unwrap();
        let bytes = std::fs::read(&copy).unwrap();
        std::fs::remove_file(&copy).unwrap();

        let done = db_restore(
            Admin,
            State(app.clone()),
            Query(Chunk { offset: 0, total: bytes.len() as u64 }),
            HeaderMap::new(),
            axum::body::Body::from(bytes),
        )
        .await;
        assert_eq!(done.status(), StatusCode::OK);
        assert_eq!(app.db.nodes().unwrap().len(), 1, "the backup went in");

        // The database and the files DuckDB keeps beside it -- its write-ahead
        // log, its spill directory and the lock -- are the only ones that may
        // remain.
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|name| {
                !matches!(name.as_str(), "live.db" | "live.db.wal" | "live.db.tmp" | "live.db.lock")
            })
            .collect();
        assert!(left.is_empty(), "left beside the database: {left:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A connected agent holding one report. The receiver is returned because
    /// dropping it closes the channel, which is the signal `reset_token` is tested
    /// for.
    fn connect(app: &App, id: i64, metrics: Value) -> tokio::sync::mpsc::Receiver<String> {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let agent = crate::agent_ws::Agent::new(7, tx);
        {
            let mut state = agent.lock_state();
            state.metrics = metrics;
            state.last_seen = Utc::now().timestamp();
            agent.publish(&state);
        }
        app.agents.write().unwrap().insert(id, std::sync::Arc::new(agent));
        rx
    }

    /// A probe assigned to `nodes`. The window query draws only a node's current
    /// assignments, so a fixture holding ping records requires one.
    fn task(app: &App, nodes: Vec<i64>) -> i64 {
        app.db
            .save_ping_task(&PingTask {
                id: 0,
                name: "probe".into(),
                target: "1.1.1.1:443".into(),
                interval: 60,
                nodes,
            })
            .unwrap()
    }

    fn node(app: &App, name: &str, public: bool) -> i64 {
        app.db
            .create_node(
                &Node { name: name.into(), public, remark: "secret note".into(), ..Default::default() },
                &format!("token-of-{name}"),
            )
            .unwrap()
    }

    /// A chart request costs roughly the same whatever it spans. This path
    /// requires no session, so an unbounded window would let any caller force
    /// unnecessarily wide storage scans and megabytes of JSON construction.
    #[test]
    fn a_history_window_costs_the_same_however_wide_it_is() {
        let app = app();
        let id = node(&app, "n", true);
        let now = Utc::now().timestamp();
        // Two days of history at the rate the hub writes it. Two probes, because
        // the budget is per series and a single-probe fixture would conceal that.
        //
        // ponytail: two days rather than a month. What the budget bounds is the
        // step, not the window, and the assertions below are about rows returned
        // for a window rather than about how much history exists; the fixture only
        // has to be longer than the widest window that divides evenly.
        const PROBES: i64 = 2;
        for _ in 0..PROBES {
            task(&app, vec![id]);
        }
        for i in 0..2 * 1440 {
            app.db.insert_metric(id, now - i * 60, &json!({"cpu": 1.0})).unwrap();
            for task in 1..=PROBES {
                app.db.insert_ping(id, task, now - i * 20, 42).unwrap();
            }
        }

        // Including windows that do not divide evenly, which are where a step
        // rounded the wrong way overruns.
        for hours in [1, 6, 13, 23, 24, 168, 2_160] {
            let step = sample_step(hours, None);
            let since = now - hours * 3_600;
            let metrics = app.db.metrics(id, since, step).unwrap();
            let (ping, _) = app.db.ping_records(id, since, step).unwrap();
            // Against the budget itself rather than whatever the step produced:
            // derived from the step, this would only demonstrate that division
            // works. One bucket of slack, as the window rarely divides evenly.
            let cap = 1_441;
            assert!(metrics.len() <= cap, "{hours}h returned {} metric rows", metrics.len());
            assert!(
                ping.len() <= cap * PROBES as usize,
                "{hours}h returned {} ping rows for {PROBES} probes",
                ping.len()
            );
            // Thinned, but neither empty nor reaching outside the window.
            assert!(!metrics.is_empty() && !ping.is_empty(), "{hours}h returned nothing");
            // A bucket the window opens partway through begins before it.
            assert!(
                metrics.iter().all(|m| m["ts"].as_i64().unwrap() >= since - step),
                "{hours}h reached back too far"
            );
        }
        // The widest window costs no more than a narrow one: unthinned, the
        // fixture's 2,880 minutes are what a ninety-day window would try to draw.
        assert!(app.db.metrics(id, now - 2_160 * 3_600, sample_step(2_160, None)).unwrap().len() <= 1_441);

        // A day returns every minute it holds: thinning exists only for what the
        // screen cannot draw.
        assert_eq!(sample_step(24, Some(2_000)), 60, "a day of minutes fits under the ceiling");
        assert_eq!(sample_step(6, Some(2_000)), 60, "and so does six hours");

        // A caller may request less than the budget, never more: the ceiling
        // belongs to the hub, since this path takes no credentials.
        assert!(sample_step(24, Some(390)) > sample_step(24, None));
        assert_eq!(sample_step(24, Some(100_000)), sample_step(24, None));
        assert_eq!(sample_step(24, Some(0)), sample_step(24, Some(60)));

        // Requesting one half leaves the other empty rather than sending it: on
        // the day window that half was two thirds of the response.
        let series = |q: &str| serde_urlencoded::from_str::<Window>(q).unwrap().series;
        assert_eq!(series("hours=24&series=ping").as_deref(), Some("ping"));
        assert!(series("hours=24").is_none(), "no series means both, which is what curl gets");
    }

    /// What a thinned bucket may return. Keeping one row and discarding the rest
    /// made the seven-day chart integrate to twice the traffic the minutes hold,
    /// and drew a probe losing half its packets as an unbroken line.
    #[test]
    fn a_thinned_bucket_answers_with_its_mean_and_says_what_it_lost() {
        let app = app();
        let id = node(&app, "n", true);
        // Anchored on a bucket boundary, one whole bucket in the past. Anchored on
        // `now`, the rows would straddle the boundary depending on the second the
        // suite runs at.
        let base = Utc::now().timestamp() / 120 * 120 - 120;
        // One bucket: a quiet minute and a busy one, then a probe that answered
        // once and timed out three times.
        app.db.insert_metric(id, base + 10, &json!({"cpu": 0.0, "net_rx": 0})).unwrap();
        app.db.insert_metric(id, base + 70, &json!({"cpu": 40.0, "net_rx": 1_000})).unwrap();
        for _ in 0..3 {
            task(&app, vec![id]);
        }
        for (i, latency) in [30, -1, -1, -1].into_iter().enumerate() {
            app.db.insert_ping(id, 1, base + 10 + i as i64 * 20, latency).unwrap();
        }
        // A second probe that never answered, and a third that answered cleanly.
        app.db.insert_ping(id, 2, base + 10, -1).unwrap();
        app.db.insert_ping(id, 3, base + 10, 12).unwrap();

        let m = &app.db.metrics(id, base, 120).unwrap()[0];
        assert_eq!(m["cpu"], 20.0, "the bucket is its mean, not one row of it");
        assert_eq!(m["net_rx"], 500);
        assert_eq!(m["ts"], base, "stamped with the bucket, so every series shares a grid");

        // Keyed by task rather than index: the rows share a timestamp, so
        // their relative order within the timestamp is not part of the contract.
        let (rows, window_loss) = app.db.ping_records(id, base, 120).unwrap();
        let probe = |task: i64| {
            rows.iter().find(|r| r["task_id"] == task).unwrap_or_else(|| panic!("no probe {task}"))
        };
        assert_eq!(probe(1)["latency"], 30, "the median of what answered, not of the timeouts");
        assert_eq!(probe(1)["loss"], 75);
        assert_eq!(probe(2)["latency"], json!(null), "a bucket that was all timeout has no latency");
        assert_eq!(probe(2)["loss"], 100);
        // One answer, so there is nothing for a band to span.
        assert!(probe(1).get("band").is_none(), "{:?}", probe(1));
        // A clean bucket carries no loss key, which is why the percentage rounds
        // up: the key's absence denotes no loss, so no loss must be the only way
        // to produce it.
        assert!(probe(3).get("loss").is_none(), "{:?}", probe(3));
        // Each probe has one bucket here, so the window and bucket figures agree
        // -- precisely the fixture shape that concealed the difference between
        // them. The test below separates the two.
        assert_eq!(window_loss["2"], 100.0);
        assert!(window_loss.get("3").is_none(), "a probe that lost nothing is left out");

        // One timeout in a bucket too large for it to reach a whole percent:
        // truncating would report the same as a clean bucket.
        let wide = node(&app, "wide", true);
        let wide_probe = task(&app, vec![wide]);
        let wide_base = base / 180 * 180;
        for i in 0..180 {
            app.db.insert_ping(wide, wide_probe, wide_base + i, if i == 0 { -1 } else { 20 }).unwrap();
        }
        let (rows, _) = app.db.ping_records(wide, wide_base, 180).unwrap();
        assert_eq!(rows.len(), 1, "the fixture has to be one bucket for this to mean anything");
        let row = &rows[0];
        assert_eq!(row["loss"], 1, "a bucket that lost one of 180 has not lost none");

        // What the band conveys: the median reading and the two extremes the
        // bucket reached. Drawing 20 alone would render a 40 ms swing as a flat
        // point.
        let jitter = node(&app, "jitter", true);
        let jitter_probe = task(&app, vec![jitter]);
        for (i, latency) in [10, 20, 50, 20, 20].into_iter().enumerate() {
            app.db.insert_ping(jitter, jitter_probe, wide_base + i as i64, latency).unwrap();
        }
        let row = &app.db.ping_records(jitter, wide_base, 180).unwrap().0[0];
        assert_eq!(row["latency"], 20, "the middle answer, not the mean of 24");
        assert_eq!(row["band"], json!([10, 50]));

        // An even count has no single middle value, so it is the mean of the two
        // straddling it. Every neighbouring pair differs, so selecting one rank
        // either way would yield 20 or 30 rather than 25.
        let even = node(&app, "even", true);
        let even_probe = task(&app, vec![even]);
        for (i, latency) in [40, 10, 30, 20].into_iter().enumerate() {
            app.db.insert_ping(even, even_probe, wide_base + i as i64, latency).unwrap();
        }
        assert_eq!(app.db.ping_records(even, wide_base, 180).unwrap().0[0]["latency"], 25);
    }

    /// What a window lost is the proportion of its samples lost, and only the hub
    /// can determine it: `close_bucket` divides within each bucket and keeps the
    /// quotient, so the denominators are gone by the time a reader sees the rows.
    /// Averaging the bucket percentages would weight a bucket holding one sample
    /// equally with one holding twelve, and unequal buckets are the ordinary case
    /// rather than an edge one. The window's first and last are partial by
    /// construction, and a probe that starts, stops, loses its node or skips a
    /// round on a slow resolver produces more.
    #[test]
    fn a_probe_reports_the_share_of_the_window_it_lost_not_the_mean_of_its_buckets() {
        let app = app();
        let id = node(&app, "n", true);
        let probe = task(&app, vec![id]);
        let base = Utc::now().timestamp() / 60 * 60 - 120;
        // A full minute at five seconds per round with no loss, then a minute
        // holding one sample, which was lost, before the probe stopped.
        for i in 0..12 {
            app.db.insert_ping(id, probe, base + i * 5, 20).unwrap();
        }
        app.db.insert_ping(id, probe, base + 60, -1).unwrap();

        let (rows, loss) = app.db.ping_records(id, base, 60).unwrap();
        let per_bucket: Vec<i64> = rows.iter().map(|r| r["loss"].as_i64().unwrap_or(0)).collect();
        assert_eq!(per_bucket, vec![0, 100], "the buckets are right about themselves");

        // Their mean is 50%, while one round of thirteen did not answer.
        let window = loss.get(probe.to_string()).and_then(|v| v.as_f64()).expect("this probe lost one");
        assert!((window - 100.0 / 13.0).abs() < 1e-9, "{window}");
        assert!(window < 8.0, "the window lost {window}%, not the 50% its buckets average to");
    }

    #[test]
    fn the_public_view_hides_private_nodes_and_sensitive_fields() {
        let app = app();
        let open = node(&app, "open", true);
        node(&app, "hidden", false);
        app.db.save_facts(open, &json!({"hostname": "vps-1"}), "198.51.100.9").unwrap();

        // A live report, so the public view has metrics to strip. `hostname` is
        // what a node token in the wrong hands can insert, and what the agent
        // repository could add to the contract.
        let _held = connect(
            &app,
            open,
            json!({"boot_id": "abc", "net_rx_total": 134_000_000_000i64, "cpu": 1.0,
                   "hostname": "db-prod-01", "ip": "203.0.113.7"}),
        );

        let public = visible_nodes(&app, false).unwrap();
        assert_eq!(public.len(), 1, "a node marked private must not be listed");
        assert_eq!(public[0]["name"], "open");
        // Disclosing the token would let any visitor impersonate the node.
        for hidden in ["ip", "remark", "hostname", "token"] {
            assert!(public[0].get(hidden).is_none(), "{hidden} must not be public");
        }
        assert!(
            !serde_json::to_string(&public).unwrap().contains("token-of-open"),
            "no node's token may appear anywhere in a public payload"
        );
        // Raw kernel counters would disclose the machine's lifetime traffic, and
        // anything the contract does not name is not published at all, the report
        // coming from a machine holding one node's token.
        for hidden in ["boot_id", "net_rx_total", "net_tx_total", "hostname", "ip"] {
            assert!(public[0]["metrics"].get(hidden).is_none(), "{hidden} must not be public");
        }
        assert_eq!(public[0]["metrics"]["cpu"], 1.0, "the rest of the report still goes out");

        let admin = visible_nodes(&app, true).unwrap();
        assert_eq!(admin.len(), 2);
        for n in &admin {
            assert!(n.get("token").is_none() && n.get("token_hash").is_none());
        }
        assert!(!live_snapshot(&app, true).as_str().contains("token-of-open"));
        assert_eq!(admin[0]["ip"], "198.51.100.9");
        assert_eq!(admin[0]["remark"], "secret note");
    }

    #[tokio::test]
    async fn rotating_a_token_closes_the_session_the_old_one_opened() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        let mut rx = connect(&app, id, Value::Null);

        let response =
            reset_token(Admin, axum::extract::State(app.clone()), domain_headers(), Path(id)).await;
        assert_eq!(response.status(), StatusCode::OK);
        // The agent loop selects on this receiver, so a closed channel is how it
        // learns to stop. `try_recv`, because `recv().await` on a channel
        // incorrectly left open would hang the suite rather than fail it.
        assert!(
            matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)),
            "the old agent's channel must be closed"
        );
        assert!(app.agents.read().unwrap().is_empty(), "the node must read as offline at once");
    }

    /// Rotation hands back a long-lived node credential, so it is gated exactly
    /// like creating a node: an operator on a plain-http entry point would put
    /// the new token on the wire in clear.
    #[tokio::test]
    async fn rotating_a_token_requires_the_https_domain_entry() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        let plain = HeaderMap::from_iter([(header::HOST, "198.51.100.7:28080".parse().unwrap())]);

        let response = reset_token(Admin, axum::extract::State(app.clone()), plain, Path(id)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            app.db.node_by_token("token-of-n").unwrap(),
            Some(id),
            "a refused rotation must leave the existing token working"
        );
    }

    /// Deleting a node must reach the connection it opened, for the same reason
    /// rotating its token does: the allocator never reissues the deleted id, so
    /// a left-connected old machine would keep writing rows for an id that no
    /// longer exists (or, after some future schema change, for whatever row a
    /// new allocation happened to receive).
    #[tokio::test]
    async fn deleting_a_node_closes_its_session_so_the_next_id_does_not_inherit_it() {
        let app = std::sync::Arc::new(app());
        let old = node(&app, "old", true);
        let mut rx = connect(&app, old, json!({"cpu": 42.0}));

        assert_eq!(
            delete_node(Admin, axum::extract::State(app.clone()), Path(old)).await.status(),
            StatusCode::OK
        );
        assert!(
            matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)),
            "the deleted node's agent must be told to go"
        );

        // The new node receives a fresh id -- the allocator never reissues one --
        // and nothing of the old machine may accompany it either way.
        let fresh = node(&app, "fresh", true);
        assert_ne!(fresh, old, "a deleted node's id is not handed out again");
        let nodes = visible_nodes(&app, true).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["online"], json!(false), "a node nobody deployed is not online");
        assert_eq!(nodes[0]["metrics"], Value::Null, "and it has nobody else's metrics");
    }

    /// Both writers enforce the same limits. The create path formerly accepted a
    /// whole `Node` unchecked, leaving everything the update path refuses
    /// reachable by another route.
    #[tokio::test]
    async fn both_write_paths_refuse_the_same_out_of_range_values() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        for bad in [
            json!({"name": "x", "traffic_reset_day": 99}),
            json!({"name": "x", "price": -5.0}),
            json!({"name": "x", "traffic_limit": -1}),
        ] {
            let created = create_node(
                Admin,
                axum::extract::State(app.clone()),
                domain_headers(),
                Ok(Json(serde_json::from_value(bad.clone()).unwrap())),
            )
            .await;
            assert_eq!(created.status(), StatusCode::BAD_REQUEST, "create accepted {bad}");
            let updated = update_node(
                Admin,
                axum::extract::State(app.clone()),
                Path(id),
                Ok(Json(serde_json::from_value(bad.clone()).unwrap())),
            )
            .await;
            assert_eq!(updated.status(), StatusCode::BAD_REQUEST, "update accepted {bad}");
        }
        assert_eq!(app.db.nodes().unwrap().len(), 1, "nothing was created");
    }

    /// A stream outlives the request that opened it, so everything the handshake
    /// tested must be re-read rather than captured -- both answers, not one. The
    /// admin frame carries private node details, and the public frame
    /// is what switching the status page off is meant to withdraw; a socket
    /// surviving either decision would continue sending what was withdrawn.
    #[test]
    fn a_stream_re_reads_both_answers_its_handshake_tested() {
        let app = app();
        app.db.set("public_page", "on").unwrap();
        let hash = sha256("live-token");
        app.db.create_session(&hash, Utc::now().timestamp() + 3_600).unwrap();

        assert_eq!(stream_audience(&app, Some(&hash)), Some(true), "a live session gets the admin frame");
        assert_eq!(stream_audience(&app, None), Some(false), "an anonymous stream gets the public one");

        // Signing out, another device revoking this one, a password change and a
        // restore all manifest as this row disappearing.
        app.db.drop_session(&hash).unwrap();
        assert_eq!(stream_audience(&app, Some(&hash)), None, "a revoked session must end its stream");

        // The other half. `live_ws` refuses a new anonymous connection from here
        // and `nodes` answers 401, so a stream that continued was the only
        // remaining route, for as long as the tab stayed open.
        app.db.create_session(&hash, Utc::now().timestamp() + 3_600).unwrap();
        app.db.set("public_page", "off").unwrap();
        assert_eq!(stream_audience(&app, None), None, "closing the status page must end anonymous streams");
        assert_eq!(stream_audience(&app, Some(&hash)), Some(true), "a signed-in operator still gets theirs");
    }

    #[test]
    fn the_shared_snapshot_keeps_the_two_audiences_apart() {
        let app = app();
        let open = node(&app, "open", true);
        node(&app, "hidden", false);
        app.db.save_facts(open, &json!({"hostname": "vps-1"}), "198.51.100.9").unwrap();

        let public = live_snapshot(&app, false);
        let admin = live_snapshot(&app, true);
        // Caching must never let one audience's payload reach the other.
        assert!(!public.as_str().contains("198.51.100.9"), "the public frame must carry no address");
        assert!(!public.as_str().contains("hidden"), "the public frame must carry no private node");
        assert!(admin.as_str().contains("198.51.100.9") && admin.as_str().contains("hidden"));

        // Two reads over unchanged data prove nothing, since a rebuild returns the
        // same bytes, so the data is modified first.
        node(&app, "late", true);
        assert_eq!(live_snapshot(&app, false), public, "the frame is reused, not rebuilt per viewer");
    }

    #[test]
    fn a_clock_stepping_backwards_does_not_pin_a_stale_frame() {
        let app = app();
        node(&app, "first", true);
        live_snapshot(&app, false);

        // NTP correcting a fresh boot leaves the cached stamp in the future, which
        // does not constitute a young frame.
        app.snapshot.lock().unwrap()[0].0 = Utc::now().timestamp_millis() + 60_000;
        node(&app, "added-after", true);
        assert!(live_snapshot(&app, false).as_str().contains("added-after"));
    }

    /// The panel sends only a name, and expects the node just added to appear in
    /// the frame it is already streaming.
    #[tokio::test]
    async fn a_node_added_from_the_panel_needs_only_a_name_and_shows_up_at_once() {
        let app = std::sync::Arc::new(app());
        node(&app, "existing", true);
        assert!(!live_snapshot(&app, true).as_str().contains("added"));

        let added: Node = serde_json::from_value(json!({"name": "added"})).unwrap();
        // Newly provisioned nodes use the approved public default; existing private rows are not migrated.
        assert!(added.public);
        assert_eq!(added.billing_cycle, "monthly");
        assert_eq!(added.traffic_reset_day, 1);

        let created = create_node(Admin, State(app.clone()), domain_headers(), Ok(Json(added))).await;
        assert_eq!(created.status(), StatusCode::OK);
        // Frames are cached for nearly two seconds, so without dropping the cache
        // the node just added would disappear from the list.
        assert!(live_snapshot(&app, true).as_str().contains("added"));

        // A name consisting only of spaces is refused and leaves no node behind.
        let blank = Json(serde_json::from_value::<Node>(json!({"name": "   "})).unwrap());
        let refused = create_node(Admin, State(app.clone()), domain_headers(), Ok(blank)).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.nodes().unwrap().len(), 2);
    }

    /// Every gate on the anonymous route, in the order a batch install encounters
    /// them: closed, wrong key, open, expired, closed manually.
    #[tokio::test]
    async fn registration_only_works_inside_a_window_the_panel_opened() {
        let app = std::sync::Arc::new(app());
        let register = |key: Option<&str>, name: &str| {
            let mut headers = domain_headers();
            if let Some(key) = key {
                headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
            }
            agent_register(
                State(app.clone()),
                ConnectInfo("198.51.100.7:40000".parse().unwrap()),
                headers,
                name.to_owned(),
            )
        };

        // Nothing was opened, so no key is correct.
        assert_eq!(register(Some("guess"), "a").await.status(), StatusCode::FORBIDDEN);
        assert!(app.db.nodes().unwrap().is_empty());

        assert_eq!(open_register(Admin, State(app.clone()), domain_headers()).await.status(), StatusCode::OK);
        let key = app.db.get("register_key").unwrap();
        assert_eq!(register(Some("guess"), "a").await.status(), StatusCode::FORBIDDEN);
        assert_eq!(register(None, "a").await.status(), StatusCode::FORBIDDEN);
        assert!(app.db.nodes().unwrap().is_empty());

        let issued = register(Some(&key), "  web-01\n").await;
        assert_eq!(issued.status(), StatusCode::OK);
        let token = axum::body::to_bytes(issued.into_body(), usize::MAX).await.unwrap().to_vec();
        let token = String::from_utf8(token).unwrap();
        // The purpose of the route: what returned is a token an agent can connect
        // with, not merely a 200.
        let id = app.db.node_by_token(&token).unwrap().expect("token opens a node");
        let node = app.db.nodes().unwrap().into_iter().find(|n| n.id == id).unwrap();
        assert_eq!(node.name, "web-01");
        // Registered nodes take the panel's defaults rather than `Node::default()`.
        assert!(node.public);
        assert_eq!(node.traffic_reset_day, 1);

        // An hour later the same key is worthless, which is what makes leaving the
        // window open harmless.
        app.db.set("register_until", &(Utc::now().timestamp() - 1).to_string()).unwrap();
        assert_eq!(register(Some(&key), "b").await.status(), StatusCode::FORBIDDEN);

        // Reopened, then closed manually: the key from the open window stops
        // working.
        open_register(Admin, State(app.clone()), domain_headers()).await;
        let key = app.db.get("register_key").unwrap();
        assert_eq!(close_register(Admin, State(app.clone())).await.status(), StatusCode::NO_CONTENT);
        assert_eq!(register(Some(&key), "c").await.status(), StatusCode::FORBIDDEN);
        assert_eq!(app.db.nodes().unwrap().len(), 1);
    }

    /// The ceiling on the anonymous route: a leaked key cannot fill the table.
    #[tokio::test]
    async fn one_window_stops_registering_at_the_limit() {
        let app = std::sync::Arc::new(app());
        open_register(Admin, State(app.clone()), domain_headers()).await;
        let key = app.db.get("register_key").unwrap();
        for i in 0..REGISTER_LIMIT {
            node(&app, &format!("n{i}"), true);
        }
        let mut headers = domain_headers();
        headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
        let refused = agent_register(
            State(app.clone()),
            ConnectInfo("198.51.100.7:40000".parse().unwrap()),
            headers,
            "one-too-many".to_owned(),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(app.db.nodes().unwrap().len() as i64, REGISTER_LIMIT);
    }

    #[test]
    fn a_node_view_carries_traffic_even_while_offline() {
        let app = app();
        let id = node(&app, "n", true);
        app.db.accumulate(id, "b", Some((100, 100))).unwrap();
        app.db.accumulate(id, "b", Some((900, 500))).unwrap();
        app.db.touch_seen(id, 1_700_000_000).unwrap();

        let view = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(view["online"], false);
        assert_eq!(view["metrics"], Value::Null);
        assert_eq!(view["total_rx"], 800, "traffic is stored, not derived from the live state");
        assert_eq!(view["total_tx"], 400);
        // The live entry went with the connection, so "offline since" must come
        // from the node row.
        assert_eq!(view["last_seen"], 1_700_000_000);
    }

    /// A capacity arrives twice -- once in the facts stored at the handshake, and
    /// again in every report -- and the two diverge as soon as a disk is mounted
    /// on a running machine, which the agent detects by re-reading its mount table
    /// every sample. Drawn from the stored copy, the card and the detail page
    /// showed the same host two different sizes until it reconnected.
    #[test]
    fn a_capacity_that_changed_since_the_handshake_is_the_reported_one() {
        let app = app();
        let id = node(&app, "n", true);
        // What the handshake stored: 30 GB of disk, 1 GB of swap.
        app.db
            .save_facts(
                id,
                &json!({"mem_total": 1_000, "swap_total": 1i64 << 30, "disk_total": 30i64 << 30}),
                "ip",
            )
            .unwrap();

        let offline = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(
            offline["disk_total"],
            30i64 << 30,
            "with nobody connected the stored facts are all there is"
        );

        // A 5 GB volume is mounted and swap is disabled. The same session, with no
        // second hello, so the stored facts do not change.
        let _held = connect(
            &app,
            id,
            json!({"mem_total": 1_000, "swap_total": 0, "disk_total": 35i64 << 30, "cpu": 1.0}),
        );
        let live = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(live["disk_total"], 35i64 << 30, "the report is the truth while the agent is connected");
        assert_eq!(live["swap_total"], 0, "swapoff means zero, not the gigabyte that was there at connect");
        assert_eq!(live["disk_total"], live["metrics"]["disk_total"], "one number, not two");
        assert_eq!(app.db.node(id).unwrap().unwrap().disk_total, 30i64 << 30, "and no extra write to get it");
    }

    /// `PUBLIC_HOURS` bounds one window; this bounds how many are built
    /// concurrently. History reads use the bounded DuckDB reader pool, while
    /// this outer gate keeps anonymous callers from turning expensive scans into
    /// an unbounded CPU/memory-bandwidth backlog.
    #[tokio::test]
    async fn history_queries_past_the_gate_are_refused_rather_than_queued() {
        let app = std::sync::Arc::new(app());
        app.db.set("public_page", "on").unwrap();
        let id = node(&app, "n", true);
        let ask = || {
            metrics(
                State(app.clone()),
                HeaderMap::new(),
                Path(id),
                Query(Window { hours: 1, points: None, series: None }),
            )
        };

        let fill = || -> Vec<_> {
            (0..HISTORY_SLOTS).map(|_| app.history_gate[0].try_acquire().expect("up to the limit")).collect()
        };
        let held = fill();
        assert_eq!(ask().await.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(held);
        assert_eq!(ask().await.status(), StatusCode::OK, "a finished query gives its slot back");

        // An unauthorised caller is told so rather than asked to retry later: the
        // gate sits behind the visibility check deliberately.
        app.db.set("public_page", "off").unwrap();
        let held = fill();
        assert_eq!(ask().await.status(), StatusCode::UNAUTHORIZED);
        drop(held);
    }

    /// The anonymous status page cannot spend the operator's history budget: the
    /// two audiences draw on separate pools, as they already do for live stream
    /// seats.
    #[tokio::test]
    async fn a_saturated_public_page_still_leaves_the_operator_a_history_slot() {
        let app = std::sync::Arc::new(app());
        app.db.set("public_page", "on").unwrap();
        let id = node(&app, "n", true);
        let token = random_token();
        app.db.create_session(&sha256(&token), Utc::now().timestamp() + 3_600).unwrap();
        let signed_in =
            HeaderMap::from_iter([(header::COOKIE, format!("monitor_session={token}").parse().unwrap())]);

        let held: Vec<_> =
            (0..HISTORY_SLOTS).map(|_| app.history_gate[0].try_acquire().expect("up to the limit")).collect();
        let anonymous = metrics(
            State(app.clone()),
            HeaderMap::new(),
            Path(id),
            Query(Window { hours: 1, points: None, series: None }),
        );
        assert_eq!(anonymous.await.status(), StatusCode::SERVICE_UNAVAILABLE);

        let operator = metrics(
            State(app.clone()),
            signed_in,
            Path(id),
            Query(Window { hours: 1, points: None, series: None }),
        );
        assert_eq!(operator.await.status(), StatusCode::OK, "the operator keeps their own slots");
        drop(held);
    }

    #[tokio::test]
    async fn public_default_view_is_validated_and_exposed() {
        let app = std::sync::Arc::new(app());
        let Json(initial) = me(State(app.clone()), HeaderMap::new()).await;
        assert_eq!(initial["public_default_view"], "cards");
        let Json(initial_settings) = settings(Admin, State(app.clone())).await;
        assert_eq!(initial_settings["public_default_view"], "cards");
        for invalid in [json!("grid"), json!(""), json!(true)] {
            let response = save_settings(
                Admin,
                State(app.clone()),
                HeaderMap::new(),
                Json(json!({"public_default_view": invalid})),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(app.db.get("public_default_view").is_none());
        }
        let response = save_settings(
            Admin,
            State(app.clone()),
            HeaderMap::new(),
            Json(json!({"public_default_view":"list"})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app.db.get("public_default_view").as_deref(), Some("list"));
        let Json(saved) = me(State(app), HeaderMap::new()).await;
        assert_eq!(saved["public_default_view"], "list");
    }

    /// A settings write lands whole or not at all. Changing the password drops
    /// every session and places the replacement cookie on the response, so a 400
    /// raised afterwards -- on a later key, in whatever order the map iterates --
    /// would sign the admin out of every device without explanation.
    #[tokio::test]
    async fn a_settings_write_is_all_or_nothing() {
        let app = std::sync::Arc::new(app());
        app.db.set("admin_password_hash", "the-old-hash").unwrap();
        let save = |body: Value| save_settings(Admin, State(app.clone()), HeaderMap::new(), Json(body));

        // BTreeMap order places the password first, which is the failing case.
        let refused = save(json!({"admin_password": "a-long-enough-one", "retention_days": "abc"})).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.get("admin_password_hash").as_deref(), Some("the-old-hash"));

        // A correctly named key carrying the wrong type is refused rather than
        // discarded while the response reports success.
        let refused = save(json!({"public_page": false})).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.get("public_page"), None);

        let saved = save(json!({"public_page": "off", "retention_days": "7"})).await;
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(app.db.get("retention_days").as_deref(), Some("7"));
    }

    /// The install script and the sign-in page keep separate counters: five
    /// machines started with a stale key is a misconfigured deploy, and a shared
    /// counter would lock the operator out of the panel for the lockout window.
    #[tokio::test]
    async fn a_wrong_registration_key_does_not_lock_the_sign_in_page() {
        let app = std::sync::Arc::new(app());
        app.db.set("register_key", "the-key").unwrap();
        app.db.set("register_until", &(Utc::now().timestamp() + 60).to_string()).unwrap();
        let mut headers = domain_headers();
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        let peer: std::net::SocketAddr = "198.51.100.7:9000".parse().unwrap();

        // The attempt after the last permitted one answers 429 rather than 403.
        for _ in 0..5 {
            let refused =
                agent_register(State(app.clone()), ConnectInfo(peer), headers.clone(), "n".into()).await;
            assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        }
        assert!(app.registrations.locked(peer.ip()), "the register route counts its own failures");
        assert!(!app.throttle.locked(peer.ip()), "and the panel's sign-in page is not one of them");
    }

    #[test]
    fn per_node_reads_follow_the_public_flag_and_the_public_page_switch() {
        let app = app();
        app.db.set("public_page", "on").unwrap();
        let open = node(&app, "open", true);
        let hidden = node(&app, "hidden", false);

        assert!(readable(&app, false, open), "a published node is readable by anyone");
        assert!(!readable(&app, false, hidden), "a private node is not");
        assert!(!readable(&app, false, 9999), "an unknown id is not");
        assert!(readable(&app, true, hidden), "the panel sees a private node");

        // Switching the public page off closes even a published node.
        app.db.set("public_page", "off").unwrap();
        assert!(!readable(&app, false, open));
        assert!(readable(&app, true, open), "and never closes it for the panel");
    }

    /// The window ceiling is a scan bound rather than a response bound: the
    /// thinning already limits the row count, while a quarter-year still reads
    /// every row behind it and consumes analytical reader/CPU bandwidth.
    #[tokio::test]
    async fn an_anonymous_history_window_stops_at_a_week() {
        let app = std::sync::Arc::new(app());
        app.db.set("public_page", "on").unwrap();
        let id = node(&app, "n", true);
        let now = Utc::now().timestamp();
        // One sample per day for a month, so a row's presence identifies its
        // window. The minute of slack keeps day seven clear of the 168-hour cutoff:
        // exactly on the boundary, a second elapsing between these inserts and the
        // query below would drop it and leave the count one short.
        for day in 0..30 {
            app.db.insert_metric(id, now - day * 86_400 + 60, &json!({"cpu": 1.0})).unwrap();
        }
        let ask = |hours| {
            let query = format!("hours={hours}&series=metrics");
            metrics(
                State(app.clone()),
                HeaderMap::new(),
                Path(id),
                Query(serde_urlencoded::from_str::<Window>(&query).unwrap()),
            )
        };
        let rows =
            |body: &str| serde_json::from_str::<Value>(body).unwrap()["metrics"].as_array().unwrap().len();

        let week = axum::body::to_bytes(ask(168).await.into_body(), usize::MAX).await.unwrap();
        assert_eq!(rows(std::str::from_utf8(&week).unwrap()), 8, "a week reaches back seven days");

        // Requesting the quarter year formerly available to an anonymous caller
        // returns the week: the extra rows exist, and reading them is the cost.
        let quarter = axum::body::to_bytes(ask(2_160).await.into_body(), usize::MAX).await.unwrap();
        assert_eq!(quarter, week, "an anonymous window past a week is clamped to one");
    }

    /// One client holds at most `VIEWERS_PER_CLIENT` anonymous streams, an IPv6
    /// client is one /64, and a seat is returned when its stream ends.
    #[test]
    fn anonymous_viewer_seats_are_counted_per_client() {
        let app = std::sync::Arc::new(app());
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();

        let held: Vec<_> =
            (0..VIEWERS_PER_CLIENT).map(|_| ViewerSeat::take(&app, ip("198.51.100.7")).unwrap()).collect();
        assert!(ViewerSeat::take(&app, ip("198.51.100.7")).is_none(), "the allowance is spent");
        // Another client is unaffected, including one reported as an IPv4-mapped
        // IPv6 address by a dual-stack listener -- it is the same host as its
        // plain form, so it shares that allowance rather than getting its own.
        assert!(ViewerSeat::take(&app, ip("198.51.100.8")).is_some());
        assert!(ViewerSeat::take(&app, ip("::ffff:198.51.100.7")).is_none());

        drop(held);
        assert!(ViewerSeat::take(&app, ip("198.51.100.7")).is_some(), "a finished stream returns its seat");

        // Fresh addresses from one /64 are still one client; the next /64 is not.
        let prefix: Vec<_> = (1..=VIEWERS_PER_CLIENT)
            .map(|n| ViewerSeat::take(&app, ip(&format!("2001:db8:0:1::{n:x}"))).unwrap())
            .collect();
        assert!(ViewerSeat::take(&app, ip("2001:db8:0:1::ffff")).is_none());
        assert!(ViewerSeat::take(&app, ip("2001:db8:0:2::1")).is_some());
        drop(prefix);

        // Nothing lingers once every stream has ended.
        assert!(app.anonymous_viewers.lock().unwrap().is_empty());
    }

    /// A patch aimed at a node that is gone is refused, not acknowledged: the
    /// panel would otherwise report a save that changed nothing. The traffic
    /// route used to fail the other way, as a storage error.
    #[tokio::test]
    async fn patching_a_missing_node_is_a_404_not_a_success() {
        let app = std::sync::Arc::new(app());
        let id = app.db.create_node(&crate::db::Node::default(), "patched-token").unwrap();
        let missing = id + 1_000;

        let node = |id: i64| {
            let app = app.clone();
            async move {
                let body = Ok(Json(serde_json::from_value::<NodePatch>(json!({"price": 5})).unwrap()));
                update_node(Admin, State(app), Path(id), body).await.status()
            }
        };
        assert_eq!(node(missing).await, StatusCode::NOT_FOUND);
        assert_eq!(node(id).await, StatusCode::OK);

        let traffic = |id: i64| {
            let app = app.clone();
            async move {
                let body = Json(crate::db::TrafficPatch { total_rx: Some(1), ..Default::default() });
                patch_traffic(Admin, State(app), Path(id), body).await.status()
            }
        };
        assert_eq!(traffic(missing).await, StatusCode::NOT_FOUND);
        assert_eq!(traffic(id).await, StatusCode::OK);
    }

    /// Both halves of the local credential are proven with the password being
    /// replaced. A session is not that proof: one left open on an unattended
    /// machine would otherwise be enough to take the account over.
    #[tokio::test]
    async fn changing_a_credential_requires_the_current_password() {
        let app = std::sync::Arc::new(app());
        app.db.set("admin_password_hash", &hash_password("the-current-password").unwrap()).unwrap();
        let save = |body: Value| {
            let app = app.clone();
            async move { save_settings(Admin, axum::extract::State(app), HeaderMap::new(), Json(body)).await }
        };

        for key in ["admin_password", "admin_username"] {
            let value = if key == "admin_password" { "a-long-enough-password" } else { "operator" };
            let missing = save(json!({key: value})).await;
            assert_eq!(missing.status(), StatusCode::BAD_REQUEST, "{key} without proof");

            let wrong = save(json!({key: value, "current_password": "not-the-password"})).await;
            assert_eq!(wrong.status(), StatusCode::FORBIDDEN, "{key} with the wrong proof");
        }
        // Nothing was written by either refusal.
        assert_eq!(app.db.get("admin_username"), None);
        assert!(crate::auth::password_matches(&app, "the-current-password"));

        // An empty proof is refused by validation rather than reaching argon2.
        let empty = save(json!({"admin_password": "a-long-enough-password", "current_password": ""})).await;
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);

        // Settings that are not the credential need no proof at all.
        let ordinary = save(json!({"site_name": "romi"})).await;
        assert_eq!(ordinary.status(), StatusCode::OK);
        assert_eq!(app.db.get("site_name").as_deref(), Some("romi"));

        // With the proof, the change lands and the proof itself is not stored.
        let accepted = save(
            json!({"admin_password": "a-long-enough-password", "current_password": "the-current-password"}),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert!(crate::auth::password_matches(&app, "a-long-enough-password"));
        assert_eq!(app.db.get("current_password"), None, "the proof has no stored form");
    }

    #[tokio::test]
    async fn changing_the_password_kills_other_sessions_but_not_the_caller() {
        let app = std::sync::Arc::new(app());
        app.db.set("admin_password_hash", &hash_password("the-current-password").unwrap()).unwrap();
        let stale = random_token();
        app.db.create_session(&sha256(&stale), Utc::now().timestamp() + 3_600).unwrap();

        let body = Json(
            json!({"admin_password": "a-long-enough-password", "current_password": "the-current-password"}),
        );
        let response = save_settings(Admin, axum::extract::State(app.clone()), HeaderMap::new(), body).await;

        assert!(!app.db.session_valid(&sha256(&stale)), "sessions must not outlive the old password");

        // The caller receives a replacement rather than being logged out by its
        // own password change.
        let cookie = response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .expect("a replacement session")
            .to_str()
            .unwrap();
        let token = cookie.split(';').next().unwrap().split('=').nth(1).unwrap();
        assert!(app.db.session_valid(&sha256(token)), "the replacement session must work");
    }

    /// The panel hides the delete button on the caller's own row, so the mark is
    /// all that prevents an admin from signing themselves out.
    #[tokio::test]
    async fn the_session_list_marks_the_caller_and_hides_expired_rows() {
        let app = std::sync::Arc::new(app());
        let (mine, theirs, stale) = (random_token(), random_token(), random_token());
        let now = Utc::now().timestamp();
        app.db.create_session(&sha256(&mine), now + 3_600).unwrap();
        app.db.create_session(&sha256(&theirs), now + 7_200).unwrap();
        app.db.create_session(&sha256(&stale), now - 1).unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("monitor_session={mine}").parse().unwrap());
        let body = axum::body::to_bytes(
            sessions(Admin, axum::extract::State(app.clone()), headers).await.into_body(),
            usize::MAX,
        )
        .await
        .unwrap();
        let rows: Vec<Value> = serde_json::from_slice(&body).unwrap();

        assert_eq!(rows.len(), 2, "an expired session is not a session");
        assert_eq!(rows[0]["id"], sha256(&theirs), "newest first");
        assert_eq!(rows[0]["current"], false);
        assert_eq!(rows[1]["id"], sha256(&mine));
        assert_eq!(rows[1]["current"], true, "the caller's own row must be marked");
        assert_eq!(rows[1]["created_at"].as_i64().unwrap(), now + 3_600 - 14 * 86_400);

        delete_session(Admin, axum::extract::State(app.clone()), Path(sha256(&theirs))).await;
        assert!(!app.db.session_valid(&sha256(&theirs)), "the deleted device is signed out");
        assert!(app.db.session_valid(&sha256(&mine)), "and nobody else is");
    }

    #[tokio::test]
    async fn a_short_password_is_refused_and_changes_nothing() {
        let app = std::sync::Arc::new(app());
        let live = random_token();
        app.db.create_session(&sha256(&live), Utc::now().timestamp() + 3_600).unwrap();

        let body = Json(json!({"admin_password": "short"}));
        let response = save_settings(Admin, axum::extract::State(app.clone()), HeaderMap::new(), body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app.db.get("admin_password_hash").is_none(), "the password must not have changed");
        assert!(app.db.session_valid(&sha256(&live)), "a rejected change must not log anyone out");
    }

    /// Housekeeping clamps whatever it finds, so an unparsable value is not an
    /// error downstream: it silently means 7 days, in a field still displaying
    /// what was entered.
    #[tokio::test]
    async fn a_retention_window_that_would_never_apply_is_refused() {
        let app = std::sync::Arc::new(app());
        let put = |v: &str| {
            save_settings(
                Admin,
                State(app.clone()),
                HeaderMap::new(),
                Json(json!({"retention_days": v.to_owned()})),
            )
        };
        for junk in ["", "abc", "0", "-1", "9999"] {
            assert_eq!(put(junk).await.status(), StatusCode::BAD_REQUEST, "{junk:?}");
        }
        assert!(app.db.get("retention_days").is_none(), "a refused window must not be stored");
        assert_eq!(put("7").await.status(), StatusCode::OK);
        assert_eq!(app.db.get("retention_days").as_deref(), Some("7"));
    }

    /// What `settings` returns must be what `save_settings` accepts. The panel
    /// echoes the whole form back and the write is all-or-nothing, so one key
    /// returned in a form the write refuses fails the entire page, naming a field
    /// that was never edited.
    #[tokio::test]
    async fn a_fresh_hub_answers_settings_that_it_will_take_back() {
        let app = std::sync::Arc::new(app());
        let Json(read) = settings(Admin, State(app.clone())).await;
        assert_eq!(read["retention_days"], "30", "the default belongs in the answer, not in each caller");

        // Exactly what the panel sends, on a hub where nothing was ever set.
        let echoed = json!({
            "site_name": read["site_name"],
            "retention_days": read["retention_days"],
            "online_grace_minutes": read["online_grace_minutes"],
            "maintenance_days": read["maintenance_days"],
            "public_page": "on",
            "notify_grace": read["notify_grace"],
            "notify_traffic": read["notify_traffic"],
            "notify_expiry": read["notify_expiry"],
            "notify_login": read["notify_login"],
            "notify_telegram_chat": read["notify_telegram_chat"],
            "notify_telegram_text": read["notify_telegram_text"],
            "notify_webhook_body": read["notify_webhook_body"],
        });
        assert_eq!(
            save_settings(Admin, State(app.clone()), HeaderMap::new(), Json(echoed)).await.status(),
            StatusCode::OK,
            "a fresh hub's own settings must survive a round trip"
        );
        assert_eq!(app.db.retention_days(), 30, "and the stored window is the one that was shown");
    }

    #[tokio::test]
    async fn healthz_reports_closed_storage_as_unavailable() {
        let app = std::sync::Arc::new(app());
        assert_eq!(healthz(State(app.clone())).await.status(), StatusCode::OK);
        app.db.close().unwrap();
        let response = healthz(State(app.clone())).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn distribution_routes_are_disabled_until_validated_and_then_versioned() {
        let disabled = std::sync::Arc::new(app());
        assert_eq!(
            agent_distribution(State(disabled.clone()), Query(DistributionQuery::default())).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            agent_install_script(State(disabled.clone())).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            agent_binary_alias(State(disabled.clone()), Path("x86_64".into())).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            agent_binary(State(disabled), Path(("0.1.0".into(), crate::distribution::TARGET.into())))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let mut configured = app();
        configured.distribution =
            Some(crate::distribution::Distribution::test_fixture("0.1.0", b"agent-bytes"));
        let configured = std::sync::Arc::new(configured);

        let metadata =
            agent_distribution(State(configured.clone()), Query(DistributionQuery::default())).await;
        assert_eq!(metadata.status(), StatusCode::OK);
        let body = axum::body::to_bytes(metadata.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["version"], "0.1.0");
        assert_eq!(value["download"], format!("/agent/v0.1.0/{}", crate::distribution::TARGET));
        assert!(value.get("path").is_none(), "filesystem paths must never be exposed");

        let script = agent_install_script(State(configured.clone())).await;
        assert_eq!(script.status(), StatusCode::OK);
        let script = axum::body::to_bytes(script.into_body(), usize::MAX).await.unwrap();
        let script = std::str::from_utf8(&script).unwrap();
        assert!(script.contains("romi-agent"));
        assert!(!script.contains("api.github.com"));
        assert!(!script.contains("/releases/download/"));

        let binary = agent_binary(
            State(configured.clone()),
            Path(("0.1.0".into(), crate::distribution::TARGET.into())),
        )
        .await;
        assert_eq!(binary.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(binary.into_body(), usize::MAX).await.unwrap(),
            b"agent-bytes".as_slice()
        );
        assert_eq!(
            agent_binary(State(configured.clone()), Path(("0.1.1".into(), "x86_64".into()))).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            agent_binary(State(configured.clone()), Path(("0.1.0".into(), "aarch64".into()))).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            agent_binary_alias(State(configured), Path("x86_64".into())).await.status(),
            StatusCode::NOT_FOUND,
            "the mutable architecture-only alias is never served"
        );
    }

    #[tokio::test]
    async fn changing_the_password_removes_the_bootstrap_credential_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "romi-bootstrap-remove-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("bootstrap-password");
        std::fs::write(&path, "one-time-secret\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let mut app = app();
        app.bootstrap_password_file = Some(path.clone());
        // The real shape of this moment: the operator replaces the generated
        // bootstrap password, and proves it with the one they were handed.
        app.db.set("admin_password_hash", &hash_password("one-time-secret").unwrap()).unwrap();
        let app = std::sync::Arc::new(app);
        let response = save_settings(
            Admin,
            State(app.clone()),
            HeaderMap::new(),
            Json(json!({"admin_password": "a-long-enough-one", "current_password": "one-time-secret"})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!path.exists(), "the one-time bootstrap credential must be removed");
        assert!(app.db.get("admin_password_hash").unwrap().starts_with("$argon2"));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn settings_never_hand_back_a_secret() {
        let app = app();
        app.db.set("notify_telegram_token", "123:bot-secret").unwrap();
        app.db.set("notify_webhook_url", "https://hooks.example/url-secret").unwrap();
        app.db.set("notify_webhook_headers", "Authorization: header-secret").unwrap();

        let Json(body) = settings(Admin, axum::extract::State(std::sync::Arc::new(app))).await;
        assert_eq!(body["notify_telegram_token_set"], true);
        assert_eq!(body["notify_webhook_url_set"], true);
        assert!(body.get("notify_telegram_token").is_none());
        for secret in ["bot-secret", "url-secret", "header-secret"] {
            assert!(!body.to_string().contains(secret), "{secret}");
        }
    }
}
