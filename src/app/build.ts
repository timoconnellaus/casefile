/**
 * Which copy of casefile is running (ADR 22, ADR 24).
 *
 * A desktop build's version is `version` in deno.json as it was built (CI sets it from the
 * release tag), read from the copy embedded in this code: the version of the code that is
 * actually running (see `relaunchIfStale` in updates.ts).
 *
 * A development run (`deno task dev`) says so instead; anything else (`deno task app`, tests) has
 * no version.
 */
import denoJson from "../../deno.json" with { type: "json" };

export interface BuildInfo {
  /** The desktop build's version (`0.2.0`), or null when not a desktop build. */
  version: string | null;
  /** Started by `deno task dev` against the synthetic case only. */
  dev: boolean;
}

/** The version this code was built as. */
export const EMBEDDED_VERSION: string = denoJson.version;

/** `Deno.desktopVersion`: the bundle's Info.plist version, or null outside a desktop build. */
export function bundleVersion(): string | null {
  // deno-lint-ignore no-explicit-any
  const v = (Deno as any).desktopVersion;
  return typeof v === "string" && v ? v : null;
}

export function readBuildInfo(dev: boolean): BuildInfo {
  return { version: bundleVersion() ? EMBEDDED_VERSION : null, dev };
}
