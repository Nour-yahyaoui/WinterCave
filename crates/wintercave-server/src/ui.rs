//! The editor page, rendered by the server, and its small text endpoints.
//!
//! There is no client-side framework and no build step: the page is HTML that
//! this module builds, the highlighting and the completion are computed here by
//! `wintercave-core`, and the only client code is `assets/editor.js` moving text
//! between the page and these routes.

use actix_web::http::{header, StatusCode};
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::Value;
use wintercave_core::complete::{byte_to_utf16, complete, utf16_to_byte};
use wintercave_core::language::{
    flatten_tokens, get_language, language_for_filename, tokenize_line, HighlightState,
};

use crate::api::{json, parse_body, read_limited_payload, AppState, PathQuery};
use crate::codec;
use crate::error::ServerError;
use crate::files::{FileRecord, TreeEntry};

/// Beyond this, the page shows the text without highlighting rather than burning
/// CPU on every keystroke. Completion uses the same ceiling.
pub const MAX_HIGHLIGHT_BYTES: usize = 400_000;

/// How many suggestions one request may return.
pub const COMPLETION_LIMIT: usize = 24;

/// Runs before the stylesheet paints, so a saved theme never flashes.
///
/// Dark is the default; `light` comes from the saved choice or, when there is no
/// saved choice, from the operating system.
const THEME_BOOTSTRAP: &str = concat!(
    "<script>(function(){try{var stored=localStorage.getItem('wintercave.theme');",
    "var system=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';",
    "var theme=stored==='light'||stored==='dark'?stored:system;",
    "document.documentElement.dataset.theme=theme;}catch(error){}})();</script>"
);

pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Tokenize a whole document into `<span class="t-kind">` runs.
pub fn highlight(text: &str, language_id: &str) -> String {
    let language = get_language(language_id);
    let mut out = String::with_capacity(text.len() * 2);
    let mut state = HighlightState::default();

    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let (tokens, next) = tokenize_line(line, language, state);
        state = next;

        let mut cursor = 0_usize;
        for run in flatten_tokens(line, &tokens) {
            if run.start >= run.end || run.end > line.len() {
                continue;
            }
            let (Some(before), Some(inside)) = (line.get(cursor..run.start), line.get(run.start..run.end))
            else {
                continue;
            };
            out.push_str(&escape_html(before));
            out.push_str("<span class=\"t-");
            out.push_str(run.kind.as_str());
            out.push_str("\">");
            out.push_str(&escape_html(inside));
            out.push_str("</span>");
            cursor = run.end;
        }
        if let Some(rest) = line.get(cursor..) {
            out.push_str(&escape_html(rest));
        }
    }

    out
}

pub struct PageData {
    pub version: String,
    pub root: String,
    pub read_only: bool,
    pub entries: Vec<TreeEntry>,
    /// Folder the sidebar is showing, relative to the root.
    pub dir: String,
    /// Breadcrumb segments below the root: `(label, relative path)`.
    pub crumbs: Vec<(String, String)>,
    pub current_path: String,
    pub current_name: String,
    pub language: String,
    pub text: String,
    pub notice: Option<String>,
}

/// `sub/deep` → `[("sub", "sub"), ("deep", "sub/deep")]`.
pub fn crumbs_for(dir: &str) -> Vec<(String, String)> {
    let mut crumbs = Vec::new();
    let mut path = String::new();
    for part in dir.split('/').filter(|part| !part.is_empty()) {
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(part);
        crumbs.push((part.to_string(), path.clone()));
    }
    crumbs
}

/// The folder above `dir`, or empty for the root.
fn parent_of(dir: &str) -> String {
    match dir.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    }
}

/// The workspace folder's own name, for the first breadcrumb.
fn root_label(root: &str) -> String {
    std::path::Path::new(root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string())
}

/// `/?path=…`, carrying the open folder so the sidebar stays where it was.
fn file_href(dir: &str, path: &str) -> String {
    let mut href = String::from("/?path=");
    href.push_str(&codec::percent_encode(path));
    if !dir.is_empty() {
        href.push_str("&amp;dir=");
        href.push_str(&codec::percent_encode(dir));
    }
    href
}

