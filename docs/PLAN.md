# casefile — plan

A local desktop app plus a Claude-facing CLI for a self-represented party in Australian family law proceedings. It de-identifies case documents, then lets Claude organise them and help draft from them **without ever seeing identifying information**. Designed around the FCFCOA *Practice Direction: Use of Artificial Intelligence* (PD-AI, issued 29 May 2026).

This file says what is built, what is deliberately not built and why, and what is still risky. The vocabulary is in [CONTEXT.md](../CONTEXT.md), the decisions in [adr/](adr/README.md), and the wave-by-wave record of the v2 rebuild in [rebuild/STATUS.md](rebuild/STATUS.md).

## Architecture

```
            you (real names)                          Claude Code (tokens only)
                  │                                            │
        ┌─────────▼──────────┐                       ┌─────────▼─────────┐
        │  casefile app      │                       │   casefile CLI    │
        │  (Deno.serve, UI)  │                       │  (no vault key)   │
        └───┬────────────┬───┘                       └─────────┬─────────┘
            │            │                                     │
   ┌────────▼─────┐  ┌───▼────────────────────────────────────▼───┐
   │   vault/     │  │                 public.db                  │
   │ originals,   │  │ tokenised text, index, chronology, issues, │
   │ who's who,   │  │ evidence, tags, notes, drafts, AI-use log  │
   │ ledger, …    │  │                                            │
   └──────────────┘  └────────────────────────────────────────────┘
                case folder (one per matter, location chosen by user)
```

- **App** (`src/app/`, Deno 2.9, TypeScript): import, de-identification, review, checking, drafting, export. It always **renders real names** and is the only component that can open the vault. It is a `Deno.serve()` app on 127.0.0.1 with a framework-free UI (`src/app/ui/`), run in the browser with `deno task app`. `deno desktop` packaging is not set up yet (ADR 2).
- **Case folder** per matter:
  - `vault/`: one AES-256-GCM file per document plus who's who, settings, the attestation ledger, exposures, lapsed checks, document authors, affidavit headings, annexure marks and the other app-only records, under a passphrase (and optional recovery key) (ADR 4).
  - `public.db`: SQLite (schema v4) holding tokenised text and all organisation data.
  - `CLAUDE.md` and `.claude/settings.json`: generated guidance and Claude Code settings (sandbox on, web tools denied), checked byte for byte by the app (ADR 3, ADR 17).
- **CLI `casefile`** (`src/cli/`): used by Claude Code. Reads and writes `public.db` **only**; it has no code path to the vault and is compiled with `--deny-net` (ADR 3).
- **AI-use log** (`ai_log` in `public.db`, hash-chained by the app, ADR 8): imports, sharing, CLI reads (with the lines returned, ADR 16) and writes, checks, adoptions, pastes and exports, as ids and counts only. The Court summary built from it and the vault answers PD-AI para 4.11 (ADR 18).

## De-identification pipeline

1. **Input**: plain text, Markdown and PDF (`.txt`, `.md`, `.pdf`): drop files or a folder, choose files, or paste text. Each import is a batch reviewed as a queue. A PDF's text layer is read in a worker with no permissions and the PDF is kept encrypted in the vault (`original-<id>`), viewable from the review and document screens; scanned PDFs are refused and scanned pages reported (ADR 23). Scanned PDFs, email and photos are listed as "coming soon" with copy-and-paste guidance.
2. **Detect**, in layers, on folded text with one matcher (ADR 6):
   - Australian rules: Medicare, TFN, ABN/ACN (checksums), phone, email, street address, suburb/state/postcode, dates of birth, court file numbers, BSB/account, licence/passport, social-media handles and profile URLs. Role hints such as `medicare_1`, `tfn_1`, `file_number`.
   - Every form, alias and identifying part of every entity already in the case.
   - Optional NER (pinned `Xenova/bert-base-NER` via transformers.js, offline; off by default) and an optional LLM pass through a user-configured OpenAI-compatible endpoint, refused if it is remote (including Ollama `:cloud` models) unless the user allows it (ADR 12).
   - Propagation of anything found once through the whole document.
   - A suggested origin from stamps such as "produced under subpoena".
