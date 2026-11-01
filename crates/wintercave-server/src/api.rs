//! Request routing and JSON shapes — a mirror of `server/app.ts`.
//!
//! Nothing here touches the disk: `FileService` owns that, `static_files` owns
//! hosting. The handlers are small on purpose so the tests can drive them
//! through a real actix service instead of a mocked one.

use actix_web::http::header;
use actix_web::http::StatusCode;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::Value;

use crate::error::ServerError;
use crate::files::{FileService, TreeEntry};
use crate::{BODY_LIMIT, SERVER_NAME};
use wintercave_core::fuzzy::fuzzy_filter;

#[derive(Debug, Clone)]
pub struct AppState {
    pub files: FileService,
    pub version: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    pub path: Option<String>,
}

pub(crate) fn query_path(query: &PathQuery) -> &str {
    query.path.as_deref().unwrap_or("")
}

pub(crate) fn json(status: StatusCode, body: &Value) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"))
        .insert_header((header::CONTENT_TYPE, "application/json; charset=utf-8"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .body(body.to_string())
}

fn error_value(code: &str, message: &str) -> Value {
    serde_json::json!({ "error": { "code": code, "message": message } })
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
pub(crate) fn parse_body(bytes: &[u8]) -> Result<Value, ServerError> {
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

/// `POST /api/find` — quick open. Ranks the files below `dir` against `query`
/// with the same subsequence matcher the command palette uses.
pub async fn find_files(
    state: web::Data<AppState>,
    body: web::Bytes,
) -> Result<HttpResponse, ServerError> {
    let value = parse_body(&body)?;
    let query = value.get("query").and_then(Value::as_str).unwrap_or("");
    let dir = value.get("dir").and_then(Value::as_str).unwrap_or("");
    let limit = value
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(40)
        .clamp(1, 200) as usize;

    let walked = state.files.walk(dir)?;
    let files: Vec<TreeEntry> = walked
        .into_iter()
        .filter(|entry| entry.kind == "file")
        .collect();
    let ranked = fuzzy_filter(&files, query, |entry| entry.path.clone(), limit);
    let items: Vec<Value> = ranked
        .iter()
        .map(|found| {
            let entry = &files[found.index];
            serde_json::json!({
                "path": entry.path.clone(),
                "name": entry.name.clone(),
                "score": found.score,
            })
        })
        .collect();

    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "items": items, "query": query, "dir": dir }),
    ))
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
