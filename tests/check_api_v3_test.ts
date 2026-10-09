/**
 * Wave 3 checking, drafting and paste API (v3/check-api): every check message re-identified on
 * one server path, paste sentences with their paragraph, facts split by core, sources with
 * context, relies dates, ¶N in "Used in", distinct 409 codes, issue and evidence edits, a
 * chronology count per issue, the own-statement flag from the vault, the feeling-word check and
 * the safety warning on Paste. SYNTHETIC data only (ADR 11): the CANON case.
 */
import { assert, assertEquals } from "@std/assert";
import { setDocAuthor } from "../src/core/checking.ts";
import { setParagraphSources } from "../src/core/drafting.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { type Client, withCase } from "./helpers/app.ts";

const TOKEN = /\{\{[a-z]/;

async function canon() {
  const t = await withCase({ detectorFactory: () => [] });
  const s = t.state.session!;
  await seedCanon(s);
  return { ...t, s };
}

// deno-lint-ignore no-explicit-any
type Any = any;

async function chronoEntry(user: Client, id: number): Promise<Any> {
  const r = await user.get("/api/chronology");
  assertEquals(r.status, 200, r.text);
  return r.json.find((e: Any) => e.id === id);
}

async function issueOf(user: Client, id: number): Promise<Any> {
  const r = await user.get("/api/issues");
  assertEquals(r.status, 200, r.text);
  return r.json.find((i: Any) => i.id === id);
}

/** No check message, text or segment the API sends still holds a name token. */
function assertReidentified(rows: Any[], where: string) {
  for (const c of rows) {
    assert(!TOKEN.test(c.message), `${where}: message has a token: ${c.message}`);
    assert(!TOKEN.test(c.text ?? ""), `${where}: text has a token: ${c.text}`);
    assert(Array.isArray(c.segs), `${where}: no segs`);
    assertEquals(c.segs.map((g: Any) => g.t).join(""), c.message);
  }
}

// ── 1. one re-identification path for check rows ─────────────────────────────

Deno.test("check messages are re-identified everywhere: chronology, evidence, drafts, export, paste", async () => {
  const { state, user, s } = await canon();
  try {
    // Chronology: Claude swapped the children (D001:7 names Lachlan).
    const c = s.store.addChronology({
      event_date: "2025-03-29",
      description: "{{child_1.first}} has a temperature.",
      sources: [{ doc_id: "D001", line_start: 7, line_end: 7 }],
    }, "claude");
    const e = await chronoEntry(user, c);
    assertReidentified(e.checks, "chronology");
    assert(e.checks.some((r: Any) => r.message.includes("Mia") && r.message.includes("Lachlan")));

    const issue = s.store.addIssue(
      { title: "Medical care", description: "Who decides." },
      "claude",
    );
    s.store.addEvidence(issue, {
      doc_id: "D001",
      line_start: 7,
      line_end: 7,
      note: "{{child_1.first}} was unwell",
    }, "claude");
    const i = await issueOf(user, issue);
    assertReidentified(i.evidence[0].checks, "evidence");

    // An outline: Claude's unadopted paragraph's fact flags go to exportCheck.flags.
    const draft = (await user.post("/api/drafts", { kind: "outline", title: "Outline" })).json.id;
    const p = s.store.addParagraph(
      draft,
      "{{child_2.first}} waited at {{school}} on 14 March 2025.",
      "claude",
    );
    await setParagraphSources(s, p, [{ doc_id: "D001", line_start: 1, line_end: 2 }]);
    const d = (await user.get(`/api/drafts/${draft}`)).json;
    assertReidentified(d.paragraphs[0].checks, "paragraph checks");
    for (const f of d.paragraphs[0].facts) assertReidentified(f.checks, "facts");
    const flags = d.exportCheck.flags.filter((x: Any) => x.reason === "fact");
    assert(flags.length > 0, "a fact flag");
    for (const f of d.exportCheck.flags) {
      assert(!TOKEN.test(f.message), `export flag has a token: ${f.message}`);
      assertEquals(f.segs.map((g: Any) => g.t).join(""), f.message);
    }
    assert(flags.some((f: Any) => f.message.includes("Lachlan")));

    // Paste.
    const r = await user.post("/api/paste/view", {
      text: "{{child_2.first}} has a temperature (D001:5).",
    });
    assertEquals(r.status, 200, r.text);
    assertReidentified(r.json.sentences[0].checks, "paste");
    assert(r.json.sentences[0].checks.some((x: Any) => x.message.includes("Lachlan")));
  } finally {
    state.lock();
  }
});

// ── 2. paste sentences carry their paragraph ────────────────────────────────

Deno.test("paste view: each sentence has its paragraph index", async () => {
  const { state, user } = await canon();
  try {
    const r = await user.post("/api/paste/view", {
      text: "{{father.first}} was late (D001:1-2). He said traffic.\n\n" +
        "{{child_1.first}} waited.\r\n\r\nThird one. And more.",
    });
    assertEquals(r.status, 200, r.text);
    assertEquals(
      r.json.sentences.map((x: Any) => [x.paragraph, x.text.text]),
      [
        [0, "Daniel was late."],
        [0, "He said traffic."],
        [1, "Mia waited."],
        [2, "Third one."],
        [2, "And more."],
      ],
    );
    assertEquals(r.json.paragraphs, 3);
    assertEquals(r.json.sentences[0].cites, ["D001:1-2"]);
  } finally {
    state.lock();
  }
});

// ── 3, 4, 5, 11. facts from core, sources with context, relies date, feelings ──

Deno.test("drafts: facts come from core and are what adoption records; feelings are flagged", async () => {
  const { state, user, s } = await canon();
  try {
    const draft = (await user.post("/api/drafts", { kind: "affidavit", title: "Affidavit" })).json
      .id;
    const late = s.store.addChronology({
      event_date: "2025-03-14",
      description: "{{father.first}} was 90 minutes late.",
      sources: [{ doc_id: "D001", line_start: 1, line_end: 2 }],
    }, "claude");
    const p = s.store.addParagraph(
      draft,
      "On 14 March 2025 {{father.first}} collected {{child_1.first}} late. " +
        "{{child_1.first}} was upset and scared (D001:4).",
      "claude",
    );
    await setParagraphSources(
      s,
      p,
      [{ doc_id: "D001", line_start: 2, line_end: 2 }],
      [{ target_type: "chronology", target_id: late }],
    );
    const d = (await user.get(`/api/drafts/${draft}`)).json;
    const para = d.paragraphs[0];

    // Facts: core's sentence split, inline citations used for their own sentence.
    assertEquals(para.facts.map((f: Any) => [f.text.text, f.cites]), [
      ["On 14 March 2025 Daniel collected Mia late.", ["D001:2"]],
      ["Mia was upset and scared.", ["D001:4"]],
    ]);
    // The feeling-word check fires (DESIGN-SPEC: "only you can say it").
    const feel = para.facts[1].checks.filter((c: Any) => c.kind === "feeling");
    assertEquals(feel.map((c: Any) => [c.text, c.level, c.ok]), [
      ["upset", "attention", null],
      ["scared", "attention", null],
    ]);
    assert(para.checks.some((c: Any) => c.kind === "feeling" && c.text === "upset"));

    // Sources: ±2 lines of context, each marked cited or not.
    const src = para.sources[0];
    assertEquals(src.ref, "D001:2");
    assertEquals(src.lines.map((l: Any) => [l.line, l.cited]), [
      [1, false],
      [2, true],
      [3, false],
      [4, false],
    ]);
    assertEquals(src.context.before.length, 1);
    assert(!TOKEN.test(src.lines[0].text), "context lines are re-identified");

    // Relies: the entry's date on its own.
    assertEquals(para.relies[0].date, "2025-03-14");
    assertEquals(para.relies[0].label, "Daniel was 90 minutes late.");

    // Adoption records exactly the facts shown, one answer each.
    const r = await user.post(`/api/paragraphs/${p}/adopt`, {
      ownKnowledge: true,
      ownWords: true,
      version: para.version,
      facts: para.facts.map((f: Any, i: number) => ({
        text: f.text.text,
        answer: i ? "saw" : "read",
      })),
    });
    assertEquals(r.status, 200, r.text);
    const vault = await s.readVaultJson<Record<string, { facts: Any[] }>>("adoption-facts", {});
    assertEquals(
      vault[String(p)].facts,
      para.facts.map((f: Any, i: number) => ({ text: f.text.text, answer: i ? "saw" : "read" })),
    );
  } finally {
    state.lock();
  }
});

Deno.test("usedIn gives the paragraph's number in its draft (¶N)", async () => {
  const { state, user, s } = await canon();
  try {
    const c = s.store.addChronology({
      event_date: "2025-03-22",
      description: "Swimming moved to Saturday.",
      sources: [{ doc_id: "D001", line_start: 5, line_end: 5 }],
    }, "claude");
    const draft = (await user.post("/api/drafts", { kind: "affidavit", title: "A" })).json.id;
    await user.post(`/api/drafts/${draft}/paragraphs`, { text: "I am the mother." });
    await user.post(`/api/drafts/${draft}/paragraphs`, { text: "I live in Dapto." });
    const third = s.store.addParagraph(draft, "Swimming moved.", "claude");
    await setParagraphSources(s, third, [], [{ target_type: "chronology", target_id: c }]);
    const e = await chronoEntry(user, c);
    assertEquals(e.usedIn.map((u: Any) => [u.paragraph_id, u.n]), [[third, 3]]);
  } finally {
    state.lock();
  }
});

// ── 6. distinct 409s ─────────────────────────────────────────────────────────

Deno.test("409s say which: version mismatch (stale) or Can't check", async () => {
  const { state, user, s } = await canon();
  try {
    const ok = s.store.addChronology({
      event_date: "2025-03-22",
      description: "Swimming moved to Saturday.",
      sources: [{ doc_id: "D001", line_start: 5, line_end: 5 }],
    }, "claude");
    const cant = s.store.addChronology({
      event_date: "2025-03-29",
      description: "{{child_1.first}} has a temperature.",
      sources: [{ doc_id: "D001", line_start: 7, line_end: 7 }],
    }, "claude");
    const ticks = { quoteAccurate: true, fairReading: true };

    const old = (await chronoEntry(user, ok)).version;
    s.store.updateChronology(ok, { description: "Swimming moved to Sunday." });
    const stale = await user.post(`/api/chronology/${ok}/verify`, { version: old, ...ticks });
    assertEquals(stale.status, 409, stale.text);
    assertEquals([stale.json.code, stale.json.stale, stale.json.cantCheck], [
      "stale",
      true,
      undefined,
    ]);

    const v = (await chronoEntry(user, cant)).version;
    const refused = await user.post(`/api/chronology/${cant}/verify`, { version: v, ...ticks });
    assertEquals(refused.status, 409);
    assertEquals([refused.json.code, refused.json.cantCheck, refused.json.stale], [
      "cant_check",
      true,
      undefined,
    ]);

    // Adopting a paragraph that changed since it was shown: the same stale code.
    const draft = (await user.post("/api/drafts", { kind: "affidavit", title: "A" })).json.id;
    const p = s.store.addParagraph(draft, "Swimming moved.", "claude");
    const shown = (await user.get(`/api/drafts/${draft}`)).json.paragraphs[0].version;
    s.store.updateParagraph(p, "Swimming moved again.", "claude");
    const adopt = await user.post(`/api/paragraphs/${p}/adopt`, {
      ownKnowledge: true,
      ownWords: true,
      version: shown,
    });
    assertEquals([adopt.status, adopt.json.code], [409, "stale"]);
  } finally {
    state.lock();
  }
});

// ── 7. edits to issues and evidence ──────────────────────────────────────────

Deno.test("PATCH issue and evidence: the user's edit withdraws their check (To check, not changed)", async () => {
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
      note: "{{child_2.first}} was unwell",
      stance: "context",
    }, "claude");
    let i = await issueOf(user, issue);
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
      200,
    );
    i = await issueOf(user, issue);
    assertEquals([i.descState, i.evidence[0].state], ["checked", "checked"]);

    // Edit the description (real names are tokenised) and the evidence note and stance.
    let r = await user.req("PATCH", `/api/issues/${issue}`, {
      description: "Who decides Lachlan's medical care.",
    });
    assertEquals([r.status, r.json.changed], [200, true], r.text);
    assertEquals(
      s.store.getIssue(issue).description,
      "Who decides {{child_2.first}}'s medical care.",
    );
    r = await user.req("PATCH", `/api/evidence/${ev}`, {
      note: "Lachlan had a temperature",
      stance: "supports",
    });
    assertEquals([r.status, r.json.changed], [200, true], r.text);
    const stored = s.store.getEvidence(ev);
    assertEquals([stored.note, stored.stance], ["{{child_2.first}} had a temperature", "supports"]);

    i = await issueOf(user, issue);
    assertEquals([i.descState, i.lapsed], ["to_check", null]);
    assertEquals([i.evidence[0].state, i.evidence[0].lapsed], ["to_check", null]);
    assertEquals(i.evidence[0].note.text, "Lachlan had a temperature");

    // Bad input and removed items.
    assertEquals((await user.req("PATCH", `/api/evidence/${ev}`, { stance: "maybe" })).status, 400);
    assertEquals((await user.req("PATCH", `/api/issues/${issue}`, { title: "" })).status, 400);
    await user.post(`/api/evidence/${ev}/remove`);
    assertEquals((await user.req("PATCH", `/api/evidence/${ev}`, { note: "x" })).status, 409);

    const log = s.store.listLog(50).map((l) => l.action);
    assert(log.includes("issue_edited") && log.includes("evidence_edited"));
  } finally {
    state.lock();
  }
});