3. **Review** (`#/review/<id>`): findings grouped Needs you / People / Places & organisations / Numbers, dates & addresses / Left as written. "Leave as written" needs a reason and is refused for safety-sensitive values. The user answers "Where did you get this document?" and sees the title Claude will see (a dry run of publishing).
4. **Publish**: tokenise, run the leak check over body and title, and write to `public.db`. The document is then **Shared** or **Withheld** by its origin and the Claude plan (ADR 7). Undo share and Review again keep earlier decisions.
5. **Re-identify** on display and export. Unknown or malformed tokens are flagged, never silently passed through (ADR 5).
6. **Exposure**: every change to who's who re-checks every shared document; one that now shows a known value is withdrawn at once and recorded with Claude's reads of it through casefile (ADR 7).

## What is built, by milestone

The original milestones (1–6) built the core and a first app; the v2 rebuild (waves 0–3, see [rebuild/STATUS.md](rebuild/STATUS.md)) reworked it to match the Workbench design.

1. **Core library and CLI** — built. Case folder, vault crypto (ADR 4), `public.db` with per-line FTS5 (ADR 10), rule detector, tokeniser and re-identifier (ADR 5), the `casefile` CLI. Security review fixes: titles through the detectors, role-name rule, secure delete (ADR 3).
2. **Detection** — built. NER with model pinning, LLM pass with endpoint classification, entity and role suggestion (ADR 12), folded matching and identifying forms (ADR 6).
3. **Desktop app v1** — built, then rebuilt in v2. Import, review, publish, real-name reading view, local API security (ADR 13).
4. **Organisation** — built. CLI write commands (document details, tags, chronology, issues, evidence, notes, drafts and paragraphs) and the user's checks, signed in a vault ledger (ADR 8), with the CLI refusing to change what the user checked or adopted.
5. **Drafting workspace** — built. Per-paragraph authorship and adoption with an affidavit export gate (ADR 9); draft kind recorded in the ledger.
6. **Packaging and more formats** — packaging built. `deno task desktop` builds `dist/casefile.app` (Apple silicon; about 240 MB, mostly the NER runtime) with the CLI inside. Releases are built, smoke-tested, signed and published by GitHub Actions, and the app updates itself from them (ADR 24). It is ad-hoc signed and installed with `install.sh`, not notarised. PDF import (text layer) is built (ADR 23); OCR and DOCX input are deferred (below).

**v2 rebuild** (all in the app and CLI as they stand):

- **Design system and shell**: dark-only UI, CSP-safe classes, bundled IBM Plex Sans and Mono, one state vocabulary, shared components, AppHeader with To-check count, ⌘K search across the case (ADR 20).
- **Sharing**: origin with "Not asked yet" as the default, the commercial plan behind three PD-AI 5.5 conditions with one-at-a-time sharing, exposures with triggers and re-check, details kept while an origin change withholds a document (ADR 6, ADR 7).
- **People**: colour slots, relationship descriptions Claude reads, the safety-sensitive flag and the person→detail link, where-they-appear, nickname impact, rename everywhere (ADR 15); merge two entries, stop replacing one that identifies no one, and "Tidy up who's who" suggestions from rules and the local language model (ADR 25).
- **Checking**: casefile's own checks of names, dates and numbers against the cited lines; four work states with lapsed checks; the two-part check; Can't check blocks checking; removed items restorable; issue and evidence edits; "only source is your own statement" (ADR 8).
- **Drafting**: four paragraph states with no similarity measure, placeholders, fact-by-fact answers at adoption, paragraph sources and relies-on links, vault-only affidavit heading, export flags for other kinds (ADR 9, ADR 16).
- **Paste**: logged views and copies, per-sentence checks, safety warning before copy, add to a draft as Claude's (ADR 19).
- **To check, log and Court summary** from signed records only; readable log with labels and CSV export (ADR 18).
- **Case setup**: recovery key, idle lock 15/30/60 minutes, Claude Code folder checks and restore, "Open Terminal here", PD-AI 5.4 confirmations, Getting started checklist (ADR 4, ADR 13, ADR 17).
- **CLI**: logs the lines and hits it returns, paragraph `--source` / `--relies`, plain withheld reasons, removed items hidden, guide rules against writing the witness's feelings (ADR 16).
- **Export** (wave 3): RTF for Word (affidavit with heading, numbered paragraphs and jurat; chronology table, checked only or all with unchecked marked), vault-only annexure marks, a provenance report per draft, and a safety confirmation before an export includes a protected address (ADR 21).
- **Word (.docx) export**: drafts and the chronology as `.docx` with the reviewed, exactly pinned `docx` package (9.7.2), run in a Web Worker with no permissions; the same layout, gates, safety check (on the file read back as Word shows it) and counts-only logging as RTF, which stays available. No PDF export: open the `.docx` in Word and Save as PDF (ADR 26).
- **Extra checks** (ADR 14): a `Judge` interface with three backends (a pinned NLI model on this computer, the language model under Finding names, Jev by TypeSafe), asked on request about chronology entries, evidence, draft paragraphs and shared documents; flags only, counts-only logging, Jev off by default and listed in the Court summary when used; thresholds calibrated on a synthetic labelled set (`deno task judge-eval`).
- **Seed**: `deno task seed` builds the synthetic CANON case (312 or 40 documents) through the real flows.

