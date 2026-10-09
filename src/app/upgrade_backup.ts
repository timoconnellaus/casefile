/**
 * The upgrade backup `deno task release` makes before a new build can open the case (ADR 22).
 *
 * public.db migrations only go forward, so after a release the way back to the earlier build is
 * this copy. It is made while holding the case-in-use lock, so neither the app nor the seed can
 * open (and repair) the case halfway through, and public.db is copied with SQLite's online backup,
 * which makes a consistent copy even while the CLI (Claude) is writing to it.
 *
 * Backups go in the app's own folder (`<config>/backups/<case folder name>/<time>-before-<release>/`),
 * which the generated Claude Code settings block. A backed-up public.db still holds documents
 * withdrawn or withheld since, so it must never be somewhere Claude can read.
 *
 * Symbolic links in the case folder are not followed or copied (Claude can make them there); the
 * lock file is left out. Claude can also swap a file or folder for a link while the copy runs. A
 * restored backup lands back in the case folder, where Claude can read it, so a file the copy
 * reached through a link would then be readable. Each file is therefore read through one open
 * handle whose inode must be the one first seen as a regular file, and each folder and file must
 * resolve to its own place inside the case folder. Deno has no O_NOFOLLOW or openat, so the folder
 * check narrows the window rather than closing it (the residual race of ADR 13).
 */
import { basename, join } from "@std/path";
import { backup, DatabaseSync } from "node:sqlite";
import { CASE_LOCK_FILE, CaseLock } from "../core/caselock.ts";
import { casePaths, isCaseDir } from "../core/case.ts";

export interface BackupResult {
  dir: string;
  files: number;
  /** Links in the case folder that were not copied, relative to it. */
  skippedLinks: string[];
  /** public.db's schema version when it was copied. */
  schema: number | null;
}

const PUBLIC_DB_FILES = new Set([
  "public.db",
  "public.db-wal",
  "public.db-shm",
  "public.db-journal",
]);

/** Back up `root` into `backupsDir`. Throws CaseInUseError while the case is open. */
export async function backupCase(
  root: string,
  backupsDir: string,
  info: {
    /** The release about to be installed. */
    release: string;
    /** The release in use until now (its build last opened the case), if any. */
    previous: string | null;
    now?: Date;
  },
): Promise<BackupResult> {
  const paths = casePaths(root);
  if (!isCaseDir(paths.root)) throw new Error(`Not a casefile case: ${paths.root}`);
  const lock = await CaseLock.acquire(paths.root, "release");
  try {
    const now = info.now ?? new Date();
    const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "");
    const dir = join(backupsDir, basename(paths.root), `${stamp}-before-${info.release}`);
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    const result: BackupResult = { dir, files: 0, skippedLinks: [], schema: null };

    const realRoot = await Deno.realPath(paths.root);
    /** `rel` must still be where it was, not reached through a link. */
    const inPlace = async (rel: string) =>
      (await Deno.realPath(rel ? join(paths.root, rel) : paths.root)) ===
        (rel ? join(realRoot, rel) : realRoot);

    const copyTree = async (from: string, to: string, rel: string) => {
      if (!(await inPlace(rel))) {
        result.skippedLinks.push(rel);
        return;
      }
      for await (const e of Deno.readDir(from)) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (!rel && (e.name === CASE_LOCK_FILE || PUBLIC_DB_FILES.has(e.name))) continue;
        const st = await Deno.lstat(join(from, e.name));
        if (st.isSymlink) result.skippedLinks.push(relPath);
        else if (st.isDirectory) {
          await Deno.mkdir(join(to, e.name), { mode: 0o700 });
          await copyTree(join(from, e.name), join(to, e.name), relPath);
        } else if (st.isFile) {
          const f = await Deno.open(join(from, e.name), { read: true });
          try {
            const now = await f.stat();
            if (
              !now.isFile || now.ino !== st.ino || now.dev !== st.dev || !(await inPlace(relPath))
            ) {
              result.skippedLinks.push(relPath);
              continue;
            }
            await Deno.writeFile(join(to, e.name), f.readable, { createNew: true, mode: 0o600 });
          } finally {
            try {
              f.close();
            } catch { /* closed by writeFile when it consumed the stream */ }
          }
          result.files++;
        }
      }
    };
    await copyTree(paths.root, dir, "");

    const db = await Deno.lstat(paths.publicDb).catch(() => null);
    if (db?.isFile && (await inPlace("public.db"))) {
      const src = new DatabaseSync(paths.publicDb, { readOnly: true });
      try {
        result.schema = (src.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        await backup(src, join(dir, "public.db"));
      } finally {
        src.close();
      }
      result.files++;
    }

    await Deno.writeTextFile(
      join(dir, "backup.json"),
      JSON.stringify(
        {
          format: "casefile-backup",
          case: paths.root,
          madeBefore: info.release,
          previousRelease: info.previous,
          createdAt: now.toISOString(),
          publicDbSchema: result.schema,
        },
        null,
        2,
      ) + "\n",
    );
    return result;
  } finally {
    lock.release();
  }
}
