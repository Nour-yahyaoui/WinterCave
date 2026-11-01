# WinterCave — Text Editor Feature Plan

> Status: planning draft · No code written · Scope: features, priorities, UX decisions, risks, roadmap

---

## 1. What we're optimizing for

A text editor is judged on five things, in this order. Every feature below is scored against them.

1. **Never lose a keystroke.** Crash, power loss, browser tab kill, laptop sleep — the buffer survives.
2. **Latency is the feature.** Typing must feel local, always. Target: <16ms keystroke-to-paint on a 10k-line file, <100ms open of a 1MB file.
3. **Predictable over clever.** No auto-inserted characters the user didn't ask for, no silent rewrites, no modal surprises.
4. **Keyboard-first, mouse-optional.** Every action reachable without touching the mouse.
5. **Legible plain text.** If it can't be represented as UTF-8 text in a file, it's an attachment, not a feature.

**Explicit anti-goals** (features that look good on a comparison chart and ruin the product):

- No AI autocomplete rewriting text in place by default.
- No modal editing as the default mode (Vim-style keys as an *option*, never mandatory).
- No proprietary file format. Markdown / plain text / source files in, same out.
- No telemetry on document content. Ever.
- No feature that requires an account to edit a local file.

---

## 2. Tier 0 — table stakes (ship-blockers)

If any of these is missing, it's not an editor yet.

| Feature | Acceptance criteria |
| --- | --- |
| Open / save / save-as | Round-trips a file byte-for-byte when untouched; preserves line endings (LF/CRLF) and final-newline state |
| Recent files | Last 20, keyboard-navigable, survives restart |
| Multi-tab (or multi-buffer) | ≥20 open docs, tab order persists, modified indicator per tab |
| Undo / redo | ≥1000 steps, grouped by typing burst (&lt;500ms gap = one step), survives tab switch |
| Find (in document) | Literal + case toggle + whole-word + regex; wrap-around; match count |
| Replace | Single + replace-all with a confirm showing the count |
| Go to line | Accepts `line`, `line:col` |
| Cut / copy / paste | Multi-line, respects system clipboard, paste of 10MB doesn't freeze |
| Select all / by word / by line | Double-click word, triple-click line, shift-click range |
| Line numbers + current line highlight | Toggleable |
| Cursor position memory | Reopen a file → cursor where you left it, per file |
| Scroll restore | Same; plus scroll position survives restart |
| Word wrap toggle | On for prose, off for code — per file type default |
| UTF-8 + emoji + CJK + RTL | No corruption, no cursor-in-the-middle-of-a-grapheme bugs |
| Large file guard | Warn above ~5MB, refuse above ~50MB with a read-only "open anyway" |
| Unsaved-changes guard | Prompt on close/quit/tab-close; never silently discard |

---

## 3. Editing core

| Feature | Priority | Notes |
| --- | --- | --- |
| Multi-cursor | P1 | Add cursor above/below (Ctrl+Alt+↑/↓), select-all-occurrences, column/box select |
| Smart Home | P1 | First press → first non-whitespace, second → column 0 |
| Auto-indent | P1 | Preserve indentation on newline; honor tabs-vs-spaces per file |
| Bracket/quote auto-close | P1 | Wrap selection when a bracket is typed over a selection; *don't* fight the user on quotes |
| Bracket matching + jump to match | P1 | Highlight pair under cursor, flash on unmatched |
| Tab / shift-tab indent block | P1 | On selection |
| Move line up/down, duplicate line | P1 | Alt+↑/↓, Shift+Alt+↓ |
| Insert/replace mode | P2 | Insert only by default; replace via toggle |
| Column ruler / soft guide at 80/100 | P2 | Configurable |
| Trim trailing whitespace on save | P2 | Off by default, per-project opt-in — show a diff-count confirm |
| Convert case (upper/lower/title) | P2 | |
| RTL + bidi cursor handling | P2 | Correct caret behavior in mixed Arabic/Hebrew/Latin lines |
| Sort / dedupe selected lines | P3 | |
| Snippets / templates | P3 | Tab-triggered, user-defined |
| Emmet-style expansion | P3 | Only if we go web-dev heavy |

**UX decision:** auto-close and auto-indent are the two features most likely to annoy users. Default them *on* but give one keystroke to undo the auto-insertion without undoing the user's own typing.

---

## 4. Navigation & search

