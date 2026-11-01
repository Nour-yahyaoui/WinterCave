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
12 languages — Rust, JavaScript/TypeScript, Python, shell, YAML, SQL, JSON,
HTML, CSS, Markdown, plain text — is the engine crate's job, and its tests are
the specification. Above 400 KB the page stops highlighting instead of
sending megabytes per keystroke.

**Files** — the sidebar lists the root directory (folders first, with `target`,
`node_modules`, `.git` and `.DS_Store` hidden), `/?path=` opens a file, and the
API can read, replace, create and delete. Writes are atomic: temp file beside the
target, `sync_all`, rename over it. Every path is confined to `--root`; `..`,
absolute paths and NUL bytes are rejected before the filesystem is touched, and
symlinked parents are resolved and checked.

**Folders and quick open** — the sidebar is a browser, not a fixed list:
`/?dir=sub` shows a folder, folders are links, and a breadcrumb walks back to the
workspace root. `Mod+P` opens a quick-open palette over the whole workspace
(`POST /api/find`, ranked by the engine's subsequence matcher); `Mod+Shift+O`
walks folders (`GET /api/tree`) and opens the one you choose. Both are server
rendered as links first: with JavaScript off you still navigate, just without the
palette.

**Light and dark** — one token set, two palettes. The choice is saved in
`localStorage['wintercave.theme']`; with nothing saved the page follows
`prefers-color-scheme`. An inline script in `<head>` applies the answer before
the stylesheet paints, so the wrong theme never flashes on load. The toggle is a
button in the header (`aria-pressed` tracks it), and the fallback is CSS-only.

**Completion** — `POST /api/complete` returns keyword, constant and
buffer-identifier suggestions for the caret, ranked prefix-first then by
subsequence (`wintercave_core::complete`). The popup is a listbox anchored on a
hidden mirror of the textarea, because a textarea reports no caret geometry;
`Up`/`Down`/`Enter`/`Tab`/`Esc` drive it and `Mod+Space` asks explicitly.
Nothing leaves the machine: the candidates come from the file and the language
table, not from a model.

**No-JavaScript fallback** — `<noscript>` users get a normal form: `POST /save`
writes the file and redirects back to it. The editor page is rendered by the
server (`src/ui.rs`), so it is usable in any browser, including one with scripts
off.

## Landing page

`site/` is the static page for **wintercave.vercel.app**: one `index.html` and one
`styles.css`, no build step, no framework, no analytics. It documents what the
project is, what the five editor surfaces do, how to run it and where the edges
are. It deliberately does not host the editor — the editor is a localhost
program.

```bash
python3 -m http.server 3000 --directory site   # look at it
```

Vercel project: `wintercave` (`prj_r5p8QHpFxixqYJz2dLTfrFZHFezZ`), output
directory `site`, build and install commands set to no-ops. The framework is
recorded as `svelte` only because the Vercel API rejects `other` through the
connector and refuses the first deployment of a project without framework
settings; nothing is built, the two files are served as they are. Git pushes do
not deploy on their own (the integration has `createDeployments: disabled`), so
deploy from the commit you want with the Vercel tool.

## Architecture

```
crates/wintercave-core/     the engine: document model, edits, undo, search,
                            tokenizer, smart editing, keymap
crates/wintercave-wasm/     wasm-bindgen bindings for the engine — kept compiling
                            for a future in-browser engine; nothing loads it today
crates/wintercave-server/   the editor: actix-web, HTML rendering, file API
  src/main.rs               binary: flags, bind, print the port
  src/ui.rs                 the page, /api/highlight, /api/complete, the no-JS form
  src/api.rs                /api/health, /api/files, /api/tree, /api/find, CORS
  src/files.rs              the only module that touches the disk; atomic writes
  src/paths.rs              "inside the root or rejected"
  src/codec.rs              percent and form encoding
  src/assets.rs             editor.js and editor.css, embedded with include_str!
  assets/editor.js          the thin client: text, theme, dialogs, completion
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
| `GET /?dir=` | the editor page showing that folder |
| `GET /assets/editor.js`, `/assets/editor.css` | the embedded client, with ETags |
| `POST /save?path=` | the no-JavaScript save (form body), answers `303` |
| `POST /api/highlight` | `{text, language\|path}` → `{html, language}` |
| `POST /api/complete` | `{text, offset, language\|path}` → `{from, to, items}` |
| `POST /api/find` | `{query, dir}` → `{items}` for quick open |
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
- **One file at a time.** No tab strip; opening a file is a page load, and the
  folder browser walks one level at a time (quick open does search recursively,
  bounded to six levels and 4 000 entries).
- **Highlighting is a round trip.** Typing is instant (the `textarea` is local),
  colours arrive ~120 ms later. A 20k-line file means a 20k-line POST per pause;
  the 400 KB ceiling exists for that reason.
- **Multi-cursor and find/replace are not wired to the page yet.** The folder
  tree and the command palette are, in the reduced form described above. The engine implements them and its tests cover them
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
