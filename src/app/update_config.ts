/**
 * Where the desktop app gets its updates, and the key they must be signed with (ADR 24). Both are
 * filled in once, when the GitHub repository is set up (docs/RELEASING.md). While either is null
 * the app never checks for updates.
 */

/** `owner/repo` on GitHub; releases are fetched from its public release files. */
export const UPDATE_REPO: string | null = null;

/**
 * The Ed25519 public key (raw 32 bytes, base64) the update manifest is signed with. Made by
 * `deno task release:keygen`; its private half is only in the GitHub `release` environment.
 */
export const UPDATE_PUBLIC_KEY: string | null = null;

/** The folder `latest.json` and the patches are fetched from: the latest release's files. */
export function updateBaseUrl(repo: string): string {
  return `https://github.com/${repo}/releases/latest/download`;
}
