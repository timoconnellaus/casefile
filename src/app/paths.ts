import { join } from "@std/path";

/**
 * The app's config folder: `CASEFILE_CONFIG_DIR`, or the platform default. The defaults are the
 * ones the generated Claude Code settings block (`APP_DIRS` in core/case.ts), so what is kept
 * there, upgrade backups included (ADR 22), is out of Claude's reach.
 */
export function configDir(): string {
  return Deno.env.get("CASEFILE_CONFIG_DIR") ?? defaultConfigDir();
}

export function defaultConfigDir(): string {
  const home = Deno.env.get("HOME") ?? ".";
  return Deno.build.os === "darwin"
    ? join(home, "Library", "Application Support", "casefile")
    : join(home, ".config", "casefile");
}
