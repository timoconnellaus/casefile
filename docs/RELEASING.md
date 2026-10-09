# Releasing casefile

The user runs the desktop app (`~/Applications/casefile.app`). It updates itself from this repo's
GitHub releases: it checks the latest release when it starts and then hourly, downloads a small
signed patch, and shows **"casefile X.Y.Z is ready — Restart to update"**. The design and its safety
reasoning are in [ADR 23](adr/0023-desktop-updates-from-signed-github-releases.md).

## Shipping a change

1. Open a pull request from your branch. GitHub runs `deno task ci`, and the PR is merged once it
   is green.
2. Tag the merged `main` with the next version and push the tag:

   ```sh
   gh release list --limit 1          # the last version
   git fetch origin && git tag v0.4.0 origin/main && git push origin v0.4.0
   ```

   A fix bumps PATCH and a feature bumps MINOR. CI sets the version from the tag; `version` in
   `deno.json` does not need editing.
3. The `release` workflow (`.github/workflows/release.yml`) runs:
   - **build** (macOS): `deno task ci`, then `deno task desktop` at that version, then a smoke test
     that launches the app and checks it reports its version. It zips the app and makes update
     patches from the last three releases, checking that each one rebuilds this version's runtime
     byte for byte.
   - **publish** (the `release` environment): **waits for the owner's approval**. This is the only
     job that can read the signing key. It signs `latest.json` and publishes the release with the
     app zip, the patches, `latest.json` and `install.sh`.
4. The owner approves it under Actions → release → Review deployments; the GitHub mobile app works
   too. Within an hour, or at the next launch, the app offers the update.

An app older than the last three releases gets no patch. It stays on its version until it is
reinstalled with `install.sh`.

## One-time setup

Done once, when the repo is first set up. Until all of it is done, `UPDATE_REPO` or
`UPDATE_PUBLIC_KEY` in `src/app/update_config.ts` is null, and the app never checks for updates.

1. **The `release` environment.** On GitHub, go to Settings → Environments → New environment and
   name it `release`. Under Required reviewers add the owner and enable "Prevent self-review" if
   offered. Under Deployment branches and tags, allow only tags matching `v*.*.*`.
2. **The signing key.** In a checkout of `main`, run:

   ```sh
   deno task release:keygen | gh secret set CASEFILE_UPDATE_SIGNING_KEY --env release
   ```

   This writes the public key into `src/app/update_config.ts`. The private key goes straight into
   the environment secret and never touches the disk or the terminal. Keep no other copy. If the
   key is ever replaced, every installed app refuses updates until it is reinstalled.
3. **The repository.** Set `UPDATE_REPO = "timoconnellaus/casefile"` in
   `src/app/update_config.ts`. Commit both lines through a PR.
4. **Pin the actions.** In `release.yml`, replace `actions/checkout@v4`, `denoland/setup-deno@v2`,
   `actions/upload-artifact@v4` and `actions/download-artifact@v4` with their full commit SHAs. A
   moved tag must not be able to change what runs next to the signing key.
5. **The first release.** Tag `v0.2.0` (or the next version) as above. It has no patches, because
   there is nothing to patch from.
6. **Install it.** Quit any casefile that is running. Then:

   ```sh
   curl -fsSL https://github.com/timoconnellaus/casefile/releases/latest/download/install.sh | sh
   ```

   Downloaded with curl, the app carries no quarantine flag, so macOS opens it without an Apple
   Developer ID. Updates after that arrive as signed patches inside the app.
7. **Check the first real update.** Ship a small change as `v0.2.1` and watch for:
   - the app offering it;
   - **Restart to update** bringing it back as 0.2.1;
   - a backup in `~/Library/Application Support/casefile/backups/<case>/`;
   - `casefile --help` in a terminal still working.

   This is the first time the update requests go to github.com, through its redirect to the
   release file host. A local test (below) can't check that part.

## Testing an update locally

The full path has been tested against a local HTTPS server: signature, patch hash, staging, the
one-click restart and the CLI install. To repeat it:

1. Make a throwaway key with `generateKeys()` from `scripts/release/signing.ts`. Make a test CA and
   a leaf certificate for `127.0.0.1` (`basicConstraints=CA:FALSE`).
2. In a copy of the repo with the test public key in `update_config.ts`, build two versions with
   `deno run … scripts/build_desktop.ts`, changing `version` in `deno.json` between them.
3. `bsdiff old.app/…/libruntime.dylib new.app/…/libruntime.dylib patch-A-to-B.bin`, then
   `CASEFILE_UPDATE_SIGNING_KEY=<test key> deno run … scripts/release/manifest.ts --version B
   --dir serve --patch A=patch-A-to-B.bin`.
4. Serve `serve/` over HTTPS. Launch the old app's `Contents/MacOS/laufey_webview` with
   `CASEFILE_UPDATE_URL=https://127.0.0.1:<port>`, `DENO_CERT=<ca.crt>`, and a scratch `HOME` and
   `CASEFILE_CONFIG_DIR` (so it doesn't touch the real CLI or config). Put a stub `open` first on
   `PATH` that relaunches the app with the same environment.

## Known Deno issues (2.9.7)

- **Before 2.9.5,** packaged apps couldn't verify a signed manifest at all (denoland/deno#36150).
  `scripts/build_desktop.ts` refuses older Denos.
- **The launch that swaps an update in still runs the old runtime,** and that launch marks the
  update good on the new version's behalf. The app works around the first part by relaunching once
  (`relaunchIfStale` in `src/app/updates.ts`). The second part means Deno's automatic rollback
  can't catch a new version that fails to start. That is why the release smoke-tests the app
  before publishing it. If a published version still won't start, ship a fixed version and
  reinstall with `install.sh`. Worth reporting upstream.
