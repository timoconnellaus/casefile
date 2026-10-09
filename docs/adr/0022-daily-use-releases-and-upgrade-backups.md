# 22. Daily use while in development: releases, upgrade backups, a fenced dev copy

Date: 2026-10-09
Status: Accepted. The release script (`deno task release`) and the restart amendment are superseded by ADR 24; the dev copy, upgrade backup and frozen schemas stand.

## Context

casefile is meant to be usable on a real case while it is still being worked on. Three things
could then go wrong:

- **A build being worked on opens the real case.** Opening repairs public.db against the vault
  and migrates public.db forward. There was one config folder, so a development run started with
  the real case as its last case.
- **An upgrade can't be undone.** public.db migrations only go forward, and a build refuses a
  schema newer than its own. After a bad release, nothing would take the case back.
- **The running app changes under the user.** The app served its UI from disk on each request,
  so merging into the checkout it runs from would change the screens before the server restarted.

The app and the CLI must also come from the same commit: Claude Code runs `casefile` from the
PATH, and the CLI reads and writes the same public.db.

## Decision

**Two copies.** The main checkout, on `main`, is the copy in daily use: the desktop app it builds
(`dist/casefile.app`) or `deno task app` on port 8217, with the default config folder. Work happens in worktrees. `deno task dev` runs a development
copy on port 8218 with its config in `.dev/canon.config`. It sets `CASEFILE_DEV_CASES=.dev`, and
`AppState` (`caseRoot`) then refuses to create, open or recover a case outside `.dev/`. It
suggests new cases there too. `deno task seed:dev` builds the CANON case in `.dev/canon`. A
development copy is marked "dev" in the header and "[dev]" in the window title.

**The UI is read once.** The copy in daily use reads every UI file at start
(`snapshotUi`), so a merge into its checkout changes nothing until it restarts. A development
copy still reads from disk, so a reload shows a UI change.

**`deno task release`** (`scripts/release.ts`), from the main checkout only:

1. It refuses unless it is on `main` with nothing uncommitted, apart from the build output in
   `bin/` and `dist/`. It also refuses while the app has the case open, and unless
   `deno task ci` passes.
2. It backs up the last-opened case (or each `--case`) while holding the case lock. The backup
   holds the whole folder except the lock file and any symbolic links. public.db is copied with
   SQLite's online backup, so a CLI writing at the same time can't tear it.
3. It builds the CLI and installs it to `~/.local/bin/casefile`.
4. It writes `release.json`, which is gitignored, and rebuilds the desktop app
   (`dist/casefile.app`) with that file inside. It refuses while the desktop app is running. The
   app shows the release in Settings.
5. It tags the commit `use-YYYY-MM-DD-N`. The script then says whether the public.db schema changed and
   whether the generated `CLAUDE.md` or `settings.json` changed (a hash is kept in
   `release.json`). After a change to those files, the case folder shows "changed" until the user
   restores the files in Settings (ADR 17).

**Backups go in the app's own folder** (`<config>/backups/<case>/<time>-before-<release>/`),
not next to the case. A backed-up public.db still holds documents that were withdrawn or
withheld after the backup (exposures, Undo share, origin changes). Claude Code's sandbox can
read folders next to the case folder, but it is already blocked from the app's folder
(`APP_DIRS` in `core/case.ts`). So the backups need no new rule and no change to the generated
settings. The release refuses to run with `CASEFILE_CONFIG_DIR` set, so the backups can't end
up anywhere else. They are never pruned automatically.

**Going back** is manual and is the last resort: quit, check out the earlier tag, and replace
the case folder's contents with the backup made before the release being left. Anything done
since that backup is lost.

**Every schema version is frozen.** `tests/fixtures/schemas/vN.sql` holds each schema version
that has shipped. A fresh store must match the current version's file exactly, so a schema edit
without a version bump fails. Every frozen version must also migrate to exactly a fresh store.

## Consequences

- A development copy can't migrate or repair the real case by accident. This depends on
  `deno task dev` being used, and on there being no symbolic link inside `.dev/` that leads out.
- A bad release can be undone, losing only the work done since its backup.
- The backups hold the same kinds of data as the case: an encrypted vault and a tokenised
  public.db. Withdrawn text survives in them, on the user's own disk, out of Claude's reach.
- `dist/` is build output and is no longer tracked (an old bundle had been committed).

## Amendment: restart into an update without locking the case (2026-10-09)

casefile is run day to day as a web app (`deno task app`), not the desktop bundle. Quitting the
app for each release, logging in again and losing one's place was a cost worth removing.

**Decision.** `deno task app` runs `src/app/supervisor.ts`, which runs the app (`main.ts`) as a
child process. `deno task release` sends the supervisor SIGHUP after tagging. Then:

1. The supervisor asks the app, on the app's stdin, to hand over. The app logs
   `restarted_for_update`, closes the case as a shutdown does (its vault writes finish, the case
   lock is released), and replies on its stdout with the case folder, the vault **data key** and
   the session token (`AppState.handOff`). Then it exits.
2. If the release changed, the supervisor backs the case up while holding its lock. If the
   backup fails, the key is dropped and the case stays locked until the user opens it again.
3. The supervisor starts the new app and gives it the hand-over on its stdin. The new app opens the
   case with `CaseSession.openWithKey`. As with a recovery key, the key must decrypt an existing
   vault file before it is trusted. Opening then runs the lock, the repair and the log as usual.
   The app keeps the token, so the browser's cookie still signs in. It listens on the same port,
   so the cookie's name is the same too.
4. The page in the browser polls `/api/status`. When the release has changed, it shows "casefile
   was updated. Reload the page…" and does not reload by itself, so nothing being typed is lost.

The release no longer refuses when this app has the case open. It leaves the backup to the
restart. Rebuilding the desktop bundle is now opt-in (`--desktop`).

**Safety.** This is the first time the data key leaves the process that unwrapped it (ADR 4). It
only crosses the two child processes' own anonymous pipes. It never goes to a file, a port or a
socket, and it is never logged. The supervisor holds it only for the restart, as a JavaScript
string (which can't be wiped). Any process running as the same user could already read the app's
memory, so this adds no reader that could not already get the key. Claude Code's sandbox can't
reach those pipes. Being the same user, it might be able to send the supervisor SIGHUP. That only
causes a restart: the case stays open, and a backup is made only when `release.json` has
changed, which Claude can't write in the main checkout. Ctrl-C stops the app as before (it locks
the case), and then the supervisor. `deno task dev` still runs `main.ts` directly.
