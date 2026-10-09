# v2 rebuild — status

What has been merged to `main` for the rebuild in [REBUILD-PLAN.md](REBUILD-PLAN.md), wave by
wave, in merge order. Commit ids are the merge commits on `main`. What is built overall, what is
deferred and the known limitations are in [../PLAN.md](../PLAN.md).

## Before the rebuild

The original milestones and reviews, all merged before wave 0:

| Merge | What |
|---|---|
| `3860a66` | Milestone 1: core library and CLI |
| `c38ee79` | Security review fixes (milestone 1) |
| `00f039f` | Milestone 5 core: drafting rules |
| `694fcad` | Milestone 2: NER and LLM detection |
| `931818a` | LLM endpoint security fixes |
| `49c61cd`, `09f3aca` | Attestation ledger, user-text detection and ledger security fixes |
| `f43f4bc` | The desktop app (milestones 3–5) |
| `24dbf61`, `1cfd206` | Passphrase rate-limit hardening; security hardening from the independent review |
| `e6e4c42`, `254fbbd`, `66b1da9` | NER model pin; verified bytes are the bytes loaded; model path validation |
| `a69128b` | Flaky-test fix and graceful close |
| `186c951`, `009588b` | Design review documents; fixes for bugs it found |
| `80faabb` | ADR 14 (Jev), decision only |

## Wave 0: seams and contracts

| Merge | Package | What |
|---|---|---|
| `e3dab49` | W0 | API split into `src/app/routes/*`; ledger extracted to `src/core/ledger.ts`; public.db schema v4 (`withheld_reason`, `entities.description`, notes done, `removed_at`, `paragraph_sources`, `paragraph_links`); origin replaces sensitivity; segments; the state vocabulary in `src/core/states.ts`; stubs; `tests/helpers/app.ts` and `tests/fixtures/canon.ts`; new glossary terms. Also the rebuild plan, design spec and CANON case. |

## Wave 1: foundations

| Merge | Package | What |
|---|---|---|
| `4c49137` | W1-A Store and CLI | Paragraph `--source` / `--relies`, logged reads (lines, hits, cited ranges), removed rows hidden and gated, plain withheld reasons, new guide rules. ADR 16. |
| `f8e3486` | W1-F UI design system | Tokens, components, AppHeader, router, gallery, bundled IBM Plex, first `scripts/seed.ts`, UI model tests. ADR 20. |
| `41cd301` | W1-E People and search | Colour slots, safety flag, relationship description, usage, nickname impact, `/api/search/all`. ADR 15. |
| `fddd9e7` | W1-A security fixes | CLI log gaps and gate-parity holes. |
| `3da028a` | W1-E security fix | An entity change is checked as a whole before anything is written (ADR 15 amendment). |
| `2d81fd9` | W1-D Drafting, authorship and paste | No similarity; `rewrite` attestation; placeholder gate; heading in the vault; export flags; paste view, copy and add-to-draft. ADR 9 amendment, ADR 19. |
| `612bc4d` | W1-E fixes | Every name word is identifying; entity changes serialised (ADR 15 amendment 2). |
| `95527c1` | W1-G Case setup | Recovery key (keyfile v2), idle-lock setting, Claude Code folder checks and restore (no following links), Open Terminal, PD-AI 5.4 confirmations, `/api/start`. ADR 4 and 13 amendments, ADR 17. |
| `e3799b9` | W1-C Checking | `claimcheck`, four work states, lapsed checks, two-part check, Can't check enforced in the ledger, user-recorded removals and notes done. ADR 8 amendment. |
| `be6b5ba` | W1-B Sharing | Origin and "Not asked yet", commercial plan conditions, withdraw/reopen/recheck, exposures (fail closed), entity lock covering publish. ADR 6 and 7 amendments. |
| `6d87f71` | W1-H To check and Court summary | Queue, Court summary and readable log from signed records, per-row seal check. ADR 18. |

## Wave 2: UI rebuild

| Merge | Package | What |
|---|---|---|
| `bb7175c` | W2-0 Seed | The seed builds the full CANON case through the wave 1 flows. |
| `8e92d4c` | W2-5 | Issues & evidence screen |
| `0254e59` | W2-3 | People & places screen |
| `747352d` | W2-4 | Chronology screen |
| `d806505` | W2-7 | To check, AI-use log and Paste screens |
| `56a10f7` | W2-8 | Getting started, Unlock and Settings screens |
| `966e9e9` | W2-6 | Drafts list and affidavit draft screens |
| `3d46cb4` | W2-1 | Review screen (Share with Claude) |
| `df90445` | W2-2 | Documents, Document and Import screens |

