//! The editor's own assets, compiled into the binary with `include_str!`.
//!
//! There is no build step and no `dist/` directory: `cargo run` is the whole
//! program. The assets are two small files that a browser can read on its own,
//! and they carry an ETag so a reload does not re-download them.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use actix_web::http::{header, StatusCode};
use actix_web::{HttpRequest, HttpResponse};

pub const EDITOR_JS: &str = include_str!("../assets/editor.js");
pub const EDITOR_CSS: &str = include_str!("../assets/editor.css");

fn etag_for(body: &str) -> String {
    let mut hasher = DefaultHasher::new();
    body.hash(&mut hasher);
    format!("\"{:x}-{:x}\"", body.len(), hasher.finish())
}

fn respond(request: &HttpRequest, body: &'static str, content_type: &'static str) -> HttpResponse {
    let etag = etag_for(body);
    let matches = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == etag)
        .unwrap_or(false);

    if matches {
        return HttpResponse::NotModified()
            .insert_header((header::ETAG, etag))
            .insert_header((header::CACHE_CONTROL, "no-cache"))
            .finish();
    }

    HttpResponse::build(StatusCode::OK)
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header((header::ETAG, etag))
        .insert_header((header::CACHE_CONTROL, "no-cache"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .body(body)
}

pub async fn serve_js(request: HttpRequest) -> HttpResponse {
    respond(&request, EDITOR_JS, "text/javascript; charset=utf-8")
}

pub async fn serve_css(request: HttpRequest) -> HttpResponse {
    respond(&request, EDITOR_CSS, "text/css; charset=utf-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assets_are_embedded_and_non_empty() {
        assert!(EDITOR_JS.len() > 500, "editor.js looks empty");
        assert!(EDITOR_CSS.len() > 500, "editor.css looks empty");
        assert!(EDITOR_JS.contains("/api/highlight"));
        assert!(EDITOR_CSS.contains(".t-keyword"));
    }

    #[test]
    fn etags_differ_per_content() {
        assert_ne!(etag_for("a"), etag_for("b"));
        assert_eq!(etag_for("a"), etag_for("a"));
    }
}
