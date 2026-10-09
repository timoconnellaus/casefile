# 7. Restricted material is withheld from consumer Claude plans

Date: 2026-10-07
Status: Accepted

## Context

PD-AI para 5.5 says material from discovery, subpoena or production orders, or under a
suppression/non-publication order, must not go into a GenAI tool unless it stays in a closed
environment under enforceable confidentiality terms and is not used for training. The user drives
the CLI with Claude Code on a Pro/Max (consumer) plan.

## Decision

- Each document has a sensitivity: `none`, `discovery`, `subpoena`, `suppression`, `restricted`.
- The case records the user's Claude setup: `consumer` (default) or `commercial`.
- While the setup is `consumer`, a restricted document is published **without its text**: the
  public row has `withheld = 1`, no body, no searchable lines, and a generic title. It cannot be
  cited.
- Switching the setup to `commercial` republishes restricted documents with text; switching back
  removes it again, together with the document details (type, date, author role, source) and tags
  set while the text was visible, because they describe it (security review, 2026-10-07). The
  same applies whenever a document is published as withheld (e.g. its sensitivity is raised),
  on every such publish: public.db's `withheld` flag and `meta_by` are Claude-writable, so they
  cannot be trusted to say whether the details predate withholding. Details the user sets on a
  withheld document therefore last only until it is next republished. Work Claude derived from the text while it was
  visible (chronology entries, notes, drafts that cite or describe it) is not removed: it is
  Claude's own output and stays in public.db; citations to a withheld document can no longer be
  added, and its lines are no longer quoted to Claude.

## Consequences

Withholding is structural (ADR 3): the text is not in `public.db`, so no CLI bug or shell command
can reveal it. The user, not Claude, decides the setup, and the change is logged.

## Amendment (v2 rebuild, W1-B, 2026-10-07): origin, "not asked yet", plan conditions, exposures

Sensitivity was replaced by **origin** in schema v4 (`mine | other_side | court_or_subpoena |
under_order | not_sure`; `null` = not asked yet). Who may see what (`origin.ts` `withheldReason`,
one function used by every path):

| Origin | Consumer plan | Commercial plan |
|---|---|---|
| `mine` | shared | shared |
| `other_side`, `court_or_subpoena` | withheld | withheld until the user shares that one document (`released`) |
| `under_order`, `not_sure` | withheld | withheld |
| not asked yet (`null`), or any unknown value | withheld | withheld |

- **New imports now default to withheld.** A document imported without an origin is "Not asked
  yet" and is published without its text (`withheld_reason = 'not_asked'`) until the user says
  where it came from. This is a deliberate behaviour change users will notice: before v2 the
  default was the user's own material, shared once reviewed.
- **The commercial plan needs three conditions.** `POST /api/plan` (and
  `CaseSession.setClaudeSetup`) refuses `commercial` unless the user confirms a closed
  environment, no training on their material, and use for this case only (PD-AI 5.5). The plan
  and its conditions are stored in the vault settings with the date, attested in the ledger (kind
  `plan`) and logged. A case marked commercial without recorded conditions counts as consumer.
- **Switching plan never shares anything by itself.** Moving to commercial publishes nothing; the
  user shares eligible documents one at a time (`POST /api/docs/:id/share`, or `release` at
  publish), each logged. Moving back to consumer withdraws them and forgets those shares, so a
  later switch to commercial does not bring them back. Changing a document's origin also forgets
  its share. `under_order` and `not_sure` stay withheld on any plan.
- **Exposures.** Every change to who's who (an alias, a rename, a new entity from another
  document, the safety flag) re-checks every shared document. One that now shows a known value
  as written (e.g. the nickname "Annie" just added) is **withdrawn at once**: its text leaves
  public.db (republished withheld, `withheld_reason = 'exposed'`, state "Exposed — re-check"),
  before anything is recorded, so a failure while recording still leaves it withdrawn; a document
  that cannot be checked is withdrawn too. An exposure goes to the vault file `exposures`: the
  roles involved, when it was shared, found and withdrawn, Claude's reads of it through casefile
  in that window (from the AI-use log, `PublicStore.claudeReads`; reads by other means are not
  recorded and the UI must say "through casefile"), and pending documents in which the value was
  newly found (they are detected again). The AI-use log gets only `document_withdrawn {doc,
  reason: "exposed"}`: never the value or the roles. The same check runs when the case is opened,
  for a change saved before the app stopped. A document withheld by its origin is not an exposure
  (Claude never had it), but it cannot be shared until re-checked.
