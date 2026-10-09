# Product brief: casefile

## Who it is for

One person: a **self-represented party** (no lawyer) in an Australian family-law parenting matter in the
Federal Circuit and Family Court of Australia (FCFCOA). They have a large pile of documents (affidavits,
text messages, emails, letters, school records, some subpoenaed or produced on discovery) and want to
use Claude (an AI assistant) to help organise them and prepare court documents.

## The problem it solves

The Court's *Practice Direction: Use of Artificial Intelligence* (PD-AI, full text in `PD-AI.txt`)
allows AI use but requires, among other things: confidentiality and safety of sensitive information
(especially children's and protected details), not entering discovery/subpoena/suppressed material into
AI tools without enforceable no-training confidentiality terms, verifying every AI output and citation,
affidavits in the witness's own words, and being able to explain how AI was used if asked.

## How the product works (as specified)

- A **desktop app** the user runs on their own computer. They import documents (plain text for now).
- The app **detects identifying details** (names, places, schools, phone numbers, Medicare/TFN numbers,
  addresses, dates of birth…) using rules, an on-device name model and optionally a local language
  model, and the user **reviews** every detection before anything is shared.
- Identifiers are replaced with **tokens** such as `{{mother}}`, `{{mother.first}}`, `{{child_1}}`,
  `{{school}}`. Originals and the token key stay in an **encrypted vault** on the user's computer.
- **Claude Code** (an AI coding/agent tool) works in the case folder through a command-line tool
  (`casefile`) that only ever sees the tokenised copy. Claude can read documents, search, and write a
  chronology, issues with linked evidence (citing document lines like `D002:9`), notes, and draft
  paragraphs.
- The app always shows the user **real names** (tokens swapped back). Everything Claude writes is
  **unverified** until the user checks it. Affidavit paragraphs written by Claude must be rewritten by
  the user or explicitly **adopted** before an affidavit can be exported.
- Documents marked as discovery/subpoena/suppression material are **withheld** from Claude unless the
  user has a commercial (no-training) Claude plan.
- An **AI-use log** records what was imported, what Claude did and what the user checked.
- The user's Claude plan is a consumer Pro/Max plan.

## What you are reviewing

A set of design mockups (static HTML, one file per screen) in the folder given to you. Each `.dc.html`
file is ordinary HTML; text in `{{ … }}` inside the markup is filled from the `renderVals()` function in
the `<script type="text/x-dc">` block at the bottom of the same file (that is how literal tokens like
`{{mother}}` are displayed). Screens (file → screen):

- `Workbench.dc.html` — reviewing detections in a newly imported document before publishing it
- `wb/Unlock.dc.html` — opening or creating a case
- `wb/Documents.dc.html` — document list and import
- `wb/Document.dc.html` — reading a published document: what the user sees vs what Claude sees
- `wb/People.dc.html` — people, places and identifiers (the token key)
- `wb/Chronology.dc.html` — chronology, checking Claude's entries
- `wb/Issues.dc.html` — issues with supporting/undermining evidence
- `wb/Draft.dc.html` — an affidavit draft with authorship tracking and adoption
- `wb/Settings.dc.html` — Claude plan, detection settings, Claude Code, passphrase
- `wb/Paste.dc.html` — pasting Claude's text to see it with real names
- `wb/Log.dc.html` — the AI-use log

All names and numbers in the mockups are invented test data.
