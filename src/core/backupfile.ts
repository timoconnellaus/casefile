/**
 * The encrypted single-file backup of a case (ADR 29).
 *
 *   "CASEFILE-BACKUP\n"            16 bytes
 *   header length                  u32, big-endian (at most 64 KiB)
 *   header                         JSON: format, version, createdAt, app, publicDbSchema, keyfile
 *   frames, one after another:     u8 last (0 or 1) ‖ u32 length ‖ 12-byte IV ‖ AES-GCM ciphertext
 *
 * `keyfile` is the case's `vault/keyfile.json` as it was: the case's own data key wrapped by the
 * passphrase and, if there is one, by the recovery key. The frames are encrypted with a key
 * derived from that data key (`backupKeyFrom`), so the passphrase or the recovery key opens the
 * backup and nothing else does. Each frame's associated data binds the SHA-256 of everything
 * before the frames (so the header, keyfile included, can't be changed), the frame's number (so
 * frames can't be dropped or reordered) and whether it is the last (so a cut-short file is caught).
 *
 * Decrypted, the frames are one archive:
 *
 *   'F' ‖ u16 path length ‖ path ‖ u64 size ‖ bytes     one per file
 *   'E' ‖ u32 file count                                 then nothing more
 *
 * Paths are `case.json`, `public.db` and `vault/<name>.enc`; the vault files are copied as they
 * are on disk (still encrypted with the data key). The generated Claude Code files are not kept:
 * opening the restored case writes them again. Nothing else in the case folder is in the backup.
 *
 * Only the app imports this module (tests/boundary_test.ts).
 */
import { encodeHex } from "@std/encoding/hex";
import { basename, dirname, join, resolve } from "@std/path";
import { backup, DatabaseSync } from "node:sqlite";
import { CASE_MARKER, casePaths, findCaseDir } from "./case.ts";
import { SCHEMA_VERSION } from "./publicdb.ts";
import type { CaseSession } from "./session.ts";
import {
  backupKeyFrom,
  type KeySecret,
  MalformedRecoveryKeyError,
  unwrapKeyFile,
  Vault,
  WrongPassphraseError,
} from "./vault.ts";

export const BACKUP_MAGIC = "CASEFILE-BACKUP\n";
export const BACKUP_EXTENSION = ".casefile-backup";
/** Plaintext per frame. */
export const FRAME_SIZE = 1 << 20;
const MAX_HEADER = 64 * 1024;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_FILES = 1_000_000;
const VAULT_FILE_RE = /^vault\/[a-z0-9][a-z0-9_.-]{0,95}\.enc$/;
type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface BackupHeader {
  format: "casefile-backup";
  version: 1;
  createdAt: string;
  /** The casefile release that made it (null when run from source). */
  app: string | null;
  /** public.db's schema version in the backup. */
  publicDbSchema: number;
  /** `vault/keyfile.json` as it was when the backup was made. */
  keyfile: unknown;
}

/** Not a casefile backup at all (wrong start, or a header that can't be read). */
export class NotABackupError extends Error {
  constructor() {
    super("That file is not a casefile backup.");
    this.name = "NotABackupError";
  }
}

/** The passphrase or recovery key was right, but the file was damaged, cut short or changed. */
export class BackupDamagedError extends Error {
  constructor(detail: string) {
    super(`This backup is damaged or incomplete (${detail}). Nothing was restored.`);
    this.name = "BackupDamagedError";
  }
}

/** Made by a newer casefile, whose public.db this build can't open. */
export class BackupTooNewError extends Error {
  constructor(readonly schema: number) {
    super(
      `This backup was made by a newer casefile (public.db v${schema}; this one reads up to ` +
        `v${SCHEMA_VERSION}). Update casefile, then restore it.`,
    );
    this.name = "BackupTooNewError";
  }
}

/** The folder to restore into is not new and empty, or is inside a case. */
export class RestoreTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreTargetError";
  }
}

// ── taking the copy ──────────────────────────────────────────────────────────

export interface SnapshotFile {
  path: string;
  data: Uint8Array;
}

export interface Snapshot {
  files: SnapshotFile[];
  keyfile: unknown;
  schema: number;
}

