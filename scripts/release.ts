#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run --allow-ffi --allow-sys
/**
 * Release the checkout in daily use (ADR 22): `deno task release`, from the main checkout.
 *
 * 1. Refuses unless this is the main checkout (not a worktree), on `main`, with nothing
 *    uncommitted, and `deno task ci` passes.
 * 2. Backs up each case (the last one the app opened, or every `--case DIR`) into the app's own
 *    folder, which Claude Code is blocked from (src/app/upgrade_backup.ts). A case open in the app
 *    that `deno task app` runs is backed up during the restart instead (step 6). Refuses while
 *    any other casefile has the case open.
 * 3. Builds `bin/casefile` and installs it to `~/.local/bin` (`--bin-dir`), so Claude Code in the
 *    case folder runs the CLI from this same commit.
 * 4. Writes `release.json` (gitignored; the app shows it in Settings). With `--desktop`, also
 *    rebuilds `dist/casefile.app` with it (refused while that app is running).
 * 5. Tags the commit `use-YYYY-MM-DD-N` and says what changed since the last release: commits, a
 *    public.db schema upgrade, and whether the case folder's generated CLAUDE.md / settings
 *    changed.
 * 6. If `deno task app` is running, restarts it into the release (src/app/supervisor.ts): the open
 *    case is closed, backed up and reopened, and the browser stays signed in. Reload the page when
 *    it says casefile was updated.
 *
 * ## Going back to an earlier release
 *
 * Quit casefile. `git checkout <earlier tag>`. Replace the case folder's contents with the backup
 * made before the release you are leaving (`<config>/backups/<case>/<time>-before-<tag>/`, all of
 * it except `backup.json`). Start the app. Anything done in the case since that backup is lost,
 * which is why going back is the last resort; a fix released forward is usually better.
 */
import { parseArgs } from "@std/cli/parse-args";
import { encodeHex } from "@std/encoding/hex";
import { DELIMITER, fromFileUrl, join, resolve } from "@std/path";
import { CaseInUseError, CaseLock, pidAlive } from "../src/core/caselock.ts";
import { supervisorFile, type SupervisorInfo } from "../src/app/supervisor.ts";
import { CLAUDE_SETTINGS } from "../src/core/case.ts";
import { CLAUDE_GUIDE } from "../src/core/guide.ts";
import { SCHEMA_VERSION } from "../src/core/publicdb.ts";
import { defaultConfigDir } from "../src/app/paths.ts";
import { backupCase } from "../src/app/upgrade_backup.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

export interface ReleaseRecord {
  release: string;
  commit: string;
  releasedAt: string;
  publicDbSchema: number;
  /** sha256 of the generated CLAUDE.md and .claude/settings.json text, to spot a change. */
  generatedFiles: string;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  Deno.exit(1);
}

async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd: REPO, stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

async function task(name: string) {
  const out = await new Deno.Command(Deno.execPath(), { args: ["task", name], cwd: REPO }).spawn()
    .status;
  if (!out.success) fail(`deno task ${name} failed. Nothing was released.`);
}

/** Is a program inside `appPath` running? */
async function running(appPath: string): Promise<boolean> {
  const out = await new Deno.Command("pgrep", { args: ["-f", `${appPath}/`], stdout: "null" })
    .output();
  return out.success;
}

/** `deno task desktop`, with release.json in the bundle so the app can say which release it is. */
async function buildDesktop() {
  const tasks = JSON.parse(await Deno.readTextFile(join(REPO, "deno.json"))).tasks;
  const words = String(tasks.desktop).split(/\s+/);
  if (words[0] !== "deno" || !words.includes("--output")) fail("Unexpected desktop task");
  const args = words.slice(1);
  args.splice(args.indexOf("--output"), 0, "--include", "release.json");
  const out = await new Deno.Command(Deno.execPath(), { args, cwd: REPO }).spawn().status;
  if (!out.success) fail("Building the desktop app failed. The release is not tagged.");
}

