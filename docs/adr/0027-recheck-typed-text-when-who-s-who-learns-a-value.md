# 27. Re-checking text already in public.db when who's who learns a value

Date: 2026-10-09
Status: Accepted

## Context

Text the user types in the app (notes, chronology entries, issues, evidence notes, draft
paragraphs and titles, tags, document details) is tokenised when it is saved, against the values
who's who holds at that moment (`tokeniseUserText`). A nickname added later ("Annie"), or a person
first added to who's who after the note was written, can already be sitting as written in that
text, where Claude reads it. Shared documents were already re-checked on every change to who's
who and withdrawn as exposures (ADR 7); this other text was not (`docs/PLAN.md`, "Text not
re-checked"). The user decided it should be re-checked too, as an exposure event.

The danger in fixing it is the probe (ADR 3): Claude can write guesses at names into its own text.
If casefile then turned a guess into a token when the user added that value, Claude would learn
which guess was right. So casefile must never rewrite text Claude wrote, and must not trust
public.db's `created_by` to say who wrote what, since Claude can write it.

## Decision

Every save of who's who (`CaseSession.saveRegistry`, after the shared documents' exposure check)
runs `recheckTypedText` (`src/core/typedtext.ts`). It scans every text field in public.db other
than a document's body and title with the known-values matcher the leak check uses (including
leak-only parts such as a middle name), removed items included:

1. **The user's own text is re-tokenised.** An item counts as the user's only if the ledger says so:
   a `user_item` record matching its content (notes, chronology entries, issues, evidence links),
   or, for a paragraph, `authorship` of its current text with no Claude text in it
   (`claude_body` null). The value becomes its token (`tokeniseKnown`), the ledger records the new
   content as still the user's, and the user's marks carry over (`Ledger.carryMarks`: a removed
   item stays removed, a note stays dealt with; the mark's date becomes the rewrite's). Checks on
   the item lapse to "Changed since you checked", as for any change the user did not make.
2. **Everything else is left as written and listed**: Claude's work (`why: "claude"`), and text
   whose author casefile cannot confirm because only public.db records it, namely draft titles,
   tags and document details (`why: "unconfirmed"`), and a paragraph the user rewrote from
   Claude's. Text where the value cannot be replaced cleanly (an ambiguous match, a leak-only part)
   is left too (`why: "unclear"`).
3. **Records.** Each re-check that changes something or leaves a different set of items is kept in
   the vault file `typed-text-rechecks` (items by kind and id, roles, and the values found, which
   are real: vault only, never logged or published). The AI-use log gets
   `typed_text_rechecked {count}`, the number of the user's items changed, and nothing about the
   items left: how many of Claude's items name someone would confirm Claude's guesses.
4. **The user is told.** `PATCH /api/entities/:role` returns `typedText` (`replaced` and `left`,
   labels such as "note 12" only), and People shows it after the change: what was replaced, and
   what is still written as is, which the user can edit or remove.

Shared documents are unchanged: the exposure check still withdraws them and they go back for
re-checking (ADR 7). Only the known-values layer runs on this text; the name finder and the
language model are not run again over it (they ran when it was saved).

## Consequences

- A nickname or a person added later no longer stays visible in the user's own notes and drafts.
- Claude can see that the user's text changed (a value became a token). That tells Claude the
  value is the person's, which the user's own text already said; the same happens when an exposed
  document is re-checked and shared again.
- Claude's own text that names someone stays as written. Claude wrote it, so it reveals nothing
  new, but the user should know, so it is listed. Text casefile cannot attribute is listed rather
  than rewritten, at the cost of the user editing it by hand.
- No public.db schema change. One new vault file and one new log action.
