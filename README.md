# WinterCave

A latency-obsessed text editor. Native-caret editing surface, a platform-neutral
core, and no runtime dependencies.

The feature plan this was built from lives in
[`docs/editor-feature-plan.md`](docs/editor-feature-plan.md).

```bash
npm install
npm run dev        # editor on http://localhost:5173
npm test           # 230 unit, DOM and server tests
npm run typecheck  # tsc --noEmit
npm run build      # static bundle in dist/ (80 KB JS, 12 KB CSS, gzipped ~25 KB)

npm run server     # the small TypeScript server (static + file API) on :4173
npm run serve      # build, then serve dist/ and the file API together
npm run serve:rust # the same server in Rust (actix-web), if you have cargo

npm run smoke:rust # drive the compiled actix server over real HTTP

cargo test --workspace   # the Rust engine: 129 unit tests
npm run wasm:build       # compile the engine to WebAssembly (needs Rust)
npm run wasm:smoke       # load that package in Node and exercise the real API
```

## What works

**Editing** — typing, Enter with auto-indent (splits `{}` into three lines),
bracket/quote auto-close with type-through and selection wrapping, Tab/Shift+Tab,
move line, duplicate line, delete line, toggle line comment, smart Home,
grapheme-safe Backspace (emoji and combining marks are never split).

**Multi-cursor** — add cursor above/below, select word → select next occurrence,
per-cursor typing, auto-close, paste and delete. Overlapping cursors merge so a
region is never deleted twice.

**Find & replace** — literal/regex, case-sensitive, whole-word, match counter,
next/previous with wrap-around, replace, replace-all with `$1` / `$<name>`
expansion, invalid-pattern reporting instead of throwing.

**Navigation** — command palette (`Mod+Shift+P`), quick open (`Mod+P`), go to
line (`Mod+G`), 1000-step undo/redo with typing-burst grouping and redo
invalidation.

**View** — syntax highlighting for 11 languages, light/dark/system themes,
zoom, word wrap, line numbers, search highlights, custom scrollbars.

**Durability** — session restore (tabs, cursors, scroll, unsaved buffers), a
crash-recovery journal flushed 700 ms after the last edit, unsaved-changes guard
on unload, size guards (warn at 5 MB, refuse at 50 MB).

**Files** — open/save/save-as via the File System Access API, with a
download/`<input type=file>` fallback, drag-and-drop, language detection,
LF/CRLF detection with round-trip preservation, and a toggle to convert.

## Architecture

```
crates/wintercave-core/  the editor engine, in Rust (std + regex + unicode-segmentation)
crates/wintercave-wasm/  wasm-bindgen surface for the browser
src/core/                the TypeScript reference core, and the engine seam
src/ui/                  shell: EditorView, palette, find bar, App wiring
server/                  the small TypeScript server: static hosting + file API
crates/wintercave-server/ the same server in Rust (actix-web), same JSON contract
tests/core/              unit tests for the model and the engine seam
tests/dom/               integration tests driving the real DOM (happy-dom)
tests/server/            HTTP tests against a real socket and a temp workspace
```

The editor core is Rust. `crates/wintercave-core` carries the document model,
edits, undo, search, the tokenizer, the smart-editing rules, fuzzy matching and
the keymap; see [`docs/rust-engine.md`](docs/rust-engine.md) for the module
map, the byte-offset convention and exactly which paths run in Rust today.

**The engine seam.** `src/core/engine.ts` is the one place that decides which
implementation is live. When `npm run wasm:build` has produced
`public/wasm/wintercave_core.js`, auto-close, Enter handling, smart Home and
palette ranking run in Rust and the status bar reads `engine: rust 0.3.0`.
Without that package — a fresh clone, or no Rust toolchain — the shell runs the
TypeScript core and reads `engine: typescript`. Nothing silently differs between
the two: the adapter is tested both ways, and CI loads the real wasm package and
asserts the behaviour.

The TypeScript core is kept, not deleted. It is the reference implementation the
Rust port was written against, it is what makes the fallback honest, and its
tests are the specification.

`src/core` never imports from `src/ui`. That is what keeps a Tauri/Electron or
CLI shell a bolt-on rather than a rewrite, and it is why the model is testable
without a browser.

## The tiny server

