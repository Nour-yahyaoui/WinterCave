# WinterCave

A text editor you run locally. One Rust binary: it serves the page, tokenizes and
highlights the file, and reads and writes it through a path-confined file API.
No Node, no npm, no bundler, no wasm shell, no `dist/`.

```bash
cargo run -p wintercave-server -- --port 4173 --root .
# → wintercave-server 0.3.0
#   root: /home/you/project
#   listening on http://0.0.0.0:4173
```

Open that address. The left column lists the workspace, the right one is the
editor: native `textarea` for input and caret, a painted layer behind it for
syntax highlighting. `Mod+S` saves. With JavaScript disabled the page still
loads and a **Save** button under the editor submits a plain HTML form.

```bash
cargo test --workspace        # every test, including the ones that spawn the binary
cargo test -p wintercave-server   # the server: routes, page, API, live HTTP
cargo build --release -p wintercave-server   # one binary, nothing else needed
```

## What works

**Editing** — the surface is a `textarea`, so IME, clipboard, undo, screen
readers, selection and native caret movement are the browser's, not a
reimplementation. `Mod+S` saves over `PUT /api/files`; the status bar shows
`unsaved` until the write lands, and closing the tab with unsaved changes warns.

**Highlighting** — every keystroke (debounced 120 ms) posts the buffer to
`/api/highlight`, the server tokenizes it with `wintercave-core` and answers with
HTML spans; a scroll-synced layer behind the textarea paints them. Tokenizing
11 languages — Rust, TypeScript/JavaScript, Python, Go, C/C++, Java, JSON,
HTML, CSS, Markdown, plain text — is the engine crate's job, and its 129 tests
are the specification. Above 400 KB the page stops highlighting instead of
sending megabytes per keystroke.

**Files** — the sidebar lists the root directory (folders first, with `target`,
`node_modules`, `.git` and `.DS_Store` hidden), `/?path=` opens a file, and the
API can read, replace, create and delete. Writes are atomic: temp file beside the
target, `sync_all`, rename over it. Every path is confined to `--root`; `..`,
absolute paths and NUL bytes are rejected before the filesystem is touched, and
symlinked parents are resolved and checked.

**No-JavaScript fallback** — `<noscript>` users get a normal form: `POST /save`
writes the file and redirects back to it. The editor page is rendered by the
server (`src/ui.rs`), so it is usable in any browser, including one with scripts
off.

## Architecture

```
crates/wintercave-core/     the engine: document model, edits, undo, search,
                            tokenizer, smart editing, keymap (129 tests)
crates/wintercave-wasm/     wasm-bindgen bindings for the engine — kept compiling
                            for a future in-browser engine; nothing loads it today
crates/wintercave-server/   the editor: actix-web, HTML rendering, file API
  src/main.rs               binary: flags, bind, print the port
  src/ui.rs                 the page, the highlight endpoint, the no-JS form
  src/api.rs                /api/health, /api/files, /api/tree, CORS, errors
  src/files.rs              the only module that touches the disk; atomic writes
  src/paths.rs              "inside the root or rejected"
  src/codec.rs              percent and form encoding
  src/assets.rs             editor.js and editor.css, embedded with include_str!
  assets/editor.js          the thin client: text in, text out, nothing else
  assets/editor.css         the whole stylesheet
  tests/api.rs              the actix application against a real temp workspace
  tests/live.rs             the compiled binary over a real socket, no HTTP crate
docs/                       the actix server, the original feature plan
```

The server is the only place with I/O. `wintercave-core` has no filesystem, no
DOM and no async runtime, so the same code can drive a terminal or native window
later; today the server is the shell.

## The API

| Endpoint | Meaning |
| --- | --- |
| `GET /` | the editor page, rendered by the server |
| `GET /?path=` | the editor page with that file open |
| `GET /assets/editor.js`, `/assets/editor.css` | the embedded client, with ETags |
| `POST /save?path=` | the no-JavaScript save (form body), answers `303` |
| `POST /api/highlight` | `{text, language\|path}` → `{html, language}` |
| `GET /api/health` | name, version, workspace root, limits |
| `GET /api/files?path=` | read a UTF-8 text file |
| `PUT /api/files?path=` | replace an existing file (`{"text": "..."}`) |
| `POST /api/files?path=` | create a file, making parent directories |
| `DELETE /api/files?path=` | remove a file |
| `GET /api/tree?path=` | list a directory, folders first |

Errors are `{"error": {"code": "...", "message": "..."}}` with stable codes:
`bad_path`, `not_found`, `is_a_directory`, `read_only`, `too_large`, `binary`,
`bad_body`, `bad_json`, `method_not_allowed`, `unknown_endpoint`, `io_error`.

## Flags

```
-p, --port <n>      port (default 4173, 0 picks a free port)
    --host <addr>   bind address (default 0.0.0.0; use 127.0.0.1 to stay local)
    --root <dir>    directory the editor may read/write (default .)
    --read-only     open files, refuse writes
    --max-bytes <n> largest file accepted, in bytes
-h, --help
```

`PORT`, `HOST` and `WINTERCAVE_ROOT` work as defaults.

## Known limitations

- **No auth, no TLS.** It binds `0.0.0.0` by default, like most local dev
  servers. On a shared machine pass `--host 127.0.0.1`.
- **One file at a time, top-level listing.** The sidebar is not recursive and
  there is no tab strip; navigation is a page load.
- **Highlighting is a round trip.** Typing is instant (the `textarea` is local),
  colours arrive ~120 ms later. A 20k-line file means a 20k-line POST per pause;
  the 400 KB ceiling exists for that reason.
- **Multi-cursor, find/replace, the command palette and the file tree are not
  wired to the page yet.** The engine implements them and its tests cover them
  (`crates/wintercave-core`), but this shell does not surface them — the previous
  TypeScript shell did, and it is preserved at tag `v0.2.0`.
- **Blocking disk I/O on the async runtime.** Fine for one local user, wrong for
  a shared service.
- **No request log.** Startup information only.

## History

`v0.1.0` and `v0.2.0` shipped a browser shell in TypeScript/Vite with a
WebAssembly build of the engine. At `0.3.0` that whole layer was removed on
purpose: the editor is one Rust program and the browser gets only the page and a
small script. The old shell is still readable in those tags and in the
`v0.2.0` release.
