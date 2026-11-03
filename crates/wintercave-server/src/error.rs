//! The one error type the server returns.
//!
//! Every failure carries an HTTP status, a machine-readable code and a human
//! message, because that is exactly what `server/app.ts` does on the TypeScript
//! side: `{ "error": { "code": "bad_path", "message": "..." } }`.

use std::fmt;

use actix_web::http::{header, StatusCode};
use actix_web::{HttpResponse, ResponseError};

#[derive(Debug)]
pub struct ServerError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ServerError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_path(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_path", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn read_only() -> Self {
        Self::new(StatusCode::FORBIDDEN, "read_only", "This server is read-only.")
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", message)
    }

    pub fn is_a_directory() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "is_a_directory",
            "That path is a directory.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "io_error", message)
    }

    /// Map an OS error onto the same codes the TypeScript server uses.
    pub fn from_io(error: &std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::not_found("No such file."),
            std::io::ErrorKind::PermissionDenied => Self::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Permission denied.",
            ),
            std::io::ErrorKind::IsADirectory => Self::is_a_directory(),
            _ => Self::internal(error.to_string()),
        }
    }

    pub fn body(&self) -> serde_json::Value {
        serde_json::json!({
            "error": { "code": self.code, "message": self.message }
        })
    }
}

impl fmt::Display for ServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for ServerError {}

impl ResponseError for ServerError {
    fn status_code(&self) -> StatusCode {
        self.status
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status)
            .insert_header((header::CONTENT_TYPE, "application/json; charset=utf-8"))
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .insert_header(("X-Content-Type-Options", "nosniff"))
            .body(self.body().to_string())
    }
}