- **Quick open** (Ctrl/Cmd+P): fuzzy filename search across the workspace root, ranked by recency + path proximity.
- **Command palette** (Ctrl/Cmd+Shift+P): every menu action, discoverable and searchable; this is how features stay unmapped and still usable.
- **Project-wide search** (Ctrl/Cmd+Shift+F): literal + regex, match list with 2 lines of context, click-to-jump, replace across files with a preview diff and a per-file checkbox.
- **Search options remembered per project** — nobody wants to re-tick "regex" 40 times a day.
- **Outline / symbol list:** headings for Markdown, functions/classes for code — a jump list, no window chrome.
- **Breadcrumbs** — P2. Only useful with structure; costs vertical space.
- **Minimap** — P2. Controversial; small files don't need it, big files benefit. Ship off-by-default.
- **Folding** — P1 for code, P2 for Markdown headings. Persist fold state per file.
- **Bookmarks / marks** — P3.

---

## 5. Presentation

- **Themes:** light, dark, high-contrast, system-follow. Themes are data (a token→color map), not code, so users can write their own.
- **Font:** user-selectable family, size, line height, ligatures toggle. Must ship a competent default (a monospace for code, a readable serif/sans for prose) rather than shipping system defaults.
- **Syntax highlighting:** incremental, tree-sitter-class parsing — must not re-highlight the whole document on each keystroke. Ship ~15 languages, make adding more a data/config task.
- **Markdown rendering:** live preview (side-by-side and toggle-to-preview modes), fenced code blocks highlighted, click a rendered heading to jump to source.
- **Focus mode / typewriter scroll** — P2. Cheap, loved by writers.
- **Spellcheck** — P1 for prose, off by default for code. Underline, right-click suggestions, add-to-dictionary. Must be local (no cloud round-trip).
- **Whitespace rendering** (dots/arrows) — P2, toggle.
- **Indent guides** — P2.
- **Zoom** (editor-only vs UI) — P1, Ctrl+scroll, remembered.

---

## 6. Files, projects, and the outside world

- **Open folder / workspace** with a file tree: create, rename, delete (to trash, with undo), move (drag), refresh on external change.
- **External change detection:** file changed on disk while open in a dirty buffer → never auto-reload silently. Offer *reload / keep mine / diff*.
- **Drag-and-drop** files and folders onto the window to open.
- **Encoding & line endings:** show current encoding in the status bar, allow re-open with a different encoding, save-as with a chosen encoding.
- **Export:** Markdown → HTML and PDF; plain text → HTML. PDF via the OS print path is acceptable for v1.
- **Import:** paste HTML/RTF → Markdown-ish text (P2).
- **Print** — P2.
- **Sync/settings:** settings are a human-readable file (JSON/TOML) in a known location, syncable by the user via any mechanism. Optional first-party sync is a P3 convenience, not a requirement.
- **CLI launcher** (`wintercave file.md:42`) — P2 for desktop, trivial and very valuable for developers.

---

## 7. Durability & recovery

This section is where editors earn trust, and where most competitors are quietly bad.

- **Autosave/journal:** append-only write-ahead log of buffer content to a temp dir, flushed every ~500ms of idle typing. On startup after a crash: "Recovered unsaved changes from 14:32" → restore or discard.
- **Autosave to file** (optional, per project) with debounce, atomic write (write temp → fsync → rename) so a crash mid-save can't truncate the original.
- **Local history:** every save produces a snapshot; "Timeline for this file" shows last N versions with a diff and restore. This single feature removes most reasons people fear editors.
- **Session restore:** all tabs, cursors, scroll, fold state, unsaved buffers.
- **Backup on delete/rename** for 7 days.
- **Read-only mode** when the file isn't writable — clear affordance, never a save that fails at the last second.

---

## 8. Keyboard, menus, accessibility

- **Shortcuts:** one canonical table, platform-aware (Cmd on macOS, Ctrl elsewhere), fully remappable, conflict detection, printable cheat sheet.
- **Muscle-memory compatibility:** match VS Code / Sublime defaults where they exist. Deviating for aesthetics costs users real time.
- **Every command is in the palette** — a command not in the palette doesn't exist for discoverability purposes.
- **Menus:** full menu bar on desktop with the same commands; no feature that's shortcut-only.
- **Accessibility (P1, not a nice-to-have):**
  - Full keyboard operation including file tree and dialogs.
  - Screen-reader support: ARIA roles for the editing surface (or a proper textarea fallback mode), announcements for find results, save state, and errors.
  - Respects OS reduced-motion, high-contrast mode, and text scaling.
  - Contrast ratios ≥4.5:1 in every shipped theme.
  - No focus traps; visible focus rings everywhere.

---

## 9. Extensibility

Two schools; pick deliberately.

**A. No plugins.** Every feature first-party, curated. Cheaper to make coherent, impossible to extend.

