/**
 * The structural guarantee (ADR 0003): the Claude-facing CLI cannot reach original text or the
 * token key, because nothing it imports can. This test reads the CLI's real module graph.
 */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = new URL("../", import.meta.url);
const FORBIDDEN = [
  "src/core/vault.ts",
  "src/core/backupfile.ts", // the single-file backup carries the keyfile (ADR 29)
  "src/core/session.ts",
  "src/core/signing.ts",
  "src/core/entities.ts",
  "src/core/detect/",
  "src/core/judge/",
  "src/core/tokenise.ts",
  "src/core/drafting.ts",
  "src/core/pdf", // pdf.ts and its worker: the original files (ADR 23)
  "src/app/",
];

async function moduleGraph(entry: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", entry],
    cwd: fromFileUrl(ROOT),
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  const info = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    modules: { specifier: string }[];
  };
  return info.modules.map((m) => m.specifier);
}

Deno.test("the CLI's module graph excludes the vault, the session and the detectors", async () => {
  const mods = await moduleGraph("src/cli/main.ts");
  const local = mods.filter((m) => m.startsWith(ROOT.href)).map((m) => m.slice(ROOT.href.length));
  assert(local.includes("src/cli/commands.ts"));
  assert(local.includes("src/core/publicdb.ts"));
  for (const f of FORBIDDEN) {
    const hit = local.filter((m) => m.startsWith(f));
    assertEquals(hit, [], `CLI imports ${hit.join(", ")}`);
  }
});

Deno.test("the CLI has no network dependencies", async () => {
  const mods = await moduleGraph("src/cli/main.ts");
  const remote = mods.filter((m) => m.startsWith("npm:") || m.startsWith("http"));
  // Only the Deno standard library (jsr) is allowed.
  assertEquals(remote.filter((m) => !m.startsWith("https://jsr.io/@std/")), []);
});
