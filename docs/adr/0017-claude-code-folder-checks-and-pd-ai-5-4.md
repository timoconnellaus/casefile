# 17. Claude Code folder checks and PD-AI 5.4 confirmations

Date: 2026-10-07
Status: Accepted

## Context

PD-AI 5.4 asks court users to "disable the chat history and web search access in GenAI Chatbots
if this option is available". casefile generates `.claude/settings.json` (ADR 3) denying Claude
Code's web tools and asking for its sandbox, but nothing told the user whether those settings were
still in place, and casefile cannot see the user's Claude account at all. The design review asked
for status rows with a real check behind them, a "changed" state with a way back, a first-run
checklist, and dated confirmations the 4.11 summary can quote.

## Decision

- **What casefile checks** (`checkScaffold` in `core/case.ts`, `GET /api/claude-code`):
  - `.claude/settings.json` and `CLAUDE.md` compared **byte for byte** with what this build
    writes: `ok`, `changed` or `missing`. They are not parsed: Claude Code's parser may read the
    same bytes differently from `JSON.parse` (duplicate keys, a BOM, comments), so only the exact
    bytes casefile wrote count as unchanged. Reformatting the file therefore shows as changed.
  - `webBlocked` and `sandbox` are true only when `settings.json` is exactly as generated (which
    denies both web tools and asks for the strict sandbox) and `settings.local.json` doesn't
    override them.
  - `.claude/settings.local.json`, which Claude Code merges over the project file: any key but
    `permissions`, any permission key but allow/ask/deny, and allow/ask rules naming the web
    tools, artifacts, the vault or the app's folders are listed as `localOverrides`. Ordinary
    "don't ask again" rules Claude Code writes there are fine. It is only interpreted when it is at
    most 64 KB, nested at most 8 deep, and its bytes are exactly what `JSON.stringify` writes for
    the value it parses to (2-space or compact): that rules out duplicate keys, a BOM and
    comments. Otherwise it is reported as unreadable, which counts as changed.
  - Symbolic links among these files (or a linked `.claude`) are reported as changed and never
    read through.
  - `claude` and `casefile` found on the PATH or in usual install folders (stat only).
  The overall `state` is `changed` when any of the files differs, is missing, is a link, or is
  overridden.
- **Restore** (`POST /api/claude-code/restore`) rewrites the generated files without following
  links (ADR 13 amendment) and renames an overriding `settings.local.json` to
  `settings.local.json.disabled-<time>` (kept, not deleted). It is logged as
  `claude_settings_restored` with the file names only.
- **Open Terminal here** on macOS only (ADR 13 amendment).
- **PD-AI 5.4 confirmations.** The user confirms "Help improve Claude is off" and "chat history
  is set the way I want for this case". Each is stored with its date in the vault settings
  (`confirmations.helpImproveOff`, `confirmations.chatHistory`), can be confirmed again or
  withdrawn, and is logged (`pd_ai_confirmed` / `pd_ai_confirmation_withdrawn`, item names only).
  The web-search part of 5.4 for Claude Code is the folder check above, not a confirmation.
- **Getting started** (`GET /api/start`) derives each step from records: plan recorded plus both
  confirmations plus the web block; Claude Code found; documents imported (vault); documents
  reviewed (vault, shared vs withheld); "I've opened Claude Code here", which only the user can
  know, kept in the vault file `start`; backup is listed as not available yet.

## Consequences

- The status rows only claim what casefile checked: the files in the case folder. Claude Code's
  user-level and managed settings, `.mcp.json`, agents and hooks elsewhere are outside casefile's
  view, and the UI must not say otherwise (DESIGN-SPEC §8).
- Because the case is reopened with a fresh scaffold, a tampered file is normally caught at the
  next open as well; the check covers the time in between.
- Confirmations are the user's statement, recorded; casefile cannot verify them. They live in the
  vault (Claude cannot write them) and the log, which is what the Court summary (ADR 18) reads.
