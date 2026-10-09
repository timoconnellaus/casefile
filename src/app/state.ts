import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { Detector } from "../core/detect/types.ts";
import { casePaths, isCaseDir } from "../core/case.ts";
import { InvalidInputError } from "../core/publicdb.ts";
import { CaseInUseError, CaseLock } from "../core/caselock.ts";
import { CaseSession, type CaseSettings } from "../core/session.ts";
import { KDF_ITERATIONS, Vault, VaultCorruptError, WrongPassphraseError } from "../core/vault.ts";
import { HttpError } from "./routes/context.ts";
import type { ClaudeCodeEnv } from "./claudecode.ts";
import type { BuildInfo } from "./build.ts";
import type { Updates, UpdateStatus } from "./updates.ts";
import { backupCase } from "./upgrade_backup.ts";
import { newToken, readCookie, safeEqual } from "./security.ts";

/** App-wide configuration kept outside any case folder. Holds no case content. */
export interface AppConfig {
  lastCase?: string;
  /**
   * The desktop version that last opened each case (by folder). A case is backed up before a new
   * version first opens it, since public.db migrations only go forward (ADR 23).
   */
  openedWith?: Record<string, string>;
  /**
   * The last-opened case's idle-lock setting (15, 30 or 60), copied here so the locked screen and
   * `/api/status` can say "Locks after N min idle" without opening the vault. Not sensitive.
   */
  idleLockMinutes?: number;
}

export interface LlmCheck {
  local: boolean;
  confirmed: boolean;
  reason: string;
}

export interface AppStateOptions {
  configDir: string;
  /** Builds the optional detectors (NER, LLM) from a case's settings. */
  detectorFactory?: (settings: CaseSettings) => Promise<Detector[]> | Detector[];
  /** Classifies the configured LLM endpoint as local or remote. */
  llmChecker?: (settings: CaseSettings) => Promise<LlmCheck>;
  /** KDF iterations for new vaults (tests use fewer). */
  kdfIterations?: number;
  /**
   * Lock after this much inactivity, overriding the case's setting (tests). Without it the case's
   * `idleLockMinutes` applies (default 30).
   */
  idleLockMs?: number;
  home?: string;
  /** Where to look for `claude`/`casefile`, and how to open Terminal (tests replace these). */
  claudeCode?: ClaudeCodeEnv;
  /** Which copy of casefile this is, for `/api/status` (ADR 22). */
  build?: BuildInfo;
  /** Desktop updates (ADR 23): whether one is ready. */
  updates?: Updates;
  /** Start the updated app (a new instance of the bundle); main.ts supplies it. */
  relaunch?: () => Promise<void>;
  /**
   * A development run (`deno task dev`) opens and creates cases only inside this folder, so a
   * build being worked on can never open, and migrate, the case in daily use (ADR 22).
   */
  caseRoot?: string;
}

/** Idle-lock choices offered in Settings (ADR 13, amended). */
export const IDLE_LOCK_MINUTES = [15, 30, 60] as const;
export const DEFAULT_IDLE_LOCK_MINUTES = 30;

/**
 * The longest wait after wrong passphrases. Any local process can make wrong guesses (ADR 13), so
 * a long lockout would let it keep the user out of their own case; two minutes still limits a
 * guesser to about 720 attempts a day once the doubling has reached the cap.
 */
export const MAX_LOCKOUT_MS = 2 * 60_000;

/** Wait after `failures` wrong passphrases: none for the first 2, then 2 s doubling, capped. */
export function lockoutMs(failures: number): number {
  return failures < 3 ? 0 : Math.min(MAX_LOCKOUT_MS, 1000 * 2 ** (failures - 2));
}

/** Shown when the open case's folder was deleted and made again, or moved (ADR 4, amended). */
export const CASE_REPLACED_MESSAGE =
  "This case's folder was replaced while it was open; open it again.";

export class AppState {
  session: CaseSession | null = null;
  token: string | null = null;
  /**
   * Why the case was last locked, when it was not the user's doing (the folder was replaced).
   * Shown on the unlock screen until a case is opened. A fixed sentence: nothing about the case.
   */
  lockNotice: string | null = null;
  config: AppConfig = {};
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wrong-passphrase counts, per vault (keyed by its resolved path). */
  #limits = new Map<string, { failures: number; lockedUntil: number }>();
  /** Passphrase checks run one at a time, so parallel guesses can't race past the limit. */
  #passphraseQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly opts: AppStateOptions) {}

