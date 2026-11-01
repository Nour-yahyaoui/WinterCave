# WinterCave

A latency-obsessed text editor. Native-caret editing surface, a platform-neutral
core, and no runtime dependencies.

The feature plan this was built from lives in
[`docs/editor-feature-plan.md`](docs/editor-feature-plan.md).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 181 unit + DOM integration tests
npm run typecheck  # tsc --noEmit
npm run build      # static bundle in dist/ (76 KB JS, 12 KB CSS, gzipped ~23 KB)
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
src/core/    pure TypeScript, zero DOM — the whole editor model
src/ui/      shell: EditorView, palette, find bar, App wiring
tests/core/  unit tests for the model
tests/dom/   integration tests driving the real DOM (happy-dom)
```

`src/core` never imports from `src/ui`. That is what keeps a Tauri/Electron or
CLI shell a bolt-on rather than a rewrite, and it is why the model is testable
without a browser.

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