Deno.test("PATCH evidence: keeping a name Claude wrote as plain text is refused (probe guard)", async () => {
  const { state, user, s } = await canon();
  try {
    const issue = s.store.addIssue({ title: "Medical care", description: "" }, "claude");
    // Claude guessed a name in plain text; the user's save must not tell it whether it is real.
    const ev = s.store.addEvidence(issue, {
      doc_id: "D001",
      line_start: 7,
      line_end: 7,
      note: "Lachlan was unwell",
    }, "claude");
    const r = await user.req("PATCH", `/api/evidence/${ev}`, { note: "Lachlan was very unwell" });
    assertEquals(r.status, 400, r.text);
    assertEquals(s.store.getEvidence(ev).note, "Lachlan was unwell");
  } finally {
    state.lock();
  }
});

// ── 8. undo of a just-added link goes to Removed items ───────────────────────

Deno.test("removing the user's own just-added evidence keeps it in Removed items", async () => {
  const { state, user, s } = await canon();
  try {
    const issue = s.store.addIssue({ title: "Changeovers", description: "" }, "claude");
    const id = (await user.post(`/api/issues/${issue}/evidence`, { source: "D001:1-2" })).json.id;
    assertEquals((await user.post(`/api/evidence/${id}/remove`)).status, 200);
    const removed = (await user.get("/api/evidence?removed=1")).json;
    assertEquals(removed.map((e: Any) => e.id), [id]);
    assertEquals((await issueOf(user, issue)).evidence, []);
  } finally {
    state.lock();
  }
});

