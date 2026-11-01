# Style — the one direction this product uses

> Written per `skills/ux/distinctive-visual-style`: three directions proposed,
> one chosen, the rest recorded so the next project cannot quietly reuse them.

## Chosen: **Glacier Cartography**

**Ancestor** — cold-climate topographic survey maps: survey hairlines, legend
panels, a measured grid, one warm mark used sparingly against ice. Not a
dark-hero SaaS page, and deliberately not R1 Paper & Ink.

**Why this one** — WinterCave is a survey instrument for a codebase: you walk a
folder, read the terrain, and the tool reports positions (line:column). Cold
palette, hairline rules and mono captions say "instrument" without the usual
terminal-green or neon-on-black developer cliché.

**Tokens** (`crates/wintercave-server/assets/editor.css`, and the landing page
that follows it):

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| surface | `#0b1418` | `#eef2f4` | page ground — water and ice paper, never `#000`/`#fff` |
| panel | `#0e1a1f` | `#e4ecee` | sidebar, dialogs |
| rule | `#1c2e36` | `#c9d7db` | 1px hairlines; borders do the dividing, not shadows |
| ink | `#dbe8ec` | `#16252b` | body text |
| muted | `#7d949e` | `#566f78` | captions, metadata, `kbd` |
| accent | `#58b7cc` | `#1f6f8b` | glacier blue: focus, current file, primary action only |
| mark | `#e2a869` | `#99571a` | the survey mark: numbers and constants |

**Type** — the UI is system sans for prose and one monospace for anything that is
data: file names, paths, line:column, key hints, captions. Captions are 11px,
uppercase, letter-spaced 0.06–0.08em, like a map legend.

**Shape** — radius 2px. No drop shadows except on modals (which float above the
map and need the separation). No gradients, no glass, no glow.

**Layout** — asymmetric legend on the left (actions, breadcrumb, listing, root
path), the "terrain" on the right (the text). Hairline rules separate; nothing
is boxed twice.

## Rejected

- **REJECTED: Studio Terminal** (graphite `#0E1116`, amber `#FF7A1A`, 2px radius,
  all-mono headings, numbered 01–07 left rail). Rejected because the rail implies
  a spec sheet of finished features, and WinterCave's honest status is "most of
  the engine exists, part of it is wired to the page".
- **REJECTED: Letterpress Cave** (parchment `#F4EDE1`, oxblood `#8A2B1F`, serif
  display, drop caps, marginalia). Rejected because a serif display face reads as
  editorial writing, and this page has to read as a tool someone runs in a
  terminal — the drop cap would promise prose the product does not deliver.

Both are recorded here so a later change does not drift back into them, and so
another project in this workspace does not reuse them either.

## Applying it

- Editor chrome: `crates/wintercave-server/assets/editor.css` — token system, two
  themes, inline theme bootstrap in `src/ui.rs`.
- Landing page: `site/` — same tokens, same rules, no build step.
