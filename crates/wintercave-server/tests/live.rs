//! The compiled binary, over a real socket.
//!
//! The other integration test file drives the application in-process. This one
//! starts `wintercave-server` exactly as a user would, waits for it to announce
//! its port, and speaks HTTP/1.1 to it with no client library at all.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Server {
    child: Child,
    port: u16,
    base: PathBuf,
    root: PathBuf,
}

impl Server {
    fn start(label: &str, read_only: bool) -> Self {
        let base = std::env::temp_dir().join(format!(
            "wintercave-live-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let root = base.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("notes.md"), "# live\n").unwrap();
        std::fs::write(root.join("code.rs"), "let answer = 42;\n").unwrap();

        let mut command = Command::new(env!("CARGO_BIN_EXE_wintercave-server"));
        command
            .arg("--port")
            .arg("0")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--root")
            .arg(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if read_only {
            command.arg("--read-only");
        }

        let mut child = command.spawn().expect("spawn wintercave-server");
        let stdout = child.stdout.take().expect("stdout");
        let mut reader = BufReader::new(stdout);

        let mut port = None;
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            if let Some(rest) = line.trim().strip_prefix("listening on http://127.0.0.1:") {
                port = rest.parse::<u16>().ok();
                break;
            }
            line.clear();
        }

        // Keep the pipe drained so the child never blocks on a full buffer.
        std::thread::spawn(move || {
            let mut sink = String::new();
            while reader.read_line(&mut sink).unwrap_or(0) > 0 {
                sink.clear();
            }
        });

        let port = port.expect("the server never announced a port");
        Self {
            child,
            port,
            base,
            root,
        }
    }

    fn request(&self, method: &str, path: &str, body: Option<&str>) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect");
        let payload = body.unwrap_or("");
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            payload.len()
        );
        request.push_str(payload);
        stream.write_all(request.as_bytes()).expect("write");
        stream.flush().unwrap();

        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read");
        response
    }

    fn status_of(response: &str) -> u16 {
        response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[test]
fn serves_the_page_the_assets_and_the_api() {
    let server = Server::start("smoke", false);

    let page = server.request("GET", "/", None);
    assert_eq!(Server::status_of(&page), 200, "{page}");
    assert!(page.contains("<textarea"), "no editor surface");
    assert!(page.contains("<span class=\"t-keyword\">let</span>"), "no highlighting");
    assert!(page.contains("WinterCave"));
    assert!(page.contains(env!("CARGO_PKG_VERSION")));

    let script = server.request("GET", "/assets/editor.js", None);
    assert_eq!(Server::status_of(&script), 200);
    assert!(script.contains("javascript"));
    assert!(script.contains("/api/highlight"));

    let health = server.request("GET", "/api/health", None);
    assert_eq!(Server::status_of(&health), 200);
    assert!(health.contains("\"ok\":true"), "{health}");
    assert!(health.contains(env!("CARGO_PKG_VERSION")));

    let tree = server.request("GET", "/api/tree", None);
    assert_eq!(Server::status_of(&tree), 200);
    assert!(tree.contains("notes.md"));

    let missing = server.request("GET", "/nowhere", None);
    assert_eq!(Server::status_of(&missing), 404);
}

#[test]
fn saves_highlights_and_deletes_over_http() {
    let server = Server::start("write", false);

    let saved = server.request(
        "PUT",
        "/api/files?path=notes.md",
        Some(r##"{"text":"# edited over HTTP\n"}"##),
    );
    assert_eq!(Server::status_of(&saved), 200, "{saved}");
    assert_eq!(
        std::fs::read_to_string(server.root.join("notes.md")).unwrap(),
        "# edited over HTTP\n"
    );

    let reread = server.request("GET", "/?path=notes.md", None);
    assert!(reread.contains("# edited over HTTP") || reread.contains("edited over HTTP"));

    let highlighted = server.request(
        "POST",
        "/api/highlight",
        Some(r#"{"text":"let x = 1;","language":"rust"}"#),
    );
    assert_eq!(Server::status_of(&highlighted), 200);
    assert!(highlighted.contains("t-keyword"), "{highlighted}");

    let traversal = server.request("GET", "/api/files?path=../etc/passwd", None);
    assert_eq!(Server::status_of(&traversal), 400);

    let removed = server.request("DELETE", "/api/files?path=notes.md", None);
    assert_eq!(Server::status_of(&removed), 200);
    assert!(!server.root.join("notes.md").exists());
}

#[test]
fn read_only_mode_refuses_writes_over_http() {
    let server = Server::start("readonly", true);

    let write = server.request(
        "PUT",
        "/api/files?path=notes.md",
        Some(r#"{"text":"nope"}"#),
    );
    assert_eq!(Server::status_of(&write), 403, "{write}");

    let page = server.request("GET", "/", None);
    assert_eq!(Server::status_of(&page), 200);
    assert!(page.contains("read only"));
}
