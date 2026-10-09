/**
 * Checking Claude's work against its sources through the API (W1-C, ADR 8 amendment): states,
 * CheckLists, the two-part check, Can't check, Changed since you checked, own-statement flag.
 * SYNTHETIC data only (ADR 11): the CANON case.
 */
import { assert, assertEquals } from "@std/assert";
import { setDocAuthor } from "../src/core/checking.ts";
import { CaseSession } from "../src/core/session.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { type Client, PASS, withCase } from "./helpers/app.ts";

const MARCH_14 =
  "{{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.";

async function canon() {
  const t = await withCase({ detectorFactory: () => [] });
  const s = t.state.session!;
  await seedCanon(s);
  const c14 = s.store.addChronology({
    event_date: "2025-03-14",
    description: MARCH_14,
    sources: [
      { doc_id: "D002", line_start: 9, line_end: 9 },
      { doc_id: "D001", line_start: 1, line_end: 2 },
    ],
  }, "claude");
  const c29 = s.store.addChronology({
    event_date: "2025-03-29",
    description: "{{child_1.first}} has a temperature.",
    sources: [{ doc_id: "D001", line_start: 7, line_end: 7 }],
  }, "claude");
  return { ...t, s, c14, c29 };
}

// deno-lint-ignore no-explicit-any
async function entry(user: Client, id: number, query = ""): Promise<any> {
  const r = await user.get(`/api/chronology${query}`);
  assertEquals(r.status, 200, r.text);
  // deno-lint-ignore no-explicit-any
  return r.json.find((e: any) => e.id === id);
}

async function check(user: Client, id: number, extra: Record<string, unknown> = {}) {
  const e = await entry(user, id);
  return await user.post(`/api/chronology/${id}/verify`, {
    version: e.version,
    quoteAccurate: true,
    fairReading: true,
    ...extra,
  });
}

Deno.test("CANON 14 March entry: To check, with the CheckList, sources and context", async () => {
  const { state, user, c14 } = await canon();
  try {
    const e = await entry(user, c14);
    assertEquals(e.state, "to_check");
    assertEquals(e.lapsed, null);
    assertEquals(e.removed_at, null);
    const msgs = e.checks.map((c: { level: string; message: string }) => [c.level, c.message]);
    for (
      const want of [
        ["ok", "14 March 2025 appears in D001:1–2 and D002:9."],
        ["ok", "Daniel appears in D001:1–2 and D002:9."],
        ["ok", "90 minutes appears in D002:9."],
        ["ok", "Kiama Downs Public School appears in D002:9."],
        ["danger", "Lachlan is not in D001:1–2, only in D002:9."],
      ]
    ) {
      assert(
        msgs.some((m: string[]) => m[0] === want[0] && m[1] === want[1]),
        JSON.stringify(msgs),
      );
    }
    // Quotes and ±2 lines of context come from the vault, re-identified.
    const [d001, d002] = e.sources; // in the store's order
    assertEquals(d002.docTitle, "Affidavit of Anna Thornbury");
    assertEquals(d002.withheld, false);
    assert(d002.quote[0].text.startsWith("4. On 14 March 2025 Daniel collected Mia and Lachlan"));
    assertEquals(d002.context.before.map((l: { line: number }) => l.line), [7, 8]);
    assertEquals(d002.context.after.map((l: { line: number }) => l.line), [10, 11]);
    assertEquals(d001.context.before, []);
    assertEquals(d001.context.after.map((l: { line: number }) => l.line), [3, 4]);
    assertEquals(e.ownStatementOnly, false);
    assertEquals(e.usedIn, []);
    assertEquals(e.issues, []);
  } finally {
    state.lock();
  }
});

Deno.test("CANON 29 March entry is Can't check, and marking it as checked is refused (409)", async () => {
  const { state, user, c29 } = await canon();
  try {
    const e = await entry(user, c29);
    assertEquals(e.state, "cant_check");
    const mia = e.checks.find((c: { kind: string; ok: boolean }) => c.kind === "entity" && !c.ok);
    assertEquals(mia.message, "May have mixed up Mia and Lachlan: D001:7 names Lachlan, not Mia.");
    const r = await check(user, c29);
    assertEquals(r.status, 409, r.text);
    assertEquals(r.json.cantCheck, true);
    assert(r.json.checks.some((c: { message: string }) => c.message.startsWith("May have mixed")));
    assertEquals((await entry(user, c29)).state, "cant_check");
  } finally {
    state.lock();
  }
});

Deno.test("checking needs the version and both ticks, and the ticks are logged", async () => {
  const { state, user, s, c14 } = await canon();
  try {
    const e = await entry(user, c14);
    for (
      const body of [
        { version: e.version },
        { version: e.version, quoteAccurate: true },
        { version: e.version, quoteAccurate: true, fairReading: "yes" },
        { quoteAccurate: true, fairReading: true },
      ]
    ) {
      const r = await user.post(`/api/chronology/${c14}/verify`, body);
      assertEquals(r.status, 400, JSON.stringify(body));
    }
    assertEquals((await entry(user, c14)).state, "to_check");
    const ok = await check(user, c14);
    assertEquals(ok.status, 200, ok.text);
    const after = await entry(user, c14);
    assertEquals([after.state, after.verified], ["checked", true]);
    const logged = s.store.listLog(50).find((r) => r.action === "verified");
    assert(logged);
    assertEquals(JSON.parse(logged.detail).flags, { quoteAccurate: true, fairReading: true });
  } finally {
    state.lock();
  }
});

