#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * Make and sign latest.json for a release (ADR 24). Run by CI in the `release` environment:
 *
 *   CASEFILE_UPDATE_SIGNING_KEY=… deno task release:manifest --version 0.3.0 --dir out \
 *     --patch 0.2.0=patch-0.2.0-to-0.3.0.bin --patch 0.1.0=patch-0.1.0-to-0.3.0.bin
 *
 * Each patch file is read from `--dir` and hashed. The signing key's public half must be the one
 * built into the app (src/app/update_config.ts), or the app would refuse every update: checked
 * here so a wrong secret fails the release instead.
 */
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { UPDATE_PUBLIC_KEY } from "../../src/app/update_config.ts";
import {
  type Manifest,
  parseVersion,
  publicKeyOf,
  sha256Hex,
  signManifest,
  verifyEnvelope,
} from "./signing.ts";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  Deno.exit(1);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["version", "dir", "patch"],
    collect: ["patch"],
  });
  const version = args.version ?? fail("--version is required");
  if (!parseVersion(version)) fail(`Not a version: ${version}`);
  const dir = args.dir ?? fail("--dir is required");
  const key = Deno.env.get("CASEFILE_UPDATE_SIGNING_KEY") ??
    fail("No signing key in the environment");
  if (!UPDATE_PUBLIC_KEY) fail("src/app/update_config.ts has no UPDATE_PUBLIC_KEY");
  if (await publicKeyOf(key) !== UPDATE_PUBLIC_KEY) {
    fail("The signing key does not match UPDATE_PUBLIC_KEY in src/app/update_config.ts");
  }

  const manifest: Manifest = { version, patches: {} };
  for (const p of (args.patch as string[] | undefined) ?? []) {
    const [from, name] = p.split("=");
    if (!parseVersion(from) || !name || name.includes("/")) fail(`Bad --patch ${p}`);
    manifest.patches[from] = {
      name,
      sha256: await sha256Hex(await Deno.readFile(join(dir, name))),
    };
  }
  const env = await signManifest(manifest, key);
  if (!(await verifyEnvelope(env, UPDATE_PUBLIC_KEY))) fail("The signature does not verify");
  await Deno.writeTextFile(join(dir, "latest.json"), JSON.stringify(env) + "\n");
  console.log(
    `latest.json: ${version}, patches from ${Object.keys(manifest.patches).join(", ") || "none"}`,
  );
}
