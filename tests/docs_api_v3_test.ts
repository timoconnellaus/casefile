/**
 * Documents, review and exposure API gaps closed in wave 3 (v3/docs-api): the title Claude sees
 * and a dry-run publish, withdraw keeping decisions, import batches, logForDoc, details kept while
 * an origin change withholds a document, exposure triggers, undecided counts and new matches,
 * "Cited in" items, and the vault-side document author. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { importAndPublish, publishRequestFrom, withCase } from "./helpers/app.ts";
import { cli } from "./helpers/canon_work.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { docAuthor } from "../src/core/checking.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE } from "./fixtures/synthetic.ts";

/** Everything Claude can read: every row of public.db's tables, as text. */
function publicText(state: { session?: { store: { db: unknown } } | null }): string {
  // deno-lint-ignore no-explicit-any
  const db = (state.session!.store as any).db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join(
    "\n",
  );
}

// ── 1. the title Claude sees, and a dry run ─────────────────────────────────

Deno.test("review gives the title Claude will see; preview checks decisions without publishing", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await seedCanon(s());
  const imp = await user.post("/api/docs/import", {
    title: "Anna's notes about Lachlan",
    text: "Lachlan was collected late by Daniel.",
    origin: "mine",
  });
  const id = imp.json.id;
  const review = (await user.get(`/api/docs/${id}/review`)).json;
  assertEquals(review.claudeTitle, "{{mother.first}}'s notes about {{child_2.first}}");
  assertEquals(review.titleLeaks, []);
  assertEquals(review.claudeTitleSegs[0], { t: "{{mother.first}}", role: "mother", form: "first" });
  assertEquals(review.claudeTitleSegs.map((x: { t: string }) => x.t).join(""), review.claudeTitle);

  // A title with a name casefile doesn't know yet: the dry run names it, and nothing changes.
  const logBefore = s().store.listLog(1000).length;
  const entitiesBefore = s().registry.list().length;
  const req = { ...publishRequestFrom(review), title: "Notes for Sarah Jones" };
  const p = await user.post(`/api/docs/${id}/preview`, req);
  assertEquals(p.status, 200, p.text);
  assertEquals(p.json.refused.kind, "leak");
  assert(p.json.titleLeaks.some((l: { text: string }) => l.text === "Sarah Jones"));
  assertFalse(p.json.willShare);
  assertEquals(s().store.listLog(1000).length, logBefore, "a preview is not logged");
  assertEquals(s().registry.list().length, entitiesBefore, "a preview creates no one");
  assertFalse(s().store.hasDocument(id), "a preview publishes nothing");
  assertEquals((await s().getDoc(id)).status, "pending");

  // Deciding the name as a new person in the same request: the title becomes their label.
  const req2 = {
    ...req,
    newEntities: [...req.newEntities, { ref: "n-sj", kind: "person", full: "Sarah Jones" }],
  };
  const p2 = (await user.post(`/api/docs/${id}/preview`, req2)).json;
  assertEquals(p2.refused, null);
  assertEquals(p2.titleLeaks, []);
  assert(/^Notes for \{\{person_\d+\}\}$/.test(p2.claudeTitle), p2.claudeTitle);
  assert(p2.willShare);
  assertEquals(s().registry.list().length, entitiesBefore);

  // Leaving a safety-sensitive name as written is refused in the dry run too.
  const p3 = (await user.post(`/api/docs/${id}/preview`, {
    ...publishRequestFrom(review),
    ignore: ["Anna"],
    ignoreReasons: { Anna: "It's me" },
  })).json;
  assertEquals(p3.refused.kind, "safety");
  assertEquals(p3.refused.roles, ["mother"]);

  // A bad body is a 400, like publish.
  assertEquals((await user.post(`/api/docs/${id}/preview`, { newEntities: 1 })).status, 400);
});

// ── 2. Undo share keeps the decisions ───────────────────────────────────────

