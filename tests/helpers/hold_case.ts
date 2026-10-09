/**
 * Run as a separate process by tests/caselock_test.ts: open a case and keep it open, like a
 * running casefile app. Reads commands on stdin, one per line, and answers each with a JSON line:
 *
 *   write  try to log and to write the vault; say which errors came back
 *   close  close the case (as locking does) and exit
 *
 * SYNTHETIC data only (ADR 11).
 */
import { CaseSession } from "../../src/core/session.ts";

const [dir, pass] = Deno.args;
const say = (v: unknown) => console.log(JSON.stringify(v));
let s: CaseSession;
try {
  s = await CaseSession.open(dir, pass);
} catch (e) {
  say({ error: e instanceof Error ? e.name : String(e) });
  Deno.exit(1);
}
say({ open: true, pid: Deno.pid });

const name = (e: unknown) => (e instanceof Error ? e.name : String(e));
let buf = "";
const dec = new TextDecoder();
for await (const chunk of Deno.stdin.readable) {
  buf += dec.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const cmd = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (cmd === "write") {
      const out = { replaced: s.folderReplaced(), log: "ok", vault: "ok" };
      try {
        s.log("user", "case_locked");
      } catch (e) {
        out.log = name(e);
      }
      try {
        await s.vault.writeJson("lapsed-checks", {});
      } catch (e) {
        out.vault = name(e);
      }
      say(out);
    } else if (cmd === "close") {
      await s.closeSettled();
      say({ closed: true });
      Deno.exit(0);
    }
  }
}