Deno.test("re-publishing a cited document makes a checked entry 'Changed since you checked'", async () => {
  const { state, user, s, c14 } = await canon();
  try {
    assertEquals((await check(user, c14)).status, 200);
    // The vault's D001 is re-published with line 2 changed.
    const d = await s.getDoc("D001");
    d.tokenised = d.tokenised!.replace("Traffic.", "Roadworks.");
    await s.saveDoc(d);
    s.republish(d);
    const e = await entry(user, c14);
    assertEquals([e.state, e.verified, e.verified_at], ["changed", false, null]);
    assertEquals(e.lapsed.reason, "source_changed");
    assert(e.lapsed.checkedAt);
    // Checking it again clears the lapse.
    assertEquals((await check(user, c14)).status, 200);
    const again = await entry(user, c14);
    assertEquals([again.state, again.lapsed], ["checked", null]);
  } finally {
    state.lock();
  }
});

Deno.test("Claude editing a checked entry makes it 'changed' (edited), also found when reopening", async () => {
  const { state, user, s, c14, caseDir } = await canon();
  assertEquals((await check(user, c14)).status, 200);
  await s.settled();
  state.lock();
  // While the app is closed, Claude rewrites the description.
  const raw = await CaseSession.open(caseDir, PASS);
  raw.store.db.prepare("UPDATE chronology SET description = ? WHERE id = ?").run(
    "{{father.first}} collected the children late.",
    c14,
  );
  await raw.settled();
  raw.close();
  // Opening prunes the stale check and remembers it lapsed.
  const s2 = await CaseSession.open(caseDir, PASS);
  try {
    const row = s2.store.getChronology(c14);
    assertEquals(await s2.isChronologyVerified(row), false);
    const lapsed = await s2.ledger.lapsedCheck("chronology", c14);
    assertEquals(lapsed?.reason, "edited");
  } finally {
    s2.close();
  }
});

Deno.test("the user's own unverify or edit leaves 'To check', not 'changed'", async () => {
  const { state, user, c14 } = await canon();
  try {
    assertEquals((await check(user, c14)).status, 200);
    assertEquals((await user.post(`/api/chronology/${c14}/unverify`)).status, 200);
    assertEquals((await entry(user, c14)).state, "to_check");
    assertEquals((await check(user, c14)).status, 200);
    const p = await user.req("PATCH", `/api/chronology/${c14}`, { event_date: "2025-03-15" });
    assertEquals(p.status, 200, p.text);
    const e = await entry(user, c14);
    assertEquals([e.state, e.lapsed], ["to_check", null]);
  } finally {
    state.lock();
  }
});

Deno.test("own-statement flag: only the user's own affidavit cited", async () => {
  const { state, user, s } = await canon();
  try {
    await s.updateSettings({ userRole: "mother" });
    // Who wrote D002, as the user recorded it in the app (vault; not public.db's author_role).
    await setDocAuthor(s, "D002", "mother");
    const id = s.store.addChronology({
      event_date: "2025-03-14",
      description: "{{father.first}} was 90 minutes late.",
      sources: [{ doc_id: "D002", line_start: 9, line_end: 9 }],
    }, "claude");
    assertEquals((await entry(user, id)).ownStatementOnly, true);
  } finally {
    state.lock();
  }
});

Deno.test("issues: description check needs {version, neutral:true}; evidence has states too", async () => {
  const { state, user, s } = await canon();
  try {
    const issue = s.store.addIssue(
      { title: "Medical care", description: "Who decides." },
      "claude",
    );
    const ev = s.store.addEvidence(issue, {
      doc_id: "D001",
      line_start: 7,
      line_end: 7,
      note: "{{child_1.first}} was unwell",
    }, "claude");
    const list = (await user.get("/api/issues")).json;
    const i = list.find((x: { id: number }) => x.id === issue);
    assertEquals(i.descState, "to_check");
    assertEquals(i.evidence[0].state, "cant_check");
    assertEquals(i.evidence[0].sources[0].docTitle, "Text messages, March 2025");
    assertEquals(
      (await user.post(`/api/issues/${issue}/verify`, { version: i.version })).status,
      400,
    );
    assertEquals(
      (await user.post(`/api/issues/${issue}/verify`, { version: i.version, neutral: true }))
        .status,
      200,
    );
    assertEquals(
      (await user.post(`/api/evidence/${ev}/verify`, {
        version: i.evidence[0].version,
        quoteAccurate: true,
        fairReading: true,
      })).status,
      409,
    );
    const after = (await user.get("/api/issues")).json.find((x: { id: number }) => x.id === issue);
    assertEquals(after.descState, "checked");
  } finally {
    state.lock();
  }
});
