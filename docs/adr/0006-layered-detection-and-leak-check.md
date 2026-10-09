# 6. Layered detection and the leak check

Date: 2026-10-07
Status: Accepted

## Context

No single detector catches everything. Missing one name is the failure that matters.

## Decision

Detection runs in layers and the results are merged:

1. **Rules** for Australian identifiers, checksum-validated where possible (Medicare, TFN, ABN,
   ACN), plus phones, emails, addresses, suburb/state/postcode, dates of birth (DOBs only; other
   dates are kept, as the user chose), court file numbers, BSB/account, licence/passport and
   social-media profile URLs.
2. **Known entities**: every form and alias of every entity already in the case, anywhere.
3. **NER** (transformers.js, offline) and an **LLM pass** (OpenAI-compatible endpoint, ADR 12),
   both optional and pluggable.
4. **Propagation**: any value a model found once is searched for everywhere in the document, and
   for new people their first name, surname and "Title Surname" are searched too.

**Matching** (security review, 2026-10-07). Known values and rules are matched on a *folded*
copy of the text (`src/core/fold.ts`): NFKC per character (full-width letters and digits,
ligatures, decomposed accents), every apostrophe-like character (U+2019, U+02BC, …) as `'`, runs
of horizontal whitespace as one space, and case (for known values). Every folded character
remembers its original range, so spans map back to exact offsets. A known value also matches
in the plural and possessive plural ("the Okafors", "Okafors'"). The leak check, tokenising
user text and the probe guard (ADR 3) all use this one matcher. Invisible format characters
(zero-width space, soft hyphen) are skipped and dash-like characters fold to `-`, so
"An\u200Bna" and "Anne‑Marie" match; homoglyphs from other scripts are not folded. A span
that is a known value in a folded form publishes as that entity's token, so re-identification
gives the canonical form ("Ｒｅｂｅｃｃａ" comes back as "Anna"): equal after folding, not byte
for byte (tests/detection_test.ts round-trips every variant through detect, publish, the leak
check and re-identification).

Stoplists never hide people: model detections are dropped as generic institutions ("Court",
"Police") only when they are not persons, and generic words are exempt from the role-name rule
only for places and organisations, so a person surnamed Court or West still can't be `court_dad`.

**More identifying forms** (same review), all checked by the leak check and flagged by detection:

- A date directly after a person's name or person token — "Mia (3/3/2017)", "{{child_1}},
  3 March 2017," — is flagged as a possible date of birth (`date_after_name`).
- Social-media handles (`@miaokafor09`) are identifiers, whether or not they contain a known name.
- **Leak-only parts** (`EntityRegistry.variants({ leak: true })`): a person's middle names when
  the full form has three or more words; an address's street ("Banksia Crescent") and suburb
  ("Gerringong"); an organisation's or school's distinctive words, i.e. runs of words that are not
  generic ("Kiama Downs" of "Kiama Downs Public School", "Little Gumnuts" of "Little Gumnuts
  Childcare"). They block publishing and are proposed for review, but are never used to
  tokenise, because the token renders the full form and "Jessica" would re-identify as "Anna
  Jessica Thornbury".
- Role names (ADR 3 rule 7) may not contain any value word of two letters or more ("aunty_jo" for
  "Jo Pemberton"); a list of generic words (Mr, St, Public, School, Pty, …) is exempt.

Nicknames and other forms that share no word with the full name ("Anni" for Anna) are not
derivable; they are caught only once the user adds them as **aliases** of the entity (or by the
optional NER/LLM detectors).

Overlaps resolve by source strength (manual > rule > known > LLM > NER), then length. A value that
could be several entities (a surname shared by a parent and child) is **ambiguous** and blocks
publishing until the user chooses.

Before anything is published, the **leak check** scans the tokenised body *and title* for any
known value and anything the rules recognise. Any hit blocks publishing. Failed detectors are
reported to the user, never silently skipped: on import and re-detection the review screen lists
them, and the checks that run without a review step fail closed (security review, 2026-10-07).
If any detector errors while checking a document title at publish, publishing is refused
(`LeakError` naming the detector); if any errors while checking text the user typed
(`tokeniseUserText`), the text is refused (`InvalidInputError` naming the detector) and not stored.

Name detection is optional. `CaseSession.nameDetection` is true only when a detector that looks for
names (NER or LLM, `Detector.findsNames`) is configured; the API reports it (`nameDetection` in
settings, status and the review data) so the app can warn "Only identifiers are checked
automatically — names are not" when it is off.

## Consequences

Publishing is conservative: it can refuse until the user resolves or explicitly ignores a value.
`auditPublished()` re-runs the leak check on published documents when new entities or aliases
are added later.

## Amendment (v2 rebuild, W1-B, 2026-10-07): leaving values as written, safety, and re-checking

- **"Leave as written" needs a reason.** Every value newly added to a document's `ignore` list at
  publish must come with a reason (`PublishRequest.ignoreReasons`); the reasons are kept in the
  vault document (`ignoreReasons`) and shown on review as "Left as written". Until the wave-2
  review screen ships, the legacy screen's ignores are recorded with the reason
  "(no reason asked: earlier review screen)" rather than an invented one; wave 3 removes that.
- **Safety-sensitive people are never left as written.** Publishing refuses (`SafetyError`, HTTP
  409) a request that asks to leave any value of an entity marked `safety` (any form, alias or
  leak-only part) as written. An earlier "leave as written" of such a value — made before the
  person was marked, or before the value was known to be theirs — is no longer honoured anywhere:
  the leak check, the exposure check, detection on review and re-detection all use
  `CaseSession.honouredIgnore`, never the raw list. So marking someone safety-sensitive withdraws
  any shared document that shows their value (an exposure, ADR 7), and reviewing it again proposes
  the value for replacement.
- **The leak check is re-run before any text is shared, not only at publish.** `publishedView`
  (the single function that decides what public.db holds, used by publish, republish, origin and
  plan changes and the repair on open) withholds a document whose stored text shows a value
  learnt since it was tokenised (`withheld_reason = 'exposed'`). This is a backstop; the active
  path is the exposure check (ADR 7).
- **Identifier role hints.** Rules suggest `medicare_1`, `tfn_1`, `abn_1` and `file_number` for new
  identifiers (the next free number when taken), instead of `id_N`.
- **Origin hints.** `originHints` suggests an origin from a stamp in a document's first 15 lines
  ("produced under subpoena", "subpoena", "suppression/non-publication order", "discovery",
  "disclosure"). It is only a suggestion; the user answers "Where did you get this document?".
