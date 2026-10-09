/**
 * Which copy of casefile is running (ADR 22).
 *
 * `deno task release` writes `release.json` at the root of the checkout it releases from (it is
 * gitignored), so the copy in daily use can say which release it is. A development run
 * (`deno task dev`) says so instead, and a checkout that was never released says "not released".
 * Read once at start: an app started before a release keeps saying what it is running.
 */

export interface BuildInfo {
  /** The release tag (`use-2026-10-09-1`), or null when not released. */
  release: string | null;
  commit: string | null;
  releasedAt: string | null;
  /** Started by `deno task dev` against the synthetic case only. */
  dev: boolean;
}

const RELEASE_FILE = new URL("../../release.json", import.meta.url);

export async function readBuildInfo(dev: boolean): Promise<BuildInfo> {
  const info: BuildInfo = { release: null, commit: null, releasedAt: null, dev };
  if (dev) return info;
  try {
    const r = JSON.parse(await Deno.readTextFile(RELEASE_FILE));
    if (typeof r.release === "string") info.release = r.release;
    if (typeof r.commit === "string") info.commit = r.commit;
    if (typeof r.releasedAt === "string") info.releasedAt = r.releasedAt;
  } catch { /* not released, or a desktop bundle without the file */ }
  return info;
}
