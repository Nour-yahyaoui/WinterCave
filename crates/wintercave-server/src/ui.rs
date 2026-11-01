//! The editor page, rendered by the server, and its two small endpoints.
//!
//! There is no client-side framework and no build step: the page is HTML that
//! this module builds, the highlighting is done here by `wintercave-core`, and
//! the only client code is `assets/editor.js` moving text between the page and
//! these routes.

use actix_web::http::{header, StatusCode};
use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::Value;
use wintercave_core::language::{
    flatten_tokens, get_language, language_for_filename, tokenize_line, HighlightState,
};

use crate::api::{json, parse_body, query_path, AppState, PathQuery};
use crate::codec;
use crate::error::ServerError;
use crate::files::{FileRecord, TreeEntry};

/// Beyond this, the page shows the text without highlighting rather than burning
/// CPU on every keystroke.
pub const MAX_HIGHLIGHT_BYTES: usize = 400_000;

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
    pub current_path: String,
    pub current_name: String,
    pub language: String,
    pub text: String,
    pub notice: Option<String>,
}

fn html_response(status: StatusCode, body: &str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .body(body.to_string())
}

pub fn render(data: &PageData) -> String {
    let mut html = String::with_capacity(data.text.len() * 2 + 3000);

    html.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>");
    if data.current_name.is_empty() {
        html.push_str("WinterCave");
    } else {
        html.push_str(&escape_html(&data.current_name));
        html.push_str(" — WinterCave");
    }
    html.push_str("</title>\n<link rel=\"stylesheet\" href=\"/assets/editor.css\">\n</head>\n<body data-path=\"");
    html.push_str(&escape_html(&data.current_path));
    html.push_str("\" data-language=\"");
    html.push_str(&escape_html(&data.language));
    html.push_str("\" data-read-only=\"");
    html.push_str(if data.read_only { "true" } else { "false" });
    html.push_str("\">\n");

    // ---- sidebar ------------------------------------------------------
    html.push_str("<aside class=\"tree\">\n<div class=\"brand\">WinterCave<span class=\"version\">");
    html.push_str(&escape_html(&data.version));
    html.push_str("</span></div>\n<ul class=\"files\">\n");
    if data.entries.is_empty() {
        html.push_str("<li class=\"empty\">no files here</li>\n");
    }
    for entry in &data.entries {
        if entry.kind == "dir" {
            html.push_str("<li class=\"dir\">");
            html.push_str(&escape_html(&entry.name));
            html.push_str("/</li>\n");
        } else {
            let current = entry.path == data.current_path;
            html.push_str("<li><a class=\"file");
            if current {
                html.push_str(" current");
            }
            html.push_str("\" href=\"/?path=");
            html.push_str(&codec::percent_encode(&entry.path));
            html.push_str("\">");
            html.push_str(&escape_html(&entry.name));
            html.push_str("</a></li>\n");
        }
    }
    html.push_str("</ul>\n<p class=\"root\" title=\"");
    html.push_str(&escape_html(&data.root));
    html.push_str("\">");
    html.push_str(&escape_html(&data.root));
    html.push_str("</p>\n<p class=\"hint\">highlighting runs in Rust on the server</p>\n</aside>\n");

    // ---- editor -------------------------------------------------------
    html.push_str("<main class=\"pane\">\n<header class=\"bar\"><span class=\"name\">");
    if data.current_name.is_empty() {
        html.push_str("<em>no file open</em>");
    } else {
        html.push_str(&escape_html(&data.current_name));
    }
    html.push_str("</span><span class=\"language\">");
    html.push_str(&escape_html(&data.language));
    html.push_str("</span></header>\n");

    if let Some(notice) = &data.notice {
        html.push_str("<p class=\"notice\">");
        html.push_str(&escape_html(notice));
        html.push_str("</p>\n");
    }

    html.push_str("<div class=\"wrap\">\n<pre class=\"layer highlight\" id=\"highlight\" aria-hidden=\"true\">");
    if data.text.len() <= MAX_HIGHLIGHT_BYTES {
        html.push_str(&highlight(&data.text, &data.language));
    } else {
        html.push_str(&escape_html(&data.text));
    }
    html.push_str("</pre>\n<textarea class=\"layer input\" id=\"editor\" spellcheck=\"false\" autocomplete=\"off\" autocapitalize=\"off\" wrap=\"off\" aria-label=\"File contents\">");
    // A newline directly after <textarea> is swallowed by the HTML parser, so a
    // document that starts with a blank line needs one extra to round-trip.
    if data.text.starts_with('\n') {
        html.push('\n');
    }
    html.push_str(&escape_html(&data.text));
    html.push_str("</textarea>\n</div>\n");

    html.push_str("<form class=\"fallback\" id=\"fallback\" method=\"post\" action=\"/save?path=");
    html.push_str(&codec::percent_encode(&data.current_path));
    html.push_str("\"><button type=\"submit\">Save</button><span>works without JavaScript</span></form>\n");
    html.push_str("<footer class=\"status\"><span id=\"status\">");
    html.push_str(if data.read_only { "read only" } else { "saved" });
    html.push_str("</span><span id=\"position\">1:1</span><span id=\"language-display\">");
    html.push_str(&escape_html(&data.language));
    html.push_str("</span></footer>\n</main>\n");
    html.push_str("<script src=\"/assets/editor.js\" defer></script>\n</body>\n</html>\n");

    html
}