fn html_response(status: StatusCode, body: &str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .body(body.to_string())
}

fn push_crumbs(html: &mut String, data: &PageData) {
    html.push_str("<nav class=\"crumbs\" id=\"workspace-crumbs\" aria-label=\"Folders\"><a href=\"/\">");
    html.push_str(&escape_html(&root_label(&data.root)));
    html.push_str("</a>");
    for (label, path) in &data.crumbs {
        html.push_str("<span class=\"sep\" aria-hidden=\"true\">/</span><a href=\"/?dir=");
        html.push_str(&codec::percent_encode(path));
        html.push_str("\">");
        html.push_str(&escape_html(label));
        html.push_str("</a>");
    }
    html.push_str("</nav>\n");
}

pub fn render(data: &PageData) -> String {
    let mut html = String::with_capacity(data.text.len() * 2 + 7000);

    // ---- head ----------------------------------------------------------
    html.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    html.push_str("<meta name=\"color-scheme\" content=\"dark light\">\n<title>");
    if data.current_name.is_empty() {
        html.push_str("WinterCave");
    } else {
        html.push_str(&escape_html(&data.current_name));
        html.push_str(" — WinterCave");
    }
    html.push_str("</title>\n");
    html.push_str(THEME_BOOTSTRAP);
    html.push_str("\n<link rel=\"stylesheet\" href=\"/assets/editor.css\">\n</head>\n<body data-path=\"");
    html.push_str(&escape_html(&data.current_path));
    html.push_str("\" data-dir=\"");
    html.push_str(&escape_html(&data.dir));
    html.push_str("\" data-language=\"");
    html.push_str(&escape_html(&data.language));
    html.push_str("\" data-read-only=\"");
    html.push_str(if data.read_only { "true" } else { "false" });
    html.push_str("\">\n");

    // ---- sidebar -------------------------------------------------------
    html.push_str("<aside class=\"tree\">\n<header class=\"brand\">WinterCave<span class=\"version\">");
    html.push_str(&escape_html(&data.version));
    html.push_str("</span></header>\n<div class=\"actions\">\n");
    html.push_str(
        "<button type=\"button\" class=\"action\" id=\"open-file\" title=\"Quick open (Ctrl or Cmd + P)\">Open file…<kbd>⌘P</kbd></button>\n",
    );
    html.push_str(
        "<button type=\"button\" class=\"action\" id=\"open-folder\" title=\"Browse the workspace (Ctrl or Cmd + Shift + O)\">Browse workspace…</button>\n",
    );
    html.push_str("<button type=\"button\" class=\"action\" id=\"open-local-folder\">Choose folder on this PC…</button>\n");
    html.push_str("<button type=\"button\" class=\"action\" id=\"open-settings\">Settings</button>\n");
    html.push_str("<button type=\"button\" class=\"action\" id=\"open-about\">About WinterCave</button>\n");
    html.push_str("</div>\n");
    push_crumbs(&mut html, data);

    html.push_str("<ul class=\"files\" id=\"workspace-files\">\n");
    if !data.dir.is_empty() {
        let parent = parent_of(&data.dir);
        html.push_str("<li><a class=\"dir up\" href=\"/");
        if !parent.is_empty() {
            html.push_str("?dir=");
            html.push_str(&codec::percent_encode(&parent));
        }
        html.push_str("\">../</a></li>\n");
    }
    if data.entries.is_empty() {
        html.push_str("<li class=\"empty\">no files here</li>\n");
    }
    for entry in &data.entries {
        if entry.kind == "dir" {
            html.push_str("<li><a class=\"dir\" href=\"/?dir=");
            html.push_str(&codec::percent_encode(&entry.path));
            html.push_str("\">");
            html.push_str(&escape_html(&entry.name));
            html.push_str("/</a></li>\n");
        } else {
            html.push_str("<li><a class=\"file");
            if entry.path == data.current_path {
                html.push_str(" current");
            }
            html.push_str("\" href=\"");
            html.push_str(&file_href(&data.dir, &entry.path));
            html.push_str("\">");
            html.push_str(&escape_html(&entry.name));
            html.push_str("</a></li>\n");
        }
    }
    html.push_str("</ul>\n<p class=\"root\" id=\"workspace-root\" title=\"");
    html.push_str(&escape_html(&data.root));
    html.push_str("\">");
    html.push_str(&escape_html(&data.root));
    html.push_str("</p>\n<p class=\"hint\">highlighting, completion and search run in Rust</p>\n</aside>\n");
    html.push_str("<div class=\"sidebar-resize\" id=\"sidebar-resize\" role=\"separator\" tabindex=\"0\" aria-orientation=\"vertical\" aria-valuemin=\"200\" aria-valuemax=\"520\" aria-valuenow=\"262\" aria-label=\"Resize sidebar\"></div>\n");

    // ---- editor --------------------------------------------------------
    html.push_str("<main class=\"pane\">\n<header class=\"bar\"><span class=\"name\" id=\"current-name\">");
    if data.current_name.is_empty() {
        html.push_str("<em>no file open</em>");
    } else {
        html.push_str(&escape_html(&data.current_name));
    }
    html.push_str("</span><span class=\"language\" id=\"current-language\">");
    html.push_str(&escape_html(&data.language));
    html.push_str("</span><button type=\"button\" class=\"theme\" id=\"theme-toggle\" aria-pressed=\"false\" aria-label=\"Toggle the colour theme\" title=\"Switch between the dark and light theme\"><span id=\"theme-label\">Light</span></button></header>\n");

    if let Some(notice) = &data.notice {
        html.push_str("<p class=\"notice\" role=\"status\">");
        html.push_str(&escape_html(notice));
        html.push_str("</p>\n");
    }

    html.push_str("<div class=\"wrap\">\n<pre class=\"layer highlight\" id=\"highlight\" aria-hidden=\"true\">");
    if data.text.len() <= MAX_HIGHLIGHT_BYTES {
        html.push_str(&highlight(&data.text, &data.language));
    } else {
        html.push_str(&escape_html(&data.text));
    }
    html.push_str("</pre>\n<textarea class=\"layer input\" id=\"editor\" spellcheck=\"false\" autocomplete=\"off\" autocapitalize=\"off\" wrap=\"off\" aria-label=\"File contents\" aria-describedby=\"status\">");
    // A newline directly after <textarea> is swallowed by the HTML parser, so a
    // document that starts with a blank line needs one extra to round-trip.
    if data.text.starts_with('\n') {
        html.push('\n');
    }
    html.push_str(&escape_html(&data.text));
    html.push_str("</textarea>\n");
    html.push_str(
        "<ul class=\"completion\" id=\"completion\" role=\"listbox\" aria-label=\"Completions\" hidden></ul>\n</div>\n",
    );

    html.push_str("<form class=\"fallback\" id=\"fallback\" method=\"post\" action=\"/save?path=");
    html.push_str(&codec::percent_encode(&data.current_path));
    html.push_str("\"><button type=\"submit\">Save</button><span>works without JavaScript</span></form>\n");
    html.push_str("<footer class=\"status\"><span id=\"status\">");
    html.push_str(if data.read_only { "read only" } else { "saved" });
    html.push_str("</span><span id=\"position\">1:1</span><span id=\"language-display\">");
    html.push_str(&escape_html(&data.language));
    html.push_str("</span><span class=\"keys\">Ctrl/⌘ P open file · Ctrl/⌘ S save · Ctrl + Space complete</span></footer>\n</main>\n");

    // ---- dialogs -------------------------------------------------------
    html.push_str("<dialog class=\"sheet\" id=\"quick-open\" aria-label=\"Open file\">\n");
    html.push_str("<div class=\"sheet-head\"><span>Open file</span><button type=\"button\" class=\"close\" data-close aria-label=\"Close\">Esc</button></div>\n");
    html.push_str("<input id=\"quick-input\" type=\"search\" placeholder=\"Type part of a file name…\" autocomplete=\"off\" spellcheck=\"false\" aria-label=\"Search files\" aria-controls=\"quick-results\">\n");
    html.push_str("<ul class=\"results\" id=\"quick-results\" role=\"listbox\" aria-label=\"Files\"></ul>\n");
    html.push_str("<p class=\"sheet-hint\"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p>\n</dialog>\n");

    html.push_str("<dialog class=\"sheet\" id=\"folder-browser\" aria-label=\"Open folder\">\n");
    html.push_str("<div class=\"sheet-head\"><span>Open folder</span><button type=\"button\" class=\"close\" data-close aria-label=\"Close\">Esc</button></div>\n");
    html.push_str("<nav class=\"crumbs\" id=\"folder-crumbs\" aria-label=\"Folder path\"></nav>\n");
    html.push_str("<ul class=\"results\" id=\"folder-results\" role=\"listbox\" aria-label=\"Folders\"></ul>\n");
    html.push_str("<div class=\"sheet-foot\"><button type=\"button\" class=\"action primary\" id=\"folder-open\">Open this folder</button></div>\n</dialog>\n");

    html.push_str("<dialog class=\"sheet\" id=\"settings\" aria-label=\"Settings\">\n");
    html.push_str("<div class=\"sheet-head\"><span>Settings</span><button type=\"button\" class=\"close\" data-close aria-label=\"Close settings\">Close</button></div>\n");
    html.push_str("<div class=\"settings-body\">\n");
    html.push_str("<label class=\"setting-row\" for=\"setting-theme\"><span>Color theme</span><select id=\"setting-theme\"><option value=\"system\">System</option><option value=\"dark\">Dark</option><option value=\"light\">Light</option></select></label>\n");
    html.push_str("<label class=\"setting-row\" for=\"setting-font-size\"><span>Editor text size</span><select id=\"setting-font-size\"><option value=\"12\">12 px</option><option value=\"13\">13 px</option><option value=\"14\">14 px</option><option value=\"15\">15 px</option><option value=\"16\">16 px</option><option value=\"18\">18 px</option></select></label>\n");
    html.push_str("<label class=\"setting-row\" for=\"setting-tab-size\"><span>Tab width</span><select id=\"setting-tab-size\"><option value=\"2\">2 spaces</option><option value=\"4\">4 spaces</option><option value=\"8\">8 spaces</option></select></label>\n");
    html.push_str("<label class=\"setting-row\" for=\"setting-wrap\"><span>Wrap long lines</span><input id=\"setting-wrap\" type=\"checkbox\"></label>\n");
    html.push_str("<p class=\"settings-note\">Preferences are saved in this browser. The sidebar width is adjustable by dragging its divider.</p>\n</div>\n</dialog>\n");

    html.push_str("<dialog class=\"sheet\" id=\"about\" aria-label=\"About WinterCave\">\n");
    html.push_str("<div class=\"sheet-head\"><span>About</span><button type=\"button\" class=\"close\" data-close aria-label=\"Close about\">Close</button></div>\n");
    html.push_str("<div class=\"about-body\"><h2>WinterCave</h2><p>A local text editor built with Rust. Your files stay on your computer.</p><p>Version ");
    html.push_str(&escape_html(&data.version));
    html.push_str(" · MIT License</p><p>Folder access uses the browser's explicit directory permission when supported. No icon font or remote icon service is used.</p><p><a href=\"https://github.com/Nour-yahyaoui/WinterCave\" target=\"_blank\" rel=\"noopener noreferrer\">Project source</a></p></div>\n</dialog>\n");

    html.push_str("<script src=\"/assets/editor.js\" defer></script>\n</body>\n</html>\n");

    html
}