- **Cleanup** (W3-4): the legacy views and their shims, the `#/search` page and the old redirects are gone; so are the deprecated API surfaces (`sensitivity` fields and `POST /api/docs/:id/sensitivity`, `similarity`, the three-value paragraph `status`, `/api/stats`, `/api/reidentify`, `/api/settings/claude-setup`, the array-shaped `/api/search` and the `/api/entities` list). The API accepts origin values only; stored pre-v4 vault documents still read. Every value left as written needs the user's reason.

**The v2 rebuild is complete: waves 0–3 are merged or ready to merge** (see [rebuild/STATUS.md](rebuild/STATUS.md)), including the accessibility and CANON QA pass (W3-2) and the cleanup (W3-4).

## Deferred, and why

These are deliberate (REBUILD-PLAN section 3). The UI says so honestly rather than hiding them.

| Item | Why it is deferred | What the app does instead |
|---|---|---|
| OCR (scanned PDFs), `.eml`/`.msg`, photo import | Needs OCR and mail-parsing libraries. Text-layer PDF import and binary originals in the vault are built (ADR 23) | A PDF with no text is refused and pages without text are reported; import lists the rest as "coming soon" and says to copy the text, use Paste text, and keep the original outside the case folder |
| Attaching original files as annexures | Only PDFs keep their original (ADR 23); exports don't attach files yet | Annexure marks work (ADR 21); the user attaches the originals when filing |
| PDF export | The user's decision (ADR 26): Word makes a better PDF than casefile would, and it is one less writer to review | "Export for Word (.docx)" (or .rtf); to make a PDF, open it in Word and Save as PDF |
| Encrypted single-file backup and restore | The restore path is the risky part and needs its own ADR and tests | Getting started lists backup as not available yet; copy the whole case folder while casefile is closed. The recovery key **is** built |
| Judgement checks beyond the three built (direct quote, law to check), a quasi-identifier pass | Not built | Extra checks ask three questions (ADR 14 amendment) |
| Light theme | Contrast is specified and tested for dark only | Dark only (ADR 20) |
| "My affidavit sworn [date], para 4" citations | Not built in W3-1 | Citations of unmarked documents become "Title, line N" |
| Hearings and deadlines, draft versions, a hide-now key | Out of the design's scope | Nothing shown |

## Known limitations and remaining risks

**What casefile cannot see or enforce**

- **Shell reads are invisible to logging.** The log records what Claude read *through casefile* (CLI output). Claude Code can also read `public.db` or other files with shell commands, which casefile never sees, so exposure records and the Court summary are a lower bound for Claude's reads; every screen says "through casefile" (ADR 16). CLI rows Claude alters or deletes before the app countersigns them cannot be detected (ADR 8).
- **The sandbox is Claude Code's, not casefile's.** The generated settings turn on Claude Code's sandbox and deny web tools, but Claude Code honours them; the user or managed settings can override them, and user-level settings, `.mcp.json`, agents and hooks are outside casefile's view (ADR 3, ADR 17). Unsandboxed, Claude Code running as the same user could impersonate a local LLM server and receive original text, so use NER only in that case (ADR 12). The transformers.js code itself is not pinned when run from source.
- **Deno has no `openat`/`O_NOFOLLOW`.** casefile's writes and reads of the case's Claude Code files check for links and pipes and re-check device and inode just before the rename or read, but a swap between the last check and the rename or open is narrowed, not closed (ADR 13 amendment).
- **Confirmations and the plan are the user's statements.** casefile cannot check with Anthropic that "Help improve Claude" is off or that a commercial agreement meets PD-AI 5.5; the summary says "as recorded by you" (ADR 17, ADR 18).
- **Probing through edits** is turned into a refusal the user sees, but whatever the user finally saves is visible to Claude (ADR 3).