Deno.test("withdraw (Undo share) keeps the user's decisions, like Review again", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await seedCanon(s());
  // "Okafor" alone could be the father or a child: the user decides (the father).
  const imp = await user.post("/api/docs/import", {
    title: "Phone note",
    text: "Okafor rang about Mia.\nAnna answered.",
    origin: "mine",
  });
  const id = imp.json.id;
  const first = (await user.get(`/api/docs/${id}/review`)).json;
  assert(first.findings.some((f: { group: string }) => f.group === "needs"));
  assertEquals((await user.post(`/api/docs/${id}/publish`, publishRequestFrom(first))).status, 200);
  const before = await s().getDoc(id);
  assert(before.replacements.length > 0);
  const w = await user.post(`/api/docs/${id}/withdraw`);
  assertEquals(w.json.state, "needs_review");
  assertFalse(s().store.hasDocument(id));
  const review = (await user.get(`/api/docs/${id}/review`)).json;
  // Every earlier replacement comes back decided, as the person it was given to.
  for (const r of before.replacements) {
    const p = review.proposals.find((x: { start: number; end: number }) =>
      x.start === r.start && x.end === r.end
    );
    assertExists(p, `replacement ${r.start}-${r.end} kept`);
    assertEquals(p.proposal, { type: "existing", role: r.role, form: r.form });
  }
  // Nothing needs the user, so sharing again needs no new decision.
  assertEquals(
    review.findings.filter((f: { group: string }) => f.group === "needs").length,
    0,
  );
  const again = await user.post(`/api/docs/${id}/publish`, publishRequestFrom(review));
  assertEquals(again.status, 200, again.text);
  assertEquals((await s().getDoc(id)).tokenised, before.tokenised);
});

// ── 3. import batches ───────────────────────────────────────────────────────

Deno.test("import starts a batch; the rest join it; GET /api/docs?batch= is the review queue", async () => {
  const { user } = await withCase();
  const a = await user.post("/api/docs/import", { title: "One", text: "First text." });
  assertEquals(a.status, 200, a.text);
  const batch = a.json.batch;
  assert(/^B\d+$/.test(batch), batch);
  const b = await user.post("/api/docs/import", { title: "Two", text: "Second text.", batch });
  assertEquals(b.json.batch, batch);
  const c = await user.post("/api/docs/import", { title: "Three", text: "Third text." });
  assert(c.json.batch !== batch, "a new import is a new batch");

  const queue = (await user.get(`/api/docs?batch=${batch}`)).json;
  assertEquals(queue.map((d: { id: string }) => d.id), [a.json.id, b.json.id]);
  assertEquals(queue[0].batch, batch);
  const review = (await user.get(`/api/docs/${a.json.id}/review`)).json;
  assertEquals(review.batch, batch);

  // Only batches this case started.
  assertEquals((await user.get("/api/docs?batch=B999")).status, 400);
  assertEquals((await user.get("/api/docs?batch=x")).status, 400);
  const bad = await user.post("/api/docs/import", { title: "x", text: "x", batch: "B999" });
  assertEquals(bad.status, 400);
  // An empty document starts no batch.
  const empty = await user.post("/api/docs/import", { title: "x", text: "  " });
  assertEquals(empty.status, 400);
  const d = await user.post("/api/docs/import", { title: "Four", text: "Fourth." });
  assertEquals(Number(d.json.batch.slice(1)), Number(c.json.batch.slice(1)) + 1);
});

// ── 4. logForDoc ────────────────────────────────────────────────────────────

Deno.test("a document's activity includes chronology and evidence citing it and notes on it", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await seedCanon(s());
  await cli(s(), [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "Late.",
    "--source",
    "D001:1-2",
  ]);
  await cli(s(), [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "Late.",
    "--source",
    "D002:9",
  ]);
  const issue = JSON.parse(
    (await cli(s(), ["issue", "add", "--title", "Changeovers", "--json"])).out,
  ).id;
  await cli(s(), ["evidence", "add", String(issue), "--source", "D001:3", "--note", "Third time"]);
  await cli(s(), ["note", "add", "--on", "doc:D001", "--text", "Check the times."]);
  await cli(s(), ["note", "add", "--on", "doc:D002", "--text", "Affidavit."]);

  const actions = (id: string) => s().store.logForDoc(id).map((r) => r.action);
  const d1 = actions("D001");
  assertEquals(d1.filter((a) => a === "cli:chrono_add").length, 1);
  assert(d1.includes("cli:evidence_add"));
  assertEquals(d1.filter((a) => a === "cli:note_add").length, 1);
  const d2 = actions("D002");
  assertEquals(d2.filter((a) => a === "cli:chrono_add").length, 1);
  assertFalse(d2.includes("cli:evidence_add"));
  // A document id that is a prefix of another's does not match it.
  assertEquals(actions("D00").length, 0);
  // Through the API too.
  const doc = (await user.get("/api/docs/D001")).json;
  assert(doc.activity.some((r: { action: string }) => r.action === "cli:note_add"));
  // None of these are reads (ADR 16): Claude's reads of D001 are unchanged.
  assertEquals(s().store.claudeReads("D001").length, 0);
});

