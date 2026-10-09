# 13. Local API security

Date: 2026-10-07
Status: Accepted

## Context

The app is a `Deno.serve()` server on 127.0.0.1 (ADR 2). Once a case is unlocked its API returns
re-identified text. Any process on the machine can reach 127.0.0.1, including Claude Code, which
has a shell and is working in the case folder. A web page in an ordinary browser can also send
requests to localhost.

## Decision

- **Session cookie for the passphrase.** Unlocking or creating a case issues a random 256-bit
  session token as an `HttpOnly; SameSite=Strict` cookie. Every route except `status`,
  `case/open` and `case/create` requires it (constant-time comparison). Locking clears it.
  The case auto-locks after 30 minutes idle.
- **Open routes reveal nothing.** `status` returns the case label and folder only to a caller
  with the cookie. The last-opened folder is remembered in the window's `localStorage`, not by
  the server.
- **Passphrase attempts are rate limited.** After 3 wrong passphrases for a vault, each further
  failure doubles the wait (2 s up to **2 minutes**, `MAX_LOCKOUT_MS`). Attempts are checked one at a time (parallel
  guesses can't race past the limit), and limits are per vault: only unlocking *that* vault
  resets them, so opening some other case does not clear the count. The correct passphrase may take over an open session
  (it proves who is asking); `case/create` may not replace one without the cookie.
- **No scaffolding into existing folders.** A new case needs a new or empty folder, so the API
  can't be used to write `CLAUDE.md`/`.claude/` into an arbitrary directory.
- **Browser protections.** The `Host` header must be a loopback name (blocks DNS rebinding).
  A state-changing request with an `Origin` must come from the same local origin (blocks CSRF).
  Responses carry a strict CSP (no inline script or style), `nosniff`, `no-referrer` and
  `no-store`. The UI never uses `innerHTML` for document text.
- **Nothing sensitive in logs or errors.** Unexpected errors return a generic message and print
  only the error type (full detail only with `CASEFILE_DEBUG=1`). Settings changes log only the
  LLM endpoint's host, never a URL that could carry credentials.
- **Exports are downloads** and are never written into the case folder (ADR 3).

## Consequences

**Lockout trade-off** (security review, 2026-10-07). `case/open` is an open route, so any local
process (including Claude Code) can make wrong guesses and trigger the lockout, keeping the user
out of their own case. The cap was lowered from 15 minutes to 2 minutes: once the doubling reaches
the cap a guesser gets at most about 720 attempts a day, against a 12-character passphrase and
600,000 PBKDF2 iterations, while the user never waits more than 2 minutes. The wait is shown in the
unlock screen (`retryAfterSeconds` from `status`) and in the 429 error, which says that any program
can cause it.

Claude Code can read `public.db` (by design) but cannot use the app's API to see real names
without the passphrase. tests/app_test.ts exercises each rule.

## Amendment: recovery key, idle-lock setting and Claude Code actions (v2 rebuild, 2026-10-07)

- **Open routes are unchanged**: still only `status`, `case/open` and `case/create`
  (`tests/settings_api_test.ts` restates the check). `case/open` also accepts
  `{dir, recoveryKey, newPassphrase}` (ADR 4). Wrong recovery keys are wrong passphrases for the
  rate limit: one count per vault, shared, serialised, reset only by a success on that vault. Text
  that cannot be a recovery key is refused (400) before any key derivation and does not count.
  Making, replacing or removing a recovery key needs the cookie and the passphrase, and wrong
  passphrases there count too. The 429 message says "wrong passphrases or recovery keys".
- **Idle lock** is a case setting: 15, 30 (default) or 60 minutes, kept in the vault.
  `/api/status` returns `idleLockMinutes` to every caller (amended in wave 3; it first said
  signed-in callers only). Signed in, it is the open case's setting; otherwise it is the app-level
  copy of the last-opened case's setting (`AppState.lastIdleLockMinutes`, in the app config, or
  the default), so the unlock screen can say "Locks after N min idle". It is one of 15, 30 or 60
  and says nothing about the case's contents, so it is not treated as sensitive.
- **Running a program.** The app task gains `--allow-run=open` and nothing else.
  `POST /api/claude-code/open-terminal` runs exactly `open -a Terminal <case folder>` on macOS,
  with the open case's real path (checked to be a folder with the case marker); nothing from the
  request is used. Elsewhere, or if it fails, it returns `opened: false` and the command to type.
  Finding `claude` and `casefile` only stats files on the PATH (absolute entries only) and in a
  few usual install folders; nothing is run.
- **No writes or reads through links, pipes or huge files.** Claude can write in the case folder,
  so casefile's own writes there (the scaffold, at create, open and restore) never follow a
  symbolic link: path components are checked with lstat, a linked folder is replaced with a real
  one, the file is written to a new temp file (`createNew`, so nothing already at that name is
  followed) in the verified real folder, and immediately before the rename the folder's real path
  and the temp file's device and inode are checked again. Reads for the status check require a
  regular file (lstat) of at most 64 KB, then compare the opened file's fstat device and inode with
  the lstat, read at most 64 KB + 1 bytes, and give up after 2 seconds. Anything else counts as
  changed. **Residual risk:** Deno has no `O_NOFOLLOW`/`openat`, so a swap between the last check
  and the rename (or the open) is narrowed, not closed: a swapped-in link at the final name is
  replaced, not followed, by the rename, and a pipe swapped in after the lstat can at worst hold
  one request for 2 seconds (and leave one blocked thread until a writer appears). The test hooks
  `scaffoldTestHooks.beforeOpen`/`beforeRename` simulate these swaps.
