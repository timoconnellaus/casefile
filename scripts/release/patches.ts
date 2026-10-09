#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
/**
 * Make update patches from earlier releases to this one (ADR 24). Run by CI on the macOS runner
 * after `deno task desktop`:
 *
 *   deno run … scripts/release/patches.ts --version 0.3.0 --out out \
 *     --dylib dist/casefile.app/Contents/MacOS/libruntime.dylib --keep 3
 *
 * For each of the last `--keep` published releases older than this one, downloads its app
 * (`casefile-macos-arm64.zip`, with `gh`), diffs its runtime dylib against this build's with
 * `bsdiff`, and checks with `bspatch` that the patch rebuilds this build's dylib byte for byte.
 * Writes `patch-<from>-to-<to>.bin` and `patches.args` (the `--patch` arguments for manifest.ts).
 * Apps older than that get no patch and stay put until reinstalled.
 */
import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { parseVersion } from "./signing.ts";

const ZIP = "casefile-macos-arm64.zip";
const DYLIB = "casefile.app/Contents/MacOS/libruntime.dylib";

async function sh(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stderr: "inherit" }).output();
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")} failed`);
  return new TextDecoder().decode(out.stdout);
}

function older(a: string, b: string): boolean {
  const x = parseVersion(a)!, y = parseVersion(b)!;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([Deno.readFile(a), Deno.readFile(b)]);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ["version", "out", "dylib", "keep"] });
  const version = args.version!;
  if (!parseVersion(version)) throw new Error(`Not a version: ${version}`);
  const out = resolve(args.out!);
  const dylib = resolve(args.dylib!);
  const keep = Number(args.keep ?? 3);
  await Deno.mkdir(out, { recursive: true });

  const releases = JSON.parse(
    await sh("gh", [
      "release",
      "list",
      "--exclude-drafts",
      "--exclude-pre-releases",
      "--limit",
      "50",
      "--json",
      "tagName",
    ]),
  ) as { tagName: string }[];
  const earlier = releases.map((r) => r.tagName.replace(/^v/, ""))
    .filter((v) => parseVersion(v) && older(v, version))
    .sort((a, b) => (older(a, b) ? 1 : -1))
    .slice(0, keep);

  const argsOut: string[] = [];
  for (const from of earlier) {
    const work = await Deno.makeTempDir();
    try {
      await sh("gh", ["release", "download", `v${from}`, "--pattern", ZIP, "--dir", work]);
      await sh("ditto", ["-x", "-k", join(work, ZIP), work]);
      const name = `patch-${from}-to-${version}.bin`;
      await sh("bsdiff", [join(work, DYLIB), dylib, join(out, name)]);
      await sh("bspatch", [join(work, DYLIB), join(work, "rebuilt"), join(out, name)]);
      if (!(await sameBytes(join(work, "rebuilt"), dylib))) {
        throw new Error(`The patch from ${from} does not rebuild this version's runtime`);
      }
      argsOut.push(`--patch ${from}=${name}`);
      console.log(`✓ ${name} (${(await Deno.stat(join(out, name))).size} bytes)`);
    } finally {
      await Deno.remove(work, { recursive: true });
    }
  }
  await Deno.writeTextFile(join(out, "patches.args"), argsOut.join(" ") + "\n");
  if (earlier.length === 0) console.log("No earlier release: no patches.");
}
