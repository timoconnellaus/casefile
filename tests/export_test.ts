/**
 * Export formats (W3-1, ADR 0021): the RTF writer and its escaping, the affidavit and chronology
 * as RTF, annexure marks (vault only), the provenance report, the safety warning, and the
 * download and logging rules. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { rtfDocument, rtfText, rtfToText } from "../src/core/export/rtf.ts";
import {
  labelLinkSuggestions,
  labelOwner,
  protectedAddressesIn,
  protectedDetails,
} from "../src/core/export/safety.ts";
import { EntityRegistry } from "../src/core/entities.ts";
import { initials } from "../src/core/export/annexures.ts";
import {
  ADOPTION_FACTS_FILE,
  adoptParagraph,
  setDraftHeading,
  userCreateDraft,
} from "../src/core/drafting.ts";
import type { CaseSession } from "../src/core/session.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { dumpPublic } from "./fixtures/case.ts";
import { IDS, tempDir } from "./fixtures/synthetic.ts";
import { assertSecurityHeaders, withCase } from "./helpers/app.ts";
import { seedCanonWork } from "./helpers/canon_work.ts";

// ── a minimal RTF reader, for checking what the writer produced ─────────────

interface Parsed {
  /** Every control word, in order (without the backslash or parameter). */
  words: string[];
  /** The body text, decoded (\par → \n\n, \line → \n, \tab → \t, \cell → |, \row → \n). */
  text: string;
  /** Group depth never went below zero and ended at zero exactly at the end. */
  balanced: boolean;
}

function parseRtf(rtf: string): Parsed {
  const words: string[] = [];
  let text = "";
  let depth = 0;
  let minDepth = 0;
  let skipDepth = -1; // inside {\fonttbl …}
  let i = 0;
  let endedAt = -1;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      minDepth = Math.min(minDepth, depth);
      if (skipDepth >= 0 && depth < skipDepth) skipDepth = -1;
      if (depth === 0 && endedAt < 0) endedAt = i;
      i++;
      continue;
    }
    if (c === "\\") {
      const n = rtf[i + 1];
      if (n === "\\" || n === "{" || n === "}") {
        if (skipDepth < 0) text += n;
        i += 2;
        continue;
      }
      const m = /^([a-z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1));
      if (!m) {
        words.push(`symbol:${n}`);
        i += 2;
        continue;
      }
      i += 1 + m[0].length;
      const w = m[1];
      words.push(w);
      if (w === "fonttbl") skipDepth = depth;
      if (skipDepth >= 0) continue;
      if (w === "par") text += "\n\n";
      else if (w === "line") text += "\n";
      else if (w === "tab") text += "\t";
      else if (w === "cell") text += "|";
      else if (w === "row") text += "\n";
      else if (w === "u") {
        const v = Number(m[2]);
        text += String.fromCharCode(v < 0 ? v + 0x10000 : v);
        if (rtf[i] === "?") i++;
      }
      continue;
    }
    if (c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (skipDepth < 0 && depth > 0) text += c;
    i++;
  }
  return {
    words,
    text,
    balanced: minDepth >= 0 && depth === 0 && endedAt === rtf.trimEnd().length - 1,
  };
}

const EVIL = "A }{\\rtf1 \\par\\b bold} {\\object\\objdata 0101} \\'e9 {\\field{\\*\\fldinst " +
  'HYPERLINK "http://example.invalid"}} Café — 😀\r\nnext\tline\u0007\u0000end\\';

/** What the reader should get back: control characters other than tab and line feed dropped. */
function expectedText(s: string): string {
  return [...s.replace(/\r\n/g, "\n")].filter((c) => c === "\t" || c === "\n" || c >= " ").join("");
}

