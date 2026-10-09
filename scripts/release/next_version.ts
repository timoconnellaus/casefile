#!/usr/bin/env -S deno run --allow-read --allow-run
/**
 * The version to release a push to main as (ADR 23): the last `vMAJOR.MINOR.PATCH` tag, bumped.
 * PATCH by default; MINOR or MAJOR when a commit since the last release says `[minor]` or
 * `[major]` (in its title or body, e.g. the PR title). With no release yet, deno.json's `version`.
 * Prints nothing when this commit is already released (a re-run), so the workflow skips.
 *
 *   deno run --allow-read --allow-run scripts/release/next_version.ts
 */
import { parseVersion } from "./signing.ts";

export type Bump = "major" | "minor" | "patch";

export function bumpOf(messages: string[]): Bump {
  const all = messages.join("\n");
  if (/\[major\]/i.test(all)) return "major";
  if (/\[minor\]/i.test(all)) return "minor";
  return "patch";
}

export function bump(version: string, kind: Bump): string {
  const [a, b, c] = parseVersion(version)!;
  if (kind === "major") return `${a + 1}.0.0`;
  if (kind === "minor") return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

/** The highest `vX.Y.Z` among `tags`, without the `v`, or null. */
export function latest(tags: string[]): string | null {
  const versions = tags.map((t) => t.replace(/^v/, "")).filter((v) => parseVersion(v));
  versions.sort((x, y) => {
    const a = parseVersion(x)!, b = parseVersion(y)!;
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  return versions.at(-1) ?? null;
}

async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(out.stdout).trim();
}

if (import.meta.main) {
  if (await git("tag", "--points-at", "HEAD", "--list", "v*.*.*")) Deno.exit(0);
  const last = latest((await git("tag", "--list", "v*.*.*")).split("\n").filter(Boolean));
  if (!last) {
    const deno = JSON.parse(await Deno.readTextFile("deno.json"));
    console.log(deno.version);
    Deno.exit(0);
  }
  const log = await git("log", "--format=%B", `v${last}..HEAD`);
  console.log(bump(last, bumpOf([log])));
}
