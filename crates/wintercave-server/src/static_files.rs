//! Static hosting for the built web shell — the same rules as `server/static.ts`.
//!
//! Anything that is not `/api/*` lands here; unknown extension-less paths fall
//! back to `index.html` so deep links keep working. Responses carry an ETag so
//! the browser can revalidate the wasm bundle instead of downloading it again.

use std::path::{Path, PathBuf};

use actix_web::http::{header, Method, StatusCode};
use actix_web::HttpResponse;

use crate::files::mtime_ms;
use crate::paths;

#[derive(Debug, Clone)]
pub struct StaticOptions {
    /// Directory holding the built app.
    pub directory: PathBuf,
    /// Serve `index.html` for unknown extension-less paths.
    pub spa_fallback: bool,
}

impl StaticOptions {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            spa_fallback: true,
        }
    }
}

pub fn content_type_for(file_name: &str) -> &'static str {
    let extension = Path::new(file_name)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

pub fn etag_for(size: u64, mtime: f64) -> String {
    format!("\"{:x}-{:x}\"", size, mtime.max(0.0) as u64)
}

/// Percent-decode a request path. `None` means the path was malformed.
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Answer a static request. Never panics and never escapes the asset directory.
pub fn serve(
    assets: &StaticOptions,
    url_path: &str,
    method: &Method,
    if_none_match: Option<&str>,
) -> HttpResponse {
    let relative = url_path.trim_start_matches('/');

    if relative.is_empty() {
        return match send_file(assets, "index.html", if_none_match) {
            Some(response) => response,
            None => not_found(method),
        };
    }

    if let Some(response) = send_file(assets, relative, if_none_match) {
        return response;
    }

    let looks_like_asset = Path::new(relative).extension().is_some();
    if assets.spa_fallback && !looks_like_asset {
        if let Some(response) = send_file(assets, "index.html", if_none_match) {
            return response;
        }
    }

    not_found(method)
}

fn not_found(method: &Method) -> HttpResponse {
    if method == Method::HEAD {
        return HttpResponse::NotFound()
            .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
            .body(Vec::new());
    }
    HttpResponse::NotFound()
        .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
        .body("Not found")
}

/// Map a request path onto a real file inside the asset directory.
fn resolve(assets: &StaticOptions, relative: &str) -> Option<PathBuf> {
    let directory = paths::normalize(&assets.directory);
    let candidate = if relative.is_empty() {
        directory.clone()
    } else {
        paths::normalize(&directory.join(relative))
    };

    if !paths::is_inside(&directory, &candidate) {
        return None;
    }
    if candidate.is_dir() {
        let index = candidate.join("index.html");
        return index.is_file().then_some(index);
    }
    candidate.is_file().then_some(candidate)
}

fn send_file(assets: &StaticOptions, relative: &str, if_none_match: Option<&str>) -> Option<HttpResponse> {
    let file = resolve(assets, relative)?;
    let meta = std::fs::metadata(&file).ok()?;
    let etag = etag_for(meta.len(), mtime_ms(&meta));
    let immutable = !file.to_string_lossy().ends_with("index.html");
    let cache_control = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    if let Some(candidate) = if_none_match {
        if candidate == etag {
            return Some(
                HttpResponse::NotModified()
                    .insert_header((header::ETAG, etag))
                    .insert_header((header::CACHE_CONTROL, cache_control))
                    .finish(),
            );
        }
    }

    let bytes = std::fs::read(&file).ok()?;
    Some(
        HttpResponse::build(StatusCode::OK)
            .insert_header((header::CONTENT_TYPE, content_type_for(&file.to_string_lossy())))
            .insert_header((header::ETAG, etag))
            .insert_header((header::CACHE_CONTROL, cache_control))
            .insert_header(("X-Content-Type-Options", "nosniff"))
            .body(bytes),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_content_types() {
        assert_eq!(content_type_for("app.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.WASM"), "application/wasm");
        assert_eq!(content_type_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("blob"), "application/octet-stream");
    }

    #[test]
    fn decodes_percent_escapes_and_rejects_malformed_input() {
        assert_eq!(percent_decode("/a%20b").unwrap(), "/a b");
        assert_eq!(percent_decode("/plain").unwrap(), "/plain");
        assert!(percent_decode("/bad%2").is_none());
        assert!(percent_decode("/bad%zz").is_none());
    }
}
