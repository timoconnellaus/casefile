/**
 * Acknowledging a recorded log problem (ADR 28): the problem is kept and still reported, the
 * acknowledgement is kept in the vault and logged in the hash chain, the Court summary marks it
 * "acknowledged by you on <date>", and a problem found later warns in full again.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { CaseSession } from "../src/core/session.ts";
import { courtSummary, formatDate, logEntries, sealedLog } from "../src/core/summary.ts";
import { PASS, withCase } from "./helpers/app.ts";

/** Cut the last two entries from the log, as Claude could with SQL, then let the app write. */
function cutTail(s: CaseSession) {
  for (let i = 0; i < 3; i++) s.log("user", "something", { i });
  const last = s.store.listLog(1)[0].id;
  s.store.db.prepare("DELETE FROM ai_log WHERE id >= ?").run(last - 1);
  s.log("user", "next entry");
}

async function caseWithProblem() {
  const t = await withCase();
  const s = t.state.session!;
  cutTail(s);
  const check = await s.verifyLog();
  assertEquals(check.intact, false);
  assertEquals(check.recorded?.length, 1);
  assertEquals(check.recorded![0].kind, "tail_changed");
  return { ...t, s };
}

Deno.test("acknowledging a log problem keeps it recorded and the log still not intact", async () => {
  const { user, s, state, caseDir } = await caseWithProblem();
  const r = await user.post("/api/log/problems/1/acknowledge");
  assertEquals(r.status, 200, r.text);
  // deno-lint-ignore no-explicit-any
  const body = r.json as any;
  assertExists(body.problem.acknowledged?.at);
  assertEquals(body.check.intact, false);
  assertEquals(body.check.recorded.length, 1);
  assertEquals(body.check.recorded[0].acknowledged.at, body.problem.acknowledged.at);

  // Once only; no such problem; not a number.
  assertEquals((await user.post("/api/log/problems/1/acknowledge")).status, 409);
  assertEquals((await user.post("/api/log/problems/2/acknowledge")).status, 404);
  assertEquals((await user.post("/api/log/problems/0/acknowledge")).status, 404);
  assertEquals((await user.post("/api/log/problems/x/acknowledge")).status, 400);

  // Settings writes never drop it, and it survives reopening.
  await s.updateSettings({ shortcuts: false });
  await state.lock();
  const again = await CaseSession.open(caseDir, PASS);
  const check = await again.verifyLog();
  assertEquals(check.intact, false);
  assertEquals(check.recorded?.length, 1);
  assertEquals(check.recorded![0].acknowledged?.at, body.problem.acknowledged.at);
  await again.closeSettled();
});

Deno.test("an acknowledgement is written to the hash-chained log, and the chain still verifies", async () => {
  const { user, s } = await caseWithProblem();
  const found = (await s.verifyLog()).recorded![0];
  assertEquals((await user.post("/api/log/problems/1/acknowledge")).status, 200);

  const row = s.store.listLog(20).find((l) => l.action === "log_problem_acknowledged");
  assertExists(row);
  assertEquals(row.actor, "user");
  assertEquals(JSON.parse(row.detail), {
    problem: 1,
    kind: "tail_changed",
    found: found.at,
    after: found.headId,
  });
  // Sealed by the app, and nothing in the chain is broken or forged now.
  const check = await s.verifyLog();
  assertEquals(check.chainProblem, undefined);
  assertEquals(check.brokenAt, undefined);
  assertEquals(check.forged, []);
  assert((await sealedLog(s)).some((l) => l.id === row.id), "the acknowledgement is sealed");

  // The readable log labels it.
  const entries = await logEntries(s, { limit: 50 });
  const label = entries.rows.find((e) => e.action === "log_problem_acknowledged");
  assertEquals(label?.label, "You acknowledged a problem casefile found in the log");
  assertStringIncludes(label?.note ?? "", `Found on ${formatDate(found.at)}`);
});

Deno.test("the Court summary still lists an acknowledged problem, marked with the date", async () => {
  const { user, s } = await caseWithProblem();
  const found = (await s.verifyLog()).recorded![0];
  const before = await courtSummary(s);
  assertStringIncludes(before.text, "Log checked: casefile found a problem (entries after entry");

  const r = await user.post("/api/log/problems/1/acknowledge");
  // deno-lint-ignore no-explicit-any
  const ackAt = (r.json as any).problem.acknowledged.at;
  const sum = await courtSummary(s);
  assertEquals(sum.figures.log.intact, false);
  assertEquals(sum.figures.log.recorded, [{
    n: 1,
    kind: "tail_changed",
    at: found.at,
    what: `entries after entry ${found.headId} were deleted or altered`,
    acknowledgedAt: ackAt,
  }]);
  const record = sum.sections.find((x) => x.id === "record")!.lines;
  assertEquals(
    record[0],
    "Log checked: casefile found a problem earlier, listed below. Figures above that come from " +
      "the log may be affected.",
  );
  assertEquals(
    record[1],
    `Problem found on ${formatDate(found.at)}: entries after entry ${found.headId} were deleted ` +
      `or altered; acknowledged by you on ${formatDate(ackAt)}.`,
  );
});

Deno.test("a problem found after an acknowledgement warns in full again", async () => {
  const { user, s } = await caseWithProblem();
  assertEquals((await user.post("/api/log/problems/1/acknowledge")).status, 200);
  cutTail(s);

  const check = await s.verifyLog();
  assertEquals(check.recorded?.length, 2);
  assertExists(check.recorded![0].acknowledged);
  assertEquals(check.recorded![1].acknowledged, undefined);
  // The warning leads with the new, unacknowledged problem.
  assertStringIncludes(check.problem ?? "", `entries after entry ${check.recorded![1].headId}`);

  const sum = await courtSummary(s);
  const record = sum.sections.find((x) => x.id === "record")!.lines;
  assertStringIncludes(record[0], "Log checked: casefile found a problem (entries after entry");
  assertStringIncludes(record[1], "; acknowledged by you on");
  assert(!record[2].includes("acknowledged"), record[2]);

  // The new one can be acknowledged in turn; both stay listed.
  assertEquals((await user.post("/api/log/problems/2/acknowledge")).status, 200);
  const after = await courtSummary(s);
  assertEquals(after.figures.log.recorded.filter((p) => p.acknowledgedAt).length, 2);
  assertStringIncludes(after.text, "casefile found 2 problems earlier, listed below");
});
