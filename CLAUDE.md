# casefile — development notes

Local desktop app + Claude-facing CLI that de-identifies family-law documents and organises them.
Read `docs/PLAN.md`, `CONTEXT.md` and `docs/adr/` before changing behaviour.

## Hard rules

- **Never open, paste or commit real case documents.** Use `tests/fixtures/synthetic.ts` (ADR 11).
- **The CLI (`src/cli/`) must not import** `vault.ts`, `session.ts`, `signing.ts`, `entities.ts`,
  `tokenise.ts`, `drafting.ts`, `pdf.ts`, `detect/`, `judge/` or `src/app/`.
  `tests/boundary_test.ts` enforces this (ADR 3).
- Anything that should be hidden from Claude must not be written to `public.db` at all (ADR 3, 7).
- Every write of document text to public.db goes through `CaseSession.publishedView` (via
  `publish`/`republish`), which runs the leak check (ADR 6).
- **The user runs the desktop app** installed from this repo's GitHub releases
  (`~/Applications/casefile.app`), which updates itself (ADR 24). Work in a worktree and try changes
  with `deno task dev`. Never open the user's case, and never quit their app. Ship changes as
  described in "Shipping a change to the user" below.
- Decisions that change the safety boundary, data formats or compliance behaviour need an ADR.

## Commands

```sh
deno task test       # all tests
deno task ci         # fmt check, lint, type check, tests
deno task cli help   # run the Claude-facing CLI from source
deno task build:cli  # compile bin/casefile (--deny-net)
deno task seed:dev   # build the CANON case in .dev/canon for deno task dev
deno task dev        # a development copy at http://127.0.0.1:8218; opens cases only in .dev/
deno task app        # the app in a browser at http://127.0.0.1:8217 (fallback; not the user's copy)
deno task browsercheck   # every screen in headless Chromium on a fresh CANON case (own port; not in ci)
deno task desktop    # build dist/casefile.app (Apple silicon, Deno >= 2.9.5; CI does this for releases)
deno task seed --force   # build the synthetic CANON case (see scripts/seed.ts)
scripts/cloud-setup.sh   # setup script for a Claude Code cloud environment (paste into its config; keep it current)
```

## Shipping a change to the user

The repo is public (github.com/timoconnellaus/casefile). The private history before it is kept
locally as the tag `archive/pre-public`: never merge, rebase onto or push anything containing it (a
local pre-push hook refuses), and never push `use-*` tags. Releases (`vX.Y.Z`) are made by CI.

When a change is finished and the user wants it in their app, do all of this without asking how
(details and the one-time setup are in `docs/RELEASING.md`):

1. In your worktree, on a branch from `origin/main` (`git fetch origin` first): bring it up to date
   with `origin/main` and make `deno task ci` pass. Try the change with `deno task seed:dev` (once)
   and `deno task dev` (port 8218, `.dev/` cases only), with synthetic data only.
2. If the public.db schema changed: bump `SCHEMA_VERSION`, add a migration, then run
   `UPDATE_SCHEMA_FIXTURE=1 deno task test tests/schema_fixtures_test.ts` and commit
   `tests/fixtures/schemas/`. Never edit an older `vN.sql`.
3. Push and open a pull request: `git push -u origin <branch>`, then `gh pr create --fill`. GitHub
   runs `deno task ci` on it. It is merged on GitHub once green, by the user or by
   `/loop /babysitter`. Don't merge into the local `main` by hand.
4. Merging releases it: every push to `main` that changes the app runs the `release` workflow, which
   works out the next version (PATCH; put `[minor]` or `[major]` in the PR title for more), builds,
   smoke-tests, makes update patches, signs and publishes. Don't tag by hand. A PR that only changes
   docs doesn't release.
5. Tell the user it's on its way: within an hour of the release (or at the next launch) casefile
   shows "casefile X.Y.Z is ready" — click **Restart to update** and enter the passphrase. If the
   `release` environment requires approval, they approve it first (Actions → release → Review
   deployments). The new version backs the case up before it opens it, and installs its CLI. If the
   generated CLAUDE.md or settings changed, they restore them in Settings → Claude Code in this
   folder.

If `src/app/update_config.ts` still has `UPDATE_REPO` or `UPDATE_PUBLIC_KEY` null, the one-time
setup in `docs/RELEASING.md` hasn't been done: do that with the user first.

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
