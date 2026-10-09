/**
 * Wave 0 contracts on a CANON case (docs/rebuild/CANON.md): the canonical fixture, origin
 * read-normalisation, rich re-identification, vault files and new ledger kinds.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { CaseSession, isRestricted, normaliseStoredDoc } from "../src/core/session.ts";
import { paragraphState } from "../src/core/drafting.ts";
import { listExposures } from "../src/core/exposure.ts";
import { withheldReason } from "../src/core/origin.ts";
import { checkClaim, splitSentences } from "../src/core/claimcheck.ts";
import { courtSummary, toCheck } from "../src/core/summary.ts";
import { CANON_ENTITIES, D001_LINES, D002_LINES, seedCanon } from "./fixtures/canon.ts";
import { PASS } from "./fixtures/case.ts";
import { SECRETS, tempDir } from "./fixtures/synthetic.ts";
import { importAndPublish, withCase } from "./helpers/app.ts";

async function canonCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  await seedCanon(s);
  return { s, dir };
}

Deno.test("seedCanon shares D001 (7 lines) and D002 (line 9 exact) with names replaced", async () => {
  const { s } = await canonCase();
  assertEquals(D001_LINES.length, 7);
  assertEquals(
    D002_LINES[8],
    "4. On 14 March 2025 Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.",
  );
  const d1 = s.store.getLines("D001");
  assertEquals(d1.length, 7);
  assertEquals(
    s.reidentify(d1.map((l) => l.text).join("\n")).text,
    D001_LINES.join("\n"),
  );
  const line9 = s.store.getLines("D002", 9, 9)[0].text;
  assertEquals(
    line9,
    "4. On 14 March 2025 {{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.",
  );
  assertEquals(s.reidentify(line9).text, D002_LINES[8]);
  const all = JSON.stringify(s.store.db.prepare("SELECT * FROM lines").all());
  for (const secret of SECRETS) assert(!all.includes(secret), secret);
  assertEquals(s.registry.list().length, CANON_ENTITIES.length);
  assertEquals(s.registry.get("mother")?.safety, true);
  s.close();
});

Deno.test("reidentifyRich adds each entity's kind and colour slot", async () => {
  const { s } = await canonCase();
  const r = s.reidentifyRich("{{mother.first}} and {{school}} and {{ghost}}");
  assertEquals(r.text, s.reidentify("{{mother.first}} and {{school}} and {{ghost}}").text);
  assertEquals(r.segs, [
    { t: "Anna", role: "mother", form: "first", kind: "person", colour: 0 },
    { t: " and " },
    { t: "Kiama Downs Public School", role: "school", form: "full", kind: "school", colour: null },
    { t: " and " },
    { t: "{{ghost}}", unknown: true, raw: "{{ghost}}" },
  ]);
  s.close();
});

Deno.test("a vault document saved with a sensitivity is read with an origin", async () => {
  const { s, dir } = await canonCase();
  const doc = await s.getDoc("D001");
  // As a pre-v4 build saved it.
  const legacy: Record<string, unknown> = { ...doc, sensitivity: "subpoena" };
  delete legacy.origin;
  await s.vault.writeJson(s.docName("D001"), legacy);
  s.close();
  const s2 = await CaseSession.open(dir, PASS); // reconciles public.db with the vault
  const read = await s2.getDoc("D001");
  assertEquals(read.origin, "court_or_subpoena");
  assert(!("sensitivity" in read));
  assertEquals((await s2.listDocs()).find((d) => d.id === "D001")?.origin, "court_or_subpoena");
  const row = s2.store.getDocument("D001");
  assertEquals([row.withheld, row.withheld_reason, row.sensitivity], [
    1,
    "origin",
    "court_or_subpoena",
  ]);
  assertEquals(row.title, "[withheld: subpoena material]");
  s2.close();
  assertEquals(normaliseStoredDoc({ origin: undefined }).origin, null);
  for (const o of [null, "other_side", "not_sure", "garbage"]) {
    assert(isRestricted(o as never), String(o));
  }
  assert(!isRestricted("mine"));
});

Deno.test("the API takes and gives origin only: legacy sensitivity values are refused", async () => {
  const { state, user } = await withCase();
  try {
    const a = await importAndPublish(user, {
      title: "Note",
      text: "A plain note.",
      origin: "other_side",
    });
    assertEquals(a.publish.withheld, true);
    // The pre-v4 value set is no longer accepted as input (W3-4), nor is `sensitivity`.
    for (const legacy of ["none", "discovery", "subpoena", "suppression", "restricted"]) {
      const r = await user.post("/api/docs/import", { title: "x", text: "y", origin: legacy });
      assertEquals(r.status, 400, legacy);
    }
    const ignored = await user.post("/api/docs/import", {
      title: "Old client",
      text: "A note.",
      sensitivity: "none",
    });
    assertEquals(ignored.status, 200);
    assertEquals(ignored.json.origin, null, "sensitivity is ignored: not asked yet");
    assertEquals((await user.req("DELETE", `/api/docs/${ignored.json.id}`)).status, 200);
    const b = await importAndPublish(user, {
      title: "Note 2",
      text: "Another note.",
      origin: "mine",
    });
    assertEquals(b.publish.withheld, false);
    const list = (await user.get("/api/docs")).json;
    assertEquals(list.map((d: { origin: string }) => d.origin), ["other_side", "mine"]);
    assert(list.every((d: Record<string, unknown>) => !("sensitivity" in d)));
    assertEquals(
      (await user.put(`/api/docs/${b.id}/origin`, { origin: "suppression" })).status,
      400,
    );
    assertEquals(
      (await user.put(`/api/docs/${b.id}/origin`, { origin: "under_order" })).status,
      200,
    );
    assertEquals((await user.get(`/api/docs/${b.id}`)).json.origin, "under_order");
    assertEquals((await user.put(`/api/docs/${b.id}/origin`, { origin: "mine" })).status, 200);
    const detail = (await user.get(`/api/docs/${b.id}`)).json;
    assert(!("sensitivity" in detail));
    assert(!("sensitivity" in (await user.get(`/api/docs/${b.id}/review`)).json));
    assertEquals(
      (await user.post(`/api/docs/${b.id}/sensitivity`, { origin: "mine" })).status,
      404,
    );
    const doc = (await user.get(`/api/docs/${b.id}`)).json;
    assertEquals(doc.lines[0].text, "Another note.");
    // show() adds segments; quote() lines carry them too.
    const iss = await user.post("/api/issues", { title: "Changeovers" });
    await user.post(`/api/issues/${iss.json.id}/evidence`, { source: `${b.id}:1` });
    const issue = (await user.get("/api/issues")).json[0];
    assertEquals(issue.title, {
      text: "Changeovers",
      segs: [{ t: "Changeovers" }],
      unknown: [],
      malformed: [],
    });
    assertEquals(issue.evidence[0].quote, [{
      line: 1,
      text: "Another note.",
      segs: [{ t: "Another note." }],
    }]);
  } finally {
    state.lock();
  }
});

Deno.test("feature vault files are queued; the session's own files are refused", async () => {
  const { s } = await canonCase();
  assertEquals(await s.readVaultJson("exposures", []), []);
  assertEquals(await listExposures(s), []);
  await Promise.all([1, 2, 3].map((n) => s.writeVaultJson("lapsed-checks", { n })));
  assertEquals(await s.readVaultJson("lapsed-checks", {}), { n: 3 });
  for (const name of ["settings", "entities", "attestations", "doc-d001", "log-head"]) {
    await assertRejects(() => s.writeVaultJson(name, {}));
  }
  s.close();
});

Deno.test("plan and rewrite attestations hold while their content is unchanged", async () => {
  const { s, dir } = await canonCase();
  const conditions = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };
  await s.updateSettings({ plan: { setup: "commercial", conditions, at: "2025-09-03" } });
  await s.attest("plan", "current", { setup: "commercial", conditions });
  assert(await s.isAttested("plan", "current", { setup: "commercial", conditions }));
  const draft = s.store.createDraft({ kind: "affidavit", title: "Affidavit" }, "claude");
  const para = s.store.addParagraph(draft, "{{father.first}} was late.", "claude");
  const content = { id: para, draft_id: draft, body: "{{father.first}} was late." };
  await s.attest("rewrite", para, content);
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_rewritten");
  await s.settled();
  s.close();
  // On open, both still hold; a changed plan prunes the plan entry.
  const s2 = await CaseSession.open(dir, PASS);
  assert(await s2.isAttested("rewrite", para, content));
  assert(await s2.isAttested("plan", "current", { setup: "commercial", conditions }));
  await s2.updateSettings({ plan: { setup: "consumer", at: "2025-10-01" } });
  await s2.settled();
  s2.close();
  const s3 = await CaseSession.open(dir, PASS);
  assert(!(await s3.isAttested("plan", "current", { setup: "commercial", conditions })));
  s3.close();
});

Deno.test("wave 0 stubs answer safely", async () => {
  const { s } = await canonCase();
  assertEquals(
    checkClaim("", [{
      ref: { doc_id: "D001", line_start: 1, line_end: 1 },
      lines: [{ line: 1, text: "x" }],
    }], new Map()),
    [],
  );
  assertEquals(splitSentences(""), []);
  assertEquals(withheldReason(null, "commercial", true), "not_asked");
  assertEquals(withheldReason("other_side", "consumer", false), "origin");
  assertEquals(withheldReason("mine", "consumer", false), null);
  assertEquals((await toCheck(s)).total, 0);
  assertEquals((await courtSummary(s)).figures.open.total, 0); // filled in by W1-H
  s.close();
});
