//! romi-hub: collects reports from romi agents and serves the panel.
//!
//! No configuration is required to start. Everything beyond the listen address
//! and the database path is configured in the panel and stored in the embedded
//! DuckDB database, leaving no config file to track and no secrets in plaintext
//! TOML. The storage design is documented in `docs/storage.md`.

mod agent_ws;
mod api;
mod auth;
mod db;
mod distribution;
mod frontend;
mod notify;

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use anyhow::{Context, Result};
use axum::http::{Extensions, HeaderMap, StatusCode, Version};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use chrono::{Local, Months, NaiveDate};
use tokio::signal::unix::{signal, SignalKind};
use tower_http::compression::Predicate;
use tracing::{info, warn};

use agent_ws::Agent;
use db::Db;
use distribution::Distribution;

pub type Shared = Arc<App>;

pub struct App {
    pub db: Db,
    /// Every connected agent: its outbound channel, the session that opened it,
    /// and its independently locked report state. The map lock protects only
    /// membership/lookup; a report clones the per-session handle and releases
    /// the map before any database work. See `agent_ws`.
    pub agents: RwLock<HashMap<i64, Arc<Agent>>>,
    /// Serializes map-mutating operations that also touch credentials or the
    /// database contents: activation, token rotation, node deletion and restore.
    /// It is deliberately separate from `agents`, so waiting for an in-flight
    /// report or a database write never holds the global membership lock.
    pub agents_admin: Mutex<()>,
    /// Last rendered node list per audience, `[public, admin]`, with the
    /// millisecond it was built. Shared by every browser stream so viewers do
    /// not multiply the query load. See `api::live_snapshot`.
    pub snapshot: Mutex<[(i64, axum::extract::ws::Utf8Bytes); 2]>,
    pub throttle: auth::Throttle,
    /// Failed agent registrations, counted separately from failed sign-ins: the
    /// two have different threat models, and a batch install run with a stale
    /// key must not lock the operator out of the panel.
    pub registrations: auth::Throttle,
    pub http: reqwest::Client,
    /// Public base URL when `--site` was given, empty otherwise. In the default
    /// case the hub is reached at whatever ip:port the browser used and the
    /// panel falls back to its own origin. Behind a reverse proxy it must be
    /// set, or a loopback listener would place 127.0.0.1 in the install commands
    /// the panel builds.
    pub site: String,
    /// Parent directory containing one folder per installed public theme.
    pub themes: PathBuf,
    pub allow_custom_themes: bool,
    /// Validated local Agent distribution, if the operator configured one.
    /// `None` means `/install.sh`, metadata, and binary routes all refuse.
    pub distribution: Option<Distribution>,
    /// When set, a fresh database writes the generated administrator password
    /// here instead of printing it to standard output.
    pub bootstrap_password_file: Option<PathBuf>,
    /// Alerts on their way out; see `notify::send`.
    pub notes: tokio::sync::mpsc::Sender<notify::Note>,
}

impl App {
    fn new(db: Db, site: String, themes: PathBuf, notes: tokio::sync::mpsc::Sender<notify::Note>) -> Self {
        Self {
            db,
            agents: RwLock::default(),
            agents_admin: Mutex::new(()),
            snapshot: Mutex::new([(0, Default::default()), (0, Default::default())]),
            throttle: auth::Throttle::default(),
            registrations: auth::Throttle::default(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("http client"),
            site,
            themes,
            allow_custom_themes: false,
            distribution: None,
            bootstrap_password_file: None,
            notes,
        }
    }

    /// Remove the bootstrap credential after the administrator has chosen a
    /// password of their own. A missing file is the normal case; any other
    /// failure is logged, never fatal, because the password already changed.
    pub fn discard_bootstrap_credential(&self) {
        let Some(path) = &self.bootstrap_password_file else { return };
        match std::fs::remove_file(path) {
            Ok(()) => info!("removed bootstrap credential {}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warn!("could not remove bootstrap credential {}: {error}", path.display()),
        }
    }

    #[cfg(test)]
    pub fn for_test(db: Db) -> Self {
        // Nothing delivers in tests; `notify::send` drops into the closed channel.
        Self::new(db, String::new(), PathBuf::from("themes"), tokio::sync::mpsc::channel(1).0)
    }

    pub fn public_page(&self) -> bool {
        self.db.get("public_page").as_deref() == Some("on")
    }

    /// Whether a session cookie may be marked Secure. With `--site` this follows
    /// its scheme; without one the hub does not know the address it was reached
    /// on and must rely on the request: a TLS-terminating proxy sets
    /// `X-Forwarded-Proto`, while a hub answering plain HTTP directly has no such
    /// header. Marking the cookie Secure over plain HTTP would cause the browser
    /// to discard the session.
    ///
    /// The header is supplied by the trusted reverse proxy. Provisioning also
    /// checks it along with the request's Host/Origin; the listener must remain
    /// publicly unreachable so callers cannot bypass that proxy.
    pub fn secure_cookies(&self, headers: &HeaderMap) -> bool {
        if !self.site.is_empty() {
            return !self.site.starts_with("http://");
        }
        forwarded_proto(headers) == Some("https")
    }
}

/// The scheme the browser used, as reported by a reverse proxy. Chained proxies
/// append to the header, so the browser's own hop is the first value.
fn forwarded_proto(headers: &HeaderMap) -> Option<&str> {
    let chain = headers.get("x-forwarded-proto")?.to_str().ok()?;
    Some(chain.split(',').next()?.trim())
}

/// Distribution refusal shared by every route that needs a validated local
/// Agent artifact. The text deliberately says what an operator has to do.
pub(crate) fn distribution_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "romi Agent distribution is not configured; install a verified romi release with its Agent artifact",
    )
        .into_response()
}

