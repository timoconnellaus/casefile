# casefile — development notes

Local desktop app + Claude-facing CLI that de-identifies family-law documents and organises them.
Read `docs/PLAN.md`, `CONTEXT.md` and `docs/adr/` before changing behaviour.

## Hard rules

- **Never open, paste or commit real case documents.** Use `tests/fixtures/synthetic.ts` (ADR 11).
- **The CLI (`src/cli/`) must not import** `vault.ts`, `session.ts`, `signing.ts`, `entities.ts`,
  `tokenise.ts`, `drafting.ts`, `detect/` or `src/app/`. `tests/boundary_test.ts` enforces this (ADR
  3).
- Anything that should be hidden from Claude must not be written to `public.db` at all (ADR 3, 7).
- Every write of document text to public.db goes through `CaseSession.publishedView` (via
  `publish`/`republish`), which runs the leak check (ADR 6).
- **The main checkout is the copy in daily use**, run with `deno task app` (ADR 22). Work in a
  worktree and try changes with `deno task dev`. Never run `deno task app` yourself, and never stop
  the process on port 8217. Ship changes as described in "Shipping a change to the user" below.
- Decisions that change the safety boundary, data formats or compliance behaviour need an ADR.

## Commands

```sh
deno task test       # all tests
deno task ci         # fmt check, lint, type check, tests
deno task cli help   # run the Claude-facing CLI from source
deno task build:cli  # compile bin/casefile (--deny-net)
deno task app        # the user's copy, at http://127.0.0.1:8217 (main checkout; the user runs it)
deno task seed:dev   # build the CANON case in .dev/canon for deno task dev
deno task dev        # a development copy at http://127.0.0.1:8218; opens cases only in .dev/
deno task release    # main checkout: ci, backup, CLI, tag, restart the user's app (ADR 22)
deno task desktop    # package dist/casefile.app with `deno desktop`
deno task seed --force   # build the synthetic CANON case (see scripts/seed.ts)
scripts/cloud-setup.sh   # setup script for a Claude Code cloud environment (paste into its config; keep it current)
```

## Shipping a change to the user

When a change is finished and the user wants it in their app, do all of this without asking how:

1. In your worktree: bring the branch up to date with `main` and make `deno task ci` pass. Try the
   change with `deno task seed:dev` (once) and `deno task dev` (port 8218, `.dev/` cases only), with
   synthetic data only.
2. If the public.db schema changed: bump `SCHEMA_VERSION`, add a migration, then run
   `UPDATE_SCHEMA_FIXTURE=1 deno task test tests/schema_fixtures_test.ts` and commit
   `tests/fixtures/schemas/`. Never edit an older `vN.sql`.
3. Merge in the main checkout:
   `git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." merge --no-ff <branch> -m "Merge v3 <topic>: <what>"`.
   The main checkout must be on `main` with nothing uncommitted. Another session may have merged
   since you last looked: re-run ci if `main` moved.
4. Release, from the main checkout: `deno task release`. It runs ci, backs up the case into the
   app's own folder (Claude Code can't read it), installs the CLI to `~/.local/bin`, tags
   `use-YYYY-MM-DD-N`, then restarts the running app into the release. The case stays open and the
   browser stays signed in. No need to ask the user to quit anything.
5. Tell the user it's live and to click **Reload** on the banner the page shows. Pass on any `!`
   lines the release printed. If it says the generated CLAUDE.md or settings changed, they restore
   them in Settings → Claude Code in this folder.

If the release says the case is open in another casefile, or `deno task app` isn't running, it still
releases. Tell the user to start it with `deno task app` in the main checkout. `--desktop` also
rebuilds `dist/casefile.app`; the user doesn't use it day to day. Going back to an earlier release
is in `docs/PLAN.md` ("Using it while it is being built").

## Layout

- `src/core/` — tokens, entities, detection (`detect/`), tokenising, vault, public store, session,
  ledger, checking (`claimcheck.ts`, `checking.ts`), sharing (`origin.ts`, `exposure.ts`), people,
  drafting, To-check and Court summary (`summary.ts`), exports (`export/`)
- `src/core/states.ts` — the state vocabulary (types only; the CLI may import it)
- `src/cli/` — the `casefile` CLI (public store only)
- `src/app/` — the app: `server.ts`, `state.ts`, API route modules in `routes/`
- `src/app/ui/` — framework-free UI: `routes.js` (hash → view), `views/`, `components/`, `shell/`,
  `model.js` (the only state → words mapping). A helper two screens need goes in `components/` (or
  `model.js` if pure), not in a view
- `scripts/seed.ts`, `scripts/seed/` — the CANON example case
- `tests/` — Deno tests; `tests/fixtures/synthetic.ts` and `tests/fixtures/canon.ts` hold the
  invented test families; `tests/helpers/app.ts` has the API test helpers
- `docs/PLAN.md` (what is built and the limits), `docs/adr/README.md` (ADR index), `docs/rebuild/`
  (the v2 rebuild plan, design spec, CANON case and status)
