/**
 * casefile desktop app entry point.
 *
 *   deno task desktop   — build dist/casefile.app (scripts/build_desktop.ts; ADR 2, ADR 24). The
 *                         copy in daily use comes from a signed GitHub release and updates itself.
 *   deno task dev       — a development run on :8218, opening only cases in .dev/ (ADR 22)
 *   deno task app       — the app in a browser at http://127.0.0.1:8217 (fallback)
 */
import { resolve } from "@std/path";
import { createHandler } from "./server.ts";
import { AppState } from "./state.ts";
import { appDetectorFactory, appLlmChecker } from "./detectors.ts";
import { readBuildInfo } from "./build.ts";
import { configDir } from "./paths.ts";
import { appBundle, relaunch, relaunchIfStale, Updates } from "./updates.ts";
import { installBundledCli } from "./cli_install.ts";

if (import.meta.main) {
  // `deno task dev` sets CASEFILE_DEV_CASES: that run opens cases only inside it (ADR 22).
  const devCases = Deno.env.get("CASEFILE_DEV_CASES");
  const build = readBuildInfo(Boolean(devCases));
  const config = resolve(configDir());
  const updates = new Updates();
  const bundle = appBundle();
  const state = new AppState({
    configDir: config,
    build,
    caseRoot: devCases ? resolve(devCases) : undefined,
    updates,
    relaunch: bundle
      ? async () => {
        await relaunch(bundle);
        Deno.exit(0);
      }
      : undefined,
    detectorFactory: appDetectorFactory,
    llmChecker: appLlmChecker,
  });
  // Straight after an update was swapped in, this may still be the old version (updates.ts).
  if (build.version && bundle && await relaunchIfStale(bundle, build.version, config)) Deno.exit(0);
  await state.load();
  if (build.version) {
    // The CLI from this same build, for Claude Code in the case folder (ADR 24).
    const home = Deno.env.get("HOME");
    if (home) {
      await installBundledCli(build.version, { home, configDir: config }).catch((e) =>
        console.error(`Could not install the casefile CLI: ${(e as Error).message}`)
      );
    }
    updates.start(build.version);
  }
  const handler = createHandler(state);
  const desktop = Boolean(Deno.env.get("DENO_SERVE_ADDRESS"));
  // In a desktop build the runtime chooses the port; it is always bound to 127.0.0.1.
  const port = Number(Deno.env.get("CASEFILE_PORT") ?? 8217);
  Deno.serve({
    hostname: "127.0.0.1",
    port,
    onListen: ({ hostname, port }) => {
      if (!desktop) console.log(`casefile is running at http://${hostname}:${port}/`);
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
