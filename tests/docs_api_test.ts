/**
 * The documents and plan API (W1-B contract): states, origin, review findings, sharing, withdraw,
 * reopen, re-check, exposures. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { assertNoSecrets, importAndPublish, publishRequestFrom, withCase } from "./helpers/app.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE, MESSAGES, MESSAGES_TITLE } from "./fixtures/synthetic.ts";

const COMMERCIAL = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };

Deno.test("a new import is not asked yet: withheld until the user says where it came from", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  const imp = await user.post("/api/docs/import", { title: MESSAGES_TITLE, text: MESSAGES });
  assertEquals(imp.status, 200, imp.text);
  assertEquals(imp.json.origin, null);
  const id = imp.json.id;
  const review = (await user.get(`/api/docs/${id}/review`)).json;
  const pub = await user.post(`/api/docs/${id}/publish`, publishRequestFrom(review));
  assertEquals(pub.status, 200, pub.text);
  assertEquals([pub.json.withheld, pub.json.state], [true, "withheld"]);
  assertEquals(s().store.getDocument(id).body, null);
  assertEquals(s().store.getDocument(id).withheld_reason, "not_asked");

  const list = (await user.get("/api/docs")).json;
  const row = list.find((d: { id: string }) => d.id === id);
  assertEquals(row.state, "withheld");
  assertEquals(row.withheldReason, "not_asked");
  assertEquals(row.origin, null);
  assertEquals(row.cited, 0);
  assertEquals(row.sharedAt, null);

  // The impact of saying it is the user's own, then doing it.
  const impact = await user.get(`/api/docs/${id}/origin-impact?origin=mine`);
  assertEquals(impact.json.withdraw, false);
  const put = await user.put(`/api/docs/${id}/origin`, { origin: "mine" });
  assertEquals(put.json, { state: "shared", withdrawn: false });
  assert(s().store.getDocument(id).body !== null);
  // Changing it back to "not sure" withdraws it, and the impact said so first.
  const impact2 = await user.get(`/api/docs/${id}/origin-impact?origin=not_sure`);
  assertEquals(impact2.json.withdraw, true);
  assertEquals(Object.keys(impact2.json.citedBy).sort(), [
    "chronology",
    "evidence",
    "notes",
    "paragraphs",
  ]);
  assertEquals((await user.put(`/api/docs/${id}/origin`, { origin: "not_sure" })).json, {
    state: "withheld",
    withdrawn: true,
  });
  assertEquals((await user.put(`/api/docs/${id}/origin`, { origin: "public" })).status, 400);
});

Deno.test("review data: findings grouped, segments per line, origin hint, safety roles", async () => {
  const { user } = await withCase();
  await importAndPublish(user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const text = "PRODUCED UNDER SUBPOENA\nAnna rang Daniel on 0412 999 888.";
  const imp = await user.post("/api/docs/import", { title: "Phone records", text });
  assertEquals(imp.json.originHint.origin, "court_or_subpoena");
  const r = (await user.get(`/api/docs/${imp.json.id}/review`)).json;
  assertEquals(r.originHint, { origin: "court_or_subpoena", reason: r.originHint.reason, line: 1 });
  assertEquals(r.state, "needs_review");
  assert(Array.isArray(r.safetyRoles));
  const byText = new Map(r.findings.map((f: { text: string }) => [f.text, f]));
  // deno-lint-ignore no-explicit-any
  const anna: any = byText.get("Anna");
  assertEquals([anna.group, anna.auto, anna.role, anna.lines], [
    "people",
    true,
    "mother",
    [2],
  ]);
  // deno-lint-ignore no-explicit-any
  const phone: any = byText.get("0412 999 888");
  assertEquals(phone.group, "ids");
  // Segments rebuild each original line exactly.
  assertEquals(
    r.lines.map((l: { segs: { t: string }[] }) => l.segs.map((x) => x.t).join("")),
    text.split("\n"),
  );
  const seg = r.lines[1].segs.find((x: { t: string }) => x.t === "Anna");
  assertEquals([seg.role, seg.group, seg.finding], ["mother", "people", anna.id]);
});

Deno.test("leave as written needs a reason, and never for a safety-sensitive person", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await importAndPublish(user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const imp = await user.post("/api/docs/import", {
    title: "Note",
    text: "Anna and Quokka met.",
    origin: "mine",
  });
  const id = imp.json.id;
  const base = { newEntities: [], replacements: [] };
  // A reason map that leaves one out: refused, nothing written.
  let r = await user.post(`/api/docs/${id}/publish`, {
    ...base,
    replacements: [{ start: 0, end: 4, ref: "mother", form: "first" }],
    ignore: ["Quokka"],
    ignoreReasons: { Other: "x" },
  });
  assertEquals(r.status, 400, r.text);
  assertEquals(s().store.hasDocument(id), false);
  // No reasons at all: refused too. (The legacy review screen's "no reason asked" fallback is
  // gone, W3-4: every value newly left as written has the user's reason.)
  r = await user.post(`/api/docs/${id}/publish`, {
    ...base,
    replacements: [{ start: 0, end: 4, ref: "mother", form: "first" }],
    ignore: ["Quokka"],
  });
  assertEquals(r.status, 400, r.text);
  assert(r.json.error.includes("Quokka"), r.text);
  assertEquals(s().store.hasDocument(id), false);
  // The mother is marked safety-sensitive: leaving her name as written is refused (409).
  assertEquals((await user.req("PATCH", "/api/entities/mother", { safety: true })).status, 200);
  r = await user.post(`/api/docs/${id}/publish`, {
    ...base,
    ignore: ["Anna"],
    ignoreReasons: { Anna: "it's fine" },
  });
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.safety, ["mother"]);
  assertEquals(s().store.hasDocument(id), false);
  // With a reason, a non-identifying word may be left.
  r = await user.post(`/api/docs/${id}/publish`, {
    ...base,
    replacements: [{ start: 0, end: 4, ref: "mother", form: "first" }],
    ignore: ["Quokka"],
    ignoreReasons: { Quokka: "an animal, not a person" },
  });
  assertEquals(r.status, 200, r.text);
  const review = (await user.get(`/api/docs/${id}/review`)).json;
  assertEquals(review.ignoreReasons, { Quokka: "an animal, not a person" });
  const kept = review.findings.find((f: { group: string }) => f.group === "kept");
  assertEquals([kept.text, kept.reason, kept.lines], ["Quokka", "an animal, not a person", [1]]);
});

Deno.test("withdraw (Undo share), reopen (Review again) and re-check", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  const { id } = await importAndPublish(user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  assertEquals(s().store.hasDocument(id), true);
  let r = await user.post(`/api/docs/${id}/withdraw`);
  assertEquals(r.json, { ok: true, state: "needs_review" });
  assertEquals(s().store.hasDocument(id), false);
  assertEquals((await user.post(`/api/docs/${id}/withdraw`)).status, 400);
  // Publish again from the same review, then review again: earlier decisions come back.
  const review = (await user.get(`/api/docs/${id}/review`)).json;
  assertEquals(
    (await user.post(`/api/docs/${id}/publish`, publishRequestFrom(review))).status,
    200,
  );
  r = await user.post(`/api/docs/${id}/reopen`);
  assertEquals(r.json.state, "needs_review");
  assertEquals(s().store.hasDocument(id), false);
  const again = (await user.get(`/api/docs/${id}/review`)).json;
  assert(
    again.proposals.every((p: { proposal: { type: string } }) => p.proposal.type === "existing"),
    "every earlier decision is an accepted proposal",
  );
  assertEquals(
    (await user.post(`/api/docs/${id}/publish`, publishRequestFrom(again))).status,
    200,
  );
  assertNoSecrets(s().store.getDocument(id).body!, "re-shared body");
  // Re-check of a shared document with nothing new: still shared.
  r = await user.post("/api/docs/recheck", { docs: [id] });
  assertEquals(r.json.results, [{ id, state: "shared", unresolved: 0 }]);
  assertEquals((await user.post("/api/docs/recheck", { docs: "D001" })).status, 400);
});

Deno.test("adding a nickname over the API withdraws a shared document; exposures list it", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await importAndPublish(user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const { id } = await importAndPublish(user, { title: "Note", text: "Anni rang at noon." });
  assertEquals(s().store.getDocument(id).body, "Anni rang at noon.");
  const aliases = s().registry.get("mother")!.aliases;
  const p = await user.req("PATCH", "/api/entities/mother", { aliases: [...aliases, "Anni"] });
  assertEquals(p.status, 200, p.text);
  assertEquals(s().store.getDocument(id).body, null);
  const docs = (await user.get("/api/docs")).json;
  assertEquals(docs.find((d: { id: string }) => d.id === id).state, "exposed");
  const ex = (await user.get("/api/exposures")).json;
  assertEquals(ex.length, 1);
  assertEquals([ex[0].doc, ex[0].title, ex[0].state, ex[0].resharedAt], [
    id,
    "Note",
    "exposed",
    null,
  ]);
  const view = (await user.get(`/api/docs/${id}`)).json;
  assertEquals([view.state, view.withheldReason], ["exposed", "exposed"]);
  assert(view.activity.some((a: { action: string }) => a.action === "document_withdrawn"));
  const rc = await user.post("/api/docs/recheck", { docs: [id] });
  assertEquals(rc.json.results[0].state, "shared");
  assertEquals(s().store.getDocument(id).body, "{{mother}} rang at noon.");
  assertExists((await user.get("/api/exposures")).json[0].resharedAt);
});

Deno.test("plan API: conditions required, nothing shared by switching, then one at a time", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  await importAndPublish(user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const { id } = await importAndPublish(user, {
    title: MESSAGES_TITLE,
    text: MESSAGES,
    origin: "other_side",
  });
  const order = await importAndPublish(user, {
    title: "Family report",
    text: "A report.",
    origin: "under_order",
  });
  let r = await user.get("/api/plan");
  assertEquals(r.json.setup, "consumer");
  assertEquals(r.json.couldShare.map((d: { id: string }) => d.id), [id]);
  assertEquals(r.json.stillWithheld.map((d: { id: string }) => d.id), [order.id]);
  r = await user.post("/api/plan", { setup: "commercial" });
  assertEquals(r.status, 400);
  r = await user.post("/api/plan", {
    setup: "commercial",
    conditions: { ...COMMERCIAL, closedEnvironment: false },
  });
  assertEquals(r.status, 400);
  assertEquals(s().effectiveSetup, "consumer");
  r = await user.post("/api/plan", { setup: "commercial", conditions: COMMERCIAL });
  assertEquals(r.status, 200, r.text);
  assertEquals([r.json.setup, r.json.attested, r.json.withdrawn], ["commercial", true, []]);
  assertExists(r.json.at);
  assertEquals(s().store.getDocument(id).body, null, "switching shares nothing");
  // Under an order: refused even now.
  assertEquals((await user.post(`/api/docs/${order.id}/share`)).status, 400);
  assertEquals((await user.post(`/api/docs/${id}/share`)).json, { ok: true, state: "shared" });
  assert(s().store.getDocument(id).body !== null);
  r = await user.post("/api/plan", { setup: "consumer" });
  assertEquals(r.json.withdrawn, [id]);
  assertEquals(s().store.getDocument(id).body, null);
});
