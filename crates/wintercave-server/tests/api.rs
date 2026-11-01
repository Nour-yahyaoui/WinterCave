//! Integration tests: the real actix service, a real temp directory on disk.
//!
//! These assert the JSON contract the web shell depends on, so a regression here
//! breaks the editor immediately instead of silently drifting from the
//! TypeScript server's behaviour.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use actix_web::http::{header, Method, StatusCode};
use actix_web::{test, web, App};
use serde_json::Value;

use wintercave_server::api::{serve_static, AppState};
use wintercave_server::files::{FileService, FileServiceOptions};
use wintercave_server::static_files::StaticOptions;
use wintercave_server::{configure, BODY_LIMIT};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    dist: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "wintercave-actix-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let root = base.join("workspace");
        let dist = base.join("dist");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&dist).unwrap();

        std::fs::write(root.join("notes.md"), "# hello\n\nworld\n").unwrap();
        std::fs::write(root.join("crlf.txt"), "a\r\nb\r\n").unwrap();
        std::fs::write(root.join("sub").join("deep.txt"), "deep\n").unwrap();
        std::fs::write(root.join("binary.bin"), [0_u8, 1, 2, 3]).unwrap();
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><title>WinterCave</title>",
        )
        .unwrap();
        std::fs::write(dist.join("app.js"), "console.log('hi')").unwrap();

        Self { base, root, dist }
    }

    fn state(&self, read_only: bool) -> AppState {
        self.state_with(read_only, 1_000_000)
    }

    fn state_with(&self, read_only: bool, max_bytes: u64) -> AppState {
        AppState {
            files: FileService::new(FileServiceOptions {
                root: self.root.clone(),
                max_bytes,
                read_only,
            })
            .expect("file service"),
            version: "9.9.9".to_string(),
            assets: Some(StaticOptions::new(self.dist.clone())),
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

macro_rules! service {
    ($fixture:expr, $read_only:expr) => {{
        let app = App::new()
            .app_data(web::Data::new($fixture.state($read_only)))
            .app_data(web::PayloadConfig::new(BODY_LIMIT))
            .configure(configure)
            .default_service(web::to(serve_static));
        test::init_service(app).await
    }};
}

macro_rules! service_with {
    ($state:expr) => {{
        let app = App::new()
            .app_data(web::Data::new($state))
            .app_data(web::PayloadConfig::new(BODY_LIMIT))
            .configure(configure)
            .default_service(web::to(serve_static));
        test::init_service(app).await
    }};
}

async fn json_body<B>(response: actix_web::dev::ServiceResponse<B>) -> Value
where
    B: actix_web::body::MessageBody,
{
    test::read_body_json(response).await
}

#[actix_web::test]
async fn health_reports_the_same_contract_as_the_typescript_server() {
    let fixture = Fixture::new("health");
    let app = service!(fixture, false);

    let response = test::call_service(&app, test::TestRequest::get().uri("/api/health").to_request())
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .and_then(|value| value.to_str().ok()),
        Some("*")
    );

    let body = json_body(response).await;
    assert_eq!(body["ok"], Value::Bool(true));
    assert_eq!(body["name"], Value::String("wintercave-server".to_string()));
    assert_eq!(body["version"], Value::String("9.9.9".to_string()));
    assert_eq!(body["readOnly"], Value::Bool(false));
    assert_eq!(body["maxBytes"], Value::from(1_000_000));
    assert!(body["root"].as_str().unwrap().ends_with("workspace"));
}

#[actix_web::test]
async fn reads_a_file_with_metadata() {
    let fixture = Fixture::new("read");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=notes.md")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    assert_eq!(body["path"], Value::String("notes.md".to_string()));
    assert_eq!(body["name"], Value::String("notes.md".to_string()));
    assert_eq!(body["text"], Value::String("# hello\n\nworld\n".to_string()));
    assert_eq!(body["lineEnding"], Value::String("lf".to_string()));
    assert_eq!(body["size"], Value::from(15));
    assert_eq!(body["readOnly"], Value::Bool(false));
    assert!(body["mtime"].as_f64().unwrap() > 0.0);
}

#[actix_web::test]
async fn detects_crlf_line_endings() {
    let fixture = Fixture::new("crlf");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=crlf.txt")
            .to_request(),
    )
    .await;
    let body = json_body(response).await;
    assert_eq!(body["lineEnding"], Value::String("crlf".to_string()));
}

#[actix_web::test]
async fn missing_files_and_directories_report_distinct_codes() {
    let fixture = Fixture::new("missing");
    let app = service!(fixture, false);

    let missing = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=nope.txt")
            .to_request(),
    )
    .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let body = json_body(missing).await;
    assert_eq!(body["error"]["code"], Value::String("not_found".to_string()));

    let directory = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/files?path=sub").to_request(),
    )
    .await;
    assert_eq!(directory.status(), StatusCode::CONFLICT);
    let body = json_body(directory).await;
    assert_eq!(
        body["error"]["code"],
        Value::String("is_a_directory".to_string())
    );
}

