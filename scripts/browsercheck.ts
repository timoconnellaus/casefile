#!/usr/bin/env -S deno run -A
/**
 * Browser check: every screen of the app, in headless Chromium, on a fresh synthetic CANON case.
 *
 *   deno task browsercheck            # 40-document CANON case
 *   deno task browsercheck --full     # the 312-document case
 *   deno task browsercheck --keep     # leave the temporary case folder in place
 *
 * It builds the case with the seed in a temporary folder, starts the development app on a free port
 * with its own CASEFILE_DEV_CASES and CASEFILE_CONFIG_DIR (never port 8217, never a real case),
 * unlocks it with the seed's synthetic passphrase and visits every route in src/app/ui/routes.js.
 * A screen fails on a console error, an uncaught exception, a failed same-origin request, a missing
 * main heading, or horizontal scrolling at 375px wide. Screenshots go to `.browsercheck/`
 * (gitignored). Prints one PASS/FAIL line per screen and exits 1 if any failed.
 *
 * Chromium: `CHROME_PATH` (set by scripts/cloud-setup.sh) is launched with --no-sandbox; without
 * it, Playwright's own browser. Not part of `deno task ci`.
 */
import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl, join } from "@std/path";
import { type Browser, chromium, type Page } from "playwright";
import { DEFAULT_PASS, seedCase } from "./seed.ts";
import { UNLOCK } from "../src/app/ui/routes.js";
import { type Screen, screensFor } from "./browsercheck/screens.ts";

/** The page's globals that page.evaluate uses (this file is type-checked without the DOM lib). */
interface BrowserGlobals {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
}

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const SHOTS = join(ROOT, ".browsercheck");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

interface Result {
  name: string;
  hash: string;
  problems: string[];
}

/** A free TCP port on 127.0.0.1 that is not the app's own. */
function freePort(): number {
  for (;;) {
    const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const { port } = l.addr as Deno.NetAddr;
    l.close();
    if (port !== 8217 && port !== 8218) return port;
  }
}

/** Start `src/app/main.ts` as `deno task dev` does, but on its own port and folders. */
async function startApp(cases: string, config: string, port: number) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "--allow-ffi",
      "--allow-sys",
      join(ROOT, "src/app/main.ts"),
    ],
    cwd: ROOT,
    env: {
      CASEFILE_DEV_CASES: cases,
      CASEFILE_CONFIG_DIR: config,
      CASEFILE_PORT: String(port),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) output.push(chunk);
  };
  collect(child.stdout);
  collect(child.stderr);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(origin + "/");
      await res.body?.cancel();
      if (res.ok) return { child, origin, output };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`The app did not start on ${origin}:\n${output.join("")}`);
}

/** Every route, with parameters taken from the seeded case. */
async function concreteScreens(page: Page): Promise<Screen[]> {
  const data = await page.evaluate(async () => {
    const get = async (p: string) => (await fetch(p)).json();
    return { docs: await get("/api/docs"), drafts: await get("/api/drafts") };
  });
  return screensFor(data);
}

/** Load one screen and collect what went wrong. */
async function check(page: Page, origin: string, screen: Screen): Promise<string[]> {
  const problems: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  };
  const onPageError = (e: Error) => problems.push(`uncaught: ${e.message}`);
  const sameOrigin = (u: string) => u.startsWith(origin + "/");
  const onFailed = (r: { url(): string; failure(): { errorText: string } | null }) => {
    if (sameOrigin(r.url())) {
      problems.push(`request failed: ${r.url().slice(origin.length)} ${r.failure()?.errorText}`);
    }
  };
  const onResponse = (r: { url(): string; status(): number }) => {
    if (sameOrigin(r.url()) && r.status() >= 400) {
      problems.push(`HTTP ${r.status()}: ${r.url().slice(origin.length)}`);
    }
  };
  const listen = (on: boolean) => {
    const f = on ? page.on.bind(page) : page.off.bind(page);
    f("console", onConsole);
    f("pageerror", onPageError);
    f("requestfailed", onFailed);
    f("response", onResponse);
  };
  try {
    for (const [label, size] of [["desktop", DESKTOP], ["375", PHONE]] as const) {
      await page.setViewportSize(size);
      // Leave the last screen first, so its unfinished requests are not counted here, and so a
      // hash-only change still loads the page afresh.
      listen(false);
      await page.goto("about:blank");
      listen(true);
      await page.goto(origin + "/" + screen.hash, { waitUntil: "load" });
      try {
        await page.locator("main h1").first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        problems.push(`${label}: no main heading`);
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      if (label === "375") {
        // A function, not a string: the app's CSP forbids eval.
        const over = await page.evaluate(() => {
          const el = (globalThis as unknown as BrowserGlobals).document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        if (over > 0) problems.push(`375px: scrolls sideways by ${over}px`);
      }
      await page.screenshot({ path: join(SHOTS, `${screen.name}-${label}.png`), fullPage: true });
    }
  } finally {
    listen(false);
  }
  return [...new Set(problems)];
}

async function unlock(page: Page, origin: string, dir: string): Promise<string[]> {
  const problems = await check(page, origin, { name: UNLOCK.name, hash: "" });
  await page.setViewportSize(DESKTOP);
  await page.locator("#u-dir").fill(dir);
  await page.locator("#u-pass").fill(DEFAULT_PASS);
  await page.locator("#u-pass").press("Enter");
  await page.locator("#u-pass").waitFor({ state: "detached", timeout: 60_000 });
  return problems;
}

async function launch(): Promise<Browser> {
  const executablePath = Deno.env.get("CHROME_PATH");
  return executablePath
    ? await chromium.launch({ executablePath, args: ["--no-sandbox"] })
    : await chromium.launch();
}

async function main() {
  const args = parseArgs(Deno.args, { boolean: ["full", "keep"] });
  const tmp = await Deno.makeTempDir({ prefix: "casefile-browsercheck-" });
  const cases = join(tmp, "cases");
  const dir = join(cases, "canon");
  const config = join(tmp, "config");
  await Deno.remove(SHOTS, { recursive: true }).catch(() => {});
  await Deno.mkdir(SHOTS, { recursive: true });

  console.log(`browsercheck: seeding CANON in ${dir}`);
  await seedCase({ dir, configDir: config, small: !args.full, quiet: true });
  const port = freePort();
  const app = await startApp(cases, config, port);
  console.log(`browsercheck: app at ${app.origin}`);
  const browser = await launch();
  const results: Result[] = [];
  try {
    const page = await browser.newPage({ viewport: DESKTOP });
    results.push({
      name: UNLOCK.name,
      hash: "(locked)",
      problems: await unlock(page, app.origin, dir),
    });
    for (const screen of await concreteScreens(page)) {
      results.push({ ...screen, problems: await check(page, app.origin, screen) });
    }
  } finally {
    await browser.close();
    app.child.kill("SIGTERM");
    await app.child.status;
    if (!args.keep) await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }

  console.log("");
  for (const r of results) {
    console.log(`${r.problems.length ? "FAIL" : "PASS"}  ${r.name.padEnd(12)} ${r.hash}`);
    for (const p of r.problems) console.log(`        ${p}`);
  }
  const failed = results.filter((r) => r.problems.length).length;
  console.log(
    `\n${results.length - failed}/${results.length} screens passed. Screenshots in .browsercheck/`,
  );
  if (args.keep) console.log(`Case kept in ${dir} (passphrase "${DEFAULT_PASS}")`);
  if (failed) Deno.exit(1);
}

if (import.meta.main) await main();
