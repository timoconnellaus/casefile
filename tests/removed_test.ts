/**
 * Removed items and notes dealt with (W1-C, ADR 8 amendment): the user's marks live in the
 * vault's ledger; public.db's removed_at / done_at are Claude-writable and never decide what the
 * user sees. Disagreements are reported as security events and repaired. Also the verify gates'
 * parity across chronology, evidence and issues, and across the API and the session.
 * SYNTHETIC data only (ADR 11): the CANON case.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { CantCheckError } from "../src/core/claimcheck.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { type Client, withCase } from "./helpers/app.ts";

async function canon() {
  const t = await withCase({ detectorFactory: () => [] });
  const s = t.state.session!;
  await seedCanon(s);
  const chrono = s.store.addChronology({
    event_date: "2025-03-14",
    description: "{{father.first}} was 90 minutes late.",
    sources: [{ doc_id: "D002", line_start: 9, line_end: 9 }],
  }, "claude");
  const issue = s.store.addIssue({ title: "Reliability of changeovers" }, "claude");
  const ev = s.store.addEvidence(issue, {
    doc_id: "D001",
    line_start: 2,
    line_end: 2,
    note: "{{father.first}} was late",
  }, "claude");
  const note = s.store.addNote("issue", String(issue), "Ask about the swimming change.", "claude");
  const sql = (q: string, ...a: (string | number)[]) => s.store.db.prepare(q).run(...a);
  return { ...t, s, chrono, issue, ev, note, sql };
}

async function ids(user: Client, path: string): Promise<number[]> {
  const r = await user.get(path);
  assertEquals(r.status, 200, r.text);
  return r.json.map((x: { id: number }) => x.id);
}

async function events(user: Client) {
  const r = await user.get("/api/security-log");
  assertEquals(r.status, 200, r.text);
  return r.json as { event: string; target: string; problem?: string }[];
}

Deno.test("a removed_at Claude writes hides nothing from the user, and is reported and undone", async () => {
  const { state, user, s, chrono, issue, ev, sql } = await canon();
  try {
    sql("UPDATE chronology SET removed_at = 't', removed_by = 'user' WHERE id = ?", chrono);
    sql("UPDATE issues SET removed_at = 't', removed_by = 'user' WHERE id = ?", issue);
    sql("UPDATE evidence SET removed_at = 't', removed_by = 'user' WHERE id = ?", ev);
    assertEquals(await ids(user, "/api/chronology"), [chrono]);
    assertEquals(await ids(user, "/api/chronology?removed=1"), []);
    const issues = (await user.get("/api/issues")).json;
    assertEquals([issues[0].id, issues[0].evidence[0].id], [issue, ev]);
    assertEquals(issues[0].removed_at, null);
    assertEquals(await ids(user, "/api/issues?removed=1"), []);
    assertEquals(await ids(user, "/api/evidence?removed=1"), []);
    const ev1 = (await events(user)).filter((e) => e.event === "removal_mismatch");
    assertEquals(
      ev1.map((e) => [e.target, e.problem]).sort(),
      [
        [`chronology:${chrono}`, "not_by_you"],
        [`evidence:${ev}`, "not_by_you"],
        [`issue:${issue}`, "not_by_you"],
      ],
    );
    // public.db is put back, so Claude sees them again too; nothing is reported twice.
    assertEquals(s.store.getChronology(chrono).removed_at, null);
    await user.get("/api/chronology");
    assertEquals((await events(user)).filter((e) => e.event === "removal_mismatch").length, 3);
    // It is not in Removed items, so it cannot be "restored".
    assertEquals((await user.post(`/api/chronology/${chrono}/restore`)).status, 400);
  } finally {
    state.lock();
  }
});

Deno.test("the user's removal holds when Claude clears removed_at, and restore brings it back checked", async () => {
  const { state, user, s, chrono, sql } = await canon();
  try {
    const e = (await user.get("/api/chronology")).json[0];
    const v = await user.post(`/api/chronology/${chrono}/verify`, {
      version: e.version,
      quoteAccurate: true,
      fairReading: true,
    });
    assertEquals(v.status, 200, v.text);
    const rm = await user.post(`/api/chronology/${chrono}/remove`);
    assertEquals(rm.status, 200, rm.text);
    assertEquals(rm.json.usedIn, []);
    assert(s.store.getChronology(chrono).removed_at, "public.db hides it from Claude's lists");
    assertEquals(await ids(user, "/api/chronology"), []);
    const removed = (await user.get("/api/chronology?removed=1")).json;
    assertEquals([removed[0].id, removed[0].state], [chrono, "checked"]);
    assert(removed[0].removed_at);

    // Claude "restores" it with SQL: the user's view does not change; it is reported and redone.
    sql("UPDATE chronology SET removed_at = NULL, removed_by = NULL WHERE id = ?", chrono);
    assertEquals(await ids(user, "/api/chronology"), []);
    assertEquals(await ids(user, "/api/chronology?removed=1"), [chrono]);
    assert(
      (await events(user)).some((x) =>
        x.event === "removal_mismatch" && x.problem === "undone_outside_app"
      ),
    );
    assert(s.store.getChronology(chrono).removed_at, "re-applied");

    // Restore: back in the list, still checked.
    assertEquals((await user.post(`/api/chronology/${chrono}/restore`)).status, 200);
    const back = (await user.get("/api/chronology")).json;
    assertEquals([back[0].id, back[0].state, back[0].removed_at], [chrono, "checked", null]);
    assertEquals(s.store.getChronology(chrono).removed_at, null);
  } finally {
    state.lock();
  }
});

Deno.test("a removed item restored after its source changed comes back 'changed', not checked", async () => {
  const { state, user, s, chrono } = await canon();
  try {
    const e = (await user.get("/api/chronology")).json[0];
    await user.post(`/api/chronology/${chrono}/verify`, {
      version: e.version,
      quoteAccurate: true,
      fairReading: true,
    });
    assertEquals((await user.post(`/api/chronology/${chrono}/remove`)).status, 200);
    const d = await s.getDoc("D002");
    d.tokenised = d.tokenised!.replace("90 minutes", "ninety minutes");
    await s.saveDoc(d);
    s.republish(d);
    assertEquals((await user.post(`/api/chronology/${chrono}/restore`)).status, 200);
    const back = (await user.get("/api/chronology")).json[0];
    assertEquals([back.state, back.verified, back.lapsed.reason], [
      "changed",
      false,
      "source_changed",
    ]);
  } finally {
    state.lock();
  }
});

Deno.test("Claude editing an item the user removed shows it again and is reported", async () => {
  const { state, user, issue, sql } = await canon();
  try {
    assertEquals((await user.post(`/api/issues/${issue}/remove`)).status, 200);
    assertEquals(await ids(user, "/api/issues"), []);
    assertEquals(await ids(user, "/api/issues?removed=1"), [issue]);
    sql("UPDATE issues SET title = 'Something else' WHERE id = ?", issue);
    assertEquals(await ids(user, "/api/issues"), [issue]);
    assert(
      (await events(user)).some((x) =>
        x.event === "removal_mismatch" && x.problem === "changed" && x.target === `issue:${issue}`
      ),
    );
  } finally {
    state.lock();
  }
});

Deno.test("evidence remove and restore; restore of an item not removed is refused", async () => {
  const { state, user, ev, issue } = await canon();
  try {
    assertEquals((await user.post(`/api/evidence/${ev}/restore`)).status, 400);
    assertEquals((await user.post(`/api/evidence/${ev}/remove`)).status, 200);
    assertEquals((await user.get("/api/issues")).json[0].evidence, []);
    const removed = (await user.get("/api/evidence?removed=1")).json;
    assertEquals([removed[0].id, removed[0].issue_id, removed[0].issueTitle], [
      ev,
      issue,
      "Reliability of changeovers",
    ]);
    assertEquals((await user.post(`/api/evidence/${ev}/restore`)).status, 200);
    assertEquals((await user.get("/api/issues")).json[0].evidence[0].id, ev);
  } finally {
    state.lock();
  }
});

Deno.test("notes: only the user marks a note dealt with; Claude's done_at is reported and undone", async () => {
  const { state, user, s, note, sql } = await canon();
  try {
    const done = async () =>
      (await user.get("/api/notes")).json.find((n: { id: number }) => n.id === note);
    sql("UPDATE notes SET done_at = 't', done_by = 'user' WHERE id = ?", note);
    assertEquals([(await done()).done, (await done()).done_at], [false, null]);
    assert(
      (await events(user)).some((x) =>
        x.event === "done_mismatch" && x.problem === "not_by_you" && x.target === `note:${note}`
      ),
    );
    assertEquals(s.store.getNote(note).done_at, null);

    for (const bad of ["true", 1, "false", null]) {
      assertEquals((await user.post(`/api/notes/${note}/done`, { done: bad })).status, 400);
    }
    assertEquals((await done()).done, false);
    assertEquals((await user.post(`/api/notes/${note}/done`, {})).json, { ok: true, done: true });
    assertEquals((await done()).done, true);
    // The issue view shows it too.
    assertEquals((await user.get("/api/issues")).json[0].notes[0].done, true);

    // Claude clears it: still done for the user, reported, re-applied.
    sql("UPDATE notes SET done_at = NULL, done_by = NULL WHERE id = ?", note);
    assertEquals((await done()).done, true);
    assert(s.store.getNote(note).done_at);
    // Claude changes the note after it was dealt with: no longer done.
    sql("UPDATE notes SET body = 'Something new' WHERE id = ?", note);
    assertEquals((await done()).done, false);
    assertEquals((await user.post(`/api/notes/${note}/done`, { done: false })).status, 200);
  } finally {
    state.lock();
  }
});

// ── verify gate parity ──────────────────────────────────────────────────────

Deno.test("every verify endpoint takes only literal true ticks", async () => {
  const { state, user, chrono, issue, ev } = await canon();
  try {
    const c = (await user.get("/api/chronology")).json[0];
    const i = (await user.get("/api/issues")).json[0];
    const e = i.evidence[0];
    const cases: [string, string, string[]][] = [
      [`/api/chronology/${chrono}/verify`, c.version, ["quoteAccurate", "fairReading"]],
      [`/api/evidence/${ev}/verify`, e.version, ["quoteAccurate", "fairReading"]],
      [`/api/issues/${issue}/verify`, i.version, ["neutral"]],
    ];
    for (const [path, version, flags] of cases) {
      for (const bad of ["true", 1, "yes", {}, null]) {
        for (const f of flags) {
          const body: Record<string, unknown> = { version };
          for (const g of flags) body[g] = g === f ? bad : true;
          const r = await user.post(path, body);
          assertEquals(r.status, 400, `${path} ${f}=${JSON.stringify(bad)}`);
        }
      }
      const ok: Record<string, unknown> = { version };
      for (const g of flags) ok[g] = true;
      assertEquals((await user.post(path, ok)).status, 200, path);
    }
  } finally {
    state.lock();
  }
});

Deno.test("Can't check is refused on every path, not only the API", async () => {
  const { state, s } = await canon();
  try {
    // A chronology entry naming Mia where D001:7 names Lachlan.
    const c = s.store.addChronology({
      event_date: "2025-03-29",
      description: "{{child_1.first}} has a temperature.",
      sources: [{ doc_id: "D001", line_start: 7, line_end: 7 }],
    }, "claude");
    await assertRejects(() => s.verifyChronology(c), CantCheckError);
    // Evidence whose note names someone not in its line.
    const i = s.store.addIssue({ title: "Medical care" }, "claude");
    const e = s.store.addEvidence(i, {
      doc_id: "D001",
      line_start: 7,
      line_end: 7,
      note: "{{child_1.first}} was unwell",
    }, "claude");
    await assertRejects(() => s.verifyEvidence(e), CantCheckError);
    // An issue with a label casefile doesn't know.
    const i2 = s.store.addIssue({ title: "About {{ghost}}" }, "claude");
    await assertRejects(() => s.verifyIssue(i2), CantCheckError);
    // Lines partly past the end of the document can't be quoted in full.
    const partial = s.store.db.prepare(
      "INSERT INTO chronology(event_date, description, created_by, created_at, updated_at) VALUES ('2025-03-29', 'Temperature.', 'claude', 't', 't')",
    ).run().lastInsertRowid;
    s.store.db.prepare(
      "INSERT INTO chronology_sources(entry_id, doc_id, line_start, line_end) VALUES (?, 'D001', 7, 9)",
    ).run(partial);
    await assertRejects(() => s.verifyChronology(Number(partial)), CantCheckError);
    // A user's own entry with no source at all.
    const none = s.store.addChronology({
      event_date: "2025-03-01",
      description: "Separated.",
      sources: [],
    }, "user");
    await assertRejects(() => s.verifyChronology(none), CantCheckError);
    for (const id of [c, Number(partial), none]) {
      assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
    }
  } finally {
    state.lock();
  }
});

Deno.test("the API shows partial line ranges and missing sources as Can't check", async () => {
  const { state, user, s } = await canon();
  try {
    const none = s.store.addChronology({
      event_date: "2025-03-01",
      description: "Separated.",
      sources: [],
    }, "user");
    const e = (await user.get("/api/chronology")).json.find((x: { id: number }) => x.id === none);
    assertEquals(e.state, "cant_check");
    const r = await user.post(`/api/chronology/${none}/verify`, {
      version: e.version,
      quoteAccurate: true,
      fairReading: true,
    });
    assertEquals(r.status, 409, r.text);
  } finally {
    state.lock();
  }
});