// ── 9. chronology per issue ──────────────────────────────────────────────────

Deno.test("each issue counts the chronology entries that bear on it", async () => {
  const { state, user, s } = await canon();
  try {
    const issue = s.store.addIssue({ title: "Changeovers", description: "" }, "claude");
    const other = s.store.addIssue({ title: "Swimming", description: "" }, "claude");
    s.store.addEvidence(issue, { doc_id: "D001", line_start: 1, line_end: 3 }, "claude");
    const a = s.store.addChronology({
      event_date: "2025-03-14",
      description: "Late.",
      sources: [{ doc_id: "D001", line_start: 2, line_end: 2 }],
    }, "claude");
    const b = s.store.addChronology({
      event_date: "2025-03-15",
      description: "Third time.",
      sources: [{ doc_id: "D001", line_start: 3, line_end: 3 }],
    }, "claude");
    s.store.addChronology({
      event_date: "2025-03-22",
      description: "Swimming.",
      sources: [{ doc_id: "D001", line_start: 5, line_end: 5 }],
    }, "claude");
    let i = await issueOf(user, issue);
    assertEquals(i.chronologyCount, 2);
    assertEquals(i.chronology.map((c: Any) => c.id), [a, b]);
    assertEquals((await issueOf(user, other)).chronologyCount, 0);
    // An entry the user removed no longer counts.
    await user.post(`/api/chronology/${b}/remove`);
    i = await issueOf(user, issue);
    assertEquals(i.chronologyCount, 1);
  } finally {
    state.lock();
  }
});

