//! WinterCave's local server, on actix-web.
//!
//! Two jobs, same as the TypeScript server it mirrors: serve the built web shell
//! out of `dist/`, and expose a file API (`/api/files`, `/api/tree`,
//! `/api/health`) confined to a root directory. The JSON contract, the error
//! codes and the confinement rules are identical, so the web shell does not care
//! which server it is talking to — see `docs/actix-server.md`.

pub mod api;
pub mod config;
pub mod error;
pub mod files;
pub mod paths;
pub mod static_files;

use actix_web::{guard, web};

pub use api::AppState;
pub use config::{parse_args, Config, ParseOutcome, USAGE};
pub use error::ServerError;
pub use files::{FileService, FileServiceOptions, DEFAULT_MAX_BYTES};
pub use static_files::StaticOptions;

pub const SERVER_NAME: &str = "wintercave-server";

/// Largest request body the file API accepts, in bytes.
pub const BODY_LIMIT: usize = 12_000_000;

/// Register the `/api` scope. The caller adds the static default service, so
/// this one function serves both `main.rs` and the integration tests.
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .service(
                web::resource("/health")
                    .route(web::get().to(api::health))
                    .route(web::route().guard(guard::Options()).to(api::preflight))
                    .route(web::route().to(api::method_not_allowed)),
            )
            .service(
                web::resource("/files")
                    .route(web::get().to(api::read_file))
                    .route(web::put().to(api::put_file))
                    .route(web::post().to(api::post_file))
                    .route(web::delete().to(api::delete_file))
                    .route(web::route().guard(guard::Options()).to(api::preflight))
                    .route(web::route().to(api::method_not_allowed)),
            )
            .service(
                web::resource("/tree")
                    .route(web::get().to(api::tree))
                    .route(web::route().guard(guard::Options()).to(api::preflight))
                    .route(web::route().to(api::method_not_allowed)),
            )
            .default_service(web::to(api::unknown_endpoint)),
    );
}
