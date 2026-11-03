//! Integration tests: the real actix application against a real temp workspace.
//!
//! They drive the same `configure()` that `main.rs` uses, so a route that is
//! missing here is missing in the program the user runs.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use actix_web::http::{header, Method, StatusCode};
use actix_web::{test, web, App};
use serde_json::Value;

use wintercave_server::api::AppState;
use wintercave_server::files::{FileService, FileServiceOptions};
use wintercave_server::{configure, BODY_LIMIT};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    base: PathBuf,
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "wintercave-actix-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let root = base.join("workspace");
        std::fs::create_dir_all(root.join("sub")).unwrap();

        std::fs::write(root.join("notes.md"), "# hello\n\nworld\n").unwrap();
        std::fs::write(root.join("crlf.txt"), "a\r\nb\r\n").unwrap();
        std::fs::write(root.join("code.rs"), "let answer = 42; // yes\n").unwrap();
        std::fs::write(root.join("sub").join("deep.txt"), "deep\n").unwrap();
        std::fs::write(root.join("binary.bin"), [0_u8, 1, 2, 3]).unwrap();

        Self { base, root }
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
            .configure(configure);
        test::init_service(app).await
    }};
}

macro_rules! service_with {
    ($state:expr) => {{
        let app = App::new()
            .app_data(web::Data::new($state))
            .configure(configure);
        test::init_service(app).await
    }};
}

async fn json_body<B>(response: actix_web::dev::ServiceResponse<B>) -> Value
where
    B: actix_web::body::MessageBody,
{
    test::read_body_json(response).await
}

async fn text_body<B>(response: actix_web::dev::ServiceResponse<B>) -> String
where
    B: actix_web::body::MessageBody,
{
    let bytes = test::read_body(response).await;
    String::from_utf8_lossy(&bytes).to_string()
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn page_renders_the_workspace_with_highlighted_text() {
    let fixture = Fixture::new("page");
    let app = service!(fixture, false);

    let response = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/html; charset=utf-8")
    );

    let body = text_body(response).await;
    assert!(body.contains("<textarea"), "no editor surface");
    assert!(body.contains("id=\"editor\""));
    assert!(body.contains("/assets/editor.js"));
    assert!(body.contains("/assets/editor.css"));
    // The sidebar lists the whole workspace, binary files included.
    assert!(body.contains("notes.md"));
    assert!(body.contains("binary.bin"));
    // The landing page opens the first file it can actually read (binary.bin
    // sorts first but answers 415), and highlights it server-side.
    assert!(body.contains("data-path=\"code.rs\""), "wrong file auto-opened");
    assert!(body.contains("<span class=\"t-keyword\">let</span>"), "no highlighting");
    // The no-JavaScript fallback form is always rendered.
    assert!(body.contains("method=\"post\" action=\"/save?path=code.rs\""));
}

#[actix_web::test]
async fn page_highlights_markdown_headings() {
    let fixture = Fixture::new("page-markdown");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?path=notes.md").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = text_body(response).await;
    assert!(body.contains("data-language=\"markdown\""));
    assert!(body.contains("<span class=\"t-heading\"># hello</span>"));
}

#[actix_web::test]
async fn page_opens_the_requested_file_with_its_language() {
    let fixture = Fixture::new("page-open");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?path=code.rs").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = text_body(response).await;
    assert!(body.contains("data-language=\"rust\""));
    assert!(body.contains("<span class=\"t-keyword\">let</span>"));
    assert!(body.contains("<span class=\"t-comment\">// yes</span>"));
    assert!(body.contains("data-path=\"code.rs\""));
}

#[actix_web::test]
async fn page_escapes_file_contents() {
    let fixture = Fixture::new("page-escape");
    std::fs::write(fixture.path("danger.md"), "<script>alert(1)</script>\n").unwrap();
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?path=danger.md").to_request(),
    )
    .await;
    let body = text_body(response).await;
    assert!(!body.contains("<script>alert(1)</script>"), "unescaped content");
    assert!(body.contains("&lt;script&gt;"));
}

#[actix_web::test]
async fn page_keeps_a_leading_blank_line() {
    let fixture = Fixture::new("page-blank");
    std::fs::write(fixture.path("blank.txt"), "\nsecond line\n").unwrap();
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?path=blank.txt").to_request(),
    )
    .await;
    let body = text_body(response).await;
    // The parser swallows one newline right after the tag, so the page emits an
    // extra one; the document therefore starts with two.
    assert!(body.contains("<textarea class=\"layer input\" id=\"editor\""));
    let start = body.find(">\n\nsecond line").expect("leading newline lost");
    assert!(start > 0);
}

