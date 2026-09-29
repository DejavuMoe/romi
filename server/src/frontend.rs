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
/// Every inline `<script>` body in a shell, in document order.
///
/// Both shells carry exactly one: the theme bootstrap, which has to run before
/// the bundle so a dark session does not flash white. A hashed policy has to
/// name it, and naming it by hashing what is actually served keeps the policy
/// correct whatever the bundler did to the source.
///
/// Elements carrying `src` are skipped -- those are covered by `'self'` -- and
/// so is anything with a `type` other than a classic script, which cannot
/// execute.
fn inline_scripts(html: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        let after = &rest[start + "<script".len()..];
        let Some(open) = after.find('>') else { break };
        let (attributes, body) = after.split_at(open);
        let body = &body[1..];
        let Some(end) = body.find("</script") else { break };
        if !attributes.contains("src=") && !attributes.contains("type=") {
            found.push(&body[..end]);
        }
        rest = &body[end..];
    }
    found
}

/// Content rules for the two shells.
///
/// Everything either app loads is embedded in this binary and served from this
/// origin: no CDN, no external font, no analytics, no external images. So
/// `default-src 'self'` holds, and `connect-src` only adds the WebSocket schemes
/// the live stream uses.
///
/// `frame-ancestors 'none'` is the half that matters most here: the panel makes
/// state-changing requests with a `SameSite=Lax` cookie, which does accompany a
/// framed top-level navigation, and without this the whole UI can be framed by
/// any site. `X-Frame-Options` repeats it for anything predating CSP level 2.
///
/// `style-src` keeps `'unsafe-inline'`: React writes element `style` attributes
/// for the resource bars, and a hash cannot cover those.
fn policy(html: &str) -> String {
    let mut script = String::from("script-src 'self'");
    for body in inline_scripts(html) {
        script.push_str(" 'sha256-");
        script.push_str(&base64(&Sha256::digest(body.as_bytes())));
        script.push('\'');
    }
    format!(
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; {script}; \
         connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'; \
         form-action 'self'; frame-ancestors 'none'"
    )
}

/// Standard base64, which is the encoding CSP hash sources use. Written out
/// rather than pulled in: it runs over a 32-byte digest, twice per shell.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn asset(path: &str, data: Vec<u8>, known: Option<&str>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if is_asset(path) {
        // Hashed, immutable, and not a document: the framing and referrer rules
        // have nothing to act on, and only the sniffing guard is worth carrying.
        let cache = "public, max-age=31536000, immutable";
        return (
            [
                (header::CONTENT_TYPE, mime.as_ref()),
                (header::CACHE_CONTROL, cache),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            data,
        )
            .into_response();
    }
    // Half a SHA-256 of the body, and therefore a strong validator: equal
    // digests mean identical shells.
    let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&data))[..32]);
    let csp = policy(&String::from_utf8_lossy(&data));
    let headers = [
        (header::CONTENT_TYPE, mime.as_ref()),
        (header::CACHE_CONTROL, "no-cache"),
        (header::ETAG, etag.as_str()),
        (header::CONTENT_SECURITY_POLICY, csp.as_str()),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
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

    /// The encoding CSP hash sources use, against the two shapes the padding
    /// takes plus the 32-byte digest length this actually runs on.
    #[test]
    fn base64_matches_the_encoding_csp_expects() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(&Sha256::digest(b"")), "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    }

    /// The shells run one inline script before their bundle, so a policy that
    /// only allowed `'self'` would leave a dark session flashing white. The hash
    /// is taken from the bytes actually served, and elements with `src` or a
    /// module `type` are somebody else's rule.
    #[test]
    fn inline_scripts_are_named_by_hash_and_external_ones_are_not() {
        let html = "<script>alert(1)</script><script src=\"/a.js\"></script>\
                    <script type=\"module\" src=\"/b.js\"></script>";
        assert_eq!(inline_scripts(html), vec!["alert(1)"]);

        let csp = policy(html);
        let digest = base64(&Sha256::digest(b"alert(1)"));
        assert!(csp.contains(&format!("script-src 'self' 'sha256-{digest}'")), "{csp}");
        // The clickjacking half, which is why this exists at all.
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
        assert!(csp.contains("object-src 'none'"), "{csp}");
    }

    /// Both hardening headers ride on the shell; a hashed asset carries only the
    /// sniffing guard, so its bytes stay cacheable as they are.
    #[test]
    fn the_shell_is_hardened_and_assets_stay_plain() {
        let shell = asset("index.html", b"<html></html>".to_vec(), None);
        assert_eq!(shell.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(shell.headers()[header::REFERRER_POLICY], "no-referrer");
        assert!(shell.headers().contains_key(header::CONTENT_SECURITY_POLICY));

        let script = asset("assets/app.js", b"export{}".to_vec(), None);
        assert_eq!(script.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert!(!script.headers().contains_key(header::CONTENT_SECURITY_POLICY));
    }
}
