import { join } from "@std/path";

/**
 * The case-in-use lock (ADR 4, amendment "one opener at a time").
 *
 * Whatever opens a case with its vault (the app, `scripts/seed.ts`, creating a case) holds
 * `<case>/.casefile-lock` while it has the case open. Opening a case runs a repair pass over
 * public.db against the vault (`reconcilePublic`), so two openers at once can undo each other's
 * work: an app that opened the canon case while `seed --force` was rebuilding it saw a document in
 * public.db that its earlier read of the vault did not list, and withdrew it.
 *
 * - The file is made with an exclusive create (`createNew`, O_EXCL), so of two openers only one
 *   gets it. It records the pid, the start time and the host.
 * - It is removed when the case is closed (lock, shutdown). A lock whose process is no longer
 *   running on this host is stale and is taken over; one from another host is treated as live
 *   (its process can't be checked from here).
 * - Within one process the lock is shared (the app replaces its own session when the user opens
 *   the case again), counted per folder and released when the last holder closes.
 * - The Claude-facing CLI never takes it: Claude works alongside the open app, and its writes to
 *   public.db are ordinary SQLite transactions that do not repair anything.
 *
 * The lock prevents accidents between casefile's own processes. Anything that can write in the
 * case folder (Claude included) can delete it; that only removes this protection.
 */

export const CASE_LOCK_FILE = ".casefile-lock";

/** What the lock file records about its holder. */
export interface CaseLockInfo {
  format: "casefile-lock";
  pid: number;
  startedAt: string;
  host: string;
  /** What took it: "app" (opening or creating a case) or "seed". */
  by: string;
  /** Random, per acquisition: tells this holder's file from a later one at the same path. */
  token: string;
}

/** Someone else has the case open. */
export class CaseInUseError extends Error {
  constructor(readonly holder: CaseLockInfo | null) {
    super(
      holder
        ? `This case is open in casefile (pid ${holder.pid}${
          holder.host === thisHost() ? "" : ` on ${holder.host}`
        }). Lock it or quit casefile first.`
        : "This case is being opened by another casefile. Try again in a moment.",
    );
    this.name = "CaseInUseError";
  }
}

/** A lock file younger than this that can't be read may still be being written. */
const UNREADABLE_GRACE_MS = 10_000;

function thisHost(): string {
  try {
    return Deno.hostname();
  } catch {
    return "unknown";
  }
}

// ── is a process running? ────────────────────────────────────────────────────
//
// kill(pid, 0) sends no signal: it only reports whether the process exists (0, or -1 with EPERM
// when it belongs to another user) or not (-1 with ESRCH). Deno has no API for this that does not
// need --allow-run, so it is called through FFI (the app and seed tasks have --allow-ffi). Without
// FFI the answer is "running": a lock is then never taken over, which is the safe mistake.

const ESRCH = 3;
type Libc = {
  symbols: { kill: (pid: number, sig: number) => number; errno: () => Deno.PointerValue };
  close(): void;
};
let libc: Libc | null | undefined;

function openLibc(): Libc | null {
  if (libc !== undefined) return libc;
  const os = Deno.build.os;
  const path = os === "darwin" ? "/usr/lib/libSystem.B.dylib" : os === "linux" ? "libc.so.6" : null;
  const errnoName = os === "darwin" ? "__error" : "__errno_location";
  libc = null;
  if (!path) return libc;
  try {
    const lib = Deno.dlopen(path, {
      kill: { parameters: ["i32", "i32"], result: "i32" },
      [errnoName]: { parameters: [], result: "pointer" },
    });
    const errnoFn = lib.symbols[errnoName] as () => Deno.PointerValue;
    libc = {
      symbols: { kill: lib.symbols.kill as (p: number, s: number) => number, errno: errnoFn },
      close: () => lib.close(),
    };
  } catch {
    libc = null;
  }
  return libc;
}

/** Whether process `pid` is running on this host (true when that can't be told). */
export function pidAlive(pid: number): boolean {
  if (pid === Deno.pid) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const lib = openLibc();
  if (!lib) return true;
  if (lib.symbols.kill(pid, 0) === 0) return true;
  const p = lib.symbols.errno();
  if (!p) return true;
  return new Deno.UnsafePointerView(p).getInt32() !== ESRCH;
}

// ── the lock ─────────────────────────────────────────────────────────────────

async function folderId(dir: string): Promise<string> {
  const st = await Deno.stat(dir);
  return st.ino === null || st.dev === null ? `path:${dir}` : `${st.dev}:${st.ino}`;
}

type Read = { info: CaseLockInfo } | { unreadable: true; mtime: number } | null;