// ── 5. details kept while an origin change withholds it ─────────────────────

Deno.test("withholding by origin keeps type, date and tags in the vault; setting it back restores them", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  const { id } = await importAndPublish(user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  s().store.setDocumentMeta(id, { doc_type: "affidavit", doc_date: "2025-04-02" }, "claude");
  s().store.addTag(id, "changeovers", "user");
  s().store.addTag(id, "violence", "claude");

  const w = await user.put(`/api/docs/${id}/origin`, { origin: "not_sure" });
  assertEquals(w.json, { state: "withheld", withdrawn: true });
  // Claude sees nothing: no details and no tags in public.db.
  const row = s().store.getDocument(id);
  assertEquals([row.doc_type, row.doc_date, row.body], [null, null, null]);
  assertEquals(s().store.tagsFor(id), []);
  const pub = publicText(state);
  assertFalse(pub.includes("violence"), "a tag of a withheld document is in public.db");
  assertFalse(pub.includes("2025-04-02"));
  // The user still sees them, marked as kept for later.
  const listed = (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === id);
  assertEquals([listed.doc_type, listed.doc_date, listed.detailsHeld], [
    "affidavit",
    "2025-04-02",
    true,
  ]);
  assertEquals(listed.tags, ["changeovers", "violence"]);

  // Undo: the origin set back shares it again with its details.
  const back = await user.put(`/api/docs/${id}/origin`, { origin: "mine" });
  assertEquals(back.json.state, "shared");
  const again = s().store.getDocument(id);
  assertEquals([again.doc_type, again.doc_date, again.meta_by], [
    "affidavit",
    "2025-04-02",
    "claude",
  ]);
  assertEquals(s().store.tagsFor(id), ["changeovers", "violence"]);
  assertEquals(s().store.tagCreatedBy(id, "violence"), "claude");
  assertEquals((await s().getDoc(id)).heldDetails, null);
  const listed2 = (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === id);
  assertFalse(listed2.detailsHeld);
});

// ── 6 and 7. exposure triggers, new matches, undecided counts ───────────────

Deno.test("exposures say which value triggered them (app only); pending documents show new matches", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await seedCanon(s(), { omitAliases: ["Annie"] });
  const shared = await importAndPublish(user, {
    title: "Letter",
    text: "Our client says Annie refused the changeover.",
  });
  const pending = await user.post("/api/docs/import", {
    title: "Childcare email",
    text: "Annie picked up the children at 3pm.",
    origin: "mine",
  });
  const mother = s().registry.get("mother")!;
  const r = await user.req("PATCH", "/api/entities/mother", {
    aliases: ["Annie", ...mother.aliases],
  });
  assertEquals(r.status, 200, r.text);

  const ex = (await user.get("/api/exposures")).json;
  assertEquals(ex.length, 1);
  assertEquals(ex[0].doc, shared.id);
  assertEquals(ex[0].trigger, { role: "mother", kind: "alias", value: "Annie" });
  assertEquals(ex[0].triggers, [{ role: "mother", kind: "alias", value: "Annie" }]);
  assertEquals(ex[0].newMatchesIn, [pending.json.id]);

  const docs = (await user.get("/api/docs")).json;
  const p = docs.find((d: { id: string }) => d.id === pending.json.id);
  assertEquals(p.newMatch.values, [{ role: "mother", kind: "alias", value: "Annie" }]);
  assertEquals(p.newMatch.exposed, [shared.id]);
  assertEquals(docs.find((d: { id: string }) => d.id === shared.id).newMatch, null);

  // The value is never logged and never in public.db.
  const pub = publicText(state);
  assertFalse(/\bBec\b/.test(pub), "the triggering value reached public.db");

  // Publishing the pending document clears its new match.
  const review = (await user.get(`/api/docs/${pending.json.id}/review`)).json;
  await user.post(`/api/docs/${pending.json.id}/publish`, publishRequestFrom(review));
  const after = (await user.get("/api/docs")).json.find((d: { id: string }) =>
    d.id === pending.json.id
  );
  assertEquals(after.newMatch, null);
});