- **Re-check and re-share.** `POST /api/docs/recheck` re-tokenises a document with its earlier
  decisions plus every value now known. If nothing needs the user it is shared again (subject to
  its origin) and the exposure gets `resharedAt`; otherwise it goes back to "Needs review".
  **Re-sharing changes the cited lines, so Claude's work the user had checked against them —
  chronology entries and evidence citing the document — becomes "Changed since you checked"**
  (the ledger's cited-line hashes no longer match, ADR 8). This is intended: the check was made
  against text that has changed.
- **Undo share and Review again.** `withdraw` takes a shared document out of public.db entirely
  and back to review; `reopen` does the same with its earlier decisions offered as accepted
  proposals.

## Amendment (wave 3, v3/docs-api, 2026-10-07): details kept while withheld, triggers, author

Status: Accepted.

- **Undo share keeps decisions.** `withdraw` now works like `reopen`: the document leaves
  public.db entirely, and its earlier replacements come back as accepted proposals (values left as
  written stay left, with their reasons), with anything found since added for review. Withdrawing
  no longer throws away what the user decided.
- **Details kept while a document is withheld.** Withholding still clears the
  document's details (type, date, author role, source) and tags from public.db, as above. When
  a shared document is withheld (a change of origin, a switch to a consumer plan, or an exposure;
  wave 3 extended this from origin changes only), those values (with who set them) are first
  copied into the vault document (`StoredDoc.heldDetails`). When the document is
  shared again (origin set back, a commercial-plan share, a plan switch that shares it, or a
  publish that shares it, such as the re-check after an exposure), they are written back to
  public.db; values set since win, kept tags are added. While withheld, the app shows them to
  the user (`detailsHeld: true`) and Claude has none of them.
- **Exposure triggers.** An exposure records which known values caused it (`triggers: [{role,
  kind: "alias" | "full" | "first" | "surname" | "title" | "part", value}]`, nicknames first) in
  the vault's `exposures` file; `GET /api/exposures` returns them with `trigger` (the first). A
  pending document in which a change to who's who finds new values records them likewise
  (`StoredDoc.newMatch: {foundAt, values, exposed}`, cleared when it is published), for the
  Documents list. These hold real values: they are app-only, never logged, never in public.db.
  Exposures recorded before this work their triggers out again from the withdrawn document.
- **Who wrote a document** is the user's statement, kept in the vault (`checking.ts`
  `setDocAuthor` / `docAuthor`, vault file `document-authors`, added by v3/check-api), exposed as
  `PUT /api/docs/:id/author {role}` and as `author` on `GET /api/docs` and `GET /api/docs/:id`.
  public.db's `author_role` is Claude-writable and stays a hint only. The record follows who's
  who as `relatedTo` does: a renamed role is renamed in it, a role no longer in who's who is
  dropped (so it can't attach to whoever is next given that role); `settings.userRole` follows
  the same way.
- **Dry run.** `POST /api/docs/:id/preview` runs everything publishing would (new entities in a
  copy of who's who, the title detectors, the leak check, the safety refusal) and returns the
  title Claude would see and the result, without saving, logging or creating anything. Publishing
  still runs the leak check itself (ADR 6); the preview is a display aid, not a gate.

## Amendment (wave 3, W3-4 cleanup, 2026-10-07): origin values only

- The API and `CaseSession` accept only origin values. The pre-v4 sensitivity values (`none`,
  `discovery`, `subpoena`, `suppression`, `restricted`) are refused as input (`parseOrigin`), the
  `sensitivity` request and response fields are gone, and so are `POST /api/docs/:id/sensitivity`
  and `CaseSession.setSensitivity` (use `PUT /api/docs/:id/origin` and `setOrigin`).
- Stored data still reads: a vault document saved with a `sensitivity` is read with the matching
  origin (`originFromStored`, used only by `normaliseStoredDoc`), and the public.db v3→v4
  migration maps the column as before. public.db keeps its `documents.sensitivity` column (it
  holds the origin; the CLI and schema use it), and a document withheld by origin still has the
  title `[withheld: <legacy word> material]` there.
