import { dirname, join, relative, resolve } from "@std/path";
import { CLAUDE_GUIDE } from "./guide.ts";

/**
 * A case folder (ADR 0003):
 *
 *   case.json              marker: { format: "casefile-case", version: 1 }
 *   public.db              everything Claude may see (tokenised)
 *   vault/                 originals + token key, encrypted (desktop app only)
 *   CLAUDE.md              how Claude should work in this case (generated)
 *   .claude/settings.json  Claude Code permission rules denying the vault (generated)
 *
 * This module only deals with paths and the generated files; it does not touch the vault's contents,
 * so the CLI may import it.
 */

export const CASE_MARKER = "case.json";

export interface CasePaths {
  root: string;
  marker: string;
  publicDb: string;
  vaultDir: string;
  claudeGuide: string;
  claudeSettings: string;
  /** Claude Code's per-user project settings; not generated, but checked (ADR 17). */
  claudeLocalSettings: string;
}

export function casePaths(root: string): CasePaths {
  const r = resolve(root);
  return {
    root: r,
    marker: join(r, CASE_MARKER),
    publicDb: join(r, "public.db"),
    vaultDir: join(r, "vault"),
    claudeGuide: join(r, "CLAUDE.md"),
    claudeSettings: join(r, ".claude", "settings.json"),
    claudeLocalSettings: join(r, ".claude", "settings.local.json"),
  };
}

export function isCaseDir(dir: string): boolean {
  try {
    const m = JSON.parse(Deno.readTextFileSync(join(dir, CASE_MARKER)));
    return m?.format === "casefile-case";
  } catch {
    return false;
  }
}

/** Walk up from `start` to find the enclosing case folder. */
export function findCaseDir(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    if (isCaseDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Directories outside the case that hold app state Claude must not read or change: the app's
 * config folder and the NER model cache (macOS and Linux locations, ADR 12). Paths in permission
 * rules and sandbox settings are home-relative (`~/`).
 */
const APP_DIRS = [
  "~/Library/Application Support/casefile",
  "~/.config/casefile",
  "~/Library/Caches/casefile",
  "~/.cache/casefile",
];

/**
 * Generated `.claude/settings.json` for a case folder (ADR 3).
 *
 * The protection is the **sandbox** (Claude Code's OS-level sandbox for Bash commands;
 * https://code.claude.com/docs/en/sandboxing, keys in
 * https://code.claude.com/docs/en/settings-reference), which applies to every process a command
 * starts (python3, node, cat, cp…). The `permissions.deny` rules are only defence in depth: they
 * match Claude Code's own tools and the literal command names they list, and are trivially
 * sidestepped by any other program (e.g. `python3 -c 'import sqlite3…'` instead of `sqlite3`).
 * Nothing here relies on them. The docs state that `Read` deny rules are also added to the
 * sandbox's `denyRead` list; casefile lists the paths in `denyRead` itself anyway.
 *
 * - `enabled` + `failIfUnavailable`: commands run sandboxed, and Claude Code refuses to start if
 *   the sandbox can't (instead of silently running unsandboxed).
 * - `allowUnsandboxedCommands: false`: Claude cannot retry a blocked command outside the sandbox.
 * - Writes are limited to the working directory (the case folder) and temp by default; `denyWrite`
 *   also protects `vault/`. `denyRead` blocks the vault and the app's folders.
 * - `network.allowLocalBinding: false` (the default, stated explicitly): on macOS sandboxed
 *   commands can neither listen on a port (e.g. pose as the local LLM on :11434) nor connect to
 *   localhost (the app's API). On Linux each command has its own loopback.
 * - No `allowedDomains`: every outbound host goes through Claude Code's proxy and its permission
 *   prompt. (Refusing all hosts outright needs `network.strictAllowlist`, which only user or
 *   managed settings can set.)
 *
 * - Web tools are denied (FCFCOA PD-AI para 5.4: "disable ... web search access ... if this option
 *   is available"). Tool names from https://code.claude.com/docs/en/tools-reference and rule
 *   syntax from https://code.claude.com/docs/en/permissions ("Match all uses of a tool", "Allow
 *   or deny every fetch"): a bare `WebSearch` or `WebFetch` deny rule removes the tool from
 *   Claude's context entirely. `Artifact` (publishing pages to claude.ai) is denied the same way
 *   and `enableArtifact: false` turns artifacts off for the project
 *   (https://code.claude.com/docs/en/artifacts#disable-artifacts), so case content is not
 *   published outside the case folder. The bare `WebFetch` rule does not change which hosts
 *   sandboxed commands can reach; those still go through the network prompt (see above).
 *
 * The `casefile` CLI only reads and writes `public.db` in the case folder, so it runs sandboxed.
 */
export const CLAUDE_SETTINGS = {
  permissions: {
    deny: [
      "Read(./vault/**)",
      "Edit(./vault/**)",
      "Write(./vault/**)",
      "Bash(sqlite3:*)",
      ...APP_DIRS.flatMap((d) => [`Read(${d}/**)`, `Edit(${d}/**)`]),
      // PD-AI 5.4: no web search or fetching, and no publishing to claude.ai.
      "WebSearch",
      "WebFetch",
      "Artifact",
    ],
  },
  enableArtifact: false,
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: ["./vault", ...APP_DIRS],
      denyWrite: ["./vault", ...APP_DIRS],
    },
    network: {
      allowLocalBinding: false,
    },
  },
};