Deno.test("RTF: text never produces control words or groups, whatever it contains", () => {
  // The writer's own words for a line break and a tab are the only ones text can lead to.
  const PLAIN = "x\ny\tz";
  const plain = rtfDocument([{ type: "para", text: PLAIN }, {
    type: "numbered",
    n: 1,
    text: PLAIN,
  }]);
  const evil = rtfDocument([{ type: "para", text: EVIL }, { type: "numbered", n: 1, text: EVIL }]);
  const a = parseRtf(plain);
  const b = parseRtf(evil);
  assert(a.balanced && b.balanced, "groups balanced, closing only at the end");
  // Exactly the writer's control words: nothing from the text (u is the Unicode escape).
  assertEquals(b.words.filter((w) => w !== "u"), a.words);
  // Every character comes back as written (other control characters dropped, \r\n one break).
  const expected = expectedText(EVIL);
  assertStringIncludes(b.text, `${expected}\n\n`);
  assertStringIncludes(b.text, `1.\t${expected}\n\n`);
  // 7-bit output: everything else is \uN?, astral characters as a surrogate pair.
  assert([...evil].every((c) => c === "\t" || c === "\n" || (c >= " " && c <= "~")));
  assertEquals(rtfText("é—😀"), "\\u233?\\u8212?\\u-10179?\\u-8704?");
  assertEquals(rtfText("{a}\\b"), "\\{a\\}\\\\b");
});

Deno.test("RTF: table cells are escaped the same way", () => {
  const doc = rtfDocument([{
    type: "table",
    widths: [3000, 6000],
    header: ["Date", "What"],
    rows: [["1 March", EVIL], ["}", "{"]],
  }]);
  const p = parseRtf(doc);
  assert(p.balanced);
  const plain = parseRtf(rtfDocument([{
    type: "table",
    widths: [3000, 6000],
    header: ["Date", "What"],
    rows: [["1 March", "x\ny\tz"], ["a", "b"]],
  }]));
  assertEquals(p.words.filter((w) => w !== "u"), plain.words);
  assertStringIncludes(p.text, "}|{|");
});

const hasTextutil = Deno.build.os === "darwin" &&
  (() => {
    try {
      Deno.statSync("/usr/bin/textutil");
      return true;
    } catch {
      return false;
    }
  })();