/// Places the panel's GitHub proxy in front of a github.com URL when one is
/// set. Used by the theme updater.
pub fn proxied(app: &App, url: String) -> String {
    match app.db.get("github_proxy").filter(|v| !v.trim().is_empty()) {
        Some(proxy) => format!("{}/{url}", proxy.trim().trim_end_matches('/')),
        None => url,
    }
}

// ---- startup ----

struct Args {
    listen: SocketAddr,
    database: String,
    site: String,
    themes: PathBuf,
    allow_custom_themes: bool,
    db_memory: Option<String>,
    db_threads: Option<i64>,
    db_temp: Option<String>,
    distribution_dir: Option<PathBuf>,
    bootstrap_password_file: Option<PathBuf>,
}

/// Native installs bind loopback unless explicitly configured otherwise.
fn default_listen() -> &'static str {
    "127.0.0.1:28080"
}

/// Default database file name used when `--db` is omitted.
const DEFAULT_DATABASE: &str = "romi.db";

/// Identity printed by `--version` and used to open `--help`. It never opens
/// the database or makes a network request.
fn version_line() -> String {
    format!("romi-hub {}", env!("CARGO_PKG_VERSION"))
}

/// Bytes from a short human form such as `512MB` or `2GiB`. DuckDB validates the
/// spelling again; this only rejects something that is obviously not a size, so a
/// typo fails at startup rather than at the first spill.
fn valid_size(value: &str) -> bool {
    let trimmed = value.trim();
    let digits = trimmed.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    !digits.is_empty()
        && digits.parse::<f64>().is_ok_and(|n| n > 0.0)
        && trimmed.len() > digits.len()
        && matches!(
            trimmed[digits.len()..].to_ascii_uppercase().as_str(),
            "B" | "KB" | "KIB" | "MB" | "MIB" | "GB" | "GIB" | "TB" | "TIB"
        )
}

