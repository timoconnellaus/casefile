/**
 * The To-check queue, the Court summary and the readable AI-use log through the API (W1-H,
 * ADR 0018), on the CANON case. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { assertNoSecrets, assertSecurityHeaders, withCase } from "./helpers/app.ts";
import { cliLog, seedCanonWork } from "./helpers/canon_work.ts";

async function canonApp() {
  const t = await withCase();
  const w = await seedCanonWork(t.state.session!);
  return { ...t, w };
}

Deno.test("CANON: To check is 14, grouped as in CANON, most serious first", async () => {
  const { user, state } = await canonApp();
  const r = await user.get("/api/to-check");
  assertEquals(r.status, 200, r.text);
  assertSecurityHeaders(r, "to-check");
  assertEquals(r.json.total, 14);
  assertEquals(r.json.groups, [
    { what: "Exposed documents", count: 1 },
    { what: "Documents to review", count: 2 },
    { what: "Chronology entries", count: 5 },
    { what: "Evidence links", count: 2 },
    { what: "Affidavit paragraphs", count: 3 },
    { what: "Issue descriptions", count: 1 },
  ]);
  const items = r.json.items;
  assertEquals(items.length, 14);
  // Exposed (danger) comes first.
  assertEquals(items[0].kind, "document");
  assertEquals(items[0].id, "D006");
  assertEquals(items[0].state, "exposed");
  assertEquals(items[0].level, "danger");
  assertEquals(items[0].where, { doc: "D006", href: "#/doc/D006" });
  assertMatch(
    items[0].detail,
    /^D006 Letter from the other side's lawyer: withdrawn from Claude on \d+ \w+ \d{4}$/,
  );
  // Every danger item precedes every attention item.
  const firstAttention = items.findIndex((i: { level: string }) => i.level === "attention");
  assert(items.slice(firstAttention).every((i: { level: string }) => i.level === "attention"));
  // Documents to review: D015, D016, opened in Review.
  const review = items.filter((i: { what: string }) => i.what === "Documents to review");
  assertEquals(review.map((i: { id: string }) => i.id), ["D015", "D016"]);
  assertEquals(review[0].where.href, "#/review/D015");
  assertEquals(review[0].actor, "user");
  // Evidence: D001:3 and D001:6 under "Reliability of changeovers".
  const ev = items.filter((i: { kind: string }) => i.kind === "evidence");
  assertEquals(ev.map((i: { detail: string }) => i.detail), [
    'D001:3 for "Reliability of changeovers"',
    'D001:6 for "Reliability of changeovers"',
  ]);
  // The main checking example reads with real names.
  const main = items.find((i: { detail: string }) => i.detail.startsWith("14 March 2025"));
  assertEquals(
    main.detail,
    "14 March 2025: Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.",
  );
  // The first citation as the store orders them (by document, then line).
  assertEquals(main.where.doc, "D001");
  assertEquals(main.where.line, 1);
  // The whole range and the other source, so the list can say "D001:1–2 +1" (QA T1).
  assertEquals(main.where.line_end, 2);
  assertEquals(main.where.more, 1);
  assertEquals(main.actor, "claude");
  // The 14 March entry stays "To check": the Lachlan row is a caution, not a mix-up.
  assertEquals(main.state, "to_check");
  assertEquals(main.level, "attention");
  assertEquals(main.next, "Check it against the document.");
  // Affidavit paragraphs 4, 5 and 6; the issue is Claude's "Medical care".
  const paras = items.filter((i: { kind: string }) => i.kind === "paragraph");
  assertEquals(
    paras.map((i: { detail: string }) => i.detail).sort(),
    [4, 5, 6].map((n) => `Affidavit of Anna Thornbury, paragraph ${n}`),
  );
  const issue = items.find((i: { kind: string }) => i.kind === "issue");
  assertEquals(issue.detail, `Claude's description of "Medical care"`);
  for (const i of items) {
    assert(!i.detail.includes("{{"), `labels in ${i.detail}`);
    assert(i.next && i.where.href.startsWith("#/"), JSON.stringify(i));
  }
  state.session!.close();
});

Deno.test({
  name: "the 29 March entry is Can't check and comes straight after the exposure",
  fn: async () => {
    const { user, state, w } = await canonApp();
    const items = (await user.get("/api/to-check")).json.items;
    assertEquals(items[1].kind, "chronology");
    assertEquals(items[1].id, String(w.chronology.cantCheck));
    assertEquals(items[1].state, "cant_check");
    assertEquals(items[1].level, "danger");
    state.session!.close();
  },
});

Deno.test("¶4 is 'rewritten by you, adopt to confirm' in the queue", async () => {
  const { user, state, w } = await canonApp();
  const items = (await user.get("/api/to-check")).json.items;
  const p4 = items.find((i: { id: string; kind: string }) =>
    i.kind === "paragraph" && i.id === String(w.paragraphs[3])
  );
  assertEquals(p4.state, "claude_rewritten");
  assertEquals(p4.next, "You rewrote Claude's draft. Use these words as your own to confirm.");
  state.session!.close();
});

Deno.test("checking an item takes it off the queue", async () => {
  const { user, state, w } = await canonApp();
  await state.session!.verifyEvidence(w.evidence.toCheck[0]);
  const r = await user.get("/api/to-check");
  assertEquals(r.json.total, 13);
  assertEquals(
    r.json.groups.find((g: { what: string }) => g.what === "Evidence links").count,
    1,
  );
  state.session!.close();
});

Deno.test("GET /api/court-summary gives sections, figures and copyable text", async () => {
  const { user, state } = await canonApp();
  const r = await user.get("/api/court-summary");
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.title, "If the Court asks: use of AI (PD-AI 4.11)");
  assertEquals(r.json.sections.length, 7);
  assertEquals(r.json.figures.open.total, 14);
  assertEquals(r.json.figures.evidence.checked, 9);
  assertStringIncludes(r.json.text, "Whether AI was used");
  assertStringIncludes(r.json.text, "What this summary cannot show");
  assertNoSecrets(JSON.stringify(r.json.figures.log), "log figures");
  state.session!.close();
});

Deno.test("/api/log/entries: plain labels, categories, filters and paging", async () => {
  const { user, state } = await canonApp();
  const all = await user.get("/api/log/entries");
  assertEquals(all.status, 200, all.text);
  assert(all.json.total > 20);
  assertEquals(all.json.rows.length, Math.min(100, all.json.total));
  assertEquals(all.json.categories[0], { id: "claude", label: "Claude's use" });
  // Newest first.
  assert(all.json.rows[0].id > all.json.rows[1].id);
  const row = all.json.rows[0];
  for (const k of ["id", "ts", "actor", "who", "action", "label", "category", "doc", "detail"]) {
    assert(k in row, k);
  }
  assertEquals(row.record, "signed");

  const claude = await user.get("/api/log/entries?what=claude");
  assertEquals(claude.json.total, 2);
  assertEquals(
    claude.json.rows.map((r: { label: string }) => r.label),
    ["Claude read the chronology", "Claude read D006 (lines 1–12)"],
  );
  assert(claude.json.rows.every((r: { who: string }) => r.who === "Claude"));
  assert(claude.json.rows.every((r: { record: string }) => r.record === "countersigned"));

  const d006 = await user.get("/api/log/entries?doc=D006");
  assertEquals(
    d006.json.rows.map((r: { label: string }) => r.label).reverse(),
    [
      "You added D006 to the case",
      "You shared D006 with Claude (names replaced)",
      "Claude read D006 (lines 1–12)",
      "casefile withdrew D006 from Claude: it showed a name or number casefile knows",
    ],
  );
  assertEquals(d006.json.rows[0].doc, "D006");

  const paste = await user.get("/api/log/entries?what=paste&actor=user");
  assertEquals(paste.json.total, 4);
  assertEquals(
    paste.json.rows[0].label,
    "You added Claude's text to draft 1 as Claude's paragraphs",
  );
  assertEquals(paste.json.rows[1].label, "You viewed Claude's text with real names");

  const page = await user.get("/api/log/entries?offset=1&limit=2");
  assertEquals(page.json.total, all.json.total);
  assertEquals(page.json.rows.map((r: { id: number }) => r.id), [
    all.json.rows[1].id,
    all.json.rows[2].id,
  ]);

  const today = new Date().toISOString().slice(0, 10);
  assertEquals(
    (await user.get(`/api/log/entries?from=${today}&to=${today}`)).json.total,
    all.json.total,
  );
  assertEquals((await user.get("/api/log/entries?to=2000-01-01")).json.total, 0);

  for (
    const bad of [
      "what=nonsense",
      "actor=root",
      "doc=../x",
      "from=yesterday",
      "limit=0",
      "limit=501",
      "offset=-1",
    ]
  ) {
    assertEquals((await user.get(`/api/log/entries?${bad}`)).status, 400, bad);
  }
  state.session!.close();
});

Deno.test("a log row claiming to be the user's that casefile did not write shows as Unknown", async () => {
  const { user, state } = await canonApp();
  state.session!.store.db.prepare(
    "INSERT INTO ai_log(ts, actor, action, detail) VALUES (?, 'user', 'verified', ?)",
  ).run(new Date().toISOString(), JSON.stringify({ what: "chronology", id: 1 }));
  const pending = (await user.get("/api/log/entries?limit=1")).json.rows[0];
  assertEquals(pending.who, "Unknown");
  assertEquals(pending.record, "forged");
  state.session!.log("app", "case_opened", {}); // seals it
  const rows = (await user.get("/api/log/entries?limit=2")).json.rows;
  assertEquals(rows[1].who, "Unknown");
  assertEquals(rows[1].record, "forged");
  state.session!.close();
});

Deno.test("/api/log/export downloads the whole log as CSV and logs the download", async () => {
  const { user, state } = await canonApp();
  // Claude can write log details; a formula must not run when the user opens the file.
  cliLog(state.session!, "cli:search", { query: '=HYPERLINK("http://x")', hits: [] });
  const r = await user.get("/api/log/export");
  assertEquals(r.status, 200);
  assertSecurityHeaders(r, "log export");
  assertEquals(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assertMatch(
    r.headers.get("content-disposition")!,
    /^attachment; filename="casefile-ai-use-log-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  const lines = r.text.trim().split("\r\n");
  assertEquals(lines[0], "entry,time,who,what,category,document,record,action,detail");
  assertStringIncludes(r.text, "Claude read D006 (lines 1–12)");
  for (const line of lines) {
    for (const cell of line.split(",")) assert(!/^"?[=+@]/.test(cell), cell);
  }
  assertNoSecrets(r.text, "log export");
  const last = (await user.get("/api/log/entries?limit=1")).json.rows[0];
  assertEquals(last.action, "log_exported");
  assertEquals(last.label, "You downloaded the full log");
  state.session!.close();
});

Deno.test("the new routes need an unlocked case", async () => {
  const { user, other, state } = await canonApp();
  for (
    const path of ["/api/to-check", "/api/court-summary", "/api/log/entries", "/api/log/export"]
  ) {
    assertEquals((await other.get(path)).status, 401, path);
  }
  await user.post("/api/lock");
  for (
    const path of ["/api/to-check", "/api/court-summary", "/api/log/entries", "/api/log/export"]
  ) {
    assertEquals((await user.get(path)).status, 423, path);
  }
  state.session?.close();
});

Deno.test("a row forged with chain_kind 'signed' and a plausible seal shows as Unknown and forged", async () => {
  const { user, state } = await canonApp();
  const db = state.session!.store.db;
  const last = db.prepare(
    "SELECT chain FROM ai_log WHERE chain IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get() as { chain: string };
  db.prepare(
    "INSERT INTO ai_log(ts, actor, action, detail, chain, chain_kind) VALUES (?, 'user', 'verified', ?, ?, 'signed')",
  ).run(new Date().toISOString(), JSON.stringify({ what: "chronology", id: 1 }), last.chain);
  const row = (await user.get("/api/log/entries?limit=1")).json.rows[0];
  assertEquals(row.action, "verified");
  assertEquals(row.who, "Unknown");
  assertEquals(row.record, "forged");
  const youRows = (await user.get("/api/log/entries?what=checking")).json.rows;
  assert(
    youRows.every((r: { who: string; record: string }) =>
      r.record !== "forged" || r.who === "Unknown"
    ),
  );
  const csv = (await user.get("/api/log/export")).text;
  assertStringIncludes(csv, "Unknown,You checked a chronology entry against its source");
  state.session!.close();
});
