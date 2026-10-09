/**
 * Word (.docx) exports (ADR 0026): the writer in its no-permission worker, the reader the safety
 * check uses, the affidavit and chronology as .docx through the API with the same gates as RTF,
 * and the pinned dependency. SYNTHETIC data only (ADR 11).
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { DOCX_TYPE, docxDocument, docxToText, unzip, xmlSafe } from "../src/core/export/docx.ts";
import { adoptParagraph, setDraftHeading, userCreateDraft } from "../src/core/drafting.ts";
import type { CaseSession } from "../src/core/session.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { IDS, tempDir } from "./fixtures/synthetic.ts";
import { assertSecurityHeaders, withCase } from "./helpers/app.ts";
import { seedCanonWork } from "./helpers/canon_work.ts";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── the writer and the reader ──────────────────────────────────────────────

Deno.test("docx: text is escaped, never markup, and reads back as written", async () => {
  const nasty = "Tags <w:p><w:r><w:t>x</w:t></w:r></w:p> & \"quotes\" 'too' ]]> &amp; " +
    "<?xml?> <!-- c --> {\\rtf1}";
  const bytes = await docxDocument([
    { type: "para", text: nasty, bold: true, align: "centre" },
    { type: "para", text: "line one\nline two\tafter a tab" },
    { type: "numbered", n: 4, text: "On 14 March 2025 Daniel was late." },
  ]);
  const files = await unzip(bytes);
  for (const f of ["[Content_Types].xml", "word/document.xml", "docProps/core.xml"]) {
    assert(files.has(f), `no ${f}`);
  }
  const xml = dec(files.get("word/document.xml")!);
  // Exactly the paragraphs the writer made: the text's own "<w:p>" is escaped.
  assertEquals(xml.match(/<w:p>|<w:p /g)?.length, 3);
  assertStringIncludes(xml, "&lt;w:p&gt;");
  const text = await docxToText(bytes);
  assertEquals(
    text,
    `${nasty}\nline one\nline two\tafter a tab\n4.\tOn 14 March 2025 Daniel was late.\n`,
  );
  // Document properties carry no names.
  const core = dec(files.get("docProps/core.xml")!);
  assertStringIncludes(core, "<dc:creator>casefile</dc:creator>");
  assertStringIncludes(core, "<cp:lastModifiedBy>casefile</cp:lastModifiedBy>");
});

Deno.test("docx: characters XML cannot hold are dropped or replaced, so Word can open the file", async () => {
  assertEquals(xmlSafe("a\u0000b\u0007c\u001fd\u007fe"), "abcde");
  assertEquals(xmlSafe("a\r\nb\rc"), "a\nb\nc");
  assertEquals(xmlSafe("x\uFFFEy\uFFFFz"), "xyz");
  assertEquals(xmlSafe("lone \uD800 and \uDC00"), "lone \uFFFD and \uFFFD");
  assertEquals(xmlSafe("emoji \u{1F600} ok"), "emoji \u{1F600} ok");
  const bytes = await docxDocument([{ type: "para", text: "bell\u0007 \uD800 é ✓" }]);
  assertEquals(await docxToText(bytes), "bell \uFFFD é ✓\n");
});

Deno.test("docx: tables keep their cells, a landscape page turns", async () => {
  const bytes = await docxDocument([
    { type: "table", widths: [2000, 6000], header: ["Date", "What"], rows: [["1 May", "a & b"]] },
  ], { landscape: true });
  const xml = dec((await unzip(bytes)).get("word/document.xml")!);
  assertStringIncludes(xml, '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
  assertEquals(xml.match(/<w:tc>/g)?.length, 4);
  assertStringIncludes(xml, "<w:tblHeader/>");
  assertStringIncludes(await docxToText(bytes), "Date\nWhat\n1 May\na & b\n");
});

Deno.test("docx: the reader refuses what is not a .docx", async () => {
  await assertRejects(() => docxToText(new TextEncoder().encode("{\\rtf1 not a zip}")));
});

Deno.test("docx: the dependency is pinned to an exact version in deno.json and deno.lock", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  assertEquals(cfg.imports.docx, "npm:docx@9.7.2");
  const lock = JSON.parse(await Deno.readTextFile(new URL("../deno.lock", import.meta.url)));
  assertEquals(lock.specifiers["npm:docx@9.7.2"], "9.7.2");
  assert(lock.npm["docx@9.7.2"].integrity.startsWith("sha512-"));
  // No install scripts anywhere in its tree (ADR 0026).
  const tree = new Set<string>();
  const walk = (key: string) => {
    if (tree.has(key)) return;
    tree.add(key);
    const entry = lock.npm[key];
    assert(entry, `${key} is not in deno.lock`);
    assert(!entry.scripts, `${key} has install scripts`);
    for (const d of entry.dependencies ?? []) {
      const k = Object.keys(lock.npm).find((n) => n === d || n.startsWith(`${d}@`));
      assert(k, `${d} is not in deno.lock`);
      walk(k);
    }
  };
  walk("docx@9.7.2");
  assert(tree.size > 5);
});

// ── through the API ─────────────────────────────────────────────────────────

const CLAUDE_PARA =
  "On 14 March 2025 {{father.first}} collected {{child_1.first}} late (D001:1-2), as I said " +
  "before (D002:9).";

async function canonDraft() {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanon(s);
  s.registry.update("mothers_home", { relatedTo: "mother" });
  await s.saveRegistry();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit of Anna Thornbury");
  const para = s.store.addParagraph(draft, CLAUDE_PARA, "claude");
  return { ...t, s, draft, para };
}

function lastLog(s: CaseSession, action: string) {
  const row = s.store.listLog(50).find((l) => l.action === action);
  assert(row, `no ${action} row`);
  return JSON.parse(row.detail);
}

Deno.test("affidavit .docx: the same gates as RTF, then a Word download with heading and jurat", async () => {
  const { user, s, draft, para } = await canonDraft();
  const blocked = await user.get(`/api/drafts/${draft}/export?format=docx`);
  assertEquals(blocked.status, 409);
  assertEquals(blocked.json.needsReview, [para]);
  assertEquals(lastLog(s, "export_blocked").format, "docx");
  await adoptParagraph(s, para, { ownKnowledge: true, ownWords: true });
  await setDraftHeading(s, draft, {
    fileNumber: "PAC1234/2024",
    deponent: "father",
    applicant: "mother",
    respondent: "father",
    occupation: "Joiner",
    oath: "sworn",
  });

  const r = await user.get(`/api/drafts/${draft}/export?format=docx`);
  assertEquals(r.status, 200, r.text);
  assertSecurityHeaders(r, "docx export");
  assertEquals(r.headers.get("content-type"), DOCX_TYPE);
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertMatch(
    r.headers.get("content-disposition")!,
    /^attachment; filename="affidavit-\d+-\d{4}-\d{2}-\d{2}\.docx"$/,
  );
  const text = await docxToText(r.bytes);
  assertStringIncludes(text, "FEDERAL CIRCUIT AND FAMILY COURT OF AUSTRALIA\n");
  assertStringIncludes(text, "[check against the Court's current form]");
  assertStringIncludes(text, "File number: PAC1234/2024\n");
  assertStringIncludes(text, "Applicant: Anna Thornbury\nRespondent: Daniel Okafor\n");
  assertStringIncludes(text, "I, Daniel Okafor, of [address], Joiner, make oath and say:\n");
  assertStringIncludes(
    text,
    "1.\tOn 14 March 2025 Daniel collected Mia late (Text messages, March 2025, lines 1–2), " +
      "as I said before (Affidavit of Anna Thornbury, line 9).\n",
  );
  assertStringIncludes(text, "Sworn by the deponent at [place] on [date]");
  assert(!text.includes("{{"), "no tokens left");
  const log = lastLog(s, "exported");
  assertEquals(log.format, "docx");
  assertEquals(log.claude_adopted, 1);
  assert(!JSON.stringify(log).includes("Daniel"));
  // The other formats still work.
  for (const f of ["rtf", "text", "markdown"]) {
    assertEquals((await user.get(`/api/drafts/${draft}/export?format=${f}`)).status, 200, f);
  }
  assertEquals((await user.get(`/api/drafts/${draft}/export?format=pdf`)).status, 400);
});

Deno.test("affidavit .docx: a protected address needs confirming, found in the file as Word reads it", async () => {
  const { user, s, draft, para } = await canonDraft();
  await adoptParagraph(s, para, { ownKnowledge: true, ownWords: true });
  await setDraftHeading(s, draft, { deponent: "father", oath: "sworn" });
  const add = await user.post(`/api/drafts/${draft}/paragraphs`, {
    text: `She lives at ${IDS.address}.`,
  });
  assertEquals(add.status, 200, add.text);
  const r = await user.get(`/api/drafts/${draft}/export?format=docx`);
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.safetyConfirm, true);
  assert(!r.text.includes("Banksia"), "the warning does not repeat the address");
  assertEquals(lastLog(s, "export_safety_warned"), { draft, format: "docx", addresses: 1 });
  const ok = await user.get(`/api/drafts/${draft}/export?format=docx&confirmSafety=1`);
  assertEquals(ok.status, 200);
  assertStringIncludes(await docxToText(ok.bytes), `She lives at ${IDS.address}.`);
});

Deno.test("chronology .docx: checked entries only, or all with unchecked marked", async () => {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanonWork(s);
  const r = await t.user.get("/api/chronology/export?which=all&format=docx");
  assertEquals(r.status, 200, r.text);
  assertEquals(r.headers.get("content-type"), DOCX_TYPE);
  assertMatch(
    r.headers.get("content-disposition")!,
    /^attachment; filename="chronology-all-\d{4}-\d{2}-\d{2}\.docx"$/,
  );
  const xml = dec((await unzip(r.bytes)).get("word/document.xml")!);
  assertStringIncludes(xml, 'w:orient="landscape"');
  const text = await docxToText(r.bytes);
  assertStringIncludes(
    text,
    "14 March 2025\nDaniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public " +
      "School.\nText messages, March 2025, lines 1–2; Affidavit of Anna Thornbury, line 9\n" +
      "Claude\nNOT CHECKED\n",
  );
  assertEquals(lastLog(s, "chronology_exported").format, "docx");
  assertEquals(lastLog(s, "chronology_exported").unchecked, 5);
  // RTF stays the default; an unknown format is refused.
  const rtf = await t.user.get("/api/chronology/export");
  assertEquals(rtf.headers.get("content-type"), "application/rtf");
  assertEquals((await t.user.get("/api/chronology/export?format=pdf")).status, 400);
});

// ── a real Word reader, when one is installed ──────────────────────────────

const soffice = (() => {
  for (const p of ["/usr/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"]) {
    try {
      Deno.statSync(p);
      return p;
    } catch { /* not here */ }
  }
  return null;
})();

