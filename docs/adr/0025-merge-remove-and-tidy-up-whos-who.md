# 25. Merging and removing who's who entries, and "Tidy up who's who"

Date: 2026-10-09
Status: Accepted

## Context

Importing a PDF (ADR 23) showed three problems with who's who:

- **Duplicates.** A new entity is keyed on its kind and exact text, so one person written two ways
  ("OKAFOR, Daniel" in a court form's field and "Daniel Okafor" in its text) became two entries,
  `father` and `person_1`. Claude then reads two people.
- **Labels that say nothing.** NER gives no role hint, and an LLM hint that would reveal a value is
  dropped, so entries fall back to `person_3`, `org_2`, `other_1`. Claude needs to know who an
  entry is to the case to reason about it.
- **Things that identify no one.** The language model flagged a time ("5:01 PM") as `other`, which
  then read as `{{other_2}}` to Claude.

Who's who could only rename an entry (ADR 15). There was no merge (deferred: "a large token rewrite
across documents, notes and drafts") and no way to take an entry out: "Review again" plus "Leave as
written" removed it from one document but left the entry in who's who, and in what Claude sees.

## Decision

**Merge** (`CaseSession.mergeEntity(from, into)`, `POST /api/entities/:role/merge`). `from`'s
values become `into`'s: a value equal to one of `into`'s forms or other names (compared folded,
ignoring stray punctuation at either end) maps to that form; a first name, surname or title `into`
lacks fills it; anything else becomes another name of `into` (and so renders as its full form, as
nicknames already do). Links, the safety flag (either side's), the colour and the description carry
over if `into` has none. Only like with like: a person with a person, an address, phone, email,
identifier or date of birth with the same kind; places, organisations, schools and "other" with
each other. Every token of `from` becomes `into`'s, with the mapped form, everywhere
rename already reaches: vault documents (replacements, pending proposals, held details, new
matches), public.db (documents, lines, chronology, issues, evidence, notes, drafts, paragraphs),
other entries' descriptions, document authors, affidavit headings, the user's own role and
exposure records. Published documents are re-tokenised from their replacements and republished
through `publishedView` (the leak check). Checked items whose text changes lapse to "Changed since
you checked", as after a rename. The log gets `entity_merged {from, into}`.

**Remove** (`CaseSession.removeEntity(role, reason)`, `POST /api/entities/:role/remove`, UI "Stop
replacing"). For an entry that identifies no one. A reason is required, as for every value left as
written (ADR 6). Each document that replaced it now leaves those values as written: they are added
to the document's `ignore` with the reason, the replacements and proposals naming it are dropped,
and published documents are re-tokenised and republished. Tokens of it in Claude's work and in
descriptions become its value as written. Refused for a safety-sensitive entry (never left as
written, ADR 15); for an entry any of whose values contains another entry's value or part, even
inside a longer value ("Daniel" or "Daniel Okafor Jr" would uncover the father), because the
values are written into Claude's notes, which no leak check reads; and for a value a rule always
replaces (a phone number, an identifier). The user merges or keeps it instead. The log gets
`entity_removed {role}` only: no value, no reason.

**Tidy up who's who** (`POST /api/people/tidy`, `suggestTidy` in `people.ts`,
`src/core/detect/tidy.ts`). Suggestions only; nothing changes until the user accepts one, and an
accepted one goes through the same path and checks as doing it by hand (`mergeEntity`,
`changeEntity` for a rename, `removeEntity` with the suggestion's reason).

- *Rules*, always: an entry whose every value is only a time, ordinary date, amount or length of
  time → remove. `harmlessShape` needs a digit and exact month and unit words (so "Marcus",
  "June" or "12" never qualify) and applies only to `other`, `place` and `organisation`; two
  people whose names are the same words in another order or case, or one inside the other (a
  middle name) → merge, keeping the entry whose label is not `kind_N`.
- *The language model* set up under Finding names, when there is one. It is sent each entry's
  label, kind, real values, description (with names) and up to three original lines (240
  characters each) where it appears, in batches of 60, and asked for merges, relationship labels
  and removals. This is original text, so it follows ADR 12 exactly: `classifyEndpoint` before
  every request, refused for a remote or unconfirmed endpoint unless the user allowed it, no
  redirects, no echo of the reply in errors. If it is refused or fails, the rules' suggestions are
  still returned and the reason is shown.
- *Checks on what the model says*: roles must exist; a merge must join two entries of the same
  kind; a new label goes through `sanitiseRole` against every known value, must be valid, unused,
  not revealing (`revealingWords`) and without long numbers; the model may never suggest removing
  a person, address, phone, email, identifier or date of birth.
  Contradictions are settled (an entry merged away is not also renamed or removed; a removal beats
  a rename; one label per suggestion).
- Suggestions and their reasons are shown in the app only and never written to public.db. The log
  gets `entity_suggestions {suggestions, llm}`: a count and whether the model ran.

**At detection**, model spans (NER, LLM) whose text has a harmless shape are dropped, as generic
institutions already are, so new imports stop making entries like `other_2` for "5:01 PM". Rules
spans are unaffected. `splitPersonName` reads "SURNAME, Given names" the right way round.

## Consequences

- Duplicates and unclear labels from earlier imports can be fixed where they are, without
  re-reviewing documents, and Claude's own notes follow.
- A merged spelling re-identifies as `into`'s full form, not as written ("OKAFOR, Daniel" reads
  back as "Daniel Okafor"), as nicknames already do (ADR 5). The vault keeps the original text.
- Removing an entry puts its value into text Claude reads, including Claude's earlier notes. That
  is the same decision as "Leave as written", made once for the whole case, with a reason, and it
  cannot apply to a safety-sensitive entry or a value someone else shares.
- There is no undo for merge or remove; renaming has one. An entry merged by mistake can't be split
  automatically: the user reviews the affected documents again ("Review again") and chooses who
  each name is. The confirmation says what will change before anything does.
- Merging entities still waiting for review is not offered on the review screen; documents are
  published first and tidied in who's who. New entities proposed in a document under review are
  not in who's who yet, so "Tidy up" does not see them until it is published.
- The language model sees real names and a few lines of each document, as the LLM name pass
  already does; a user who uses NER only gets the rules' suggestions.

## Amendment: suggestions while a document is reviewed, with the whole document (2026-10-09)

The point of using the local model was that it can read the real names and the whole document
before anything reaches Claude. "Tidy up" in People runs only after sharing, with three lines per
entry. So the review screen gets **Suggested fixes** (`POST /api/docs/:id/tidy`,
`suggestForReview` in `people.ts`, `reviewSuggestions` in `detect/tidy.ts`):

- For each new finding in the document: **same** (it is an entry already in who's who, or another
  new finding, written differently), **label** (what Claude should call it), or **leave** (it
  identifies no one). Rules always run (a name written in another order or with a middle name,
  the same text found as two kinds, a harmless shape); the language model under Finding names,
  when set up, reads the **whole original document** in 6,000-character chunks with who's who
  (labels, kinds, real values, descriptions) and the findings. ADR 12's rules apply unchanged:
  classified before every request, refused for a remote or unconfirmed endpoint unless allowed.
- Checks: items and targets must exist; "same" only between compatible kinds (person with
  person; places, organisations, schools and "other" together; a number with the same kind);
  labels through `sanitiseRole` and `revealingWords` (including the findings' own values), valid
  and free; "leave" never for a person, address, phone, email, identifier or date of birth, nor
  for a value that contains a known value or that a rule always replaces. Chains are followed
  ("Dan" → "Daniel Okafor" → `father`), cycles dropped, one suggestion per finding.
- **Matching a role instead of a name.** Tried on a synthetic case, the model said a new
  respondent with a different name was the existing `father` (and then the father's partner),
  because both are "the respondent". So a model "same" from a new person to someone already in
  who's who is **dropped** unless their names share a word or one starts the other ("Dan",
  "Daniel"); the user can still choose that person by hand. Between two new findings it is kept
  but marked `caution` ("The names differ…"), and **Use all** never applies a doubtful one; any
  doubtful link makes a whole chain doubtful.
- Nothing is saved by asking. "Use" pre-fills the review screen's own decisions, which the user
  can still change, and the document is shared through the normal publish and leak check.
- **Remembering a spelling.** A publish request may carry `aliases: [{ref, value}]`. The review
  screen sends one for each finding a "same" suggestion was used for; publish adds the value as
  another name of that entry if this request replaces that very text with it and no entry already
  has it as a value. So the next document that writes "OKAFOR, Daniel" finds the father at once.
- The review screen also lets the user edit a new entry's label before sharing ("What Claude calls
  this new entry"), checked again by publish (a revealing label still falls back to `kind_N`).
- The log gets `review_suggestions {doc, suggestions, llm}`: counts only.
