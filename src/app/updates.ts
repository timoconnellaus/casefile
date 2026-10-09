/**
 * Desktop updates from signed GitHub releases (ADR 24).
 *
 * `Deno.autoUpdate` (deno desktop's runtime) fetches `latest.json` from the latest release once
 * at start and then hourly. The manifest must be signed with the Ed25519 key in update_config.ts;
 * the patch it names must match its SHA-256. A good patch is staged next to the app's runtime and
 * applied by the launcher at the next launch, which rolls back by itself if that launch fails.
 * Nothing is sent but the requests for those files: no case data, no identifiers.
 *
 * The app shows "Update ready" once a patch is staged. Restarting closes the case (its writes
 * finish, its lock is released) and opens a new instance of the bundle; the user unlocks the case
 * again, and the new version backs it up before it opens it (AppState.openCase).
 */
import { dirname, join } from "@std/path";
import { UPDATE_PUBLIC_KEY, UPDATE_REPO, updateBaseUrl } from "./update_config.ts";

const HOUR_MS = 60 * 60 * 1000;

export interface UpdateStatus {
  /** Updates are configured and this is a desktop build. */
  enabled: boolean;
  /** A newer version is staged and applies on restart. */
  ready: string | null;
  /** The last update failed to start and the runtime went back to this version. */
  rolledBack: boolean;
}

export class Updates {
  #status: UpdateStatus = { enabled: false, ready: null, rolledBack: false };

  get status(): UpdateStatus {
    return { ...this.#status };
  }

  /** Start checking (a desktop build with updates configured only). */
  start(version: string | null): void {
    // deno-lint-ignore no-explicit-any
    const autoUpdate = (Deno as any).autoUpdate;
    // A test server can stand in for GitHub (docs/RELEASING.md, "Testing an update locally"):
    // the manifest must still be signed with the built-in key.
    const url = Deno.env.get("CASEFILE_UPDATE_URL") ??
      (UPDATE_REPO ? updateBaseUrl(UPDATE_REPO) : null);
    if (!version || !url || !UPDATE_PUBLIC_KEY || typeof autoUpdate !== "function") return;
    this.#status.enabled = true;
    autoUpdate({
      url,
      publicKey: UPDATE_PUBLIC_KEY,
      interval: HOUR_MS,
      onUpdateReady: (v: string) => (this.#status.ready = String(v)),
      onRollback: () => (this.#status.rolledBack = true),
    });
  }

  /** For tests: as if a patch had been staged. */
  markReady(version: string): void {
    this.#status.ready = version;
  }
}

/** The `.app` bundle the running executable is in, or null (not a desktop build). */
export function appBundle(execPath = Deno.execPath()): string | null {
  for (let dir = execPath; dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.endsWith(".app")) return dir;
  }
  return null;
}

/** The runtime the launcher loads, which update patches replace. */
export function runtimeDylib(bundle: string): string {
  return join(bundle, "Contents", "MacOS", "libruntime.dylib");
}

const VERSION_MARK = new TextEncoder().encode('"app_name":"casefile","app_version":"');

/** The version recorded in a runtime file's embedded metadata, or null. */
export async function runtimeVersion(dylib: string): Promise<string | null> {
  using f = await Deno.open(dylib, { read: true });
  const chunk = new Uint8Array(8 * 1024 * 1024);
  let carry = new Uint8Array(0);
  while (true) {
    const n = await f.read(chunk);
    if (n === null) return null;
    const buf = new Uint8Array(carry.length + n);
    buf.set(carry);
    buf.set(chunk.subarray(0, n), carry.length);
    const at = indexOf(buf, VERSION_MARK);
    if (at >= 0) {
      const rest = new TextDecoder().decode(buf.subarray(at + VERSION_MARK.length, at + 200));
      const m = /^([0-9A-Za-z.+-]+)"/.exec(rest);
      if (m) return m[1];
    }
    carry = buf.slice(Math.max(0, buf.length - 256));
  }
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (
    let i = hay.indexOf(needle[0]);
    i >= 0 && i <= hay.length - needle.length;
    i = hay.indexOf(needle[0], i + 1)
  ) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Deno 2.9.7's launcher swaps a staged update in at launch but still runs the runtime it had
 * already loaded: the new version only runs from the launch after (seen in testing; ADR 24). So
 * right after a swap (`.backup` is there), if the runtime on disk is newer than this code, start
 * again at once, before any window opens, so "Restart to update" takes one restart. A marker in
 * the config folder stops this repeating if the runtime on disk still doesn't start as itself.
 * Returns true when the caller should exit.
 */
export async function relaunchIfStale(
  bundle: string,
  version: string,
  configDir: string,
  launch: (bundle: string) => Promise<void> = relaunch,
): Promise<boolean> {
  const dylib = runtimeDylib(bundle);
  if (!(await Deno.lstat(`${dylib}.backup`).catch(() => null))) return false;
  const onDisk = await runtimeVersion(dylib).catch(() => null);
  if (!onDisk || onDisk === version) return false;
  const marker = join(configDir, "relaunched-for");
  const last = await Deno.readTextFile(marker).catch(() => "");
  if (last.trim() === onDisk) return false;
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(marker, onDisk + "\n");
  await launch(bundle);
  return true;
}

/** Open a new instance of the bundle (the launcher applies the staged update first). */
export async function relaunch(bundle: string): Promise<void> {
  const out = await new Deno.Command("open", {
    args: ["-n", bundle],
    stdout: "null",
    stderr: "null",
  })
    .output();
  if (!out.success) throw new Error("open failed");
}
