#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Make the update signing key, once, when the GitHub repository is set up (docs/RELEASING.md):
 *
 *   deno task release:keygen | gh secret set CASEFILE_UPDATE_SIGNING_KEY --env release
 *
 * The public key is written into src/app/update_config.ts (commit it). The private key goes to
 * stdout only, straight into the GitHub secret: never into a file or the terminal. Making a new
 * key later means every installed app refuses updates until it is reinstalled.
 */
import { fromFileUrl } from "@std/path";
import { generateKeys } from "./signing.ts";

const CONFIG = fromFileUrl(new URL("../../src/app/update_config.ts", import.meta.url));

if (import.meta.main) {
  if (Deno.stdout.isTerminal()) {
    console.error("Pipe this into `gh secret set` rather than printing the private key here.");
    Deno.exit(1);
  }
  const text = await Deno.readTextFile(CONFIG);
  const line = "export const UPDATE_PUBLIC_KEY: string | null = null;";
  if (!text.includes(line)) {
    console.error(
      "UPDATE_PUBLIC_KEY is already set in src/app/update_config.ts. Not replacing it.",
    );
    Deno.exit(1);
  }
  const { publicKey, privateKey } = await generateKeys();
  await Deno.writeTextFile(
    CONFIG,
    text.replace(line, `export const UPDATE_PUBLIC_KEY: string | null = "${publicKey}";`),
  );
  console.error(`Public key written to src/app/update_config.ts: ${publicKey}`);
  await Deno.stdout.write(new TextEncoder().encode(privateKey));
}
