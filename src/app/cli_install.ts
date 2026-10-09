/**
 * The desktop app carries the `casefile` CLI built from the same commit (`--include bin/casefile`)
 * and installs it to `~/.local/bin` the first time each version starts, so Claude Code in the case
 * folder always runs a CLI that matches the app's public.db (ADR 23).
 */
import { join } from "@std/path";

const BUNDLED_CLI = new URL("../../bin/casefile", import.meta.url);

export interface CliInstall {
  installed: boolean;
  path: string;
  reason?: string;
}

export async function installBundledCli(
  version: string,
  opts: { home: string; configDir: string; source?: URL },
): Promise<CliInstall> {
  const binDir = join(opts.home, ".local", "bin");
  const target = join(binDir, "casefile");
  const marker = join(opts.configDir, "cli-version");
  const done = await Deno.readTextFile(marker).then((t) => t.trim()).catch(() => null);
  if (done === version) return { installed: false, path: target, reason: "already installed" };
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(opts.source ?? BUNDLED_CLI);
  } catch {
    return { installed: false, path: target, reason: "this build carries no CLI" };
  }
  await Deno.mkdir(binDir, { recursive: true });
  // Written beside it and renamed over it: a Claude Code session running the old CLI keeps it.
  await Deno.writeFile(`${target}.new`, bytes, { mode: 0o755 });
  await Deno.chmod(`${target}.new`, 0o755);
  await Deno.rename(`${target}.new`, target);
  await Deno.mkdir(opts.configDir, { recursive: true });
  await Deno.writeTextFile(marker, version + "\n");
  return { installed: true, path: target };
}
