---
name: babysitter
description: Merge the user's own open casefile pull requests (timoconnellaus/casefile) once they are green, and report the rest. One pass per run; made to be repeated with `/loop /babysitter` (or `/loop 10m /babysitter`). Use when the user says "babysit my PRs", "merge my green PRs", or invokes /babysitter.
---

# Babysitter: merge my green casefile PRs

One pass over the user's open PRs on `timoconnellaus/casefile`: merge the green ones, update the
ones that are only behind, leave everything else alone, and report. Only this repo. Never fix
code, never push commits of your own, never merge anyone else's PR.

## Each pass

1. List candidates:

   ```sh
   gh pr list -R timoconnellaus/casefile --author @me --state open \
     --json number,title,url,isDraft,headRefOid,mergeable,mergeStateStatus,reviewDecision,labels,statusCheckRollup
   ```

2. Classify each PR. **Green** means all of:
   - not a draft, and no label like `wip`, `do-not-merge`, `hold` or `no-babysit`;
   - `statusCheckRollup` includes the `ci` job (`.github/workflows/ci.yml`, which runs
     `deno task ci`), and every entry is finished and passing: `status == COMPLETED` with
     `conclusion` in `SUCCESS`, `NEUTRAL` or `SKIPPED` (or `state == SUCCESS` for a status
     context). No checks at all is not green; report it as "no CI".
   - `mergeable == MERGEABLE` and `mergeStateStatus == CLEAN` (or `HAS_HOOKS`);
   - `reviewDecision` is not `CHANGES_REQUESTED` or `REVIEW_REQUIRED`.

   Otherwise it is one of:
   - **Pending**: a check is queued or in progress. Wait for the next pass.
   - **Behind**: green apart from `mergeStateStatus == BEHIND`. Run
     `gh pr update-branch N -R timoconnellaus/casefile` once (it merges `main` into the PR branch
     on GitHub, which reruns CI), then wait for the next pass. On a conflict, treat it as Blocked.
   - **Red**: a check failed, was cancelled or timed out. Report the failing check and the link.
     Don't rerun or fix anything.
   - **Blocked**: conflicts (`CONFLICTING` / `DIRTY`), changes requested, draft or held label.
     Report why.

3. Merge each green PR, pinned to the commit that was checked so a late push can't slip in:

   ```sh
   gh pr merge N -R timoconnellaus/casefile --squash --delete-branch --match-head-commit <headRefOid>
   ```

   If the merge is refused (the head moved, or protection blocks it), report it and move on.
   **Never pass `--admin` or `--auto`.** Never force-push.

4. Don't touch the main checkout, and don't release. Merging on GitHub doesn't change the running
   app; shipping it is `git pull --ff-only` and `deno task release` in the main checkout
   (CLAUDE.md, "Shipping a change to the user"). After merges, end the report with: "Merged on
   GitHub; not released yet."

## Report (keep it short)

One line per PR: `merged`, `updated branch`, `waiting on CI`, `red: <check>`, `blocked: <reason>`
or `no CI`, plus the PR link. If nothing changed since the last pass, say so in one line.

## Pacing under /loop

When run under dynamic `/loop` (no interval), schedule the next pass yourself:

- Checks pending or a branch was just updated: about 5–10 minutes.
- Only red, blocked or no-CI PRs left, or nothing open: about 30 minutes, with `noop: true` when
  nothing changed.
- Stop the loop (`stop: true`) if no PRs have been open for several passes, or if `gh` reports an
  auth failure (tell the user to run `gh auth login`).
