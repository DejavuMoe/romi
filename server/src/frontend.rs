//! Embedded administrative and public interfaces. External executable themes are not supported.
use crate::Shared;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};
#[derive(RustEmbed)]
#[folder = "../admin/dist"]
struct AdminAssets;
#[derive(RustEmbed)]
#[folder = "target/theme/dist"]
struct DefaultThemeAssets;
pub async fn serve(State(_app): State<Shared>, headers: HeaderMap, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let known = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    if path == "api" || path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "no such endpoint").into_response();
    }
    if path == "admin" || path.starts_with("admin/") {
        return embedded::<AdminAssets>(path.strip_prefix("admin").unwrap().trim_start_matches('/'), known);
    }
    embedded::<DefaultThemeAssets>(path, known)
}
fn is_asset(path: &str) -> bool {
    path.starts_with("assets/")
}
fn embedded<T: RustEmbed>(requested: &str, known: Option<&str>) -> Response {
    let path = if requested.is_empty() { "index.html" } else { requested };
    if let Some(file) = T::get(path) {
        return asset(path, file.data.into_owned(), known);
    }
    if is_asset(path) {
        return (StatusCode::NOT_FOUND, "no such asset").into_response();
    }
    match T::get("index.html") {
        Some(file) => asset("index.html", file.data.into_owned(), known),
        None => (StatusCode::SERVICE_UNAVAILABLE, "frontend assets missing").into_response(),
    }
}
fn asset(path: &str, data: Vec<u8>, known: Option<&str>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if is_asset(path) {
        let cache = "public, max-age=31536000, immutable";
        return ([(header::CONTENT_TYPE, mime.as_ref()), (header::CACHE_CONTROL, cache)], data)
            .into_response();
    }
    // Half a SHA-256 of the body, and therefore a strong validator: equal
    // digests mean identical shells.
    let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&data))[..32]);
    let headers = [
        (header::CONTENT_TYPE, mime.as_ref()),
        (header::CACHE_CONTROL, "no-cache"),
        (header::ETAG, etag.as_str()),
    ];
    if known == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    (headers, data).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_revalidates_and_hashed_assets_are_immutable() {
        let response = asset("index.html", b"shell".to_vec(), None);
        let etag = response.headers()[header::ETAG].to_str().unwrap();
        assert_eq!(asset("index.html", b"shell".to_vec(), Some(etag)).status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            asset("assets/test.js", vec![], None).headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
    }
}