/** Convert RTF to plain text with macOS's own reader (what TextEdit and Quick Look use). */
async function textutil(rtf: string): Promise<string> {
  const dir = await tempDir("casefile-rtf-");
  const file = join(dir, "export.rtf");
  await Deno.writeTextFile(file, rtf);
  const out = await new Deno.Command("/usr/bin/textutil", {
    args: ["-convert", "txt", "-stdout", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  // textutil writes \line as U+2028.
  return new TextDecoder().decode(out.stdout).replaceAll(" ", "\n");
}

Deno.test({
  name: "RTF: macOS textutil reads the writer's output as the same text",
  ignore: !hasTextutil,
  fn: async () => {
    const txt = await textutil(rtfDocument([
      { type: "para", text: "Heading", bold: true, align: "centre" },
      { type: "numbered", n: 1, text: EVIL },
      { type: "table", widths: [3000, 6000], header: ["Date", "What"], rows: [["1 March", EVIL]] },
    ]));
    const expected = expectedText(EVIL);
    assertStringIncludes(txt, "Heading");
    assertStringIncludes(txt, `1.\t${expected}`);
    assertStringIncludes(txt, "1 March");
    // Nothing became formatting or a field: the braces and backslashes are in the text.
    assertEquals(txt.split(expected).length - 1, 2);
  },
});

Deno.test("initials for annexure marks", () => {
  assertEquals(initials("Anna Thornbury"), "AT");
  assertEquals(initials("Anne-Marie de la Cruz"), "AMC");
  assertEquals(initials(""), "");
});

// ── the API ─────────────────────────────────────────────────────────────────

const CLAUDE_PARA =
  "On 14 March 2025 {{father.first}} collected {{child_1.first}} late (D001:1-2), as I said " +
  "before (D002:9).";

async function canonDraft() {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanon(s);
  // The user says whose the address is (who's who): it is protected because she is.
  s.registry.update("mothers_home", { relatedTo: "mother" });
  await s.saveRegistry();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit of Anna Thornbury");
  const para = s.store.addParagraph(draft, CLAUDE_PARA, "claude");
  return { ...t, s, draft, para };
}

async function adopt(s: CaseSession, para: number) {
  await adoptParagraph(s, para, { ownKnowledge: true, ownWords: true });
}

function lastLog(s: CaseSession, action: string) {
  const row = s.store.listLog(50).find((l) => l.action === action);
  assert(row, `no ${action} row`);
  return JSON.parse(row.detail);
}

Deno.test("affidavit RTF: gates still apply, then a download with heading, jurat and markers", async () => {
  const { user, s, draft, para } = await canonDraft();
  // Not adopted: blocked, in RTF as in the other formats.
  const blocked = await user.get(`/api/drafts/${draft}/export?format=rtf`);
  assertEquals(blocked.status, 409);
  assertEquals(blocked.json.needsReview, [para]);
  assertEquals(lastLog(s, "export_blocked").format, "rtf");
  // A placeholder blocks too.
  const ph = s.store.addParagraph(draft, "[In your own words: how Mia was]", "claude");
  assertEquals((await user.get(`/api/drafts/${draft}/export?format=rtf`)).json.placeholders, [ph]);
  s.store.deleteParagraph(ph);
  await adopt(s, para);
  assertEquals((await user.get(`/api/drafts/${draft}/export?format=docx`)).status, 400);

  const r = await user.get(`/api/drafts/${draft}/export?format=rtf`);
  assertEquals(r.status, 200, r.text);
  assertSecurityHeaders(r, "rtf export");
  assertEquals(r.headers.get("content-type"), "application/rtf");
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertMatch(
    r.headers.get("content-disposition")!,
    /^attachment; filename="affidavit-\d+-\d{4}-\d{2}-\d{2}\.rtf"$/,
  );
  const p = parseRtf(r.text);
  assert(p.balanced);
  assertStringIncludes(p.text, "FEDERAL CIRCUIT AND FAMILY COURT OF AUSTRALIA");
  assertStringIncludes(p.text, "[check against the Court's current form]");
  assertStringIncludes(p.text, "File number: [file number]");
  assertStringIncludes(p.text, "I, [full name], of [address], [occupation], [make oath / affirm]");
  assertStringIncludes(
    p.text,
    "1.\tOn 14 March 2025 Daniel collected Mia late (Text messages, March 2025, lines 1–2), " +
      "as I said before (Affidavit of Anna Thornbury, line 9).",
  );
  assertStringIncludes(p.text, "Sworn / affirmed by the deponent at [place] on [date]");
  assertStringIncludes(p.text, "Before me: ____________________");
  const log = lastLog(s, "exported");
  assertEquals(log.format, "rtf");
  assertEquals(log.claude_adopted, 1);
  // Counts only: no names, titles or text in the log row.
  assert(!JSON.stringify(log).includes("Daniel"));
  // Markdown stays the default.
  const md = await user.get(`/api/drafts/${draft}/export`);
  assertEquals(md.status, 200);
  assertStringIncludes(md.text, "# Affidavit of Anna Thornbury");
});

Deno.test({
  name: "affidavit RTF opens in macOS's RTF reader (textutil) with real names",
  ignore: !hasTextutil,
  fn: async () => {
    const { user, s, draft, para } = await canonDraft();
    await adopt(s, para);
    await setDraftHeading(s, draft, {
      fileNumber: "PAC1234/2024",
      deponent: "father",
      applicant: "mother",
      respondent: "father",
      occupation: "Joiner",
      oath: "sworn",
    });
    const r = await user.get(`/api/drafts/${draft}/export?format=rtf`);
    assertEquals(r.status, 200, r.text);
    const txt = await textutil(r.text);
    assertStringIncludes(txt, "File number: PAC1234/2024");
    assertStringIncludes(txt, "Applicant: Anna Thornbury");
    assertStringIncludes(txt, "Respondent: Daniel Okafor");
    assertStringIncludes(txt, "I, Daniel Okafor, of [address], Joiner, make oath and say:");
    assertStringIncludes(txt, "1.\tOn 14 March 2025 Daniel collected Mia late");
    assertStringIncludes(txt, "Sworn by the deponent at [place] on [date]");
  },
});

Deno.test("annexure marks: kept in the vault only, and citations become annexure marks", async () => {
  const { user, s, draft, para } = await canonDraft();
  await adopt(s, para);
  await setDraftHeading(s, draft, { deponent: "father" });
  const g = await user.get(`/api/drafts/${draft}/annexures`);
  assertEquals(g.status, 200, g.text);
  assertEquals(g.json.marks, {});
  assertEquals(g.json.prefix, "DO");
  assertEquals(g.json.suggested, { D001: "DO-1", D002: "DO-2" });
  assertEquals(g.json.docs.map((d: { doc: string }) => d.doc), ["D001", "D002"]);

  // Bad input is refused and nothing is saved.
  for (
    const bad of [
      { D001: "AT-1", D002: "at-1" }, // twice
      { D001: "AT 1}" },
      { D001: "{\\rtf}" },
      { D999: "AT-1" },
      { "../x": "AT-1" },
      ["AT-1"],
    ]
  ) {
    assertEquals((await user.put(`/api/drafts/${draft}/annexures`, { marks: bad })).status, 400);
  }
  const put = await user.put(`/api/drafts/${draft}/annexures`, { marks: { D001: "AT-1" } });
  assertEquals(put.status, 200, put.text);
  assertEquals(put.json.marks, { D001: "AT-1" });
  assertEquals((await user.get(`/api/drafts/${draft}/annexures`)).json.docs[0].mark, "AT-1");
  // Never in public.db, and the log has the count only.
  assert(!dumpPublic(s.store).includes("AT-1"), "the mark is not in public.db");
  assertEquals(lastLog(s, "annexure_marks_set"), { draft, marks: 1 });

  const r = await user.get(`/api/drafts/${draft}/export?format=text`);
  assertEquals(r.status, 200, r.text);
  assertStringIncludes(
    r.text,
    "Daniel collected Mia late (annexure AT-1), as I said before (Affidavit of Anna " +
      "Thornbury, line 9).",
  );
  assertEquals(lastLog(s, "exported").annexure_citations, 1);
  assert(!dumpPublic(s.store).includes("AT-1"), "exporting does not put it in public.db");

  // A new draft that reuses the id does not inherit the marks.
  s.store.db.prepare("DELETE FROM drafts WHERE id = ?").run(draft);
  const again = s.store.createDraft({ kind: "affidavit", title: "Other" }, "claude");
  assertEquals(again, draft);
  s.store.db.prepare("UPDATE drafts SET created_at = ? WHERE id = ?").run(
    "2030-01-01T00:00:00.000Z",
    again,
  );
  assertEquals((await user.get(`/api/drafts/${again}/annexures`)).json.marks, {});
});

Deno.test("a safety-sensitive person's address in an export needs confirming", async () => {
  const { user, s, draft, para } = await canonDraft();
  await adopt(s, para);
  // CANON: the mother is safety-sensitive; the heading holds her address.
  await setDraftHeading(s, draft, { deponent: "mother", address: IDS.address, oath: "affirmed" });
  const r = await user.get(`/api/drafts/${draft}/export?format=rtf`);
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.safetyConfirm, true);
  assert(!r.text.includes(IDS.address), "the warning does not repeat the address");
  assertEquals(r.json.addresses, [
    { label: "mothers_home", person: "mother", kind: "address", via: "link" },
  ]);
  assertEquals(lastLog(s, "export_safety_warned"), { draft, format: "rtf", addresses: 1 });
  // The other formats are gated the same way.
  assertEquals((await user.get(`/api/drafts/${draft}/export?format=markdown`)).status, 409);

  const ok = await user.get(`/api/drafts/${draft}/export?format=rtf&confirmSafety=1`);
  assertEquals(ok.status, 200, ok.text);
  assertEquals(lastLog(s, "exported").safety_confirmed, 1);
  assert(!JSON.stringify(lastLog(s, "exported")).includes("Banksia"));

  // An address typed differently in the heading still warns: the deponent is safety-sensitive.
  await setDraftHeading(s, draft, { deponent: "mother", address: "c/o a PO box", oath: "sworn" });
  const r2 = await user.get(`/api/drafts/${draft}/export?format=text`);
  assertEquals(r2.status, 409);
  assertEquals(r2.json.addresses, [
    { label: "heading", person: "mother", kind: "address", via: "heading" },
  ]);
  // Someone else as deponent, with no address of hers in the text: no warning.
  await setDraftHeading(s, draft, { deponent: "father", address: "1 Other St", oath: "sworn" });
  assertEquals((await user.get(`/api/drafts/${draft}/export?format=text`)).status, 200);
  // Her address in a paragraph warns, wherever it appears.
  await user.post(`/api/drafts/${draft}/paragraphs`, { text: `I lived at ${IDS.address}.` });
  assertEquals((await user.get(`/api/drafts/${draft}/export?format=text`)).status, 409);
});

Deno.test("export safety follows who's who, not the label: a linked address under any name", async () => {
  const { user, s } = await canonDraft();
  const letter = async (text: string) => {
    const id = await userCreateDraft(s, "letter", "Letter");
    s.store.addParagraph(id, text, "user");
    for (const p of s.store.listParagraphs(id)) await s.ledger.attestUserAuthorship(p);
    return id;
  };
  // An address whose label names no one, linked to the safety-sensitive mother.
  s.registry.add({ role: "address_7", kind: "address", full: "9 Wattle Lane, Kiama NSW 2533" });
  s.registry.update("address_7", { relatedTo: "mother" });
  // And one named like hers but linked to the father (not safety-sensitive).
  s.registry.add({
    role: "mothers_old_flat",
    kind: "address",
    full: "3 Fig Tree Row, Dapto NSW 2530",
  });
  s.registry.update("mothers_old_flat", { relatedTo: "father" });
  await s.saveRegistry();

  const linked = await letter("She now lives at 9 Wattle Lane, Kiama NSW 2533.");
  const r = await user.get(`/api/drafts/${linked}/export?format=text`);
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.addresses, [
    { label: "address_7", person: "mother", kind: "address", via: "link" },
  ]);

  const named = await letter("He kept 3 Fig Tree Row, Dapto NSW 2530 for a while.");
  assertEquals((await user.get(`/api/drafts/${named}/export?format=text`)).status, 200);

  // Unlinking her address lifts the warning; flagging the address itself brings it back.
  s.registry.update("address_7", { relatedTo: null });
  await s.saveRegistry();
  assertEquals((await user.get(`/api/drafts/${linked}/export?format=text`)).status, 200);
  s.registry.update("address_7", { safety: true });
  await s.saveRegistry();
  const own = await user.get(`/api/drafts/${linked}/export?format=text`);
  assertEquals(own.status, 409);
  assertEquals(own.json.addresses, [
    { label: "address_7", person: null, kind: "address", via: "flag" },
  ]);
});

Deno.test("export safety fails closed: an unlinked address labelled as hers still warns (security review)", async () => {
  const { user, s } = await canonDraft();
  const letter = async (text: string) => {
    const id = await userCreateDraft(s, "letter", "Letter");
    s.store.addParagraph(id, text, "user");
    for (const p of s.store.listParagraphs(id)) await s.ledger.attestUserAuthorship(p);
    return id;
  };
  // A case from before links: mothers_home has no relatedTo, and she is safety-sensitive.
  s.registry.update("mothers_home", { relatedTo: null });
  await s.saveRegistry();
  assertEquals(s.registry.isSafetySensitive("mothers_home"), false, "no link, no own flag");
  const id = await letter(`She lives at ${IDS.address}.`);
  const r = await user.get(`/api/drafts/${id}/export?format=text`);
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.addresses, [
    { label: "mothers_home", person: "mother", kind: "address", via: "label" },
  ]);
  assertEquals((await user.get(`/api/drafts/${id}/provenance`)).status, 409);
  // The app suggests the link; it isn't made for the user.
  assertEquals(labelLinkSuggestions(s.registry).filter((x) => x.role === "mothers_home"), [
    { role: "mothers_home", person: "mother", safety: true },
  ]);
  assertEquals(s.registry.get("mothers_home")?.relatedTo ?? null, null);
  // Once she links it (to her), it is protected by the link and no longer suggested.
  s.registry.update("mothers_home", { relatedTo: "mother" });
  await s.saveRegistry();
  assertEquals(
    (await user.get(`/api/drafts/${id}/export?format=text`)).json.addresses[0].via,
    "link",
  );
  assertEquals(labelLinkSuggestions(s.registry).some((x) => x.role === "mothers_home"), false);
  // Linked to someone else on purpose: the label no longer decides.
  s.registry.update("mothers_home", { relatedTo: "father" });
  await s.saveRegistry();
  assertEquals((await user.get(`/api/drafts/${id}/export?format=text`)).status, 200);
});