Deno.test({
  name: "affidavit .docx opens in LibreOffice with real names",
  ignore: !soffice,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { user, s, draft, para } = await canonDraft();
    await adoptParagraph(s, para, { ownKnowledge: true, ownWords: true });
    await setDraftHeading(s, draft, { deponent: "father", applicant: "mother", oath: "sworn" });
    const r = await user.get(`/api/drafts/${draft}/export?format=docx`);
    assertEquals(r.status, 200, r.text);
    const dir = await tempDir("docx-lo");
    await Deno.writeFile(join(dir, "a.docx"), r.bytes);
    const out = await new Deno.Command(soffice!, {
      args: [
        `-env:UserInstallation=file://${dir}/profile`,
        "--headless",
        "--convert-to",
        "txt:Text",
        "--outdir",
        dir,
        join(dir, "a.docx"),
      ],
      stdout: "null",
      stderr: "null",
      signal: AbortSignal.timeout(120_000),
    }).output();
    assert(out.success, "LibreOffice could not convert the file");
    const txt = (await Deno.readTextFile(join(dir, "a.txt"))).replace(/^﻿/, "");
    assertStringIncludes(txt, "Applicant: Anna Thornbury");
    assertStringIncludes(txt, "I, Daniel Okafor, of [address], [occupation], make oath and say:");
    assertStringIncludes(txt, "1.\tOn 14 March 2025 Daniel collected Mia late");
    assertStringIncludes(txt, "Sworn by the deponent at [place] on [date]");
  },
});
