#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --deny-net
/**
 * casefile — the Claude-facing CLI.
 *
 * It reads and writes the case's public store only. It must never import the vault, the session
 * or anything that can see original text (ADR 0003; enforced by tests/boundary_test.ts).
 */
import { parseArgs } from "@std/cli/parse-args";
import { COLLECT_FLAGS, normaliseArgv, run, STRING_FLAGS } from "./commands.ts";

if (import.meta.main) {
  const args = parseArgs(normaliseArgv(Deno.args), {
    boolean: ["json", "help"],
    string: STRING_FLAGS,
    collect: [...COLLECT_FLAGS],
    alias: { h: "help" },
  });
  const stdin = async () =>
    new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer());
  const { code, out, err } = await run(args, {
    cwd: Deno.cwd(),
    env: Deno.env.toObject(),
    readStdin: stdin,
  });
  if (out) console.log(out);
  if (err) console.error(err);
  Deno.exit(code);
}