Deno.test("export safety covers every detail linked to a safety-sensitive person, not only addresses", async () => {
  const { user, s } = await canonDraft();
  const letter = async (text: string) => {
    const id = await userCreateDraft(s, "letter", "Letter");
    s.store.addParagraph(id, text, "user");
    for (const p of s.store.listParagraphs(id)) await s.ledger.attestUserAuthorship(p);
    return id;
  };
  // Her mobile and email, linked to her; and a phone labelled as hers with no link yet.
  s.registry.add({ role: "phone_9", kind: "phone", full: "0491 570 006" });
  s.registry.update("phone_9", { relatedTo: "mother" });
  s.registry.add({ role: "email_9", kind: "email", full: "ann.t@example.com" });
  s.registry.update("email_9", { relatedTo: "mother" });
  s.registry.add({ role: "mother_work_phone", kind: "phone", full: "02 5550 1234" });
  // His phone (not safety-sensitive) stays unprotected.
  s.registry.add({ role: "phone_8", kind: "phone", full: "0491 570 007" });
  s.registry.update("phone_8", { relatedTo: "father" });
  await s.saveRegistry();

  const phone = await letter("Call her on 0491 570 006 or email ann.t@example.com.");
  const r = await user.get(`/api/drafts/${phone}/export?format=rtf`);
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.addresses, [
    { label: "email_9", person: "mother", kind: "email", via: "link" },
    { label: "phone_9", person: "mother", kind: "phone", via: "link" },
  ]);
  assert(!r.text.includes("0491"), "the warning never repeats the value");
  assert(/contact details/.test(r.json.error), r.json.error);

  const work = await letter("Her work number is 02 5550 1234.");
  const w = await user.get(`/api/drafts/${work}/export?format=markdown`);
  assertEquals(w.status, 409, w.text);
  assertEquals(w.json.addresses, [
    { label: "mother_work_phone", person: "mother", kind: "phone", via: "label" },
  ]);

  const his = await letter("His number is 0491 570 007.");
  assertEquals((await user.get(`/api/drafts/${his}/export?format=text`)).status, 200);

  // Protected details, with why.
  const all = protectedDetails(s.registry);
  assertEquals(all.get("phone_9"), { person: "mother", kind: "phone", via: "link" });
  assertEquals(all.get("mother_work_phone")?.via, "label");
  assertEquals(all.has("phone_8"), false);
  assertEquals(all.has("mother"), false, "a person's own name is not a detail");
});