// ── writing inside the case folder without following links ──────────────────
//
// Claude Code can write inside the case folder, so it could replace `.claude/`, `settings.json`
// or `CLAUDE.md` with a symbolic link to a file elsewhere (the vault, the app's config, any file
// of the user's). casefile's own writes there must never follow one: every path component under
// the case folder is checked with lstat, a link where a folder should be is removed (the link
// only, never its target) and replaced with a real folder, files are written to a new temp file
// in the verified real folder and renamed over the target (renaming over a link replaces the
// link), and the folder's real path must still be inside the case folder just before the rename.
// Reads for the status check never follow a link either: a link is reported as changed.

export class UnsafeCasePathError extends Error {
  constructor(what: string) {
    super(`casefile won't write ${what}: it is not a plain file or folder inside the case folder`);
    this.name = "UnsafeCasePathError";
  }
}

async function lstatOrNull(p: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(p);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * Make `root/parts…` a real folder: create missing ones, and replace a symbolic link at any level
 * with a new, empty folder. Returns its path under the real root, verified with realPath.
 */
async function ensureRealDir(rootReal: string, parts: string[]): Promise<string> {
  let dir = rootReal;
  for (const part of parts) {
    dir = join(dir, part);
    const st = await lstatOrNull(dir);
    if (st?.isSymlink) await Deno.remove(dir); // removes the link itself, not what it points to
    else if (st && !st.isDirectory) throw new UnsafeCasePathError(relative(rootReal, dir));
    if (!st || st.isSymlink) await Deno.mkdir(dir);
  }
  if ((await Deno.realPath(dir)) !== dir) throw new UnsafeCasePathError(relative(rootReal, dir));
  return dir;
}

/**
 * Test hooks for simulating a swap at the moments a race could happen (between the checks and
 * the open or rename). Unset in the app.
 */
export const scaffoldTestHooks: {
  beforeRename?: (dir: string) => Promise<void>;
  beforeOpen?: (path: string) => Promise<void>;
} = {};

/** Largest generated or checked file casefile reads from the case folder. */
export const MAX_SCAFFOLD_READ = 64 * 1024;
/** A read of a regular file that takes longer than this is abandoned (e.g. a pipe swapped in). */
const READ_TIMEOUT_MS = 2_000;

const sameFile = (a: Deno.FileInfo, b: Deno.FileInfo) =>
  a.dev === b.dev && a.ino === b.ino && a.dev !== null && a.ino !== null;

/** Write `root/rel` as described above. */
async function safeWriteText(rootReal: string, rel: string, text: string): Promise<void> {
  const parts = rel.split("/");
  const name = parts.pop()!;
  const dir = await ensureRealDir(rootReal, parts);
  const target = join(dir, name);
  const st = await lstatOrNull(target);
  // A folder there is refused. Anything else (file, link, pipe…) is replaced by the rename,
  // which swaps the folder entry without opening what was there.
  if (st?.isDirectory) throw new UnsafeCasePathError(rel);
  const tmp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  // createNew (O_EXCL): never write through anything already at the temp name, link or not.
  const f = await Deno.open(tmp, { write: true, createNew: true, mode: 0o644 });
  let written: Deno.FileInfo;
  try {
    const data = new TextEncoder().encode(text);
    let off = 0;
    while (off < data.length) off += await f.write(data.subarray(off));
    written = await f.stat();
  } finally {
    f.close();
  }
  try {
    await scaffoldTestHooks.beforeRename?.(dir);
    // Re-verify after the temp file exists and just before the rename: the folder is still the
    // real folder inside the case, and the temp name is still the file written above.
    if ((await Deno.realPath(dir)) !== dir) throw new UnsafeCasePathError(rel);
    const now = await lstatOrNull(tmp);
    if (!now?.isFile || !sameFile(now, written)) throw new UnsafeCasePathError(rel);
    await Deno.rename(tmp, target); // within the same verified folder
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** What a read of a file in the case folder found. Only `ok` carries text. */
type SafeRead =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "link" }
  | { kind: "unsafe"; why: string };

/**
 * Read `root/rel` without following links, and only if it is a regular file of at most
 * MAX_SCAFFOLD_READ bytes. The file is opened after an lstat, then its fstat must show the same
 * device and inode (so a link or pipe swapped in between is not read), and at most the cap is
 * read. A link anywhere on the way is reported, not followed.
 */
async function safeReadText(rootReal: string, rel: string): Promise<SafeRead> {
  let p = rootReal;
  let st: Deno.FileInfo | null = null;
  for (const part of rel.split("/")) {
    p = join(p, part);
    st = await lstatOrNull(p);
    if (!st) return { kind: "missing" };
    if (st.isSymlink) return { kind: "link" };
  }
  if (!st!.isFile) return { kind: "unsafe", why: "not a regular file" };
  if (st!.size > MAX_SCAFFOLD_READ) return { kind: "unsafe", why: "too large" };
  await scaffoldTestHooks.beforeOpen?.(p);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async (): Promise<SafeRead> => {
    let f: Deno.FsFile;
    try {
      f = await Deno.open(p, { read: true });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return { kind: "missing" };
      throw e;
    }
    try {
      const fst = await f.stat();
      if (!fst.isFile || !sameFile(fst, st!)) return { kind: "unsafe", why: "replaced while read" };
      const buf = new Uint8Array(MAX_SCAFFOLD_READ + 1);
      let n = 0;
      while (n < buf.length) {
        const got = await f.read(buf.subarray(n));
        if (got === null) break;
        n += got;
      }
      if (n > MAX_SCAFFOLD_READ) return { kind: "unsafe", why: "too large" };
      // ignoreBOM keeps a byte-order mark in the text, so it doesn't compare equal.
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf.subarray(0, n));
      return { kind: "ok", text };
    } finally {
      f.close();
    }
  })();
  const timeout = new Promise<SafeRead>((res) => {
    timer = setTimeout(() => res({ kind: "unsafe", why: "read timed out" }), READ_TIMEOUT_MS);
    Deno.unrefTimer(timer as unknown as number);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Generated files, relative to the case folder. */
const MARKER_REL = CASE_MARKER;
const GUIDE_REL = "CLAUDE.md";
const SETTINGS_REL = ".claude/settings.json";
const LOCAL_SETTINGS_REL = ".claude/settings.local.json";

/**
 * Write the marker and the Claude-facing guidance files. Idempotent. Never follows a symbolic
 * link inside the case folder (see above).
 */
export async function writeCaseScaffold(paths: CasePaths): Promise<void> {
  await Deno.mkdir(paths.root, { recursive: true });
  const rootReal = await Deno.realPath(paths.root);
  await safeWriteText(
    rootReal,
    MARKER_REL,
    JSON.stringify({ format: "casefile-case", version: 1 }, null, 2) + "\n",
  );
  await safeWriteText(rootReal, GUIDE_REL, CLAUDE_GUIDE);
  await safeWriteText(rootReal, SETTINGS_REL, CLAUDE_SETTINGS_TEXT);
}

// ── checking the generated files (ADR 17) ───────────────────────────────────
//
// Generated files are compared byte for byte with what casefile writes. They are not parsed:
// Claude Code's settings parser may read the same bytes differently (duplicate keys, a BOM,
// comments), so "parses to the same thing" is not "Claude Code sees the same thing".

/** A generated file: exactly as casefile wrote it, anything else, or gone. */
export type ScaffoldFileState = "ok" | "changed" | "missing";

export interface ScaffoldCheck {
  /** `.claude/settings.json`, byte for byte against the generated file. */
  settingsFile: ScaffoldFileState;
  /** `CLAUDE.md`, byte for byte against this build's guide. */
  guideFile: ScaffoldFileState;
  /** Web search and fetch are denied: true only when settings.json is exactly as generated and nothing re-allows them. */
  webBlocked: boolean;
  /** The strict sandbox is asked for: true only when settings.json is exactly as generated and not overridden. */
  sandbox: boolean;
  /**
   * What `.claude/settings.local.json` holds that could weaken the generated settings (Claude
   * Code merges it over them): any key but `permissions`, any `permissions` key but
   * allow/ask/deny, and allow/ask rules naming the web tools, artifacts, the vault or the app's
   * folders. A file casefile can't read safely (a link, not a regular file, over 64 KB) or that
   * is not plain JSON in a single, unambiguous form is listed as one entry saying so. Empty when
   * the file is absent or only adds harmless rules.
   */
  localOverrides: string[];
  /**
   * Generated (or checked) files that are symbolic links, or sit in a linked `.claude` folder.
   * They are not read or followed, and count as changed; restoring replaces the link.
   */
  links: string[];
}

/** The exact bytes casefile writes to `.claude/settings.json`. */
export const CLAUDE_SETTINGS_TEXT = JSON.stringify(CLAUDE_SETTINGS, null, 2) + "\n";

const RISKY_RULE = /^(WebSearch|WebFetch|Artifact)\b|vault|\/casefile\b/i;

/**
 * Overrides in settings.local.json. It is only interpreted when its bytes are exactly what
 * JSON.stringify writes for the value they parse to (2-space or compact, optional final
 * newline): that rules out duplicate keys, a BOM, comments and other forms another parser might
 * read differently. Anything else is reported, not interpreted.
 */
const MAX_LOCAL_DEPTH = 8;

/** The deepest nesting of `{`/`[` outside strings (no parsing, so no deep recursion). */
function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") max = Math.max(max, ++depth);
    else if (c === "}" || c === "]") depth--;
  }
  return max;
}

function localOverrides(r: SafeRead): string[] {
  if (r.kind === "missing") return [];
  if (r.kind === "link") return ["symbolic link"];
  if (r.kind === "unsafe") return [`unreadable: ${r.why}`];
  if (jsonDepth(r.text) > MAX_LOCAL_DEPTH) return ["unreadable: nested too deeply"];
  let v: unknown;
  let forms: string[];
  try {
    v = JSON.parse(r.text);
    forms = [JSON.stringify(v, null, 2), JSON.stringify(v)];
  } catch {
    return ["unreadable: not JSON"];
  }
  if (!forms.some((f) => r.text === f || r.text === f + "\n")) {
    return ["unreadable: not in a form casefile can check"];
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["unreadable: not an object"];
  const out: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (k !== "permissions") {
      out.push(k);
      continue;
    }
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      out.push("permissions");
      continue;
    }
    for (const [pk, rules] of Object.entries(val)) {
      if (pk === "deny") continue;
      if ((pk !== "allow" && pk !== "ask") || !Array.isArray(rules)) {
        out.push(`permissions.${pk}`);
        continue;
      }
      for (const rule of rules) {
        if (typeof rule !== "string" || RISKY_RULE.test(rule)) {
          out.push(`permissions.${pk}: ${rule}`);
        }
      }
    }
  }
  return out;
}

