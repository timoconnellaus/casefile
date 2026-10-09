# 9. Affidavit paragraphs: authorship tracking and adoption

Date: 2026-10-07
Status: Accepted

## Context

PD-AI para 4.9: an affidavit must be in the witness's own words. The user chose to track
authorship per paragraph, with export blocked until every Claude-written paragraph is rewritten
or explicitly adopted.

## Decision

- Every paragraph records its author (`user` or `claude`) and, for Claude's, the text Claude wrote.
- Claude can add paragraphs and edit or remove its own. It cannot edit or remove the user's; it
  can leave notes on them.
- A Claude paragraph becomes the user's when the user rewrites it substantially (token-level
  similarity to Claude's text below 50%).
- Otherwise the user must **adopt** it: a deliberate, per-paragraph attestation ("this is true, from
  my own knowledge, and how I would say it"), signed (ADR 8) and logged. There is no bulk adopt.
- Exporting an affidavit is blocked while any Claude paragraph is neither rewritten nor validly
  adopted. Other draft kinds (outline, submission, letter) export freely; the kind that counts is
  the one recorded in the vault, not public.db's (see "Draft kind" below).

## Consequences

Affidavits that leave the app are demonstrably the user's words or deliberately adopted, and the
AI-use log shows which.

## Implementation

`src/core/drafting.ts` (app side only; the CLI must not import it, enforced by
`tests/boundary_test.ts`).

- **Similarity**: Sørensen–Dice coefficient over the multisets of lower-cased word tokens,
  `2·|A ∩ B| / (|A| + |B|)`. A token such as `{{mother.first}}` is one word; punctuation, whitespace
  and word order are ignored (reordering Claude's sentences is not a rewrite). Two empty texts score
  1, an empty text against a non-empty one 0.
- **Threshold**: a user edit of a Claude paragraph makes it the user's when its similarity is
  below 0.5, where the similarity is the **higher** of its similarity to the text the user started
  from (`body`) and to the text Claude last wrote (`claude_body`) (`rewriteSimilarity`). Both
  columns are writable by Claude. Comparing with `claude_body` alone let Claude replace it with
  garbage so that any light edit looked like a full rewrite. `body` is what the app showed the
  user, so lowering `claude_body` alone cannot flip authorship, and if Claude corrupts `body` the
  user sees that text and writes over it, which really is their own words. The cost is that small
  edits no longer accumulate: each edit is measured against the text in front of the user, so to
  make a paragraph theirs the user has to rewrite most of it in one edit. A light edit keeps
  `claude_body` as it was (`PublicStore.updateParagraph(..., { keepClaudeBody: true })`).
- **Authorship attestation**: the `author` column is unsigned, and Claude could set it to `user` on
  its own paragraph. So whenever the user writes or rewrites a paragraph in the app
  (`userAddParagraph`, or `userEditParagraph` when the result is the user's), the app records an
  `authorship` attestation over the paragraph's id, draft and body in the vault's attestation
  ledger (ADR 8). A paragraph counts as the user's only if `author = 'user'` **and** that
  attestation matches its current body. Otherwise it is treated as Claude's: its status is
  `claude_needs_review` (or `claude_adopted` if validly adopted), a user edit is measured as an
  edit of Claude's text, and it can be adopted. Paragraphs written before this attestation existed
  need to be re-saved or adopted.
- **User text** is tokenised (`tokeniseUserText`) before it is stored, so the user can type real
  names. Any change to a paragraph clears its adoption.
- **Adoption** takes an attestation object `{ ownKnowledge: true, ownWords: true }`; both fields
  must be literally `true`. It applies only to Claude paragraphs, one at a time (there is no bulk
  adopt), is signed over the paragraph's id, draft, body, author and `adopted_at` (ADR 8), and is
  logged as `paragraph_adopted`. The attestation wording shown in the UI will be: "This paragraph
  is true, it is from my own knowledge, and it is how I would say it."
- **Status** is `user` (authorship attested for the current body), `claude_adopted` (the adoption
  is the ledger's current one and its signature checks out) or `claude_needs_review`. A forged
  `adopted_at`, a body changed after adoption, a forged `author`, or an adoption written back after
  it was withdrawn is `claude_needs_review`.
- **Export** re-identifies the title and paragraphs and returns `{ filename, content }` for the app
  to deliver as a download; nothing is written into the case folder (ADR 3). Affidavit paragraphs
  are numbered; other kinds are plain paragraphs. The filename is `<kind>-<draft id>-<date>` and
  never contains names. An affidavit with any `claude_needs_review` paragraph, or any draft with an
  unknown or malformed token, throws `ExportBlockedError` listing the paragraphs. Both outcomes are
  logged (`exported` / `export_blocked`), without the content.
- **Draft kind** (security review, 2026-10-07): `drafts.kind` is in public.db, so Claude could
  change an affidavit to `outline` and export unreviewed paragraphs. The vault's attestation ledger
  records each draft's kind (ledger kind `draft`, signed over `{ id, kind }`): when the user creates
  a draft in the app (`userCreateDraft`), and, for drafts Claude creates through the CLI, the first
  time the app sees them (`CaseSession.recordDraftKinds`, run when a case is opened and whenever
  the app lists or shows drafts). From then on the recorded kind is the truth: `draftKind` returns
  it when public.db agrees, and **`affidavit`** (the strictest kind, with the export gate and
  numbering) when the stored kind differs or was never recorded. A changed kind is logged on a
  blocked export (`stored_kind_changed`) and the API reports it (`kindChanged`). Unlike other
  ledger entries, a `draft` entry is not dropped when public.db disagrees with it, only when the
  draft is deleted. A Claude draft whose kind Claude changes *before* the app first sees it is
  recorded as changed; that is no worse than Claude creating it with that kind, which it may.

## Amendment (2026-10-07, v2): authorship is history, not similarity

Status: Accepted. Supersedes the **Similarity**, **Threshold** and "becomes the user's when the
user rewrites it substantially" parts above.

### Context

The similarity rule turned authorship into a measure of the text: rewrite enough words and a
Claude paragraph silently became "Your words". That is the wrong question for PD-AI 4.9. A
paragraph that started as Claude's draft is still a paragraph Claude drafted, however much the
user changed it; what matters is that the user deliberately confirmed it. The number was also
gameable from both sides (Claude can write `body` and `claude_body`) and hard to explain.

### Decision

- **Four states** (`ParaState`, DESIGN-SPEC §3): `user` ("Your words"), `claude_needs_you`
  ("Drafted by Claude — needs you"), `claude_rewritten` ("Drafted by Claude — rewritten by you,
  adopt to confirm") and `claude_adopted` ("Drafted by Claude — adopted"). "Drafted by Claude"
  is permanent history. There is no similarity measure anywhere (`similarity`,
  `rewriteSimilarity` and `REWRITE_THRESHOLD` are removed; the API kept `similarity: null`
  until W3-4 removed it).
- **`user`** only for paragraphs the user wrote in the app (`userAddParagraph`): `author = 'user'`
  and an `authorship` attestation matching the current body. Editing them keeps them the user's.
- **A user edit of a Claude paragraph**, light or heavy, keeps `author = 'claude'` (and
  `claude_body`, Claude's text, for reference) and records a signed **`rewrite`** attestation
  (ledger kind `rewrite`, content `{id, draft_id, body}`) over the body the app wrote. The state is
  `claude_rewritten`. Any change to the body by Claude makes the attestation stale; it is then
  dropped for good, so putting the user's text back does not revive it (`claude_needs_you`).
- **Adoption** applies to `claude_needs_you` and `claude_rewritten` alike, one paragraph at a
  time, as before. It is **refused while the body contains `[In your own words`** (any letter
  case): Claude leaves that placeholder where only the user can speak, and it must be replaced
  first. Adoption may carry per-fact answers (`facts: [{text, answer: "saw"|"read"|"unsure"}]`,
  "Did you see this yourself or read it?"). They are stored in the vault (`adoption-facts`) and
  the log records only counts (`facts: {saw, read, unsure}`); they are not part of the signature.
  Withdrawing an adoption of a rewritten paragraph returns it to `claude_rewritten`.
- **Export gate.** An affidavit exports only when every Claude paragraph is `claude_adopted` and no
  paragraph holds a placeholder (`ExportBlockedError` gains `placeholders`). Other kinds export
  with **flags** (Claude paragraphs not adopted, placeholders, and casefile's checks that need a
  look in Claude's unadopted paragraphs) that the user must confirm (`?confirm=1`; otherwise 409
  `needsConfirm`). The log records how many flags were confirmed. Unknown or malformed tokens
  block every kind, as before.
- **Sources and checks.** The user can set a paragraph's sources (document lines; withheld,
  missing or out-of-range documents refused, checked against the vault) and what it relies on
  (chronology entries, evidence links). Each paragraph shows casefile's checks of its text against
  its sources (`claimcheck.checkClaim`). Sources are not part of the adoption signature.
- **Affidavit heading** (file number, deponent / applicant / respondent as roles, occupation,
  address, sworn or affirmed) identifies people, so it is kept in the vault only
  (`draft-heading-<id>`, tied to the draft's `created_at` so a reused id does not inherit it;
  cleared when the user deletes the draft). public.db and the log record only that it changed.
- **Export layout.** Affidavits get the heading, numbered paragraphs and a jurat, with
  `[check against the Court's current form]` where the Court's form governs and bracketed
  placeholders for anything missing. Citations such as `D001:3` become
  "Text messages, March 2025, line 3" (document titles from the vault).

### Grandfathered paragraphs

Paragraphs that became the user's under the old similarity rule (a heavy rewrite set
`author = 'user'` and recorded an `authorship` attestation) cannot be told apart from paragraphs
the user wrote from scratch: `claude_body` might hint at it, but it is writable by Claude. They
stay `user` ("Your words"). This only affects cases edited before this amendment, and every such
paragraph was rewritten by the user under a rule that was in force at the time.

### Consequences

- A heavy rewrite no longer gets an affidavit past the gate without a deliberate adoption.
- Because a rewritten paragraph stays `author = 'claude'`, the CLI still lets Claude edit it (it
  refuses only the user's and adopted paragraphs). Such an edit invalidates the rewrite, so the
  paragraph shows "needs you" again; nothing Claude changes can be exported as adopted.
- The legacy `status` field (`user` / `claude_adopted` / `claude_needs_review`) stayed until wave
  3 (rewritten paragraphs reported `claude_needs_review` there); W3-4 removed it and
  `paragraphStatus`. `state` is the only paragraph field.

## Amendment: facts are split once, by core (v3 check-api, 2026-10-07)

"Fact by fact" is `drafting.paragraphFacts`: the paragraph split by `claimcheck.splitSentences`,
each sentence checked against its own inline citations or else the paragraph's sources. The draft
view shows these facts (`paragraphs[].facts`), and `adoptParagraph` matches the answers to the same
split: one answer per fact, in order (`facts: [{answer, text?}]`). The recorded fact text is the
one casefile showed, re-identified; a `text` sent that differs means the paragraph changed since it
was shown (`StaleItemError`, 409 `stale`), and a different number of answers is refused. What is
recorded in `adoption-facts` is therefore exactly what the user was shown.