Deno.test("label link suggestions: the longest person label wins, and only unlinked details", () => {
  const reg = new EntityRegistry();
  reg.add({ role: "child_1", kind: "person", full: "Ann Example" });
  reg.add({ role: "child_10", kind: "person", full: "Ben Example" });
  reg.add({ role: "child_10_phone", kind: "phone", full: "0400 000 010" });
  reg.add({ role: "child_1s_school_bag", kind: "other", full: "blue bag" });
  reg.add({ role: "place_1", kind: "place", full: "Dapto" });
  reg.add({ role: "child_1_email", kind: "email", full: "ann@example.com" });
  reg.update("child_1_email", { relatedTo: "child_10" });
  assertEquals(labelOwner(reg, "child_10_phone"), "child_10");
  assertEquals(labelOwner(reg, "child_1s_school_bag"), "child_1");
  assertEquals(labelOwner(reg, "place_1"), null);
  assertEquals(labelOwner(reg, "child_1_email"), null, "already linked");
  assertEquals(labelOwner(reg, "child_1"), null, "a person");
  assertEquals(labelLinkSuggestions(reg).map((x) => x.role), [
    "child_10_phone",
    "child_1s_school_bag",
  ]);
});

Deno.test("chronology RTF: checked only, or all with unchecked marked; checks from the ledger", async () => {
  const t = await withCase();
  const s = t.state.session!;
  const w = await seedCanonWork(s);
  // Claude forges a check in public.db: still not checked.
  s.store.db.prepare("UPDATE chronology SET verified_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    w.chronology.toCheck[0],
  );
  const checked = await t.user.get("/api/chronology/export");
  assertEquals(checked.status, 200, checked.text);
  assertSecurityHeaders(checked, "chronology export");
  assertEquals(checked.headers.get("content-type"), "application/rtf");
  assertMatch(
    checked.headers.get("content-disposition")!,
    /^attachment; filename="chronology-checked-\d{4}-\d{2}-\d{2}\.rtf"$/,
  );
  const p = parseRtf(checked.text);
  assert(p.balanced);
  assert(!p.text.includes("NOT CHECKED"));
  assert(!p.text.includes("Daniel collected"), "the forged check does not count");
  assertEquals(p.text.split("An event in the case history.").length - 1, 12);
  assertStringIncludes(p.text, "Swimming timetable, line 1");
  assertEquals(lastLog(s, "chronology_exported"), {
    format: "rtf",
    scope: "checked",
    entries: 12,
    unchecked: 0,
    left_out: 5,
  });

  const all = await t.user.get("/api/chronology/export?which=all");
  assertEquals(all.status, 200, all.text);
  const a = parseRtf(all.text);
  assertStringIncludes(
    a.text,
    "14 March 2025|Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public " +
      "School.|Text messages, March 2025, lines 1–2; Affidavit of Anna Thornbury, line 9|" +
      "Claude|NOT CHECKED|",
  );
  assertStringIncludes(a.text, "NOT CHECKED (can't check against its source)");
  assertEquals(lastLog(s, "chronology_exported").unchecked, 5);
  assertEquals((await t.user.get("/api/chronology/export?which=some")).status, 400);

  if (hasTextutil) {
    const txt = await textutil(all.text);
    assertStringIncludes(txt, "Daniel collected Mia and Lachlan 90 minutes late");
    assertStringIncludes(txt, "NOT CHECKED");
  }
});

