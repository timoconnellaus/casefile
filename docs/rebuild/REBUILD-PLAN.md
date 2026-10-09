# casefile v2 rebuild plan: matching the Workbench design

Read for this plan: CLAUDE.md, PLAN.md, CONTEXT.md, ADRs 3/5/6/7/8/9/10/12/13/14, all of `src/` (api.ts route table, session.ts, publicdb.ts schema v3, entities/tokens/drafting/vault/case/guide, CLI log calls, UI shell/lib/css), the test inventory, and every mockup (Workbench + 12 `wb/*` screens, text and `renderVals`), DESIGN-SPEC.md, CANON.md and REPORT.md. The repo is clean on `main`.

**Five facts that shape the plan:**
1. **No inline styles.** The CSP is `style-src 'self'`, so no inline `style` attributes are allowed. Mockup styling has to become classes, and entity colours become `.ent-c0…c5` classes. Google Fonts are blocked, so IBM Plex has to be bundled in the repo.
2. **Two hotspot files.** `api.ts` (one 778-line route table) and `session.ts` (1744 lines, holding the attestation ledger too) would be edited by nearly every package. Splitting them is a prerequisite for parallel work.
3. **Identifier roles mostly fit already.** They are `{{phone_1}}`-style today (`KIND_PREFIX`), so ADR 5 needs no change. Medicare, TFN and ABN currently get `id_N` roles; CANON wants `medicare_1`, `tfn_1`, `abn_1` and `file_number`, which is a role-hint change only.
4. **Existing fixtures don't match CANON.** `tests/fixtures/synthetic.ts` differs from CANON (D001 has 4 lines, not 7; D002 line 9 says "the children", not "Mia and Lachlan"). Add a new `tests/fixtures/canon.ts` rather than editing the old one, which dozens of tests depend on.
5. **No API tests exist for the UI.** `src/app/ui` is excluded from lint and untested.

---

## 1. Gap list (design vs `src/`)

Legend: **UI** = UI-only. **API** = new or changed route. **Core** = logic in `src/core`. **Schema** = public.db or vault format. **CLI** = Claude-side change. **ADR** = changes a recorded decision. Sizes are S, M or L.

### A. Shell and design system
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Dark Workbench tokens (colours, type scale, radii), focus ring `#FFD27A`, IBM Plex bundled in the repo | Light/dark CSS variables, system fonts | M | UI | new ADR 0020 (dark-only, CSP-safe styling, bundled fonts) |
| AppHeader: case name, 8-item nav with `aria-current`, To-check count, ⌘K search, "Locks after N min idle", Lock | Side nav, 9 items, no count | M | UI + API (count from `/api/to-check`, idle minutes from `/api/status`) | – |
| Components: Badge (state vocabulary only), ActorLabel, EntityMark, TokenChip, EntityDot, Key, SourcePanel (±2 lines), CheckList, ConfirmBar, Toast with Undo, live region, FilterChips, sortable/paged Table, Dialog | `badge()` and `richText()` only | L | UI | – |
| Hover links every occurrence (150 ms delay, others dim to 60%), focus and pin, `aria-describedby` popover text | None | M | UI (needs segments, below) | – |
| Segments: re-identified text split into `{t, role, form, kind, colour}` so the client can colour and chip it | Flat strings from `show()`/`plain()` | M | Core (`tokens.ts`) + API (all routes) | – |
| Keyboard shortcuts only while a list has focus, with an on/off setting and hints only when on | Global keys | S | UI + settings field | – |
| ⌘K "Search everything" palette (document lines, people, chronology, issues) with totals | Separate Search page, capped at 50/100 | M | API + UI | – |
| Every screen: one `<h1>`, real tables for side-by-side, distinct `aria-label`s, targets of 44/32 px or more | Partial | M | UI | – |

### B. Unlock, new case, recovery
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Show/hide passphrase, "Type it again" label, honest "forgot passphrase" panel | Basic forms | S | UI | – |
| Recovery key: optional at creation, shown once, unlocks the case, can be rotated | None | M | Core (vault keyfile gets a second wrapped data key) + API (open route accepts `recoveryKey`) + Schema (keyfile v2) | **ADR 4 amendment, ADR 13 amendment** |
| Lockout wait shown | Exists (`retryAfterSeconds`) | S | UI | – |

### C. Getting started (Start)
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| 6-step checklist with state derived from records (plan recorded, documents imported, documents shared, Claude Code found, "I've done this") | None | M | API `/api/start` + UI | – |
| PD-AI 5.4 confirmations ("Help improve Claude" off, chat history), dated and logged | None | S | Settings fields + API + log | new ADR 0017 |
| "casefile checked: web search/fetch blocked" (compare `.claude/settings.json` with `CLAUDE_SETTINGS`) | None | S | Core (`case.ts`) + API | ADR 0017 |
| "Look for Claude Code again" (`claude` and `casefile` on PATH, found by stat-ing PATH entries, no `--allow-run`) | None | S | API | ADR 0017 |
| "Open Terminal here" (`open -a Terminal <dir>`) | None | S | API, needs `--allow-run=open` | **ADR 13 amendment** |
| "Ask Claude to…" request templates, glossary, "not legal advice" panel | None | S | UI (static copy) | – |
| Step 6: encrypted backup | None | – | **Deferred** (see section 3) | – |

### D. Documents list and import
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Status counts in the vocabulary Needs review / Shared with Claude / Withheld from Claude / Exposed — re-check | `pending`/`published` plus `withheld` | M | Core `docState()` + API | ADR 7 |
| "Where it came from" filter with 5 categories plus "Not asked yet" | 5-value sensitivity, import default `none` | M | Core + Schema + API | **ADR 7 amendment** |
| Type filter groups, tags, sort, 50/100/200 paging, "undated first" rule | Plain list | M | UI (client-side; hundreds of documents is fine) | – |
| "Cited" count per document | None | S | API (store count over chronology_sources, evidence, paragraph_sources) | – |
| Bulk actions: review selected, tag, set origin | None | S | UI (loops existing endpoints) | – |
| Drop files or folder, Choose files, Paste text, "Checking 5 of 7: …" progress | Partly in the legacy UI | S | UI | – |
| PDF, email and photo imports listed as "coming soon", with copy-and-paste guidance | – | S | UI | – |
| "What casefile knows about this case" panel (plan, name finders, counts) | None | S | UI over `/api/settings` and `/api/to-check` | – |