#[derive(Debug, Default, Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub dir: Option<String>,
}

pub async fn page(state: web::Data<AppState>, query: web::Query<PageQuery>) -> HttpResponse {
    let requested_file = query.path.clone().unwrap_or_default();

    // Which folder the sidebar shows: the explicit `dir`, otherwise the folder
    // holding the requested file, otherwise the workspace root.
    let dir = match query.dir.clone().filter(|dir| !dir.is_empty()) {
        Some(dir) => dir,
        None => match requested_file.rsplit_once('/') {
            Some((parent, _)) => parent.to_string(),
            None => String::new(),
        },
    };

    let listing = if dir.is_empty() { "." } else { dir.as_str() };
    let tree = match state.files.tree(listing) {
        Ok(tree) => tree,
        Err(error) => {
            return html_response(error.status, &render_error(&error.message, &state.version))
        }
    };

    let mut status = StatusCode::OK;
    let mut notice = None;
    let mut current: Option<FileRecord> = None;

    // Opening `/?path=` wins; otherwise the first *readable* file in the folder
    // is shown, so a binary sitting at the top does not turn the page into a 415.
    if requested_file.is_empty() {
        for entry in tree.entries.iter().filter(|entry| entry.kind == "file") {
            if let Ok(record) = state.files.read(&entry.path) {
                current = Some(record);
                break;
            }
        }
    } else {
        match state.files.read(&requested_file) {
            Ok(record) => current = Some(record),
            Err(error) => {
                notice = Some(error.message.clone());
                status = error.status;
            }
        }
    }

    let data = PageData {
        version: state.version.clone(),
        root: state.files.root().to_string_lossy().to_string(),
        read_only: state.files.read_only(),
        entries: tree.entries,
        crumbs: crumbs_for(&dir),
        dir,
        current_path: current
            .as_ref()
            .map(|record| record.path.clone())
            .unwrap_or(requested_file),
        current_name: current
            .as_ref()
            .map(|record| record.name.clone())
            .unwrap_or_default(),
        language: current
            .as_ref()
            .map(|record| language_for_filename(&record.name).id.to_string())
            .unwrap_or_else(|| "plaintext".to_string()),
        text: current
            .as_ref()
            .map(|record| record.text.clone())
            .unwrap_or_default(),
        notice,
    };

    html_response(status, &render(&data))
}

