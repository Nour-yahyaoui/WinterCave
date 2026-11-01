//! Request routing and JSON shapes — a mirror of `server/app.ts`.
//!
//! Nothing here touches the disk: `FileService` owns that, `static_files` owns
//! hosting. The handlers are small on purpose so the tests can drive them
//! through a real actix service instead of a mocked one.

use actix_web::http::header;
use actix_web::http::{Method, StatusCode};
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::Value;

use crate::error::ServerError;
use crate::files::FileService;
use crate::static_files::{self, StaticOptions};
use crate::{BODY_LIMIT, SERVER_NAME};

#[derive(Debug, Clone)]
pub struct AppState {
    pub files: FileService,
    pub version: String,
    /// Static hosting; `None` runs the server in API-only mode.
    pub assets: Option<StaticOptions>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    pub path: Option<String>,
}

fn query_path(query: &PathQuery) -> &str {
    query.path.as_deref().unwrap_or("")
}

fn cors_headers(builder: actix_web::HttpResponseBuilder) -> actix_web::HttpResponseBuilder {
    builder.insert_header((header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"))
}

fn json(status: StatusCode, body: &Value) -> HttpResponse {
    cors_headers(HttpResponse::build(status))
        .insert_header((header::CONTENT_TYPE, "application/json; charset=utf-8"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .body(body.to_string())
}

fn error_value(code: &str, message: &str) -> Value {
    serde_json::json!({ "error": { "code": code, "message": message } })
}

fn plain(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
        .body(message.to_string())
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, ServerError> {
    serde_json::to_value(value).map_err(|error| ServerError::internal(error.to_string()))
}

/// Reject an oversized body before reading it, with our own error code.
fn ensure_body_size(request: &HttpRequest) -> Result<(), ServerError> {
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    match declared {
        Some(length) if length > BODY_LIMIT as u64 => {
            Err(ServerError::too_large("Request body is too large."))
        }
        _ => Ok(()),
    }
}

/// A JSON object body, or the same errors the TypeScript server produces.
fn parse_body(bytes: &[u8]) -> Result<Value, ServerError> {
    let text = String::from_utf8_lossy(bytes);
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(value @ Value::Object(_)) => Ok(value),
        Ok(_) => Err(ServerError::new(
            StatusCode::BAD_REQUEST,
            "bad_body",
            "Expected a JSON object.",
        )),
        Err(_) => Err(ServerError::new(
            StatusCode::BAD_REQUEST,
            "bad_json",
            "Request body is not valid JSON.",
        )),
    }
}

pub async fn health(state: web::Data<AppState>) -> Result<HttpResponse, ServerError> {
    let health = state.files.health();
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({
            "ok": true,
            "name": SERVER_NAME,
            "version": &state.version,
            "root": state.files.root().to_string_lossy(),
            "maxBytes": health.max_bytes,
            "readOnly": health.read_only,
        }),
    ))
}

pub async fn read_file(
    state: web::Data<AppState>,
    query: web::Query<PathQuery>,
) -> Result<HttpResponse, ServerError> {
    let record = state.files.read(query_path(&query))?;
    Ok(json(StatusCode::OK, &to_value(&record)?))
}

fn write(
    state: &AppState,
    path: &str,
    body: &[u8],
    method_creates: bool,
) -> Result<HttpResponse, ServerError> {
    let value = parse_body(body)?;
    let text = value.get("text").and_then(Value::as_str);
    let create = method_creates || value.get("create").and_then(Value::as_bool) == Some(true);
    let result = state.files.write(path, text, create)?;
    let status = if method_creates {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok(json(status, &to_value(&result)?))
}

pub async fn put_file(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<PathQuery>,
    body: web::Bytes,
) -> Result<HttpResponse, ServerError> {
    ensure_body_size(&request)?;
    write(&state, query_path(&query), &body, false)
}

pub async fn post_file(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<PathQuery>,
    body: web::Bytes,
) -> Result<HttpResponse, ServerError> {
    ensure_body_size(&request)?;
    write(&state, query_path(&query), &body, true)
}

pub async fn delete_file(
    state: web::Data<AppState>,
    query: web::Query<PathQuery>,
) -> Result<HttpResponse, ServerError> {
    let path = state.files.remove(query_path(&query))?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "path": path })))
}

pub async fn tree(
    state: web::Data<AppState>,
    query: web::Query<PathQuery>,
) -> Result<HttpResponse, ServerError> {
    let requested = query_path(&query);
    let relative = if requested.is_empty() { "." } else { requested };
    let result = state.files.tree(relative)?;
    Ok(json(StatusCode::OK, &to_value(&result)?))
}

pub async fn method_not_allowed(request: HttpRequest) -> HttpResponse {
    let message = if request.path().ends_with("/files") {
        "Use GET, PUT, POST or DELETE."
    } else {
        "Use GET."
    };
    json(StatusCode::METHOD_NOT_ALLOWED, &error_value("method_not_allowed", message))
}

pub async fn unknown_endpoint(request: HttpRequest) -> HttpResponse {
    let message = format!("No endpoint at {}.", request.path());
    json(StatusCode::NOT_FOUND, &error_value("unknown_endpoint", &message))
}

pub async fn preflight() -> HttpResponse {
    HttpResponse::NoContent()
        .insert_header((header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"))
        .insert_header((
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, PUT, POST, DELETE, OPTIONS",
        ))
        .insert_header((header::ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type"))
        .insert_header((header::ACCESS_CONTROL_MAX_AGE, "600"))
        .finish()
}

/// Everything that is not `/api/*`: the built web shell.
pub async fn serve_static(request: HttpRequest) -> HttpResponse {
    let Some(state) = request.app_data::<web::Data<AppState>>().cloned() else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "Server is not configured.");
    };

    let method = request.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return json(
            StatusCode::METHOD_NOT_ALLOWED,
            &error_value("method_not_allowed", "Use GET."),
        );
    }

    let Some(assets) = state.assets.as_ref() else {
        return json(
            StatusCode::NOT_FOUND,
            &error_value("not_found", "Nothing is served here."),
        );
    };

    let Some(decoded) = static_files::percent_decode(request.path()) else {
        return plain(StatusCode::BAD_REQUEST, "Malformed URL");
    };
    if decoded.contains('\0') {
        return plain(StatusCode::BAD_REQUEST, "Malformed URL");
    }

    let if_none_match = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());

    static_files::serve(assets, &decoded, &method, if_none_match)
}