### E. Review screen (Workbench)
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Review queue strip for the current import, "Import more" | Single document | S | UI | – |
| Findings grouped Needs you / People / Places & organisations / Numbers, dates & addresses / Left as written, each with count and decision state (Decided automatically · not looked at yet / You decided) | Spans coloured by decision status | M | API (grouping, kind, colour per proposal) + UI ("looked at" kept client-side per document) | – |
| Filter chips All / Needs you / Not looked at yet / You decided | None | S | UI | – |
| Original / As Claude sees it / Side by side (as a `<table>`), colour, chips, key | Partial | M | UI + API segments for proposals | – |
| "Which person is this?" for ambiguous spans, "Leave as written…" with a required reason, "Claude will see exactly this" preview | Ignore list, no reason | S | Core (`ignoreReasons` stored in vault doc) + API + UI | ADR 6 amendment |
| Safety-sensitive entities cannot be left as written | None | S | Core (publish refuses) | ADR 6 / 0015 |
| "Where did you get this document?" per document, with a suggestion from a stamp ("Produced under subpoena") | Batch-level select | S/M | Core `originHints()` (rules) + API + UI | ADR 6/7 |
| "Mark something missed" button (not only select + M) | Keyboard only | S | UI | – |
| Finish document gate ("N decided automatically, not looked at yet"), ConfirmBar "Share" summary, then a toast with **Undo** (withdraw) | Publish only | M | API `POST /docs/:id/withdraw` + Core + UI | ADR 7 |
| Identifier role hints `medicare_1`, `tfn_1`, `abn_1`, `file_number` | `id_N` | S | Core (`detect/rules.ts` role hints) | – |

### F. Document view
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Single column by default plus side-by-side table, key with counts, underline shapes | Basic | M | UI | – |
| Change origin with an impact ConfirmBar: withdrawn now, what cites it (chronology, evidence, notes), Claude's reads from the log | Sensitivity select with no impact | M | API `/docs/:id/origin-impact` + Core | ADR 7 |
| "Review again" (reopen a shared document with earlier decisions pre-applied) | None | M | Core + API | ADR 7 |
| "Cited in" list with states | None | S | API (store query) | – |
| "What Claude did through casefile" (log rows for this document, including lines read) | None | S | API + **CLI must log the lines and search hits it shows** | new ADR 0016 |
| "Link selected lines…" to an issue | None | S | UI (existing evidence endpoint) | – |