#[actix_web::test]
async fn refuses_paths_that_escape_the_workspace() {
    let fixture = Fixture::new("escape");
    std::fs::write(fixture.base.join("outside.txt"), "secret\n").unwrap();
    let app = service!(fixture, false);

    let traversal = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=../outside.txt")
            .to_request(),
    )
    .await;
    assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
    let body = json_body(traversal).await;
    assert_eq!(body["error"]["code"], Value::String("bad_path".to_string()));

    let absolute = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=/etc/passwd")
            .to_request(),
    )
    .await;
    assert_eq!(absolute.status(), StatusCode::BAD_REQUEST);

    let empty = test::call_service(&app, test::TestRequest::get().uri("/api/files").to_request())
        .await;
    assert_eq!(empty.status(), StatusCode::BAD_REQUEST);
}

#[actix_web::test]
async fn put_updates_an_existing_file_atomically() {
    let fixture = Fixture::new("put");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/files?path=notes.md")
            .set_payload(r#"{"text":"rewritten\n"}"#)
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["path"], Value::String("notes.md".to_string()));
    assert_eq!(body["size"], Value::from(10));

    assert_eq!(
        std::fs::read_to_string(fixture.path("notes.md")).unwrap(),
        "rewritten\n"
    );
    // No temp file may survive a successful write.
    let names: Vec<String> = std::fs::read_dir(&fixture.root)
        .unwrap()
        .map(|item| item.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(names.is_empty(), "left temp files behind: {names:?}");
}

#[actix_web::test]
async fn put_needs_create_for_a_new_file_but_post_does_not() {
    let fixture = Fixture::new("create");
    let app = service!(fixture, false);

    let strict = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/files?path=fresh.txt")
            .set_payload(r#"{"text":"hi"}"#)
            .to_request(),
    )
    .await;
    assert_eq!(strict.status(), StatusCode::NOT_FOUND);

    let created = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/files?path=nested/deeper/fresh.txt")
            .set_payload(r#"{"text":"hi\n"}"#)
            .to_request(),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(
        std::fs::read_to_string(fixture.path("nested/deeper/fresh.txt")).unwrap(),
        "hi\n"
    );

    let flagged = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/files?path=flagged.txt")
            .set_payload(r#"{"text":"ok","create":true}"#)
            .to_request(),
    )
    .await;
    assert_eq!(flagged.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(fixture.path("flagged.txt")).unwrap(),
        "ok"
    );
}

#[actix_web::test]
async fn rejects_malformed_bodies() {
    let fixture = Fixture::new("body");
    let app = service!(fixture, false);

    let invalid_json = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/files?path=notes.md")
            .set_payload("not json")
            .to_request(),
    )
    .await;
    assert_eq!(invalid_json.status(), StatusCode::BAD_REQUEST);
    let body = json_body(invalid_json).await;
    assert_eq!(body["error"]["code"], Value::String("bad_json".to_string()));

    let missing_text = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/files?path=notes.md")
            .set_payload(r#"{"nope":true}"#)
            .to_request(),
    )
    .await;
    assert_eq!(missing_text.status(), StatusCode::BAD_REQUEST);
    let body = json_body(missing_text).await;
    assert_eq!(body["error"]["code"], Value::String("bad_body".to_string()));
}

#[actix_web::test]
async fn delete_removes_a_file() {
    let fixture = Fixture::new("delete");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::delete()
            .uri("/api/files?path=notes.md")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["path"], Value::String("notes.md".to_string()));
    assert!(!fixture.path("notes.md").exists());

    let again = test::call_service(
        &app,
        test::TestRequest::delete()
            .uri("/api/files?path=notes.md")
            .to_request(),
    )
    .await;
    assert_eq!(again.status(), StatusCode::NOT_FOUND);
}

#[actix_web::test]
async fn read_only_servers_refuse_writes() {
    let fixture = Fixture::new("readonly");
    let app = service!(fixture, true);

    let write = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/files?path=notes.md")
            .set_payload(r#"{"text":"nope"}"#)
            .to_request(),
    )
    .await;
    assert_eq!(write.status(), StatusCode::FORBIDDEN);
    let body = json_body(write).await;
    assert_eq!(body["error"]["code"], Value::String("read_only".to_string()));

    let delete = test::call_service(
        &app,
        test::TestRequest::delete()
            .uri("/api/files?path=notes.md")
            .to_request(),
    )
    .await;
    assert_eq!(delete.status(), StatusCode::FORBIDDEN);

    // Reads still work, and the record says so.
    let read = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=notes.md")
            .to_request(),
    )
    .await;
    assert_eq!(read.status(), StatusCode::OK);
    let body = json_body(read).await;
    assert_eq!(body["readOnly"], Value::Bool(true));
}

