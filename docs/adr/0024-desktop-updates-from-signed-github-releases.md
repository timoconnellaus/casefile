# 24. Desktop updates from signed GitHub releases

Date: 2026-10-09
Status: Accepted. Supersedes ADR 22's release script and its restart amendment; ADR 22's dev copy,
upgrade backup and frozen schemas stand.

## Context

The user wants to run casefile as the desktop app and update it by pressing a button, not by
running a script. The repository is now public on GitHub, with CI. The app holds the vault key
while a case is open, so whatever can change the app's code can read the case. The update path is
therefore part of the safety boundary.

`deno desktop` (Deno 2.9) has an updater, `Deno.autoUpdate`. It reads `latest.json` from a base
URL and downloads a bsdiff patch for the app's runtime (`Contents/MacOS/libruntime.dylib`, which
holds the app's code). It checks the patch's SHA-256 and stages it for the launcher to swap in at
the next launch. With a public key configured, the manifest must be Ed25519-signed.

## Decision

**Where updates come from.** The app fetches
`https://github.com/<UPDATE_REPO>/releases/latest/download/latest.json` and the patch it names. It
checks at start and then hourly. The requests carry no case data and no identifiers. They are made
by the runtime, not the page, so the CSP is unchanged.

**What makes an update trusted.**
- The manifest must be signed with the Ed25519 key whose public half is built into the app
  (`src/app/update_config.ts`).
- The private key is a secret of the GitHub `release` environment only, which only runs for
  `main`. Every push to `main` that changes the app is released automatically, at the next
  version. The environment can require the owner's approval for each release. Without that,
  merging is releasing, so the PR merge rules are the gate (amendment below).
- The patch must match the SHA-256 in the signed manifest.
- CI also checks that each patch rebuilds that release's runtime byte for byte, and smoke-tests the
  built app before anything is signed.
- Without both `UPDATE_REPO` and the key, the app never checks for updates.
- `CASEFILE_UPDATE_URL` can point the app at a test server. The signature is still required.

**Restarting.** Once a patch is staged, the app shows "casefile X.Y.Z is ready — Restart to
update". The restart route needs the signed-in session, like every route except the three ADR 13
leaves open. While the case is locked, the bar says to quit casefile and open it again instead,
which applies the update the same way. The restart closes the case as quitting does, then opens a new instance of the bundle
(`open -n`), and the user unlocks the case again. Handing the key over to the new instance, as
the web app did (ADR 22 amendment), would need a channel between two app instances that macOS
starts. That was judged not worth the risk.

**A Deno 2.9.7 workaround.** The launch that swaps an update in still runs the old runtime. So
the app, which knows the version it was built as (`version` from deno.json, embedded), reads the
version from the runtime file on disk after a swap. If that version is newer, the app relaunches
once, before any window opens. A marker file stops it relaunching in a loop.

**Before a new version opens a case,** it backs the case up into the app's folder, as ADR 22
does. This happens only after the passphrase is checked, and once per version per case
(`openedWith` in the app config). If the backup fails, the case isn't opened.

**The CLI travels with the app.** The build includes `bin/casefile` from the same commit. The app
installs it to `~/.local/bin` the first time each version starts, so Claude Code always runs a CLI
that matches the app's public.db.

**Build.**
- `scripts/build_desktop.ts` needs Deno 2.9.5 or later (denoland/deno#36150). It leaves out
  onnxruntime's other-platform binaries, which shrinks the runtime from 379 MB to 239 MB. bsdiff
  then fits a standard macOS runner (4.8 GB peak). Patches between builds are a few kilobytes.
- Releases are Apple-silicon only.
- First installs use `install.sh` with curl, so the app carries no quarantine flag and needs no
  Apple Developer ID.

**Removed.** `deno task release`, the web-app supervisor and its key hand-over, and the reload
banner. `deno task app` stays as a browser fallback for development.

## Consequences

- An update can only come from a signed manifest, and signing needs the owner's approval in
  GitHub. Stealing it means compromising the owner's GitHub account plus a workflow run, or
  replacing the public key in a release the owner approves.
- Each update costs a login. The case is backed up before the new version touches it.
- Deno's automatic rollback can't catch a version that fails to start (the launch that swaps
  marks it good). The release smoke test is the guard. The recovery for a broken release is a
  fixed release plus `install.sh`.
- Apps more than three releases behind get no patch and need `install.sh`.
- The first live update through GitHub's redirect to its release file host still needs checking
  (docs/RELEASING.md, one-time setup).

## Amendment: release on every merge to main (2026-10-09)

The owner asked for releases to happen on merge, without pushing a tag. The release workflow now
runs on each push to `main` that changes the app (`src/`, `deno.json`, `deno.lock`, the build and
release scripts, the workflow), and picks the version itself: PATCH, or MINOR or MAJOR when a
commit since the last release says `[minor]` or `[major]`. One release runs at a time. Nothing is
released until the public key is in `update_config.ts`.

Whether a person approves each release is now a setting of the `release` environment (required
reviewers), not a step in the process. Without it, a green, merged PR reaches the app that holds
the case. PRs are merged automatically when green, so the chain from push to install would then
have no person in it. docs/RELEASING.md puts that choice to the owner during setup.