async function generatedFilesHash(): Promise<string> {
  const text = CLAUDE_GUIDE + "\0" + JSON.stringify(CLAUDE_SETTINGS);
  return encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["case", "bin-dir"],
    collect: ["case"],
    boolean: ["help", "desktop"],
  });
  if (args.help) {
    console.log("deno task release [--case DIR]... [--bin-dir DIR] [--desktop]");
    Deno.exit(0);
  }
  if (Deno.env.get("CASEFILE_CONFIG_DIR")) {
    fail(
      "CASEFILE_CONFIG_DIR is set. Releases use the app's default folder (Claude Code is blocked " +
        "from it, so the backups are too). Unset it and run again.",
    );
  }
  const home = Deno.env.get("HOME") ?? fail("HOME is not set");
  const binDir = resolve(args["bin-dir"] ?? join(home, ".local", "bin"));
  const config = defaultConfigDir();

  // ── 1. the checkout ────────────────────────────────────────────────────────
  if (resolve(await git("rev-parse", "--absolute-git-dir"), "..") !== resolve(REPO)) {
    fail("Run this from the main checkout, not a worktree.");
  }
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") fail(`This checkout is on ${branch}. Release from main.`);
  // bin/ and dist/ are build output.
  const dirty = await git("status", "--porcelain", "--", ".", ":!dist", ":!bin");
  if (dirty) fail(`There are uncommitted changes:\n${dirty}`);
  const commit = await git("rev-parse", "HEAD");
  const tags = (await git("tag", "--list", "use-*", "--sort=-creatordate")).split("\n")
    .filter(Boolean);
  const atHead = (await git("tag", "--points-at", "HEAD", "--list", "use-*")).split("\n")
    .filter(Boolean)[0];
  const last = await readJson<ReleaseRecord>(join(REPO, "release.json"));
  const previous = (last?.release !== atHead ? last?.release : undefined) ??
    tags.find((t) => t !== atHead) ?? null;
  // The local date: the tag is for the user, who reads it in their own day.
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
  let n = 1;
  while (tags.includes(`use-${day}-${n}`)) n++;
  const release = atHead ?? `use-${day}-${n}`;

  const appConfig = await readJson<{ lastCase?: string }>(join(config, "config.json"));
  const cases = (args.case as string[] | undefined)?.length
    ? (args.case as string[]).map((c) => resolve(c))
    : appConfig?.lastCase
    ? [appConfig.lastCase]
    : [];
  // `deno task app` running: it is restarted into the release, and backs up its open case then.
  const sup = await readJson<SupervisorInfo>(supervisorFile(config));
  const supervisor = sup && pidAlive(sup.pid) ? sup : null;
  // Before the slow checks: anything else with the case open must close it first.
  const atRestart = new Set<string>();
  for (const c of cases) {
    const holder = await CaseLock.holder(c);
    if (!holder) continue;
    if (supervisor && holder.by === "app") atRestart.add(c);
    else fail(`${c}\n  is open in casefile. Lock the case (or quit casefile) and run again.`);
  }

  const desktopApp = join(REPO, "dist", "casefile.app");
  if (args.desktop && await running(desktopApp)) {
    fail("The casefile desktop app is running. Quit it and run again.");
  }

  console.log(`Releasing ${commit.slice(0, 7)} as ${release}${atHead ? " (already tagged)" : ""}.`);
  console.log(`\n── Checks (deno task ci) ──`);
  await task("ci");

  // ── 2. backups ──────────────────────────────────────────────────────────────
  console.log(`\n── Backups ──`);
  if (cases.length === 0) console.log("No case opened yet, so nothing to back up.");
  for (const c of cases) {
    if (atRestart.has(c)) {
      console.log(`${c}\n  is open in casefile: it is backed up when casefile restarts (below).`);
      continue;
    }
    try {
      const b = await backupCase(c, join(config, "backups"), {
        release,
        previous: last?.release ?? null,
      });
      console.log(`✓ ${c}\n  → ${b.dir} (${b.files} files, public.db schema v${b.schema})`);
      if (b.skippedLinks.length) {
        console.log(`  Links in the case folder were not copied: ${b.skippedLinks.join(", ")}`);
      }
    } catch (e) {
      if (e instanceof CaseInUseError) {
        fail(`${c}\n  is open in casefile. Lock the case (or quit casefile) and run again.`);
      }
      fail(`Could not back up ${c}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 3. the CLI ──────────────────────────────────────────────────────────────
  console.log(`\n── CLI ──`);
  await task("build:cli");
  await Deno.mkdir(binDir, { recursive: true });
  const target = join(binDir, "casefile");
  await Deno.copyFile(join(REPO, "bin", "casefile"), `${target}.new`);
  await Deno.chmod(`${target}.new`, 0o755);
  await Deno.rename(`${target}.new`, target);
  console.log(`✓ Installed ${target}`);
  const onPath = (Deno.env.get("PATH") ?? "").split(DELIMITER).some((p) => resolve(p) === binDir);
  if (!onPath) console.log(`  ${binDir} is not on your PATH: Claude Code won't find casefile.`);

  // ── 4. record, and the desktop app ──────────────────────────────────────────
  const record: ReleaseRecord = {
    release,
    commit,
    releasedAt: new Date().toISOString(),
    publicDbSchema: SCHEMA_VERSION,
    generatedFiles: await generatedFilesHash(),
  };
  await Deno.writeTextFile(join(REPO, "release.json"), JSON.stringify(record, null, 2) + "\n");
  if (args.desktop) {
    console.log(`\n── Desktop app ──`);
    await buildDesktop();
    console.log(`✓ Built ${desktopApp}`);
  }

  // ── 5. tag ──────────────────────────────────────────────────────────────────
  if (!atHead) await git("tag", release);

  console.log(`\n── What changed since ${previous ?? "the start"} ──`);
  console.log(
    previous
      ? (await git("log", "--oneline", "--no-merges", `${previous}..HEAD`)) || "(nothing)"
      : "(first release)",
  );
  if (last && last.publicDbSchema !== record.publicDbSchema) {
    console.log(
      `\n! public.db goes from schema v${last.publicDbSchema} to v${record.publicDbSchema} the ` +
        "next time the case opens. Earlier builds can't open it after that; the backup above is " +
        "the way back.",
    );
  }
  if (last && last.generatedFiles !== record.generatedFiles) {
    console.log(
      "\n! The case folder's generated CLAUDE.md or .claude/settings.json changed. Settings → " +
        "Claude Code in this folder will say so; restore them there.",
    );
  }
  if (!supervisor) {
    console.log(`\n✓ Released ${release}. Start casefile with deno task app.`);
    Deno.exit(0);
  }

  // ── 6. restart the running app ──────────────────────────────────────────────
  console.log(`\n── Restarting casefile ──`);
  Deno.kill(supervisor.pid, "SIGHUP");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const st = await (await fetch(`http://127.0.0.1:${supervisor.port}/api/status`)).json();
      if (st.build?.release === release) {
        console.log(
          `✓ Released ${release}. casefile restarted on it${
            st.unlocked ? "; the case stayed open" : ""
          }. Reload the page in your browser when it says casefile was updated.`,
        );
        Deno.exit(0);
      }
    } catch { /* restarting */ }
  }
  fail(`Released ${release}, but casefile did not come back. Check its terminal.`);
}