/**
 * Read a regular file at `rel` inside `root` through one handle, and only if it is still the file
 * first seen there and still inside the case folder (not reached through a link). The same rule
 * as the upgrade backup's copy (`src/app/upgrade_backup.ts`). Null if it isn't.
 */
function readInPlaceSync(root: string, realRoot: string, rel: string): Uint8Array | null {
  const path = join(root, rel);
  const st = Deno.lstatSync(path);
  if (!st.isFile) return null;
  const f = Deno.openSync(path, { read: true });
  try {
    const now = f.statSync();
    if (!now.isFile || now.ino !== st.ino || now.dev !== st.dev) return null;
    if (Deno.realPathSync(path) !== join(realRoot, rel)) return null;
    const out = new Uint8Array(now.size);
    for (let off = 0; off < out.length;) {
      const n = f.readSync(out.subarray(off));
      if (n === null) return null; // shorter than it said: changed while read
      off += n;
    }
    return out;
  } finally {
    f.close();
  }
}

/**
 * Take a consistent copy of the open case. The session's queued vault writes finish first; then,
 * with no `await` in between, so nothing else in this process can write meanwhile, the vault files
 * are read. public.db is copied after them, with SQLite's online backup from a read-only
 * connection, as the upgrade backup does (`src/app/upgrade_backup.ts`): a consistent copy even
 * while the CLI writes. (`VACUUM INTO` can't be used: Deno turns off SQLite's ATTACH unless every
 * permission is granted.) Vault first, so public.db is never older than the vault: opening a case
 * repairs public.db against the vault, and the AI-use log's head in the vault may lag public.db but
 * must not lead it (ADR 8).
 */
async function snapshot(session: CaseSession, tmpDir: string): Promise<Snapshot> {
  await session.settled();
  await Deno.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const dbCopy = join(tmpDir, `backup-${crypto.randomUUID()}.db`);
  try {
    const root = session.paths.root;
    const realRoot = Deno.realPathSync(root);
    if (Deno.realPathSync(session.paths.vaultDir) !== join(realRoot, "vault")) {
      throw new Error("The case's vault folder is not where it should be.");
    }
    // ── synchronous from here ──
    const files: SnapshotFile[] = [];
    const marker = readInPlaceSync(root, realRoot, CASE_MARKER);
    if (!marker) throw new Error("The case's case.json can't be read.");
    files.push({ path: CASE_MARKER, data: marker });
    const keyfileBytes = readInPlaceSync(root, realRoot, "vault/keyfile.json");
    if (!keyfileBytes) throw new Error("The case's key file can't be read.");
    const keyfile = JSON.parse(dec.decode(keyfileBytes));
    const names = [...Deno.readDirSync(session.paths.vaultDir)]
      .map((e) => `vault/${e.name}`)
      .filter((p) => VAULT_FILE_RE.test(p) && p !== "vault/keyfile.enc")
      .sort();
    for (const p of names) {
      const data = readInPlaceSync(root, realRoot, p);
      if (data) files.push({ path: p, data });
    }
    // ── end ──
    const st = Deno.lstatSync(session.paths.publicDb);
    if (!st.isFile || Deno.realPathSync(session.paths.publicDb) !== join(realRoot, "public.db")) {
      throw new Error("The case's public.db is not where it should be.");
    }
    const src = new DatabaseSync(session.paths.publicDb, { readOnly: true });
    let schema: number;
    try {
      schema = (src.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      await backup(src, dbCopy);
    } finally {
      src.close();
    }
    files.push({ path: "public.db", data: await Deno.readFile(dbCopy) });
    return { files, keyfile, schema };
  } finally {
    for (const f of [dbCopy, `${dbCopy}-wal`, `${dbCopy}-shm`, `${dbCopy}-journal`]) {
      await Deno.remove(f).catch(() => {});
    }
  }
}

// ── writing ─────────────────────────────────────────────────────────────────

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function frameAad(headerHash: string, index: number, last: boolean): Bytes {
  return enc.encode(`casefile-backup-frame|${headerHash}|${index}|${last ? 1 : 0}`);
}

async function writeAll(f: Deno.FsFile, data: Uint8Array) {
  for (let off = 0; off < data.length;) off += await f.write(data.subarray(off));
}

/** Encrypts the archive into frames as it is written. */
class FrameWriter {
  #buf = new Uint8Array(FRAME_SIZE);
  #fill = 0;
  #index = 0;
  constructor(
    private readonly file: Deno.FsFile,
    private readonly key: CryptoKey,
    private readonly headerHash: string,
  ) {}

  async write(data: Uint8Array) {
    let off = 0;
    while (off < data.length) {
      if (this.#fill === FRAME_SIZE) await this.#flush(false);
      const n = Math.min(FRAME_SIZE - this.#fill, data.length - off);
      this.#buf.set(data.subarray(off, off + n), this.#fill);
      this.#fill += n;
      off += n;
    }
  }

  finish(): Promise<void> {
    return this.#flush(true);
  }

  async #flush(last: boolean) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: frameAad(this.headerHash, this.#index, last) },
        this.key,
        this.#buf.slice(0, this.#fill),
      ),
    );
    const head = new Uint8Array(5);
    head[0] = last ? 1 : 0;
    head.set(u32(IV_LEN + ct.length), 1);
    await writeAll(this.file, head);
    await writeAll(this.file, iv);
    await writeAll(this.file, ct);
    this.#index++;
    this.#fill = 0;
  }
}

