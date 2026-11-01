# The server

`crates/wintercave-server` is WinterCave. One actix-web process serves the editor
page, the two client assets, the highlighting endpoint and the file API.

```
crates/wintercave-server/
  src/main.rs      binary: parse flags, bind, print the address
  src/config.rs    flags and environment variables
  src/ui.rs        the editor page (HTML), /api/highlight, /api/complete, the no-JS form
  src/api.rs       /api/health, /api/files, /api/tree, /api/find, CORS, error bodies
  src/files.rs     the only module that touches the disk; atomic writes
  src/paths.rs     path confinement rules
  src/codec.rs     percent / form encoding
  src/assets.rs    editor.js and editor.css, compiled in with include_str!
  src/error.rs     one error type: status + code + message
  assets/          the thin client and the stylesheet
  tests/api.rs     the actix application against a real temp workspace
  tests/live.rs    the compiled binary, spawned, spoken to over a raw socket
```

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | renders the editor page; `?path=` opens a file, `?dir=` shows a folder |
| `GET /assets/editor.js`, `GET /assets/editor.css` | embedded, ETag + `304` |
| `POST /save?path=` | the no-JavaScript form save, answers `303 See Other` |
| `POST /api/highlight` | `{text, language}` or `{text, path}` → `{html, language}` |
| `POST /api/complete` | `{text, offset, language}` (offset in UTF-16 units) → `{from, to, items}` |
| `POST /api/find` | `{query, dir}` → quick open, ranked with the engine's subsequence matcher |
| `GET /api/health` | server name, version, workspace root, limits |
| `GET /api/files?path=` | read a UTF-8 text file |
| `PUT /api/files?path=` | replace an existing file |
| `POST /api/files?path=` | create a file (and its directories) |
| `DELETE /api/files?path=` | remove a file |
| `GET /api/tree?path=` | list one directory, folders first |

`OPTIONS` on any `/api/*` route answers `204` with permissive CORS headers; any
other method on a known route answers `405` with a JSON body.

## Rendering the page

There is no template engine. `ui::render` builds the HTML with a `String`, which
keeps the dependency list to `actix-web`, `serde`, `serde_json` and the engine.

Two details are worth knowing, because both are easy to get wrong:

- **Escaping.** Every string that reaches the page goes through
  `ui::escape_html`, including file contents, file names and the root path.
- **A leading blank line.** HTML parsers drop exactly one newline directly after
  `<textarea>`, so a document that starts with `\n` is emitted with one extra.
  `tests/api.rs` pins this down.

Highlighting is server-side: `ui::highlight` walks the document line by line
through `wintercave_core::language::tokenize_line`, carrying
`HighlightState` so a block comment opened 400 lines above still colours
correctly, then wraps each run in `<span class="t-…">`. Above
`MAX_HIGHLIGHT_BYTES` (400 KB) the endpoint refuses and the page falls back to
plain escaped text.

## The client

`assets/editor.js` is plain JavaScript, no framework and no build step. It does
seven things:

1. debounce keystrokes (120 ms) into `POST /api/highlight` and paint the answer
   into the layer behind the textarea, dropping stale responses;
2. `Mod+S` → `PUT /api/files?path=…`, and keep the status bar honest;
3. keep the highlight layer's scroll in step with the textarea's;
4. insert two spaces on Tab and warn before unloading unsaved changes;
5. resolve the theme — saved choice, else `prefers-color-scheme` — and flip it
   from the header button. The choice is written to
   `localStorage['wintercave.theme']`; an inline script in `<head>` applies it
   before the stylesheet paints, so there is no flash of the wrong palette;
6. quick open (`Mod+P`) asks `POST /api/find`, open folder (`Mod+Shift+O`) walks
   `GET /api/tree`; both dialogs are plain `<dialog>` elements and both fall back
   to the server-rendered file list when JavaScript is off;
7. word completion asks `POST /api/complete` and draws a listbox at the caret.
   The caret's pixel position comes from a hidden mirror element: a textarea
   reports no geometry of its own.

## Completion

`wintercave_core::complete` is deliberately local: the candidates are the open
language's keywords and constants plus the identifiers already in the buffer,
ranked by prefix first and subsequence second, with `fuzzy_match` doing the
scoring. Nothing leaves the machine; no language server, no model.

The one bridge worth remembering is offsets. The DOM counts UTF-16 code units,
the engine counts bytes, so `/api/complete` converts in (`utf16_to_byte`) and
out (`byte_to_utf16`) and accepts a caret in the middle of a surrogate pair by
snapping to the character start.

Without it, the `<form method="post" action="/save?path=…">` still saves.

## Flags

```
-p, --port <n>      port (default 4173, 0 picks a free port)
    --host <addr>   bind address (default 0.0.0.0)
    --root <dir>    directory the editor may read/write (default .)
    --read-only     open files, refuse writes
    --max-bytes <n> largest file accepted, in bytes
-h, --help
```

`PORT`, `HOST` and `WINTERCAVE_ROOT` supply defaults. The server prints the
address it actually bound, which is how the live test finds an ephemeral port.

## Tests

```bash
cargo test -p wintercave-server
```

- `tests/api.rs` drives the same `configure()` the binary uses: the page render,
  escaping, the leading-newline case, asset ETags, the highlight endpoint, the
  form save, path confinement, every status code, read-only mode, and that no
  temp file survives a write.
- `tests/live.rs` spawns the compiled binary, waits for `listening on http://…`,
  and speaks HTTP/1.1 over `std::net::TcpStream` — no HTTP client crate. It saves
  a file, reads the page back, highlights code and deletes a file over the wire.

CI runs `cargo test --workspace --all-targets`, builds the release binary and
reports its size.

## Limits

- HTTP only, no auth. `--host 127.0.0.1` if the machine is shared.
- Disk access blocks the worker; one local user is the design point.
- No request log, no metrics.
- One file open at a time; the sidebar lists the root directory only.
- The page is server-rendered per navigation, so opening a file is a request.
