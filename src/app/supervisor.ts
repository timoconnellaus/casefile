/**
 * `deno task app`: runs the app (main.ts) as a child process and restarts it into an update
 * without locking the case (ADR 22, amendment).
 *
 * On SIGHUP (sent by `deno task release`):
 * 1. The app is asked to hand over. It closes the case (its vault writes finish, its case lock is
 *    released) and replies, over its stdout pipe, with the case folder, the vault data key and
 *    the session token. Then it exits.
 * 2. If the release changed, the case is backed up (upgrade_backup.ts) before the new build can
 *    open (and migrate) it. If that fails the key is dropped, and the case stays locked until the
 *    user opens it again.
 * 3. The new app starts and is given the hand-over on its stdin. It opens the case with the key
 *    (the key must decrypt a vault file first) and keeps the token, so the browser stays signed in.
 *
 * The key only ever passes through the two child processes' own pipes, never a file or socket. The
 * supervisor keeps it no longer than the restart (JavaScript strings can't be wiped).
 *
 * `<config>/app.json` records the supervisor's pid and port, for the release to find it. Ctrl-C
 * stops the app as before (it locks the case), and then the supervisor.
 */
import { fromFileUrl, join, resolve } from "@std/path";
import { controlLine, type FromApp, lines, parseControl, type ToApp } from "./control.ts";
import { readBuildInfo } from "./build.ts";
import { configDir } from "./paths.ts";
import { backupCase } from "./upgrade_backup.ts";
import { pidAlive } from "../core/caselock.ts";
import type { Handoff } from "./state.ts";

const MAIN = fromFileUrl(new URL("./main.ts", import.meta.url));
/** The app's own permissions (the `app` task before the supervisor). */
const APP_PERMISSIONS = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-net",
  "--allow-ffi",
  "--allow-sys",
  "--allow-run=open",
];
const HANDOFF_TIMEOUT_MS = 60_000;

/** Where the release finds a running supervisor. */
export function supervisorFile(config: string): string {
  return join(config, "app.json");
}

export interface SupervisorInfo {
  pid: number;
  port: number;
  startedAt: string;
}

interface Running {
  child: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  /** The app's next control message (null once its stdout has closed). */
  next: () => Promise<FromApp | null>;
  release: string | null;
}

const encoder = new TextEncoder();

async function start(resume: Handoff | null): Promise<{ app: Running; port: number }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", ...APP_PERMISSIONS, MAIN],
    env: { CASEFILE_SUPERVISED: "1" },
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const stdin = child.stdin.getWriter();
  // The app's stdout is read all the time, so ordinary output never fills the pipe; control
  // messages queue until asked for.
  const queue: (FromApp | null)[] = [];
  const waiting: ((m: FromApp | null) => void)[] = [];
  const push = (m: FromApp | null) => {
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  };
  (async () => {
    for await (const line of lines(child.stdout)) {
      const msg = parseControl<FromApp>(line);
      if (msg) push(msg);
      else console.log(line);
    }
    push(null);
  })();
  const next = () =>
    queue.length ? Promise.resolve(queue.shift()!) : new Promise<FromApp | null>((r) => {
      waiting.push(r);
    });
  const app: Running = { child, stdin, next, release: (await readBuildInfo(false)).release };
  await stdin.write(encoder.encode(controlLine({ resume } satisfies ToApp)));
  const first = await app.next();
  if (!first || !("ready" in first)) {
    throw new Error("The app stopped before it started listening.");
  }
  return { app, port: first.ready.port };
}

/** Ask the app to close the case and stop; its hand-over, or null (no case open, or no reply). */
async function handOff(app: Running): Promise<Handoff | null> {
  await app.stdin.write(encoder.encode(controlLine({ handOff: true } satisfies ToApp)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), HANDOFF_TIMEOUT_MS)));
  const reply = (async () => {
    for (let msg = await app.next(); msg; msg = await app.next()) {
      if ("handOff" in msg) return msg.handOff;
    }
    return null;
  })();
  try {
    const h = await Promise.race([reply, timeout]);
    // No reply in time: stop it as Ctrl-C would (it locks the case).
    if (h === null) {
      try {
        app.child.kill("SIGTERM");
      } catch { /* already gone */ }
    }
    return h;
  } finally {
    clearTimeout(timer);
    await app.child.status;
  }
}

if (import.meta.main) {
  const config = resolve(configDir());
  await Deno.mkdir(config, { recursive: true });
  // Already running (in another terminal): open it rather than fail on the port.
  try {
    const other = JSON.parse(await Deno.readTextFile(supervisorFile(config))) as SupervisorInfo;
    if (other.pid !== Deno.pid && pidAlive(other.pid)) {
      const url = `http://127.0.0.1:${other.port}/`;
      console.log(`casefile is already running at ${url} (pid ${other.pid}). Opening it.`);
      if (Deno.build.os === "darwin") {
        await new Deno.Command("open", { args: [url] }).output().catch(() => {});
      }
      Deno.exit(0);
    }
  } catch { /* not running */ }
  let started;
  try {
    started = await start(null);
  } catch {
    console.error(
      `casefile could not start. Is something else using port ${
        Deno.env.get("CASEFILE_PORT") ?? 8217
      }? (See the error above.)`,
    );
    Deno.exit(1);
  }
  let { app, port } = started;
  console.log(`casefile is running at http://127.0.0.1:${port}/`);
  const info: SupervisorInfo = { pid: Deno.pid, port, startedAt: new Date().toISOString() };
  await Deno.writeTextFile(supervisorFile(config), JSON.stringify(info) + "\n");

  let restarting = false;
  let stopping = false;
  const stop = async (code: number) => {
    stopping = true;
    await Deno.remove(supervisorFile(config)).catch(() => {});
    Deno.exit(code);
  };

  Deno.addSignalListener("SIGHUP", async () => {
    if (restarting || stopping) return;
    restarting = true;
    try {
      const old = app;
      let h = await handOff(old);
      const release = (await readBuildInfo(false)).release;
      if (h && release !== old.release) {
        try {
          const b = await backupCase(h.root, join(config, "backups"), {
            release: release ?? "unreleased",
            previous: old.release,
          });
          console.log(`Backed up the case to ${b.dir}`);
        } catch (e) {
          console.error(
            `Could not back up the case before the update (${(e as Error).message}). ` +
              "It stays locked: open it again in casefile.",
          );
          h = null;
        }
      }
      ({ app, port } = await start(h));
      h = null;
      console.log(`casefile restarted${release ? ` on ${release}` : ""}.`);
    } catch (e) {
      console.error(`Restart failed: ${(e as Error).message}`);
      await stop(1);
    } finally {
      restarting = false;
    }
  });

  // Ctrl-C reaches the app too (same process group): it locks the case and exits, then so do we.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(sig, () => {
      stopping = true;
      try {
        app.child.kill("SIGTERM");
      } catch { /* already gone */ }
    });
  }

  // The app stopping by itself, not for a restart, stops the supervisor too.
  while (true) {
    const current = app;
    const status = await current.child.status;
    if (current === app && !restarting) await stop(status.code);
    // A restart replaced it: wait for the new one (the restart may still be starting it).
    while (restarting) await new Promise((r) => setTimeout(r, 100));
  }
}