function headerBytes(header: BackupHeader): { prefix: Uint8Array; hash: Promise<string> } {
  const json = enc.encode(JSON.stringify(header));
  const prefix = new Uint8Array(BACKUP_MAGIC.length + 4 + json.length);
  prefix.set(enc.encode(BACKUP_MAGIC), 0);
  prefix.set(u32(json.length), BACKUP_MAGIC.length);
  prefix.set(json, BACKUP_MAGIC.length + 4);
  return {
    prefix,
    hash: crypto.subtle.digest("SHA-256", prefix).then((d) => encodeHex(new Uint8Array(d))),
  };
}

export interface BackupWritten {
  path: string;
  createdAt: string;
  bytes: number;
  files: number;
  schema: number;
}

/** The file name for a backup made at `now`: no case name in it, only the time. */
export function backupFileName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "").replaceAll(":", "").replace("T", "-");
  return `casefile-backup-${stamp}${BACKUP_EXTENSION}`;
}

/**
 * Write a backup of the open case into the folder `dir` (which must exist), as one new file. It is
 * written under a temporary name, flushed, read back and checked in full with the case's key, and
 * only then given its name, so a backup that exists under its name is a whole one.
 */
export async function writeBackup(
  session: CaseSession,
  dir: string,
  opts: { tmpDir: string; app: string | null; now?: Date },
): Promise<BackupWritten> {
  const now = opts.now ?? new Date();
  const path = join(dir, backupFileName(now));
  if (await Deno.lstat(path).catch(() => null)) {
    throw new Error("A backup with that name is already there. Try again in a moment.");
  }
  const snap = await snapshot(session, opts.tmpDir);
  const key = await session.vault.backupKey();
  const bytes = await writeBackupFile(path, snap, key, {
    createdAt: now.toISOString(),
    app: opts.app,
  });
  return {
    path,
    createdAt: now.toISOString(),
    bytes,
    files: snap.files.length,
    schema: snap.schema,
  };
}

/**
 * Write `snap` as a backup file at `path` (the format at the top of this module), encrypted with
 * `key` (`backupKeyFrom` the data key `snap.keyfile` wraps). Exported for tests, which also build
 * backups as older versions of casefile made them. Returns the file's size.
 */