Deno.test("provenance report: from signed records only; forging public.db changes nothing", async () => {
  const t = await withCase();
  const s = t.state.session!;
  const w = await seedCanonWork(s);
  const r = await t.user.get(`/api/drafts/${w.draft}/provenance`);
  assertEquals(r.status, 200, r.text);
  assertSecurityHeaders(r, "provenance");
  assertMatch(
    r.headers.get("content-disposition")!,
    /^attachment; filename="provenance-affidavit-\d+-\d{4}-\d{2}-\d{2}\.md"$/,
  );
  const md = r.text;
  assertStringIncludes(md, "# Provenance report: Affidavit of Anna Thornbury");
  assertStringIncludes(
    md,
    "- 7 paragraphs: 3 in your own words; Claude drafted 4 (1 adopted by you, 1 rewritten by you, " +
      "not adopted yet, 2 still need you).",
  );
  assertStringIncludes(
    md,
    "| 3 | Mia attends Kiama Downs Public School. | Drafted by Claude — adopted by you |",
  );
  assertStringIncludes(
    md,
    "| 5 | Lachlan attends Little Gumnuts Childcare. | Drafted by Claude — needs you | — |",
  );
  assertStringIncludes(
    md,
    "Plan: a consumer plan (Claude Pro or Max), as recorded by you on 3 September 2025.",
  );
  assertStringIncludes(md, "You used Claude's paragraph as your own words");
  assertStringIncludes(md, "## What this report cannot show");
  assertEquals(lastLog(s, "provenance_exported"), { draft: w.draft, paragraphs: 7 });

  // Fact answers come from the vault, and only for the current adoption.
  const p3 = s.store.getParagraph(w.paragraphs[2]);
  await s.writeVaultJson(ADOPTION_FACTS_FILE, {
    [String(p3.id)]: {
      at: p3.adopted_at,
      draft: w.draft,
      facts: [{ text: "a", answer: "saw" }, { text: "b", answer: "read" }],
    },
    [String(w.paragraphs[4])]: {
      at: "2025-01-01",
      draft: w.draft,
      facts: [{ text: "c", answer: "saw" }],
    },
  });
  const withFacts = (await t.user.get(`/api/drafts/${w.draft}/provenance`)).text;
  assertStringIncludes(
    withFacts,
    "fact by fact: 1 you saw or did yourself, 1 you read, 0 you were",
  );
  assertStringIncludes(withFacts, "| 1 saw or did myself, 1 read |");

  // Claude marks its paragraphs as the user's and adopted, and inserts a log row claiming to be
  // the user's: the report is the same.
  s.store.db.prepare("UPDATE paragraphs SET author = 'user', adopted_at = ? WHERE draft_id = ?")
    .run(new Date().toISOString(), w.draft);
  s.store.db.prepare(
    "INSERT INTO ai_log (ts, actor, action, detail, chain, chain_kind) VALUES (?, 'user', " +
      "'paragraph_adopted', ?, 'ab', 'signed')",
  ).run(new Date().toISOString(), JSON.stringify({ draft: w.draft, paragraph: w.paragraphs[4] }));
  const again = (await t.user.get(`/api/drafts/${w.draft}/provenance`)).text;
  assertStringIncludes(again, "Claude drafted 4 (0 adopted by you");
  assertStringIncludes(
    again,
    "| 5 | Lachlan attends Little Gumnuts Childcare. | Drafted by Claude — needs you |",
  );
  assertEquals(again.split("You used Claude's paragraph as your own words").length - 1, 1);
  assertStringIncludes(again, "could not be verified and is left out");
});

