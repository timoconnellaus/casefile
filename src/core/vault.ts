import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { dirname, join } from "@std/path";

/**
 * The vault (ADR 0004): a directory of AES-256-GCM encrypted files.
 *
 *   vault/keyfile.json   KDF parameters + the data key, wrapped with a passphrase-derived key,
 *                        and optionally wrapped again with a recovery-key-derived key (v2)
 *   vault/<name>.enc     12-byte IV ‖ ciphertext; the file name is bound in as associated data
 *
 * Only the desktop app imports this module. The Claude-facing CLI must never reach it
 * (enforced by tests/boundary_test.ts).
 */

export const KDF_ITERATIONS = 600_000;
const KEYFILE = "keyfile.json";
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,95}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (u: Uint8Array): Bytes => new Uint8Array(u) as Bytes;

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "WrongPassphraseError";
  }
}

/**
 * A wrong recovery key. It is a WrongPassphraseError, so it counts toward the same per-vault
 * lockout as wrong passphrases (ADR 13, amended).
 */
export class WrongRecoveryKeyError extends WrongPassphraseError {
  constructor() {
    super();
    this.message = "Wrong recovery key";
    this.name = "WrongRecoveryKeyError";
  }
}

/** Text that cannot be a recovery key (wrong length or letters). Says nothing about the vault. */
export class MalformedRecoveryKeyError extends Error {
  constructor() {
    super("That is not a recovery key. A recovery key has 32 letters and numbers.");
    this.name = "MalformedRecoveryKeyError";
  }
}

/**
 * The vault folder at this path is no longer the one this Vault opened: the case folder was
 * deleted and made again (e.g. a new case created over it), or moved. Writing would put files
 * encrypted with this vault's key into another vault, where they fail their integrity check.
 */
export class VaultReplacedError extends Error {
  constructor(dir: string) {
    super(`The case folder was replaced or moved while it was open: ${dir}`);
    this.name = "VaultReplacedError";
  }
}

export class VaultCorruptError extends Error {
  constructor(name: string) {
    super(`Vault file failed its integrity check: ${name}`);
    this.name = "VaultCorruptError";
  }
}

/** A data key wrapped with a key derived by PBKDF2 from a secret (passphrase or recovery key). */
interface Wrap {
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  wrapped: { iv: string; data: string };
}

/**
 * `keyfile.json`. Version 1 holds the passphrase wrap only. Version 2 adds an optional `recovery`
 * wrap (ADR 4, amended). A keyfile without a recovery wrap is still written as version 1, so a
 * case without a recovery key opens in older builds.
 */
interface KeyFile extends Wrap {
  format: "casefile-vault";
  version: 1 | 2;
  recovery?: Wrap & { createdAt: string };
}

/** Associated data for each wrap, so a recovery wrap can't be passed off as a passphrase wrap. */
const AAD_PASSPHRASE = "casefile-data-key";
const AAD_RECOVERY = "casefile-data-key-recovery";

// ── recovery keys ────────────────────────────────────────────────────────────
//
// 160 random bits in Crockford base32 (no I, L, O or U, so nothing is easily misread): 32
// characters, shown in 8 groups of 4. Reading one back ignores case, spaces and hyphens, and maps
// O → 0 and I/L → 1, as Crockford specifies.

export const RECOVERY_KEY_BYTES = 20;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Format 20 key bytes as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.length !== RECOVERY_KEY_BYTES) throw new Error("A recovery key is 20 bytes");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of key) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/** Read a recovery key the user typed. Returns null if the text cannot be one. */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (clean.length !== 32) return null;
  const out = new Uint8Array(RECOVERY_KEY_BYTES);
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[n++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

// ── key wrapping ─────────────────────────────────────────────────────────────

async function deriveKek(
  secret: string | Uint8Array,
  salt: Bytes,
  iterations: number,
): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? enc.encode(secret) : bytes(secret);
  const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrapKey(
  rawKey: Bytes,
  secret: string | Uint8Array,
  iterations: number,
  aad: string,
): Promise<Wrap> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKek(secret, salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
      kek,
      rawKey,
    ),
  );
  return {
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: encodeBase64(salt) },
    wrapped: { iv: encodeBase64(iv), data: encodeBase64(wrapped) },
  };
}

