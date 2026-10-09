# 3. The public store is everything Claude may see

Date: 2026-10-07
Status: Accepted

## Context

Claude Code drives the `casefile` CLI. Anything the CLI prints goes into a transcript sent to
Anthropic. If the CLI *could* print original text, one wrong command would leak it, and a CLI
"refusal" can be bypassed because Claude Code also has a shell. The guarantee has to be
structural, not a matter of discipline.

## Decision

A case folder has two stores with different trust levels:

| Store | Contents | Who can open it |
|---|---|---|
| `vault/` | originals, token key (entity registry), settings, LLM API key | desktop app only, with the passphrase (ADR 4) |
| `public.db` | tokenised text and all organisation data | app and CLI, and anything else on the machine |

Rules:

1. **`public.db` contains only what Claude may see.** Anything withheld from Claude is simply not
   published there (ADR 7). We never rely on the CLI refusing to show something that is present.
2. Only the app's `CaseSession` moves information from the vault to `public.db` ("publishing"),
   and every publish passes the leak check (ADR 6).
3. The CLI's module graph must not include the vault, session, signing, registry, detectors or app
   code. `tests/boundary_test.ts` enforces this from `deno info`.
4. Each case folder gets a generated `CLAUDE.md` and `.claude/settings.json` that turn on
   Claude Code's **sandbox** for its commands. The sandbox is the protection; the file's
   `permissions.deny` rules (`vault/`, `sqlite3`, the app's config and model folders) are only
   defence in depth and are **not** relied on: they match Claude Code's tools and the literal
   commands they name, so any other program (`python3 -c 'import sqlite3…'`, `cat`, `cp`) gets
   round them. Sandbox settings (`src/core/case.ts` `CLAUDE_SETTINGS`; keys as
   documented at https://code.claude.com/docs/en/sandboxing and
   https://code.claude.com/docs/en/settings-reference): `sandbox.enabled: true`,
   `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `filesystem.denyRead` and
   `denyWrite` for `./vault` and the app folders, and `network.allowLocalBinding: false`. With it,
   Claude's commands can write only inside the case folder (and temp), cannot read the vault or
   app folders, and on macOS cannot listen on a port or connect to localhost. Outbound hosts are
   not pre-allowed; each goes through Claude Code's network prompt (a project file cannot make
   that a hard refusal: `network.strictAllowlist` is user/managed only). These settings are
   defence in depth: they are honoured by Claude Code, not enforced by casefile, and the user (or
   managed settings) can override them.

   **Web tools (PD-AI para 5.4).** PD-AI 5.4 asks users to "disable the chat history and web
   search access in GenAI Chatbots if this option is available". `permissions.deny` therefore also
   lists `WebSearch` and `WebFetch`, and `Artifact` (publishing a page to claude.ai), with
   `enableArtifact: false`. Tool names are from https://code.claude.com/docs/en/tools-reference;
   per https://code.claude.com/docs/en/permissions ("Match all uses of a tool", "Allow or deny
   every fetch"), a bare tool name in `deny` removes the tool from Claude's context entirely, and
   `WebSearch` takes no specifier. `enableArtifact` and the `Artifact` rule are documented at
   https://code.claude.com/docs/en/artifacts#disable-artifacts. A bare `WebFetch` deny does not
   change which hosts sandboxed commands can reach (`curl` still goes through the network prompt);
   `WebFetch(domain:*)` in `deny` would also refuse every host to sandboxed commands, but is not
   used, since it changes the network posture above. The generated `CLAUDE.md` tells Claude not to
   search the web or fetch URLs about the case by any means, not to publish case content, and not
   to save case content to files outside the CLI. Chat history (where Claude Code keeps
   transcripts) is not a case-folder setting and is not covered by this change; the design review
   tracks it with recording the user's settings in the log.
5. Exports with real names are delivered to the user as downloads, never written into the case
   folder.
6. Metadata that is never reviewed must not be published raw: the original file name stays in the
   vault, and the title goes through the full detectors as well as the leak check. "Full
   detectors" means whatever is configured: with the default settings (no NER, no LLM) that is
   the identifier rules and the names already in the case, so a new name that appears only in a
   title is *not* caught automatically; the app warns when no name detector is on (ADR 6). A
   detector that fails while checking a title blocks publishing.
7. Role names are public, so a role may not contain any word of any entity's value
   (`EntityRegistry.revealingWords`). A detector's suggestion that does is replaced with a
   neutral `kind_N` role; a user rename that does is refused.
8. The CLI may only change or remove what Claude wrote (chronology, issues, evidence, tags,
   paragraphs, and document details the user has not set), and only while the user has not
   verified or adopted it (design review, 2026-10-07): a chronology entry, issue or evidence link
   with `verified_at` set, or a paragraph with `adopted_at` set, is refused with a pointer to
   `casefile note add --on …`. `issue rm` is also refused while the issue has any evidence that is
   the user's or verified, since removing an issue removes its evidence. For the user's items it
   can leave notes. These checks read public.db, so they only limit Claude; going round them with
   SQL is detected by the app (ADR 8, "Deleted attested items").
9. Withdrawn text must not linger: `public.db` runs with `secure_delete`, and after text is
   withheld or deleted the FTS index is optimised and the WAL checkpointed and truncated.

Rules 6–9 were added after a security review of milestone 1 (tests/security_test.ts).

## Consequences

**What is and is not guaranteed** (security review, 2026-10-07). The guarantee for originals is:
they are encrypted at rest in the vault (ADR 4), and the app never sends them anywhere except to a
detector endpoint the user configured (ADR 12). It is *not* a guarantee against a process running
as the same user with a shell. If Claude Code runs **unsandboxed** it can, for example, stop Ollama
and answer on `localhost:11434` itself, so that the LLM detector sends it original text; replace
the NER model files (now caught by pinning, ADR 12); rewrite or delete anything in public.db
(caught where it matters by the vault ledger, reconciliation and the log chain, ADR 8); or delete
vault files (denial of service). With the generated sandbox settings those routes are closed for
the commands Claude runs, but only as far as Claude Code honours them. So when Claude Code runs
without the sandbox, use **NER only** (in-process) for name detection, not an LLM endpoint.

The CLI can be run by Claude with full filesystem access without risk to originals. Entity *roles
and kinds* (e.g. `mother`, person) are public; their values are not. Text the user types in the app
(notes, drafts) is tokenised before it is stored (`tokeniseUserText`). Known values become tokens;
the text is then run through the full detectors, as titles are at publish, and anything they find
outside a token (e.g. a new name not yet in the registry) is refused until the user adds it as an
entity or uses a token.

**Probing through user edits** (security review, 2026-10-07). Tokenising user text is itself an
oracle: if Claude writes guesses ("Sarah Anna Jessica Priya Mia") into a paragraph and the user
lightly edits it, the stored result ("Sarah {{mother.first}} Jessica Priya {{child_1.first}}") tells
Claude which guesses were real. So when user text replaces text Claude wrote or last changed
(an edit of a Claude paragraph, a document detail Claude set, a Claude chronology entry, a draft
title), `tokeniseUserText(text, { replacing })` refuses (`ProbeError`) while the new text still names
any entity that Claude's text named as plain text. The user is told why and asked to remove the
value or type a token. The document-details form saves only fields the user actually changed
(compared with what was shown, or an explicit `changed` list), so a field the user merely saw is
never re-tokenised.

- **Nothing Claude can observe depends on whether a guess was right.** Every check runs before
  anything is written, so a refused edit leaves public.db byte for byte as it was (no text,
  `updated_at`, counter, rowid or log row; the `paragraph_edited` entry is absent exactly as for
  any other refusal). Claude can also `stat` the vault's files, so the record of the check must
  not appear only on a probe: *every* save that may replace Claude-written text (paragraph edits
  of Claude's paragraphs, document details, chronology edits, draft renames) appends exactly one
  fixed-shape record `{ ts, probe: 0|1, target }` to the vault file `edit-checks`, whether it was
  refused, accepted or changed nothing (`recordEditCheck`, `guardedSave` in api.ts). The file's
  size and mtime therefore move the same way for a probe, an ordinary refusal (e.g. a phone
  number) and a no-op save (tests/app_test.ts compares all three). The user sees the probes via
  `GET /api/security-log`. (Earlier versions logged `possible_probe` in the AI-use log, then wrote
  a vault file only on probes; both were oracles and were replaced.) The checks run in the same
  order on every path; the remaining timing difference (a probe is refused before the detectors
  run) is not observable from the case folder, only to the API caller, who needs the cookie.
- **One matcher.** The guard finds known values with `knownMatches` (tokenise.ts), the same
  function `tokeniseKnown` uses to decide what to replace, on the same folded text (NFKC,
  apostrophes, whitespace runs, case, plurals; fold.ts, ADR 6). A form the guard missed but
  tokenising replaced would reopen the oracle, so they must never differ (tests/probe_test.ts
  checks each variant form).

Residual: whatever the user finally saves is, by definition, visible to Claude. If the user keeps
retyping until the edit is accepted, the final text says which names they removed. The defence
turns a silent per-name oracle into a refusal the user sees and can recognise as probing.
