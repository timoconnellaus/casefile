/**
 * Tampering with the AI-use log must stay reported after casefile writes to the log again
 * (ADR 8, amended): the app never re-seals over a tail that no longer matches the vault's record,
 * a lost head is never treated more leniently than a mismatched one, and the record of a problem
 * survives every settings write. Each test plays someone editing public.db (as Claude can) or the
 * case folder's vault files. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { CaseSession } from "../src/core/session.ts";
import { PublicStore } from "../src/core/publicdb.ts";
import { courtSummary } from "../src/core/summary.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const PASS = "a long test passphrase";
const OPTS = { kdfIterations: 1_000 };

/** A closed case whose log has app entries and countersigned Claude entries. */
async function closedCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", OPTS);
  for (let i = 0; i < 4; i++) s.log("user", "something", { i });
  await s.closeSettled();
  const cli = PublicStore.open(join(dir, "public.db"));
  for (let i = 0; i < 3; i++) cli.log("claude", "cli:info", { i });
  cli.close();
  const s2 = await CaseSession.open(dir, PASS); // countersigns Claude's entries
  await s2.closeSettled();
  return dir;
}

/** Edit public.db as Claude can (it has no vault key). */
function claudeSql(dir: string, query: string, ...args: (string | number | null)[]) {
  const db = PublicStore.open(join(dir, "public.db"));
  db.db.prepare(query).run(...args);
  db.close();
}

function lastId(dir: string): number {
  const db = PublicStore.open(join(dir, "public.db"));
  const id = db.listLog(1)[0].id;
  db.close();
  return id;
}

async function reportedAfterWrites(dir: string, label: string) {
  const s = await CaseSession.open(dir, PASS);
  let check = await s.verifyLog();
  assertEquals(check.intact, false, `${label}: not reported on open`);
  s.log("user", "later entry");
  check = await s.verifyLog();
  assertEquals(check.intact, false, `${label}: hidden by the next write`);
  await s.closeSettled();
  const again = await CaseSession.open(dir, PASS);
  check = await again.verifyLog();
  assertEquals(check.intact, false, `${label}: hidden after reopening`);
  await again.closeSettled();
  return check;
}

Deno.test("entries cut from the end while the app is closed stay reported after it writes again", async () => {
  const dir = await closedCase();
  claudeSql(dir, "DELETE FROM ai_log WHERE id >= ?", lastId(dir) - 2);
  const check = await reportedAfterWrites(dir, "truncated");
  assertStringIncludes(check.problem ?? "", "deleted or altered");
});

Deno.test("entries cut from the end while the app is open stay reported after its next write", async () => {
  const dir = await closedCase();
  const s = await CaseSession.open(dir, PASS);
  claudeSql(dir, "DELETE FROM ai_log WHERE id >= ?", lastId(dir) - 2);
  s.log("user", "next entry");
  assertEquals((await s.verifyLog()).intact, false);
  await s.closeSettled();
  await reportedAfterWrites(dir, "truncated while open");
});

Deno.test("sealed entries made unsealed and rewritten are not sealed again as if untouched", async () => {
  const dir = await closedCase();
  // Claude's own (countersigned) entries at the end: clear their seals and change them.
  claudeSql(
    dir,
    "UPDATE ai_log SET chain = NULL, chain_kind = NULL, detail = '{\"i\":99}' WHERE actor = 'claude'",
  );
  await reportedAfterWrites(dir, "unsealed tail");
});

Deno.test("a deleted log head and settings file do not make a cut log look pre-chaining", async () => {
  const dir = await closedCase();
  claudeSql(dir, "DELETE FROM ai_log WHERE id >= ?", lastId(dir) - 2);
  await Deno.remove(join(dir, "vault", "log-head.enc"));
  await Deno.remove(join(dir, "vault", "settings.enc"));
  await reportedAfterWrites(dir, "head and settings deleted");
});

Deno.test("the record of a lost head survives every settings write", async () => {
  const dir = await closedCase();
  await Deno.remove(join(dir, "vault", "log-head.enc"));
  const s = await CaseSession.open(dir, PASS);
  assertEquals((await s.verifyLog()).headLost?.reason, "missing");
  // Normal settings writes, and a settings object replaced wholesale, keep the record.
  await s.updateSettings({ label: "Renamed", idleLockMinutes: 15 });
  // deno-lint-ignore no-explicit-any
  await s.updateSettings({ logHeadLost: undefined, logProblems: [] } as any);
  s.settings = { ...s.settings };
  // deno-lint-ignore no-explicit-any
  delete (s.settings as any).logHeadLost;
  // deno-lint-ignore no-explicit-any
  delete (s.settings as any).logProblems;
  await s.saveSettings();
  assertEquals((await s.verifyLog()).intact, false);
  await s.closeSettled();
  const again = await CaseSession.open(dir, PASS);
  const check = await again.verifyLog();
  assertEquals([check.intact, check.headLost?.reason], [false, "missing"]);
  await again.closeSettled();
});

Deno.test("a vault head that is merely behind (the app stopped before writing it) is not a problem", async () => {
  const dir = await closedCase();
  const head = join(dir, "vault", "log-head.enc");
  const old = await Deno.readFile(head);
  const s = await CaseSession.open(dir, PASS);
  for (let i = 0; i < 3; i++) s.log("user", "more", { i });
  await s.closeSettled();
  await Deno.writeFile(head, old); // as if the last head writes never reached the disk
  const again = await CaseSession.open(dir, PASS);
  const check = await again.verifyLog();
  assertEquals(check.intact, true, check.problem);
  await again.closeSettled();
});

Deno.test("the Court summary reports a lost log head as not intact", async () => {
  const dir = await closedCase();
  await Deno.remove(join(dir, "vault", "log-head.enc"));
  const s = await CaseSession.open(dir, PASS);
  const sum = await courtSummary(s);
  assertEquals(sum.figures.log.intact, false);
  assert(sum.figures.log.problem?.includes("last entry"), sum.figures.log.problem ?? "");
  assert(sum.text.includes("Log checked: casefile found a problem"), sum.text);
  await s.closeSettled();
});