export async function writeBackupFile(
  path: string,
  snap: Snapshot,
  key: CryptoKey,
  meta: { createdAt: string; app: string | null },
): Promise<number> {
  const header: BackupHeader = {
    format: "casefile-backup",
    version: 1,
    createdAt: meta.createdAt,
    app: meta.app,
    publicDbSchema: snap.schema,
    keyfile: snap.keyfile,
  };
  const { prefix, hash } = headerBytes(header);
  const headerHash = await hash;
  const tmp = `${path}.${crypto.randomUUID()}.partial`;
  try {
    const f = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    try {
      await writeAll(f, prefix);
      const w = new FrameWriter(f, key, headerHash);
      for (const file of snap.files) {
        const name = enc.encode(file.path);
        const rec = new Uint8Array(1 + 2 + name.length + 8);
        const dv = new DataView(rec.buffer);
        rec[0] = 0x46; // 'F'
        dv.setUint16(1, name.length);
        rec.set(name, 3);
        dv.setBigUint64(3 + name.length, BigInt(file.data.length));
        await w.write(rec);
        await w.write(file.data);
      }
      const end = new Uint8Array(5);
      end[0] = 0x45; // 'E'
      end.set(u32(snap.files.length), 1);
      await w.write(end);
      await w.finish();
      await f.sync();
    } finally {
      f.close();
    }
    // Read it back as a restore would, with the key it was written with.
    const check = await readBackup(tmp, { key }, null);
    if (check.files !== snap.files.length) throw new Error("The backup didn't read back whole.");
    if (await Deno.lstat(path).catch(() => null)) {
      throw new Error("A backup with that name is already there. Try again in a moment.");
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  return (await Deno.stat(path)).size;
}

// ── reading ─────────────────────────────────────────────────────────────────

async function readExactly(f: Deno.FsFile, n: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(n);
  let off = 0;
  while (off < n) {
    const r = await f.read(out.subarray(off));
    if (r === null) return off === 0 ? null : out.subarray(0, off);
    off += r;
  }
  return out;
}

/** Read a backup's header. Throws NotABackupError if the file isn't one. */
export async function readBackupHeader(
  path: string,
): Promise<{ header: BackupHeader; hash: string; length: number }> {
  const f = await Deno.open(path, { read: true });
  try {
    return await readHeaderFrom(f);
  } finally {
    f.close();
  }
}

async function readHeaderFrom(
  f: Deno.FsFile,
): Promise<{ header: BackupHeader; hash: string; length: number }> {
  const magic = await readExactly(f, BACKUP_MAGIC.length + 4);
  if (
    !magic || magic.length < BACKUP_MAGIC.length + 4 ||
    dec.decode(magic.subarray(0, BACKUP_MAGIC.length)) !== BACKUP_MAGIC
  ) {
    throw new NotABackupError();
  }
  const len = new DataView(magic.buffer, magic.byteOffset).getUint32(BACKUP_MAGIC.length);
  if (len === 0 || len > MAX_HEADER) throw new NotABackupError();
  const json = await readExactly(f, len);
  if (!json || json.length !== len) throw new NotABackupError();
  let header: BackupHeader;
  try {
    header = JSON.parse(dec.decode(json));
  } catch {
    throw new NotABackupError();
  }
  if (
    header?.format !== "casefile-backup" || header.version !== 1 ||
    typeof header.createdAt !== "string" || !Number.isSafeInteger(header.publicDbSchema) ||
    typeof header.keyfile !== "object" || header.keyfile === null
  ) {
    throw new NotABackupError();
  }
  const prefix = new Uint8Array(BACKUP_MAGIC.length + 4 + len);
  prefix.set(magic, 0);
  prefix.set(json, magic.length);
  const hash = encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", prefix)));
  return { header, hash, length: prefix.length };
}

/** Pulls decrypted bytes out of the frames, in order. */
class FrameReader {
  #index = 0;
  #done = false;
  #buf: Uint8Array = new Uint8Array(0);
  #pos = 0;
  constructor(
    private readonly file: Deno.FsFile,
    private readonly key: CryptoKey,
    private readonly headerHash: string,
  ) {}

  /** Decrypt the next frame into the buffer. False once the last frame has been read. */
  async #next(): Promise<boolean> {
    if (this.#done) return false;
    const head = await readExactly(this.file, 5);
    if (!head || head.length < 5) throw new BackupDamagedError("it ends too soon");
    const last = head[0];
    const len = new DataView(head.buffer, head.byteOffset).getUint32(1);
    if (
      (last !== 0 && last !== 1) || len < IV_LEN + TAG_LEN || len > IV_LEN + TAG_LEN + FRAME_SIZE
    ) {
      throw new BackupDamagedError(`part ${this.#index + 1} can't be read`);
    }
    const body = await readExactly(this.file, len);
    if (!body || body.length < len) throw new BackupDamagedError("it ends too soon");
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: body.slice(0, IV_LEN),
            additionalData: frameAad(this.headerHash, this.#index, last === 1),
          },
          this.key,
          body.slice(IV_LEN),
        ),
      );
    } catch {
      throw new BackupDamagedError(
        this.#index === 0
          ? "its first part doesn't match its key"
          : `part ${this.#index + 1} was changed`,
      );
    }
    this.#index++;
    if (last === 1) {
      this.#done = true;
      if ((await readExactly(this.file, 1)) !== null) {
        throw new BackupDamagedError("there is more after its end");
      }
    }
    this.#buf = plain;
    this.#pos = 0;
    return true;
  }

  /** Up to `max` bytes (at least one), or throws if the archive ends first. */
  async some(max: number): Promise<Uint8Array> {
    while (this.#pos >= this.#buf.length) {
      if (!(await this.#next())) throw new BackupDamagedError("it ends too soon");
    }
    const n = Math.min(max, this.#buf.length - this.#pos);
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  async exactly(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    for (let off = 0; off < n;) {
      const part = await this.some(n - off);
      out.set(part, off);
      off += part.length;
    }
    return out;
  }

  /** True once every frame has been read and nothing is left over. */
  async atEnd(): Promise<boolean> {
    while (this.#pos >= this.#buf.length) {
      if (!(await this.#next())) return true;
    }
    return false;
  }
}

/** Where `readBackup` puts each file: null to check the backup without writing anything. */
type Sink = { dir: string } | null;

/**
 * Read a backup through to its end, checking every frame, and (with a sink) write its files into
 * `sink.dir`, which must be empty. With `{ secret }` the data key is unwrapped from the header;
 * with `{ key }` the backup key is given (checking a backup just written).
 */
async function readBackup(
  path: string,
  how: { secret: KeySecret } | { key: CryptoKey },
  sink: Sink,
): Promise<{ header: BackupHeader; files: number }> {
  const f = await Deno.open(path, { read: true });
  try {
    const { header, hash } = await readHeaderFrom(f);
    let key: CryptoKey;
    if ("key" in how) key = how.key;
    else {
      let raw: Uint8Array;
      try {
        raw = await unwrapKeyFile(header.keyfile, how.secret);
      } catch (e) {
        if (e instanceof WrongPassphraseError || e instanceof MalformedRecoveryKeyError) throw e;
        throw new NotABackupError();
      }
      key = await backupKeyFrom(raw);
      raw.fill(0);
    }
    if (header.publicDbSchema > SCHEMA_VERSION) throw new BackupTooNewError(header.publicDbSchema);
    const r = new FrameReader(f, key, hash);
    const seen = new Set<string>();
    while (true) {
      const type = (await r.exactly(1))[0];
      if (type === 0x45) {
        const count = new DataView((await r.exactly(4)).buffer).getUint32(0);
        if (count !== seen.size) throw new BackupDamagedError("its file count is wrong");
        if (!(await r.atEnd())) throw new BackupDamagedError("there is more after its end");
        break;
      }
      if (type !== 0x46) throw new BackupDamagedError("it holds something casefile can't read");
      const plen = new DataView((await r.exactly(2)).buffer).getUint16(0);
      const rel = dec.decode(await r.exactly(plen));
      const size = Number(new DataView((await r.exactly(8)).buffer).getBigUint64(0));
      if (
        !(rel === CASE_MARKER || rel === "public.db" || VAULT_FILE_RE.test(rel)) ||
        rel === "vault/keyfile.enc" || seen.has(rel) || seen.size >= MAX_FILES ||
        !Number.isSafeInteger(size)
      ) {
        throw new BackupDamagedError("it holds a file casefile doesn't expect");
      }
      seen.add(rel);
      let out: Deno.FsFile | null = null;
      if (sink) {
        if (rel.startsWith("vault/")) {
          await Deno.mkdir(join(sink.dir, "vault"), { mode: 0o700 }).catch((e) => {
            if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
          });
        }
        out = await Deno.open(join(sink.dir, rel), { write: true, createNew: true, mode: 0o600 });
      }
      try {
        for (let left = size; left > 0;) {
          const part = await r.some(Math.min(left, FRAME_SIZE));
          if (out) await writeAll(out, part);
          left -= part.length;
        }
        await out?.sync();
      } finally {
        out?.close();
      }
    }
    for (const need of [CASE_MARKER, "public.db", "vault/settings.enc"]) {
      if (!seen.has(need)) throw new BackupDamagedError(`it has no ${need}`);
    }
    return { header, files: seen.size };
  } finally {
    f.close();
  }
}

/** Check a whole backup with the passphrase or recovery key, writing nothing. */
export async function verifyBackup(
  path: string,
  secret: KeySecret,
): Promise<{ header: BackupHeader; files: number }> {
  return await readBackup(path, { secret }, null);
}

export interface Restored {
  root: string;
  header: BackupHeader;
  files: number;
}

/**
 * The folder to restore into must be new, or an empty folder, and not inside a case folder (that
 * case's Claude could then read the restored public.db, and its vault rules don't cover it).
 */
async function checkTarget(target: string): Promise<{ exists: boolean }> {
  const st = await Deno.lstat(target).catch((e) => {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  });
  if (st) {
    if (!st.isDirectory) {
      throw new RestoreTargetError(
        "Something that isn't a folder is already there. Choose a new folder.",
      );
    }
    for await (const _ of Deno.readDir(target)) {
      throw new RestoreTargetError(
        "That folder isn't empty. A backup is only restored into a new, empty folder, never over a case.",
      );
    }
  }
  let parent = dirname(target);
  try {
    parent = await Deno.realPath(parent);
  } catch { /* not made yet */ }
  if (findCaseDir(parent)) {
    throw new RestoreTargetError(
      "That folder is inside a case folder. Choose a folder outside every case.",
    );
  }
  return { exists: Boolean(st) };
}

/**
 * Restore a backup into `target`, a new or empty folder. The whole backup is decrypted and
 * checked into a hidden folder next to `target` first; only a backup that reads through to its
 * end is moved into place, so a wrong key, a damaged or cut-short file, or a backup from a newer
 * casefile leaves nothing behind. With a recovery key, `newPassphrase` replaces the passphrase in
 * the restored copy before it is moved into place (ADR 4: using the recovery key means choosing a
 * new passphrase). The case the backup came from is never touched.
 */
export async function restoreBackup(
  file: string,
  target: string,
  secret: KeySecret,
  opts: { newPassphrase?: string; kdfIterations?: number } = {},
): Promise<Restored> {
  target = resolve(target);
  if ("recoveryKey" in secret && !opts.newPassphrase) {
    throw new Error("A new passphrase is needed with a recovery key");
  }
  const { exists } = await checkTarget(target);
  // Unwrap before anything is written: a wrong passphrase leaves no trace.
  const { header } = await readBackupHeader(file);
  let key: CryptoKey;
  try {
    const raw = await unwrapKeyFile(header.keyfile, secret);
    key = await backupKeyFrom(raw);
    raw.fill(0);
  } catch (e) {
    if (e instanceof WrongPassphraseError || e instanceof MalformedRecoveryKeyError) throw e;
    throw new NotABackupError();
  }
  if (header.publicDbSchema > SCHEMA_VERSION) throw new BackupTooNewError(header.publicDbSchema);
  const parent = dirname(target);
  await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.${basename(target)}.restoring-${crypto.randomUUID()}`);
  await Deno.mkdir(staging, { mode: 0o700 });
  try {
    // The key only opens the frames if the header read now is the one it was unwrapped from.
    const r = await readBackup(file, { key }, { dir: staging });
    // The keyfile came in the header, which every frame's check covers.
    await Deno.writeTextFile(
      join(staging, "vault", "keyfile.json"),
      JSON.stringify(r.header.keyfile, null, 2),
      { createNew: true, mode: 0o600 },
    );
    if ("recoveryKey" in secret) {
      const v = await Vault.openWithRecovery(join(staging, "vault"), secret.recoveryKey);
      await v.changePassphrase(opts.newPassphrase!, opts.kdfIterations);
    }
    // Move into place. Over an empty folder, rename replaces it; if anything appeared in it
    // meanwhile, the rename fails and nothing is lost.
    if (!exists && (await Deno.lstat(target).catch(() => null))) {
      throw new RestoreTargetError(
        "Something appeared in that folder meanwhile. Choose a new folder.",
      );
    }
    try {
      await Deno.rename(staging, target);
    } catch (e) {
      throw new RestoreTargetError(
        `casefile couldn't put the restored case in that folder (${(e as Error).message}).`,
      );
    }
    return { root: casePaths(target).root, header: r.header, files: r.files };
  } catch (e) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw e;
  }
}
