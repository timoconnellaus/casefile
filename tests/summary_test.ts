/**
 * The "If the Court asks" summary (PD-AI 4.11; ADR 0018) on the CANON case: figures from signed
 * records only, fixed modest wording, and forged public.db columns or log rows change nothing.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { CaseSession } from "../src/core/session.ts";
import { courtSummary, formatDate, formatRange, sealedLog, toCheck } from "../src/core/summary.ts";
import { PASS } from "./fixtures/case.ts";
import { tempDir } from "./fixtures/synthetic.ts";
import { type CanonWork, seedCanonWork } from "./helpers/canon_work.ts";

async function canonWork(): Promise<{ s: CaseSession; w: CanonWork }> {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  const w = await seedCanonWork(s);
  return { s, w };
}

function section(sum: Awaited<ReturnType<typeof courtSummary>>, id: string): string[] {
  const sec = sum.sections.find((x) => x.id === id);
  assert(sec, `section ${id}`);
  return sec.lines;
}

Deno.test("dates are written the plain Australian way", () => {
  assertEquals(formatDate("2025-09-03"), "3 September 2025");
  assertEquals(formatDate("2025-03"), "March 2025");
  assertEquals(formatDate("2025"), "2025");
  assertEquals(formatRange("2025-09-28", "2025-10-05"), "28 September – 5 October 2025");
  assertEquals(formatRange("2025-10-02", "2025-10-05"), "2 – 5 October 2025");
  assertEquals(formatRange("2025-10-02", "2025-10-02"), "2 October 2025");
});

Deno.test("CANON: the Court summary's figures match CANON (all of them)", async () => {
  const { s } = await canonWork();
  const sum = await courtSummary(s);
  const f = sum.figures;
  // Chronology: 12 of 17 checked; 4 to check + 1 can't check.
  assertEquals(f.chronology.claude, 17);
  assertEquals(f.chronology.checked, 12);
  assertEquals([f.chronology.toCheck, f.chronology.cantCheck], [4, 1]);
  assertEquals(f.chronology.changed, 0);
  assertEquals(f.chronology.yours, 0);
  // Evidence: 9 of 11 checked. Issue descriptions: 3 of 4.
  assertEquals([f.evidence.checked, f.evidence.claude], [9, 11]);
  assertEquals([f.issues.checked, f.issues.claude], [3, 4]);
  // Affidavit: 3 paragraphs your words; Claude drafted 4: 1 adopted, 1 rewritten, 2 need you.
  assertEquals(f.drafts.length, 1);
  assertEquals(f.drafts[0].title, "Affidavit of Anna Thornbury");
  assertEquals(f.drafts[0].kind, "affidavit");
  assertEquals([f.paragraphs.yours, f.paragraphs.claude, f.paragraphs.adopted], [3, 4, 1]);
  assertEquals([f.paragraphs.rewritten, f.paragraphs.needsYou], [1, 2]);
  // 6 documents kept from Claude: 3 subpoena/court, 1 other side, 1 under order, 1 not sure.
  assertEquals(f.keptFromClaude.total, 6);
  assertEquals(f.keptFromClaude.byOrigin, {
    mine: 0,
    other_side: 1,
    court_or_subpoena: 3,
    under_order: 1,
    not_sure: 1,
  });
  // 1 exposure: D006, 28 Sep – 5 Oct 2025, withdrawn, read once through casefile.
  assertEquals(f.exposures.length, 1);
  assertEquals(f.exposures[0].doc, "D006");
  assertEquals(f.exposures[0].title, "Letter from the other side's lawyer");
  // Paste: 3 uses, 2 passages added to the draft.
  assertEquals(f.paste, { views: 3, copies: 0, passagesAdded: 2 });
  // Tools: Claude on a consumer plan as recorded; no language model; name finder not used.
  assertEquals(f.claude.plan.setup, "consumer");
  assertEquals(f.claude.plan.at, "2025-09-03T02:00:00.000Z");
  assertEquals(f.claude.logEntries, 2);
  assertEquals(f.languageModel.documents, 0);
  assertEquals(f.log.intact, true);
  assertEquals(f.log.pending, 0);
  // Open items mirror the To-check queue.
  assertEquals(f.open.total, 14);
  assertEquals(f.open.total, (await toCheck(s)).total);
  s.close();
});

Deno.test({
  name: "CANON's exact chronology split: 4 to check + 1 can't check",
  fn: async () => {
    const { s } = await canonWork();
    const f = (await courtSummary(s)).figures;
    assertEquals([f.chronology.toCheck, f.chronology.cantCheck], [4, 1]);
    s.close();
  },
});
Deno.test("CANON: the summary's sentences are fixed, modest and answer PD-AI 4.11", async () => {
  const { s } = await canonWork();
  const sum = await courtSummary(s);
  assertEquals(sum.sections.map((x) => x.id), [
    "ai_used",
    "tools",
    "checking",
    "principles",
    "open",
    "record",
    "limits",
  ]);
  assertMatch(section(sum, "ai_used")[0], /^Yes\. Claude .* was used through casefile\./);
  const tools = section(sum, "tools").join("\n");
  assertStringIncludes(tools, "Claude, used through casefile's command-line tool in Claude Code.");
  assertStringIncludes(
    tools,
    "Plan: a consumer plan (Claude Pro or Max), as recorded by you on 3 September 2025.",
  );
  assertStringIncludes(tools, "No language model was used by casefile to find names.");
  assertStringIncludes(tools, "Jev by TypeSafe AI (extra checks): never turned on.");
  const checking = section(sum, "checking").join("\n");
  assertStringIncludes(checking, "Chronology: you checked 12 of the 17 Claude wrote");
  assertStringIncludes(checking, "Evidence links: you checked 9 of the 11 Claude wrote");
  assertStringIncludes(
    checking,
    "Affidavit of Anna Thornbury: 3 paragraphs in your own words; Claude drafted 4: 1 adopted " +
      "by you, 1 rewritten by you, awaiting adoption, 2 still need you.",
  );
  assertStringIncludes(checking, "2 passages were added to a draft as Claude's paragraphs");
  const principles = section(sum, "principles").join("\n");
  assertStringIncludes(
    principles,
    "6 documents kept from Claude (3 from a subpoena or the court, 1 from the other side, " +
      "1 under a court order, 1 origin not sure): casefile gave Claude none of their text.",
  );
  // D006 went through the real exposure flow today (CANON's dates are 28 Sep – 5 Oct 2025).
  const x = sum.figures.exposures[0];
  assertStringIncludes(
    principles,
    "Exposure: D006 (Letter from the other side's lawyer) showed Claude a name or number casefile " +
      `knows from ${formatDate(x.sharedAt)} until casefile withdrew it on ${
        formatDate(x.withdrawnAt)
      }. Claude read it through casefile 1 time in that time (lines 1–12 on ${
        formatDate(x.claudeReads[0].ts)
      }).`,
  );
  assertStringIncludes(principles, "PD-AI 5.4, as recorded by you:");
  assertStringIncludes(section(sum, "open")[0], "Still to check: 14 items");
  assertMatch(
    section(sum, "record")[0],
    /^Log checked: no changes found \(since \d+ \w+ \d{4}\)\.$/,
  );
  const limits = section(sum, "limits").join("\n");
  assertStringIncludes(limits, "only what happened through casefile");
  // Modest: never claims more than casefile knows.
  const all = sum.text.toLowerCase();
  for (const word of ["verified", "guarantee", "certif", "all documents", "never used", "proves"]) {
    assert(!all.includes(word), `the summary says "${word}"`);
  }
  // Names only where the user typed them (titles); no labels leak into the summary.
  assert(!sum.text.includes("{{"), "no labels in the summary");
  assertStringIncludes(sum.text, "If the Court asks: use of AI (PD-AI 4.11)");
  s.close();
});

Deno.test("forging Claude-writable columns in public.db raises no count and hides nothing", async () => {
  const { s, w } = await canonWork();
  const before = await courtSummary(s);
  const queue = await toCheck(s);
  const db = s.store.db;
  const ts = new Date().toISOString();
  const fake = "a".repeat(64);
  // Claude marks its own unchecked work as checked, adopted, the user's, removed and done.
  for (const id of [...w.chronology.toCheck, w.chronology.cantCheck]) {
    db.prepare(
      "UPDATE chronology SET verified_at = ?, verified_sig = ?, removed_at = ?, removed_by = 'user', created_by = 'user' WHERE id = ?",
    ).run(ts, fake, ts, id);
  }
  for (const id of w.evidence.toCheck) {
    db.prepare(
      "UPDATE evidence SET verified_at = ?, verified_sig = ?, removed_at = ? WHERE id = ?",
    ).run(ts, fake, ts, id);
  }
  const medical = w.issues.find((i) => !i.checked)!.id;
  db.prepare("UPDATE issues SET verified_at = ?, verified_sig = ?, removed_at = ? WHERE id = ?")
    .run(ts, fake, ts, medical);
  const [, , , p4, p5, p6] = w.paragraphs;
  db.prepare("UPDATE paragraphs SET adopted_at = ?, adopted_sig = ? WHERE id = ?").run(
    ts,
    fake,
    p5,
  );
  db.prepare("UPDATE paragraphs SET author = 'user' WHERE id IN (?, ?)").run(p4, p6);
  // ...and writes log rows claiming to be the user's paste uses and checks.
  for (const action of ["reidentified_text", "paste_viewed", "verified", "document_imported"]) {
    db.prepare("INSERT INTO ai_log(ts, actor, action, detail) VALUES (?, 'user', ?, ?)")
      .run(ts, action, JSON.stringify({ what: "chronology", detectors: ["llm"] }));
  }

  const after = await courtSummary(s);
  for (const k of ["chronology", "evidence", "issues", "paragraphs", "paste", "languageModel"]) {
    const key = k as keyof typeof after.figures;
    assertEquals(after.figures[key], before.figures[key], k);
  }
  assertEquals((await toCheck(s)).total, queue.total);
  assertEquals((await toCheck(s)).groups, queue.groups);
  // The forged rows are reported: the log no longer checks out.
  s.log("app", "case_opened", {}); // seals (countersigns) them, as the app does on its next write
  const sealed = await courtSummary(s);
  assertEquals(sealed.figures.log.intact, false);
  assertStringIncludes(section(sealed, "record")[0], "Log checked: casefile found a problem");
  s.close();
});

Deno.test("an empty case: no AI use recorded, nothing to check, nothing kept from Claude", async () => {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Empty", { kdfIterations: 1_000 });
  const sum = await courtSummary(s);
  assertEquals(section(sum, "ai_used"), ["casefile has no record of Claude using this case."]);
  assertEquals(section(sum, "open"), ["Nothing is waiting to be checked."]);
  assertStringIncludes(
    section(sum, "principles").join("\n"),
    "No documents were kept from Claude.",
  );
  assertStringIncludes(
    section(sum, "principles").join("\n"),
    "No PD-AI 5.4 confirmations are recorded.",
  );
  assertEquals(sum.figures.drafts, []);
  s.close();
});

Deno.test("a commercial plan's PD-AI 5.5 conditions are stated as recorded by the user", async () => {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Commercial", { kdfIterations: 1_000 });
  await s.updateSettings({
    plan: {
      setup: "commercial",
      at: "2025-09-03T02:00:00.000Z",
      conditions: { closedEnvironment: true, noTraining: true, thisCaseOnly: true },
    },
  });
  const sum = await courtSummary(s);
  assertStringIncludes(
    section(sum, "tools")[0],
    "Plan: a commercial plan with no-training terms, as recorded by you on 3 September 2025.",
  );
  assertStringIncludes(
    section(sum, "principles").join("\n"),
    "PD-AI 5.5, as recorded by you on 3 September 2025",
  );
  s.close();
});

Deno.test("a forged row claiming chain_kind 'signed' and actor 'user' is never counted", async () => {
  const { s } = await canonWork();
  const before = (await courtSummary(s)).figures;
  const db = s.store.db;
  // A plausible seal: real rows' seals are 64 hex characters, so copy the shape (and a real one).
  const last = db.prepare(
    "SELECT chain FROM ai_log WHERE chain IS NOT NULL ORDER BY id DESC LIMIT 1",
  )
    .get() as { chain: string };
  const forge = (action: string, detail: unknown, chain: string) =>
    db.prepare(
      "INSERT INTO ai_log(ts, actor, action, detail, chain, chain_kind) VALUES (?, 'user', ?, ?, ?, 'signed')",
    ).run(new Date().toISOString(), action, JSON.stringify(detail), chain);
  forge("paste_added", { draft: 1, paragraphs: 40 }, last.chain);
  forge("paste_viewed", { chars: 10 }, "f".repeat(64));
  forge("document_imported", { doc: "D099", detectors: ["rules", "llm", "ner"] }, "0".repeat(64));
  // ...and alters a genuine signed paste row's detail, keeping its seal.
  const real = db.prepare(
    "SELECT id FROM ai_log WHERE action = 'reidentified_text' AND chain_kind = 'signed' LIMIT 1",
  ).get() as { id: number };
  db.prepare("UPDATE ai_log SET action = 'paste_added', detail = ? WHERE id = ?")
    .run(JSON.stringify({ draft: 1, paragraphs: 9 }), real.id);

  const after = (await courtSummary(s)).figures;
  // The altered genuine row no longer counts at all; nothing forged is added.
  assertEquals(after.paste, { views: before.paste.views - 1, copies: 0, passagesAdded: 2 });
  assertEquals(after.languageModel, before.languageModel);
  assertEquals(after.nameFinder, before.nameFinder);
  assertEquals(after.log.intact, false);
  const log = await sealedLog(s);
  const forged = log.filter((r) => r.record === "forged");
  assertEquals(forged.length, 4);
  assert(forged.every((r) => r.actor === "user"));
  // Rows after a forged one still verify on their own.
  s.log("user", "paste_viewed", { chars: 5 });
  assertEquals((await sealedLog(s)).at(-1)!.record, "signed");
  assertEquals((await courtSummary(s)).figures.paste.views, before.paste.views);
  s.close();
});
