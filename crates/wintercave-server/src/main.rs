//! WinterCave's local editor server.
//!
//!   cargo run -p wintercave-server -- --port 4173 --root .
//!
//! It serves the editor page and a file API confined to `--root`. Everything —
//! the document model, the tokenizer, the highlighting and the HTTP handlers —
//! is Rust; the browser only needs the tiny script the server serves.

use std::collections::HashMap;
use std::path::Path;

use actix_web::{web, App, HttpServer};

use wintercave_server::api::AppState;
use wintercave_server::config::{self, ParseOutcome};
use wintercave_server::files::{FileService, FileServiceOptions};
use wintercave_server::{configure, paths, ServerError, SERVER_NAME};

fn to_io(error: ServerError) -> std::io::Error {
    std::io::Error::other(error)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env: HashMap<String, String> = std::env::vars().collect();

    let settings = match config::parse_args(&args, &env) {
        Ok(ParseOutcome::Run(settings)) => settings,
        Ok(ParseOutcome::Help) => {
            println!("{}", config::USAGE);
            return Ok(());
        }
        Err(message) => {
            eprintln!("error: {message}\n");
            eprintln!("{}", config::USAGE);
            std::process::exit(2);
        }
    };

    let root = paths::absolute(Path::new(&settings.root)).map_err(to_io)?;
    let files = FileService::new(FileServiceOptions {
        root: root.clone(),
        max_bytes: settings.max_bytes,
        read_only: settings.read_only,
    })
    .map_err(to_io)?;

    let version = env!("CARGO_PKG_VERSION").to_string();
    let state = AppState {
        files,
        version: version.clone(),
    };

    println!("{SERVER_NAME} {version}");
    println!("  root: {}", root.display());
    if settings.read_only {
        println!("  mode: read only");
    }

    let shared = state.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(shared.clone()))
            .configure(configure)
    })
    .bind((settings.host.as_str(), settings.port))?;

    for address in server.addrs() {
        println!("listening on http://{address}");
    }

    server.run().await
}
