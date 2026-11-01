# The Rust engine

The editor's engine is written in Rust. This document records what "engine"
means here, how the pieces fit together, and what is still done in TypeScript —
because a port that is described more grandly than it exists is worse than no
port at all.

```
crates/wintercave-core/   the engine: std + regex + unicode-segmentation
crates/wintercave-wasm/   wasm-bindgen surface for the web shell
src/core/engine.ts        the seam: Rust engine when built, TS core otherwise
server/                   the small TypeScript server (not Rust, by design)
```

## What the engine owns

| Rust module | Ported from | Responsibility |
| --- | --- | --- |
| `text.rs` | `src/core/text.ts` | line-ending detection and round-trip, grapheme boundaries |
| `document.rs` | `src/core/document.ts` | immutable `TextDocument`, line index, offsets ↔ positions |
| `selection.rs` | `src/core/selection.ts` | carets, sorting, merging, primary selection |
| `edits.rs` | `src/core/edits.ts` | sequential and concurrent edit application, caret mapping |
| `history.rs` | `src/core/history.ts` | undo/redo over edit records, typing-burst grouping |
| `search.rs` | `src/core/search.ts` | literal/regex search, whole word, `$1` expansion |
| `language.rs` | `src/core/language.ts` | 11 languages, multi-line state, token flattening |
| `smart_edit.rs` | `src/core/smartEdit.ts` | auto-close, newline, indent detection, comments |
| `fuzzy.rs` | `src/core/fuzzy.ts` | palette scoring with positions |
| `keymap.rs` | `src/core/keymap.ts` | combo normalisation, conflicts, formatting |
| `limits.rs` | `src/core/limits.ts` | size policy |
| `commands.rs` | `src/core/commands.ts` | palette metadata ranking |

Not ported, on purpose: `src/core/session.ts` is `localStorage` serialisation
and belongs to the shell. It is a storage adapter, not editor logic.

## Two conventions that matter

**Byte offsets.** Rust strings are byte-indexed, so every offset in the engine
is a byte offset, and every slice passes through a boundary check
(`floor_char_boundary`). The TypeScript core counted UTF-16 code units. The
conversion lives at the DOM boundary and is the most likely place for a Unicode
bug, so `text.rs` has explicit tests for emoji, combining marks and ZWJ
sequences.

**Immutable documents.** `TextDocument` never mutates. Edits return a new
document, which is what makes undo, recovery snapshots and concurrent tests
honest. Undo is stored as edit records, not snapshots, so a 10 MB file does not
allocate 10 GB of history.

## Running it

```bash
cargo test --workspace              # 129 unit tests, no browser needed
cargo fmt --all                     # CI checks this

rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100   # must match crates/wintercave-wasm
npm run wasm:build                  # -> public/wasm/wintercave_core.{js,_bg.wasm}
npm run wasm:smoke                  # loads the package in Node and exercises the API
```

CI runs all of it: `rust` (fmt + tests) and `wasm` (build + smoke test). The
smoke test is what proves the bridge works — it is not a compile check, it loads
the generated JavaScript, instantiates the module and asserts tokenising,
undo/redo, search, fuzzy ranking, auto-close, keymap formatting and the size
policy.

## What the browser does today

`src/core/engine.ts` defines the seam. `loadRustEngine()` tries
`/wasm/wintercave_core.js`; if it loads, the shell's auto-close decisions, Enter
handling, smart Home and palette ranking all run in Rust, and the status bar
reads `engine: rust 0.1.0`. If it does not load, the shell runs the TypeScript
reference core and the status bar reads `engine: typescript`. Both paths are
tested (`tests/core/engine.test.ts` covers the adapter and the fallback).

What is **not** yet on the Rust path in the browser:

- the live document and undo stack (the wasm `Engine` owns them, and the smoke
  test exercises them, but the shell still uses `TextDocument`/`History` from
  `src/core` for DOM-backed state);
- syntax highlighting, which still uses the incremental `HighlightCache` in
  `src/core/language.ts`.

Both are follow-ups: the highlight cache is the interesting one, because it is
the incremental structure the engine needs before it can take over painting
without a performance regression.

## Why the server is TypeScript

The brief was explicit: keep the small server in TypeScript. It is a hosting and
file-I/O concern (static assets, atomic writes, path confinement), not editor
logic, and it has no reason to share a process or a toolchain with the engine.
