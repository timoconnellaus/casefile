# 20. UI design system: dark only, CSP-safe styling, bundled fonts, one vocabulary

Date: 2026-10-07
Status: Accepted

## Context

The v2 rebuild matches the Workbench design (`DESIGN-SPEC.md` and `CANON.md` from the design
review). The mockups use inline styles and Google Fonts. The app's CSP (ADR 13) is
`default-src 'self'; style-src 'self'`, so the browser blocks both: inline `style` attributes and
`<style>` blocks don't apply, and fonts can only come from the app itself. The CSP stays as it is:
it is part of what stops a hostile page or injected text from reaching re-identified content.

Sixteen screens are being rebuilt in parallel (wave 2). Without a shared component library and
one list of words for each state, each screen would invent its own colours, badges and copy.

## Decision

- **Dark only.** One theme: the spec's Workbench palette. Contrast is specified and tested for dark
  only, so there is no light theme (`color-scheme: dark`). The light/dark legacy CSS variables go.
- **Classes, never inline styles.** Every colour, size and space is a CSS variable in
  `ui/tokens.css`. Components use classes in `ui/components.css` and `ui/shell/shell.css`; each
  screen has `ui/views/<name>.css`. `h()` (`ui/dom.js`, re-exported by `lib.js`) throws on a
  `style` or `innerHTML` attribute, and `tests/ui_model_test.ts` scans the UI for inline styles,
  inline scripts, `innerHTML` and external URLs. The gallery (`/dev/gallery.html`) renders every
  component and must show no CSP violation in the console.
- **Entity colour as classes.** The six colour slots are `.ent-c0` … `.ent-c5` (mother, father,
  child_1, child_2, two spare); everyone else is `.ent-ink`; numbers, dates and addresses are
  `.ent-id`. Each sets custom properties that `.ent` (a real name: colour, tint, underline),
  `.token` (the label Claude sees) and `.ent-dot` read. Underline shape is `.ent-solid` (person),
  `.ent-dashed` (place or organisation) or `.ent-dotted` (number or date). `.ent-plain` on a
  container turns marks off ("Highlight people" off); `.ent-notint` drops the tint (affidavit body).
  Linking (hover after 150 ms, focus, pin) adds `.is-linking` to the container and `.is-on` to
  the linked marks; the rest dim to 60%.
- **Bundled fonts.** IBM Plex Sans (400, 500, 600) and IBM Plex Mono (400, 500) as woff2 in
  `ui/fonts/`, from the `@ibm/plex-sans` and `@ibm/plex-mono` npm packages version 1.1.0 (the
  "complete" woff2 files, about 290 KB together), with the SIL Open Font License 1.1 in
  `ui/fonts/OFL.txt`. The server serves `.woff2` as `font/woff2`.
- **One vocabulary.** `ui/model.js` holds the only mapping from state to words, glyph and tone
  (DESIGN-SPEC §3): documents (Needs review, Shared with Claude, Withheld from Claude, Exposed —
  re-check), Claude's work (To check, Checked against source, Changed since you checked, Can't
  check) and affidavit paragraphs (Your words; Drafted by Claude — needs you / — rewritten by you,
  adopt to confirm / — adopted). `Badge(domain, state)` throws for anything else. Status always
  shows a glyph and words, never colour alone, and only two hues carry status: attention (amber)
  and danger (red). Who did something is a word (`ActorLabel`), never a colour.
- **Component library.** `ui/components/` (Badge, Tag, ActorLabel, Button, EntityMark, TokenChip,
  EntityDot, Segments, Key, linkEntities, LinesTable, SourcePanel, CheckList, ConfirmBar,
  showToast with Undo, announce/live region, Callout, EmptyState, FilterChips, Segmented, Toggle,
  Field, listShortcuts/ShortcutHint, openDialog/confirmDialog, DataTable) and `ui/shell/`
  (AppHeader, ⌘K palette, router). Wave-2 screens use these and don't edit them; anything missing
  goes in a local helper marked `// PROMOTE` for wave 3.
- **Routing.** `ui/routes.js` maps hashes to `views/<name>.js` (`default async (main, params,
  ctx)`). Until a screen is rebuilt its module re-exports the legacy view from `views/legacy/`
  and sets `legacy = true`, which renders it inside `.legacy`: the old stylesheet with every
  selector scoped under that class (`views/legacy/legacy.css`). Legacy views, their CSS and the
  shims are deleted in wave 3. (Done in W3-4, October 2026: `views/legacy/`, `legacy.css`, the
  `.legacy` scope and the `#/search` page are gone, and the `// PROMOTE` helpers moved into
  `components/`, `model.js`, `dom.js` and `lib.js`.)

## Deviations from the spec

- **Control borders are `#626A72`, not `#5A626A`.** The spec says control borders reach 3:1, but
  `#5A626A` is 2.96:1 on the page ground (`#121518`) and lower on panels. `#626A72` is at least
  3:1 on the ground, both panel colours, the header and the ConfirmBar. The test checks each pair.
- **⌘K always works.** Single-key shortcuts follow the "Keyboard shortcuts" setting and only work
  while a list has focus; ⌘K/Ctrl+K is a modifier shortcut for the header's search field and is
  always on.

## Consequences

- Every new screen inherits focus rings, target sizes, contrast and the vocabulary from shared
  code; reviewing a screen means checking structure and copy, not colours.
- The legacy screens keep working inside the new shell (dark, with the new header) until they are
  replaced, so the app stays usable throughout the rebuild.
- Fonts add about 290 KB to the app. They are loaded from the app itself, so nothing reaches a
  font CDN.
- Endpoints that wave 1 adds are optional for the shell: the To-check count is hidden while
  `/api/to-check` answers 404, and ⌘K falls back from `/api/search/all` to `/api/search`.
- `scripts/seed.ts` builds the CANON case (synthetic, ADR 11) for checking screens in the browser.
  It uses core for the user's actions and the CLI for Claude's, then runs any
  `scripts/seed/<area>.ts` a wave-2 package adds.
