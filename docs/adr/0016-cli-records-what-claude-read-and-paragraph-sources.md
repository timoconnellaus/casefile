# 16. The CLI records what Claude read through casefile; draft paragraphs cite their sources

Date: 2026-10-07
Status: Accepted

## Context

Two v2 features depend on knowing what Claude has seen and what its drafting is based on.

- **Exposure** (ADR 7 amendment). A shared document can later turn out to show a real name, for
  example after the user adds a nickname. casefile withdraws it at once, and the user needs to know
  what Claude read of it in the meantime. The AI-use log (ADR 8) already had a row per CLI command,
  but the rows did not say which lines were returned: `docs show` logged the range asked for
  (`"all"`), `search` logged only a count, and lists that show citations logged nothing about
  them.
- **Adopting Claude's paragraphs** (ADR 9 amendment). The user checks a paragraph Claude drafted
  against the lines it is based on before adopting it. Until now a paragraph had no sources.

PD-AI para 4.11 asks the user to be able to say how AI was used. Claude Code can also read files
with shell commands, which casefile cannot see. The sandbox and the case guide steer Claude to
the CLI, but shell reads can still happen.

## Decision

1. **Read commands log what they returned.** The detail of each log row is:
   - `cli:docs_show`: `{doc, lines}`. `lines` is the range actually returned (`"1-7"`, `"3"`), or
     `""` when no lines came back, for example because the document is withheld or the range was
     past its end.
   - `cli:search`: `{query, total, hits: [{doc, line}]}`. Search shows at most 200 hits
     (`MAX_LOGGED_HITS`, whatever `--limit` says) and logs every hit it shows, so `total` is the
     number of hits shown.
   - `cli:chrono_list`, `cli:issue_show`, `cli:draft_show`, `cli:para_list`, `cli:para_show`:
     the command's usual detail plus `cited: [{doc, lines}]`, one entry for each distinct range
     the items shown cite. The text of those lines is not printed. They are recorded anyway,
     because Claude learns what a cited range says from the item that cites it.
   - Line ranges are always strings in the form `"N"` or `"N-M"` (`formatLines`).
   - No log row holds document text, only ids and line numbers.
2. **The public store reads these shapes back.** `PublicStore.logForDoc(doc)` returns the rows
   that name a document through `detail.doc`, `detail.hits[].doc` or `detail.cited[].doc`.
   `PublicStore.claudeReads(doc, {from?, to?})` returns `{id, ts, action, lines}`, one entry for
   each range of the document that Claude read, between two timestamps. Exposure (package B), the
   To-check queue and Court summary (H), and the document activity view use these. They do not
   parse log rows themselves.
3. **This is what Claude read through casefile, and no more.** Every place that shows these reads
   says "through casefile", because reads by shell commands are not recorded. The log is
   hash-chained by the app (ADR 8), so CLI rows cannot be quietly removed after they are
   countersigned. A CLI row the app has not yet countersigned can still be deleted.
4. **Draft paragraphs cite sources.** `para add` and `para edit` take `--source D001:3`
   (repeatable). The values go in `paragraph_sources`. Each one must cite lines Claude can see:
   a withheld document is refused, and the refusal says why. They also take
   `--relies chrono:N|evidence:N` (repeatable). These go in `paragraph_links`, and each target
   must exist and must not have been removed. On edit, either list is replaced; `none` clears it.
   An adopted paragraph cannot be changed, and that includes its sources. Nor can a Claude
   paragraph the user has edited (its text differs from `claude_body`): Claude cannot edit or
   remove it. `para list`, `para show`
   and `draft show` print each paragraph's sources and what it relies on. Claude may not delete a
   chronology entry or evidence link that a draft paragraph relies on (`chrono rm`, `evidence rm`,
   `issue rm`), or edit such an entry (`chrono edit`). The store's hard deletes also remove any links to the deleted item, so none are
   left dangling.
5. **Removed items are hidden from Claude but never open a gate.** Lists and shows leave out
   chronology entries, evidence and issues the user removed, and so do the counts in `info`. Every
   command that changes or deletes something sees removed rows and refuses to act on them. The
   message says "removed by the user". Evidence under a removed issue counts as removed, for
   `evidence rm` and `--relies` alike. `issue rm` is refused if any of the issue's evidence has
   been removed, since the user may want to restore it. `removed_at` is Claude-writable, so it is
   only ever a reason to refuse, never a reason to allow.
6. **Withheld documents say why, in plain English.** `docs show`, `docs list --json`
   (`withheld_because`) and every citation refusal name the reason, using `withheldBecause()`
   from `publicdb.ts`, never the stored value. The reasons are: "it came from the other side",
   "it came from a subpoena or the court", "it is under a court order", "the user is not sure
   where it came from", "the user has not said yet where it came from", and, for an exposed
   document, "it was found to show a name or number that should have been replaced…".

## Consequences

- An exposure record can list Claude's reads of the document by line range: "Claude read lines
  1–12 on 2 Oct 2025 through casefile".
- Logged reads are an upper bound for the CLI, because cited ranges count as read even though
  their text was not printed. They are a lower bound overall, because shell reads are missing.
- The log grows by up to 200 small hit entries per search.
- Mutations log what they changed (for example `cli:chrono_edit` `{id, date?, sources?}`).
- Old rows (`lines: "all"`, `hits: <number>`) still parse. `claudeReads` reports `"all"` as it
  is, and ignores a numeric `hits`.
- The CLI still imports nothing but the public store, tokens and case-folder helpers (ADR 3).