**B. Plugin surface** (recommended, later): out-of-process plugin host (separate process or worker), declared capabilities, no ambient filesystem/network access without a permission prompt. API surface limited to *commands, text transforms, decorations, panels* — enough for linters and themes, not enough to reimplement the editor.

Start with **A** for v1, but design the command model so **B** is a bolt-on: every action already goes through a command registry with an id, a schema, and a pure "apply to document" signature.

Ship-before-plugins: themes, keymaps, and language grammars are **user-editable data files**. That covers ~80% of plugin demand with ~5% of the complexity.

---

## 10. Collaboration (deliberately late)

- **Phase 1:** none. Files on disk, user's own sync.
- **Phase 2:** optional live co-editing (CRDT-based, per-document opt-in, presence cursors, no account required for self-hosted). Only if user research shows demand — it's the single largest complexity multiplier in this plan.
- **Never:** silent cloud upload of documents.

---

## 11. Performance budgets

Treat these as acceptance tests, not aspirations.

| Scenario | Budget |
| --- | --- |
| Keystroke → paint, 10k lines | ≤16ms |
| Keystroke → paint, 500k lines | ≤50ms |
| Open 1MB file | ≤100ms |
| Open 100MB file | read-only, ≤3s, no freeze &gt;100ms per frame |
| Project-wide search, 10k files | streaming results in ≤300ms, cancelable |
| Find-as-you-type | ≤30ms per query on 1MB doc |
| Memory, 20 tabs of 100KB | ≤300MB |
| Cold start | ≤1s desktop, ≤1.5s web |
| Crash-free session rate | ≥99.5% |

---

## 12. Decisions to make before building

These are the forks that determine the architecture; each is expensive to reverse later.

1. **Platform:** desktop (Tauri/Electron/native), web, or both. *Both* means the editor core must be platform-neutral from day one.
2. **Editing surface:** DOM textarea/contenteditable vs canvas vs a custom rendered layer. This single choice decides whether large-file performance and accessibility are achievable.
3. **Primary user:** developer or writer. The progressive requirement sets (folding + regex + git gutter *vs* preview + spellcheck + focus mode) diverge fast.
4. **Sync model:** local-only, user-supplied sync, or first-party. Affects file abstraction from the start.
5. **Plugin stance:** closed or open, per §9.

**Recommendation if undecided:** desktop-first (Tauri), platform-neutral core, developer-and-writer hybrid, local-only files, no plugins in v1.

---

## 13. Roadmap

**Phase 1 — "it's a real editor" (≈6 weeks)**
Everything in Tier 0, plus multi-cursor, quick open, find/replace, folding, themes, syntax highlighting for 5 languages, autosave journal + crash recovery, session restore, command palette.

*Exit criteria:* a daily user can work a full day without reaching for another editor; zero data-loss bugs open.

**Phase 2 — "it's a good editor" (≈6 weeks)**
Project-wide search & replace, workspace file tree, local history/timeline, spellcheck, Markdown preview, export, full keyboard remapping, accessibility pass, 15 languages, performance budgets met and enforced in CI.

*Exit criteria:* measurable perf budgets green; a screen-reader user can complete open→edit→find→save end to end.

**Phase 3 — "it's *the* editor, for someone" (≈8 weeks)**
Pick one audience and go deep: developer (git gutter, diagnostics/LSP client, integrated terminal) **or** writer (focus mode, distraction-free, PDF export, document outline, citations). Local history diffing gets a real UI. Optional sync.

*Exit criteria:* a named group of 20 users switches their daily driver.

**Phase 4 — platform (only if earned)**
Plugin host with permission model, live collaboration, mobile companion (read + light edit), CLI, self-hosted sync.

---

## 14. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Building both code and prose features | Bloated, mediocre at both | Choose the Phase 3 audience early; keep shared core thin |
| Editing-surface choice locks out large files | Rewrite of the core | Prototype the surface against the 100MB budget *before* Phase 1 features |
| Accessibility retrofitted | Expensive, always incomplete | Canvas/custom surface must have an accessible fallback mode from day one |
| Plugin API before the command model is stable | Permanent compatibility debt | No plugins until Phase 4; data-driven themes/keymaps first |
| Collaboration pulled forward | 2–3× schedule | Hard gate: Phase 2 exit criteria met first |
| Undo + multi-cursor + autosave interactions | Data loss | Single-writer document model, one undo stack owner, property-based tests on operations |

---

## 15. Definition of done (per feature)

A feature ships when: it's in the command palette, it has a remappable shortcut, it's undoable if it mutates text, it survives restart if it's state, it works with 20 tabs open and a 10MB file, it's reachable by keyboard only, it's covered by a test at the operation level, and it's documented in one place users actually look.
