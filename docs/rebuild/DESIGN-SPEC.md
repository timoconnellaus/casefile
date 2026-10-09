# casefile Workbench — revision spec (v2)

Shared contract for every screen. Where this conflicts with an existing board, this wins.
Source: the 16-angle review (`REPORT.md` next to this file). Theme: dark Workbench (IBM Plex Sans /
IBM Plex Mono, ground `#121518`, panels `#15191C`/`#171B1F`, borders `#262B30`/`#2F353B`).

## 1. Colour roles (no colour means two things)

| Role | Style |
|---|---|
| Body text | `#E3E6E9`; muted `#A7AFB7` (min for any readable text); line numbers `#8E979F` |
| Primary action | solid **neutral light** button: bg `#E3E6E9`, text `#121518`, weight 600 |
| Secondary action | transparent, 1px border `#5A626A` (≥3:1), text `#E3E6E9` |
| Link | `#B7DBF2`, underlined |
| Selected row/item | raised surface `#222830` + 2px left bar `#E3E6E9` (never a status hue) |
| Focus | every interactive element: `outline: 2px solid #FFD27A; outline-offset: 2px` (focus-visible) |
| **Status hues — only these two** | **attention** amber `#E8A33D` (on `#2A2418`, border `#5A4114`); **danger** red `#F4867A` (on `#3A1A17`, border `#6B2A24`) |
| Checked / neutral states | no hue: `#E3E6E9` text with an icon |

Status is ALWAYS icon + text in a Badge, never colour alone. Badge glyphs (inline stroke SVG or text):
check ✓ (checked), dot ● (attention), triangle ▲ (danger), circle-i (info), pen (drafted by Claude).

## 2. Who did it (actor)
Never colour. A small text label: **"Claude"** (with a small spark-free robot/pen glyph) or **"You"**.
Claude's notes are always labelled "Claude's note". Things the app checked itself: "casefile checked".

## 3. State vocabulary (one word per state, everywhere)

- **Document:** `Needs review` (attention) · `Shared with Claude` (neutral ✓) · `Withheld from Claude` (neutral, lock glyph) · `Exposed — re-check` (danger: a known name/number is visible to Claude).
- **Claude's work** (chronology entry, evidence link, issue): `To check` (attention) · `Checked against source` (✓) · `Changed since you checked` (attention) · `Can't check` (danger: unknown token or uncitable source).
- **Affidavit paragraph:** `Your words` (✓) · `Drafted by Claude — needs you` (attention) · `Drafted by Claude — rewritten by you, adopt to confirm` (attention) · `Drafted by Claude — adopted` (✓, pen glyph). Drafted-by-Claude is permanent history; no similarity meter anywhere.
- Never use: unverified, verified (as a word on screen), publish, tokenise, entity, leak, de-identified (in UI copy; say "with names replaced").

## 4. Entity colour (people and places in text)

Budget: **6 hues** for the parties and children only (Paul Tol "light" scheme, colour-blind-safe on dark):
`mother #FFAABB` · `father #77AADD` · `child_1 #44BB99` · `child_2 #BBCC33` · spare `#99DDFF` · spare `#EEDD88`.
Everyone/everything else (grandparents, teachers, schools, places, organisations): **neutral ink** `#D5DAE0`
with the role chip, dashed underline for places/organisations, solid for people. The user can "Give a colour"
to one more person in People (spare slots; taken slots shown disabled).
Identifiers (phone, email, Medicare, TFN, ABN, file numbers, DOB): neutral `#C3CAD1`, dotted underline, chip
labelled by type. Tokens for identifiers use their own roles: `{{phone_1}}`, `{{email_1}}`, `{{medicare_1}}`,
`{{tfn_1}}`, `{{dob_1}}`, `{{file_number}}` — NEVER `{{mother.phone}}` (only forms first/surname/title exist).

Rendering — real text: colour + 1.5px underline (solid/dashed/dotted) + background tint 12% (no tint in
affidavit body). Token: mono chip, colour text, tint 14%, 1px border 55%, radius 4px. Unknown token: danger badge style.

Where colour shows: **full colour** on Review (Workbench), Document and Paste — these are about the link
between names and tokens. On Chronology, Issues and Draft names are **plain by default** with a
"Highlight people" toggle (off) in the toolbar. Wherever colour shows, show a visible **key**.
Marks are focusable (`tabindex="0"`) and have `aria-describedby` to a hidden "Anna Thornbury — Claude sees {{mother.first}}".
Hover/focus/pin links all occurrences; others dim to 60% (not lower); a hover only takes effect after 150 ms.

## 5. Components (use these names and shapes on every board)
- **AppHeader**: brand · case name · nav (Documents · To check (count) · People · Chronology · Issues · Drafts · Log · Settings; Paste lives in "To check"/Drafts, Search is ⌘K in the header) · search field (⌘K) · auto-lock note "Locks after 30 min idle" (small) · Lock. Same on every board; `aria-current="page"` on the current item.
- **Badge**(state) — only the states in §3. **ActorLabel** (Claude/You). **EntityMark**, **TokenChip**, **EntityDot**, **Key** (legend).
- **SourcePanel**: cited lines with ±2 lines of context, document name + line link, "Open document".
- **CheckList**: app-side checks shown as rows "✓ 14 March 2025 appears in D002:9" / "▲ Lachlan is not in D001:1–2".
- **ConfirmBar** for consequential actions: summarises what will happen in plain words + primary + Cancel; Undo toast after.
- Keyboard shortcuts only when the list has focus; Settings has "Keyboard shortcuts: on/off". Show shortcut hints only when on.
- Empty/error states use the same panel with a plain sentence and one action.

## 6. Plain English (copy rules)
- Say what the user is doing: "Share with Claude" (not publish), "Check against the document" (not verify),
  "Use these words as my own" (adopt), "Names replaced" (de-identified), "Who's who" (entities/token key).
- First mention of the practice direction on a screen: "the Court's rules on AI (PD-AI 5.5)", then "PD-AI 5.5".
- Guidance that governs an action sits next to that action at body size (14px), not 12px grey.
- Calm, specific, non-blaming. Say whether harm happened and what to do next.
- Evidence stance labels: "Helps your account" / "Points the other way" / "Background".
- No developer words: model ids, sandbox, leak check, intact, Ollama, tokens-as-jargon (say "label", show the chip).

## 7. Accessibility
Real `<button>`/`<a href>`/`<label>`; one `<h1>` per board; section titles are headings; side-by-side is a
`<table>` with row headers (line numbers) and column headers; live region (`role="status"`) for results of
actions; repeated buttons get distinct accessible names (`aria-label="Check chronology entry 14 March 2025"`);
targets ≥ 44px for primary actions, ≥ 32px elsewhere; text ≥ 4.5:1, UI borders ≥ 3:1.

## 8. Data the screens may show (honesty rule)
Show only what casefile can actually know or check. Don't claim things outside its control (e.g. "vault
blocked for Claude Code: yes"). Counts in the Court summary come only from checks the app recorded.
