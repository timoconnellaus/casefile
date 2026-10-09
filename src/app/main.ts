/**
 * casefile desktop app entry point.
 *
 *   deno task app       — the copy in daily use, at http://127.0.0.1:8217, run by supervisor.ts so
 *                         `deno task release` can restart it into an update without locking the
 *                         case (ADR 22)
 *   deno task dev       — a development run on :8218, opening only cases in .dev/ (ADR 22)
 *   deno task desktop   — build dist/casefile.app with `deno desktop` (ADR 2; macOS, the UI
 *                         files are included in the bundle)
 */
import { resolve } from "@std/path";
import { createHandler, snapshotUi } from "./server.ts";
import { AppState } from "./state.ts";
import { appDetectorFactory, appLlmChecker } from "./detectors.ts";
import { readBuildInfo } from "./build.ts";
import { configDir } from "./paths.ts";
import { controlLine, type FromApp, lines, parseControl, type ToApp } from "./control.ts";

/** A fixed sentence for the unlock screen when the hand-over after an update did not work. */
const RESUME_FAILED =
  "casefile was updated but could not reopen the case by itself. Open it again.";

if (import.meta.main) {
  // `deno task dev` sets CASEFILE_DEV_CASES: that run opens cases only inside it (ADR 22).
  const devCases = Deno.env.get("CASEFILE_DEV_CASES");
  const state = new AppState({
    configDir: resolve(configDir()),
    build: await readBuildInfo(Boolean(devCases)),
    caseRoot: devCases ? resolve(devCases) : undefined,
    detectorFactory: appDetectorFactory,
    llmChecker: appLlmChecker,
  });
  await state.load();

  // Run by the supervisor (`deno task app`): the first line on stdin says whether to carry on
  // with a case the app this one replaces had open (ADR 22, amendment).
  const supervised = Deno.env.get("CASEFILE_SUPERVISED") === "1";
  const fromSupervisor = supervised ? lines(Deno.stdin.readable) : null;
  const send = async (msg: FromApp) => {
    await Deno.stdout.write(new TextEncoder().encode(controlLine(msg)));
  };
  if (fromSupervisor) {
    const first = await fromSupervisor.next();
    const msg = first.done ? null : parseControl<ToApp>(first.value);
    if (msg && "resume" in msg && msg.resume) {
      try {
        await state.resume(msg.resume);
      } catch (e) {
        console.error(`Could not reopen the case after the update: ${(e as Error).name}`);
        state.lockNotice = RESUME_FAILED;
      }
    }
  }
  // A development run reads the UI from disk on each request (reload to see a change); the copy
  // in daily use keeps the UI it started with until it is restarted (ADR 22).
  const handler = createHandler(state, devCases ? {} : { readUi: await snapshotUi() });
  const desktop = Boolean(Deno.env.get("DENO_SERVE_ADDRESS"));
  // In a desktop build the runtime chooses the port; it is always bound to 127.0.0.1.
  const port = Number(Deno.env.get("CASEFILE_PORT") ?? 8217);
  Deno.serve({
    hostname: "127.0.0.1",
    port,
    onListen: ({ hostname, port }) => {
      if (supervised) send({ ready: { port } });
      else if (!desktop) console.log(`casefile is running at http://${hostname}:${port}/`);
    },
  }, handler);
  // deno-lint-ignore no-explicit-any
  const BW = (Deno as any).BrowserWindow;
  if (desktop && BW) {
    const win = new BW({ title: "casefile", width: 1280, height: 860 });
    win.addEventListener?.("close", async () => {
      await state.shutdown();
      Deno.exit(0);
    });
  }
  if (fromSupervisor) {
    (async () => {
      for await (const line of fromSupervisor) {
        const msg = parseControl<ToApp>(line);
        if (msg && "handOff" in msg) {
          // Closes the case (its writes finish) before replying, so the supervisor can back it
          // up and the new app can open it.
          const h = await state.handOff();
          await send({ handOff: h });
          Deno.exit(0);
        }
      }
      // The supervisor is gone: stop as Ctrl-C would.
      await state.shutdown();
      Deno.exit(0);
    })();
  }
  // Stopping the app (Ctrl-C, or the system ending it) locks the case and lets its last vault
  // writes finish before the process exits.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, async () => {
        await state.shutdown();
        Deno.exit(0);
      });
    } catch { /* not every signal exists on every platform */ }
  }
}
