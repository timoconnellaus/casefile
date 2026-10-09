# 11. Synthetic test data only

Date: 2026-10-07
Status: Accepted

## Context

Development happens in Claude Code sessions. Any file a session reads is sent to Anthropic.

## Decision

Tests and fixtures use invented people, places and checksum-valid but fake identifiers
(`tests/fixtures/synthetic.ts`). Real case documents are never added to the repository or opened
in a development session. `.gitignore` excludes case folders and databases.

## Consequences

The key safety tests (nothing secret in Claude-visible files, exact re-identification) run against
a realistic synthetic family and can run anywhere.