function fileState(r: SafeRead, expected: string): ScaffoldFileState {
  if (r.kind === "missing") return "missing";
  return r.kind === "ok" && r.text === expected ? "ok" : "changed";
}

/** Compare the case folder's Claude Code files with what this build generates. Reads only. */
export async function checkScaffold(paths: CasePaths): Promise<ScaffoldCheck> {
  const rootReal = await Deno.realPath(paths.root);
  const settingsRead = await safeReadText(rootReal, SETTINGS_REL);
  const guideRead = await safeReadText(rootReal, GUIDE_REL);
  const localRead = await safeReadText(rootReal, LOCAL_SETTINGS_REL);
  const links = [
    ...(settingsRead.kind === "link" ? [SETTINGS_REL] : []),
    ...(guideRead.kind === "link" ? [GUIDE_REL] : []),
    ...(localRead.kind === "link" ? [LOCAL_SETTINGS_REL] : []),
  ];
  const settingsFile = fileState(settingsRead, CLAUDE_SETTINGS_TEXT);
  const overrides = localOverrides(localRead);
  const unreadable = overrides.some((o) => o.startsWith("unreadable") || o === "symbolic link");
  return {
    settingsFile,
    guideFile: fileState(guideRead, CLAUDE_GUIDE),
    links,
    // CLAUDE_SETTINGS denies both web tools and asks for the strict sandbox, so an exact match
    // means both hold unless settings.local.json says otherwise.
    webBlocked: settingsFile === "ok" && !unreadable &&
      !overrides.some((o) => /Web(Search|Fetch)/.test(o)),
    sandbox: settingsFile === "ok" && !unreadable && !overrides.includes("sandbox"),
    localOverrides: overrides,
  };
}

