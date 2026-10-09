import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ProposedSpan } from "../src/core/detect/pipeline.ts";
import {
  type AdoptionAttestation,
  adoptParagraph,
  ExportBlockedError,
  ExportNeedsConfirmError,
  paragraphState,
  unadoptParagraph,
  userAddParagraph,
  userCreateDraft,
  userEditParagraph,
} from "../src/core/drafting.ts";
import { exportDraftFile } from "../src/core/export/draft.ts";
import { InvalidInputError } from "../src/core/publicdb.ts";
import { CaseSession, type PublishRequest } from "../src/core/session.ts";
import {
  AFFIDAVIT,
  AFFIDAVIT_TITLE,
  FAKE_NER_NAMES,
  FakeNameDetector,
  PEOPLE,
  SECRETS,
  tempDir,
} from "./fixtures/synthetic.ts";

const PASS = "a long test passphrase";
const ATTEST: AdoptionAttestation = { ownKnowledge: true, ownWords: true };

/** A case with the synthetic affidavit published, "Mr Okafor" resolved to the father. */
async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  s.detectors = [new FakeNameDetector(FAKE_NER_NAMES)];
  const doc = await s.importText({ origin: "mine", title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const { request, unresolved } = s.defaultPublishRequest(doc);
  const fatherKey = doc.newEntities.find((n) => n.full === PEOPLE.father)?.key;
  const resolved = unresolved.map((sp: ProposedSpan) => {
    if (sp.proposal.type !== "ambiguous") throw new Error("not ambiguous");
    const opt = sp.proposal.options.find((o) => o.ref === fatherKey || o.ref === "father")!;
    return { start: sp.start, end: sp.end, ref: opt.ref, form: opt.form };
  });
  const req: PublishRequest = {
    ...request,
    replacements: [...request.replacements, ...resolved],
  };
  await s.publish(doc.id, req);
  return { dir, s };
}

const CLAUDE_TEXT =
  "On 14 March 2025 {{father.first}} collected the children 90 minutes late from {{school}}.";

function claudeDraft(s: CaseSession, kind: "affidavit" | "outline" = "affidavit") {
  const draft = s.store.createDraft({ kind, title: "Affidavit of {{mother}}" }, "claude");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  return { draft, para };
}

function paragraphText(s: CaseSession): string {
  return s.store.db.prepare("SELECT body, claude_body FROM paragraphs").all()
    .map((r) => `${r.body} ${r.claude_body ?? ""}`).join("\n") +
    s.store.listDrafts().map((d) => d.title).join("\n");
}

Deno.test("a user edit with real names is stored tokenised", async () => {
  const { s } = await newCase();
  const draft = await userCreateDraft(s, "affidavit", `Affidavit of ${PEOPLE.mother}`);
  assertEquals(s.store.getDraft(draft).title, "Affidavit of {{mother}}");
  const id = await userAddParagraph(s, draft, `I am the mother of ${PEOPLE.child1}.`);
  assertEquals(s.store.getParagraph(id).body, "I am the mother of {{child_1}}.");
  assertEquals(s.store.getParagraph(id).author, "user");
  await userEditParagraph(s, id, `${PEOPLE.father} is the father of ${PEOPLE.child2}.`);
  const p = s.store.getParagraph(id);
  assertEquals(p.body, "{{father}} is the father of {{child_2}}.");
  assertEquals(p.author, "user");
  const stored = paragraphText(s);
  for (const secret of SECRETS) assert(!stored.includes(secret), `"${secret}" stored in drafts`);
  assertEquals(await paragraphState(s, p), "user");
  // An identifier the registry does not know as a name is still refused.
  await assertRejects(
    () => userAddParagraph(s, draft, "Call me on 0498 765 432."),
    InvalidInputError,
  );
  s.close();
});

Deno.test("a user edit of Claude's paragraph, light or heavy, leaves it drafted by Claude", async () => {
  const { s } = await newCase();
  const { para } = claudeDraft(s);
  // Light edit: one word changed, real names typed.
  const light = await userEditParagraph(
    s,
    para,
    "On 14 March 2025 Daniel collected the children 95 minutes late from " +
      `${PEOPLE.school}.`,
  );
  assert(!("similarity" in light), "similarity no longer reported");
  assertEquals(light.state, "claude_rewritten");
  let p = s.store.getParagraph(para);
  assertEquals(p.author, "claude");
  assertEquals(p.claude_body, CLAUDE_TEXT, "Claude's original text is kept");
  assert(p.body.includes("95 minutes") && p.body.includes("{{father.first}}"));
  assertEquals(await paragraphState(s, p), "claude_rewritten");

  // Heavy rewrite in the user's own words: still Claude's draft, rewritten by the user.
  const heavy = await userEditParagraph(
    s,
    para,
    "That Friday I waited at the school gate with both kids until half past four, because " +
      `${PEOPLE.father} did not turn up when he said he would.`,
  );
  assertEquals(heavy.state, "claude_rewritten");
  p = s.store.getParagraph(para);
  assertEquals(p.author, "claude");
  assertEquals(p.claude_body, CLAUDE_TEXT);
  assertEquals(await paragraphState(s, p), "claude_rewritten");
  const log = s.store.listLog(20).filter((l) => l.action === "paragraph_edited");
  assertEquals(log.length, 2);
  for (const l of log) {
    const d = JSON.parse(l.detail);
    assertEquals([d.author_after, d.state], ["claude", "claude_rewritten"]);
    assertEquals(d.similarity, undefined);
  }
  s.close();
});

Deno.test("rewriting every word of Claude's paragraph still needs adopting", async () => {
  const { s } = await newCase();
  const draft = s.store.createDraft({ kind: "affidavit", title: "A" }, "claude");
  const para = s.store.addParagraph(draft, "a b c d e f g h i j", "claude");
  const r = await userEditParagraph(s, para, "k l m n o p q r s t");
  assertEquals(r.state, "claude_rewritten");
  assertEquals(s.store.getParagraph(para).author, "claude");
  const err = await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  assertEquals(err.needsReview, [para]);
  const shown = await s.itemVersion("paragraph", s.store.getParagraph(para));
  await adoptParagraph(s, para, ATTEST, { version: shown });
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_adopted");
  await exportDraftFile(s, draft, "text");
  // Withdrawing the adoption goes back to "rewritten by you", not "needs you".
  await unadoptParagraph(s, para);
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_rewritten");
  s.close();
});

Deno.test("the user editing their own paragraph keeps it theirs", async () => {
  const { s } = await newCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const id = await userAddParagraph(s, draft, "My words.");
  const r = await userEditParagraph(s, id, "My better words.");
  assertEquals(r.state, "user");
  assertEquals(await paragraphState(s, s.store.getParagraph(id)), "user");
  s.close();
});

Deno.test("adoption needs both attestations and only applies to Claude's paragraphs", async () => {
  const { s } = await newCase();
  const { draft, para } = claudeDraft(s);
  for (
    const bad of [
      {},
      { ownKnowledge: true },
      { ownWords: true },
      { ownKnowledge: true, ownWords: "yes" },
      { ownKnowledge: 1, ownWords: true },
      null,
    ]
  ) {
    await assertRejects(
      () => adoptParagraph(s, para, bad as unknown as AdoptionAttestation),
      InvalidInputError,
    );
  }
  assertEquals(s.store.getParagraph(para).adopted_at, null);
  const mine = await userAddParagraph(s, draft, "My own words.");
  await assertRejects(() => adoptParagraph(s, mine, ATTEST), InvalidInputError);

  const p = await adoptParagraph(s, para, ATTEST);
  assert(p.adopted_at && p.adopted_sig);
  assertEquals(await paragraphState(s, p), "claude_adopted");
  const entry = s.store.listLog(5).find((l) => l.action === "paragraph_adopted")!;
  assertEquals(JSON.parse(entry.detail).paragraph, para);

  await unadoptParagraph(s, para);
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
});

Deno.test("adoption stops counting when the text is changed behind the app's back", async () => {
  const { s } = await newCase();
  const { para } = claudeDraft(s);
  await adoptParagraph(s, para, ATTEST);
  s.store.db.prepare("UPDATE paragraphs SET body = ? WHERE id = ?").run(
    "{{father.first}} was never late.",
    para,
  );
  const p = s.store.getParagraph(para);
  assert(p.adopted_at !== null, "the stored flag is still set");
  assertEquals(await paragraphState(s, p), "claude_needs_you");
  s.close();
});

Deno.test("a forged adoption is not an adoption", async () => {
  const { s } = await newCase();
  const { para } = claudeDraft(s);
  s.store.setParagraphAdoption(para, new Date().toISOString(), "0".repeat(64));
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
});

Deno.test("Claude editing an adopted paragraph clears the adoption", async () => {
  const { s } = await newCase();
  const { para } = claudeDraft(s);
  await adoptParagraph(s, para, ATTEST);
  s.store.updateParagraph(para, "{{father.first}} was a little late.", "claude");
  const p = s.store.getParagraph(para);
  assertEquals(p.adopted_at, null);
  assertEquals(await paragraphState(s, p), "claude_needs_you");
  s.close();
});

/** The heading and jurat of an affidavit exported with no heading saved (placeholders). */
const BLANK_HEADING_MD = [
  "FEDERAL CIRCUIT AND FAMILY COURT OF AUSTRALIA [check against the Court's current form]",
  "File number: [file number]",
  "Applicant: [applicant]",
  "Respondent: [respondent]",
  "I, [full name], of [address], [occupation], [make oath / affirm] and say:",
].join("  \n");
const BLANK_JURAT_MD = [
  "Sworn / affirmed by the deponent at [place] on [date] [check against the Court's current form]",
  "Signature of deponent: ____________________",
  "Before me: ____________________ [name and qualification of witness]",
].join("  \n");

Deno.test("affidavit export is blocked until every paragraph Claude drafted is adopted", async () => {
  const { s } = await newCase();
  const { draft, para: c1 } = claudeDraft(s);
  const u1 = await userAddParagraph(s, draft, `I am the mother of ${PEOPLE.child1}.`, undefined);
  const c2 = s.store.addParagraph(
    draft,
    "{{child_1.first}} was upset when she got home.",
    "claude",
  );

  const err = await assertRejects(() => exportDraftFile(s, draft, "markdown"), ExportBlockedError);
  assertEquals(err.needsReview, [c1, c2]);
  assertEquals(err.badTokens, []);
  assert(!s.store.listLog(5).some((l) => l.action === "exported"));

  await adoptParagraph(s, c1, ATTEST);
  const err2 = await assertRejects(() => exportDraftFile(s, draft, "markdown"), ExportBlockedError);
  assertEquals(err2.needsReview, [c2]);

  // Rewriting it is not enough (ADR 9 amendment): it still needs adopting.
  await userEditParagraph(
    s,
    c2,
    `${PEOPLE.child1} cried all the way home and would not eat dinner.`,
  );
  const err3 = await assertRejects(() => exportDraftFile(s, draft, "markdown"), ExportBlockedError);
  assertEquals(err3.needsReview, [c2]);
  await adoptParagraph(s, c2, ATTEST);

  const now = new Date(2026, 9, 7);
  const out = await exportDraftFile(s, draft, "markdown", { now });
  assertEquals(out.filename, `affidavit-${draft}-2026-10-07.md`);
  assertEquals(
    out.content,
    `# Affidavit of ${PEOPLE.mother}\n\n` +
      `${BLANK_HEADING_MD}\n\n` +
      `1. On 14 March 2025 Daniel collected the children 90 minutes late from ${PEOPLE.school}.\n\n` +
      `2. I am the mother of ${PEOPLE.child1}.\n\n` +
      `3. ${PEOPLE.child1} cried all the way home and would not eat dinner.\n\n` +
      `${BLANK_JURAT_MD}\n`,
  );
  assertEquals(s.store.listParagraphs(draft).map((p) => p.id), [c1, u1, c2]);

  const text = await exportDraftFile(s, draft, "text", { now });
  assertEquals(text.filename, `affidavit-${draft}-2026-10-07.txt`);
  assert(text.content.startsWith(`Affidavit of ${PEOPLE.mother}\n\nFEDERAL CIRCUIT`));
  assert(text.content.includes("\n\n1. On 14 March"));

  const exported = s.store.listLog(5).find((l) => l.action === "exported")!;
  const detail = JSON.parse(exported.detail);
  assertEquals([detail.by_user, detail.claude_adopted], [1, 2]);
  for (const secret of SECRETS) assert(!exported.detail.includes(secret));
  s.close();
});

Deno.test("export filenames never contain names and nothing is written to the case folder", async () => {
  const { dir, s } = await newCase();
  const draft = await userCreateDraft(s, "letter", `Letter to ${PEOPLE.father}`);
  await userAddParagraph(s, draft, `Dear ${PEOPLE.father},`);
  const before = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
  const out = await exportDraftFile(s, draft, "text");
  assert(out.content.includes(PEOPLE.father));
  for (const secret of SECRETS) assert(!out.filename.includes(secret), out.filename);
  assert(/^letter-\d+-\d{4}-\d{2}-\d{2}\.txt$/.test(out.filename), out.filename);
  assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), before);
  s.close();
});

