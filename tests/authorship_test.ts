/**
 * Authorship without similarity (ADR 9, October 2026 amendment): a paragraph Claude drafted is
 * "Drafted by Claude" for good; a rewrite needs adopting; placeholders block adoption; the
 * affidavit heading lives in the vault; drafts API shapes. CANON case. SYNTHETIC data only.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  type AdoptionAttestation,
  adoptParagraph,
  ExportBlockedError,
  getDraftHeading,
  paragraphState,
  PlaceholderError,
  setDraftHeading,
  setParagraphSources,
  userCreateDraft,
  userEditParagraph,
} from "../src/core/drafting.ts";
import { exportDraftFile } from "../src/core/export/draft.ts";
import { convertCitationsWith } from "../src/core/export/annexures.ts";
import { CaseSession, StaleItemError } from "../src/core/session.ts";
import { InvalidInputError } from "../src/core/publicdb.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { dumpPublic, PASS } from "./fixtures/case.ts";
import { SECRETS, tempDir } from "./fixtures/synthetic.ts";
import { withCase } from "./helpers/app.ts";

const ATTEST: AdoptionAttestation = { ownKnowledge: true, ownWords: true };
const CLAUDE_TEXT =
  "On 14 March 2025 {{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.";

async function canonCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  await seedCanon(s);
  return { s, dir };
}

function sql(s: CaseSession, query: string, ...args: (string | number | null)[]) {
  s.store.db.prepare(query).run(...args);
}

async function version(s: CaseSession, id: number) {
  return await s.itemVersion("paragraph", s.store.getParagraph(id));
}

Deno.test("a complete rewrite of Claude's paragraph stays drafted by Claude and blocks export", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit of Anna Thornbury");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  const r = await userEditParagraph(
    s,
    para,
    "I stood at the gate with the kids until half past four that Friday afternoon.",
  );
  assertEquals(r.state, "claude_rewritten");
  assertEquals(s.store.getParagraph(para).author, "claude");
  const err = await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  assertEquals(err.needsReview, [para]);
  s.close();
});

Deno.test("Claude changing a rewritten paragraph sends it back to needs you, for good", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  const r = await userEditParagraph(s, para, "I waited at the school until half past four.");
  const rewritten = r.paragraph.body;
  // Claude edits the paragraph through the CLI (or SQL).
  s.store.updateParagraph(para, "{{mother}} waited a few minutes.", "claude");
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  // Putting the user's text back does not revive the rewrite record.
  sql(s, "UPDATE paragraphs SET body = ? WHERE id = ?", rewritten, para);
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
});

Deno.test("Claude cannot mark its paragraph rewritten or the user's without the ledger", async () => {
  const { s, dir } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  sql(s, "UPDATE paragraphs SET author = 'user', claude_body = NULL WHERE id = ?", para);
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
  const again = await CaseSession.open(dir, PASS);
  assertEquals(await paragraphState(again, again.store.getParagraph(para)), "claude_needs_you");
  again.close();
});

Deno.test("a paragraph with an [In your own words placeholder cannot be adopted", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(
    draft,
    "{{child_1.first}} was upset. [In your own words: how did she seem to you?]",
    "claude",
  );
  await assertRejects(
    async () => adoptParagraph(s, para, ATTEST, { version: await version(s, para) }),
    PlaceholderError,
  );
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  // A rewrite that keeps the placeholder is still refused, in any letter case.
  await userEditParagraph(s, para, "Mia was upset. [in your own words: more]");
  await assertRejects(() => adoptParagraph(s, para, ATTEST), PlaceholderError);
  const err = await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  assertEquals(err.placeholders, [para]);
  // Filled in, it can be adopted and exported.
  await userEditParagraph(s, para, "Mia was upset and cried at the door.");
  await adoptParagraph(s, para, ATTEST);
  await exportDraftFile(s, draft, "text");
  s.close();
});

Deno.test("fact answers are kept in the vault and only counted in the log", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  await assertRejects(
    () => adoptParagraph(s, para, ATTEST, { facts: [{ text: "x", answer: "maybe" }] }),
    InvalidInputError,
  );
  // One answer per fact, as casefile splits the paragraph (here one sentence).
  await assertRejects(
    () =>
      adoptParagraph(s, para, ATTEST, {
        facts: [{ answer: "saw" }, { answer: "read" }],
      }),
    InvalidInputError,
  );
  // A fact text that is not the one shown: the paragraph changed since (stale).
  await assertRejects(
    () => adoptParagraph(s, para, ATTEST, { facts: [{ text: "Daniel was late", answer: "saw" }] }),
    StaleItemError,
  );
  const facts = [
    {
      text:
        "On 14 March 2025 Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.",
      answer: "saw",
    },
  ];
  await adoptParagraph(s, para, ATTEST, { facts });
  const entry = s.store.listLog(5).find((l) => l.action === "paragraph_adopted")!;
  assertEquals(JSON.parse(entry.detail).facts, { saw: 1, read: 0, unsure: 0 });
  const pub = dumpPublic(s.store);
  for (const secret of SECRETS) assert(!pub.includes(secret), `public.db has "${secret}"`);
  const vault = await s.readVaultJson<Record<string, { facts: unknown[] }>>("adoption-facts", {});
  assertEquals(vault[String(para)].facts, facts);
  s.close();
});

Deno.test("the affidavit heading is kept in the vault only and used in the export", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit of Anna Thornbury");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT + " (D001:1-2)", "claude");
  await assertRejects(() => setDraftHeading(s, draft, { deponent: "aunt" }), InvalidInputError);
  await assertRejects(() => setDraftHeading(s, draft, { oath: "promised" }), InvalidInputError);
  await setDraftHeading(s, draft, {
    fileNumber: "PAC1234/2024",
    deponent: "mother",
    applicant: "mother",
    respondent: "father",
    occupation: "Nurse",
    address: "14 Banksia Crescent, Gerringong NSW 2534",
    oath: "affirmed",
  });
  const after = dumpPublic(s.store);
  for (const v of ["PAC1234", "Nurse", "Banksia"]) assert(!after.includes(v), `public.db has ${v}`);
  assert(after.includes("draft_heading_set"));
  assertEquals((await getDraftHeading(s, draft))?.occupation, "Nurse");

  await adoptParagraph(s, para, ATTEST);
  // The safety-sensitive deponent's address is in the heading: the user confirms it.
  const out = await exportDraftFile(s, draft, "text", { confirmSafety: true });
  assert(out.content.includes("File number: PAC1234/2024"), out.content);
  assert(out.content.includes("Applicant: Anna Thornbury"));
  assert(out.content.includes("Respondent: Daniel Okafor"));
  assert(
    out.content.includes(
      "I, Anna Thornbury, of 14 Banksia Crescent, Gerringong NSW 2534, Nurse, affirm and say:",
    ),
  );
  assert(out.content.includes("(Text messages, March 2025, lines 1–2)"), out.content);
  assert(out.content.includes("Affirmed by the deponent at [place] on [date]"));
  assert(out.content.includes("[check against the Court's current form]"));
  s.close();
});

Deno.test("a heading does not pass to a new draft that reuses a deleted draft's id", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  await setDraftHeading(s, draft, { occupation: "Nurse" });
  sql(s, "DELETE FROM drafts WHERE id = ?", draft); // Claude deletes it
  const again = s.store.createDraft({ kind: "affidavit", title: "Other" }, "claude");
  assertEquals(again, draft);
  sql(s, "UPDATE drafts SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?", again);
  assertEquals(await getDraftHeading(s, again), null);
  s.close();
});

Deno.test("citations convert to the document title and line", async () => {
  const { s } = await canonCase();
  assertEquals(
    await convertCitationsWith(s, "As she said (D001:3) and later (D002:9); not D999:1.", {}),
    "As she said (Text messages, March 2025, line 3) and later " +
      "(Affidavit of Anna Thornbury, line 9); not D999:1.",
  );
  s.close();
});

Deno.test("sources: withheld or missing documents are refused", async () => {
  const { s } = await canonCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  const withheld = await s.importText({
    title: "Subpoena material",
    text: "Some lines\nmore",
    origin: "court_or_subpoena",
  });
  await s.publishWithDefaults(withheld.id);
  await assertRejects(
    () => setParagraphSources(s, para, [{ doc_id: withheld.id, line_start: 1, line_end: 1 }]),
    InvalidInputError,
  );
  await assertRejects(
    () => setParagraphSources(s, para, [{ doc_id: "D001", line_start: 7, line_end: 8 }]),
    InvalidInputError,
  );
  await setParagraphSources(s, para, [{ doc_id: "D001", line_start: 1, line_end: 2 }]);
  assertEquals(s.store.listParagraphSources(para).length, 1);
  // Sources are not part of the adoption, so setting them leaves the state alone.
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
});

// ── API ─────────────────────────────────────────────────────────────────────

Deno.test("drafts API: counts, paragraph states, sources, heading and the export gate", async () => {
  const t = await withCase({ detectorFactory: () => [] });
  const s = t.state.session!;
  await seedCanon(s);
  const { user } = t;
  const d = await user.post("/api/drafts", { kind: "affidavit", title: "Affidavit of Anna" });
  assertEquals(d.status, 200, d.text);
  const draft: number = d.json.id;
  const mine = (await user.post(`/api/drafts/${draft}/paragraphs`, { text: "I am Mia's mother." }))
    .json.id;
  const c1 = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  const c2 = s.store.addParagraph(draft, "[In your own words: what happened next]", "claude");

  const src = await user.put(`/api/paragraphs/${c1}/sources`, {
    sources: ["D001:1-2", "D002:9"],
  });
  assertEquals(src.status, 200, src.text);
  assertEquals(src.json.sources.map((x: { ref: string }) => x.ref), ["D001:1-2", "D002:9"]);
  assertEquals(src.json.sources[0].quote[0].text, D001_LINE_1);
  assertEquals(
    (await user.put(`/api/paragraphs/${c1}/sources`, { sources: ["nonsense"] })).status,
    400,
  );

  const edit = await user.put(`/api/paragraphs/${c1}`, {
    text: "Daniel picked up Mia and Lachlan at half past four.",
  });
  assertEquals(edit.json, {
    ok: true,
    author: "claude",
    state: "claude_rewritten",
  });

  const view = (await user.get(`/api/drafts/${draft}`)).json;
  assertEquals(
    view.paragraphs.map((p: { n: number; state: string; draftedByClaude: boolean }) => [
      p.n,
      p.state,
      p.draftedByClaude,
    ]),
    [[1, "user", false], [2, "claude_rewritten", true], [3, "claude_needs_you", true]],
  );
  assertEquals(view.paragraphs[0].id, mine);
  assert(!("status" in view.paragraphs[1]), "the legacy three-value status is gone");
  assertEquals(view.paragraphs[2].hasPlaceholder, true);
  assertEquals(
    view.paragraphs[1].claude_body,
    "On 14 March 2025 Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.",
  );
  assertEquals(view.counts, { user: 1, needsYou: 1, rewritten: 1, adopted: 0 });
  assertEquals(view.heading, null);
  assertEquals(view.exportCheck.ready, false);
  assertEquals(
    view.exportCheck.blockers.map((b: { paragraph: number; reason: string }) => [
      b.paragraph,
      b.reason,
    ]),
    [[c1, "rewritten"], [c2, "needs_you"], [c2, "placeholder"]],
  );

  const list = (await user.get("/api/drafts")).json;
  assertEquals(list[0].counts, { user: 1, needsYou: 1, rewritten: 1, adopted: 0 });
  // casefile's checks (W1-C claimcheck): Lachlan is not in D001:1–2, only in D002:9; and ¶3
  // still has its placeholder.
  assertEquals([list[0].factsToCheck, list[0].exportReady], [2, false]);

  const blocked = await user.get(`/api/drafts/${draft}/export`);
  assertEquals(blocked.status, 409);
  assertEquals(blocked.json.needsReview, [c1, c2]);
  assertEquals(blocked.json.placeholders, [c2]);

  const p2 = view.paragraphs[1];
  const adopt = await user.post(`/api/paragraphs/${c1}/adopt`, {
    ownKnowledge: true,
    ownWords: true,
    version: p2.version,
    facts: [{ text: "Daniel picked up Mia and Lachlan at half past four.", answer: "saw" }],
  });
  assertEquals(adopt.status, 200, adopt.text);
  const p3 = view.paragraphs[2];
  const refused = await user.post(`/api/paragraphs/${c2}/adopt`, {
    ownKnowledge: true,
    ownWords: true,
    version: p3.version,
  });
  assertEquals(refused.status, 400);
  assertEquals(refused.json.placeholder, true);
  await user.req("DELETE", `/api/paragraphs/${c2}`);

  const h = await user.put(`/api/drafts/${draft}/heading`, { deponent: "mother", oath: "sworn" });
  assertEquals(h.status, 200, h.text);
  assertEquals(h.json.heading.deponent, "mother");
  assertEquals(
    (await user.put(`/api/drafts/${draft}/heading`, { applicant: "nobody" })).status,
    400,
  );

  const ok = await user.get(`/api/drafts/${draft}/export?format=text`);
  assertEquals(ok.status, 200, ok.text);
  assert(ok.text.includes("I, Anna Thornbury, of [address], [occupation], make oath and say:"));
  assert(ok.text.includes("1. I am Mia's mother."));
  assert(ok.text.includes("Sworn by the deponent"));

  // Deleting the draft drops its heading from the vault.
  assertEquals((await user.req("DELETE", `/api/drafts/${draft}`)).status, 200);
  assertEquals(await s.readVaultJson(`draft-heading-${draft}`, null), null);
});

Deno.test("drafts API: outlines export with flags only after ?confirm=1", async () => {
  const t = await withCase({ detectorFactory: () => [] });
  const s = t.state.session!;
  await seedCanon(s);
  const d = (await t.user.post("/api/drafts", { kind: "outline", title: "Outline" })).json.id;
  const c = s.store.addParagraph(d, CLAUDE_TEXT, "claude");
  const r = await t.user.get(`/api/drafts/${d}/export`);
  assertEquals(r.status, 409);
  assertEquals(r.json.needsConfirm, true);
  assertEquals(r.json.flags, [{
    paragraph: c,
    n: 1,
    reason: "needs_you",
    message: "Drafted by Claude — needs you",
  }]);
  const ok = await t.user.get(`/api/drafts/${d}/export?confirm=1`);
  assertEquals(ok.status, 200, ok.text);
  assert(ok.text.includes("Kiama Downs Public School"));
});

const D001_LINE_1 =
  "14/03/2025 3:05pm Anna: Where are you? Mia has been waiting at school since 3.";
