/**
 * scripts/seed.ts builds CANON (docs/rebuild/CANON.md) through the real flows: run it in --small
 * mode, open the case the way the app does, and check the To-check queue and the figures behind
 * the Court summary. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_PASS, seedCase } from "../scripts/seed.ts";
import { tempDir } from "./fixtures/synthetic.ts";
import { setup } from "./helpers/app.ts";

Deno.test({
  name: "seed --small: To check is 14 with CANON's groups, and the figures match CANON",
  // The seed runs the app in-process; its idle timer and SQLite handles are closed by the lock.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await tempDir("casefile-seed-test-");
    const dir = join(root, "canon");
    await seedCase({ dir, small: true, quiet: true, kdfIterations: 1_000 });

    // Open it as a fresh app would, with the documented passphrase.
    const t = await setup();
    const open = await t.user.post("/api/case/open", { dir, passphrase: DEFAULT_PASS });
    assertEquals(open.status, 200, open.text);

    const q = await t.user.get("/api/to-check");
    assertEquals(q.status, 200, q.text);
    assertEquals(q.json.total, 14);
    assertEquals(q.json.groups, [
      { what: "Exposed documents", count: 1 },
      { what: "Documents to review", count: 2 },
      { what: "Chronology entries", count: 5 },
      { what: "Evidence links", count: 2 },
      { what: "Affidavit paragraphs", count: 3 },
      { what: "Issue descriptions", count: 1 },
    ]);
    const items = q.json.items;
    assertEquals(items[0].id, "D006");
    // The 29 March swap is Can't check, straight after the exposure.
    assertEquals(items[1].state, "cant_check");
    assert(items[1].detail.startsWith("29 March 2025"), items[1].detail);
    assertEquals(
      items.filter((i: { what: string }) => i.what === "Documents to review")
        .map((i: { id: string }) => i.id),
      ["D015", "D016"],
    );
    const paras = items.filter((i: { kind: string }) => i.kind === "paragraph");
    assertEquals(paras.map((i: { state: string }) => i.state).sort(), [
      "claude_needs_you",
      "claude_needs_you",
      "claude_rewritten",
    ]);

    const f = (await t.user.get("/api/court-summary")).json.figures;
    assertEquals([f.chronology.claude, f.chronology.checked, f.chronology.cantCheck], [17, 12, 1]);
    assertEquals([f.evidence.claude, f.evidence.checked], [11, 9]);
    assertEquals(f.paste.views, 3);
    assertEquals(f.paste.passagesAdded, 2);
    assertEquals(f.keptFromClaude.total, 6);
    assertEquals(f.keptFromClaude.byOrigin, {
      mine: 0,
      other_side: 1,
      court_or_subpoena: 3,
      under_order: 1,
      not_sure: 1,
    });
    assertEquals(f.exposures.map((e: { doc: string }) => e.doc), ["D006"]);
    assertEquals(f.exposures[0].claudeReads.map((r: { lines: string }) => r.lines), ["1-12"]);
    assert(f.claude.plan.confirmations.helpImproveOff.startsWith("2025-09-03T02:00"));
    assertEquals(f.log.intact, true);

    // Who's who: CANON's 41, colour slots, the safety flag and the hinted identifiers.
    const people = (await t.user.get("/api/people")).json;
    assertEquals(people.groups, { people: 18, places: 14, numbers: 9 });
    const by = new Map(people.entities.map((e: { role: string }) => [e.role, e]));
    // deno-lint-ignore no-explicit-any
    const mother = by.get("mother") as any;
    assertEquals([mother.colour, mother.safety], [0, true]);
    assert(mother.aliases.includes("Annie"));
    assert(mother.description, "relationship description");
    for (const role of ["medicare_1", "tfn_1", "abn_1", "file_number"]) assert(by.has(role), role);

    // D002 is the user's own statement (vault-side author), and the user is the mother.
    assertEquals((await t.user.get("/api/docs/D002")).json.author, "mother");
    // …sworn on 2 April 2025, so exports cite it as "my affidavit sworn …" (ADR 27).
    assertEquals((await t.user.get("/api/docs/D002")).json.affidavit, {
      oath: "sworn",
      date: "2025-04-02",
    });
    assertEquals((await t.user.get("/api/settings")).json.userRole, "mother");
    // D006 was exposed by the nickname "Annie"; D015 and D016 show it as a new match.
    const ex = (await t.user.get("/api/exposures")).json;
    assertEquals(ex[0].trigger, { role: "mother", kind: "alias", value: "Annie" });
    const docs = (await t.user.get("/api/docs")).json;
    for (const id of ["D015", "D016"]) {
      const d = docs.find((x: { id: string }) => x.id === id);
      assertEquals(d.newMatch.values, [{ role: "mother", kind: "alias", value: "Annie" }], id);
      assertEquals(d.newMatch.exposed, ["D006"], id);
    }

    // CANON's dates (QA G4): D006 shared 28 Sep, read 2 Oct, withdrawn 5 Oct 2025; the log runs
    // from 3 Sep 2025 and is sealed and intact; nothing is dated after "today" (7 Oct 2025).
    const day = (iso: string) => iso.slice(0, 10);
    assertEquals(day(ex[0].sharedAt), "2025-09-28");
    assertEquals(ex[0].claudeReads.map((r: { ts: string }) => day(r.ts)), ["2025-10-02"]);
    assertEquals(day(ex[0].withdrawnAt), "2025-10-05");
    const summary = (await t.user.get("/api/court-summary")).json;
    assert(summary.text.includes("since 3 September 2025"), "log checked since 3 Sep 2025");
    assertEquals(summary.figures.log.intact, true);
    for (const d of docs) {
      if (d.doc_date) assert(d.doc_date <= "2025-10-07", `${d.id} dated ${d.doc_date}`);
    }
    // The name finder is on and recorded as used, as CANON's tools line has it.
    assertEquals(summary.figures.nameFinder.onNow, true);
    assert(summary.figures.nameFinder.documents > 0);
    assert(summary.text.includes("casefile's name finder, which runs on this computer: used on"));
    // No link suggestions are left open in the seeded case.
    assertEquals((await t.user.get("/api/people/link-suggestions")).json.suggestions, []);
    // Claude's work from D006 (2 Oct, checked by the user on 3 Oct): the exposure banner lists it
    // under "When you share D006 again, these go back to To check" (PLAN.md known gap, closed).
    const d006 = (await t.user.get("/api/docs/D006")).json;
    assertEquals(
      d006.citedIn.map((c: { type: string; state: string }) => [c.type, c.state]),
      [["chronology", "checked"], ["evidence", "checked"]],
    );
    const recheck = await t.user.post("/api/docs/recheck", { docs: ["D006"] });
    assertEquals(recheck.status, 200, recheck.text);
    assertEquals(recheck.json.results.map((r: { state: string }) => r.state), ["shared"]);
    const back = (await t.user.get("/api/docs/D006")).json.citedIn;
    assertEquals(back.map((c: { state: string }) => c.state), ["changed", "changed"]);
    const after = (await t.user.get("/api/to-check")).json;
    // D006 leaves the queue; its two items come back as "Changed since you checked".
    assertEquals(after.total, 15);

    // The seed's clock is gone once it is done.
    assert(Math.abs(Date.now() - performance.timeOrigin - performance.now()) < 60_000);

    t.state.lock();
  },
});