Deno.test("outlines export Claude's paragraphs, unnumbered, once the flags are confirmed", async () => {
  const { s } = await newCase();
  const { draft, para } = claudeDraft(s, "outline");
  await s.recordDraftKinds(); // the app has seen the draft (ADR 9)
  const p2 = s.store.addParagraph(draft, "Second point about {{child_2.first}}.", "claude");
  const err = await assertRejects(
    () => exportDraftFile(s, draft, "markdown"),
    ExportNeedsConfirmError,
  );
  assertEquals(err.flags.map((f) => [f.paragraph, f.n, f.reason]), [
    [para, 1, "needs_you"],
    [p2, 2, "needs_you"],
  ]);
  const out = await exportDraftFile(s, draft, "markdown", { confirm: true });
  assertEquals(
    out.content,
    `# Affidavit of ${PEOPLE.mother}\n\n` +
      `On 14 March 2025 Daniel collected the children 90 minutes late from ${PEOPLE.school}.\n\n` +
      `Second point about Lachlan.\n`,
  );
  const exported = s.store.listLog(5).find((l) => l.action === "exported")!;
  assertEquals(JSON.parse(exported.detail).flags_confirmed, 2);
  s.close();
});

Deno.test("unknown or malformed tokens block export of any draft kind", async () => {
  const { s } = await newCase();
  const { draft } = claudeDraft(s, "outline");
  await s.recordDraftKinds();
  const bad = s.store.addParagraph(draft, "{{grandmother}} said so to {{mothr.", "claude");
  const err = await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  assertEquals(err.needsReview, []);
  assertEquals(err.badTokens, [
    { paragraph: bad, token: "{{grandmother}}", problem: "unknown" },
    { paragraph: bad, token: "{{mothr.", problem: "malformed" },
  ]);
  s.store.renameDraft(draft, "Outline about {{aunt}}");
  s.store.updateParagraph(bad, "Fine now.", "claude");
  const err2 = await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  assertEquals(err2.badTokens, [{ paragraph: null, token: "{{aunt}}", problem: "unknown" }]);
  s.close();
});

Deno.test("multi-line affidavit paragraphs stay inside their number", async () => {
  const { s } = await newCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  await userAddParagraph(s, draft, "First line\nsecond line");
  const md = await exportDraftFile(s, draft, "markdown");
  assert(md.content.includes("\n\n1. First line\n   second line\n\n"), md.content);
  s.close();
});
