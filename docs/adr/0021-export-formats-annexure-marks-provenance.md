# 21. Export formats: RTF for Word, annexure marks, provenance report, safety warning

Date: 2026-10-07
Status: Accepted

## Context

Wave 3 (REBUILD-PLAN W3-1) needs exports a court user can file or hand on: the affidavit in a
form Word opens, the chronology as a table, and a record of whose words each paragraph is. The
plan defers `.docx` and PDF (no approved dependency; zip and docx generation is unreviewed
surface), so the honest replacement is "Export for Word (.rtf)" with "to make a PDF, open it in
Word and Save as PDF". Annexures need marks (e.g. AT-1), and marks start with the deponent's
initials, so they identify a person. An export may also be given to the other side, so a
safety-sensitive person's address in it is a risk the user should see first (ADR 0015).

## Decision

**RTF writer.** `src/core/export/rtf.ts` writes RTF 1 with no dependency: paragraphs (bold,
italic, alignment, size), numbered paragraphs with a hanging indent, and bordered tables. All
text goes through `rtfText`: `\`, `{`, `}` are escaped; line feeds and tabs become `\line` and
`\tab`; other control characters are dropped; everything outside printable ASCII is written as
`\uN?` (UTF-16 code units, `\uc1`), so the file is 7-bit and text can never open a group or
start a control word. Tests parse the output and check that a paragraph full of braces,
backslashes and RTF syntax yields exactly the writer's own control words, and convert the output
with macOS `textutil` (when present) to check that a real RTF reader gets the same text back.

**Draft export.** `GET /api/drafts/:id/export?format=markdown|text|rtf` (Markdown stays the
default) moves to `routes/export.ts` and `export/draft.ts`. The gates are unchanged (ADR 9): an
affidavit is blocked while a Claude paragraph is not validly adopted or holds a placeholder, any
draft while a label cannot be re-identified, and other kinds' flags need `confirm=1`. Affidavits
get the heading from the vault, numbered paragraphs, a jurat and
"[check against the Court's current form]" markers, in every format.

**Annexure marks** are kept in the vault only (`annexure-marks-<draft id>`, with the draft's
`created_at` so a reused id does not inherit them), never in public.db, never in the log (which
records `annexure_marks_set {draft, marks: <count>}`), and the CLI cannot read them.
`GET /api/drafts/:id/annexures` returns `{marks, docs:[{doc,title,mark}], prefix, suggested}`
(suggestions are the deponent's initials from the heading, numbered in citation order);
`PUT /api/drafts/:id/annexures {marks:{D001:"AT-1"}}` replaces them. A mark is up to 20 letters
and digits with spaces, dots or hyphens between, unique in the draft. On export a citation of a
marked document becomes "annexure AT-1"; any other citation becomes "Title, line N".
"My affidavit sworn [date], para 4" for the user's earlier affidavits is not built.

**Chronology export.** `GET /api/chronology/export?which=checked|all` returns an RTF table
(landscape A4): date, what happened, source (citations as plain descriptions), added by, and
for `all` a "Checked" column where unchecked entries say NOT CHECKED (with "changed since you
checked" or "can't check"). Checked means a current signed check (`chronologyState`), never
`verified_at`; entries the user removed (ledger) are left out.

**Provenance report.** `GET /api/drafts/:id/provenance` returns Markdown built like the Court
summary (ADR 0018) from records Claude cannot forge: paragraph states and signed adoption times
from the ledger, the kind from the ledger, the fact answers from the vault (only for the current
adoption), the plan from the vault's settings and log rows whose seal verifies (others are
counted as "could not be verified and left out"). Paragraph sources are not signed, so they are
not listed; the report says so in "What this report cannot show".

**Safety warning.** Before any of these exports includes a protected address it answers 409
`{safetyConfirm:true, addresses:[{label, person}]}` (labels only, never the address) until the
request repeats with `confirmSafety=1`. An address is protected when who's who says its values
are safety-sensitive (`EntityRegistry.isSafetySensitive`: the address is marked itself, or it
belongs to a safety-sensitive person through `relatedTo`, ADR 15 amendment 3), or when it is the
affidavit heading's address and the deponent is safety-sensitive. `person` is the
safety-sensitive person it belongs to, if any. The label plays no part (amended in wave 3: the
first version matched labels by name, `mother` → `mothers_home`, as a stand-in for the link).
Matching is the leak check's own (`findKnownSpans`
with `leak: true`, ADR 6): folded case and spacing, every alias and every identifying part (the
street without its number, the suburb). It runs on the export as its reader sees it (RTF decoded
back to text by `rtfToText`, Markdown with its escapes removed), on the same text with line
breaks as spaces, and on the whole source strings the export was built from (the provenance
report shortens paragraphs), so escaping, wrapping or truncation cannot hide a value.

The 409 for flags an outline or letter needs confirmed (`needsConfirm`) carries the flags with
their messages re-identified (`message`, same shape as before).

**Downloads and logging.** Every export is a download (`Content-Disposition: attachment`,
`Cache-Control: no-store`, the usual security headers), with a filename that carries no names,
and is never written into the case folder. Log rows carry counts only: `exported` (+ `format`,
`annexure_citations`, `safety_confirmed`), `export_blocked` (+ `format`), `export_safety_warned`,
`chronology_exported {format, scope, entries, unchecked, left_out}`, `provenance_exported`.

## Consequences

- Routes in `routes/export.ts` are registered first, so `/api/chronology/export` is never taken
  for an entry id if a `GET /api/chronology/:id` route is added.
- RTF is only a layout aid: the markers tell the user to check against the Court's current form.
  `.docx` and PDF remain deferred.
- A detail of a safety-sensitive person that is neither linked to them, marked itself, nor
  labelled as theirs is not protected; the People screen's "Whose is this?" link is how the user
  says so (amendment 1 below).
- `export/draft.ts` `exportDraftFile` is the one draft export (the old `drafting.exportDraft`
  was folded into it in wave 3), so every export runs the safety check.

## Amendment 1 (security review, 2026-10-07): fail closed for unlinked details; every detail kind

The wave 3 change above made the warning depend on `relatedTo` alone. A case made before links
existed has, for example, `mothers_home` under a safety-sensitive mother with no link, so its
exports stopped warning: fail-open. Two changes:

- **The label rule is back as a fallback.** A non-person entry with no `relatedTo` whose label
  reads as a safety-sensitive person's (`<person>_…` or `<person>s_…`, the longest person label
  winning, so `child_10_phone` is `child_10`'s) is protected, with `via: "label"`. An explicit link
  decides instead: a detail linked to someone else is that person's, whatever its label.
- **Every detail kind, not only addresses.** The warning covers every non-person entry whose
  values are safety-sensitive (`EntityRegistry.safetyOf`: its own flag, or the flag of the person
  it is linked to): addresses, phones, emails, identifiers, dates of birth, places and
  organisations. A person's own name is not a detail and doesn't trigger it.
- **Shape.** The 409 keeps its field name, `addresses`, with each entry now
  `{label, person, kind, via}`, where `via` is `"flag"`, `"link"`, `"label"` or `"heading"`. The
  message and the app's ConfirmBar say "contact details or an address" when anything other than
  an address is included. `export/safety.ts` exports `protectedDetails(registry)` (what is
  protected and why), `labelOwner` and `labelLinkSuggestions`.
- **Suggesting the link (app only).** `GET /api/people/link-suggestions` and a `linkSuggestions`
  list on `GET /api/people` give `{role, person, safety}` for each unlinked non-person entry whose
  label reads as a person's. When a case is opened the app mentions any for a safety-sensitive
  person and points to People, where each has "Link to <name>" (the usual
  `PATCH /api/entities/:role {relatedTo}`) and "Not now" (hidden for that browser session only).
  casefile never makes the link itself: which detail is whose is the user's statement (ADR 15
  amendment 3). Dismissing a suggestion doesn't lift the export warning; linking the detail to
  someone else does. Suggestions carry labels only and, like `relatedTo`, never reach `public.db`.
