use crate::{api::Admin, Shared};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use maxminddb::Reader;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Mutex, RwLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 32 * 1024 * 1024;
#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub state: String,
    pub received: usize,
    pub error: String,
    pub configured: bool,
}
pub struct Geo {
    path: PathBuf,
    reader: RwLock<Option<Reader<Vec<u8>>>>,
    active: Mutex<Option<CancellationToken>>,
    status: Mutex<Status>,
}
impl Geo {
    pub fn new(path: PathBuf) -> Self {
        let reader =
            std::fs::read(&path).ok().filter(|b| b.len() <= MAX_BYTES).and_then(|b| validate(b).ok());
        let configured = reader.is_some();
        Self {
            path,
            reader: RwLock::new(reader),
            active: Mutex::new(None),
            status: Mutex::new(Status { state: "idle".into(), configured, ..Default::default() }),
        }
    }
    pub fn country(&self, ip: &str) -> Option<String> {
        let lock = self.reader.read().ok()?;
        let reader = lock.as_ref()?;
        reader
            .lookup(ip.parse().ok()?)
            .ok()?
            .decode_path::<String>(&maxminddb::path!["country", "iso_code"])
            .ok()?
            .filter(|cc| cc.len() == 2 && cc.bytes().all(|c| c.is_ascii_uppercase()))
    }
}
pub fn valid_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
    })
}
fn validate(bytes: Vec<u8>) -> anyhow::Result<Reader<Vec<u8>>> {
    let reader = Reader::from_source(bytes)?;
    anyhow::ensure!(
        matches!(reader.metadata().database_type.as_str(), "GeoLite2-Country" | "GeoIP2-Country"),
        "需要 Country 类型的 MMDB 数据库"
    );
    reader.verify()?;
    Ok(reader)
}
pub async fn status(_: Admin, State(app): State<Shared>) -> Json<Status> {
    Json(app.geo.status.lock().unwrap_or_else(|e| e.into_inner()).clone())
}
pub async fn cancel(_: Admin, State(app): State<Shared>) -> StatusCode {
    if let Some(token) = app.geo.active.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        token.cancel();
    }
    StatusCode::NO_CONTENT
}
pub async fn update(_: Admin, State(app): State<Shared>) -> Response {
    let url = app.db.get("geolite_url").unwrap_or_default();
    if !valid_url(&url) {
        return (StatusCode::BAD_REQUEST, "请先保存 HTTPS 数据库直链").into_response();
    }
    let token = CancellationToken::new();
    {
        let mut active = app.geo.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return (StatusCode::CONFLICT, "已有更新正在进行").into_response();
        }
        *active = Some(token.clone());
    }
    {
        let mut status = app.geo.status.lock().unwrap_or_else(|e| e.into_inner());
        status.state = "downloading".into();
        status.received = 0;
        status.error.clear();
    }
    tokio::spawn(async move {
        let fetched = tokio::select! { _=token.cancelled()=>Err(anyhow::anyhow!("已取消")), result=tokio::time::timeout(Duration::from_secs(120),download(&app,&url))=>result.unwrap_or_else(|_|Err(anyhow::anyhow!("更新超时"))) };
        let result = match fetched {
            Ok(bytes) => install(app.clone(), bytes, token.clone()).await,
            Err(e) => Err(e),
        };
        let cancelled = token.is_cancelled();
        if result.is_err() {
            token.cancel();
        }
        let mut status = app.geo.status.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok(()) => {
                status.state = "complete".into();
                status.configured = true;
            }
            Err(e) => {
                status.state = if cancelled { "cancelled" } else { "error" }.into();
                status.error = e.to_string();
            }
        }
        *app.geo.active.lock().unwrap_or_else(|e| e.into_inner()) = None;
    });
    (StatusCode::ACCEPTED, Json(serde_json::json!({"accepted":true}))).into_response()
}
async fn download(app: &Shared, url: &str) -> anyhow::Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(110))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !valid_url(attempt.url().as_str()) {
                attempt.error("invalid download redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    anyhow::ensure!(response.content_length().is_none_or(|n| n <= MAX_BYTES as u64), "数据库超过 32 MiB");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(bytes.len() + chunk.len() <= MAX_BYTES, "数据库超过 32 MiB");
        bytes.extend_from_slice(&chunk);
        app.geo.status.lock().unwrap_or_else(|e| e.into_inner()).received = bytes.len();
    }
    Ok(bytes)
}
async fn install(app: Shared, bytes: Vec<u8>, token: CancellationToken) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || {
        let reader = validate(bytes.clone())?;
        anyhow::ensure!(!token.is_cancelled(), "已取消");
        if let Some(parent) = app.geo.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = app.geo.path.with_extension("tmp");
        let result = (|| -> anyhow::Result<()> {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            let _commit = app.geo.active.lock().unwrap_or_else(|e| e.into_inner());
            anyhow::ensure!(!token.is_cancelled(), "已取消");
            std::fs::rename(&temp, &app.geo.path)?;
            *app.geo.reader.write().unwrap_or_else(|e| e.into_inner()) = Some(reader);
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result?;
        for node in app.db.nodes().unwrap_or_default() {
            if let Some(cc) = app.geo.country(&node.ip) {
                if let Err(e) = app.db.set_country(node.id, &cc, &node.ip) {
                    tracing::warn!("country refresh failed: {e}");
                }
            }
        }
        crate::api::invalidate_snapshot(&app);
        Ok(())
    })
    .await?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn verified_country_database_replaces_atomically_and_failed_or_cancelled_work_keeps_it() {
        let root = std::env::temp_dir().join(format!("romi-geo-{}", rand::random::<u64>()));
        let path = root.join("country.mmdb");
        let mut app = crate::App::for_test(crate::db::Db::open(":memory:").unwrap());
        app.geo = Geo::new(path.clone());
        let app = std::sync::Arc::new(app);
        let bytes = include_bytes!("../testdata/maxmind/GeoIP2-Country-Test.mmdb").to_vec();
        install(app.clone(), bytes.clone(), CancellationToken::new()).await.unwrap();
        assert_eq!(app.geo.country("81.2.69.160").as_deref(), Some("GB"));
        assert_eq!(Geo::new(path.clone()).country("81.2.69.160").as_deref(), Some("GB"));
        assert!(install(app.clone(), b"not mmdb".to_vec(), CancellationToken::new()).await.is_err());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(install(app.clone(), bytes.clone(), cancel).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!path.with_extension("tmp").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn url_and_database_validation() {
        assert!(valid_url("https://example.com/country.mmdb"));
        for url in ["http://example.com/a", "https://a:b@example.com/a", "file:///tmp/a"] {
            assert!(!valid_url(url));
        }
        assert!(validate(b"<html>not a database</html>".to_vec()).is_err());
    }
}
