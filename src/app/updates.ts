/**
 * Desktop updates from signed GitHub releases (ADR 24).
 *
 * casefile checks the latest release once soon after it starts, then hourly, and whenever the user
 * asks (Settings → casefile updates). Each check fetches `latest.json`, which must be signed with
 * the Ed25519 key in update_config.ts, and, if there is a newer version, the patch it names, which
 * must match the manifest's SHA-256. Nothing is sent but the requests for those files: no case
 * data, no identifiers.
 *
 * Deno 2.9.7's `Deno.autoUpdate` fetches with `redirect: "error"`, and every GitHub release
 * download redirects twice (to the tagged release, then to a signed URL on the asset host), so it
 * can't download from GitHub itself (issue #5). casefile does the downloading: it follows the
 * redirects over HTTPS, checks the signature and the hash, and then hands the exact bytes it
 * checked to `Deno.autoUpdate`, which checks the signature and the hash again and stages the
 * patch next to the app's runtime. The launcher applies it at the next launch and rolls back by
 * itself if that launch fails.
 *
 * The app shows "Update ready" once a patch is staged. Restarting closes the case (its writes
 * finish, its lock is released) and opens a new instance of the bundle; the user unlocks the case
 * again, and the new version backs it up before it opens it (AppState.openCase).
 */
import { decodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { dirname, join } from "@std/path";
import { UPDATE_PUBLIC_KEY, UPDATE_REPO, updateBaseUrl } from "./update_config.ts";

const HOUR_MS = 60 * 60 * 1000;
/** The first check, a little after start so it doesn't compete with opening the window. */
const FIRST_CHECK_MS = 5_000;
/** How long `Deno.autoUpdate` may take to stage a patch it has been handed (it starts after 1s). */
const STAGE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export interface UpdateStatus {
  /** Updates are configured and this is a desktop build. */
  enabled: boolean;
  /** A newer version is staged and applies on restart. */
  ready: string | null;
  /** The last update failed to start and the runtime went back to this version. */
  rolledBack: boolean;
  /** A check is running now. */
  checking: boolean;
  /** When the last check finished (ISO time), or null if none has. */
  lastCheck: string | null;
  /** Why the last check failed, or null if it worked. Never holds case data. */
  lastError: string | null;
}

/** `Deno.autoUpdate` as casefile calls it. */
export type AutoUpdate = (opts: {
  url: string;
  publicKey: string;
  interval?: number;
  onUpdateReady?: (version: string) => void;
  onRollback?: (reason: string) => void;
}) => void;

export interface UpdatesOptions {
  /** Where `latest.json` and the patches are (default: the env override or GitHub). */
  url?: string;
  /** The manifest's public key (default: update_config.ts). */
  publicKey?: string;
  /** Default: `Deno.autoUpdate`, which only a `deno desktop` build has. */
  autoUpdate?: AutoUpdate;
  /** For the downloads (default: the global fetch). */
  fetch?: typeof fetch;
  /** How long staging may take (tests shorten it). */
  stageTimeoutMs?: number;
}

interface Manifest {
  version: string;
  patches?: Record<string, { name?: unknown; sha256?: unknown } | undefined>;
}

/** A check that failed, with a sentence for the user. */
class UpdateError extends Error {}

export class Updates {
  #status: UpdateStatus = {
    enabled: false,
    ready: null,
    rolledBack: false,
    checking: false,
    lastCheck: null,
    lastError: null,
  };
  #opts: UpdatesOptions;
  #version: string | null = null;
  #base = "";
  #publicKey = "";
  #autoUpdate: AutoUpdate | null = null;
  #running: Promise<UpdateStatus> | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(opts: UpdatesOptions = {}) {
    this.#opts = opts;
  }

  get status(): UpdateStatus {
    return { ...this.#status };
  }

  /**
   * Start checking (a desktop build with updates configured only): once soon, then hourly.
   * Pass `{ timers: false }` to only make `check()` available.
   */
  start(version: string | null, { timers = true }: { timers?: boolean } = {}): void {
    // deno-lint-ignore no-explicit-any
    const autoUpdate = this.#opts.autoUpdate ?? (Deno as any).autoUpdate;
    // A test server can stand in for GitHub (docs/RELEASING.md, "Testing an update locally"):
    // the manifest must still be signed with the built-in key.
    const url = this.#opts.url ?? Deno.env.get("CASEFILE_UPDATE_URL") ??
      (UPDATE_REPO ? updateBaseUrl(UPDATE_REPO) : null);
    const publicKey = this.#opts.publicKey ?? UPDATE_PUBLIC_KEY;
    if (!version || !url || !publicKey || typeof autoUpdate !== "function") return;
    this.#version = version;
    this.#base = url.replace(/\/$/, "");
    this.#publicKey = publicKey;
    this.#autoUpdate = autoUpdate;
    this.#status.enabled = true;
    // Only to hear whether the last update was rolled back: with no URL it checks nothing.
    autoUpdate({ url: "", publicKey, onRollback: () => (this.#status.rolledBack = true) });
    if (timers) {
      this.#timers.push(
        setTimeout(() => this.check(), FIRST_CHECK_MS),
        setInterval(() => this.check(), HOUR_MS),
      );
    }
  }

  /** Stop the background checks. */
  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  /** Check now (or join the check that is running) and return the status after it. */
  check(): Promise<UpdateStatus> {
    if (!this.#status.enabled) return Promise.resolve(this.status);
    this.#running ??= this.#check().finally(() => (this.#running = null));
    return this.#running;
  }

  async #check(): Promise<UpdateStatus> {
    this.#status.checking = true;
    try {
      await this.#checkOnce();
      this.#status.lastError = null;
    } catch (e) {
      this.#status.lastError = e instanceof UpdateError
        ? e.message
        : `The update check failed: ${withoutQueries((e as Error)?.message ?? String(e))}`;
    } finally {
      this.#status.checking = false;
      this.#status.lastCheck = new Date().toISOString();
    }
    return this.status;
  }

  async #checkOnce(): Promise<void> {
    const version = this.#version!;
    const manifestUrl = `${this.#base}/latest.json`;
    const envelopeBytes = await this.#download(manifestUrl, "the update information");
    const manifest = await verifiedManifest(envelopeBytes, this.#publicKey);
    if (manifest.version === version || manifest.version === this.#status.ready) return;
    const entry = manifest.patches?.[version];
    if (!entry) {
      throw new UpdateError(
        `casefile ${manifest.version} is out, but there is no update from ${version} to it. ` +
          "Reinstall casefile with install.sh to get it.",
      );
    }
    const { name, sha256 } = entry;
    if (
      typeof name !== "string" || !/^[\w.+-]+$/.test(name) || name.startsWith(".") ||
      typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)
    ) {
      throw new UpdateError("The update information names a patch casefile can't use.");
    }
    const patchUrl = `${this.#base}/${name}`;
    const patch = await this.#download(patchUrl, "the update");
    if (encodeHex(await crypto.subtle.digest("SHA-256", patch)) !== sha256.toLowerCase()) {
      throw new UpdateError("The downloaded update didn't match its checksum, so it was ignored.");
    }
    await this.#stage(manifest.version, { [manifestUrl]: envelopeBytes, [patchUrl]: patch });
  }

  /**
   * Have `Deno.autoUpdate` stage the patch, serving it the bytes already checked: for the length
   * of the call, a fetch of exactly those URLs gets those bytes, without going to the network.
   * Every other fetch goes through unchanged.
   */
  async #stage(version: string, files: Record<string, Uint8Array<ArrayBuffer>>): Promise<void> {
    const original = globalThis.fetch;
    let staged!: (v: string) => void;
    const ready = new Promise<string>((resolve) => (staged = resolve));
    const served: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url in files) return Promise.resolve(new Response(files[url]));
      if (url.startsWith(`${this.#base}/`)) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return original(input, init);
    };
    globalThis.fetch = served;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.#autoUpdate!({
        url: this.#base,
        publicKey: this.#publicKey,
        // Set here too, in case staging finishes after the wait below gives up.
        onUpdateReady: (v) => staged(this.#status.ready = String(v)),
        onRollback: () => (this.#status.rolledBack = true),
      });
      const v = await Promise.race([
        ready,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.#opts.stageTimeoutMs ?? STAGE_TIMEOUT_MS);
        }),
      ]);
      if (v === null) {
        throw new UpdateError(
          `casefile ${version} downloaded and passed its checks, but it couldn't be set up to install. ` +
            "casefile will try again.",
        );
      }
      this.#status.ready = v;
    } finally {
      clearTimeout(timer);
      if (globalThis.fetch === served) globalThis.fetch = original;
    }
  }

  /** GET `url`, following redirects (at most five, HTTPS stays HTTPS), as bytes. */
  async #download(url: string, what: string): Promise<Uint8Array<ArrayBuffer>> {
    const get = this.#opts.fetch ?? globalThis.fetch;
    let at = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = new URL(at).host;
      let res: Response;
      try {
        res = await get(at, { redirect: "manual", cache: "no-store" });
      } catch (e) {
        throw new UpdateError(
          `casefile couldn't reach ${host} to check for updates: ` +
            withoutQueries((e as Error)?.message ?? String(e)),
        );
      }
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        await res.body?.cancel();
        const next = new URL(res.headers.get("location")!, at);
        if (new URL(at).protocol === "https:" && next.protocol !== "https:") {
          throw new UpdateError(`${host} redirected ${what} away from HTTPS, so it was ignored.`);
        }
        at = next.href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new UpdateError(`${host} answered ${res.status} for ${what}.`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    throw new UpdateError(`Downloading ${what} redirected too many times.`);
  }

  /** For tests: as if a patch had been staged. */
  markReady(version: string): void {
    this.#status.ready = version;
  }
}

/** The manifest in `latest.json`, if it is signed with `publicKey` (as Deno.autoUpdate checks). */
async function verifiedManifest(bytes: Uint8Array, publicKey: string): Promise<Manifest> {
  const unsigned = new UpdateError(
    "The update information isn't signed with casefile's key, so it was ignored.",
  );
  let env: { signed?: unknown; signature?: unknown };
  try {
    env = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UpdateError("The update information isn't valid JSON.");
  }
  if (typeof env?.signed !== "string" || typeof env.signature !== "string") throw unsigned;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      decodeBase64(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeBase64(env.signature),
      new TextEncoder().encode(env.signed),
    );
  } catch { /* a malformed signature is no signature */ }
  if (!ok) throw unsigned;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(env.signed);
  } catch {
    throw new UpdateError("The signed update information isn't valid JSON.");
  }
  if (typeof manifest?.version !== "string") {
    throw new UpdateError("The update information has no version.");
  }
  return manifest;
}

/** A message without URL query strings (GitHub's download links carry signed tokens). */
function withoutQueries(message: string): string {
  return message.replace(/\?[^\s)"'\]]*/g, "");
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
