//! WinterCave's local server, on actix-web.
//!
//!   cargo run -p wintercave-server -- --port 4173 --root . --dist dist
//!
//! It serves the built web shell and a file API confined to `--root`. The same
//! job `server/index.ts` does, in Rust, because that is what this crate is for.

use std::collections::HashMap;
use std::path::Path;

use actix_web::{web, App, HttpServer};

use wintercave_server::api::{serve_static, AppState};
use wintercave_server::config::{self, ParseOutcome};
use wintercave_server::files::{FileService, FileServiceOptions};
use wintercave_server::static_files::StaticOptions;
use wintercave_server::{configure, paths, ServerError, BODY_LIMIT, SERVER_NAME};

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

    let assets = match settings.dist.as_ref() {
        Some(dist) => Some(StaticOptions::new(
            paths::absolute(Path::new(dist)).map_err(to_io)?,
        )),
        None => None,
    };

    let version = env!("CARGO_PKG_VERSION").to_string();
    let state = AppState {
        files,
        version: version.clone(),
        assets,
    };

    println!("{SERVER_NAME} {version}");
    println!("  root: {}", root.display());
    match settings.dist.as_ref() {
        Some(dist) => println!("  dist: {dist}"),
        None => println!("  dist: (API only)"),
    }

    let shared = state.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(shared.clone()))
            .app_data(web::PayloadConfig::new(BODY_LIMIT))
            .configure(configure)
            .default_service(web::to(serve_static))
    })
    .bind((settings.host.as_str(), settings.port))?;

    let addresses = server.addrs();
    for address in &addresses {
        println!("listening on http://{address}");
    }

    server.run().await
}
