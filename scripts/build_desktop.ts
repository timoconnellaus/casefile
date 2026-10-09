#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
/**
 * Build dist/casefile.app (ADR 2, ADR 24): `deno task desktop`.
 *
 * - Builds the CLI first and carries it in the app (`--include bin/casefile`); the app installs
 *   it on first start of each version (src/app/cli_install.ts).
 * - Leaves out onnxruntime's binaries for other platforms (Linux, Windows, Intel Macs): about
 *   175 MB of the bundle, and the update patches are made by diffing the whole runtime.
 * - The version is deno.json's `version`; CI sets it from the release tag.
 * - Needs Deno 2.9.5 or later: before it, packaged apps could not verify a signed update manifest
 *   (denoland/deno#36150), so they would refuse every update.
 */
import { fromFileUrl, join } from "@std/path";

const REPO = fromFileUrl(new URL("..", import.meta.url));

async function run(args: string[]) {
  const ok = (await new Deno.Command(Deno.execPath(), { args, cwd: REPO }).spawn().status).success;
  if (!ok) Deno.exit(1);
}

async function npmCache(): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), { args: ["info", "--json"], cwd: REPO })
    .output();
  return JSON.parse(new TextDecoder().decode(out.stdout)).npmCache;
}

if (import.meta.main) {
  if (Deno.build.os !== "darwin" || Deno.build.arch !== "aarch64") {
    console.error("The desktop app is built on an Apple Silicon Mac (macOS, arm64).");
    Deno.exit(1);
  }
  const [major, minor, patch] = Deno.version.deno.split(".").map(Number);
  if (major < 2 || (major === 2 && (minor < 9 || (minor === 9 && patch < 5)))) {
    console.error(
      `Deno ${Deno.version.deno} can't verify signed updates; build with 2.9.5 or later.`,
    );
    Deno.exit(1);
  }
  await run(["task", "build:cli"]);
  const ort = join(await npmCache(), "registry.npmjs.org", "onnxruntime-node");
  const excludes: string[] = [];
  try {
    for await (const v of Deno.readDir(ort)) {
      const bin = join(ort, v.name, "bin", "napi-v3");
      excludes.push(join(bin, "linux"), join(bin, "win32"), join(bin, "darwin", "x64"));
    }
  } catch { /* not cached yet: nothing to leave out */ }
  await run([
    "desktop",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-net",
    "--allow-ffi",
    "--allow-sys",
    "--allow-run=open",
    "--include",
    "src/app/ui",
    "--include",
    "bin/casefile",
    // PDF import reads the text layer in a worker (ADR 23, PDF import).
    "--include",
    "src/core/pdf_worker.ts",
    ...excludes.flatMap((e) => ["--exclude", e]),
    // `deno desktop` adds the .app itself.
    "--output",
    "dist/casefile",
    "src/app/main.ts",
  ]);
}