#[actix_web::test]
async fn page_reports_a_missing_file_without_failing() {
    let fixture = Fixture::new("page-missing");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?path=nope.txt").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = text_body(response).await;
    assert!(body.contains("No such file"));
    assert!(body.contains("<textarea"), "the shell must still render");
}

#[actix_web::test]
async fn unknown_paths_render_the_not_found_page() {
    let fixture = Fixture::new("page-404");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/no/such/thing").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = text_body(response).await;
    assert!(body.contains("Open the editor"));
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn serves_the_client_script_and_stylesheet_with_etags() {
    let fixture = Fixture::new("assets");
    let app = service!(fixture, false);

    let script = test::call_service(
        &app,
        test::TestRequest::get().uri("/assets/editor.js").to_request(),
    )
    .await;
    assert_eq!(script.status(), StatusCode::OK);
    assert_eq!(
        script
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/javascript; charset=utf-8")
    );
    let etag = script
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap()
        .to_string();
    let body = text_body(script).await;
    assert!(body.contains("/api/highlight"));

    let revalidated = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/assets/editor.js")
            .insert_header((header::IF_NONE_MATCH, etag))
            .to_request(),
    )
    .await;
    assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);

    let stylesheet = test::call_service(
        &app,
        test::TestRequest::get().uri("/assets/editor.css").to_request(),
    )
    .await;
    assert_eq!(stylesheet.status(), StatusCode::OK);
    assert_eq!(
        stylesheet
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/css; charset=utf-8")
    );
}

// ---------------------------------------------------------------------------
// highlighting
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn highlight_returns_spans_for_the_requested_language() {
    let fixture = Fixture::new("highlight");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/highlight")
            .set_payload(r#"{"text":"let answer = 42; // yes","language":"rust"}"#)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    assert_eq!(body["language"], Value::String("rust".to_string()));
    let html = body["html"].as_str().unwrap();
    assert!(html.contains("<span class=\"t-keyword\">let</span>"), "{html}");
    assert!(html.contains("<span class=\"t-number\">42</span>"), "{html}");
    assert!(html.contains("<span class=\"t-comment\">// yes</span>"), "{html}");
}

#[actix_web::test]
async fn highlight_infers_the_language_from_the_path() {
    let fixture = Fixture::new("highlight-path");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/highlight")
            .set_payload(r#"{"text":"fn main() {}","path":"src/main.rs"}"#)
            .to_request(),
    )
    .await;
    let body = json_body(response).await;
    assert_eq!(body["language"], Value::String("rust".to_string()));
}

#[actix_web::test]
async fn highlight_refuses_enormous_documents() {
    let fixture = Fixture::new("highlight-large");
    let app = service!(fixture, false);

    let text = "x".repeat(wintercave_server::ui::MAX_HIGHLIGHT_BYTES + 1);
    let payload = serde_json::json!({ "text": text, "language": "plaintext" }).to_string();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/highlight")
            .set_payload(payload)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], Value::String("too_large".to_string()));
}

#[actix_web::test]
async fn rejects_oversized_bodies_without_a_content_length_header() {
    let fixture = Fixture::new("body-limit");
    let app = service!(fixture, false);
    let payload = vec![b' '; BODY_LIMIT + 1];

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/find")
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .set_payload(payload)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        json_body(response).await["error"]["code"],
        Value::String("too_large".to_string())
    );
}

// ---------------------------------------------------------------------------
// the no-JavaScript form
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn form_save_writes_the_file_and_redirects_back() {
    let fixture = Fixture::new("form");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/save?path=notes.md")
            .insert_header((
                header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            ))
            .set_payload("text=from+the+form%0A")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok()),
        Some("/?path=notes.md")
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path("notes.md")).unwrap(),
        "from the form\n"
    );
}

#[actix_web::test]
async fn form_save_rejects_cross_origin_submissions() {
    let fixture = Fixture::new("form-origin");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/save?path=notes.md")
            .insert_header((header::ORIGIN, "https://attacker.example"))
            .set_payload("text=forged")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json_body(response).await["error"]["code"],
        Value::String("bad_origin".to_string())
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path("notes.md")).unwrap(),
        "# hello\n\nworld\n"
    );
}

