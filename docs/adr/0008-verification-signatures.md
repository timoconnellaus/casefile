# 8. Verification signatures

Date: 2026-10-07
Status: Accepted

## Context

PD-AI para 4.7 requires the user to check AI output themselves. Claude writes to `public.db`, so
a simple `verified` flag could be set, or verified content altered afterwards, without the user
knowing.

## Decision

When the user verifies a chronology entry, an issue or an evidence link, or adopts an affidavit
paragraph, the app stores an HMAC-SHA256 signature over the record's canonical content plus the
verification time. The key is derived from the vault data key (ADR 4), so only the unlocked app
can sign. The app shows an item as verified only if the signature checks out. Ordinary edits
through the store clear the verification.

### Attestation ledger (added after the milestone 5 security review)

A signature in `public.db` proves the app once signed that content, not that the attestation is
still current. Claude can write `public.db`, so after the user unverifies an item or withdraws an
adoption it could write the old (`verified_at`, signature) pair back, and the signature would
check out again (a replay). The same applies to any record whose verification was cleared by an
edit and whose content is later restored.

So the vault holds an **attestation ledger** (vault file `attestations`, a JSON map
`"<kind>:<id>" -> signature`; kinds `chronology`, `evidence`, `issue`, `paragraph` for adoptions,
`authorship`, `draft` (the recorded kind of a draft, ADR 9) and `user_item` (see the amendment
below)). It is the source of truth for which attestations are current:

- Signing (verify, adopt, recording user authorship) records the new signature in the ledger.
  The ledger is written after the `public.db` update succeeds, so a failure part-way leaves the
  item unattested.
- Revoking (unverify, un-adopt, a user edit that invalidates an attestation) deletes the ledger
  entry first, then clears `public.db`.
- A check passes only if the ledger has an entry, the signature stored in `public.db` equals it,
  and the HMAC verifies over the record's current content. The HMAC stays as defence in depth.