#[actix_web::test]
async fn refuses_binary_files_and_oversized_files() {
    let fixture = Fixture::new("limits");
    let app = service!(fixture, false);

    let binary = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=binary.bin")
            .to_request(),
    )
    .await;
    assert_eq!(binary.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let body = json_body(binary).await;
    assert_eq!(body["error"]["code"], Value::String("binary".to_string()));

    let small = service_with!(fixture.state_with(false, 4));
    let oversized = test::call_service(
        &small,
        test::TestRequest::get()
            .uri("/api/files?path=notes.md")
            .to_request(),
    )
    .await;
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = json_body(oversized).await;
    assert_eq!(body["error"]["code"], Value::String("too_large".to_string()));
}

#[actix_web::test]
async fn tree_lists_directories_first_and_ignores_noise() {
    let fixture = Fixture::new("tree");
    std::fs::create_dir_all(fixture.path("node_modules")).unwrap();
    std::fs::create_dir_all(fixture.path(".git")).unwrap();
    std::fs::write(fixture.path("aaa.txt"), "a\n").unwrap();
    let app = service!(fixture, false);

    let response = test::call_service(&app, test::TestRequest::get().uri("/api/tree").to_request())
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["path"], Value::String(String::new()));

    let entries = body["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["sub", "aaa.txt", "binary.bin", "crlf.txt", "notes.md"]);

    let first = &entries[0];
    assert_eq!(first["type"], Value::String("dir".to_string()));
    assert!(first.get("size").is_none());
    assert_eq!(entries[1]["type"], Value::String("file".to_string()));
    assert_eq!(entries[1]["path"], Value::String("aaa.txt".to_string()));
    assert!(entries[1]["size"].is_number());
}

#[actix_web::test]
async fn tree_of_a_subdirectory_is_relative_to_it() {
    let fixture = Fixture::new("tree-sub");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/tree?path=sub")
            .to_request(),
    )
    .await;
    let body = json_body(response).await;
    assert_eq!(body["path"], Value::String("sub".to_string()));
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["path"], Value::String("sub/deep.txt".to_string()));
}

#[actix_web::test]
async fn unknown_endpoints_and_methods_are_reported_not_dropped() {
    let fixture = Fixture::new("routing");
    let app = service!(fixture, false);

    let unknown = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/nope").to_request(),
    )
    .await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    let body = json_body(unknown).await;
    assert_eq!(
        body["error"]["code"],
        Value::String("unknown_endpoint".to_string())
    );

    let wrong_method = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/tree")
            .set_payload("{}")
            .to_request(),
    )
    .await;
    assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
    let body = json_body(wrong_method).await;
    assert_eq!(
        body["error"]["code"],
        Value::String("method_not_allowed".to_string())
    );
}

#[actix_web::test]
async fn preflight_answers_options_with_cors_headers() {
    let fixture = Fixture::new("preflight");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/api/files")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_METHODS)
            .and_then(|value| value.to_str().ok()),
        Some("GET, PUT, POST, DELETE, OPTIONS")
    );
}

#[actix_web::test]
async fn serves_the_app_and_falls_back_to_index_for_deep_links() {
    let fixture = Fixture::new("static");
    let app = service!(fixture, false);

    let root = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
    assert_eq!(root.status(), StatusCode::OK);
    assert_eq!(
        root.headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        root.headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-cache")
    );

    let deep_link = test::call_service(
        &app,
        test::TestRequest::get().uri("/some/deep/link").to_request(),
    )
    .await;
    assert_eq!(deep_link.status(), StatusCode::OK);

    let asset = test::call_service(
        &app,
        test::TestRequest::get().uri("/app.js").to_request(),
    )
    .await;
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(
        asset
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );

    let missing_asset = test::call_service(
        &app,
        test::TestRequest::get().uri("/missing.js").to_request(),
    )
    .await;
    assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);
}

#[actix_web::test]
async fn revalidates_assets_with_etags() {
    let fixture = Fixture::new("etag");
    let app = service!(fixture, false);

    let first = test::call_service(
        &app,
        test::TestRequest::get().uri("/app.js").to_request(),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap()
        .to_string();

    let second = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/app.js")
            .insert_header((header::IF_NONE_MATCH, etag))
            .to_request(),
    )
    .await;
    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
}

#[actix_web::test]
async fn api_only_mode_serves_nothing_else() {
    let fixture = Fixture::new("api-only");
    let mut state = fixture.state(false);
    state.assets = None;
    let app = service_with!(state);

    let response = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], Value::String("not_found".to_string()));

    let health = test::call_service(&app, test::TestRequest::get().uri("/api/health").to_request())
        .await;
    assert_eq!(health.status(), StatusCode::OK);
}
