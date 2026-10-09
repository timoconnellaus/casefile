# 29. Encrypted single-file backup and restore

Date: 2026-10-09
Status: Accepted

## Context

A case lives in one folder on one computer. If the computer is lost or the folder is damaged,
the user's work is gone: the upgrade backup (ADR 22, ADR 24) is a plain copy of the folder in the
app's own folder on the same disk, made only before a new version first opens the case, and is
meant for going back a version, not for getting a case onto another computer. Until now Getting
started said backup wasn't available and told the user to copy the case folder by hand while
casefile was closed (REBUILD-PLAN section 3 deferred it because "the restore path is the risky
part").

The user decided:

1. A backup is one encrypted file. Where it goes is asked each time, with the last folder used as
   the default.
2. The backup holds the case's own data key, wrapped by the case passphrase and by the recovery
   key, so the one passphrase (or the recovery key) restores everything. There is no separate
   backup passphrase.
3. A backup is restored only into a new, empty folder, never over an existing case. The restored
   case is a separate case, and the original's log carries on unchanged.
4. "Last backup: N days ago" on Getting started and in Settings, amber after 14 days. No pop-ups.

## Decision

### The file

`casefile-backup-YYYY-MM-DD-HHMMSS.casefile-backup` (UTC; no case name in it), in the folder the
user chooses. Layout (`src/core/backupfile.ts`):

```
"CASEFILE-BACKUP\n"                       16 bytes
u32 header length, then the header       JSON, at most 64 KiB
frames                                    u8 last ‖ u32 length ‖ 12-byte IV ‖ AES-256-GCM ciphertext
```

The header holds `format`, `version` (1), `createdAt`, `app` (the release that made it),
`publicDbSchema`, and `keyfile`: the case's `vault/keyfile.json` as it was, that is the data key
wrapped by the passphrase and, if there is one, by the recovery key (ADR 4, unchanged). Nothing in
the header is case content.

The frames carry one archive, decrypted: `'F' ‖ u16 path length ‖ path ‖ u64 size ‖ bytes` per
file, then `'E' ‖ u32 file count`. The files are `case.json`, `public.db` and every
`vault/<name>.enc`, the vault files byte for byte as they are on disk (still encrypted with the
data key). Not in the backup: the case lock, `CLAUDE.md` and `.claude/` (opening the restored case
writes them again, ADR 17), damaged vault files set aside, and anything else the user or Claude
put in the case folder.

### Encryption

The frames are encrypted with a key derived from the data key by HKDF-SHA256 (info
`casefile-backup-file`), so the data key opens the backup but a vault file and the backup are
never under the same key. Each frame's associated data is
`casefile-backup-frame|<SHA-256 of everything before the frames>|<frame number>|<last 0/1>`:

- **The header can't be changed.** Its hash is in every frame's associated data, so changing it
  (including the keyfile) fails the first frame.
- **A swapped keyfile can't pass off another key.** Someone who can write the backup could put in
  a keyfile wrapping a key of their own under a passphrase they know. The frames were not made
  with that key, so the first frame fails. (`Vault.openWithRecovery` needs the same check for a
  recovery wrap: the keyfile is not authenticated on its own.)
- **Frames can't be dropped, repeated or reordered,** and a file cut short is caught: only the
  frame marked last may end the file, and nothing may follow it.

A backup made before the passphrase was changed needs the passphrase it was made with; a backup
made before a recovery key was made or replaced opens only with the recovery key it carries. The
Settings screen says so.

### Making one

Settings → Backup and recovery → "Back up now" (`POST /api/backup`, signed in only). The user types
the folder each time; it is filled in with the last folder used, kept in the app's config
(`lastBackupDir`, next to `lastCase`; the folder path is not case content). The folder must exist
and must not be inside the case folder, where Claude Code could read the file and its keyfile.

The copy is consistent: the session's queued vault writes finish, then, with no `await` between
reads so nothing else in the app writes meanwhile, the vault files are read. public.db is copied
after them with SQLite's online backup from a read-only connection, as the upgrade backup copies
it, so it is a whole database even while the CLI writes. (`VACUUM INTO` would have been one
synchronous statement, but Deno turns off SQLite's ATTACH, which it needs, unless every permission
is granted.) Vault first, so public.db is never older than the vault read: opening a case repairs
public.db against the vault, and the AI-use log's head in the vault may lag public.db but must not
lead it (ADR 8). A request that wrote to the vault but not yet to public.db, or to public.db after
the vault was read, is caught as a crash at that instant would be, and opening repairs it the same
way. The temporary copy of public.db goes in the app's folder (`<config>/tmp/`), out of Claude's
reach, and is deleted.

The file is written under a temporary name, flushed, read back and checked through to its end with
the key, and only then renamed to its name. A file under a backup's name is a whole backup.

The vault records when the last backup was made (`backups`: `lastAt`), and the log gets
`case_backed_up` with the number of files and bytes only (no path, no file name).

### Restoring one

On the unlock screen, "Restore from a backup" (`POST /api/case/restore`). It needs the backup file,
a folder for the restored case, and the passphrase, or the recovery key and a new passphrase
(ADR 4: whoever uses the recovery key has forgotten the passphrase).

- **The folder must be new or empty** and must not be inside a case folder (that case's Claude
  could read the restored public.db). Anything else, a file, a link, a non-empty folder, the case
  itself, is refused before anything is written.
- **The key is unwrapped before anything is written.** A wrong passphrase or recovery key leaves no
  trace. Attempts are rate limited and serialised like opening a case (ADR 13), counted per backup
  file. A copy of the file under another name has its own count, as a copy of a vault folder does;
  whoever can copy the file can also guess offline, so the limit only slows guessing through the
  app.
- **The whole backup is decrypted and checked into a hidden folder** next to the target
  (`.<name>.restoring-<uuid>`). Only a backup that reads through to its end, with every frame, the
  file count and `case.json`, `public.db` and `vault/settings.enc` present, is moved into place, by
  one rename. Any failure removes the hidden folder. A damaged, cut-short, changed or swapped file,
  or a backup from a newer casefile (its public.db schema is newer than this build's), restores
  nothing. With the recovery key, the passphrase wrap is replaced in the hidden folder, before the
  move.
- **A backup from an older casefile restores:** its public.db is migrated forward when the
  restored case opens, as any case's is (ADR 10, ADR 22's frozen schemas).
- **The restored case is a separate case.** It opens in casefile in place of whatever was open
  (only for the signed-in user, or when nothing is open, as creating a case), with its own folder,
  lock and Claude Code files. Its log carries on from the backup's last entry, adds
  `case_restored` (the backup's date and schema version only) and is chained with the same key,
  so the log check passes. The case the backup was made from is never touched: its log carries on
  unchanged. The two logs share their history up to the backup and then go their own ways.

The restore route is the fourth open route (with status, create and open; ADR 13): it has to work
before any case is open, on a new computer. Like `case/open`, the secret is the proof, and like
`case/create` it cannot replace a session another caller has open.

### The reminder

Getting started step 6 and Settings say "Last backup: today", "1 day ago" or "N days ago", from the
vault's `lastAt`, or "No backup yet". The words are amber (the attention colour, ADR 20) when there
is no backup or the last one is more than 14 days old. There is no pop-up, banner or notification.

### How this relates to the upgrade backup

The upgrade backup (ADR 22, ADR 24) stays as it is: a plain copy of the closed case folder in the
app's folder, made before a new version first opens a case, so a release can be undone. It is on
the same disk, so it does not protect against losing the computer, and it is not counted by the
reminder.

The two share their rules rather than their code where the code can't be shared:

- **Where their working files go:** the app's folder, which the generated Claude Code settings
  already block (`APP_DIRS`). The upgrade backup keeps its copy there; the single-file backup keeps
  its temporary public.db copy there.
- **How a file in the case folder is read:** through one handle whose inode is the one first seen
  as a regular file, and only if it is still where it should be inside the case folder, not
  reached through a link (`readInPlaceSync` follows `upgrade_backup.ts`'s rule). The upgrade
  backup copies with the case closed and can stream; the single-file backup copies with the case
  open and must read synchronously to be consistent, so it has its own (synchronous) reader.
- **How public.db is copied:** the same way, with SQLite's online backup from a read-only
  connection, consistent while the CLI may be writing.
- **What is left out:** the lock file and links in both.

Restoring an upgrade backup is still the manual last resort in `docs/PLAN.md` ("Go back"). The
restore path here reads only `.casefile-backup` files.

## Consequences

- A case can be moved to another computer, or got back after losing this one, with one file and
  the passphrase or the recovery key.
- The backup file holds the keyfile's wraps. Anyone with the file can try passphrases offline
  against PBKDF2-SHA256 at 600,000 iterations, exactly as with `vault/keyfile.json`. The user is
  told to keep backups on a drive only they use. Saving into the case folder is refused.
- The whole case is read into memory to take a consistent copy. A case with very large PDF
  originals needs that much memory for a moment.
- A restored case and its original are two cases with the same data key and a shared log history.
  Nothing links them after the restore; the user decides which one to use. Checks the user signed
  are valid in both (the signing key comes from the same data key, ADR 8).
- `src/core/backupfile.ts` is outside the CLI's module graph (`tests/boundary_test.ts`).