fn render_error(message: &str, version: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\">\
<meta name=\"color-scheme\" content=\"dark light\"><title>WinterCave</title>{THEME_BOOTSTRAP}\
<link rel=\"stylesheet\" href=\"/assets/editor.css\"></head>\n<body class=\"error\">\
<div class=\"brand\">WinterCave<span class=\"version\">{}</span></div>\
<p class=\"notice\">{}</p><p><a href=\"/\">Back to the editor</a></p></body></html>\n",
        escape_html(version),
        escape_html(message)
    )
}

/// The language a text endpoint should use: an explicit id wins, then the path.
fn language_from_body(value: &Value) -> &'static str {
    value
        .get("language")
        .and_then(Value::as_str)
        .map(|language| get_language(language).id)
        .or_else(|| {
            value
                .get("path")
                .and_then(Value::as_str)
                .map(|path| language_for_filename(path).id)
        })
        .unwrap_or("plaintext")
}

/// `POST /api/highlight` — the page asks for highlighted HTML after a keystroke.
pub async fn highlight_handler(
    _state: web::Data<AppState>,
    body: web::Payload,
) -> Result<HttpResponse, ServerError> {
    let body = read_limited_payload(body).await?;
    let value = parse_body(&body)?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    if text.len() > MAX_HIGHLIGHT_BYTES {
        return Err(ServerError::too_large(format!(
            "Refusing to highlight more than {MAX_HIGHLIGHT_BYTES} bytes."
        )));
    }

    let language = language_from_body(&value);
    let html = highlight(text, language);
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "html": html, "language": language }),
    ))
}