The wave 2 packages collected API gaps and `// PROMOTE` helpers in `W3-GAPS.md` (kept outside the
repo, next to the worktrees). Wave 3 added three API packages to close them before W3-1.

## Wave 3: integration and polish

| Merge | Package | What |
|---|---|---|
| `b0ed542` | v3 check-api | One server path that re-identifies check rows; facts split by core and matched at adoption; sources with ±2 context lines; 409 codes `stale` and `cant_check`; issue and evidence edits; per-issue chronology count; `usedIn` paragraph numbers; own-statement flag from the vault's `document-authors`; paste paragraphs and safety warning; screens use the server's check data. ADR 8, 9 and 19 amendments. |
| `bc53611` | v3 docs-api | Title preview and publish dry run; Undo share keeps decisions; import batches and review queues; details kept while an origin change withholds; exposure triggers and new matches; cited-in items with states; document author control; `logForDoc` reads sources/source/on. ADR 7 amendment. |
| `7126089` | v3 misc-api | Labels for every logged action and a source scan test; Court summary copy logged; per-port session cookie; `/api/status` idle minutes while locked and next free case folder; plain check-llm copy; `relatedTo` person→detail link and `GET /api/entities/:role`; safety follows the link on publish, exposure, review and paste; vetted external links via `/api/open-link`; shell brand, favicon and setters; promoted components. ADR 15 amendment 3. |
| `ac387e9` | W3-1 Export | RTF writer; affidavit and draft export in Markdown, text and RTF; chronology RTF table; vault-only annexure marks; provenance report; safety confirmation for protected addresses. ADR 21. |
| `7e92b88` | W3-3 Docs | `docs/PLAN.md`, `CONTEXT.md`, `README.md`, `docs/adr/README.md` and this file. |
| `fd0f375` | v3 expfix | Exposure-check log rows are counts only; which documents matched or failed stays in the vault. |
| `b768ff0` | v3 loghead | Root cause of the corrupt log head (a session still open on a case folder that was then made again wrote its head into the new vault): vault writes check the folder is still the one they opened, fsync, locking waits for queued writes, and a lost or damaged head is set aside and reported instead of stopping the case opening. ADR 8 amendment. |
| `428da8b` | v3 loghead2 | Never re-seal over a changed log tail; log problems recorded append-only; `log_head_lost` label. ADR 8 amendment. |
| `3c2acc6` | v3 integrate | Export safety via who's who (`isSafetySensitive`, person→detail link); every vault role reference (document authors, affidavit headings, `userRole`, exposures) follows renames and removals; details kept on plan switch and exposure withdrawal; free store queries folded into `PublicStore` and `drafting.exportDraft` into `export/draft.ts`; screens use the shared components. ADR 13 amendment. |
| `a8881bc` | W3-2 Accessibility and CANON QA | The QA survey of all 14 screens (`QA-REPORT.md`, outside the repo) and every finding fixed: ⌘K search, focus and announcements, target sizes, narrow layouts, CANON dates in the seed, export safety failing closed with label fallback and link suggestions. ADR 15 amendment 4, ADR 21 amendment 1. |
| — | W3-4 Cleanup | Branch `v3/cleanup`, ready to merge. Deleted `views/legacy/`, `legacy.css`, the `#/search` page, the `#/entities` and `#/reidentify` redirects, the shell's `legacy` handling, the palette's `/api/search` fallback and `apiOptional`. Removed `/api/stats`, the array `/api/search`, the `/api/entities` list (screens use `/api/people`), `/api/reidentify`, `/api/settings/claude-setup`, `/api/docs/:id/sensitivity`, the `sensitivity` fields, `similarity`, the paragraph `status` and `paragraphStatus`, and the "no reason asked" ignore fallback. `parseOrigin` takes origins only; stored pre-v4 documents still read. `// PROMOTE` helpers promoted. `deno task desktop` added. ADR 7 amendment. |

**Waves 0–3 are complete.** With `v3/cleanup` merged, `deno task ci` passes (527 tests passed, 3
ignored); the compiled CLI and a browser survey of all 14 screens on a freshly seeded CANON case
were clean (no console errors, CANON numbers unchanged). Open decisions and known limitations are
in [../PLAN.md](../PLAN.md) ("Open decisions for the user", "Known gaps").
