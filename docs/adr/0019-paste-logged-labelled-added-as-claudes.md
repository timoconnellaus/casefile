# 19. Paste: logged, labelled, and added to drafts as Claude's

Date: 2026-10-07
Status: Accepted

## Context

The user reads Claude's answers outside casefile, with names replaced, and pastes them into the
app's Paste screen to see them with real names. That text is Claude's words. PD-AI para 4.11 asks
for a record of AI use, and para 4.9 requires affidavits in the witness's own words, so pasted text
must be visible in the AI-use log and must never slip into a draft as the user's. The pasted text
itself may contain anything Claude wrote, so the log (in public.db, readable by Claude) must not
hold it.

## Decision

- **View** (`POST /api/paste/view {text}`) re-identifies the text, splits it into sentences with
  their inline citations (`claimcheck.splitSentences`) and checks each against the cited lines from
  the vault (`checkClaim`). Each sentence is `checked` (every check passed), `not_checked` (no
  citation, or something to look at) or `cant_check` (a citation to a missing, withheld or too-short
  document, a check that failed badly, or an unknown or malformed token). The log row
  `paste_viewed` records `{chars, paragraphs, sentences, unknown}`: counts only, never content.
- **Copy** (`POST /api/paste/copied {chars?}`) is logged as `paste_copied` (an optional character
  count, nothing else). The UI labels the text "Claude's words — not for an affidavit as written",
  warns against pasting it into any AI, and offers to clear the clipboard.
- **Add to a draft as Claude's** (`POST /api/paste/add-to-draft {draftId, text}`) splits the text
  into paragraphs at blank lines and stores them with `author = 'claude'`, so they are "Drafted by
  Claude — needs you" and, in an affidavit, block export until adopted (ADR 9). Because it is
  Claude's text, the probe guard applies (ADR 3): any known name or number written in plain text
  refuses the whole paste (`ProbeError`, nothing stored, one edit check recorded in the vault), since
  tokenising it would tell Claude which of its guesses were real. Otherwise each paragraph goes
  through `tokeniseUserText` (detection, leak check) before anything is stored. The log row
  `paste_added` records `{draft, paragraphs}`. The response returns the new ids so the UI can undo
  by deleting them.
- The legacy `POST /api/reidentify` stayed until wave 3 (logged as `reidentified_text`, counts
  only); W3-4 removed it. Old `reidentified_text` rows keep their label and count as paste uses.

## Consequences

The AI-use log and the Court (4.11) summary can say how often Claude's text was read, copied and
brought into drafts without the log ever holding it. Pasted text in a draft is always Claude's
until the user adopts it paragraph by paragraph.

## Amendment: paragraphs and the safety warning (v3 check-api, 2026-10-07)

- `POST /api/paste/view` splits the text into paragraphs (blank lines, as "Add to a draft" does)
  and each paragraph into sentences; every sentence carries its `paragraph` index. Check rows are
  re-identified on the server like everywhere else.
- It also returns `safety: [{role, name}]`, the people marked safety-sensitive (ADR 0015) whose
  details the text re-identifies. The screen then warns before Copy and copies only after the
  user confirms; `POST /api/paste/copied {chars?, safetyConfirmed: true}` logs
  `safety_confirmed: true`. `paste_viewed` adds a `safety` count. Counts only, as before.