/// `POST /api/complete` — keyword and buffer-word suggestions for the caret.
pub async fn complete_handler(
    _state: web::Data<AppState>,
    body: web::Payload,
) -> Result<HttpResponse, ServerError> {
    let body = read_limited_payload(body).await?;
    let value = parse_body(&body)?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    if text.len() > MAX_HIGHLIGHT_BYTES {
        return Err(ServerError::too_large(format!(
            "Refusing to complete in more than {MAX_HIGHLIGHT_BYTES} bytes."
        )));
    }

    let language = get_language(language_from_body(&value));
    // The DOM counts UTF-16 code units; the engine counts bytes.
    let offset = value.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let offset = usize::try_from(offset).unwrap_or(usize::MAX);
    let caret = utf16_to_byte(text, offset);
    let (from, suggestions) = complete(text, caret, language, COMPLETION_LIMIT);

    let items: Vec<Value> = suggestions
        .iter()
        .map(|item| {
            serde_json::json!({ "label": &item.label, "kind": item.kind.as_str() })
        })
        .collect();

    Ok(json(
        StatusCode::OK,
        &serde_json::json!({
            "language": language.id,
            "from": byte_to_utf16(text, from),
            "to": byte_to_utf16(text, caret),
            "items": items,
        }),
    ))
}