Deno.test("export routes need an unlocked case and are not shadowed by entry ids", async () => {
  const { user, state } = await withCase();
  await user.post("/api/lock");
  for (
    const path of [
      "/api/chronology/export",
      "/api/drafts/1/export?format=rtf",
      "/api/drafts/1/provenance",
      "/api/drafts/1/annexures",
    ]
  ) {
    const r = await user.get(path);
    assert(r.status === 401 || r.status === 423, `${path}: ${r.status}`);
  }
  void state;
});

Deno.test("safety warning uses the leak matcher on the export as read: case, alias, part, wrapping, truncation, escaping", async () => {
  const { user, s } = await canonDraft();
  // A letter has no gates to pass, so each export below reaches the safety check.
  const letter = async (text: string) => {
    const id = await userCreateDraft(s, "letter", "Letter");
    s.store.addParagraph(id, text, "user");
    // Mark it the user's in the ledger, as the app does for the user's own paragraphs.
    for (const p of s.store.listParagraphs(id)) await s.ledger.attestUserAuthorship(p);
    return id;
  };
  const home = s.registry.get("mothers_home")!;
  home.aliases.push("the Banksia {rear} cottage");
  await s.saveRegistry();

  const cases: [string, string][] = [
    ["different case", `Write to ${IDS.address.toUpperCase()}.`],
    ["an address part (street, no number)", "She moved to Banksia Crescent last year."],
    ["an address part (suburb)", "She moved to Gerringong last year."],
    ["an alias", "She lives at the Banksia {rear} cottage now."],
    ["split by a line break", "She lives at 14 Banksia\nCrescent now."],
  ];
  for (const [what, text] of cases) {
    const id = await letter(text);
    for (const format of ["rtf", "markdown", "text"]) {
      const r = await user.get(`/api/drafts/${id}/export?format=${format}`);
      assertEquals(r.status, 409, `${what} (${format}): ${r.text.slice(0, 200)}`);
      assertEquals(r.json.safetyConfirm, true, what);
    }
    // The provenance report (Markdown) too.
    assertEquals((await user.get(`/api/drafts/${id}/provenance`)).status, 409, `${what}: report`);
  }

  // The provenance report shortens each paragraph to its first words: the check reads the whole.
  const long = await letter(
    `${"Some words before the place she lives. ".repeat(2)}It is ${IDS.address}.`,
  );
  const rep = await user.get(`/api/drafts/${long}/provenance`);
  assertEquals(rep.status, 409, rep.text.slice(0, 300));

  // The chronology: a value Claude wrote in an entry, in a different case, in a table cell.
  s.store.addChronology({
    event_date: "2025-04-01",
    description: "Moved to banksia crescent.",
    sources: [{ doc_id: "D001", line_start: 1, line_end: 1 }],
  }, "claude");
  const ch = await user.get("/api/chronology/export?which=all");
  assertEquals(ch.status, 409, ch.text.slice(0, 200));
  assertEquals((await user.get("/api/chronology/export?which=all&confirmSafety=1")).status, 200);

  // Escaping: the RTF holds "\{rear\}", which only the decoded text matches.
  const rtf = rtfDocument([{ type: "para", text: "at the Banksia {rear} cottage" }]);
  assertEquals(protectedAddressesIn(s, [rtf]).length, 0, "the raw RTF hides it");
  assertEquals(protectedAddressesIn(s, [rtfToText(rtf)]), [{
    label: "mothers_home",
    person: "mother",
    kind: "address",
    via: "link",
  }]);
});

Deno.test("the export's 409 for flags to confirm re-identifies their messages", async () => {
  const { user, s } = await canonDraft();
  const id = await userCreateDraft(s, "outline", "Outline");
  const p = s.store.addParagraph(id, "{{child_2.first}} was late (D001:1).", "claude");
  s.store.setParagraphSources(p, [{ doc_id: "D001", line_start: 1, line_end: 1 }]);
  const r = await user.get(`/api/drafts/${id}/export?format=rtf`);
  assertEquals(r.status, 409, r.text);
  assertEquals(r.json.needsConfirm, true);
  assert(r.json.flags.length > 0);
  for (const f of r.json.flags) assert(!/\{\{/.test(f.message), f.message);
  assert(r.json.flags.some((f: { message: string }) => f.message.includes("Lachlan")), r.text);
});
