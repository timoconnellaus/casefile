# casefile — domain glossary

Words used in the code, the API, the UI and the ADRs. UI labels are in quotes. Where a term has a
state, the code value is in `code`; the UI words come from `src/app/ui/model.js`.

## The case and its stores

- **Case**: one matter's folder: `case.json` (marker), `public.db`, `vault/`, plus the generated
  Claude guidance (`CLAUDE.md`, `.claude/settings.json`).
- **Case lock**: `.casefile-lock` in the case folder, held by whatever has the case open with its
  vault (the app, or `seed --force`): pid, start time, host. A second opener is refused ("This case
  is open in casefile (pid N)…"); a lock whose process has ended is taken over. The CLI never takes
  it (ADR 4).
- **Vault**: `vault/`, one AES-GCM encrypted file per document plus files for who's who, settings,
  the attestation ledger, exposures and other app-only records. Only the app opens it, with the
  passphrase or the recovery key (ADR 4).
- **Public store**: `public.db`, SQLite holding everything Claude may see, with names replaced.
  Claude reads and writes it through the CLI and can write it by other means, so nothing in it is
  trusted to say what the user did (ADR 3, ADR 8).
- **Recovery key**: an optional second way to open the vault: 160 random bits shown once as 32
  Crockford base32 characters in 8 groups of 4. It wraps the same data key as the passphrase
  (keyfile v2). Using it requires choosing a new passphrase; wrong keys count towards the same
  lockout as wrong passphrases; making, replacing or removing one needs the passphrase. Settings
  record only that one exists (ADR 4, ADR 13).
- **PD-AI**: FCFCOA _Practice Direction: Use of Artificial Intelligence_, issued 29 May 2026.

## Names and tokens

- **Original**: a document's text exactly as imported. Lives only in the vault.
- **Entity**: a person, place, organisation, school, address, phone, email, identifier or date of
  birth that identifies someone. Kept in the vault's registry ("who's who").
- **Role**: an entity's token name, e.g. `mother`, `child_1`, `school_1`, `medicare_1`. Describes a
  relationship, never a person, and may not contain any word of any real value.
- **Form**: which version of a name a token shows: full, `first`, `surname`, `title` ("Ms
  Thornbury").
- **Token**: `{{role}}` or `{{role.form}}` in tokenised text.
- **Registry**: the token key: role → real values (forms and aliases). Vault only.
- **Alias** (UI: "nickname"): another way a person is written ("Annie"). Adding one re-checks every
  shared document (see Exposure).
- **Relationship description**: what the user says about a role ("the children's maternal
  grandmother"). Stored tokenised and published to `entities.description`, which the CLI prints;
  refused if it contains any value, even one casefile could replace (ADR 15).
- **Colour slot**: one of six palette positions (0–5) an entity can hold in the UI. `mother`,
  `father`, `child_1` and `child_2` get slots 0–3 by default if free; a slot has at most one owner
  (a taken slot is refused with 409); everyone else shows in neutral ink. Vault only, not signed or
  logged (ADR 15).
- **Safety-sensitive**: an entity whose `safety` flag is set, or a detail (address, phone, …) linked
  with `relatedTo` to a person whose flag is set. Its values can never be "left as written" at
  publish, and an earlier "leave as written" of them stops counting (which can withdraw a shared
  document as an exposure); the app hides it on screen until shown; Paste warns before copying text
  that names them. Export warns before including an address that is itself marked, whose role starts
  with a marked person's role (`mother_address`), or that is the affidavit heading's address of a
  marked deponent; it does not yet follow `relatedTo` (ADR 21). The flag and the link are vault only
  (ADR 6, ADR 15).
- **Span**: a stretch of original text a detector thinks is identifying.
- **Proposal**: what a span should become: an existing entity, a new one, or _ambiguous_ (which
  blocks publishing until the user chooses).
- **Leave as written**: the user's decision to keep a detected value in the text Claude sees. It
  needs a reason, kept in the vault document (ADR 6).
- **Re-identify**: swap tokens back to real values, in the app only.

## Documents

- **Origin**: where a document came from, as the user answered "Where did you get this document?":
  `mine`, `other_side`, `court_or_subpoena`, `under_order` or `not_sure`. Kept in the vault
  document; it replaced _sensitivity_ in public.db schema v4. `originHints` may suggest one from a
  stamp in the first 15 lines; it is only a suggestion (ADR 7).
- **Not asked yet**: origin `null`, the default for every new import. Always withheld
  (`withheld_reason = 'not_asked'`) until the user answers.
- **Claude setup / plan**: `consumer` (Pro/Max, the default) or `commercial`. Commercial needs the
  user to confirm the three PD-AI 5.5 conditions (closed environment, no training, this case only);
  without them the case counts as consumer. Switching plan never shares anything by itself: on
  commercial, `other_side` and `court_or_subpoena` documents are shared one at a time (ADR 7).
- **Batch**: the documents of one import (`B1`, `B2`…), reviewed one after another in a queue
  (`GET /api/docs?batch=B1`, `#/review/<id>?queue=B1`). Cases made before batches have none.
- **Publish**: tokenise a reviewed document and write it to `public.db`, after the leak check
  passes. A published document is then shared or withheld according to its origin and the plan.
- **Leak check**: a scan of tokenised body and title for any known value (any form, alias or
  identifying part) or identifier-like string; any hit blocks publishing. It runs again whenever the
  app decides what public.db holds (`publishedView`).
- **Document states** (`DocState`, one per document, decided from the vault):
  - **Needs review** (`needs_review`): not yet published, or published and shareable by origin but
    now showing a known value.
  - **Shared** ("Shared with Claude", `shared`): its text, with names replaced, is in public.db.
  - **Withheld** ("Withheld from Claude", `withheld`): published without its text (no body, no
    lines, a generic title, no details or tags) because of its origin and the plan
    (`withheld_reason` `origin` or `not_asked`). The CLI says why in plain English.
  - **Exposed** ("Exposed — re-check", `exposed`): a shared document later found to show a known
    value (e.g. after a nickname was added); withdrawn at once (`withheld_reason = 'exposed'`) until
    the user re-checks it.
- **Exposure**: the vault record of one exposed document: the roles involved, which values triggered
  it, when it was shared, found, withdrawn and re-shared, Claude's reads of it through casefile in
  that window, and pending documents where the value was newly found. The AI-use log gets only
  `document_withdrawn {doc, reason: "exposed"}` (ADR 7).
- **Re-check**: re-tokenise an exposed document with its earlier decisions plus every value now
  known; it is shared again if nothing needs the user. Its cited lines change, so checked work
  citing it becomes "Changed since you checked".
- **Undo share / Review again**: `withdraw` and `reopen` take a shared document out of public.db and
  back to review, keeping the user's earlier decisions.

## Claude's work and the user's checks

- **AI-use log**: `ai_log` in public.db: imports, publishing, CLI reads and writes, checks,
  adoptions, pastes, exports. Hash-chained by the app; CLI rows are countersigned when the app next
  writes. Holds ids, line numbers and counts, never document text (ADR 8, ADR 16).
- **Through casefile**: what the log can show Claude read: CLI output only. Reads by shell commands
  are not recorded, so every screen that lists Claude's reads says "through casefile".
- **Attestation ledger**: the vault file of the user's current signed checks, adoptions, authorship,
  draft kinds, removals and own items. The only source for whether something is checked, adopted or
  the user's (ADR 8).
- **casefile's checks** (`CheckRow`): deterministic comparisons of a claim with the lines it cites:
  every person in the claim is in the cited lines, dates and numbers match, feeling words and
  placeholders are pointed out (`claimcheck.ts`). They only flag; they never mark anything checked.
- **Extra checks** (Settings → "Extra checks"): typed judgements about Claude's work and shared
  documents, asked on request ("Ask casefile's extra check"): does a sentence give feelings or
  opinions, is a note a fair reading of its cited lines, may a shared document have come from
  somewhere stricter than the user said. They run "On this computer" (the default), on "The language
  model on this computer" set up under Finding names, or on Jev, or are off. They only flag
  (`JudgeFlag`, "casefile's extra check thinks…"); they never mark anything checked, adopted or
  shared, and are logged as counts only (ADR 14).
- **Judge**: the interface behind extra checks (`src/core/judge/`): named questions (`noul`,
  `choice`, `score`) about a `JudgeState`, answered with probabilities. A `JudgeState` is built only
  from what Claude may see (shared documents' text with names replaced, Claude's notes and drafts),
  leak-checked. Questions, thresholds per backend and their calibration live in `questions.ts`.
- **Jev**: TypeSafe AI's hosted decision model, one judge backend. Off by default; turned on in
  Settings with a key (vault only, never shown or logged) and the typed phrase "send to Jev"; listed
  by the Court summary as a second AI tool (ADR 14).
- **Work states** (`WorkState`, for chronology entries, evidence links and issue descriptions):
  - **To check** (`to_check`): not checked by the user.
  - **Checked against source** (`checked`): the user compared it with the cited lines and ticked
    both "the quote is accurate" and "it is a fair reading" (issue descriptions: "describes the
    question fairly"), and the ledger holds a current signature over its content and cited lines. It
    says the user compared, not that Claude is right.
  - **Changed since you checked** (`changed`): a check lapsed because the item or its cited lines
    changed (recorded in the vault's `lapsed-checks`). The user's own edit gives "To check" instead.
  - **Can't check** (`cant_check`): casefile cannot check it: a person in the claim is not in the
    cited lines (or may have been mixed up with another), a label is unknown, a citation cannot be
    quoted in full from the vault, or there is no citation. Checking is refused (409 `cant_check`)
    on every path.
- **Only source is your own statement**: a flag on a chronology entry or evidence link whose every
  cited document has origin `mine` and is recorded in the vault (`document-authors`) as written by
  the role the user set as themselves in Settings (`userRole`). Both are the user's own answers;
  public.db's `author_role` is never used.
- **Removed item**: a chronology entry, evidence link or issue the user removed. Recorded in the
  ledger (`removal`), hidden from Claude's lists, shown under "Removed items" and restorable (a
  restored item keeps its check unless it changed meanwhile). public.db's `removed_at` never hides
  anything or opens a CLI gate by itself (ADR 8, ADR 16).
- **To check** (the queue): one list, built only from signed records and the vault: exposed
  documents, documents to review, Claude's unchecked chronology entries and evidence, Claude's
  paragraphs that need the user, and Claude's unchecked issue descriptions. Danger first, then
  changed, then oldest (ADR 18).

## Drafts

- **Paragraph states** (`ParaState`). "Drafted by Claude" is permanent history; there is no
  similarity measure (ADR 9).
  - **Your words** (`user`): a paragraph the user wrote in the app (authorship attested).
  - **Drafted by Claude — needs you** (`claude_needs_you`): Claude's text, not adopted.
  - **Drafted by Claude — rewritten by you, adopt to confirm** (`claude_rewritten`): the user edited
    Claude's paragraph (any amount); it still needs adopting. A later change by Claude returns it to
    "needs you".
  - **Drafted by Claude — adopted** (`claude_adopted`): the user adopted it ("true, from my own
    knowledge, how I would say it"), one paragraph at a time, signed and logged.
- **Placeholder**: `[In your own words: …]`, left by Claude where only the user can speak. Blocks
  adoption, and affidavit export, until replaced.
- **Fact by fact**: a paragraph split into sentences, each checked against its own citations or else
  the paragraph's sources; at adoption the user answers "Did you see this yourself or read it?" for
  each (answers in the vault, counts in the log).
- **Sources / relies on**: a paragraph's cited document lines, and the chronology entries or
  evidence links it relies on. Not part of the adoption signature.
- **Affidavit heading**: file number, deponent, applicant and respondent (as roles), occupation,
  address, sworn or affirmed. Vault only.
- **Annexure mark**: a label such as `AT-1` the user gives a cited document in one draft (up to 20
  characters: letters or digits, with spaces, dots or hyphens between; unique in the draft). Vault
  only, because marks start with initials. On export a citation of a marked document becomes
  "annexure AT-1" (ADR 21).
- **Export**: a download (Markdown, text, or RTF for Word), never written into the case folder. An
  affidavit exports only when every Claude paragraph is adopted and no placeholder remains; other
  kinds export after the user confirms the flags.
- **Provenance report**: Markdown for one draft, built from records Claude cannot forge: each
  paragraph's state and signed adoption time, the draft kind from the ledger, fact answers, the
  plan, and log rows whose seal verifies. It says what it cannot show (e.g. paragraph sources, which
  are not signed) (ADR 21).
- **Paste**: the screen where the user pastes Claude's answer to read it with real names. Views and
  copies are logged as counts only; "Add to a draft" stores the text as Claude's paragraphs (ADR
  19).

## The Court

- **Court summary** ("If the Court asks"): the answer to PD-AI para 4.11: whether AI was used, which
  tools, how Claude's work was checked, how the rules were followed, what is still open, the state
  of the record, and what the summary cannot show. Built only from the ledger, the vault and sealed
  log rows; the wording is fixed in core and never says "verified" or "proves". Copying it is logged
  (ADR 18).
- **PD-AI 5.4 confirmations**: the user's dated statements that "Help improve Claude" is off and
  chat history is set as they want for this case. Kept in the vault and logged; casefile cannot
  check them (ADR 17).
