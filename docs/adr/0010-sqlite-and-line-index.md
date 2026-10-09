# 10. SQLite with a per-line full-text index

Date: 2026-10-07
Status: Accepted

## Context

Claude needs search results it can cite precisely.

## Decision

`public.db` uses Deno's built-in `node:sqlite` in WAL mode. Each document is also stored as one row
per line in `lines`, with an external-content FTS5 index (`unicode61`). Search returns
`doc_id:line` plus a snippet. User queries are quoted word by word, so FTS syntax in a query cannot
cause errors. Schema changes go through `PRAGMA user_version` migrations.

## Consequences

Search results are citations. Storage roughly doubles the text size, which is negligible for
document sets of this size.
