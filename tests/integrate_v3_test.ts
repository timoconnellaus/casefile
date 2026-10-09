/**
 * Wave 3 integration (v3/integrate): the document-authors record follows who's who like
 * `relatedTo` does, and a document's details are kept in the vault whenever a shared document is
 * withheld (plan switch, exposure), restored when it is shared again, and never shown to Claude in
 * between. SYNTHETIC data only (ADR 11): the CANON case.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { docAuthor, ownStatementOnly, setDocAuthor } from "../src/core/checking.ts";
import { getDraftHeading, setDraftHeading, userCreateDraft } from "../src/core/drafting.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { importAndPublish, withCase } from "./helpers/app.ts";

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

const ALL_CONDITIONS = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };

Deno.test("the document-authors record and the user's role follow a rename; a removed role is dropped", async () => {
  const { state, user } = await withCase({ detectorFactory: () => [] });
  const s = () => state.session!;
  try {
    await seedCanon(s());
    await s().updateSettings({ userRole: "mother" });
    await setDocAuthor(s(), "D002", "mother");
    await setDocAuthor(s(), "D001", "father");
    const refs = [{ doc_id: "D002", line_start: 9, line_end: 9 }];
    assert(await ownStatementOnly(s(), refs));

    // Renaming the author: the record follows, and so does the user's own role.
    const r = await user.req("PATCH", "/api/entities/mother", { role: "applicant" });
    assertEquals(r.status, 200, r.text);
    assertEquals(await docAuthor(s(), "D002"), "applicant");
    assertEquals(s().settings.userRole, "applicant");
    assertEquals((await user.get("/api/docs/D002")).json.author, "applicant");
    assert(await ownStatementOnly(s(), refs), "the renamed author still matches the user's role");
    // Another author's rename leaves the others alone.
    await user.req("PATCH", "/api/entities/father", { role: "respondent" });
    assertEquals(await docAuthor(s(), "D001"), "respondent");
    assertEquals(await docAuthor(s(), "D002"), "applicant");

    // Removed from who's who: dropped, so a new entry given the same role doesn't inherit it.
    s().registry.remove("respondent");
    await s().saveRegistry();
    assertEquals(await docAuthor(s(), "D001"), null);
    s().registry.add({ role: "respondent", kind: "person", full: "Someone Else" });
    await s().saveRegistry();
    assertEquals(await docAuthor(s(), "D001"), null);
    assertEquals(await docAuthor(s(), "D002"), "applicant");
    // The user's own role likewise.
    s().registry.remove("applicant");
    await s().saveRegistry();
    assertEquals(s().settings.userRole, undefined);
    assertFalse(await ownStatementOnly(s(), refs));
  } finally {
    state.lock();
  }
});

Deno.test("a switch to a consumer plan keeps a shared document's details in the vault; sharing again restores them", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  try {
    assertEquals(
      (await user.post("/api/plan", { setup: "commercial", conditions: ALL_CONDITIONS })).status,
      200,
    );
    const { id } = await importAndPublish(user, {
      title: "Letter from the other side",
      text: "We act for the father. Please confirm the changeover time.",
      origin: "other_side",
    });
    assertEquals((await user.post(`/api/docs/${id}/share`, {})).status, 200);
    s().store.setDocumentMeta(id, { doc_type: "letter", doc_date: "2025-09-28" }, "claude");
    s().store.addTag(id, "changeovers", "user");
    s().store.addTag(id, "threatening", "claude");

    const sw = await user.post("/api/plan", { setup: "consumer" });
    assertEquals(sw.status, 200, sw.text);
    assertEquals(sw.json.withdrawn, [id]);
    // Claude has nothing: no text, no details, no tags.
    const row = s().store.getDocument(id);
    assertEquals([row.body, row.doc_type, row.doc_date], [null, null, null]);
    assertEquals(s().store.tagsFor(id), []);
    const pub = publicText(state);
    assertFalse(pub.includes("threatening"), "a tag of a withheld document is in public.db");
    assertFalse(pub.includes("2025-09-28"));
    // The user still sees them, kept for later.
    const listed = (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === id);
    assertEquals([listed.doc_type, listed.doc_date, listed.detailsHeld], [
      "letter",
      "2025-09-28",
      true,
    ]);

    // Back on a commercial plan, the user shares it again: its details come back.
    await user.post("/api/plan", { setup: "commercial", conditions: ALL_CONDITIONS });
    assertEquals(s().store.getDocument(id).doc_type, null, "not shared again by the switch alone");
    assertEquals((await user.post(`/api/docs/${id}/share`, {})).status, 200);
    const again = s().store.getDocument(id);
    assertEquals([again.doc_type, again.doc_date, again.meta_by], [
      "letter",
      "2025-09-28",
      "claude",
    ]);
    assertEquals(s().store.tagsFor(id), ["changeovers", "threatening"]);
    assertEquals((await s().getDoc(id)).heldDetails, null);
  } finally {
    state.lock();
  }
});

Deno.test("an exposure keeps the document's details in the vault; the re-check that shares it restores them", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  try {
    await seedCanon(s(), { omitAliases: ["Annie"] });
    const shared = await importAndPublish(user, {
      title: "Letter",
      text: "Our client says Annie refused the changeover.",
    });
    const id = shared.id;
    s().store.setDocumentMeta(id, { doc_type: "letter", doc_date: "2025-09-28" }, "claude");
    s().store.addTag(id, "refusal", "claude");

    const mother = s().registry.get("mother")!;
    const r = await user.req("PATCH", "/api/entities/mother", {
      aliases: ["Annie", ...mother.aliases],
    });
    assertEquals(r.status, 200, r.text);
    assertEquals((await user.get("/api/exposures")).json[0].doc, id);

    // Withdrawn: Claude sees no text, details or tags; the user still sees the details.
    const row = s().store.getDocument(id);
    assertEquals([row.body, row.doc_type, row.doc_date], [null, null, null]);
    assertEquals(s().store.tagsFor(id), []);
    const pub = publicText(state);
    assertFalse(pub.includes("refusal"));
    assertFalse(pub.includes("2025-09-28"));
    const listed = (await user.get("/api/docs")).json.find((d: { id: string }) => d.id === id);
    assertEquals([listed.doc_type, listed.detailsHeld], ["letter", true]);

    // Re-checked and shared again ("Annie" now replaced): the details are back.
    const re = await user.post("/api/docs/recheck", { docs: [id] });
    assertEquals(re.json.results[0].state, "shared", re.text);
    assertEquals(s().store.getDocument(id).doc_type, "letter");
    assertEquals(s().store.tagsFor(id), ["refusal"]);
    assertEquals((await s().getDoc(id)).heldDetails, null);
  } finally {
    state.lock();
  }
});

Deno.test("affidavit headings follow a rename (the export still names and protects the deponent) and drop a removed role", async () => {
  const { state, user } = await withCase({ detectorFactory: () => [] });
  const s = () => state.session!;
  try {
    await seedCanon(s());
    const draft = await userCreateDraft(s(), "affidavit", "Affidavit");
    await setDraftHeading(s(), draft, {
      deponent: "mother",
      applicant: "mother",
      respondent: "father",
      address: "c/o a PO box",
      oath: "affirmed",
    });
    const exp = (q = "") => user.get(`/api/drafts/${draft}/export?format=text${q}`);
    const r0 = await exp();
    assertEquals(r0.status, 409, r0.text);
    assertEquals(r0.json.addresses, [
      { label: "heading", person: "mother", kind: "address", via: "heading" },
    ]);

    assertEquals(
      (await user.req("PATCH", "/api/entities/mother", { role: "applicant" })).status,
      200,
    );
    const h = (await getDraftHeading(s(), draft))!;
    assertEquals([h.deponent, h.applicant, h.respondent], ["applicant", "applicant", "father"]);
    // The safety warning still fires for the renamed deponent.
    const r1 = await exp();
    assertEquals(r1.status, 409, r1.text);
    assertEquals(r1.json.addresses, [
      { label: "heading", person: "applicant", kind: "address", via: "heading" },
    ]);
    // And the export names her, not "[full name]".
    const ok = await exp("&confirmSafety=1");
    assertEquals(ok.status, 200, ok.text);
    assert(ok.text.includes("I, Anna Thornbury, of c/o a PO box"), ok.text);
    assert(ok.text.includes("Applicant: Anna Thornbury"));
    assert(ok.text.includes("Respondent: Daniel Okafor"));

    // A removed role is cleared, so it can't attach to whoever is next given that role.
    s().registry.remove("father");
    await s().saveRegistry();
    s().registry.add({ role: "father", kind: "person", full: "Someone Else" });
    await s().saveRegistry();
    assertEquals((await getDraftHeading(s(), draft))!.respondent, null);
    assertEquals((await getDraftHeading(s(), draft))!.deponent, "applicant");
  } finally {
    state.lock();
  }
});

Deno.test("exposure records follow a rename", async () => {
  const { state, user } = await withCase();
  const s = () => state.session!;
  try {
    await seedCanon(s(), { omitAliases: ["Annie"] });
    const { id } = await importAndPublish(user, {
      title: "Letter",
      text: "Our client says Annie refused the changeover.",
    });
    const mother = s().registry.get("mother")!;
    await user.req("PATCH", "/api/entities/mother", { aliases: ["Annie", ...mother.aliases] });
    await user.req("PATCH", "/api/entities/mother", { role: "applicant" });
    const ex = (await user.get("/api/exposures")).json;
    assertEquals(ex[0].doc, id);
    assertEquals(ex[0].roles, ["applicant"]);
    assertEquals(ex[0].trigger.role, "applicant");
    assertEquals((await s().getDoc(id)).exposure!.roles, ["applicant"]);
  } finally {
    state.lock();
  }
});
