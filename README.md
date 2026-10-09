# casefile

A local desktop app that de-identifies family-law documents so Claude can help organise them and
draft from them **without seeing who anyone is**, in line with the FCFCOA _Practice Direction: Use
of Artificial Intelligence_ (PD-AI, 29 May 2026). It is built for a self-represented party in
Australian family law proceedings.

- Your original documents and the key that maps `{{mother}}` back to a real name stay in an
  encrypted vault in the case folder on your computer.
- Claude Code works through the `casefile` CLI, which can only reach the de-identified copy
  (`public.db`).
- The app shows real names, lets you check Claude's work against the cited lines, tracks who wrote
  each affidavit paragraph, and keeps an AI-use log you can summarise if the Court asks.

casefile is not legal advice. See [docs/PLAN.md](docs/PLAN.md) for what is built, what is not and
the known limitations, [CONTEXT.md](CONTEXT.md) for the vocabulary, and
[docs/adr/](docs/adr/README.md) for the decisions.

## Requirements

- Deno 2.9 or later.
- macOS is where casefile is developed and tested. Paths have Linux fallbacks, but "Open Terminal
  here" is macOS only.
- Optional: a local LLM server with an OpenAI-compatible API (Ollama, LM Studio) for an extra
  name-finding pass, and network access once to download the pinned NER model (about 110 MB).

## Run the app

```sh
deno task app
```

Then open <http://127.0.0.1:8217/> (`CASEFILE_PORT` changes the port). Create a case in a new or
empty folder (the app suggests `~/Documents/casefile/case-N`), choose a passphrase and, if you like,
make a recovery key; it is shown once. The app keeps its own settings in
`~/Library/Application Support/casefile` (`~/.config/casefile` elsewhere, or `CASEFILE_CONFIG_DIR`).

`deno desktop` packaging is not set up yet; the app runs in your browser (ADR 2).

## Use the CLI with Claude Code

```sh
deno task build:cli          # compiles bin/casefile with --deny-net
deno task cli help           # or run it from source
```

Put `bin/casefile` on your `PATH`, then start Claude Code in the case folder. casefile writes a
`CLAUDE.md` and `.claude/settings.json` there that tell Claude how to use the CLI, deny web search
and fetch, and turn on Claude Code's sandbox. The CLI finds the case from `--case DIR`,
`$CASEFILE_CASE`, or by searching up from the current folder. Rebuild `bin/casefile` after pulling
changes: an older build refuses a newer `public.db` schema.

## Try it with the example case

The seed builds the invented CANON family case (`docs/rebuild/CANON.md`; synthetic data only,
ADR 11) through the real app and CLI flows:

```sh
deno task seed --force                                         # 312 documents; --small for 40
CASEFILE_CONFIG_DIR="$TMPDIR/casefile-canon.config" deno task app
```

Open the case folder the seed prints (`$TMPDIR/casefile-canon` by default) with the passphrase
`canon seed passphrase`, a test value for this synthetic case. Options: `--dir`, `--passphrase`,
`--small`, `--force`.

## Tests

```sh
deno task test      # all tests
deno task ci        # fmt check, lint, type check, tests
```

Tests use only the synthetic fixtures in `tests/fixtures/`. Some tests run macOS `textutil` when it
is present to check the RTF export.

## Security model in brief

- **Two stores.** `vault/` holds originals, who's who, settings and every record of what you did,
  encrypted with AES-256-GCM under a key wrapped by your passphrase (PBKDF2, 600,000 iterations) and
  optionally a recovery key ([ADR 4](docs/adr/0004-vault-encryption.md)). `public.db` holds only
  what Claude may see; anything withheld is simply not written there
  ([ADR 3](docs/adr/0003-public-store-is-everything-claude-may-see.md)).
- **The CLI cannot reach the vault.** Its module graph excludes the vault, session and detectors,
  and a test checks it from `deno info`; it is compiled with `--deny-net` (ADR 3).
- **Nothing is shared until you review it.** Detection runs in layers (Australian identifier rules,
  known names, optional NER and LLM) and a leak check blocks any known value or identifier from
  being published ([ADR 6](docs/adr/0006-layered-detection-and-leak-check.md)). Documents from the
  other side, a subpoena or under an order, and documents you haven't said the origin of, are
  withheld from Claude ([ADR 7](docs/adr/0007-restricted-material-is-withheld.md)). If you later add
  a nickname that a shared document shows, it is withdrawn at once and recorded as an exposure.
- **Your checks are signed.** Checks of Claude's work, adoptions of Claude's paragraphs and your
  removals are HMAC-signed and kept in a vault ledger; public.db flags Claude could write are never
  trusted, and the AI-use log is hash-chained ([ADR 8](docs/adr/0008-verification-signatures.md),
  [ADR 9](docs/adr/0009-affidavit-authorship.md)). The To-check queue and the Court summary use only
  those records ([ADR 18](docs/adr/0018-to-check-queue-and-court-summary-from-signed-records.md)).
- **Local detectors by default.** The LLM pass refuses remote endpoints, including Ollama `:cloud`
  models served from localhost, unless you allow it; the NER model is pinned by hash
  ([ADR 12](docs/adr/0012-llm-endpoint-and-ner.md)).
- **A locked-down local API.** 127.0.0.1 only, a session cookie, rate-limited passphrase attempts,
  Host and Origin checks, a strict CSP, idle lock, and exports delivered as downloads, never written
  into the case folder ([ADR 13](docs/adr/0013-local-api-security.md)).

The limits matter as much: casefile cannot see what Claude Code does outside the CLI (shell reads
are not logged), and the sandbox settings it writes are honoured by Claude Code, not enforced by
casefile. [docs/PLAN.md](docs/PLAN.md) lists the known limitations and remaining risks.