fn parse_args() -> Result<Args> {
    let mut listen = None;
    let mut database = DEFAULT_DATABASE.to_owned();
    let mut site = String::new();
    let mut themes = None;
    let mut allow_custom_themes = false;
    let mut db_memory = None;
    let mut db_threads = None;
    let mut db_temp = None;
    let mut distribution_dir = None;
    let mut bootstrap_password_file = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().unwrap_or_default();
        match arg.as_str() {
            "--listen" => listen = Some(value()),
            "--db" => database = value(),
            "--site" => site = value(),
            "--themes" => themes = Some(PathBuf::from(value())),
            "--allow-custom-themes" => allow_custom_themes = true,
            "--db-memory" => db_memory = Some(value()),
            "--db-threads" => {
                let text = value();
                let n: i64 = text.parse().with_context(|| format!("--db-threads {text}"))?;
                anyhow::ensure!((1..=64).contains(&n), "--db-threads must be from 1 to 64");
                db_threads = Some(n);
            }
            "--db-temp" => db_temp = Some(value()),
            "--distribution-dir" => distribution_dir = Some(PathBuf::from(value())),
            "--bootstrap-password-file" => bootstrap_password_file = Some(PathBuf::from(value())),
            "--version" => {
                println!("{}", version_line());
                std::process::exit(0);
            }
            "-h" | "--help" => {
                println!(
                    "{}\n\n\
                     Usage: romi-hub [--listen 127.0.0.1:28080] [--db romi.db] [--themes themes] [--site https://hub.example.com]\n\n\
                     --version prints the romi version and exits without opening a database.\n\
                     --listen defaults to 127.0.0.1:28080.\n\
                     --allow-custom-themes trusts external theme JavaScript with the admin origin.\n\
                     --themes defaults to a themes/ directory beside the database.\n\
                     --site is only needed behind a reverse proxy, where the address the\n\
                     panel is reached on is not the one agents should use. Left out, the\n\
                     hub answers on whatever ip:port it is asked, and the panel builds\n\
                     install commands from the address in the browser's bar.\n\
                     --db-memory caps DuckDB's own memory use (default 512MB); it is not a\n\
                     ceiling on the process's resident set.\n\
                     --db-threads caps DuckDB's worker threads (default: up to 8).\n\
                     --db-temp is where DuckDB spills; defaults to <db>.tmp.\n\
                     --distribution-dir validates and serves one local romi Agent\n\
                     distribution; both /install.sh and versioned /agent URLs stay\n\
                     disabled when it is omitted.\n\
                     --bootstrap-password-file writes a fresh Hub's generated admin\n\
                     credential there (0600) instead of printing it to stdout.\n",
                    version_line()
                );
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }
    if let Some(value) = &db_memory {
        anyhow::ensure!(valid_size(value), "--db-memory {value} is not a size such as 512MB");
    }
    if let Some(value) = &db_temp {
        anyhow::ensure!(!value.is_empty(), "--db-temp needs a directory");
    }
    if let Some(value) = &distribution_dir {
        anyhow::ensure!(!value.as_os_str().is_empty(), "--distribution-dir needs a directory");
    }
    if let Some(value) = &bootstrap_password_file {
        anyhow::ensure!(
            !value.as_os_str().is_empty() && value.parent().is_some(),
            "--bootstrap-password-file needs a file path"
        );
    }
    let site = if site.is_empty() { std::env::var("ROMI_SITE").unwrap_or_default() } else { site };
    let listen: SocketAddr = listen.unwrap_or_else(|| default_listen().to_owned()).parse()?;
    let themes = themes.unwrap_or_else(|| {
        std::path::Path::new(&database).parent().unwrap_or_else(|| std::path::Path::new(".")).join("themes")
    });
    Ok(Args {
        listen,
        database,
        site: site.trim_end_matches('/').to_owned(),
        themes,
        allow_custom_themes,
        db_memory,
        db_threads,
        db_temp,
        distribution_dir,
        bootstrap_password_file,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("ROMI_LOG")
                .unwrap_or_else(|_| "romi_hub=info,tower_http=warn".into()),
        )
        .init();

    let args = parse_args()?;
    std::fs::create_dir_all(&args.themes)?;
    let (notes, inbox) = tokio::sync::mpsc::channel(notify::QUEUE);
    let mut options = db::Options::default();
    if let Some(memory) = args.db_memory.clone() {
        options.memory_limit = memory;
    }
    if let Some(threads) = args.db_threads {
        options.threads = threads;
    }
    if let Some(temp) = args.db_temp.clone() {
        options.temp_directory = temp;
    }
    let mut app = App::new(Db::open_with(&args.database, options)?, args.site.clone(), args.themes, notes);
    app.allow_custom_themes = args.allow_custom_themes;
    if let Some(directory) = &args.distribution_dir {
        let distribution = Distribution::load(directory, env!("CARGO_PKG_VERSION"))?;
        info!(
            "serving romi Agent {} for {} from {} bytes of validated in-memory data",
            distribution.version, distribution.target, distribution.size
        );
        app.distribution = Some(distribution);
    }
    app.bootstrap_password_file = args.bootstrap_password_file.clone();
    if app.allow_custom_themes {
        warn!("custom themes enabled: their JavaScript shares the admin origin; use only reviewed code");
    }
    let app = Arc::new(app);
    let url = advertised_url(&args.site, args.listen);
    first_run(&app, &url)?;
    if exposed_over_plain_http(&url) {
        warn!(
            "this hub answers plain HTTP at {url}; sessions and agent tokens travel in the clear. \
             Put it behind a TLS reverse proxy -- the panel builds install commands from the \
             browser's own address, so nothing here has to change -- then --listen 127.0.0.1:PORT \
             so this port is no longer reachable in the clear"
        );
    }
    // The warning above derives from --site, the address the operator
    // advertises. This one derives from the socket actually open, and the two
    // diverge in the deployment that needs it most: `--site https://...` with
    // --listen left at its wildcard default prints nothing while the port answers
    // plain HTTP to anyone who finds it. The provisioning gate in `api` and the
    // X-Forwarded-Proto cookie flag both assume the proxy cannot be bypassed.
    else if !args.listen.ip().is_loopback() {
        warn!(
            "listening on {} in the clear. If a TLS proxy fronts this hub, callers can still reach \
             this port directly and set their own X-Forwarded-Proto -- --listen 127.0.0.1:{} so the \
             proxy is the only way in",
            args.listen,
            args.listen.port()
        );
    }
    // Checked once here, because the answer is static: `provisioning_allowed`
    // measures every request against --site, so a value that is not an https
    // domain permanently refuses adding and installing nodes however the panel is
    // reached. That refusal names the browser's address and the reverse proxy,
    // both of which are correct here, while the debug line naming --site is off
    // at the default log level. A warning rather than a fatal error: the hub
    // still serves everything else, and an operator upgrading into this check
    // should not lose a running hub. The native Hub installer validates --site
    // at entry with the same domain rule.
    if !args.site.is_empty() && api::https_domain(&args.site).is_none() {
        warn!(
            "--site {} is not an https domain entry, so adding and installing nodes will be refused \
             however the panel is reached: it has to be https://, a domain rather than an address, \
             and nothing after the host",
            args.site
        );
    }

    tokio::spawn(housekeeping(app.clone()));
    tokio::spawn(notify::deliver(app.clone(), inbox));
    tokio::spawn(notify::watch(app.clone()));

    let router = Router::new()
        // Agents.
        .route("/api/agent/ws", get(agent_ws::handler))
        .route("/api/agent/register", post(api::agent_register))
        .route("/api/agent/distribution", get(api::agent_distribution))
        .route("/install.sh", get(api::agent_install_script))
        .route("/agent/v{version}/{arch}", get(api::agent_binary))
        .route("/agent/{arch}", get(api::agent_binary_alias))
        .route("/healthz", get(api::healthz))
        // Read paths; the public page reaches these unauthenticated.
        .route("/api/me", get(api::me))
        .route("/api/nodes", get(api::nodes))
        .route("/api/nodes/{id}/metrics", get(api::metrics))
        .route("/api/ws", get(api::live_ws))
        // Sign-in.
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/github", get(auth::github_start))
        .route("/api/auth/github/callback", get(auth::github_callback))
        // Panel.
        .route("/api/nodes", post(api::create_node))
        .route("/api/register-window", post(api::open_register).delete(api::close_register))
        .route("/api/nodes/order", put(api::reorder_nodes))
        .route("/api/nodes/{id}", put(api::update_node).delete(api::delete_node))
        .route("/api/nodes/{id}/token", post(api::reset_token))
        .route("/api/nodes/{id}/traffic", put(api::patch_traffic))
        .route("/api/ping-tasks", get(api::ping_tasks).post(api::save_ping_task))
        .route("/api/ping-tasks/{id}", delete(api::delete_ping_task))
        .route("/api/sessions", get(api::sessions))
        .route("/api/sessions/{id}", delete(api::delete_session))
        .route("/api/settings", get(api::settings).put(api::save_settings))
        .route("/api/notify/test", post(notify::test))
        .route("/api/themes", get(api::themes))
        .route("/api/themes/{short}", delete(api::delete_theme))
        .route("/api/themes/{short}/preview", get(api::theme_preview))
        .route("/api/themes/{short}/update", post(api::update_theme))
        .route("/api/db", get(api::db_stats))
        .route("/api/db/backup", get(api::db_backup))
        .route("/api/db/maintenance", post(api::db_maintenance))
        .fallback(frontend::serve)
        // A report is a few hundred bytes; anything larger is not a report.
        .layer(tower_http::limit::RequestBodyLimitLayer::new(64 * 1024))
        // The two chunked uploads, merged after that layer rather than beneath
        // it. They raise the ceiling on a single request -- one 4 MiB piece --
        // not on the file behind it: a 256 MiB backup arrives as 64 such
        // requests, so no reverse proxy needs to know the database size. The
        // whole-file ceilings live on `total` and are checked before the first
        // byte is sent.
        .merge(
            Router::new()
                .route("/api/db/restore", post(api::db_restore))
                .route("/api/themes", post(api::upload_theme))
                .layer(tower_http::limit::RequestBodyLimitLayer::new(api::MAX_CHUNK))
                .with_state(app.clone()),
        )
        // Excludes the agent binary and database backups: both are already
        // compressed and both are megabytes, so deflating them would consume the
        // cores argon2 and the DuckDB writer share for no gain.
        .layer(
            tower_http::compression::CompressionLayer::new().compress_when(
                tower_http::compression::predicate::DefaultPredicate::new()
                    .and(tower_http::compression::predicate::NotForContentType::const_new(
                        "application/octet-stream",
                    ))
                    .and(|status: StatusCode, _: Version, _: &HeaderMap, _: &Extensions| {
                        status != StatusCode::SWITCHING_PROTOCOLS
                    }),
            ),
        )
        .with_state(app.clone());

    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    info!("listening on {} ({url})", listener.local_addr()?);
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await?;
    // Everything already accepted is committed before the process leaves, so a
    // restart does not silently drop the last reports. A failure here is
    // reported rather than swallowed: an operator shutting the hub down is
    // entitled to know that a write did not land.
    if let Err(e) = app.db.close() {
        warn!("closing the database cleanly failed: {e:#}");
    }
    Ok(())
}

/// Waits for whichever stop signal arrives first. SIGTERM is the significant
/// one: it is how systemd stops a service, and without handling it a deploy
/// terminates the hub outright rather than letting it finish in-flight
/// requests.
async fn shutdown() {
    // SIGTERM can always be registered; a failure here indicates a broken
    // runtime, and falling back to Ctrl-C alone would reinstate the problem
    // described above.
    let mut term = signal(SignalKind::terminate()).expect("listen for SIGTERM");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    info!("shutting down");
}

/// The address printed at startup: `--site` when given, otherwise the listen
/// address with any wildcard resolved to a concrete one, since
/// `http://0.0.0.0:28080` cannot be opened in a browser.
fn advertised_url(site: &str, listen: SocketAddr) -> String {
    if !site.is_empty() {
        return site.to_owned();
    }
    let ip =
        if listen.ip().is_unspecified() { outbound_ip().unwrap_or_else(|| listen.ip()) } else { listen.ip() };
    format!("http://{}", SocketAddr::new(ip, listen.port()))
}

/// This host's own address on its outbound route. Asking the kernel to route a
/// datagram it never sends is the cheapest way to select one interface among
/// several, and it answers without any network traffic. Behind NAT it yields the
/// private address, since the hub cannot know its public one. The native Hub
/// installer requires --site instead of guessing it.
fn outbound_ip() -> Option<IpAddr> {
    [("0.0.0.0:0", "1.1.1.1:80"), ("[::]:0", "[2606:4700:4700::1111]:80")].into_iter().find_map(
        |(bind, route_to)| {
            let socket = std::net::UdpSocket::bind(bind).ok()?;
            socket.connect(route_to).ok()?;
            socket.local_addr().ok().map(|addr| addr.ip())
        },
    )
}

/// True when the hub's own address transmits cookies and tokens in the clear.
/// Plain HTTP to loopback is local development; to anything else it means the
/// session cookie is readable by every intermediate hop.
///
/// A hub behind a TLS-terminating proxy or tunnel is excluded by either route:
/// `--site` is then the https:// address even though the listener speaks plain
/// HTTP, and without one the listener is on loopback, unreachable by others.
fn exposed_over_plain_http(site: &str) -> bool {
    let Some(rest) = site.strip_prefix("http://") else {
        return false;
    };
    !host_is_loopback(rest)
}

/// Loopback test over an `authority` such as `example.com:8080` or `[::1]:8080`.
/// IPv6 literals are bracketed, so the port is not split off at the first
/// colon.
fn host_is_loopback(authority: &str) -> bool {
    let authority = authority.split('/').next().unwrap_or("");
    // RFC 3986 places userinfo before the host, so `127.0.0.1:28080@example.com`
    // reads as loopback to any check splitting at the first colon while the
    // browser resolves the name that follows -- and this decides whether the
    // plaintext warning is printed at all. `provisioning_allowed` parses --site
    // with reqwest::Url and strips it there; both must agree.
    let authority = authority.rsplit('@').next().unwrap_or("");
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    // Parsed rather than prefix-matched: `127.example.com` is a registered name
    // resolving wherever its owner points it, and reading it as loopback would
    // suppress the only warning that the cookie travels in the clear.
    host.is_empty() || host == "localhost" || host.parse::<IpAddr>().is_ok_and(|a| a.is_loopback())
}

/// Creates the first administrator credential. Interactive development still
/// prints it; a native service writes it to a 0600 file instead so it never
/// reaches the journal through stdout.
fn first_run(app: &App, url: &str) -> Result<()> {
    if app.db.get("admin_password_hash").is_some() {
        return Ok(());
    }
    let password = auth::random_token()[..24].to_owned();
    let hash = auth::hash_password(&password)?;
    if let Some(path) = &app.bootstrap_password_file {
        write_bootstrap_credential(path, &password)?;
        if let Err(error) = app.db.set("admin_password_hash", &hash) {
            // Do not leave a credential on disk for a database that does not
            // know it. A crash between file write and database write leaves the
            // file in place; the next start refuses to overwrite it, which is
            // the safe direction for a one-time secret.
            let _ = std::fs::remove_file(path);
            return Err(error);
        }
        info!("bootstrap administrator credential written to {}", path.display());
        println!("romi Hub is ready; the first-run credential is in {}", path.display());
    } else {
        app.db.set("admin_password_hash", &hash)?;
        println!(
            "\n  romi Hub is ready.\n\n  \
             Sign in at {url}/admin\n  \
             Emergency password: {password}\n\n  \
             This is shown once. Change it, and set up GitHub sign-in, under Security.\n"
        );
    }
    Ok(())
}

/// Write a one-time secret with `O_EXCL`, mode 0600, and no overwrite. The
/// parent directory must already be writable by the Hub service account.
fn write_bootstrap_credential(path: &StdPath, password: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut file = options.open(path).with_context(|| {
        format!(
            "cannot create bootstrap credential {} (it may already exist; refusing to overwrite)",
            path.display()
        )
    })?;
    file.write_all(password.as_bytes())
        .with_context(|| format!("cannot write bootstrap credential {}", path.display()))?;
    file.write_all(b"\n").with_context(|| format!("cannot write bootstrap credential {}", path.display()))?;
    file.sync_all().with_context(|| format!("cannot sync bootstrap credential {}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("cannot restrict bootstrap credential {}", path.display()))?;
    Ok(())
}

/// Billing cycles as whole months. `once` has none, so it never rolls over.
fn cycle_months(cycle: &str) -> Option<u32> {
    Some(match cycle {
        "monthly" => 1,
        "quarterly" => 3,
        "semiannual" => 6,
        "yearly" => 12,
        "biennial" => 24,
        "triennial" => 36,
        _ => return None,
    })
}

/// A node still reporting past its expiry date has been renewed, so the date is
/// rolled forward by whole cycles until it lies in the future.
fn renewed(expires: NaiveDate, cycle: &str, today: NaiveDate) -> Option<NaiveDate> {
    let months = Months::new(cycle_months(cycle)?);
    let mut next = expires;
    while next < today {
        next = next.checked_add_months(months)?;
    }
    (next != expires).then_some(next)
}

fn renew_online_nodes(app: &App) -> Result<()> {
    // The hub's local timezone, as with the traffic boundaries: an expiry date
    // is one a person entered, and on a UTC+8 hub `Utc` reports the previous day
    // until 08:00 while the panel already shows it expired.
    let today = Local::now().date_naive();
    let online: Vec<i64> = app.agents.read().unwrap_or_else(|e| e.into_inner()).keys().copied().collect();
    let nodes = app.db.nodes()?;
    let mut rolled = Vec::new();
    for node in &nodes {
        if !online.contains(&node.id) {
            continue;
        }
        let Some(expires) = node.expires_at.as_deref().and_then(|d| d.parse::<NaiveDate>().ok()) else {
            continue;
        };
        let Some(next) = renewed(expires, &node.billing_cycle, today) else { continue };
        app.db.set_expiry(node.id, &next.to_string())?;
        info!("node {} is still up past {expires}, expiry rolled to {next}", node.name);
        rolled.push((node.name.as_str(), format!("{expires} → {next}")));
    }
    notify::renewed(app, rolled);
    Ok(())
}

/// Expires sessions, trims history, rolls over expiry dates and sends the daily
/// expiry digest, once an hour.
async fn housekeeping(app: Shared) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3_600));
    loop {
        ticker.tick().await;
        let keep = app.db.retention_days();
        if let Err(e) = app.db.prune(keep) {
            warn!("pruning history failed: {e:#}");
        }
        if let Err(e) = app.db.expire_sessions() {
            warn!("expiring sessions failed: {e:#}");
        }
        if let Err(e) = renew_online_nodes(&app) {
            warn!("rolling expiry dates failed: {e:#}");
        }
        // After the roll-over, so the digest lists dates as they now stand.
        match notify::expiry_digest(&app, Local::now()) {
            Ok(Some(note)) => notify::send(&app, note),
            Ok(None) => {}
            Err(e) => warn!("expiry digest failed: {e:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::{StatusCode, Uri};

    fn app(site: &str) -> App {
        App::new(
            Db::open(":memory:").unwrap(),
            site.into(),
            PathBuf::from("themes"),
            tokio::sync::mpsc::channel(1).0,
        )
    }

    /// A request as a reverse proxy would forward it, or as it arrives with none
    /// in front.
    fn proto(forwarded: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(scheme) = forwarded {
            headers.insert("x-forwarded-proto", scheme.parse().unwrap());
        }
        headers
    }

    /// Whichever wildcard this kernel supports must parse and carry the default
    /// port; a typo here would surface only as a refused bind at startup.
    #[test]
    fn the_default_listener_is_loopback_on_the_default_port() {
        let addr: SocketAddr = default_listen().parse().expect("the default must parse");
        assert!(addr.ip().is_loopback(), "{addr}");
        assert_eq!(addr.port(), 28_080);
    }

    #[test]
    fn an_expired_node_that_is_still_up_rolls_forward_whole_cycles() {
        let d = |s: &str| s.parse::<NaiveDate>().unwrap();
        // One day past a monthly expiry: the next month, clamped to its end.
        assert_eq!(renewed(d("2026-01-31"), "monthly", d("2026-02-01")), Some(d("2026-02-28")));
        // Years overdue: cycles are added until the date is in the future.
        assert_eq!(renewed(d("2024-03-10"), "yearly", d("2026-08-28")), Some(d("2027-03-10")));
        // Not yet due, and one-off billing: both left unchanged.
        assert_eq!(renewed(d("2026-09-01"), "monthly", d("2026-08-28")), None);
        assert_eq!(renewed(d("2020-01-01"), "once", d("2026-08-28")), None);
    }

    #[tokio::test]
    async fn an_unknown_api_path_is_a_404_not_the_single_page_app() {
        let app = Arc::new(app("http://localhost:8080"));
        let spa = |p: &str| frontend::serve(State(app.clone()), HeaderMap::new(), p.parse::<Uri>().unwrap());

        // The case that would conceal a misconfigured OAuth callback.
        assert_eq!(spa("/api/oauth_callback?code=x").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(spa("/api/nope").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(spa("/api").await.status(), StatusCode::NOT_FOUND);

        // Client-side routes still fall through to the app.
        assert_eq!(spa("/admin").await.status(), StatusCode::OK);
        assert_eq!(spa("/").await.status(), StatusCode::OK);
        // A path merely beginning with "api" is not an API path.
        assert_eq!(spa("/apiary").await.status(), StatusCode::OK);
    }

    /// A build writes hashed filenames under `assets/`, so a miss there means a
    /// tab left open across a deploy. Answering with index.html would hand a
    /// script tag HTML, failing on MIME type long after the request that caused
    /// it. Both bundles share the same fallback, so both must refuse.
    #[tokio::test]
    async fn a_missing_hashed_asset_is_a_404_not_the_single_page_app() {
        let app = Arc::new(app("http://localhost:8080"));
        let spa = |p: &str| frontend::serve(State(app.clone()), HeaderMap::new(), p.parse::<Uri>().unwrap());

        assert_eq!(spa("/assets/index-STALE.js").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(spa("/admin/assets/index-STALE.js").await.status(), StatusCode::NOT_FOUND);

        // A route merely beginning with those letters is still a route.
        assert_eq!(spa("/assetsomething").await.status(), StatusCode::OK);
        // A deep client route still reloads into the app.
        assert_eq!(spa("/node/7").await.status(), StatusCode::OK);
    }

    /// What determines the Secure flag: `--site` when set, otherwise the proxy in
    /// front -- the default ip:port deployment, where the hub does not know its
    /// own address.
    #[test]
    fn the_cookie_flag_follows_site_when_it_is_set_and_the_proxy_when_it_is_not() {
        // Local development: no Secure flag, or the browser discards the cookie
        // entirely.
        for local in ["http://127.0.0.1:28080", "http://localhost:28080", "http://[::1]:28080"] {
            assert!(!app(local).secure_cookies(&proto(None)), "{local}");
            assert!(!exposed_over_plain_http(local), "{local} is not exposed");
        }
        // A configured --site takes precedence over the request in both
        // directions: operator configuration outranks a client-settable header.
        assert!(app("https://hub.example.com").secure_cookies(&proto(Some("http"))));
        assert!(!app("http://hub.example.com").secure_cookies(&proto(Some("https"))));
        assert!(!exposed_over_plain_http("https://m.example.com"));
        // A registered name is not an address however it begins: reading one as
        // loopback would suppress the plaintext-cookie warning.
        assert!(exposed_over_plain_http("http://127.example.com"));
        assert!(exposed_over_plain_http("http://127.0.0.1.nip.io"));
        // Nor is userinfo an address: the host follows the '@', and reading the
        // part before it as loopback suppresses the same warning.
        assert!(exposed_over_plain_http("http://127.0.0.1:28080@hub.example.com"));
        assert!(!app("http://127.0.0.1:28080@hub.example.com").secure_cookies(&proto(None)));

        // Without --site the proxy's header is the only indication of scheme.
        let bare = app("");
        assert!(!bare.secure_cookies(&proto(None)), "plain HTTP, answered directly");
        assert!(bare.secure_cookies(&proto(Some("https"))));
        // Chained proxies append, so the browser's own hop is the first value.
        assert!(bare.secure_cookies(&proto(Some("https, http"))));
        assert!(!bare.secure_cookies(&proto(Some("http, https"))));
    }

    /// A hub serving in the clear must report it, and a wildcard listener is not
    /// an address anyone can open. Both concern the URL the hub advertises, which
    /// is `--site` only when one is set.
    #[test]
    fn the_advertised_url_resolves_a_wildcard_listener_and_defers_to_site() {
        let listen = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert_eq!(
            advertised_url("https://hub.example.com", listen("127.0.0.1:28080")),
            "https://hub.example.com"
        );
        assert_eq!(advertised_url("", listen("127.0.0.1:9911")), "http://127.0.0.1:9911");
        assert_eq!(advertised_url("", listen("[::1]:9911")), "http://[::1]:9911");
        // Genuinely in the clear: warn, and still no Secure flag, which is what
        // makes the warning worth printing.
        for remote in ["http://203.0.113.10:28080", "http://hub.example.com"] {
            assert!(!app(remote).secure_cookies(&proto(None)), "{remote}");
            assert!(exposed_over_plain_http(remote), "{remote} is exposed");
        }

        let resolved = advertised_url("", listen("0.0.0.0:28080"));
        assert!(resolved.starts_with("http://") && resolved.ends_with(":28080"), "{resolved}");
        // A host with no outbound route keeps the wildcard, there being nothing
        // else to print; anywhere else the wildcard must not appear.
        if outbound_ip().is_some() {
            assert!(!resolved.contains("0.0.0.0"), "{resolved}");
            assert!(exposed_over_plain_http(&resolved), "{resolved} is exposed");
        }
    }

    #[test]
    fn the_public_page_requires_explicit_opt_in() {
        let app = app("http://x");
        assert!(!app.public_page());
        app.db.set("public_page", "off").unwrap();
        assert!(!app.public_page());
        app.db.set("public_page", "on").unwrap();
        assert!(app.public_page());
    }

    #[test]
    fn agent_distribution_requires_a_validated_local_artifact() {
        assert_eq!(distribution_unavailable().status(), StatusCode::SERVICE_UNAVAILABLE);
        let app = app("http://x");
        assert!(app.distribution.is_none(), "developer startup must not enable distribution");
    }

    #[test]
    fn a_service_bootstrap_credential_is_a_private_file_not_stdout() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "romi-bootstrap-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("bootstrap-password");
        let mut app = App::new(
            Db::open(":memory:").unwrap(),
            "http://x".into(),
            PathBuf::from("themes"),
            tokio::sync::mpsc::channel(1).0,
        );
        app.bootstrap_password_file = Some(path.clone());
        first_run(&app, "http://x").unwrap();
        let secret = std::fs::read_to_string(&path).unwrap();
        assert!(secret.trim().len() >= 24);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let hash = app.db.get("admin_password_hash").unwrap();
        // Restart must neither rotate the password nor overwrite the file.
        first_run(&app, "http://x").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), secret);
        assert_eq!(app.db.get("admin_password_hash").unwrap(), hash);

        // A pre-existing file is never overwritten by a new first run.
        let other = App::new(
            Db::open(":memory:").unwrap(),
            "http://x".into(),
            PathBuf::from("themes"),
            tokio::sync::mpsc::channel(1).0,
        );
        let mut other = other;
        other.bootstrap_password_file = Some(path.clone());
        assert!(first_run(&other, "http://x").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), secret);

        app.discard_bootstrap_credential();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_github_proxy_prefixes_the_theme_url() {
        let app = app("");
        let url = "https://github.com/example/theme/releases/download/v1/theme.tar.gz";
        assert_eq!(proxied(&app, url.into()), url);
        app.db.set("github_proxy", " https://proxy.example/ ").unwrap();
        assert_eq!(proxied(&app, url.into()), format!("https://proxy.example/{url}"));
        app.db.set("github_proxy", "").unwrap();
        assert_eq!(proxied(&app, url.into()), url);
    }

    #[test]
    fn first_run_sets_a_password_once_and_leaves_it_alone_after() {
        let app = app("http://x");
        first_run(&app, "http://x").unwrap();
        let hash = app.db.get("admin_password_hash").unwrap();
        assert!(hash.starts_with("$argon2"));
        first_run(&app, "http://x").unwrap();
        assert_eq!(app.db.get("admin_password_hash").unwrap(), hash, "must not rotate on restart");
    }

    #[test]
    fn version_identifies_romi_hub_and_uses_a_romi_database_name() {
        assert_eq!(version_line(), format!("romi-hub {}", env!("CARGO_PKG_VERSION")));
        assert!(!version_line().contains("monitor"), "the inherited product name must be gone");
        assert_eq!(DEFAULT_DATABASE, "romi.db");
    }
}
