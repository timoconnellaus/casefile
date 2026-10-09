/**
 * The AI-use log is hash-chained by the app (security review, finding 6; ADR 8). Each test plays
 * Claude editing public.db's ai_log with SQL.
 */
import { assert, assertEquals } from "@std/assert";
import { CaseSession } from "../src/core/session.ts";
import { PublicStore } from "../src/core/publicdb.ts";
import { PASS, publishedCase } from "./fixtures/case.ts";

function sql(s: CaseSession, query: string, ...args: (string | number | null)[]) {
  s.store.db.prepare(query).run(...args);
}

/** A case with app entries, then CLI entries written while the app is closed, then reopened. */
async function chainedCase() {
  const { s, dir } = await publishedCase();
  s.close();
  const cli = PublicStore.open(`${dir}/public.db`);
  cli.log("claude", "cli:info");
  cli.log("claude", "cli:search", { query: "late" });
  cli.close();
  return { dir, s: await CaseSession.open(dir, PASS) };
}

Deno.test("an untouched log verifies, with CLI entries countersigned on open", async () => {
  const { s } = await chainedCase();
  const check = await s.verifyLog();
  assertEquals(check.intact, true, check.problem);
  assertEquals(check.pending, 0);
  const cliRows = s.store.listLog(100).filter((l) => l.action.startsWith("cli:"));
  assert(cliRows.every((r) => r.chain_kind === "countersigned"));
  // A CLI entry written while the app is open is pending until the app's next write.
  PublicStore.open(`${s.paths.root}/public.db`).log("claude", "cli:info");
  assertEquals((await s.verifyLog()).pending, 1);
  s.log("user", "something");
  const after = await s.verifyLog();
  assertEquals([after.intact, after.pending], [true, 0]);
  s.close();
});

Deno.test("altering, inserting or deleting log entries is detected", async () => {
  // Altered.
  let { s } = await chainedCase();
  const rows = s.store.listLog(100).reverse();
  const target = rows[3];
  sql(s, "UPDATE ai_log SET action = 'tampered' WHERE id = ?", target.id);
  let check = await s.verifyLog();
  assertEquals([check.intact, check.brokenAt], [false, target.id]);
  s.close();

  // A middle entry deleted.
  ({ s } = await chainedCase());
  const mid = s.store.listLog(100).reverse()[2];
  sql(s, "DELETE FROM ai_log WHERE id = ?", mid.id);
  check = await s.verifyLog();
  assertEquals(check.intact, false);
  s.close();

  // Entries deleted from the end (the vault remembers the last one).
  ({ s } = await chainedCase());
  const last = s.store.listLog(1)[0];
  sql(s, "DELETE FROM ai_log WHERE id >= ?", last.id - 1);
  check = await s.verifyLog();
  assertEquals(check.intact, false);
  s.close();
});

Deno.test("an entry Claude adds claiming to be the user's is flagged, even after countersigning", async () => {
  const { s, dir } = await chainedCase();
  sql(
    s,
    "INSERT INTO ai_log(ts, actor, action, detail) VALUES ('2025-01-01T00:00:00.000Z', 'user', 'verified', '{}')",
  );
  s.close();
  const s2 = await CaseSession.open(dir, PASS); // countersigns it
  const check = await s2.verifyLog();
  assertEquals(check.intact, false);
  assertEquals(check.forged.length, 1);
  s2.close();
});

Deno.test("an unchained entry slipped in before chained ones is detected", async () => {
  const { s } = await chainedCase();
  const first = s.store.listLog(1000).at(-1)!;
  sql(s, "UPDATE ai_log SET chain = NULL WHERE id = ?", first.id);
  assertEquals((await s.verifyLog()).intact, false);
  s.close();
});

Deno.test("an emptied log is not reported intact", async () => {
  const { s } = await chainedCase();
  sql(s, "DELETE FROM ai_log");
  assertEquals((await s.verifyLog()).intact, false);
  s.close();
});