- A missing ledger entry means "not verified". Deleting a record through the app
  (`CaseSession.delete*`) drops its entries so a reused SQLite id cannot inherit them; entries for
  records deleted elsewhere are reported and then pruned when the case is opened (see "Deleted
  attested items" below).
- `CaseSession.attest`, `revoke` and `isAttested` are the primitives; the verify/unverify/is*
  methods go through them. Ledger writes are queued so they reach the vault in order.

Cases created before the ledger have no entries, so their earlier verifications and adoptions show
as unverified and must be redone. Restoring content Claude changed *and* its old signature, while
the ledger still holds that signature, shows as verified again; that is the content the user
verified, so it is accepted.

## Consequences

Forged verifications and edits after verification show as unverified in the app
(tests/session_test.ts); replayed signatures after a revocation show as unverified, including
across reopening the case (tests/attestation_test.ts). The CLI cannot check signatures and reports what the store says; Claude is
told its output is unverified until the user checks it.

## Amendment: stale entries and failed writes (security review, 2026-10-07)

- **Stale entries die permanently.** When the app sees that an attested record's content no longer
  matches its signature, it removes the ledger entry. On open, every entry is checked against
  current content and dropped if it no longer verifies. Putting the old content and signature
  back afterwards does not revive it. (Content edited *and* restored while the app was closed is
  indistinguishable from never having changed; that is acceptable because it is exactly what the
  user verified.)
- **Writes never make memory more trusting than the vault.** A new attestation is written to the
  vault before it is used. A revocation is applied in memory first and then written; if the write
  fails the user is told, and the next successful write saves it.

## Amendment: vault-sourced quotes, cited lines, races and authorship (security review, 2026-10-07)

- **Quotes come from the vault.** `public.db`'s `lines` are writable by Claude, so a verification
  made against a quote from there could be a verification of invented text. Every quote the app
  shows (chronology sources, evidence, search results, the document view and the "what Claude
  sees" view) is built from the vault's tokenised text (`CaseSession.citedLines`,
  `publishedView`). Search still uses public.db's FTS index to find hits, but each hit's text comes
  from the vault and hits the vault does not have are dropped.
- **public.db is reconciled on open** (`reconcilePublic`): every published document's row and
  lines are compared with what the vault says was published and republished on any mismatch;
  documents the vault did not publish are removed; an inconsistent FTS index is rebuilt. Repairs are
  logged as `public_store_repaired` with the document ids.
- **Verifications cover the cited lines.** The signed content of a chronology entry and of an
  evidence link includes a SHA-256 of the tokenised lines each citation points at (`cited`), from
  the vault. If those lines change (e.g. a re-publish), the verification no longer holds.
  Signatures made before this change do not include `cited`, so those items show as unverified
  and must be verified again; that is accepted.
- **The user verifies what they saw.** Each item the API returns carries a `version` (a SHA-256
  of the attested content without the time, `itemVersion`); verify and adopt requests must send
  it back (the API refuses a request without one) and are refused (`StaleItemError`) if the item
  changed in between, so Claude cannot swap the text between display and click. The version is
  recomputed by the app each time, never read from public.db.
- **Fail closed on what cannot be checked.** A chronology entry or evidence link citing lines the
  vault cannot quote (an unknown, unpublished or Claude-inserted document) cannot be verified. An
  empty log, or one whose recorded head is missing, is reported as not intact.
- **Ids.** SQLite reuses the highest rowid after a delete, and Claude can insert rows with explicit
  ids, so no attestation is bound to an id alone: each is an HMAC over the record's content
  (including the id), so an id reused by different content inherits nothing.
- **Ledger writes are serialised and never stale.** Ledger writes run one at a time and each
  snapshots the in-memory ledger inside the lock, so concurrent requests cannot overwrite each
  other's entries. Revocations are applied to memory first and bump a revocation epoch; an
  attestation that started before a later revocation of the same key is dropped, so a revoked
  verification cannot be revived by a slower concurrent verify. The epoch is taken when the
  request arrives (`requestEpoch`, before any await), not when signing starts, so "requested last"
  means what the user did last even if the earlier request finishes later; an attestation whose
  key was revoked meanwhile writes nothing at all. `isAttested` re-reads the ledger after its
  await, so a check in flight when a revoke is requested reports "not verified". A stale entry it
  finds is removed only if it is still the same signature (not one re-attested meanwhile).
- **Document cache.** The app caches decrypted documents. Each save or delete bumps the
  document's generation; a read that overlapped a save does not put what it read into the cache,
  so a slow read can never reinstate an older version (found by review: the cache was filled from
  a read taken before an await, after a newer version had been saved).
- **Attest what the app wrote, not a re-read.** Authorship attestations (ADR 9) and user items are
  signed over the values the app itself wrote, not rows read back from public.db, because Claude
  can write between the app's write and its read.
- **Who created an item** (`created_by`) is unsigned. The ledger records the user's chronology
  entries, issues, evidence links and notes (kind `user_item`, id `"<type>/<n>"`), signed over the
  content the app wrote (not the id alone, so a reused rowid or content Claude rewrote does not
  inherit it; the user's own chronology edits re-record it). The API shows an item as the user's
  ("You") only if `created_by = 'user'` and that record matches its current content; anything else
  is shown as Claude's. The CLI still uses `created_by` to decide what Claude may change, which only
  limits Claude, never the user.

## Amendment: a tamper-evident AI-use log (security review, 2026-10-07)

The AI-use log (`ai_log` in public.db) is what the user relies on to answer the Court under PD-AI
4.11, and Claude can rewrite it. It is now **hash-chained** (public.db schema v2 adds `chain` and
`chain_kind`):

- Every row the app writes gets `chain = HMAC(key, previous chain ‖ row)` where the row is its id,
  time, actor, action, detail and `chain_kind`, and the key is derived from the vault data key
  with HKDF (`Vault.logChainKey`, info `casefile-log-chain`). `chain_kind` is `signed`.
- The CLI has no key, so its rows are written unchained. Before every app write (and when a case
  is opened) the app **countersigns** all unchained rows after the last chained one, in id order
  (`chain_kind = countersigned`). From then on altering or deleting them is detectable. A row
  Claude inserts claiming to be the user's or the app's is countersigned too, but flagged: the app
  never writes unchained rows, so a countersigned row whose actor is not `claude` is a forgery.
- The vault records the last chained entry (vault file `log-head`), so deleting entries from the
  end is detected; the case settings record that the log is chained, so deleting `log-head` does
  not make later rows look like pre-chaining ones.
- When a case is first opened by a build with chaining, existing rows are countersigned once as
  `legacy`; they are only as trustworthy as the log was before.
- `CaseSession.verifyLog()` (API `GET /api/log/verify`) reports `intact`, or the first entry that
  was altered, inserted or follows a deletion, plus forged entries and how many CLI entries are
  still pending countersignature.

Limits: CLI rows Claude alters or deletes *before* the app countersigns them (while the app is
not running, or between app writes) cannot be detected; the chain proves the log as the app saw
it. The CLI now also logs its read commands (`entities`, `docs list`, `chrono list`, `issue
list/show`, `draft list/show`, `note list`, `tags`, `log`).

## Amendment: deleted attested items and the evidence cascade (design review, 2026-10-07)

Claude could delete work the user had verified or adopted (`chrono rm`, `issue rm`, `evidence rm`,
`para rm` on its own items), and `issue rm` cascaded to the user's evidence. On open the app then
pruned the dangling ledger entries silently, so the user never learned the work was gone.

- **The CLI refuses** to change or remove a verified or adopted item, and `issue rm` while the
  issue has evidence that is the user's or verified (ADR 3 rule 8). It points Claude to
  `casefile note add --on …`.
- **Deleted attested items are reported.** The app drops ledger entries *before* it deletes a
  record, so a `chronology`, `evidence`, `issue`, `paragraph`, `authorship` or `user_item` entry
  whose record is missing on open was deleted outside the app (e.g. Claude with SQL). `#pruneLedger`
  appends an `attested_item_deleted` event `{ ts, target: "<kind>:<id>", kind, id, lastAttested }`
  to the vault file `security-events`, and only then prunes the entry; if the event cannot be
  written the entry is kept and the deletion is found again next time. The events appear in
  `CaseSession.securityLog()` / `GET /api/security-log` (re-identified for the user) beside
  possible probes. public.db only gets a log row `attested_items_deleted_outside_app` with a
  count, no content. (`draft` entries are not reported: a deleted draft's paragraphs are.)
- **What the item was.** Each attestation also records a short summary in the vault file
  `attested-summaries` (`"<kind>:<id>" -> { label, text, attestedAt }`: e.g. the event date or
  `issue 3, D002:14-16`, and the first 80 characters of the description, title, note or body,
  tokenised). Summaries are written with the ledger and follow it (an entry's summary goes when
  the entry does), and the event carries the last one so the user can restore the item by hand.
  A summary is only a description; it never makes anything attested. Entries made before this
  change have no summary, and their events say only the kind and id.
- **No cascade from issues to evidence** (public.db schema v3). `evidence.issue_id` no longer has
  `ON DELETE CASCADE`; the v2 → v3 migration rebuilds the table with SQLite's 12-step procedure
  (foreign keys off, one transaction, rows and ids copied; the table has no indexes or triggers).
  With foreign keys on, deleting an issue that still has evidence fails; `PublicStore.deleteIssue`
  deletes the issue's evidence explicitly, and the app's `deleteIssue` (the user's own delete)
  revokes the links' attestations first, as before. A raw-SQL issue delete with foreign keys off
  (sqlite3, Python) leaves the evidence rows in place.
- **Other cascades checked.** `chronology_sources` → `chronology` (an entry's own citations; the
  entry's deletion is reported), `paragraphs` → `drafts` (the CLI cannot delete drafts; a raw-SQL
  draft delete removes paragraphs, whose authorship or adoption deletion is reported), and
  `lines`/`tags` → `documents` (the CLI cannot delete documents; lines are restored by
  `reconcilePublic`). User tags lost to a raw-SQL document delete are not detected: tags are not
  attested. None of these is reachable through the CLI, so they are unchanged.


## Amendment: checking against the source, lapsed checks, removed items (v2 W1-C, 2026-10-07)

The v2 design replaces "verified" with four states for Claude's work (chronology entries,
evidence links, issue descriptions): **To check**, **Checked against source**, **Changed since you
checked**, **Can't check** (`WorkState`).

- **casefile's own checks** (`claimcheck.ts`, pure and deterministic). `checkClaim(claim, cited,
  kinds)` compares a tokenised claim with the tokenised lines it cites, from the vault: each
  entity label (by role) must be in the cited lines; one found only in some citations, but missing
  from a citation that names others of its kind from the claim, is flagged (▲ "Lachlan is not in
  D001:1–2, only in D002:9"); one found nowhere is not found, and if a role of the same kind (the
  same family first: `child_1`/`child_2`) is there instead it "may have been mixed up". Dates are
  compared by value across `14 March 2025`, `14/03/2025` (day first), `2025-03-14` and partial
  forms; numbers with units (durations in minutes, so "1.5 hours" is "90 minutes"), clock times
  and money; feeling words are pointed out; placeholders are flagged. A chronology entry's claim
  is its description preceded by its date (when the date has a month).
- **Can't check blocks checking.** An entity label not in the cited lines or unknown to casefile,
  a citation that cannot be quoted in full from the vault (unpublished, unknown, or any line past
  the end of the document), or a chronology entry or evidence link with no citation, makes the item
  `cant_check`, and verifying it is refused (`CantCheckError`, HTTP 409). The gate is enforced in
  the ledger's `verifyChronology` / `verifyEvidence` / `verifyIssue` themselves (issues: unknown
  labels), so every path is gated, not only the API; the API also checks first against the
  vault's registry to return re-identified rows. What blocks does not depend on entity kinds, so
  the ledger may use the kinds public.db lists.
- **The two-part check.** Verifying a chronology entry or evidence link requires `{version,
  quoteAccurate: true, fairReading: true}`; an issue description `{version, neutral: true}`. Only
  the literal `true` counts. The ticks are logged with the `verified` log row (`flags`); they are
  not part of what is signed.
- **Changed since you checked.** When the app drops a stale attestation (on open in `prune`, or
  when `isAttested` finds the content changed) of kind `chronology`, `evidence`, `issue` or
  `paragraph`, it records a lapsed check in the vault file `lapsed-checks`
  (`"<kind>:<id>" -> {checkedAt, reason: "source_changed" | "edited"}`). The reason comes from
  hashes kept in the attested summary (`own`: the content without cited lines and time; `cited`:
  the cited-line hashes). State: checked if attested, else `cant_check` if the checks block, else
  `changed` if a lapse is recorded, else `to_check`. A new check, and the user's own unverify,
  edit or delete, clear the lapse (the user's own edit gives "To check"). Lapses are not bound to
  content: if Claude deletes a lapsed item with SQL and inserts another with the same id, the new
  one shows "changed" until checked; that only over-warns.
- **Removed items.** `removed_at`/`removed_by` and `done_at`/`done_by` (public.db v4) are
  Claude-writable, so they never decide what the user sees. The user's removal of a chronology
  entry, evidence link or issue is a ledger attestation (kind `removal`, id `"<type>/<n>"`, signed
  over the item's content as for `user_item`); "dealt with" on a note is kind `note_done`. The
  public columns are then set so the CLI hides removed items from Claude. Removal keeps every other
  attestation: a restored item is still checked, unless its content or cited lines changed
  meanwhile, in which case it is "changed". A changed item that was removed is shown again.
  `Ledger.reconcileMarks()` (run before every list) compares the two: public.db removed/done but
  not by the user (`not_by_you`: shown, column cleared), removed/done by the user but cleared in
  public.db (`undone_outside_app`: still removed/done, column set again), or the item changed after
  the user's mark (`changed`: mark dropped, item shown). Each is reported as a security event
  (`removal_mismatch` / `done_mismatch` with `problem`) in the vault's `security-events`, with a
  summary of the item, before anything is repaired; public.db gets only a `marks_repaired` count.
  `prune` keeps these marks while their record exists; app deletes drop them first.

## Amendment: the own-statement flag, edits, and refusal codes (v3 check-api, 2026-10-07)

- **"Only source is your own statement" is decided from the vault.** It used to compare public.db's
  `documents.author_role` (which Claude can write with `docs meta`) with `settings.userRole`. Now
  every cited document must be origin `mine` (vault) **and** recorded as written by
  `settings.userRole` in the vault file `document-authors`
  (`{"<doc id>": {role, at}}`, written only by the app: `checking.setDocAuthor`, read only through
  `checking.docAuthor`). `author_role` is never used for it. This is a minimal store until the
  documents API keeps authorship with the document; `docAuthor` is the one place to switch.
- **The user's edits withdraw their check.** `PATCH /api/issues/:id {title?, description?}` and
  `PATCH /api/evidence/:id {note?, stance?}` behave like a chronology edit: the probe guard
  (ADR 3) runs on changed text, the user's check is withdrawn first (so the item is "To check",
  not "Changed since you checked"), a user-created item is re-recorded as the user's, and removed
  items must be restored first (409). The log records which fields changed, never the text.
- **Each 409 says why** with a `code`: `cant_check` (`cantCheck: true`, with the re-identified
  `checks`) when casefile can't check the item, and `stale` (`stale: true`) when the `version`
  the user was shown no longer matches (`StaleItemError`, previously a 400). Adoption uses the
  same `stale` code.

## Amendment: a lost or damaged log head, and writing it safely (v3 loghead, 2026-10-07)

A seeded case once would not open: `log-head` failed its integrity check. The cause was a second
session still open on the same folder after the case was made again there (`seed --force` while
the app had the old case open). The old session's next log entry (e.g. its idle lock) wrote
`log-head` into the new vault, encrypted with the old case's key. Its public.db writes went to the
deleted file, so only `log-head` showed it. Changes:

- **Vault writes check the folder (ADR 4).** A `Vault` remembers its folder's device and inode
  when opened; every write, delete and keyfile change refuses (`VaultReplacedError`) if the folder
  at that path is no longer the same one. Writes are also flushed to disk (`fsync`) before the
  rename, and the folder after it.
- **Locking waits for the head.** `AppState.lock()` returns once every queued vault write has
  finished and the store is closed (`CaseSession.closeSettled`); `POST /api/lock` answers after
  that, and the desktop window's close and SIGINT/SIGTERM lock and wait before the process exits.
  `CaseSession.create` and `open` return only after their head is written.
- **The head follows commits.** A chained entry is reported as the new head only after its
  transaction commits, so a rolled-back entry never becomes the recorded head.
- **A lost head does not lock the user out.** If `log-head` cannot be read (damaged, or written
  with another key) the case still opens: the file is set aside as `log-head.damaged-<time>` (not
  deleted), an app entry `log_head_lost` is logged, and a new head is written from the chain. If
  it is missing once the log is chained, the same happens without a file to keep. Either way the
  vault settings record `logHeadLost {at, reason, kept}`, and `verifyLog` reports the log as not
  intact (with `headLost`) from then on: entries deleted from the end before then cannot be ruled
  out, so the warning is never cleared by writing a new head. Previously a deleted head was
  reported only until the app's next write.

## Amendment: problems found in the log are recorded and never cleared (v3 loghead2, 2026-10-07)

A security review of the lost-head recovery found that a new head could be written over a log
that no longer led on from the old one. If entries were cut from the end (Claude can edit
public.db), the app's next write sealed new entries onto the shortened log and recorded a new head,
and the check then passed. Changes:

- **Check before sealing.** The store knows the last chained entry: the vault head when the case
  opens, then each entry it seals. Before it seals anything, that entry must still be there with
  the same seal, and every sealed entry after it must chain from it. If not, a `tail_changed`
  problem ("entries after entry N were deleted or altered") is recorded *before* anything is
  sealed. The settings write is queued ahead of the new head.
- **Recorded problems are append-only.** `CaseSettings.logProblems`
  (`{at, kind, headId?, kept?}`; kinds `head_missing`, `head_damaged`, `tail_changed`,
  `settings_missing`) replaces `logHeadLost`, which is still read. The session keeps its own copy,
  and `saveSettings` always writes that copy, so no settings change or replaced settings object
  can drop one. `verifyLog` reports any recorded problem as not intact (`recorded`, `headLost`).
- **Missing settings are not "legacy".** If the vault's settings are missing when a case is
  opened, that is recorded (`settings_missing`), and a missing head is then treated as lost. It
  is never treated as a log from before chaining.
- **Rows are never re-sealed.** Recovery only seals entries that have no seal yet. An altered or
  deleted sealed entry still breaks the chain, and stays reported.
- Found problems are logged (`log_head_lost`, `log_problem_found`). The Court summary says
  "Log checked: casefile found a problem (…)". The Log screen says "casefile can't rule out removed
  entries" when the only problem is a lost head.

Limitation: someone who can delete the whole vault can delete these records too. Deleting only
the settings or only the head is reported.

## Amendment: recorded log problems can be acknowledged (2026-10-09)

ADR 28 lets the user acknowledge each recorded log problem. This does not change the rule above:
problems are still append-only and never cleared, and the log check still reports the log as not
intact. The acknowledgement is a separate append-only vault record (`logProblemAcks`) plus a sealed
`log_problem_acknowledged` log entry; it only shrinks that problem's warning on the Log screen.
