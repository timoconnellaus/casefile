/**
 * Every screen agrees on a document's state, because each reads `CaseSession.docState` /
 * `listDocInfo` (B): /api/docs, /api/to-check, /api/start, the Court summary and People usage.
 * The case is an exposed document that was re-checked and is now withheld by its origin, which
 * People and /api/start used to get wrong (an open exposure record, or text-less summaries).
 * SYNTHETIC data only (ADR 11).
 */
import { assertEquals } from "@std/assert";
import { withCase } from "./helpers/app.ts";
import { seedCanonWork } from "./helpers/canon_work.ts";

type State = "needs_review" | "shared" | "withheld" | "exposed";

async function states(user: Awaited<ReturnType<typeof withCase>>["user"]) {
  const docs = (await user.get("/api/docs")).json as { id: string; state: State }[];
  const by = (st: State) => docs.filter((d) => d.state === st).length;
  const start = (await user.get("/api/start")).json.steps.find((x: { id: string }) =>
    x.id === "share"
  );
  const usage = (await user.get("/api/entities/mother/usage")).json.documents as {
    id: string;
    state: State;
  }[];
  return { docs, by, start, usage };
}

Deno.test("an exposed document re-checked into 'withheld' shows as withheld everywhere", async () => {
  const { user, state } = await withCase();
  const s = state.session!;
  await seedCanonWork(s);

  // Before: D006 is exposed (CANON: 7 shared here, 6 withheld, 1 exposed, 2 to review).
  let v = await states(user);
  assertEquals(v.docs.find((d) => d.id === "D006")!.state, "exposed");
  assertEquals(
    [v.start.shared, v.start.withheld, v.start.exposed, v.start.needsReview],
    [v.by("shared"), v.by("withheld"), v.by("exposed"), v.by("needs_review")],
  );
  assertEquals([v.by("shared"), v.by("withheld"), v.by("exposed"), v.by("needs_review")], [
    7,
    6,
    1,
    2,
  ]);
  // "Annie" was not known when D006 was shared, so People does not list it for mother yet.
  assertEquals(v.usage.some((d) => d.id === "D006"), false);
  assertEquals((await user.get("/api/to-check")).json.total, 14);

  // The user says D006 came from the other side and re-checks it: it is withheld by origin now,
  // and its exposure record stays open (it was never shared again).
  await s.setOrigin("D006", "other_side");
  await s.recheck("D006");
  assertEquals(s.docState(await s.getDoc("D006")), "withheld");

  v = await states(user);
  assertEquals(v.docs.find((d) => d.id === "D006")!.state, "withheld");
  // Re-checking replaced "Annie": People lists D006 for mother, as withheld (not "exposed",
  // although its exposure record stays open).
  assertEquals(v.usage.find((d) => d.id === "D006")!.state, "withheld");
  assertEquals(
    [v.start.shared, v.start.withheld, v.start.exposed, v.start.needsReview],
    [7, 7, 0, 2],
  );
  const queue = (await user.get("/api/to-check")).json;
  assertEquals(queue.total, 13);
  assertEquals(queue.groups.some((g: { what: string }) => g.what === "Exposed documents"), false);
  const sum = (await user.get("/api/court-summary")).json;
  assertEquals(sum.figures.keptFromClaude.total, 7);
  assertEquals(sum.figures.keptFromClaude.byOrigin.other_side, 2);
  s.close();
});
