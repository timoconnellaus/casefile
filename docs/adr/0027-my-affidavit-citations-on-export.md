# 27. "My affidavit sworn [date], para 4" citations on export

Date: 2026-10-09
Status: Accepted

## Context

Claude cites document lines (`D002:9`, ADR 5, ADR 10). On export, inside the app, ADR 21 turns a
citation into "annexure AT-1" for a document the user marked, and otherwise into "Title, line N".
A self-represented party often refers back to an affidavit they filed earlier, and the Court
expects that as "my affidavit sworn 2 April 2025, para 4", not "Affidavit of Anna Thornbury,
line 9". REBUILD-PLAN (wave 3) planned this wording next to annexure marks; ADR 21 and PLAN's
deferred list recorded it as not built, with "Title, line N" in its place. PLAN gives the wording
only, not how casefile should know which documents are the user's affidavits, when they were
sworn, or which paragraph a line is in. This ADR decides those.

Three facts are needed, and none may come from public.db, which Claude can write (ADR 3, ADR 8):

- that the document is an affidavit the speaker swore or affirmed, and on what date;
- that it is the speaker's ("my" must be true);
- which numbered paragraph the cited lines are in.

## Decision

**The user records it, in the vault.** On a document's page (origin "mine" only), "Is this an
affidavit you swore or affirmed?" (No / Yes, sworn / Yes, affirmed) and "On" (a date) are saved
with `PUT /api/docs/:id/affidavit {oath, date}` (or `{affidavit: null}` to clear) into the vault
file `earlier-affidavits`: `{ "<doc id>": {oath, date, docImportedAt, at} }`. The date must be a
real calendar date, not in the future. `docImportedAt` binds the record to that document, so a
different document never inherits it. `GET /api/docs/:id` returns `affidavit: {oath, date}` or
null. The log records `earlier_affidavit_set {doc, set}`, without the date. Nothing is written to
public.db, and the CLI cannot read the record (it lives with the other vault-only records the CLI
has no path to, ADR 3).

**Whose it is.** A citation says "my affidavit" only when the document's origin is `mine` and the
user's own vault record of who wrote it (`docAuthor`, the "Who wrote it" answer that "only source
is your own statement" also uses) is the **speaker** of the export: the affidavit heading's
deponent for an affidavit draft, otherwise the role the user set as themselves (`userRole`). The
chronology's speaker is the user. Without a speaker, or for anyone else's affidavit, the citation
keeps the title form. public.db's `doc_type` and `author_role` play no part.

**Which paragraph.** The paragraph number is read from the document's **original text in the
vault**, not from public.db's lines: a cited line belongs to the nearest line at or above it that
starts a numbered paragraph (`4. `, `4) `, `(4) `, up to three digits), unless a blank line comes
first. So a paragraph wrapped over several lines (as PDF import gives) counts as one, and lines
of the heading, blank lines and lines after a gap (the jurat, an annexure note) are in no
paragraph. A range gives "paras 4–5" (or "paras 4, 6" when not consecutive). If any cited line is
in no paragraph, the citation keeps the title form rather than guess.

**Wording and order.** `my affidavit sworn 2 April 2025, para 4` (or `affirmed`), lower case, as
PLAN shows it, inside whatever the paragraph already says around the citation. An annexure mark
the user gave the document in that draft wins (it is the user's explicit choice for that draft);
then the earlier affidavit; then "Title, line N". The same conversion runs for every draft
format (Markdown, text, RTF, .docx) and for the chronology's "What happened" and "Source"
columns. Re-identification and conversion happen only at export time in the app (ADR 5, ADR 21);
the export's safety check (ADR 21) runs on the converted text as before.

## Consequences

- One more vault-only record. It follows a document only by id and import time; deleting the
  document leaves an orphan entry that is never used (ids are never reused, and the import time
  check covers that anyway).
- The user answers two questions per earlier affidavit (who wrote it, when it was sworn). Until
  both are answered, exports keep the title form, which is what they did before.
- Paragraph numbering is a reading of the text. An affidavit whose paragraphs are not numbered at
  the start of a line, or that numbers sub-paragraphs the same way, may be cited by the wrong
  number or by title; the user checks exports against the filed affidavit, as the export markers
  already tell them to.
- "Affidavit of [someone else] sworn [date], para 4" for the other side's affidavits is not
  built: those documents are withheld from Claude on a consumer plan (ADR 7) and are rarely cited
  in the user's own words.