/// `POST /save?path=` — the no-JavaScript form. Answers with a redirect so the
/// browser lands back on the editor.
pub async fn save_form(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<PathQuery>,
    body: web::Payload,
) -> Result<HttpResponse, ServerError> {
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let origin = origin.to_str().map_err(|_| {
            ServerError::new(StatusCode::FORBIDDEN, "bad_origin", "Request origin is not allowed.")
        })?;
        let connection = request.connection_info();
        let expected = format!("{}://{}", connection.scheme(), connection.host());
        if origin != expected {
            return Err(ServerError::new(
                StatusCode::FORBIDDEN,
                "bad_origin",
                "Cross-origin form submissions are not allowed.",
            ));
        }
    }
    let body = read_limited_payload(body).await?;
    let fields = codec::parse_form(&body);
    let text = fields
        .iter()
        .find(|(key, _)| key == "text")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let written = state.files.write(crate::api::query_path(&query), Some(&text), false)?;
    let location = format!("/?path={}", codec::percent_encode(&written.path));
    Ok(HttpResponse::SeeOther()
        .insert_header((header::LOCATION, location))
        .finish())
}

pub async fn not_found(request: HttpRequest) -> HttpResponse {
    let page = format!(
        "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\">\
<meta name=\"color-scheme\" content=\"dark light\"><title>Not found — WinterCave</title>{THEME_BOOTSTRAP}\
<link rel=\"stylesheet\" href=\"/assets/editor.css\"></head>\n<body class=\"error\">\
<h1>404</h1><p class=\"notice\">Nothing at {}</p><p><a href=\"/\">Open the editor</a></p></body></html>\n",
        escape_html(request.path())
    );
    html_response(StatusCode::NOT_FOUND, &page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup() {
        assert_eq!(escape_html("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
        assert_eq!(escape_html("plain"), "plain");
    }

    #[test]
    fn highlights_rust_into_spans() {
        let html = highlight("let x = 1; // note\n", "rust");
        assert!(html.contains("<span class=\"t-keyword\">let</span>"), "{html}");
        assert!(html.contains("<span class=\"t-number\">1</span>"), "{html}");
        assert!(html.contains("<span class=\"t-comment\">// note</span>"), "{html}");
    }

    #[test]
    fn keeps_text_that_has_no_tokens() {
        assert_eq!(highlight("", "rust"), "");
        assert_eq!(highlight("plain prose", "plaintext"), "plain prose");
    }

    #[test]
    fn escapes_code_before_wrapping_it_in_spans() {
        let html = highlight("// <script>", "rust");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn splits_a_folder_path_into_breadcrumbs() {
        assert!(crumbs_for("").is_empty());
        assert_eq!(
            crumbs_for("sub/deep"),
            vec![
                ("sub".to_string(), "sub".to_string()),
                ("deep".to_string(), "sub/deep".to_string()),
            ]
        );
        assert_eq!(parent_of("sub/deep"), "sub");
        assert_eq!(parent_of("sub"), "");
    }

    #[test]
    fn builds_file_hrefs_that_keep_the_folder() {
        assert_eq!(file_href("", "code.rs"), "/?path=code.rs");
        assert_eq!(file_href("sub", "sub/a b.txt"), "/?path=sub/a%20b.txt&amp;dir=sub");
    }

    #[test]
    fn resolves_the_language_from_a_body() {
        assert_eq!(language_from_body(&serde_json::json!({})), "plaintext");
        assert_eq!(
            language_from_body(&serde_json::json!({ "path": "main.rs" })),
            "rust"
        );
        assert_eq!(
            language_from_body(&serde_json::json!({ "path": "a.txt", "language": "rust" })),
            "rust"
        );
        // An unknown language falls back to the path, then to plain text.
        assert_eq!(
            language_from_body(&serde_json::json!({ "path": "a.txt", "language": "klingon" })),
            "plaintext"
        );
    }
}