/** Unwrap the data key; undefined if the secret is wrong or the wrap was tampered with. */
async function unwrapKey(
  w: Wrap,
  secret: string | Uint8Array,
  aad: string,
): Promise<Bytes | undefined> {
  const kek = await deriveKek(secret, bytes(decodeBase64(w.kdf.salt)), w.kdf.iterations);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes(decodeBase64(w.wrapped.iv)),
          additionalData: enc.encode(aad),
        },
        kek,
        bytes(decodeBase64(w.wrapped.data)),
      ),
    );
  } catch {
    return undefined;
  }
}

async function readKeyFile(dir: string): Promise<KeyFile> {
  const kf: KeyFile = JSON.parse(await Deno.readTextFile(join(dir, KEYFILE)));
  if (kf.format !== "casefile-vault" || (kf.version !== 1 && kf.version !== 2)) {
    throw new Error("Unsupported vault format");
  }
  return kf;
}

/**
 * Keyfile changes are read-modify-write (the passphrase and recovery wraps change separately), so
 * they run one at a time per vault folder.
 */
const keyFileQueues = new Map<string, Promise<unknown>>();
function updateKeyFile(
  dir: string,
  fn: (kf: KeyFile | undefined) => Promise<KeyFile>,
): Promise<void> {
  const run = async () => {
    let kf: KeyFile | undefined;
    try {
      kf = await readKeyFile(dir);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    const next = await fn(kf);
    next.version = next.recovery ? 2 : 1;
    await atomicWrite(join(dir, KEYFILE), JSON.stringify(next, null, 2));
  };
  let key = dir;
  try {
    key = Deno.realPathSync(dir);
  } catch { /* not created yet */ }
  const prev = keyFileQueues.get(key) ?? Promise.resolve();
  const result = prev.then(run, run);
  keyFileQueues.set(key, result.catch(() => {}));
  return result;
}

function checkName(name: string) {
  if (!NAME_RE.test(name) || name === "keyfile" || name.includes("..")) {
    throw new Error(`Invalid vault file name: ${JSON.stringify(name)}`);
  }
}

/**
 * Write `path` all at once: the data goes to a temporary file in the same folder, is flushed to
 * disk, and is then renamed over `path`, so a reader (or a crash) sees the old file or the new
 * one, never a part-written one. `beforeRename` runs last, just before the rename.
 */
async function atomicWrite(
  path: string,
  data: Uint8Array | string,
  beforeRename?: () => Promise<void>,
) {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const f = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    try {
      const buf = typeof data === "string" ? enc.encode(data) : data;
      for (let off = 0; off < buf.length;) off += await f.write(buf.subarray(off));
      await f.sync();
    } finally {
      f.close();
    }
    await beforeRename?.();
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  await syncDir(dirname(path));
}

/** Flush a folder's entries (the rename) to disk, where the platform allows it. */
async function syncDir(dir: string) {
  try {
    const d = await Deno.open(dir, { read: true });
    try {
      await d.sync();
    } finally {
      d.close();
    }
  } catch {
    // Not every platform can open or flush a folder; the file itself is already on disk.
  }
}

/** What identifies a folder on disk: its device and inode (null where the platform has none). */
async function folderId(dir: string): Promise<string | null> {
  const st = await Deno.stat(dir);
  return st.ino === null || st.dev === null ? null : `${st.dev}:${st.ino}`;
}

export class Vault {
  private constructor(
    readonly dir: string,
    private dataKey: CryptoKey,
    private rawKey: Bytes,
    /** The vault folder's identity when it was opened (`folderId`), checked before each write. */
    private readonly folder: string | null,
  ) {}

  /**
   * Refuse to write if the folder at `dir` is not the one this vault was opened from (it was
   * deleted and made again, or moved). Without this, a session left open on a case that was then
   * replaced (e.g. re-seeded with --force) writes files the new case's key cannot read.
   */
  async #checkFolder() {
    if (this.folder === null) return;
    let now: string | null;
    try {
      now = await folderId(this.dir);
    } catch {
      throw new VaultReplacedError(this.dir);
    }
    if (now !== this.folder) throw new VaultReplacedError(this.dir);
  }

  static async exists(dir: string): Promise<boolean> {
    try {
      await Deno.stat(join(dir, KEYFILE));
      return true;
    } catch {
      return false;
    }
  }

  static async create(
    dir: string,
    passphrase: string,
    iterations = KDF_ITERATIONS,
  ): Promise<Vault> {
    if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
    if (await Vault.exists(dir)) throw new Error(`A vault already exists at ${dir}`);
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const w = await wrapKey(rawKey, passphrase, iterations, AAD_PASSPHRASE);
    await updateKeyFile(dir, () => Promise.resolve({ format: "casefile-vault", version: 1, ...w }));
    return new Vault(dir, await Vault.#importDataKey(rawKey), rawKey, await folderId(dir));
  }

  /** Open with the passphrase. Reads keyfile versions 1 and 2. */
  static async open(dir: string, passphrase: string): Promise<Vault> {
    const kf = await readKeyFile(dir);
    const rawKey = await unwrapKey(kf, passphrase, AAD_PASSPHRASE);
    if (!rawKey) throw new WrongPassphraseError();
    return new Vault(dir, await Vault.#importDataKey(rawKey), rawKey, await folderId(dir));
  }

  /**
   * Open with the recovery key (ADR 4, amended). Throws MalformedRecoveryKeyError for text that
   * cannot be a key, and WrongRecoveryKeyError when the key is wrong *or* the vault has no
   * recovery key (a PBKDF2 derivation runs either way, so the two take the same time).
   *
   * The keyfile is not authenticated, so something that can write it could swap in a recovery
   * wrap of a key of its own. The recovered key must therefore decrypt an existing vault file
   * before it is trusted; otherwise re-wrapping it under a new passphrase would replace the real
   * data key and lose the vault.
   */
  static async openWithRecovery(dir: string, recoveryKey: string): Promise<Vault> {
    const key = parseRecoveryKey(recoveryKey);
    if (!key) throw new MalformedRecoveryKeyError();
    const kf = await readKeyFile(dir);
    const wrap: Wrap = kf.recovery ?? {
      // No recovery key: spend the same effort on a throwaway derivation, then refuse.
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: kf.kdf.iterations,
        salt: encodeBase64(crypto.getRandomValues(new Uint8Array(16))),
      },
      wrapped: { iv: encodeBase64(new Uint8Array(12)), data: encodeBase64(new Uint8Array(48)) },
    };
    const rawKey = await unwrapKey(wrap, key, AAD_RECOVERY);
    if (!kf.recovery || !rawKey) throw new WrongRecoveryKeyError();
    const vault = new Vault(dir, await Vault.#importDataKey(rawKey), rawKey, await folderId(dir));
    const files = await vault.list();
    if (files.length === 0) throw new VaultCorruptError(KEYFILE);
    await vault.read(files[0]); // throws VaultCorruptError if this is not the vault's key
    return vault;
  }

  static #importDataKey(raw: Bytes): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  /**
   * Re-wrap the data key under a new passphrase. File contents and any recovery key are
   * untouched.
   */
  async changePassphrase(newPassphrase: string, iterations = KDF_ITERATIONS): Promise<void> {
    if (newPassphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
    const w = await wrapKey(this.rawKey, newPassphrase, iterations, AAD_PASSPHRASE);
    await this.#checkFolder();
    await updateKeyFile(this.dir, (kf) =>
      Promise.resolve({
        format: "casefile-vault",
        version: 1,
        ...w,
        ...(kf?.recovery ? { recovery: kf.recovery } : {}),
      }));
  }

  /**
   * Make a new recovery key, replacing any earlier one, and return it formatted for the user.
   * It is returned once: only its wrap of the data key is stored. Callers must check the
   * passphrase first (rotation requires it, ADR 4).
   */
  async setRecoveryKey(iterations = KDF_ITERATIONS): Promise<string> {
    const key = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
    const w = await wrapKey(this.rawKey, key, iterations, AAD_RECOVERY);
    await this.#checkFolder();
    await updateKeyFile(this.dir, (kf) => {
      if (!kf) throw new Error("The vault has no keyfile");
      return Promise.resolve({ ...kf, recovery: { ...w, createdAt: new Date().toISOString() } });
    });
    const text = formatRecoveryKey(key);
    key.fill(0);
    return text;
  }

  /** Remove the recovery key: from now on only the passphrase opens the vault. */
  async removeRecoveryKey(): Promise<void> {
    await this.#checkFolder();
    await updateKeyFile(this.dir, (kf) => {
      if (!kf) throw new Error("The vault has no keyfile");
      const { recovery: _r, ...rest } = kf;
      return Promise.resolve({ ...rest, version: 1 });
    });
  }

  /** Whether a recovery key is set, and when it was made. */
  async recoveryInfo(): Promise<{ set: boolean; createdAt: string | null }> {
    const kf = await readKeyFile(this.dir);
    return { set: Boolean(kf.recovery), createdAt: kf.recovery?.createdAt ?? null };
  }

  /** A key for signing records (verification marks), derived from — but separate to — the data key. */
  async macKey(): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", this.rawKey, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: enc.encode("casefile-verification-mac"),
      },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  }

  /** Raw key bytes for the AI-use log's hash chain (ADR 8), derived from the data key. */
  async logChainKey(): Promise<Uint8Array> {
    const base = await crypto.subtle.importKey("raw", this.rawKey, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(32),
          info: enc.encode("casefile-log-chain"),
        },
        base,
        256,
      ),
    );
  }

  #path(name: string) {
    checkName(name);
    return join(this.dir, `${name}.enc`);
  }

  async write(name: string, plaintext: Uint8Array): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(name) },
        this.dataKey,
        bytes(plaintext),
      ),
    );
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    await this.#checkFolder();
    await atomicWrite(this.#path(name), out, () => this.#checkFolder());
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    let buf: Uint8Array;
    try {
      buf = await Deno.readFile(this.#path(name));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return undefined;
      throw e;
    }
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: buf.slice(0, 12), additionalData: enc.encode(name) },
          this.dataKey,
          buf.slice(12),
        ),
      );
    } catch {
      throw new VaultCorruptError(name);
    }
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.write(name, enc.encode(JSON.stringify(value)));
  }

  async readJson<T>(name: string): Promise<T | undefined> {
    const bytes = await this.read(name);
    return bytes === undefined ? undefined : JSON.parse(dec.decode(bytes)) as T;
  }

  /**
   * Move a vault file that cannot be read out of the way, keeping it beside the vault for
   * inspection (as `<name>.damaged-<time>`, which `list` and `read` never see). Returns the name
   * it was kept under, or null if there was no such file.
   */
  async setAside(name: string): Promise<string | null> {
    await this.#checkFolder();
    const kept = `${name}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await Deno.rename(this.#path(name), join(this.dir, kept));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
    await syncDir(this.dir);
    return kept;
  }

  async delete(name: string): Promise<void> {
    await this.#checkFolder();
    try {
      await Deno.remove(this.#path(name));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(this.dir)) {
      if (entry.isFile && entry.name.endsWith(".enc")) {
        const n = entry.name.slice(0, -4);
        if (n.startsWith(prefix)) names.push(n);
      }
    }
    return names.sort();
  }
}
