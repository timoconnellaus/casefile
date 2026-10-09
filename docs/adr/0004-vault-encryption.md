# 4. Vault encryption

Date: 2026-10-07
Status: Accepted

## Context

Originals and the token key must be unreadable without the user's passphrase, including to
Claude Code, backups and other software on the machine. We want no native crypto dependencies.

## Decision

- WebCrypto only. A random 256-bit **data key** encrypts every vault file with **AES-256-GCM**
  (fresh 96-bit IV per write).
- The data key is wrapped with a key derived from the passphrase by **PBKDF2-HMAC-SHA256,
  600,000 iterations** (OWASP 2023 guidance), random 128-bit salt. Stored in `vault/keyfile.json`.
  Changing the passphrase re-wraps the data key; files are not re-encrypted.
- Each file is `IV ‖ ciphertext`, and the **file name is bound in as associated data**, so files
  cannot be swapped or renamed undetected.
- Writes are atomic (temp file, flushed to disk, then renamed), files are mode 0600, the
  directory 0700. A vault refuses to write once its folder has been replaced (ADR 8, amended).
- A separate HMAC key for verification signatures is derived from the data key with HKDF
  (ADR 8).
- One file per document (`doc-d001.enc`), plus `entities`, `settings`, `attestations` (the
  attestation ledger, ADR 8), `log-head` (the AI-use log's last chained entry, ADR 8) and
  `edit-checks` (a fixed-shape record of every check of user text that replaces Claude's text,
  including possible probes, ADR 3).
- A separate key for the AI-use log's hash chain is derived from the data key with HKDF
  (`logChainKey`, info `casefile-log-chain`, ADR 8).
- File names and sizes are visible to anything on the machine (only contents are encrypted), so
  vault writes must not depend on secret facts (ADR 3, edit checks).

## Consequences

Wrong passphrase, tampering and swapping are all detected (tests/vault_test.ts). Argon2 would
resist GPU guessing better but needs a WASM dependency; PBKDF2 at 600k is an acceptable baseline
and the KDF parameters are stored per vault so they can be raised later. A forgotten passphrase
means the vault is unrecoverable, by design.

## Amendment: recovery key (v2 rebuild, 2026-10-07)

A forgotten passphrase meant a lost case. The user may now make a **recovery key**, optionally at
creation or later in Settings.

- **The key:** 160 random bits, written in Crockford base32 as 32 characters in 8 groups of 4
  (`XXXX-XXXX-…`). Reading it back ignores case, spaces and hyphens and maps O→0, I/L→1.
- **Keyfile v2:** `keyfile.json` gains an optional `recovery` block: a second wrap of the same
  data key under a key derived from the recovery key's 20 bytes with PBKDF2-HMAC-SHA256 (same
  iteration count as the passphrase, its own salt), AES-GCM with associated data
  `casefile-data-key-recovery` (the passphrase wrap keeps `casefile-data-key`), plus `createdAt`.
  A keyfile without a recovery block is still written as **version 1**, so it opens in older
  builds; version 1 keyfiles open unchanged. Changing the passphrase keeps the recovery wrap.
- **Shown once:** the key is returned in the API response that makes it (`no-store`) and is never
  written anywhere in plain text, logged, or kept in settings (settings record only that one
  exists). Making a new key replaces the old one; making, replacing and removing all require the
  current passphrase.
- **Using it:** recovery opens the vault and immediately re-wraps the data key under a **new
  passphrase** the user chooses (someone using it has forgotten the old one). The recovery key
  stays valid until replaced.
- **Swapped wraps:** `keyfile.json` is not authenticated, so something able to write it could
  insert a recovery wrap of a key of its own. A recovered key is trusted only after it decrypts an
  existing vault file; otherwise re-wrapping it would replace the real data key and lose the case.
- Without a recovery block, a recovery attempt still performs one PBKDF2 derivation, so the reply
  takes the same time whether or not the case has a key.

Consequence: anyone holding the printed key can open the case, exactly as with the passphrase; the
UI says to keep it somewhere private. Encrypted backup remains deferred.

## Amendment: one opener at a time, and a replaced folder (v3, 2026-10-07)

**What happened.** The packaged app had the seeded canon case open when `deno task seed --force`
deleted and rebuilt that folder. Part-way through, the app opened the new case (same folder, same
seed passphrase). Opening runs `reconcilePublic`: it reads the vault's documents, then removes
from public.db any document that list did not contain. The seed published D130 between the two
reads, so the app withdrew it (`public_store_repaired {docs: [D130]}` in the case's log), and the
seed failed with "Not found: document D130". Reproduced by opening the case in a second app process
during a seed. It was *not* SQLite deleting the new case's `-wal`/`-shm`: before the checkpoint and
WAL clean-up on close, SQLite checks that the path still names the file it has open
(`SQLITE_FCNTL_HAS_MOVED`) and skips both when it does not; a test closes a stale connection while
the new case's rows are still only in its WAL and finds them all there.

**Decision.**

- **Case lock.** Whatever opens a case with its vault holds `<case>/.casefile-lock`: the app
  (open, create, recovery), and `seed --force` while it deletes the old folder. The file is made
  with an exclusive create (O_EXCL) and records the pid, start time, host and a random token. It is
  removed on lock, idle lock and shutdown, only if it still holds that token (so closing a session
  on a replaced folder never removes the new case's lock). A lock whose pid is not running on this
  host is stale and is taken over (moved aside atomically first, so two openers can't both take
  it); one from another host counts as live. Liveness is `kill(pid, 0)` through FFI (no signal is
  sent; the app, seed and test tasks have `--allow-ffi`); if that is unavailable the lock counts as
  live. Within one process holds are shared and counted (the app replacing its own session), so
  the lock does not keep two sessions of this process apart: opening (or recovering) the case that
  is open already first locks the open session and waits for its writes and its public.db to
  close, and only the right passphrase or recovery key does that.
- **Refusal.** Opening, creating over, recovering or `seed --force` on a case another live process
  holds fails with "This case is open in casefile (pid N). Lock it or quit casefile first." (409
  from the API).
- **The CLI never takes the lock.** Claude works alongside the open app; its public.db writes are
  ordinary transactions that repair nothing, and it never opens the vault.
- **A replaced folder.** A session records its case folder's and public.db's device and inode.
  `PublicStore` checks the file's identity before every statement (an open file's inode cannot be
  reused, so a match means it is still this file) and, once it differs, refuses all use
  (`StoreReplacedError`), as the vault already does (`VaultReplacedError`). The app checks before
  every request; on a replaced folder it locks the case, closes the connection normally (safe, see
  above) and shows "This case's folder was replaced while it was open; open it again." on the
  unlock screen (`/api/status` `lockNotice`, a fixed sentence).

**Consequences.** Builds before this amendment write no lock, so they are not kept out. The lock
guards against casefile's own processes, not an adversary: anything that can write in the case
folder, Claude included, can delete it. A reused pid can make a stale lock look live; the user then
quits casefile or deletes the file. Tests: `tests/caselock_test.ts`.
