//! WinterCave: the editor page and the file API, served locally by actix-web.
//!
//! One process, no build step, no client framework. The page is HTML rendered by
//! [`ui`], the syntax highlighting is `wintercave-core` running on the server,
//! and the only client code is the small `assets/editor.js` that carries text
//! between the page and [`api`].
//!
//! ```text
//! GET  /                      the editor page (server rendered)
//! GET  /assets/editor.js      the thin client
//! GET  /assets/editor.css     the stylesheet
//! POST /save?path=            the no-JavaScript form save
//! POST /api/highlight         text in, highlighted HTML out
//! GET  /api/health            server name, version, root, limits
//! GET  /api/files?path=       read a UTF-8 text file
//! PUT  /api/files?path=       replace a file
//! POST /api/files?path=       create a file
//! DEL  /api/files?path=       remove a file
//! GET  /api/tree?path=        list a directory
//! ```

pub mod api;
pub mod assets;
pub mod codec;
pub mod config;
pub mod error;
pub mod files;
pub mod paths;
pub mod ui;

use actix_web::{guard, web};

pub use api::AppState;
pub use config::{parse_args, Config, ParseOutcome, USAGE};
pub use error::ServerError;
pub use files::{FileService, FileServiceOptions, DEFAULT_MAX_BYTES};

pub const SERVER_NAME: &str = "wintercave-server";

/// Largest request body the API accepts, in bytes.
pub const BODY_LIMIT: usize = 12_000_000;

/// Register every route. Kept as one function so `main.rs` and the integration
/// tests build exactly the same application.
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
            .service(
                web::resource("/highlight")
                    .route(web::post().to(ui::highlight_handler))
                    .route(web::route().guard(guard::Options()).to(api::preflight))
                    .route(web::route().to(api::method_not_allowed)),
            )
            .default_service(web::to(api::unknown_endpoint)),
    )
    .service(web::resource("/").route(web::get().to(ui::page)))
    .service(web::resource("/save").route(web::post().to(ui::save_form)))
    .service(web::resource("/assets/editor.js").route(web::get().to(assets::serve_js)))
    .service(web::resource("/assets/editor.css").route(web::get().to(assets::serve_css)))
    .default_service(web::to(ui::not_found));
}