`server/` is a dependency-free TypeScript server — `node:http`, `node:fs`,
nothing else, no build step (`node --experimental-strip-types`).

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health` | engine name, version, workspace root, limits |
| `GET /api/files?path=` | read a UTF-8 text file (404 / 413 / 415 as appropriate) |
| `PUT /api/files?path=` | replace a file; `POST` creates one |
| `DELETE /api/files?path=` | remove a file |
| `GET /api/tree?path=` | list a directory, folders first |

Writes are atomic: the text goes to a temp file next to the target, is flushed,
then renamed over it, so a crash mid-write leaves either the old file or the new
one and never a half-written buffer. Every path is confined to `--root`: `..`,
absolute paths and NUL bytes are rejected before the filesystem is touched, and
symlinks are resolved and checked. `--read-only` turns the whole API into reads.

## The Rust server (actix)

`crates/wintercave-server` is the same server written in Rust on
[actix-web](https://actix.rs): the same routes, the same JSON, the same error
codes, the same confinement and atomic-write guarantees. The web shell cannot
tell which one answered it.

```bash
npm run build                                        # dist/ is what gets served
cargo run -p wintercave-server -- --port 4173        # or: npm run serve:rust
cargo test -p wintercave-server                      # 14 unit + 18 integration tests
npm run smoke:rust                                   # 43 checks against the real binary
```

Both servers stay in the repository deliberately: the TypeScript one needs
nothing but Node, the Rust one needs a toolchain (`rustup`), and the identical
contract is what keeps them honest. `docs/actix-server.md`
has the flags, the module map and the limits — HTTP only, no auth, blocking disk
access, no request log, `dist/` not embedded.

**Why a `textarea` and an overlay.** The `textarea` owns input, IME, clipboard,
native caret movement and screen-reader access — all things that are extremely
expensive to reimplement and easy to get subtly wrong. A painted overlay behind
it (transparent text, visible colours) supplies syntax highlighting, multi-cursor
decorations and search highlights. The custom carets for extra cursors are the
only caret drawing in the app; the primary caret is native.

**Windowing.** Only the visible rows are tokenized and painted. A per-line
highlight cache carries multi-line state (block comments, template literals,
Markdown fences) forward, so a keystroke costs the same at line 40 as at
line 40,000.

## Measured performance

From `tests/core/perf.test.ts` on a 25,000-line / 1.5 MB TypeScript file:

| Operation | Time |
| --- | --- |
| Full edit cycle (edit + index + invalidate + repaint window) | **5.3 ms** |
| Repaint the visible window (60 lines) | **0.3 ms** |
| Tokenize the entire document (the old approach) | 152 ms |
| Literal search across 1.5 MB | 0.4 ms |
| Open a 1.5 MB file | 11 ms |

## Known limitations

Tracked as issues on this repository; the important ones:

- The document rebuilds its line index on every edit (O(n)). Fine to ~50k lines,
  not to 500k — a rope or incremental line index is required.
- File handles do not survive a reload, so **Save** becomes **Save As** after
  a page refresh.
- External edits to an open file on disk go unnoticed.
- Line numbers are hidden while word wrap is enabled (wrapped line heights are
  not known up front).
- Not implemented yet: code folding, Markdown preview, local file history,
  keybinding remapping, workspace folder tree.
- The Rust engine does not yet own the browser's document state or the
  incremental highlight cache — those still run in TypeScript. The wasm `Engine`
  implements and tests them; wiring the DOM path over is the next step
  ([`docs/rust-engine.md`](docs/rust-engine.md) says exactly what is and is not
  live).

## Keyboard

| Action | Shortcut |
| --- | --- |
| Command palette | `Mod+Shift+P` / `F1` |
| Quick open | `Mod+P` |
| Find / replace | `Mod+F` / `Mod+H` |
| Go to line | `Mod+G` |
| Save / save as | `Mod+S` / `Mod+Shift+S` |
| Undo / redo | `Mod+Z` / `Mod+Shift+Z` |
| Add cursor above / below | `Mod+Alt+↑` / `Mod+Alt+↓` |
| Add next occurrence | `Mod+D` |
| Toggle comment | `Mod+/` |
| Move line / duplicate | `Alt+↑↓` / `Shift+Alt+↓` |
| Zoom | `Mod+=` / `Mod+-` / `Mod+0` |

`Mod` is `Ctrl` on Windows/Linux and `⌘` on macOS.