pub async fn page(state: web::Data<AppState>, query: web::Query<PathQuery>) -> HttpResponse {
    let requested = query.path.clone().unwrap_or_default();
    let tree = match state.files.tree(".") {
        Ok(tree) => tree,
        Err(error) => return html_response(error.status, &render_error(&error.message, &state.version)),
    };

    let mut status = StatusCode::OK;
    let mut notice = None;
    let mut current: Option<FileRecord> = None;

    // Opening `/?path=` wins; otherwise the first file in the workspace is shown
    // so the server-rendered page is never empty for no reason.
    let target = if requested.is_empty() {
        tree.entries
            .iter()
            .find(|entry| entry.kind == "file")
            .map(|entry| entry.path.clone())
    } else {
        Some(requested.clone())
    };

    if let Some(path) = target {
        match state.files.read(&path) {
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
        current_path: current
            .as_ref()
            .map(|record| record.path.clone())
            .unwrap_or(requested),
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
        "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>WinterCave</title>\
<link rel=\"stylesheet\" href=\"/assets/editor.css\"></head>\n<body class=\"error\">\
<div class=\"brand\">WinterCave<span class=\"version\">{}</span></div>\
<p class=\"notice\">{}</p><p><a href=\"/\">Back to the editor</a></p></body></html>\n",
        escape_html(version),
        escape_html(message)
    )
}

/// `POST /api/highlight` — the page asks for highlighted HTML after a keystroke.
pub async fn highlight_handler(
    _state: web::Data<AppState>,
    body: web::Bytes,
) -> Result<HttpResponse, ServerError> {
    let value = parse_body(&body)?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    if text.len() > MAX_HIGHLIGHT_BYTES {
        return Err(ServerError::too_large(format!(
            "Refusing to highlight more than {MAX_HIGHLIGHT_BYTES} bytes."
        )));
    }

    let language = value
        .get("language")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .or_else(|| {
            value
                .get("path")
                .and_then(Value::as_str)
                .map(|path| language_for_filename(path).id.to_string())
        })
        .unwrap_or_else(|| "plaintext".to_string());

    let definition = get_language(&language);
    let html = highlight(text, definition.id);
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "html": html, "language": definition.id }),
    ))
}

/// `POST /save?path=` — the no-JavaScript form. Answers with a redirect so the
/// browser lands back on the editor.
pub async fn save_form(
    state: web::Data<AppState>,
    query: web::Query<PathQuery>,
    body: web::Bytes,
) -> Result<HttpResponse, ServerError> {
    let fields = codec::parse_form(&body);
    let text = fields
        .iter()
        .find(|(key, _)| key == "text")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let written = state.files.write(query_path(&query), Some(&text), false)?;
    let location = format!("/?path={}", codec::percent_encode(&written.path));
    Ok(HttpResponse::SeeOther()
        .insert_header((header::LOCATION, location))
        .finish())
}

pub async fn not_found(request: HttpRequest) -> HttpResponse {
    let page = format!(
        "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>Not found — WinterCave</title>\
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
}