**Detection**

- Name detection is off by default: without NER or an LLM, only identifiers and names already in the case are caught, and a new name in a title is not; the app warns (ADR 3, ADR 6).
- Nicknames that share no word with the full name are caught only once added as aliases; homoglyphs from other scripts are not folded (ADR 6).

**Checks and flags that rest on the user's own answers**

- **"Only source is your own statement" depends on the user's own author choice.** It is shown when every cited document is origin `mine` and recorded as written by the role the user set as themselves; casefile does not check the document's content, so a wrong answer to "Who wrote it?" or a wrong `userRole` shows or hides the flag wrongly (ADR 8 amendment).
- casefile's own checks are deterministic (names, dates, numbers, feeling words, placeholders). They cannot tell whether a claim is a fair reading; that is the user's tick. Extra checks (ADR 14) can point out a note that may not be a fair reading, but they are small models or a hosted one, calibrated on a small synthetic set, and can be wrong both ways; they never mark anything checked.
- A lapsed check is not bound to content, so an item Claude replaces with SQL under the same id can show "Changed since you checked" when it should say "To check" (over-warns only, ADR 8).

**Text not re-checked**

- **Notes and drafts are not re-checked when a nickname is added.** The exposure check covers documents (and relationship descriptions, which are cleared). Text already in `public.db` that was tokenised before a value was known (the user's notes, draft paragraphs and titles, and other text the user typed) is not scanned again when a nickname or new entity is added, so a value the detectors missed at the time stays visible to Claude.
- Work Claude derived from a document while it was shared (chronology entries, notes, paragraphs) stays in `public.db` after the document is withheld or withdrawn (ADR 7).

**Legacy and grandfathered data**

- Paragraphs that became "Your words" under the old similarity rule stay "Your words" (ADR 9). Verifications made before the ledger or before cited-line hashing show as unchecked (ADR 8). Log rows from before sealing are `legacy` and are not counted (ADR 18).

**Open decisions for the user**

- **Log problems cannot be acknowledged.** A recorded log problem (lost or damaged log head, changed tail, missing settings) is permanent and keeps its warning on the Log screen and in the Court summary; there is no way to acknowledge it. The proposed UX is "Acknowledge": keep the record, mute the banner, and log the acknowledgement. It waits for the user's decision. Related risk: a crash that loses the last database rows while the fsynced head survives could record a false `tail_changed` problem, which then cannot be cleared (ADR 8 amendment).
- **Documents list filters (QA D4).** The mockup's per-column filter row (ID, Title, Date range, Type, Where it came from, Status) is not built; the screen has one "Filter by ID or title" box plus the sidebar facets (state, type, origin, tags). Whether the column filters are still wanted needs the user's decision and a DESIGN-SPEC note before anyone builds them.

**Known gaps**

- The exposure banner's list of Claude's work that goes back to "To check" when D006 is shared again has no seeded example: the CANON seed has no Claude work citing D006, so that list has not been seen in the browser (QA D4).
- The document API still returns `status` (`pending` / `published`) next to `state`: the screens use it to tell a document never reviewed from one reviewed but waiting for a re-check, which `state` (`needs_review` for both) does not distinguish.
- The packaged desktop app (`deno task desktop`) is built but not smoke-tested (above).

**Smaller open items** from the wave-2 gap list: IBM Plex Serif for the affidavit body is not bundled; which findings the user has "looked at" on review is kept in `sessionStorage` only; `summary.ts` repeats the store's log-chain input and must stay in step with it (ADR 18).

## Compliance rules built in

| Rule | PD-AI |
|---|---|
| The CLI can never reach originals or the key; withheld material is never in `public.db` | 3.3, 5.1–5.4 |
| Origin decides sharing: anything not the user's own is withheld on a consumer plan; on a commercial plan with all three conditions confirmed, material from the other side or a subpoena is shared one document at a time; material under an order, "not sure" and "not asked yet" are always withheld | 5.5 |
| Claude's work is "To check" until the user compares it with the cited lines and ticks both checks; citations link to source lines; casefile's own checks flag mismatches and block checking when it can't check | 4.6–4.7 |
| Affidavits: per-paragraph authorship history; export blocked until every Claude paragraph is adopted (one at a time, signed, logged) and no placeholder remains | 4.9 |
| LLM endpoint classified; remote refused unless allowed | 4.18–4.19 |
| Jev off by default, terms linked with the date checked, key in the vault, names-replaced text from shared documents only, listed as a second AI tool | 4.11, 4.18–4.19, 5.4–5.5 |
| Claude Code web tools denied and checked; "Help improve Claude" and chat history confirmations recorded | 5.4 |
| AI-use log and Court summary from signed records | 4.11 |

## Decisions

| Topic | Decision |
|---|---|
| User | Single user, self-represented party |
| Packaging | Desktop app (`deno desktop`), self-updating from signed GitHub releases (ADR 24) |
| Stack | All TypeScript (Deno) |
| NER | Own AU rules + transformers.js (pinned) + optional LLM pass |
| Inputs | Plain text and Markdown; paste / files / folder / drag-drop |
| Output | Markdown, text, RTF and .docx downloads (no PDF); Claude integrated via the CLI |
| Tokens | `{{role}}` and `{{role.form}}`, detector-suggested, user-confirmed |
| Dates | Keep; strip DOBs |
| Claude | Claude Code on Pro/Max ("Help improve Claude" should be off) |
| Storage | One case folder per matter |
| UI | Dark only, CSP-safe, bundled fonts (ADR 20) |

## Using it while it is being built

The user runs the desktop app, installed from this repo's GitHub releases. It updates itself: when a new release is out it shows "casefile X.Y.Z is ready — Restart to update" (ADR 24, [RELEASING.md](RELEASING.md)). Work happens in worktrees.

- **Develop:** in a worktree, run `deno task seed:dev` once, then `deno task dev` (http://127.0.0.1:8218, marked "dev"). It opens only cases inside `.dev/`.
- **Release:** open a PR; once GitHub CI is green and it is merged, the push to `main` releases it at the next version. The release workflow builds, smoke-tests, makes update patches, then signs and publishes (after the owner's approval, if the `release` environment requires it). A new version backs the case up to `~/Library/Application Support/casefile/backups/` (Claude Code can't read there) before it first opens it, and installs its own `casefile` CLI to `~/.local/bin`.
- **Go back:** quit casefile, install the earlier release's `casefile-macos-arm64.zip` from GitHub over `~/Applications/casefile.app`, then replace the case folder's contents with the backup made before the version being left (everything except `backup.json`). Work done since that backup is lost.
- **Schema changes:** bump `SCHEMA_VERSION`, add a migration, then freeze the new version with `UPDATE_SCHEMA_FIXTURE=1 deno task test tests/schema_fixtures_test.ts`.
- **Jev in development:** the TypeSafe key is `TYPESAFE_API_KEY` in `.env` at the checkout's root (gitignored; `.worktreeinclude` copies it into each new Claude Code worktree). In a cloud environment, set `TYPESAFE_API_KEY` in the environment's variables instead: a real variable wins over `.env`, and a missing `.env` is only a warning. `deno task judge-eval jev` uses it (calls are billed to that account). The app never reads it: to try Jev in `deno task dev`, paste the key in Settings → Extra checks, which keeps it in that case's vault.
- **Reporting a problem:** describe it in general terms ("a person with two aliases on the review screen"). It is reproduced on the CANON case and fixed with a test. Real documents and screenshots stay out of sessions (ADR 11).

## Development rule

**Real case documents never enter this repo or a Claude Code session.** Development and tests use synthetic fixtures only (`tests/fixtures/synthetic.ts`, `tests/fixtures/canon.ts`, ADR 11). The repo's `.gitignore` excludes case databases and folders.