  async load() {
    try {
      this.config = JSON.parse(await Deno.readTextFile(join(this.opts.configDir, "config.json")));
    } catch {
      this.config = {};
    }
  }

  async #saveConfig() {
    await Deno.mkdir(this.opts.configDir, { recursive: true });
    await Deno.writeTextFile(
      join(this.opts.configDir, "config.json"),
      JSON.stringify(this.config, null, 2),
    );
  }

  /**
   * The folder to suggest for a new case: the first `~/Documents/casefile/case-N` that doesn't
   * exist yet, as the user types it (`~/…`).
   */
  async suggestCaseDir(): Promise<string> {
    // A development run suggests a folder it will open (ADR 22).
    if (this.opts.caseRoot) {
      for (let n = 1; n < 1000; n++) {
        const dir = join(this.opts.caseRoot, `case-${n}`);
        if (!(await Deno.lstat(dir).catch(() => null))) return dir;
      }
    }
    const home = this.opts.home ?? Deno.env.get("HOME") ?? ".";
    for (let n = 1; n < 1000; n++) {
      try {
        await Deno.lstat(join(home, "Documents", "casefile", `case-${n}`));
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return `~/Documents/casefile/case-${n}`;
        break; // can't look (permissions): don't guess further
      }
    }
    return "~/Documents/casefile/case-1";
  }

  #expand(dir: string): string {
    const home = this.opts.home ?? Deno.env.get("HOME") ?? ".";
    const path = dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
    const root = this.opts.caseRoot;
    if (root) {
      const rel = relative(resolve(root), resolve(path));
      if (rel === "" || rel === ".." || rel.startsWith(`..${SEPARATOR}`) || isAbsolute(rel)) {
        throw new HttpError(
          403,
          `This is a development copy of casefile. It only opens cases inside ${root}.`,
        );
      }
    }
    return path;
  }

  get build(): BuildInfo {
    return this.opts.build ?? { version: null, dev: false };
  }

  get updateStatus(): UpdateStatus {
    return this.opts.updates?.status ?? { enabled: false, ready: null, rolledBack: false };
  }

  /**
   * Restart into the staged update (ADR 23): close the case as quitting does (its writes finish,
   * its lock is released), then start the new version. The user unlocks the case again.
   */
  async restartForUpdate(): Promise<void> {
    if (!this.updateStatus.ready || !this.opts.relaunch) {
      throw new HttpError(409, "There is no update waiting.");
    }
    await this.shutdown();
    await this.opts.relaunch();
  }

  /**
   * The first time this version opens `root`, back the case up first: opening can migrate
   * public.db, and an earlier version can't open it after that (ADR 23). Only a desktop build has
   * a version; the case must not be open (the backup takes its lock).
   */
  async #backupBeforeNewVersion(root: string): Promise<void> {
    const version = this.build.version;
    const key = casePaths(root).root;
    if (!version || this.config.openedWith?.[key] === version) return;
    try {
      await backupCase(key, join(this.opts.configDir, "backups"), {
        release: version,
        previous: this.config.openedWith?.[key] ?? null,
      });
    } catch (e) {
      if (e instanceof HttpError || e instanceof CaseInUseError) throw e;
      throw new HttpError(
        500,
        "casefile couldn't back up the case before this version opened it for the first time, " +
          `so it wasn't opened: ${(e as Error).message}`,
      );
    }
  }

  async #adopt(session: CaseSession) {
    this.lock();
    this.lockNotice = null;
    this.session = session;
    this.token = newToken();
    this.config.lastCase = session.paths.root;
    if (this.build.version) {
      this.config.openedWith = {
        ...this.config.openedWith,
        [session.paths.root]: this.build.version,
      };
    }
    this.config.idleLockMinutes = this.idleLockMinutes();
    try {
      await this.#saveConfig();
      await this.configureDetectors();
    } catch (e) {
      // The cookie is only sent on success: never leave a case unlocked that nobody can use.
      this.lock();
      throw e;
    }
    this.touch();
  }

  /** True if the request carries this session's cookie. */
  isSignedIn(req: Request): boolean {
    const c = readCookie(req);
    return Boolean(this.session && this.token && c && safeEqual(c, this.token));
  }

  /**
   * Opening or creating a case replaces the current session. Only the signed-in user may do that,
   * so another local process cannot lock the user out by opening a case of its own.
   */
  requireNoOtherSession(req: Request) {
    if (this.session && !this.isSignedIn(req)) {
      throw new HttpError(409, "A case is already open in casefile. Lock it there first.");
    }
  }

  /** Seconds until another passphrase attempt is allowed for any case (0 if allowed now). */
  retryAfterSeconds(): number {
    let until = 0;
    for (const l of this.#limits.values()) until = Math.max(until, l.lockedUntil);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  async #limitKey(vaultDir: string): Promise<string> {
    try {
      return await Deno.realPath(vaultDir);
    } catch {
      return vaultDir;
    }
  }

  /**
   * Passphrase attempts are rate limited: the API is reachable by any local process, so without
   * this a script could guess passphrases as fast as PBKDF2 allows. After 3 failures for a vault,
   * each further failure doubles its wait (2 s, 4 s, … up to MAX_LOCKOUT_MS, 2 minutes).
   *
   * - Attempts are serialised: parallel requests can't all pass the check before any fails.
   * - Limits are per vault, and only a success on *that* vault resets them, so unlocking some
   *   other case (e.g. one created with a known passphrase) does not clear the count.
   */
  /**
   * `fn` receives the resolved vault path and must open exactly that path: the limit key and the
   * vault that is checked are the same file, so swapping a symlink in between cannot charge the
   * attempt to a different vault.
   */
  #withPassphrase<T>(vaultDir: string, fn: (resolvedVaultDir: string) => Promise<T>): Promise<T> {
    const run = async () => {
      const key = await this.#limitKey(vaultDir);
      const limit = this.#limits.get(key) ?? { failures: 0, lockedUntil: 0 };
      const wait = Math.ceil((limit.lockedUntil - Date.now()) / 1000);
      if (wait > 0) {
        throw new HttpError(
          429,
          `Too many wrong passphrases or recovery keys. Wait ${wait} seconds, then try again. ` +
            `(Any program on this computer can cause this wait; it never lasts more than 2 minutes.)`,
          {
            retryAfterSeconds: wait,
          },
        );
      }
      try {
        const r = await fn(key);
        this.#limits.delete(key);
        return r;
      } catch (e) {
        if (e instanceof WrongPassphraseError) {
          limit.failures++;
          if (limit.failures >= 3) limit.lockedUntil = Date.now() + lockoutMs(limit.failures);
          this.#limits.set(key, limit);
        }
        throw e;
      }
    };
    const result = this.#passphraseQueue.then(run, run);
    this.#passphraseQueue = result.catch(() => {});
    return result;
  }

  /**
   * Create a case. With `recoveryKey`, also make a recovery key and return it: this is the only
   * time it is shown (ADR 4, amended).
   */
  async createCase(
    dir: string,
    passphrase: string,
    label: string,
    opts: { recoveryKey?: boolean } = {},
  ): Promise<{ recoveryKey?: string }> {
    const target = this.#expand(dir);
    // Another casefile has a case open there (ADR 4, amended): say so, not just "not empty".
    await CaseLock.refuseIfHeld(target);
    // Never scaffold into an existing folder: creating a case writes CLAUDE.md and .claude/.
    try {
      for await (const _ of Deno.readDir(target)) {
        throw new HttpError(
          409,
          "That folder already exists and is not empty. Choose a new folder for the case.",
        );
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    if (passphrase.length < 12) {
      throw new HttpError(400, "Use a passphrase of at least 12 characters");
    }
    const s = await CaseSession.create(target, passphrase, label, {
      kdfIterations: this.opts.kdfIterations,
    });
    await this.#adopt(s);
    if (!opts.recoveryKey) return {};
    const recoveryKey = await s.vault.setRecoveryKey(this.#iterations);
    await s.updateSettings({ recoveryKey: true });
    s.log("user", "recovery_key_created", {});
    return { recoveryKey };
  }

  get #iterations(): number {
    return this.opts.kdfIterations ?? KDF_ITERATIONS;
  }

  /**
   * Forgotten passphrase: open the case with its recovery key and set a new passphrase (ADR 4,
   * amended). The recovery key goes through the same per-vault limit as passphrases, so a wrong
   * one counts toward the lockout. The recovery key stays valid; Settings can replace it.
   */
  async recoverCase(dir: string, recoveryKey: string, newPassphrase: string) {
    const root = this.#expand(dir);
    if (newPassphrase.length < 12) {
      throw new HttpError(400, "Use a new passphrase of at least 12 characters");
    }
    const paths = casePaths(root);
    if (!isCaseDir(paths.root)) {
      throw new InvalidInputError(`That folder is not a casefile case: ${paths.root}`);
    }
    // Before the passphrase changes: the open below would refuse anyway (ADR 4, amended).
    await CaseLock.refuseIfHeld(paths.root);
    try {
      await this.#withPassphrase(paths.vaultDir, async (vaultDir) => {
        const v = await Vault.openWithRecovery(vaultDir, recoveryKey);
        await v.changePassphrase(newPassphrase, this.#iterations);
      });
    } catch (e) {
      if (e instanceof VaultCorruptError) {
        throw new HttpError(
          409,
          "This recovery key does not open this case's files, so nothing was changed. " +
            "The case's key file may have been altered.",
        );
      }
      throw e;
    }
    // As in `openCase`: the open session ends before the new one opens.
    if (await this.#isOpen(root)) await this.lock();
    else await this.#backupBeforeNewVersion(root);
    const s = await CaseSession.open(root, newPassphrase);
    await this.#adopt(s);
    s.log("user", "passphrase_reset_with_recovery_key", {});
  }

  /**
   * Make a new recovery key for the open case, replacing any earlier one. Requires the current
   * passphrase (rate limited like unlocking). Returns the key: it is shown once and not stored.
   */
  async rotateRecoveryKey(passphrase: string): Promise<{ recoveryKey: string; replaced: boolean }> {
    const s = this.#open();
    const v = await this.#withPassphrase(s.paths.vaultDir, (d) => Vault.open(d, passphrase));
    const replaced = (await v.recoveryInfo()).set;
    const recoveryKey = await v.setRecoveryKey(this.#iterations);
    await s.updateSettings({ recoveryKey: true });
    s.log("user", replaced ? "recovery_key_replaced" : "recovery_key_created", {});
    return { recoveryKey, replaced };
  }

  /** Remove the open case's recovery key. Requires the current passphrase. */
  async removeRecoveryKey(passphrase: string) {
    const s = this.#open();
    const v = await this.#withPassphrase(s.paths.vaultDir, (d) => Vault.open(d, passphrase));
    await v.removeRecoveryKey();
    await s.updateSettings({ recoveryKey: false });
    s.log("user", "recovery_key_removed", {});
  }

  #open(): CaseSession {
    if (!this.session) throw new HttpError(423, "The case is locked");
    return this.session;
  }

  /**
   * Open a case. Opening the case that is open already (the window lost its cookie) ends the open
   * session first, and waits for its writes and its public.db: the lock is shared within this
   * process, so nothing else keeps the two apart. Opening repairs public.db against the vault
   * (`reconcilePublic`); a session still writing meanwhile would have a document it just shared
   * withdrawn (the repair's list of documents did not have it), or its new text overwritten with
   * what the vault said a moment before.
   */
  async openCase(dir: string, passphrase: string) {
    const root = this.#expand(dir);
    const s = await this.#withPassphrase(casePaths(root).vaultDir, async (vaultDir) => {
      if (await this.#isOpen(root)) {
        // Only the right passphrase ends the open session: anyone can call this route.
        await Vault.open(vaultDir, passphrase);
        await this.lock();
      } else if (
        this.build.version && this.config.openedWith?.[casePaths(root).root] !== this.build.version
      ) {
        // Only the right passphrase makes a backup.
        await Vault.open(vaultDir, passphrase);
        await this.#backupBeforeNewVersion(root);
      }
      return CaseSession.open(root, passphrase);
    });
    await this.#adopt(s);
  }

  /** Whether `root` is the folder of the case open now (same folder, not just the same path). */
  async #isOpen(root: string): Promise<boolean> {
    const open = this.session?.paths.root;
    if (!open) return false;
    try {
      const [a, b] = await Promise.all([Deno.stat(open), Deno.stat(root)]);
      return a.dev === b.dev && a.ino === b.ino && a.ino !== null;
    } catch {
      return false;
    }
  }

  /** Confirm the passphrase for sensitive actions (throws WrongPassphraseError). */
  async verifyPassphrase(passphrase: string) {
    if (!this.session) throw new Error("No case is open");
    const vaultDir = this.session.paths.vaultDir;
    await this.#withPassphrase(vaultDir, (vault) => Vault.open(vault, passphrase));
  }

  /**
   * Lock the case. Access ends at once (the session and token are dropped before this returns);
   * the returned promise settles once every vault write still in flight has finished and the
   * store is closed. Await it before the process exits, or the last writes are lost.
   */
  lock(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.token = null;
    clearTimeout(this.#idleTimer);
    if (!s) return Promise.resolve();
    try {
      s.log("user", "case_locked");
    } catch { /* the store may already be gone; locking must still close it */ }
    const closed = s.closeSettled().catch(() => {});
    this.#closing.add(closed);
    closed.finally(() => this.#closing.delete(closed));
    return closed;
  }

  /**
   * The open case's folder was replaced (deleted and made again, or moved) while it was open:
   * lock it, and say why on the unlock screen. The session's store and vault already refuse all
   * use, so locking only closes them; nothing reaches the case now at that path.
   */
  lockReplaced(): Promise<void> {
    this.lockNotice = CASE_REPLACED_MESSAGE;
    return this.lock();
  }

  /** If the open case's folder was replaced, lock it (`lockReplaced`). True if it was. */
  async checkReplaced(): Promise<boolean> {
    if (!this.session?.folderReplaced()) return false;
    await this.lockReplaced();
    return true;
  }

  /** Sessions that are locked but still finishing their vault writes. */
  #closing = new Set<Promise<void>>();

  /** Lock the case and wait for every locked session's writes (before the process exits). */
  async shutdown(): Promise<void> {
    await this.lock();
    await Promise.all([...this.#closing]);
  }

  /** The open case's idle-lock setting, in minutes. */
  idleLockMinutes(): number {
    const m = this.session?.settings.idleLockMinutes;
    return m && (IDLE_LOCK_MINUTES as readonly number[]).includes(m)
      ? m
      : DEFAULT_IDLE_LOCK_MINUTES;
  }

  /** The folder of the last case opened in this app, if any. */
  lastCaseDir(): string | null {
    return this.config.lastCase ?? null;
  }

  /**
   * "Locks after N min idle" for someone who isn't signed in: the last-opened case's setting
   * (an app-level copy), or the default.
   */
  lastIdleLockMinutes(): number {
    const m = this.config.idleLockMinutes;
    return m && (IDLE_LOCK_MINUTES as readonly number[]).includes(m)
      ? m
      : DEFAULT_IDLE_LOCK_MINUTES;
  }

  /** Keep the app-level copy of the idle-lock setting in step after Settings changes it. */
  async rememberIdleLock() {
    if (!this.session) return;
    const m = this.idleLockMinutes();
    if (this.config.idleLockMinutes === m) return;
    this.config.idleLockMinutes = m;
    try {
      await this.#saveConfig();
    } catch {
      // only a convenience for the locked screen
    }
  }

  /** How long the open case may sit idle before it locks (0: never, tests only). */
  idleLockMs(): number {
    return this.opts.idleLockMs ?? this.idleLockMinutes() * 60_000;
  }

  /** Reset the idle auto-lock timer. */
  touch() {
    clearTimeout(this.#idleTimer);
    const ms = this.idleLockMs();
    if (ms > 0 && this.session) {
      const t = setTimeout(() => this.lock(), ms);
      Deno.unrefTimer(t as unknown as number);
      this.#idleTimer = t;
    }
  }

  async configureDetectors() {
    if (!this.session) return;
    this.session.detectors = this.opts.detectorFactory
      ? await this.opts.detectorFactory(this.session.settings)
      : [];
  }

  async checkLlm(): Promise<LlmCheck | null> {
    if (!this.session?.settings.llm) return null;
    if (!this.opts.llmChecker) {
      return { local: false, confirmed: false, reason: "LLM checking is not available" };
    }
    return await this.opts.llmChecker(this.session.settings);
  }
}