### G. Sharing states: origin, withholding, exposure
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Origin `mine \| other_side \| court_or_subpoena \| under_order \| not_sure`, null = not asked. Not asked counts as not sure, so it is withheld | `none/discovery/subpoena/suppression/restricted`, default `none` | M | Core + Schema (v4 value map, vault doc read-normalisation) + API | **ADR 7 amendment** |
| Commercial plan needs 3 dated, logged condition confirmations; switching does **not** auto-share; eligible documents are shared one at a time; `under_order` and `not_sure` stay withheld on any plan | Switch republishes everything restricted | M | Core + API | **ADR 7 amendment** |
| **Exposed — re-check**: adding an alias triggers an audit; any shared document that now leaks is withdrawn at once (`withheld_reason='exposed'`) and an exposure is recorded (shared, found, withdrawn and re-shared dates, Claude's reads in that window from the log). Pending documents are re-detected ("new match"). Batch "Re-check N documents"; "these go back to To check" list | `auditPublished()` only reports | L | Core (`exposure.ts`) + vault file `exposures` + Schema (`withheld_reason`) + API | **ADR 7 amendment** (+ ADR 6 note) |
| CLI says *why* a document is withheld (origin / exposed / not asked) | Says "(subpoena material)" | S | CLI | ADR 0016 |

### H. People
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Who's who list grouped People / Places & organisations / Numbers & dates, searchable, paged, with document and mention counts | Flat list | M | API (counts from vault replacements) + UI | – |
| Colour slots: 6-hue palette *index* in the vault, defaults mother→0, father→1, child_1→2, child_2→3, 2 spare, taken slots disabled | None | S | Core (`entities.ts`) + Schema (vault entity) + API | **new ADR 0015** |
| Relationship description shown to Claude (user-written, detector-checked, published to `entities.description`) | None | M | Core + Schema v4 + API + CLI (`entities` prints it) | ADR 0015 (ADR 3 consequence) |
| Safety-sensitive flag: no "Leave as written", warn on export/copy, address hidden until shown | None | S core + S UI | Core (publish gate) + UI | ADR 0015 |
| Forms table (full/first/surname/title) with chips, rename everywhere | Exists (PATCH) | S | UI | – |
| Add or remove a nickname with impact ("appears in D006, D015, D016"), Undo | Aliases exist, no impact | S | API `/entities/:role/alias-impact` | – |
| "Where she appears": documents (with Exposed badge), chronology, issues, drafts | None | M | API `/entities/:role/usage` | – |
| Merge with another person | None | L | **Deferred** | – |

### I. Chronology
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| States To check / Checked against source / Changed since you checked / Can't check | verified true/false | M | Core (ledger keeps a "lapsed" record when a stale entry is pruned) + API | **ADR 8 amendment** |
| CheckList: casefile checks that every entity token, date and number in the entry appears in the cited lines; flags a child swap; Can't check blocks verifying | None | M | Core `claimcheck.ts` (pure function) + API + verify gate | ADR 8 amendment |
| Two-part check (quote accurate + fair reading), button disabled until the source is shown, both flags required and logged | Single verify with version | S | API + Core | ADR 8 amendment |
| "Only source is your own affidavit/message" flag | None | S | Core (cited docs all origin `mine` and authored by `settings.userRole`) + settings `userRole` | – |
| SourcePanel with ±2 lines of context, "Open document" | Quote only | S | API (`context` lines from the vault) | – |
| Filters (person, document, issue, author), search, year jump, Highlight-people toggle, key | Partial | M | UI. Issue filter = evidence overlap, computed by the API | – |
| Remove moves the entry to **Removed items** (restorable); drafts citing it warn | Hard delete | M | Schema (`removed_at/removed_by` on chronology, evidence, issues) + Core + API + CLI (exclude removed) | ADR 8 amendment |
| Export as a Word table (only checked entries, or unchecked ones marked), citations converted to plain descriptions | None | M | Wave 3 (RTF; see section 3) | – |
| "Ask Claude to correct it" copyable request | None | S | UI | – |

### J. Issues and evidence
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Issue description check ("describes the question fairly") with its own state | `verifyIssue` exists | S | API (flag) + UI | ADR 8 amendment |
| Evidence: CheckList, two-part check, own-message flag, swap detection, "Changed since…" | Single verify | S (reuses I) | API | – |
| Stance labels Helps your account / Points the other way / Background (all three shown) | context stance hidden | S | UI | – |
| "Used in" drafts | None | S | API (paragraph_links) | – |
| Claude's note on an issue → "Mark as dealt with" | Notes have no done state | S | Schema `notes.done_at` + API | – |
| Add evidence via document picker and line range, or "Link selected lines", with preview | Typed `D004:12-15` only | S | UI | – |
| Filters "with something to check", "used in a draft"; sorts | None | S | UI | – |
| Unlink → Removed items | Hard delete | (in I) | – | – |

### K. Drafts and affidavit
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| **Paragraph states** Your words / Drafted by Claude — needs you / — rewritten by you, adopt to confirm / — adopted. Drafted-by-Claude is permanent, **no similarity**, rewritten still needs adopting | Dice similarity < 0.5 makes it the user's | M | Core (`drafting.ts`, ledger kind `rewrite`) + API | **ADR 9 amendment** |
| Paragraph **sources** (document lines) and **relies on** (chronology/evidence) shown in the draft and the adopt panel, with the relied-on items' check state | None | M | Schema (`paragraph_sources`, `paragraph_links`) + CLI `para add/edit --source/--relies` + API | ADR 9 amendment, ADR 0016 |
| Fact by fact: deterministic checks per sentence against the paragraph's sources ("Mia isn't in D001:3"), feeling-word flag ("only you can say it"), per-fact "Did you see this yourself or read it?" answers logged with the adoption | None | M | Core (`claimcheck.ts`) + API | ADR 9 amendment |
| Placeholder `[In your own words: …]` blocks adoption | None | S | Core + CLI guide | ADR 9 amendment |
| Only one edit/adopt panel open at a time; Rewrite panel shows Claude's version for reference | – | S | UI | – |
| Affidavit heading (file number, deponent/applicant/respondent roles, occupation, address, sworn/affirmed), kept in the **vault** only | None | M | Core + vault `draft-heading-<id>` + API | ADR 9 amendment |
| Export: affidavit layout with heading, numbered paragraphs, jurat placeholders, `[check against the Court's current form]` markers; citations converted to "Title, line N" | Markdown/text, numbered paragraphs | M | Core | ADR 9 amendment |
| Lighter gate for outlines/letters (unchecked Claude facts flagged and confirmed at export, not blocked); drafts list shows "N need you" / "N facts to check" | Free export | S | Core + API | ADR 9 amendment |
| Annexures (marks like AT-1, original from the vault) and citation → annexure mark | None | L | Marks in wave 3; attaching original files deferred | – |
| Export for filing in Word / PDF | md/txt | – | Wave 3 RTF; .docx/PDF deferred | – |
| "Not legal advice" plus Legal Aid links | None | S | UI | – |

### L. Paste
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Each view logged (count and characters, never content) | Logs `reidentified_text` | S | API | **new ADR 0019** |
| Per-sentence checks for cited lines (✓ / ● Not checked / ▲ Can't check), unknown-token danger, key | Unknown tokens listed | M | API (reuses claimcheck) + UI | ADR 0019 |
| "Claude's words — not for an affidavit as written" label; Copy logged, with "don't paste into any AI" warning and Clear clipboard | Copy, no log | S | API `POST /api/paste/copied` + UI | ADR 0019 |
| "Add to a draft as Claude's" (needs-you paragraphs, logged, Undo) | None | M | Core + API | ADR 0019 / ADR 9 |

### M. To check
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| One queue: exposed documents, documents to review, chronology (to check, can't check, changed), evidence, paragraphs needing you, unchecked issue descriptions; "most serious first, then oldest"; What/Who filters; next step; empty state; context panel | None | M | Core `summary.ts` + API `/api/to-check` + UI | new ADR 0018 |

### N. Log and Court (4.11) summary
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| "If the Court asks" built **only from signed records and the vault**: tools used (Claude with the plan as recorded, name finder, local LLM date range and document count, Jev off), checking counts, paragraph breakdown, paste uses, what was kept from Claude by origin, 5.4 confirmations with dates, open items, exposures, limits | `/api/stats` reads Claude-writable `verified_at` | L | Core + API `/api/court-summary` | **new ADR 0018** |
| Copy the summary; provenance report for one draft | None | M | Wave 3 | ADR 0018 |
| Full log: grouped by date, plain-language labels, filters (What, Document, Who), "Log checked: no changes found since …", Download full log | Flat, one filter | M | API (`/api/log/entries` paged with categories) + UI | – |

### O. Settings
| Capability | Now | Size | Type | ADR |
|---|---|---|---|---|
| Plan with commercial 3-condition dialog, list of what *could* then be shared, still-withheld list | Radio, auto republish | M | Core + API + UI | ADR 7 |
| Claude Code status rows (settings file present and unchanged, web blocked, sandbox requested, casefile installed), ● Changed → "Put the settings back", Details | None | M | Core (`case.ts` check/restore) + API | ADR 0017 |
| 5.4 checklist "Confirm again today" | None | S | API | ADR 0017 |
| Name finding with plain status; LLM "Not used" explanation; risky options need a typed phrase | Checkboxes | S | UI (server logs as now) | – |
| Extra checks backend (this computer / local LLM / Jev) | None (ADR 14 not built) | – | **Deferred**; only "Built in: names, dates and numbers" shown | – |
| Auto-lock 15/30/60 minutes; keyboard shortcuts on/off | Fixed 30 minutes | S | Settings + `AppState` | ADR 13 amendment |
| Backup and recovery: recovery key in scope, backup file deferred | None | (B) | – | ADR 4 |
| Passphrase change | Exists | S | UI | – |

### P. CLI and Claude guidance
| Capability | Size | Type | ADR |
|---|---|---|---|
| `para add/edit --source D001:3 (repeatable) --relies chrono:N\|evidence:N`; `para list` shows sources | M | CLI + Schema | ADR 0016 |
| Log what Claude saw: `docs show` (exists), `search` hits `[{doc,line}]` (capped), `chrono list` / `issue show` cited lines quoted | S | CLI | ADR 0016 |
| Lists exclude removed items; `entities` prints descriptions; withheld reason messages | S | CLI | – |
| Guide rules: never write the witness's feelings or opinions; use `[In your own words: …]`; always cite paragraph sources; no outcome predictions or legal advice; respond to "Can't check" notes | S | `guide.ts` | ADR 9 note |

---

## 2. Work packages

### Global rules for every package
- Each package runs in its own worktree on branch `v2/<id>` and ends green on `deno task ci`.
- **Single owner per file per wave.** Files not listed as owned are read-only. If a package needs a store query that isn't in its files, it writes a free function in its *own* module that takes `PublicStore` (folded back in wave 3).
- **Wave-1 API changes are additive.** Keep `sensitivity`, `similarity`, `/api/stats` and `/api/search` (array) working until wave 3, so the legacy UI keeps running.
- **New tests go in new files** using `tests/helpers/app.ts` (created in W0). Edit only the existing test files your package owns (tables below).
- **ADR numbers are pre-assigned** (below) so parallel packages don't collide.
- **Synthetic data only** (ADR 11). New tests use `tests/fixtures/canon.ts` (CANON case).

### Wave 0: seams and contracts (one agent, sequential, merged before wave 1 starts). No behaviour change except the origin rename.
**Owns:** `src/app/api.ts`, new `src/app/routes/*.ts`, `src/core/session.ts`, new `src/core/ledger.ts`, `src/core/publicdb.ts`, `src/core/tokens.ts`, `src/core/entities.ts` (types only), new `src/core/states.ts`, new stub modules (`claimcheck.ts`, `origin.ts`, `exposure.ts`, `summary.ts`), `src/core/drafting.ts` (rename only), `CONTEXT.md`, new `tests/helpers/app.ts`, new `tests/fixtures/canon.ts`, and any existing test needing mechanical updates.

1. **Split routes.** `api.ts` becomes `buildRoutes(state) = [...caseRoutes(ctx), ...settingsRoutes(ctx), …]` plus `errorResponse` with an `ERROR_MAPPERS` array that modules extend. `routes/context.ts` exports `HttpError`, `route`, `str`, `num`, and `RouteContext { s(), state, show(), plain(), quote(), notes(), guardedSave() }`. Modules and their wave-1 owners:
   - `case.ts`, `settings.ts` → G
   - `docs.ts`, `plan.ts` → B
   - `entities.ts`, `search.ts` → E
   - `chronology.ts`, `issues.ts`, `notes.ts` → C
   - `drafts.ts`, `paste.ts` → D
   - `log.ts`, `overview.ts` → H

   Existing routes move verbatim into these files.
2. **Extract the ledger.** Lines ~1075–1690 of `session.ts` (attest/revoke/isAttested, epochs, prune, summaries, user items, draft kinds, verify\*/is\*) move verbatim into `class Ledger` in `ledger.ts`. `CaseSession.ledger` is public, and `CaseSession` keeps thin delegates so callers don't change. Make `saveDoc`, `publishToStore` (renamed `republish`), `bumpDoc` and `docName` public, and add `readVaultJson<T>(name, fallback)` / `writeVaultJson(name, v)` (queued). Add new `AttestationKind`s now: `rewrite` (content = `{id, draft_id, body}`, same as authorship) and `plan` (content = `{setup, conditions}`), each with its `#ledgerContent` and summary case.
3. **public.db schema v4** (one migration, `BEGIN IMMEDIATE` like v3):
   - `documents.withheld_reason TEXT` (`origin|not_asked|exposed`)
   - `UPDATE documents SET sensitivity = CASE …` maps none→mine, discovery→other_side, subpoena→court_or_subpoena, suppression→under_order, restricted→not_sure
   - `entities.description TEXT`
   - `notes.done_at TEXT, done_by TEXT`
   - `removed_at TEXT, removed_by TEXT` on `chronology`, `evidence`, `issues`
   - `paragraph_sources(paragraph_id REFERENCES paragraphs ON DELETE CASCADE, doc_id, line_start, line_end)`
   - `paragraph_links(paragraph_id, target_type CHECK IN ('chronology','evidence'), target_id)`

   Store accessors: `setParagraphSources`, `listParagraphSources`, `setParagraphLinks`, `listParagraphLinks`, `markNoteDone`, `softRemove(type,id,by)`, `restore(type,id)`, `listRemoved(type)`, `citationsOf(docId)`, `citationCounts()`, `logForDoc(docId)`, `setEntities({role,kind,description})`. List methods take `{includeRemoved?:boolean}`, default false.
4. **Origin rename (mechanical).** `type Origin` in `publicdb.ts` with `ORIGINS` and `LEGACY_SENSITIVITY_MAP`. `StoredDoc.origin: Origin | null`, normalised from `sensitivity` when read. The API accepts either value set. `isRestricted(o) = o !== "mine"` keeps today's semantics, so `null` is treated as restricted, but the import default stays `"mine"` until B. Update affected tests (`publicdb_test`, `integrity_test`, `session_test`, `app_test`).
5. **Segments.** `tokens.ts`: `renderSegments(text, resolve) → { segs: Seg[]; unknown; malformed }`, where `Seg = {t} | {t, role, form} | {t, unknown:true, raw} | {t, malformed:true, raw}`. `session.reidentifyRich(text)` adds `kind` and `colour`. `RouteContext.show()` returns `Rich = {text, segs, unknown, malformed}` (additive); `quote()` lines become `{line, text, segs}`.
6. **Vocabulary contract** (`states.ts`, importable by the CLI):
   - `DocState = "needs_review"|"shared"|"withheld"|"exposed"`
   - `WorkState = "to_check"|"checked"|"changed"|"cant_check"`
   - `ParaState = "user"|"claude_needs_you"|"claude_rewritten"|"claude_adopted"`
   - `CheckRow = {kind:"entity"|"date"|"number"|"feeling"|"placeholder"|"citation"; text:string; ok:boolean|null; level:"ok"|"attention"|"danger"; where?:string; message:string}`
   - `OriginHint = {origin, reason, line}`
   - `Exposure = {doc, roles:string[], sharedAt, foundAt, withdrawnAt, resharedAt:string|null, claudeReads:{ts, lines:string}[], newMatchesIn:string[]}`
7. **Stubs with final signatures** (the owner fills them in during wave 1):
   - `claimcheck.ts`: `checkClaim(claimTokenised, cited:{ref:SourceRef; lines:{line,text}[]}[], kinds:Map<role,EntityKind>): CheckRow[]` (returns `[]`) and `splitSentences(text): {text, cites:SourceRef[]}[]`
   - `origin.ts`: `withheldReason(origin, setup, released): "origin"|"not_asked"|null`, `originHints(text): OriginHint|null`
   - `exposure.ts`: `listExposures(session): Promise<Exposure[]>`
   - `summary.ts`: `courtSummary(session)`, `toCheck(session)`
   - `drafting.ts`: `paragraphState()` alias of `paragraphStatus`, mapping to `ParaState`
8. **Settings and entity types widened.** `CaseSettings += { idleLockMinutes?:15|30|60; shortcuts?:boolean; userRole?:string; confirmations?:{helpImproveOff?:string; chatHistory?:string}; plan?:{setup, conditions?, at}; recoveryKey?:boolean }`, and `updateSettings` accepts them. `Entity += { colour?:number|null; safety?:boolean; description?:string|null }` (description tokenised), published by `saveRegistry`.
9. **Test scaffolding.** `tests/helpers/app.ts` exports the setup/`withCase`/`importAndPublish`/client helpers taken from `app_test.ts`. `tests/fixtures/canon.ts` holds CANON's D001 (7 lines), D002 (line 9 exact), entities and an `seedCanon(session)` helper.
10. `CONTEXT.md`: new terms (Origin, Shared, Withheld, Exposed, Checked against source, Changed since you checked, Can't check, Drafted by Claude, Removed item, Colour slot, Exposure).

**Acceptance:** every existing test passes, with only the origin-value edits. `routes/*` together give the same route set (`allRoutes` test). The CLI boundary test is still green. Stubs compile.

### Wave 1: foundations (8 packages in parallel, all branched from W0)

**ADR ownership:**
| ADR | Owner |
|---|---|
| 4 (amend) | G |
| 6 (amend) | B |
| 7 (amend) | B |
| 8 (amend) | C |
| 9 (amend) | D |
| 13 (amend) | G |
| 0015 entity colour, description, safety | E |
| 0016 CLI records what Claude read, paragraph sources | A |
| 0017 Claude Code folder checks and PD-AI 5.4 confirmations | G |
| 0018 To-check queue and 4.11 summary from signed records | H |
| 0019 Paste: logged, labelled, added to drafts as Claude's | D |
| 0020 UI design system (dark, CSP-safe, bundled fonts, vocabulary) | F |

**Test-file ownership in wave 1:**
| Package | Test files |
|---|---|
| A | publicdb, cli, attested_delete |
| B | session, withheld, security, fail_closed, pipeline, rules, detection, app_test.ts |
| C | integrity, log_chain |
| D | drafting, attestation, draft_kind, probe |
| E | entities, tokens |
| G | vault, sandbox_pin |
| H | none existing |
| F | none existing |

Nobody edits ner, llm, signing or tokenise tests.

#### W1-A: Store and CLI
- **Owns:** `src/core/publicdb.ts`, `src/cli/*`, `src/core/guide.ts`, ADR 0016, the tests above, new `tests/cli_reads_test.ts`.
- **Do not touch:** session, ledger, routes, UI.
- **Scope:**
  - `para add/edit --source` (repeatable, validated with `checkSourceRef`, withheld documents refused) and `--relies chrono:N|evidence:N`; adopted paragraphs still refused.
  - `para list/show` print sources.
  - `entities` prints descriptions.
  - All list/show commands exclude removed rows; `chrono rm`/`issue rm` on a removed row reports "removed by the user".
  - Withheld messages name the reason.
  - Logging: `cli:search` gets `hits:[{doc,line}]` (max 200); `cli:chrono_list` and `cli:issue_show` record `cited:[{doc,lines}]`.
  - Guide rules (section 1P).
  - Fix any accessor bugs in W0 store code.
- **Provides:** log detail shapes `{doc, lines}` and `hits[]`, which B (exposure reads), H and the Document activity view consume.
- **Tests:** sources round-trip; a withheld-document source is refused; removed rows are hidden; logged hits; the guide contains the new rules; nothing printed contains an original (existing test).
- **Accept:** `deno task cli para add 1 --text … --source D001:3 --source D001:5-6` works and is logged; boundary test green.

#### W1-B: Sharing (origin, withholding, exposure, review data)
- **Owns:** `src/core/session.ts`, `src/core/origin.ts`, `src/core/exposure.ts`, `src/core/detect/*`, `src/app/routes/docs.ts`, `src/app/routes/plan.ts`, ADR 6 and 7 amendments, its test files plus new `origin_test.ts`, `exposure_test.ts`, `docs_api_test.ts`.
- **Scope:**
  - Import default `origin = null`; `withheldReason` rules:
    - consumer plan: anything but `mine` is withheld
    - commercial plan: `other_side` and `court_or_subpoena` are withheld until the document has `released: true`, set by an explicit per-document share
    - `under_order` and `not_sure`/`null` are always withheld
  - `setClaudeSetup` no longer republishes, apart from withdrawing when switching back to consumer. `POST /api/plan {setup, conditions:{closedEnvironment, noTraining, thisCaseOnly}}` requires all three `true` for commercial, attests (`plan` ledger kind), stores the date and logs.
  - `originHints` (rules: "produced under subpoena", "subpoena", "discovery", "disclosure" stamps in the first N lines).
  - Identifier role hints (`medicare_1`, `tfn_1`, `abn_1`, `file_number`).
  - `ignoreReasons`; publish refuses to leave a `safety` entity's value as written.
  - `withdraw` (Undo share) and `reopen` (Review again, prior replacements become accepted proposals).
  - **Exposure:** a hook after `updateEntity`/`renameEntity` runs `auditPublished`; each leaking shared document is republished withheld with reason `exposed` and doc state `exposed`. An exposure record goes to the vault file `exposures`; `claudeReads` come from ai_log rows with `detail.doc` (and search hits) between `sharedAt` and `withdrawnAt`. Pending documents are re-detected; `newMatchesIn` is filled. Log row `document_withdrawn {doc, reason:"exposed"}` (no value). On re-share `resharedAt` is set. `listExposures` is implemented.
- **API (contract):**
  - `GET /api/docs` → `[{id,title,state,origin,originHint,withheldReason,importedAt,sharedAt,doc_type,doc_date,tags,cited,detectorErrors}]` (plus legacy fields)
  - `GET /api/docs/:id/review` → adds `segments` per line built from proposals, `findings:[{id,group:"needs"|"people"|"places"|"ids"|"kept",auto:boolean,role?,form?,kind,colour,text,lines:number[]}]`, `originHint`, `safetyRoles`
  - `PUT /api/docs/:id/origin {origin}` → `{state, withdrawn}`
  - `GET /api/docs/:id/origin-impact?origin=` → `{withdraw, citedBy:{chronology,evidence,notes,paragraphs}, claudeReads}`
  - `POST /api/docs/:id/publish` (+`ignoreReasons`, `release?`)
  - `POST /api/docs/:id/withdraw`
  - `POST /api/docs/:id/reopen`
  - `POST /api/docs/recheck {docs}`
  - `GET /api/docs/:id` → adds `state, origin, lines[{line,text,segs}], citedIn[], activity[]`
  - `GET /api/exposures`
- **Accept:**
  - A CANON D006 scenario test: share; Claude reads lines 1–12 via the CLI; add alias "Annie"; D006 is withdrawn with no body in public.db; the exposure lists the read; D015/D016 show new matches; re-check and re-share clears the state; chronology citing D006 shows `changed`.
  - Commercial without conditions → 400. Switching to commercial publishes nothing by itself.

#### W1-C: Checking
- **Owns:** `src/core/ledger.ts`, `src/core/claimcheck.ts`, `routes/chronology.ts`, `routes/issues.ts`, `routes/notes.ts`, ADR 8 amendment, its test files plus new `claimcheck_test.ts`, `checking_api_test.ts`, `removed_test.ts`.
- **Scope:**
  - `checkClaim`: entity tokens in the claim vs the cited lines (by role); a different role of the same kind present marks a swap (`danger`, "may have mixed up"); dates normalised across `14 March 2025`, `14/03/2025`, `2025-03-14`; numbers with units ("90 minutes"); feeling lexicon; placeholder; missing citation.
  - `splitSentences` with inline cites.
  - **Lapsed memory:** a vault file `lapsed-checks` `{key:{checkedAt, reason:"source_changed"|"edited"}}` is written when prune or `isAttested` drops a stale entry. WorkState `changed` = not attested and lapsed exists; `cant_check` = an entity check fails, a source is uncitable, or a token is unknown.
  - Verify requires `{version, quoteAccurate:true, fairReading:true}` (evidence the same; issue `{version, neutral:true}`); refused with `CantCheckError` (409) when any entity row fails; flags logged.
  - Soft remove/restore for chronology, evidence and issues (attestations kept); `GET ?removed=1`.
  - Notes done.
  - `ownStatementOnly`; `context` lines (±2, from the vault); `usedIn` (via paragraph_links and evidence overlap); chronology `issues` derived from evidence overlap.
- **API:** chronology and evidence items gain `state, checks:CheckRow[], lapsed, ownStatementOnly, sources[{…, docTitle, withheld, quote:Line[], context:{before,after}}], removed_at`. Issues gain `descState, usedIn`. Plus `POST …/remove`, `…/restore`, `POST /api/notes/:id/done`.
- **Accept:** CANON 14 March entry → ✓ date, ✓ Daniel, ✓ 90 minutes, ✓ school, ▲ Lachlan not in D001:1–2. CANON 29 March entry → `cant_check` and verify refused. Republishing a cited document turns a checked entry into `changed`. Restore brings back a checked entry still checked.

#### W1-D: Drafting, authorship and paste
- **Owns:** `src/core/drafting.ts`, `routes/drafts.ts`, `routes/paste.ts`, ADR 9 amendment, ADR 0019, its test files plus new `authorship_test.ts`, `paste_api_test.ts`.
- **Scope:**
  - Remove `similarity`/`REWRITE_THRESHOLD` from the decision. `userEditParagraph` on a Claude paragraph keeps `author='claude'` and attests `rewrite` over the new body, giving state `claude_rewritten` (a body changed by Claude invalidates it). `userAddParagraph` gives `user`.
  - Adoption applies to `claude_needs_you` and `claude_rewritten`; it is refused when the body contains `[In your own words`; it accepts `facts:[{text, answer:"saw"|"read"|"unsure"}]` and logs them (not signed).
  - Export gate: an affidavit needs every Claude paragraph `claude_adopted`; other kinds export with a `flags` list and require `?confirm=1` when flags are non-empty.
  - Sources and links API (user edits); `checks` per paragraph via `checkClaim` against its sources (stub-safe: works with `[]`).
  - Draft heading in the vault; export layout and citation conversion ("Text messages, March 2025, line 3").
  - Paste:
    - `POST /api/paste/view {text}` → `{rich, sentences:[{text:Rich, cites, checks, state}], unknown}`, logs `paste_viewed {chars, paragraphs}`
    - `POST /api/paste/copied` → logs `paste_copied`
    - `POST /api/paste/add-to-draft {draftId, text}` → splits into paragraphs, runs `tokeniseUserText`, stores them with `author='claude'`, logs `paste_added {draft, paragraphs}`, returns ids for Undo
- **API:** draft list items gain `counts{user,needsYou,rewritten,adopted}, factsToCheck, exportReady`. Draft detail paragraphs gain `{n, state, draftedByClaude, sources, relies:[{type,id,state,label}], checks, hasPlaceholder}` and `heading`, `exportCheck`. `PUT /api/drafts/:id/heading`, `PUT /api/paragraphs/:id/sources`. `PUT /api/paragraphs/:id` → `{state}` (`similarity: null` kept until wave 3).
- **Accept:** a heavy rewrite stays "Drafted by Claude — rewritten" and still blocks export until adopted. A placeholder blocks adoption. Existing attestation/kind tests are updated to the new semantics. A paste added to a draft shows as needs-you, and the log has no content.

#### W1-E: People and search
- **Owns:** `src/core/entities.ts`, `routes/entities.ts`, `routes/search.ts`, ADR 0015, entities/tokens tests plus new `people_api_test.ts`.
- **Scope:**
  - `PALETTE` (indices 0–5; hex values for the UI only); default colour on `add()` for mother, father, child_1, child_2; `setColour` refuses a taken slot.
  - `safety`; `description` validated by `tokeniseUserText` (names refused) and published through `saveRegistry`.
  - Usage counts from vault documents' `replacements`, and from chronology/issues/paragraphs by scanning `{{role`.
  - Alias impact (vault originals containing the alias; split into shared and pending).
  - `GET /api/search/all?q=` → `{total, lines:[{doc_id,line,text:Rich,docTitle}], people, chronology, issues}` with true totals.
- **API:**
  - `GET /api/entities` → `{palette:[{index,owner}], entities:[{role,kind,group,idType,forms,aliases,colour,safety,description:Rich|null,docs,mentions}]}` at the new path `/api/people` (the old route stays)
  - `PATCH /api/entities/:role` (+ `colour`, `safety`, `description`)
  - `GET /api/entities/:role/usage`
  - `GET /api/entities/:role/alias-impact?alias=`
- **Accept:** CANON totals 18/14/9 groups; spare slots `#99DDFF` and `#EEDD88` free; a description containing "Anna" is refused.

#### W1-G: Case setup, recovery and Claude Code
- **Owns:** `src/core/vault.ts`, `src/core/case.ts`, `src/app/state.ts`, new `src/app/claudecode.ts`, `routes/case.ts`, `routes/settings.ts`, `deno.json`, ADR 4/13 amendments, ADR 0017, vault/sandbox_pin tests plus new `recovery_test.ts`, `claudecode_test.ts`, `settings_api_test.ts`.
- **Scope:**
  - Keyfile v2 with an optional `recovery` wrap. The recovery key is 160-bit random, Crockford base32 in groups, PBKDF2 like the passphrase. `Vault.openWithRecovery`. Rotation requires the passphrase.
  - `case/open` accepts `recoveryKey`, under the same rate limit.
  - Idle lock from settings.
  - 5.4 confirmations; `/api/claude-code` checks (scaffold matches the generated content, web deny present, sandbox enabled, PATH stat for `casefile` and `claude`); `/restore` rewrites the scaffold and logs; `/open-terminal` on macOS only (deno.json `--allow-run=open`).
  - `GET /api/start` steps.
  - `/api/status` adds `idleLockMinutes`.
- **Accept:** a recovery key unlocks and a wrong one counts toward the lockout; a tampered `settings.json` shows `changed` and restore fixes it; the open-routes test is updated deliberately (still only `status`, `case/open`, `case/create`).

#### W1-H: To check and Court summary
- **Owns:** `src/core/summary.ts`, `routes/log.ts`, `routes/overview.ts`, ADR 0018, new `summary_test.ts`, `tocheck_test.ts`.
- **Scope:**
  - `toCheck` aggregates `docState`, WorkStates, ParaStates, issue description states and exposures; sorted by severity, then age; each item carries `{kind, id, what, detail, where:{doc?,line?,href}, actor, state, next}`.
  - `courtSummary` uses only ledger checks (`isChronologyVerified` etc.), vault exposures, settings confirmations and plan, detector settings history (log rows `settings_changed` and `document_imported.detectors`), and paste log counts. The wording is fixed in core so the UI can't overstate.
  - `/api/log/entries?what&doc&actor&from&to&offset&limit` → `{total, rows:[{…, label, category, doc}]}` with an action→label map; `/api/log/export`.
  - Codes against W0 stubs; finished after B, C and D merge (see merge order).
- **Accept:** on CANON seed data, the To-check total is 14 with group counts as in CANON, and the summary numbers match CANON's "Log / Court summary figures" section. A forged `verified_at` in public.db does not raise the counts.

#### W1-F: UI design system and shell (UI only)
- **Owns:** `src/app/ui/**` (`index.html`, `app.js`, `lib.js`, `style.css` → `base.css`, `tokens.css`, `components.css`), new `ui/shell/*`, `ui/components/*`, `ui/routes.js`, `ui/fonts/*` (IBM Plex woff2 + OFL), `ui/dev/gallery.html|js`, `src/app/server.ts` (woff2 MIME), new `scripts/seed.ts` + `scripts/seed/` loader, ADR 0020, new `tests/ui_model_test.ts`.
- **Scope:**
  - Tokens exactly as DESIGN-SPEC §1/§4. Entity classes `.ent-c0…c5` plus `.ent-ink`, `.ent-id`, underline shapes.
  - `h()` throws on a `style` attribute.
  - Components listed in 1A, plus `ui/model.js` (pure state→label/glyph maps, citation formatting, segment→DOM plan) unit-tested in Deno.
  - Router: `routes.js` maps `#/review/:id`, `#/docs`, `#/doc/:id`, `#/people[/:role]`, `#/chronology`, `#/issues[/:id]`, `#/drafts`, `#/draft/:id`, `#/to-check`, `#/log`, `#/paste`, `#/settings`, `#/start`, plus `unlock`. Each view is `views/<name>.js` exporting `default async (main, params, ctx)`, initially a **shim** re-exporting the legacy view (legacy files moved to `views/legacy/`), and `views/<name>.css` linked from index.html (empty).
  - AppHeader (count from `/api/to-check`, falling back to hidden if 404), ⌘K palette over `/api/search/all` (falls back to `/api/search`).
  - Gallery page rendering every component with CANON fixture JSON.
  - `scripts/seed.ts` builds the CANON case through core APIs and the CLI, and runs any `scripts/seed/*.ts` it finds.
- **Accept:** the gallery renders with no CSP violations in the console; the legacy screens still work through the shims; focus-visible works everywhere; text contrast meets 4.5:1 per spec tokens.

### Wave 2: UI rebuild (8 packages in parallel, after wave 1 has fully merged)
Each package **owns only** `src/app/ui/views/<its files>.js|.css`, may add `scripts/seed/<area>.ts`, and **must not edit** `components/`, `shell/`, `tokens.css`, `routes.js`, `app.js` or `lib.js`. Missing component behaviour goes in a local helper marked `// PROMOTE` for wave 3. Copy comes from DESIGN-SPEC §3/§6. Structure follows the mockup, data comes from the API, and nothing is hardcoded from CANON. Every package checks its screens in the browser against the seeded case, with keyboard-only and screen-reader name checks.

| Package | Files | Consumes | Accept (beyond matching the mockup) |
|---|---|---|---|
| W2-1 Review | `views/review.*` | B review/publish/withdraw/origin; E palette | Share disabled until every finding is decided and origin answered; "Leave as written" needs a reason; ConfirmBar + Undo; side-by-side is a `<table>` |
| W2-2 Documents + Document + Import | `views/documents.*`, `views/document.*`, `views/import.*` | B, C (`citedIn` states), H counts | Exposed panel with dates and re-check; origin change shows the impact ConfirmBar; 312-row paging is smooth |
| W2-3 People | `views/people.*` | E | Taken colour slots disabled; alias removal warns with documents + Undo; Merge hidden |
| W2-4 Chronology | `views/chronology.*` | C | "Mark as checked" disabled until source shown and both boxes ticked; Can't check explains the swap; Removed items view; Highlight-people toggle off by default; export button = "coming in wave 3" stub |
| W2-5 Issues | `views/issues.*` | C | Three stance groups; add evidence via picker; description check; Claude's note done |
| W2-6 Drafts | `views/drafts.*`, `views/draft.*` | D, C states | Four paragraph states as text badges; only one panel open; adopt panel shows full text, sources and fact checks; export gate list |
| W2-7 To check + Log + Paste | `views/tocheck.*`, `views/log.*`, `views/paste.*` | H, D paste | Summary text comes straight from the API; full log filters; paste copy warning and clipboard clear |
| W2-8 Start + Unlock + Settings | `views/start.*`, `views/unlock.*`, `views/settings.*` | G, B plan | Recovery key shown once with print; typed-phrase risky options; commercial dialog lists what could be shared |

### Wave 3: integration and polish
1. **W3-1 Export formats** (owns `src/core/export/*`, `routes/drafts.ts` export bits, `views/draft.*`/`chronology.*` export dialogs):
   - Dependency-free **RTF** writer for the affidavit (heading, numbered paragraphs, jurat) and the chronology table (checked-only or marked).
   - Annexure marks per draft, kept in the vault (initials are identifying, so never in public.db); citations converted to "annexure AT-1" / "my affidavit sworn [date], para 4".
   - Provenance report per draft (markdown).
   - Everything delivered as downloads and logged.
2. **W3-2 Accessibility and CANON QA** (no file ownership; files issues and makes fixes in view files through their owners, or sequentially). Covers every screen against DESIGN-SPEC §7 and CANON numbers, keyboard paths and shortcut off-switch.
3. **W3-3 Docs:** PLAN.md (milestones, deferred list), CONTEXT.md refresh, ADR index.
4. **W3-4 Cleanup, run last and alone:**
   - Delete `views/legacy/` and the shims.
   - Promote `// PROMOTE` helpers into components.
   - Remove deprecated API fields: `sensitivity`, `similarity`, `/api/stats`, old `/api/search` and `/api/entities` shapes.
   - Fold free-function store queries into `PublicStore`.
   - Drop the legacy-value acceptance on `origin`.

---

## 3. Deferred, with the honest UI that replaces them
| Item | Why defer | What the UI shows instead |
|---|---|---|
| PDF/OCR, .eml/.msg, photos | Needs extractor and OCR libraries plus binary originals in the vault (new ADR) | The "Not yet" list plus "select all, copy, use Paste text; keep the original outside the case folder" (already in the mockup) |
| Attaching original files as annexures | Originals are text-only in v1; binary vault storage is a format change | Annexures table lists cited documents with "attach the original yourself when filing"; marks supported (W3-1) |
| .docx / PDF export | No approved dependency; zip/docx generation is unreviewed surface | "Export for Word (.rtf)"; "to make a PDF, open it in Word and Save as PDF". Revisit `npm:docx` behind an ADR |
| Encrypted single-file backup and restore | The restore path is the risky part and needs its own ADR and tests | Settings/Start step 6: "No backup yet. While casefile is closed, copy the whole case folder to a USB drive only you use. Originals stay encrypted; the copies Claude reads have names replaced." Recovery key **is** built |
| Judge backends / Jev (ADR 14), judgement fact checks ("only says 'Fine.'"), quasi-identifier pass | Unbuilt classifier/LLM calibration | Extra checks: "Built in: names, dates and numbers, on this computer" (on). Others listed as "Not available yet". Fact checks only show deterministic rows labelled "casefile checked" |
| Merge people | L-sized token rewrite across documents, notes and drafts | Button hidden; "Rename, or add the other spelling as a nickname" hint |
| Light theme | Spec contrast is defined for dark only | Dark only (ADR 0020) |
| Hearings and deadlines, draft versions, hide-now key | Out of design scope | Nothing shown |

---

## 4. Risks and merge order

**Risks**
- **W0 is the bottleneck, and the ledger extraction is the riskiest part.** That code has epoch, revocation and race logic. Move it verbatim, keep delegates on `CaseSession`, and change no test assertion except origin values. If W0 overruns, ship it as two sequential commits (routes, schema and origin first; ledger second) but don't start wave 1 until both are in.
- **Stubs can drift from the final contracts.** H and D consume stubs owned by B and C. Contract types live in `states.ts` (W0), and tests in D and H assert their own logic only, not claimcheck details.
- **Behaviour changes users will notice.** New imports default to withheld ("Not asked yet"). Exposure auto-withdrawal can turn many checked items into "Changed since you checked" after a re-share. Both are intended; the ADR 7/8 amendments must say so.
- **Grandfathered authorship.** Paragraphs that became "user" under the similarity rule can't be told apart from paragraphs the user wrote. ADR 9's amendment must record that they are grandfathered.
- **CSP and inline styles.** Mockups are inline-styled; any `style=` attribute breaks under CSP. The `h()` guard plus the gallery console check catch this.
- **Schema v4 vs older CLI binaries.** An older CLI refuses a newer schema ("newer than this build"), so rebuild `bin/casefile` after merge.
- **`--allow-run=open` under `deno desktop`.** Packaging may need a permission change; keep open-terminal macOS-only and degrade to showing the command.
- **Exposure "Claude read" accuracy.** It is only as good as CLI logging (W1-A), and shell reads are invisible. All copy must say "through casefile".
- **Mockup content is still shifting.** Another agent is editing the mockups. UI packages take structure from the mockups and data from the API, and re-diff before merging.
- **app_test.ts churn.** Owned by B in wave 1; other packages put API tests in their own new files.

**Merge order**
1. **W0**, alone.
2. **Wave 1:** A, E, C, B, D, G, F (F is independent and can merge any time), then H last. Each merges after rebasing on the previous one and running `deno task ci`. Run the CANON seed after B, C and D are in, before merging H.
3. **Wave 2,** after all of wave 1: any order, since packages touch disjoint view files. Suggested order: 1, 2, 3, 4, 5, 6, 7, 8. After each merge, a smoke test of the seeded case in the browser.
4. **Wave 3:** W3-1 and W3-3 in parallel, then W3-2 fixes, then W3-4 cleanup last and alone.

### Critical files for implementation
- src/core/session.ts
- src/app/api.ts
- src/core/publicdb.ts
- src/core/drafting.ts
- src/app/ui/app.js