// ── 10. own statement from the vault, not Claude-writable author_role ────────

Deno.test("own-statement flag ignores author_role that Claude wrote in public.db", async () => {
  const { state, user, s } = await canon();
  try {
    await s.updateSettings({ userRole: "mother" });
    const id = s.store.addChronology({
      event_date: "2025-03-14",
      description: "{{father.first}} was 90 minutes late.",
      sources: [{ doc_id: "D002", line_start: 9, line_end: 9 }],
    }, "claude");
    // Claude (or the user's old metadata) says the mother wrote D002: not authoritative.
    s.store.setDocumentMeta("D002", { author_role: "mother" }, "claude");
    assertEquals((await chronoEntry(user, id)).ownStatementOnly, false);
    s.store.setDocumentMeta("D002", { author_role: "mother" }, "user");
    assertEquals((await chronoEntry(user, id)).ownStatementOnly, false);
    // Recorded in the vault by the app: it counts.
    await setDocAuthor(s, "D002", "mother");
    assertEquals((await chronoEntry(user, id)).ownStatementOnly, true);
    // Someone else's statement: no.
    await setDocAuthor(s, "D002", "father");
    assertEquals((await chronoEntry(user, id)).ownStatementOnly, false);
  } finally {
    state.lock();
  }
});

// ── 11. safety-sensitive people on Paste ─────────────────────────────────────

Deno.test("paste view lists safety-sensitive people it re-identifies; a copy after the warning is logged", async () => {
  const { state, user, s } = await canon();
  try {
    let r = await user.post("/api/paste/view", { text: "{{father.first}} was late." });
    assertEquals(r.json.safety, []);
    // CANON marks the mother safety-sensitive (and her home is her address).
    r = await user.post("/api/paste/view", {
      text: "{{mother.first}} lives at {{mothers_home}}. {{father.first}} was late.",
    });
    assertEquals(r.json.safety, [{ role: "mother", name: "Anna Thornbury" }]);
    const viewed = s.store.listLog(20).find((l) => l.action === "paste_viewed")!;
    assertEquals(JSON.parse(viewed.detail).safety, 1);

    assertEquals(
      (await user.post("/api/paste/copied", { chars: 10, safetyConfirmed: true })).status,
      200,
    );
    const copied = s.store.listLog(20).find((l) => l.action === "paste_copied")!;
    assertEquals(JSON.parse(copied.detail), { chars: 10, safety_confirmed: true });
    assertEquals((await user.post("/api/paste/copied", { safetyConfirmed: "yes" })).status, 400);
  } finally {
    state.lock();
  }
});
