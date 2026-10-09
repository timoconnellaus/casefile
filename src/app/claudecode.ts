import { isAbsolute, join, SEPARATOR } from "@std/path";
import { type CasePaths, checkScaffold, isCaseDir, type ScaffoldCheck } from "../core/case.ts";

/**
 * Claude Code in the case folder (ADR 17): is it set up as casefile generated it, are `claude` and
 * `casefile` installed, and opening Terminal in the case folder.
 *
 * Finding the programs only stats files on the PATH and in a few usual install folders; nothing
 * is run. Opening Terminal runs exactly `open -a Terminal <case folder>` on macOS (the app task
 * has `--allow-run=open` and nothing else); everywhere else, and if that fails, the UI shows the
 * command to type instead.
 */

export interface ClaudeCodeEnv {
  /** The PATH to search (default: this process's PATH). */
  path?: string;
  /** The user's home folder (default: $HOME). */
  home?: string;
  /** The operating system (default: Deno.build.os). */
  os?: typeof Deno.build.os;
  /** Opens Terminal in a folder (default: `open -a Terminal <dir>`). Tests replace it. */
  openTerminal?: (dir: string) => Promise<void>;
  /** Opens an allowed help link in the browser (default: `open <url>`; see links.ts). */
  openUrl?: (url: string) => Promise<void>;
}

/**
 * Where the installers put `claude` and where people put `casefile`. A desktop app started from
 * the Finder gets a short PATH (`/usr/bin:/bin:…`), so these are searched too.
 */
export function wellKnownDirs(home: string): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, "bin"),
    join(home, ".deno", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** Folders to search: the PATH's absolute entries (a relative one would search the cwd), then the usual ones. */
export function searchDirs(env: ClaudeCodeEnv = {}): string[] {
  const home = env.home ?? Deno.env.get("HOME") ?? "";
  const path = env.path ?? Deno.env.get("PATH") ?? "";
  const dirs = path.split(Deno.build.os === "windows" ? ";" : ":").filter((d) => isAbsolute(d));
  if (home) dirs.push(...wellKnownDirs(home));
  return [...new Set(dirs)];
}

/** The first executable file called `name` in `dirs` (symlinks followed), or null. */
export async function findExecutable(name: string, dirs: string[]): Promise<string | null> {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error("Bad program name");
  for (const d of dirs) {
    const p = join(d, name);
    try {
      const st = await Deno.stat(p);
      if (st.isFile && ((st.mode ?? 0o111) & 0o111) !== 0) return p;
    } catch {
      // not here
    }
  }
  return null;
}

const SAFE = /^[A-Za-z0-9_./-]+$/;

/** Quote a path for a POSIX shell. */
export function shellQuote(s: string): string {
  return SAFE.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The command the user can type to start Claude Code in the case folder. */
export function startCommand(caseDir: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME");
  const under = h && caseDir.startsWith(h.endsWith(SEPARATOR) ? h : h + SEPARATOR);
  const where = under
    ? `~/${shellQuote(caseDir.slice(h!.length).replace(/^\/+/, ""))}`
    : shellQuote(
      caseDir,
    );
  return `cd ${where} && claude`;
}

/**
 * The only program casefile runs: `open -a Terminal <case folder>`. The folder is the open
 * case's absolute path (never request input), so it cannot be read as an option.
 */
export function terminalCommand(caseDir: string): { cmd: "open"; args: string[] } {
  if (!isAbsolute(caseDir)) throw new Error("The case folder must be an absolute path");
  return { cmd: "open", args: ["-a", "Terminal", caseDir] };
}

export async function defaultOpenTerminal(dir: string): Promise<void> {
  const { cmd, args } = terminalCommand(dir);
  const out = await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output();
  if (!out.success) throw new Error(`open exited with ${out.code}`);
}

export interface Program {
  found: boolean;
  path: string | null;
}

export interface ClaudeCodeStatus extends ScaffoldCheck {
  /** "ok" when every generated file matches and nothing overrides them; else "changed". */
  state: "ok" | "changed";
  checkedAt: string;
  caseDir: string;
  /** What to type in Terminal to start Claude Code here. */
  command: string;
  claude: Program;
  casefile: Program;
  /** Whether "Open Terminal here" can work on this computer (macOS only). */
  canOpenTerminal: boolean;
}

export async function claudeCodeStatus(
  paths: CasePaths,
  env: ClaudeCodeEnv = {},
): Promise<ClaudeCodeStatus> {
  const check = await checkScaffold(paths);
  const dirs = searchDirs(env);
  const claude = await findExecutable("claude", dirs);
  const casefile = await findExecutable("casefile", dirs);
  const ok = check.settingsFile === "ok" && check.guideFile === "ok" &&
    check.localOverrides.length === 0 && check.links.length === 0 && check.webBlocked &&
    check.sandbox;
  return {
    state: ok ? "ok" : "changed",
    checkedAt: new Date().toISOString(),
    caseDir: paths.root,
    command: startCommand(paths.root, env.home),
    ...check,
    claude: { found: claude !== null, path: claude },
    casefile: { found: casefile !== null, path: casefile },
    canOpenTerminal: (env.os ?? Deno.build.os) === "darwin",
  };
}

/**
 * Open Terminal in the case folder. Returns whether it worked; never throws for "can't" (not
 * macOS, no run permission, `open` failed), so the UI can fall back to showing the command.
 */
export async function openTerminalIn(caseDir: string, env: ClaudeCodeEnv = {}): Promise<boolean> {
  if ((env.os ?? Deno.build.os) !== "darwin") return false;
  try {
    // Only ever the case folder itself: its real path, a folder, with the case marker.
    const real = await Deno.realPath(caseDir);
    if (!(await Deno.stat(real)).isDirectory || !isCaseDir(real)) return false;
    await (env.openTerminal ?? defaultOpenTerminal)(real);
    return true;
  } catch {
    return false;
  }
}