#[actix_web::test]
async fn form_save_respects_read_only() {
    let fixture = Fixture::new("form-readonly");
    let app = service!(fixture, true);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/save?path=notes.md")
            .set_payload("text=nope")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// the file API
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn rejects_non_local_hostnames_to_prevent_dns_rebinding() {
    let fixture = Fixture::new("host-guard");
    let app = service!(fixture, false);

    let rebound = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/health")
            .insert_header((header::HOST, "attacker.example"))
            .to_request(),
    )
    .await;
    assert_eq!(rebound.status(), StatusCode::NOT_FOUND);

    let local = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/health")
            .insert_header((header::HOST, "localhost:4173"))
            .to_request(),
    )
    .await;
    assert_eq!(local.status(), StatusCode::OK);
}

#[actix_web::test]
async fn health_reports_the_server_contract() {
    let fixture = Fixture::new("health");
    let app = service!(fixture, false);

    let response = test::call_service(&app, test::TestRequest::get().uri("/api/health").to_request())
        .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    assert_eq!(body["ok"], Value::Bool(true));
    assert_eq!(body["name"], Value::String("wintercave-server".to_string()));
    assert_eq!(body["version"], Value::String("9.9.9".to_string()));
    assert_eq!(body["readOnly"], Value::Bool(false));
    assert_eq!(body["maxBytes"], Value::from(1_000_000));
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
    assert_eq!(
        body["text"],
        Value::String("# hello\n\nworld\n".to_string())
    );
    assert_eq!(body["lineEnding"], Value::String("lf".to_string()));
    assert_eq!(body["size"], Value::from(15));
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

#[cfg(unix)]
#[actix_web::test]
async fn refuses_file_and_directory_symlinks_that_escape_the_workspace() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new("symlink-escape");
    let outside = fixture.base.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "outside secret").unwrap();
    symlink(outside.join("secret.txt"), fixture.path("linked.txt")).unwrap();
    symlink(&outside, fixture.path("linked-dir")).unwrap();
    let app = service!(fixture, false);

    let read = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/files?path=linked.txt")
            .to_request(),
    )
    .await;
    assert_eq!(read.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(read).await["error"]["code"], "bad_path");

    let list = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/tree?path=linked-dir")
            .to_request(),
    )
    .await;
    assert_eq!(list.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(list).await["error"]["code"], "bad_path");
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
    assert_eq!(body["size"], Value::from(10));

    assert_eq!(
        std::fs::read_to_string(fixture.path("notes.md")).unwrap(),
        "rewritten\n"
    );
    let leftovers: Vec<String> = std::fs::read_dir(&fixture.root)
        .unwrap()
        .map(|item| item.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "left temp files behind: {leftovers:?}");
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
    std::fs::create_dir_all(fixture.path("target")).unwrap();
    std::fs::create_dir_all(fixture.path(".git")).unwrap();
    std::fs::write(fixture.path("aaa.txt"), "a\n").unwrap();
    let app = service!(fixture, false);

    let response = test::call_service(&app, test::TestRequest::get().uri("/api/tree").to_request())
        .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    let entries = body["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["sub", "aaa.txt", "binary.bin", "code.rs", "crlf.txt", "notes.md"]
    );
    assert_eq!(entries[0]["type"], Value::String("dir".to_string()));
    assert!(entries[0].get("size").is_none());
    assert_eq!(entries[1]["type"], Value::String("file".to_string()));
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
async fn unknown_endpoints_and_methods_are_reported() {
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
}

#[actix_web::test]
async fn preflight_does_not_grant_cross_origin_access() {
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
    assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_METHODS).is_none());
}

// ---------------------------------------------------------------------------
// folders, themes and quick open
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn page_renders_the_folder_theme_and_completion_controls() {
    let fixture = Fixture::new("page-controls");
    let app = service!(fixture, false);

    let response = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = text_body(response).await;

    assert!(body.contains("Open file…"), "no quick open button");
    assert!(body.contains("Open folder…"), "no folder button");
    assert!(body.contains("id=\"theme-toggle\""), "no theme toggle");
    assert!(body.contains("id=\"completion\""), "no completion listbox");
    assert!(body.contains("id=\"quick-open\""), "no quick open dialog");
    assert!(body.contains("id=\"folder-browser\""), "no folder dialog");
    // The theme is resolved before the stylesheet paints, from storage or the
    // operating system: no flash of the wrong palette.
    assert!(body.contains("localStorage.getItem('wintercave.theme')"));
    assert!(body.contains("prefers-color-scheme: light"));
    assert!(body.contains("<meta name=\"color-scheme\" content=\"dark light\">"));
}