/**
 * Put the generated files back (ADR 17): rewrite the marker, `CLAUDE.md` and
 * `.claude/settings.json`, and if `.claude/settings.local.json` overrides them, rename it to
 * `settings.local.json.disabled-<time>` so Claude Code no longer reads it (it is kept, not
 * deleted). Returns what changed, for the log.
 */
export async function restoreScaffold(
  paths: CasePaths,
): Promise<{ rewritten: string[]; movedAside: string | null }> {
  const before = await checkScaffold(paths);
  // Replaces a linked `.claude` folder with a real one, so the local file below (if any) is
  // inside the real folder.
  await writeCaseScaffold(paths);
  const rewritten: string[] = [];
  if (before.settingsFile !== "ok") rewritten.push(SETTINGS_REL);
  if (before.guideFile !== "ok") rewritten.push(GUIDE_REL);
  let movedAside: string | null = null;
  const after = await checkScaffold(paths);
  if (after.localOverrides.length) {
    const rootReal = await Deno.realPath(paths.root);
    const dir = await ensureRealDir(rootReal, [".claude"]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `settings.local.json.disabled-${stamp}`;
    // Renaming moves the file, or the link itself, never a link's target.
    await Deno.rename(join(dir, "settings.local.json"), join(dir, name));
    movedAside = `.claude/${name}`;
  }
  return { rewritten, movedAside };
}
