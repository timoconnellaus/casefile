/**
 * "My affidavit sworn [date], para 4" citations (ADR 0027, PLAN deferred list): the user records in
 * the app that a document is an affidavit they swore or affirmed, and on export, inside the app,
 * a citation of it becomes "my affidavit sworn 2 April 2025, para 4". The record is vault only;
 * nothing Claude can write decides it. CANON case, SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EARLIER_AFFIDAVITS_FILE,
  getEarlierAffidavit,
  paragraphOfLine,
  paragraphsOf,
} from "../src/core/export/affidavits.ts";
import { docxToText } from "../src/core/export/docx.ts";
import { adoptParagraph, setDraftHeading, userCreateDraft } from "../src/core/drafting.ts";
import type { CaseSession } from "../src/core/session.ts";
import { D002_LINES, seedCanon } from "./fixtures/canon.ts";
import { dumpPublic } from "./fixtures/case.ts";
import { withCase } from "./helpers/app.ts";
import { cli, seedCanonWork } from "./helpers/canon_work.ts";

const D002 = D002_LINES.join("\n");

Deno.test("paragraph numbers come from the numbered paragraph a line is in", () => {
  // CANON D002: lines 1-5 are the heading (two blank), lines 6-12 are paragraphs 1-7.
  assertEquals(paragraphOfLine(D002, 9), 4);
  assertEquals(paragraphOfLine(D002, 6), 1);
  assertEquals(paragraphOfLine(D002, 12), 7);
  for (const heading of [1, 2, 3, 4, 5]) assertEquals(paragraphOfLine(D002, heading), null);
  assertEquals(paragraphOfLine(D002, 0), null);
  assertEquals(paragraphOfLine(D002, 13), null);
  assertEquals(paragraphsOf(D002, 9, 9), "para 4");
  assertEquals(paragraphsOf(D002, 9, 10), "paras 4–5");
  assertEquals(paragraphsOf(D002, 4, 9), null, "a range that starts in the heading");

  // A paragraph wrapped over several lines (as PDF import gives), then a gap and the jurat.
  const wrapped = [
    "AFFIDAVIT",
    "",
    "1. I am the mother of the",
    "children.",
    "2) We separated in June",
    "2023 and I moved out.",
    "(3) I say this.",
    "",
    "Sworn at Wollongong on 2 April 2025",
  ].join("\n");
  assertEquals(paragraphOfLine(wrapped, 4), 1);
  assertEquals(paragraphOfLine(wrapped, 6), 2);
  assertEquals(paragraphOfLine(wrapped, 7), 3);
  assertEquals(paragraphsOf(wrapped, 3, 7), "paras 1–3");
  assertEquals(paragraphOfLine(wrapped, 9), null, "the jurat is not a paragraph");
  // A date at the start of a line is not a paragraph number.
  assertEquals(paragraphOfLine("14 March 2025 we met.", 1), null);
});

// ── the CANON affidavit draft ───────────────────────────────────────────────

const CLAUDE_PARA =
  "On 14 March 2025 {{father.first}} collected {{child_1.first}} late (D001:1-2), as I said " +
  "before (D002:9).";

async function canonDraft() {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanon(s);
  const draft = await userCreateDraft(s, "affidavit", "Affidavit of Anna Thornbury");
  const para = s.store.addParagraph(draft, CLAUDE_PARA, "claude");
  await adoptParagraph(s, para, { ownKnowledge: true, ownWords: true });
  // CANON: the user is the mother, and the draft is her affidavit.
  await s.updateSettings({ userRole: "mother" });
  await setDraftHeading(s, draft, { deponent: "mother", oath: "affirmed" });
  return { ...t, s, draft, para };
}

function lastLog(s: CaseSession, action: string) {
  const row = s.store.listLog(50).find((l) => l.action === action);
  assert(row, `no ${action} row`);
  return JSON.parse(row.detail);
}

const TITLE_FORM = "as I said before (Affidavit of Anna Thornbury, line 9).";
const MY_FORM = "as I said before (my affidavit sworn 2 April 2025, para 4).";

Deno.test('a citation of the deponent\'s earlier affidavit becomes "my affidavit sworn [date], para 4"', async () => {
  const { user, s, draft } = await canonDraft();
  const text = async () => {
    const r = await user.get(`/api/drafts/${draft}/export?format=text`);
    assertEquals(r.status, 200, r.text);
    return r.text;
  };
  // Nothing recorded: the title and line, as before.
  assertStringIncludes(await text(), TITLE_FORM);

  // The user says D002 is an affidavit she swore on 2 April 2025 (CANON: filed that day).
  const put = await user.put("/api/docs/D002/affidavit", { oath: "sworn", date: "2025-04-02" });
  assertEquals(put.status, 200, put.text);
  assertEquals(put.json.affidavit, { oath: "sworn", date: "2025-04-02" });
  assertEquals((await user.get("/api/docs/D002")).json.affidavit, put.json.affidavit);
  assertEquals(lastLog(s, "earlier_affidavit_set"), { doc: "D002", set: true });
  // Still the title: "my" needs the user's own record that she wrote it.
  assertStringIncludes(await text(), TITLE_FORM);
  assertEquals((await user.put("/api/docs/D002/author", { role: "mother" })).status, 200);

  const out = await text();
  assertStringIncludes(out, MY_FORM);
  // Other documents keep the title form.
  assertStringIncludes(out, "late (Text messages, March 2025, lines 1–2)");
  // Every format says the same.
  const rtf = await user.get(`/api/drafts/${draft}/export?format=rtf`);
  assertStringIncludes(rtf.text, "my affidavit sworn 2 April 2025, para 4");
  const docx = await user.get(`/api/drafts/${draft}/export?format=docx`);
  assertEquals(docx.status, 200, docx.text);
  assertStringIncludes(await docxToText(docx.bytes), MY_FORM);
  assertStringIncludes((await user.get(`/api/drafts/${draft}/export`)).text, MY_FORM);

  // Affirmed reads "affirmed".
  await user.put("/api/docs/D002/affidavit", { oath: "affirmed", date: "2025-04-02" });
  assertStringIncludes(await text(), "(my affidavit affirmed 2 April 2025, para 4)");
  await user.put("/api/docs/D002/affidavit", { oath: "sworn", date: "2025-04-02" });

  // Someone else's affidavit draft: not "my".
  await setDraftHeading(s, draft, { deponent: "father", oath: "sworn" });
  assertStringIncludes(await text(), TITLE_FORM);
  await setDraftHeading(s, draft, { deponent: "mother", oath: "sworn" });

  // An annexure mark the user gave it wins.
  await user.put(`/api/drafts/${draft}/annexures`, { marks: { D002: "AT-2" } });
  assertStringIncludes(await text(), "as I said before (annexure AT-2).");
  await user.put(`/api/drafts/${draft}/annexures`, { marks: {} });

  // A citation of the heading's lines is not a paragraph: the title form.
  await user.post(`/api/drafts/${draft}/paragraphs`, { text: "It begins (D002:1-2)." });
  assertStringIncludes(await text(), "It begins (Affidavit of Anna Thornbury, lines 1–2).");

  // Cleared: back to the title.
  const clear = await user.put("/api/docs/D002/affidavit", { affidavit: null });
  assertEquals(clear.json.affidavit, null);
  assertEquals(lastLog(s, "earlier_affidavit_set"), { doc: "D002", set: false });
  assertStringIncludes(await text(), TITLE_FORM);
});

Deno.test("the record is the vault's: never in public.db, the log or the CLI, and Claude can't forge it", async () => {
  const { user, s, draft } = await canonDraft();
  await user.put("/api/docs/D002/author", { role: "mother" });
  await user.put("/api/docs/D002/affidavit", { oath: "sworn", date: "2025-04-02" });
  const out = await user.get(`/api/drafts/${draft}/export?format=text`);
  assertStringIncludes(out.text, MY_FORM);

  // Not in public.db (where Claude reads), not in the log (counts and ids only).
  const pub = dumpPublic(s.store);
  for (const v of ["2025-04-02", "2 April 2025, para", "my affidavit", EARLIER_AFFIDAVITS_FILE]) {
    assert(!pub.includes(v), `public.db holds ${v}`);
  }
  // Claude's view of D002 through the CLI is unchanged.
  const show = await cli(s, ["docs", "show", "D002", "--lines", "9"]);
  assert(!show.out.includes("sworn 2 April"), show.out);

  // Claude rewrites public.db: line 9 renumbered, the document typed as the father's affidavit.
  s.store.db.prepare("UPDATE lines SET text = ? WHERE doc_id = 'D002' AND line_no = 9").run(
    "77. Something else.",
  );
  s.store.db.prepare(
    "UPDATE documents SET doc_type = 'affidavit', author_role = 'father' WHERE id = 'D002'",
  ).run();
  // The paragraph number still comes from the original in the vault, the author from the vault.
  assertStringIncludes(
    (await user.get(`/api/drafts/${draft}/export?format=text`)).text,
    MY_FORM,
  );

  // A record saved for another document with the same id does not carry over.
  const stored = await s.readVaultJson<Record<string, { docImportedAt: string }>>(
    EARLIER_AFFIDAVITS_FILE,
    {},
  );
  stored.D002.docImportedAt = "2001-01-01T00:00:00.000Z";
  await s.writeVaultJson(EARLIER_AFFIDAVITS_FILE, stored);
  assertEquals(await getEarlierAffidavit(s, "D002"), null);
  assertStringIncludes(
    (await user.get(`/api/drafts/${draft}/export?format=text`)).text,
    TITLE_FORM,
  );
});

Deno.test("recording an earlier affidavit checks what it is given", async () => {
  const { user } = await canonDraft();
  const bad = [
    { oath: "promised", date: "2025-04-02" },
    { oath: "sworn" },
    { oath: "sworn", date: "2 April 2025" },
    { oath: "sworn", date: "2025-02-30" },
    { oath: "sworn", date: "2999-01-01" }, // in the future
  ];
  for (const b of bad) {
    const r = await user.put("/api/docs/D002/affidavit", b);
    assertEquals(r.status, 400, JSON.stringify(b));
  }
  assertEquals((await user.get("/api/docs/D002")).json.affidavit, null);
  // A document that doesn't exist is refused the way every document route refuses it.
  const missing = await user.put("/api/docs/D999/affidavit", { oath: "sworn", date: "2025-04-02" });
  assertEquals(missing.status, (await user.get("/api/docs/D999")).status);
  assert(missing.status >= 400 && missing.status < 500);
});

Deno.test("the chronology export cites the user's earlier affidavit the same way", async () => {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanonWork(s);
  await s.updateSettings({ userRole: "mother" });
  await t.user.put("/api/docs/D002/author", { role: "mother" });
  await t.user.put("/api/docs/D002/affidavit", { oath: "sworn", date: "2025-04-02" });
  const r = await t.user.get("/api/chronology/export?which=all&format=docx");
  assertEquals(r.status, 200, r.text);
  assertStringIncludes(
    await docxToText(r.bytes),
    "Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.\n" +
      "Text messages, March 2025, lines 1–2; my affidavit sworn 2 April 2025, para 4\n",
  );
  // Recorded as someone else's: the title form.
  await s.updateSettings({ userRole: "father" });
  const rtf = await t.user.get("/api/chronology/export?which=all");
  assertStringIncludes(rtf.text, "Affidavit of Anna Thornbury, line 9");
  assert(!rtf.text.includes("my affidavit"));
});
