/**
 * `deno task app` restarting into an update without locking the case (ADR 22, amendment): the
 * real supervisor and app processes over HTTP. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { lines } from "../src/app/control.ts";
import { CASE_LOCK_FILE } from "../src/core/caselock.ts";
import { tempDir } from "./fixtures/synthetic.ts";
import { PASS } from "./helpers/app.ts";

const SUPERVISOR = fromFileUrl(new URL("../src/app/supervisor.ts", import.meta.url));

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

Deno.test({
  name: "a restart for an update keeps the case open and the browser signed in",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await tempDir();
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        "--allow-sys",
        "--allow-run",
        SUPERVISOR,
      ],
      env: { CASEFILE_CONFIG_DIR: join(root, "config"), CASEFILE_PORT: String(port) },
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const out = lines(child.stdout);
    const waitFor = async (text: string) => {
      // Not for-await: leaving that loop would close the stream for the next wait.
      for (let r = await out.next(); !r.done; r = await out.next()) {
        if (r.value.includes(text)) return;
      }
      throw new Error(`the supervisor ended before "${text}"`);
    };
    try {
      await waitFor("casefile is running");
      const caseDir = join(root, "case");
      const created = await fetch(`${base}/api/case/create`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ dir: caseDir, passphrase: PASS, label: "Test matter" }),
      });
      assertEquals(created.status, 200, await created.text());
      const cookie = created.headers.get("set-cookie")!.split(";")[0];
      const status = async () =>
        await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
      assert((await status()).signedIn);
      const info = JSON.parse(await Deno.readTextFile(join(root, "config", "app.json")));
      assertEquals(info.pid, child.pid);

      Deno.kill(child.pid, "SIGHUP");
      await waitFor("casefile restarted");
      const after = await status();
      assert(after.unlocked, "the case is open again");
      assert(after.signedIn, "the same cookie still signs in");

      // Ctrl-C: the app locks the case and the supervisor stops, removing app.json.
      Deno.kill(child.pid, "SIGINT");
      assertEquals((await child.status).success, true);
      for (const f of [join(caseDir, CASE_LOCK_FILE), join(root, "config", "app.json")]) {
        assert(!(await Deno.lstat(f).catch(() => null)), `${f} is gone`);
      }
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already stopped */ }
      await child.stdout.cancel().catch(() => {});
    }
  },
});
