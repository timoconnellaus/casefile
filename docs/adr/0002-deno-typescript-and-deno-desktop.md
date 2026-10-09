# 2. Deno, TypeScript and `deno desktop`

Date: 2026-10-07
Status: Accepted

## Context

The user wants a native desktop app and chose `deno desktop` (Deno 2.9, June 2026; still marked
experimental). It compiles a `Deno.serve()` app plus the OS webview into one binary. Presidio and
spaCy, the strongest free PII tools, are Python and cannot run in-process.

## Decision

- Everything is TypeScript on Deno 2.9+. No Python.
- The app is an ordinary `Deno.serve()` HTTP app with a framework-free HTML/JS UI, so it runs
  unchanged in a browser (`deno task app`) if desktop packaging misbehaves.
- Name detection uses our own Australian rules plus transformers.js (ONNX, offline) and an
  optional OpenAI-compatible LLM (ADR 6).
- The Claude-facing CLI is a separate entry point compiled with `deno compile --deny-net`.
- SQLite comes from Deno's built-in `node:sqlite` (FTS5 included). No native add-ons.

## Consequences

One language and runtime; a single binary for the app. We own the Australian identifier rules and
must test them well. If `deno desktop` changes incompatibly, the browser fallback keeps the app
usable.
