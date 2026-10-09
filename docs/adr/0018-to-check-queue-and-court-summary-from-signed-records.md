# 18. The To-check queue and the Court summary come from signed records

Date: 2026-10-07
Status: Accepted

## Context

PD-AI para 4.11 does not require a court user to disclose AI use unless asked. If the Court does
ask, the user should be able to say whether AI was used, what tool was used, how the output was
checked and supervised, and how the practice direction's principles were followed. casefile
holds most of the answer, but much of it sits in `public.db`, and Claude can write to it:
`verified_at`, `adopted_at`, `author`, `created_by`, `removed_at`, `done_at` and the `ai_log`
rows. The old `/api/stats` counted `verified_at`, so Claude could make the numbers look better
than they are. The user also needs one list of everything waiting for them ("To check") that
Claude cannot shorten.

## Decision

`src/core/summary.ts` builds the To-check queue (`toCheck`), the Court summary (`courtSummary`)
and the readable log (`logEntries`, `logCsv`). Routes: `GET /api/to-check`,
`GET /api/court-summary`, `GET /api/log/entries`, `GET /api/log/export`.

**Inputs Claude cannot forge.** The only inputs are:

- the attestation ledger (ADR 8): an item counts as checked or adopted only if
  `isChronologyVerified`, `isEvidenceVerified`, `isIssueVerified` or `paragraphState` say so. A
  user's item is recognised only through `isUserItem`, and a draft's kind only through the ledger;
- the vault: documents and their origins, exposures (ADR 7), lapsed checks and the user's removals
  (ADR 8 amendment), and the settings, including the Claude plan and the PD-AI 5.4 confirmations as the user
  recorded them;
- log rows the app wrote and sealed itself, for paste uses and the detectors used at import.
  `chain`, `chain_kind` and `actor` are public.db columns, so a row's trust is never read from
  them: `sealedLog` checks **each row's seal** against the chain key derived from the vault
  (`Vault.logChainKey`, ADR 8). A row counts as `signed` only if its seal is the HMAC of the
  previous sealed row's seal and its own content, with `chain_kind = 'signed'`. Claude's own rows
  (CLI rows, countersigned with a valid seal, or still unsealed) are used only to say that Claude
  was used and when. Anything else is `forged`: an inserted row with a made-up or copied seal,
  a genuine row whose content was altered, or an unsealed row claiming to be the user's or
  casefile's. Such rows are shown as "Unknown" and never counted. Rows after a forged one still
  verify on their own (the app seals onto whatever seal precedes it), so one bad row does not hide
  the rest;
- `verifyLog()`, whose result is stated in the summary ("Log checked: no changes found since …",
  or that a change was found and figures from the log may be affected).

Claude-writable columns never raise a count or hide an item. Rows with `removed_at` are always
read. An item leaves the queue as "removed" only through the ledger's record of the user's
removal, never because of the column.

**The wording lives in core.** Each section (Whether AI was used · What tools were used · How
Claude's work was checked · How the Court's rules on AI were followed · Still open · The record ·
What this summary cannot show) is a list of finished sentences. The UI shows them as they are and
cannot change them. The response also carries the figures behind them and a plain-text version
for copying. The wording is modest on purpose:

- it says "through casefile" and "as recorded by you". casefile cannot see what Claude did
  outside it, and cannot check the plan or confirmations with Anthropic;
- it counts the user's checks as comparisons with the cited lines, and never claims that
  Claude's work is right;
- it never says "verified", "certified" or "proves";
- it always ends with its limits.

**The queue.** Exposed documents, documents to review, chronology entries and evidence links that
are not checked (to check, changed, can't check), Claude's paragraphs that need the user
(needs you, rewritten and awaiting adoption), and Claude's issue descriptions that are not checked.
The user's own items are not in the queue. Order: danger first (exposed, can't check), then
changed, then the rest. Within each, oldest first. Each item has
`{kind, id, what, detail, where{doc?, line?, href}, actor, state, level, since, next}`. `since`
uses public.db timestamps, which Claude can change. They only affect the order, never what is in
the queue or the counts.

**The log, readable.** Each action has a plain-language label and a category (Claude's use,
Documents, Checking, Drafts, Paste, People, Settings and plan, Case). Labels name document ids
only, never content. Each entry carries `record`: `signed`, `countersigned`, `pending`, `legacy`
or `forged`, from the same per-row seal check; a `forged` row is shown as "Unknown", never as
"You" or "casefile". The CSV export contains the whole log, neutralises cells that a spreadsheet would
treat as formulas (Claude writes some values), and is itself logged (`log_exported`).

**One source per input.** Document states come from `CaseSession.listDocInfo` / `docState`
(ADR 7). This is also what /api/docs, /api/start and People use, so every screen agrees, for
example on an exposed document that was re-checked and is now withheld by its origin. Work
states come from `checking.ts` (`chronologyState`, `evidenceState`, `issueDescState`), whose
lapsed checks come from `Ledger.lapsedCheck`. Removals come from `Ledger.removedByUser`
(`userRemoved`). Paragraph states come from `paragraphState` (ADR 9).

## Consequences

- Forging `verified_at`, `adopted_at`, `author`, `created_by`, `removed_at` or log rows in
  public.db, including rows that claim `chain_kind = 'signed'` with a plausible or copied seal,
  changes neither the queue nor the summary's counts (tests/summary_test.ts, tests/tocheck_test.ts).
- `summary.ts` repeats the store's chain input (`PublicStore.#chainInput`) to check rows one by
  one; the two must stay in step until wave 3 moves per-row checking into the store. Forged
  log rows make the log check fail, and the summary says so.
- Building the summary reads every document from the vault and checks every attestation, which
  is fine for cases of a few hundred documents. It is computed on request, never stored.
- Cases created before log sealing have `legacy` rows. Those are not counted for paste uses or
  detectors, so such cases may under-report. They never over-report.
- `/api/stats` stayed until wave 3 for the legacy UI; it was removed in W3-4 (October 2026).

## Amendment: acknowledged log problems in the summary (2026-10-09)

The record section lists every recorded log problem once there is more than one or any is
acknowledged, each marked "acknowledged by you on <date>" when the user acknowledged it (ADR 28).
The acknowledgement comes from the vault, never from public.db.