async function readLock(path: string): Promise<Read> {
  let text: string;
  let mtime = Date.now();
  try {
    const st = await Deno.lstat(path);
    if (!st.isFile) return { unreadable: true, mtime: 0 };
    mtime = st.mtime?.getTime() ?? mtime;
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  try {
    const info = JSON.parse(text) as CaseLockInfo;
    if (
      info?.format === "casefile-lock" && Number.isSafeInteger(info.pid) &&
      typeof info.host === "string" && typeof info.token === "string"
    ) return { info };
  } catch { /* fall through */ }
  return { unreadable: true, mtime };
}

/** One process's hold on one case folder, shared by every session of it in this process. */
interface Entry {
  id: string;
  path: string;
  token: string;
  count: number;
}
const held = new Map<string, Entry>();

export class CaseLock {
  #released = false;
  private constructor(private readonly entry: Entry) {}

  /** The lock file's path. */
  get path(): string {
    return this.entry.path;
  }

  /**
   * Take the case-in-use lock on the folder `root` (which must exist). Throws CaseInUseError if a
   * running process elsewhere holds it; takes over a stale one.
   */
  static async acquire(root: string, by = "app"): Promise<CaseLock> {
    const id = await folderId(root);
    const path = join(root, CASE_LOCK_FILE);
    const mine = held.get(id);
    if (mine) {
      const r = await readLock(path);
      if (r && "info" in r && r.info.token === mine.token) {
        mine.count++;
        return new CaseLock(mine);
      }
      // Our file is gone (or replaced): this is a different hold now.
      held.delete(id);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const info: CaseLockInfo = {
        format: "casefile-lock",
        pid: Deno.pid,
        startedAt: new Date().toISOString(),
        host: thisHost(),
        by,
        token: crypto.randomUUID(),
      };
      let f: Deno.FsFile;
      try {
        f = await Deno.open(path, { write: true, createNew: true, mode: 0o600 });
      } catch (e) {
        if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
        await CaseLock.#clearStale(path);
        continue;
      }
      try {
        const buf = new TextEncoder().encode(JSON.stringify(info, null, 2) + "\n");
        for (let off = 0; off < buf.length;) off += await f.write(buf.subarray(off));
      } finally {
        f.close();
      }
      const entry: Entry = { id, path, token: info.token, count: 1 };
      held.set(id, entry);
      return new CaseLock(entry);
    }
    throw new CaseInUseError(null);
  }

  /**
   * The live holder of the lock on `root` other than this process, or null. For refusing early
   * (creating a case, `seed --force`) with the same message `acquire` would give.
   */
  static async holder(root: string): Promise<CaseLockInfo | null> {
    const r = await readLock(join(root, CASE_LOCK_FILE));
    if (!r) return null;
    if ("unreadable" in r) {
      return Date.now() - r.mtime < UNREADABLE_GRACE_MS
        ? {
          format: "casefile-lock",
          pid: 0,
          startedAt: "",
          host: thisHost(),
          by: "",
          token: "",
        }
        : null;
    }
    return CaseLock.#isLive(r.info) && r.info.pid !== Deno.pid ? r.info : null;
  }

  /** Throw CaseInUseError if another live process holds the lock on `root`. */
  static async refuseIfHeld(root: string): Promise<void> {
    const h = await CaseLock.holder(root);
    if (h) throw new CaseInUseError(h.pid ? h : null);
  }

  static #isLive(info: CaseLockInfo): boolean {
    if (info.host !== thisHost()) return true; // can't check another machine's processes
    if (info.pid === Deno.pid) {
      // This process: live only if one of its sessions holds exactly this file.
      for (const e of held.values()) if (e.token === info.token) return true;
      return false;
    }
    return pidAlive(info.pid);
  }

  /**
   * The lock file exists. If its holder is live, refuse; if it is stale, move it aside and delete
   * it. Moving it first (a rename, which is atomic) means that if two processes both find the
   * same stale lock, the second's rename fails rather than removing the first one's new lock; if
   * what was moved turns out not to be the stale lock that was judged, it is put back.
   */
  static async #clearStale(path: string): Promise<void> {
    const r = await readLock(path);
    if (!r) return; // gone meanwhile: try again
    if ("unreadable" in r) {
      if (Date.now() - r.mtime < UNREADABLE_GRACE_MS) throw new CaseInUseError(null);
    } else if (CaseLock.#isLive(r.info)) {
      throw new CaseInUseError(r.info);
    }
    const aside = `${path}.stale-${crypto.randomUUID()}`;
    try {
      await Deno.rename(path, aside);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    const moved = await readLock(aside);
    const same = moved &&
      ("info" in moved ? "info" in r && moved.info.token === r.info.token : "unreadable" in r);
    if (same) {
      await Deno.remove(aside).catch(() => {});
      return;
    }
    // Someone took the lock between the read and the rename: put theirs back.
    try {
      await Deno.link(aside, path);
    } catch { /* a third opener has it; theirs stands */ }
    await Deno.remove(aside).catch(() => {});
    throw new CaseInUseError(moved && "info" in moved ? moved.info : null);
  }

  /**
   * Give up this hold. When it is this process's last on the folder, the lock file is removed,
   * but only if it is still this hold's file: a folder replaced while open has someone else's
   * lock at that path now, which is left alone.
   */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    const e = this.entry;
    if (--e.count > 0) return;
    if (held.get(e.id) === e) held.delete(e.id);
    try {
      const st = Deno.lstatSync(e.path);
      if (!st.isFile) return;
      const info = JSON.parse(Deno.readTextFileSync(e.path)) as CaseLockInfo;
      if (info?.token === e.token) Deno.removeSync(e.path);
    } catch { /* gone, or not ours */ }
  }
}