#[actix_web::test]
async fn page_lists_a_subfolder_and_opens_its_first_file() {
    let fixture = Fixture::new("page-dir");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?dir=sub").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = text_body(response).await;

    assert!(body.contains("data-dir=\"sub\""));
    assert!(
        body.contains("data-path=\"sub/deep.txt\""),
        "the first readable file in the folder should open"
    );
    // Breadcrumb back to the workspace root, and the folder itself as a link.
    assert!(body.contains("aria-label=\"Folders\""));
    assert!(body.contains("href=\"/?dir=sub\""));
}

#[actix_web::test]
async fn page_reports_a_missing_folder() {
    let fixture = Fixture::new("page-dir-missing");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/?dir=nope").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = text_body(response).await;
    assert!(body.contains("Back to the editor"));
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn completion_suggests_buffer_words_and_keywords() {
    let fixture = Fixture::new("complete");
    let app = service!(fixture, false);

    let text = "let counter = 1;\nco";
    let payload = serde_json::json!({
        "text": text,
        "offset": text.len(),
        "language": "rust",
    })
    .to_string();

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/complete")
            .set_payload(payload)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    assert_eq!(body["language"], Value::String("rust".to_string()));
    // "co" starts at 17 in the sample, and the caret is the payload's offset.
    assert_eq!(body["from"], serde_json::json!(17));
    assert_eq!(body["to"], serde_json::json!(19));

    let labels: Vec<&str> = body["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["label"].as_str().unwrap_or(""))
        .collect();
    assert!(labels.contains(&"counter"), "{labels:?}");
    // Rust knows `const`, and the page must be able to label it as a keyword.
    assert!(labels.contains(&"const"), "{labels:?}");
    assert!(body["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["kind"] == Value::String("keyword".to_string())));
}

#[actix_web::test]
async fn completion_counts_utf16_offsets_like_the_dom() {
    let fixture = Fixture::new("complete-utf16");
    let app = service!(fixture, false);

    let text = "counter_total = \"🌍\";\ncounter_";
    let utf16_length: usize = text.encode_utf16().count();
    let payload = serde_json::json!({
        "text": text,
        "offset": utf16_length,
        "language": "rust",
    })
    .to_string();

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/complete")
            .set_payload(payload)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    // "counter_" is eight UTF-16 units long, astral plane or not.
    assert_eq!(body["from"], serde_json::json!(utf16_length - 8));
    assert_eq!(body["to"], serde_json::json!(utf16_length));
    let labels: Vec<&str> = body["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["label"].as_str().unwrap_or(""))
        .collect();
    assert!(labels.contains(&"counter_total"), "{labels:?}");
}

#[actix_web::test]
async fn completion_refuses_enormous_documents() {
    let fixture = Fixture::new("complete-large");
    let app = service!(fixture, false);

    let text = "a".repeat(500_000);
    let payload = serde_json::json!({ "text": text, "offset": 10 }).to_string();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/complete")
            .set_payload(payload)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------------------------------------------------------------------------
// quick open
// ---------------------------------------------------------------------------

#[actix_web::test]
async fn find_ranks_files_below_the_workspace() {
    let fixture = Fixture::new("find");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/find")
            .set_payload(r#"{"query":"deep","dir":""}"#)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    let items = body["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["path"], Value::String("sub/deep.txt".to_string()));
}

#[actix_web::test]
async fn find_stays_inside_the_folder_it_is_given() {
    let fixture = Fixture::new("find-sub");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/find")
            .set_payload(r#"{"query":"","dir":"sub"}"#)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = json_body(response).await;
    let items = body["items"].as_array().expect("items");
    assert!(!items.is_empty());
    assert!(items
        .iter()
        .all(|item| item["path"].as_str().unwrap_or("").starts_with("sub/")));
}

#[actix_web::test]
async fn find_refuses_a_folder_outside_the_workspace() {
    let fixture = Fixture::new("find-escape");
    let app = service!(fixture, false);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/find")
            .set_payload(r#"{"query":"","dir":"../.."}"#)
            .to_request(),
    )
    .await;
    assert!(
        response.status().is_client_error(),
        "expected a refusal, got {}",
        response.status()
    );
}