Deno.test("GET /api/docs counts the findings that need the user in each document", async () => {
  const { state, user } = await withCase();
  await seedCanon(state.session!);
  // "Okafor" alone is the father's or a child's surname: casefile can't decide, twice over.
  const imp = await user.post("/api/docs/import", {
    title: "Note",
    text: "Okafor called. Later Okafor called again. Mia was fine.",
  });
  assertEquals(imp.json.undecided, 1, "one value, counted once");
  const row = (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === imp.json.id);
  assertEquals(row.undecided, 1);
  const shared = (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === "D001");
  assertEquals(shared.undecided, 0);
});

// ── 8. Cited in ─────────────────────────────────────────────────────────────

Deno.test("citedIn gives each citing item a title, label, state and the lines it cites", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await seedCanon(s());
  await cli(s(), [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "{{father.first}} was late.",
    "--source",
    "D001:1-2",
    "--source",
    "D002:9",
  ]);
  const issue = JSON.parse(
    (await cli(s(), ["issue", "add", "--title", "Reliability of changeovers", "--json"])).out,
  ).id;
  await cli(s(), ["evidence", "add", String(issue), "--source", "D001:3", "--note", "Third time"]);
  await cli(s(), ["note", "add", "--on", "doc:D001", "--text", "Check {{child_1.first}}'s times."]);
  const doc = (await user.get("/api/docs/D001")).json;
  const by = (t: string) => doc.citedIn.find((c: { type: string }) => c.type === t);
  const c = by("chronology");
  assertEquals([c.label, c.title, c.state, c.removed], [
    "Chronology",
    "Daniel was late.",
    "to_check",
    false,
  ]);
  assertEquals([c.date, c.lines, c.others], ["2025-03-14", ["1-2"], ["D002:9"]]);
  const e = by("evidence");
  assertEquals([e.title, e.state, e.lines, e.issue_id, e.stance], [
    "Reliability of changeovers",
    "to_check",
    ["3"],
    issue,
    "supports",
  ]);
  const n = by("note");
  assertEquals([n.label, n.title, n.by], ["Claude’s note", "Check Mia's times.", "claude"]);
});

// ── 9. who wrote it, in the vault ───────────────────────────────────────────

Deno.test("the author of a document is kept in the vault, set only by the user", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await seedCanon(s());
  assertEquals((await user.get("/api/docs/D002")).json.author, null);
  const r = await user.put("/api/docs/D002/author", { role: "mother" });
  assertEquals(r.json, { ok: true, author: "mother" });
  assertEquals((await user.get("/api/docs/D002")).json.author, "mother");
  assertEquals(await docAuthor(s(), "D002"), "mother");
  assertEquals(
    (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === "D002").author,
    "mother",
  );
  // Not in public.db: Claude's author_role is a separate, untrusted hint.
  assertEquals(s().store.getDocument("D002").author_role, null);
  const row = s().store.listLog(5).find((l) => l.action === "doc_author_set")!;
  assertEquals(JSON.parse(row.detail), { doc: "D002" });
  // Claude writing author_role changes nothing.
  s().store.setDocumentMeta("D001", { author_role: "mother" }, "claude");
  assertEquals(await docAuthor(s(), "D001"), null);
  assertEquals((await user.get("/api/docs/D001")).json.author, null);
  // Only someone in who's who; null clears it.
  assertEquals((await user.put("/api/docs/D002/author", { role: "nobody" })).status, 400);
  assertEquals((await user.put("/api/docs/D002/author", { role: null })).json.author, null);
});
