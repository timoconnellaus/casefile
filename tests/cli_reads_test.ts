/**
 * W1-A: the CLI records what Claude read through casefile, draft paragraphs carry their sources,
 * removed items are hidden from Claude but never open a gate, and withheld documents say why in
 * plain English (ADR 16). SYNTHETIC data only (ADR 11): the CANON case.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { COLLECT_FLAGS, normaliseArgv, run, STRING_FLAGS } from "../src/cli/commands.ts";
import { CLAUDE_GUIDE } from "../src/core/guide.ts";
import {
  MAX_LOGGED_HITS,
  type Origin,
  PublicStore,
  type WithheldReason,
} from "../src/core/publicdb.ts";
import { CaseSession } from "../src/core/session.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { PASS } from "./fixtures/case.ts";
import { SECRETS, tempDir } from "./fixtures/synthetic.ts";

const CLI = fromFileUrl(new URL("../src/cli/main.ts", import.meta.url));

/** A CANON case (D001 and D002 shared); the session is closed. */
async function canonDir() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  await seedCanon(s);
  s.close();
  return dir;
}

async function cli(dir: string, argv: string[], stdin = "") {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: ["json", "help"],
    collect: [...COLLECT_FLAGS],
    string: STRING_FLAGS,
  });
  return await run(args, { cwd: dir, env: {}, readStdin: () => Promise.resolve(stdin) });
}

async function ok(dir: string, argv: string[], stdin = "") {
  const r = await cli(dir, argv, stdin);
  assertEquals(r.code, 0, `${argv.join(" ")}: ${r.err}`);
  return r;
}

async function refused(dir: string, argv: string[], includes: string) {
  const r = await cli(dir, argv);
  assertEquals(r.code, 1, `${argv.join(" ")} should be refused: ${r.out}`);
  assertStringIncludes(r.err, includes);
  return r;
}

function withStore<T>(dir: string, fn: (s: PublicStore) => T): T {
  const s = PublicStore.open(join(dir, "public.db"));
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

/** Claude's raw SQL, as from a shell. */
function rawSql(dir: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(join(dir, "public.db"));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Log rows Claude wrote with this action, details parsed, oldest first. */
function logged(dir: string, action: string): Record<string, unknown>[] {
  return withStore(
    dir,
    (s) =>
      s.listLog(1000).filter((r) => r.action === action).reverse().map((r) => JSON.parse(r.detail)),
  );
}

// ── paragraph sources ───────────────────────────────────────────────────────

Deno.test("para add --source (repeatable) and --relies round-trip, print and are logged", async () => {
  const dir = await canonDir();
  await ok(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "{{father}} late",
    "--source",
    "D001:1-2",
  ]);
  await ok(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit of {{mother}}"]);
  const add = await ok(dir, [
    "para",
    "add",
    "1",
    "--text",
    "{{father.first}} was late again.",
    "--source",
    "D001:3",
    "--source",
    "D001:5-6",
    "--relies",
    "chrono:1",
    "--json",
  ]);
  const id = JSON.parse(add.out).id;
  withStore(dir, (s) => {
    assertEquals(s.listParagraphSources(id), [
      { doc_id: "D001", line_start: 3, line_end: 3 },
      { doc_id: "D001", line_start: 5, line_end: 6 },
    ]);
    assertEquals(s.listParagraphLinks(id), [{ target_type: "chronology", target_id: 1 }]);
  });
  const list = await ok(dir, ["para", "list", "1"]);
  assertStringIncludes(list.out, `[para ${id}, claude] {{father.first}} was late again.`);
  assertStringIncludes(list.out, "sources: D001:3, D001:5-6; relies on: chrono:1");
  assertStringIncludes(
    (await ok(dir, ["para", "show", String(id)])).out,
    "sources: D001:3, D001:5-6",
  );
  assertStringIncludes((await ok(dir, ["draft", "show", "1"])).out, "sources: D001:3, D001:5-6");
  const json = JSON.parse((await ok(dir, ["para", "show", String(id), "--json"])).out);
  assertEquals(json.sources.length, 2);
  assertEquals(json.relies, [{ target_type: "chronology", target_id: 1 }]);
  assertEquals(logged(dir, "cli:para_add").at(-1), {
    id,
    draft: 1,
    sources: ["D001:3", "D001:5-6"],
    relies: ["chrono:1"],
  });
  // Viewing paragraphs records the lines they cite.
  assertEquals(logged(dir, "cli:para_list").at(-1)?.cited, [
    { doc: "D001", lines: "3" },
    { doc: "D001", lines: "5-6" },
  ]);
  assertEquals(logged(dir, "cli:draft_show").at(-1)?.cited, [
    { doc: "D001", lines: "3" },
    { doc: "D001", lines: "5-6" },
  ]);

  // para edit replaces the lists, and can change them without the text.
  await ok(dir, ["para", "edit", String(id), "--source", "D002:9"]);
  withStore(dir, (s) => {
    assertEquals(s.listParagraphSources(id), [{ doc_id: "D002", line_start: 9, line_end: 9 }]);
    assertEquals(s.getParagraph(id).body, "{{father.first}} was late again.");
    assertEquals(s.listParagraphLinks(id).length, 1, "--relies not given: unchanged");
  });
  await ok(dir, ["para", "edit", String(id), "--relies", "none"]);
  withStore(dir, (s) => assertEquals(s.listParagraphLinks(id), []));
  const usage = await cli(dir, ["para", "edit", String(id)]);
  assertEquals(usage.code, 2);
  // Bad references are refused and nothing is written.
  await refused(dir, ["para", "add", "1", "--text", "x", "--source", "D001:99"], "out of range");
  await refused(dir, ["para", "add", "1", "--text", "x", "--relies", "chrono:42"], "Not found");
  assertEquals(
    (await cli(dir, ["para", "add", "1", "--text", "x", "--relies", "issue:1"])).code,
    2,
  );
  withStore(dir, (s) => assertEquals(s.listParagraphs(1).length, 1));
});

Deno.test("an adopted paragraph's sources cannot be changed", async () => {
  const dir = await canonDir();
  await ok(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit"]);
  await ok(dir, ["para", "add", "1", "--text", "Text.", "--source", "D001:3"]);
  rawSql(dir, "UPDATE paragraphs SET adopted_at = 't' WHERE id = 1");
  await refused(dir, ["para", "edit", "1", "--source", "D001:4"], "adopted by the user");
  withStore(
    dir,
    (s) =>
      assertEquals(s.listParagraphSources(1), [{ doc_id: "D001", line_start: 3, line_end: 3 }]),
  );
});

Deno.test("a withheld document cannot be a paragraph's source, and the reason is plain English", async () => {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  await seedCanon(s);
  await s.setOrigin("D002", "court_or_subpoena");
  s.close();
  await ok(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit"]);
  const r = await refused(
    dir,
    ["para", "add", "1", "--text", "Text.", "--source", "D001:3", "--source", "D002:9"],
    "withheld from Claude because it came from a subpoena or the court",
  );
  assert(!r.err.includes("court_or_subpoena"), r.err);
  withStore(dir, (st) => assertEquals(st.listParagraphs(1), [], "nothing was added"));
  // Nor can an existing paragraph be pointed at it.
  await ok(dir, ["para", "add", "1", "--text", "Text.", "--source", "D001:3"]);
  await refused(dir, ["para", "edit", "1", "--source", "D002:9"], "from a subpoena or the court");
});

// ── withheld reasons ────────────────────────────────────────────────────────

Deno.test("withheld documents say why in plain English, never the stored value", async () => {
  const dir = await canonDir();
  const cases: [Origin, WithheldReason | null, string][] = [
    ["other_side", "origin", "because it came from the other side"],
    ["court_or_subpoena", "origin", "because it came from a subpoena or the court"],
    ["under_order", "origin", "because it is under a court order"],
    ["not_sure", "origin", "because the user is not sure where it came from"],
    ["not_sure", "not_asked", "because the user has not said yet where it came from"],
    ["mine", "exposed", "because it was found to show a name or number"],
    ["other_side", null, "because it came from the other side"], // before schema v4
  ];
  withStore(dir, (s) =>
    cases.forEach(([origin, reason], i) =>
      s.publishDocument({
        id: `D${String(10 + i).padStart(3, "0")}`,
        title: `Document ${i}`,
        body: null,
        sensitivity: origin,
        withheld_reason: reason,
      })
    ));
  for (const [i, [origin, reason, phrase]] of cases.entries()) {
    const id = `D${String(10 + i).padStart(3, "0")}`;
    const show = await ok(dir, ["docs", "show", id]);
    assertStringIncludes(show.out, `withheld from Claude ${phrase}`);
    assert(!show.out.includes(origin === "mine" ? "(mine" : origin), show.out);
    if (reason) assert(!show.out.includes(reason), show.out);
    const cite = await refused(
      dir,
      ["chrono", "add", "--date", "2025-01-01", "--text", "x", "--source", `${id}:1`],
      phrase,
    );
    assert(!cite.err.includes(origin), cite.err);
    const list = JSON.parse((await ok(dir, ["docs", "list", "--json"])).out);
    assertStringIncludes(
      list.find((d: { id: string }) => d.id === id).withheld_because,
      phrase.slice(8),
    );
  }
});

// ── removed items ───────────────────────────────────────────────────────────

/** Claude's chronology entry 1, issue 1 with Claude's evidence 1 and 2; all then removed. */
async function removedWork() {
  const dir = await canonDir();
  await ok(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "{{father}} late",
    "--source",
    "D001:1-2",
  ]);
  await ok(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-22",
    "--text",
    "Swimming moved",
    "--source",
    "D001:5",
  ]);
  await ok(dir, ["issue", "add", "--title", "Reliability of changeovers"]);
  await ok(dir, ["evidence", "add", "1", "--source", "D001:3"]);
  await ok(dir, ["evidence", "add", "1", "--source", "D001:6"]);
  return dir;
}

Deno.test("lists and shows leave out removed items", async () => {
  const dir = await removedWork();
  await ok(dir, ["issue", "add", "--title", "Medical care"]);
  withStore(dir, (s) => {
    s.softRemove("chronology", 1, "user");
    s.softRemove("evidence", 2, "user");
    s.softRemove("issue", 2, "user");
  });
  const chrono = await ok(dir, ["chrono", "list"]);
  assert(!chrono.out.includes("#1 "), chrono.out);
  assertStringIncludes(chrono.out, "#2 ");
  assertEquals(logged(dir, "cli:chrono_list").at(-1)?.cited, [{ doc: "D001", lines: "5" }]);
  const issues = await ok(dir, ["issue", "list"]);
  assert(!issues.out.includes("Medical care"), issues.out);
  assertStringIncludes(issues.out, "evidence: 1");
  const show = await ok(dir, ["issue", "show", "1"]);
  assertStringIncludes(show.out, "D001:3");
  assert(!show.out.includes("D001:6"), show.out);
  assertEquals(logged(dir, "cli:issue_show").at(-1)?.cited, [{ doc: "D001", lines: "3" }]);
  await refused(dir, ["issue", "show", "2"], "removed by the user");
  const info = await ok(dir, ["info"]);
  assertStringIncludes(info.out, "Chronology entries: 1 (1 unverified)");
  assertStringIncludes(info.out, "Issues: 1, evidence links: 1");
  // The counts the app uses still include them.
  withStore(dir, (s) => assertEquals(s.stats().chronology, 2));
});

Deno.test("a removed item opens no CLI gate: Claude cannot change or delete it", async () => {
  const dir = await removedWork();
  withStore(dir, (s) => {
    s.softRemove("chronology", 1, "user");
    s.softRemove("evidence", 2, "user");
  });
  await refused(dir, ["chrono", "rm", "1"], "removed by the user");
  await refused(dir, ["chrono", "edit", "1", "--text", "Rewritten"], "removed by the user");
  await refused(dir, ["evidence", "rm", "2"], "removed by the user");
  // Deleting the issue would take the user's removed (restorable) evidence with it.
  await refused(dir, ["issue", "rm", "1"], "#2");
  withStore(dir, (s) => {
    assertEquals(s.getChronology(1).description, "{{father}} late");
    assertEquals(s.getEvidence(2).doc_id, "D001");
    assertEquals(s.getIssue(1).title, "Reliability of changeovers");
  });
  // A removed issue can't be edited, removed or given evidence.
  withStore(dir, (s) => s.softRemove("issue", 1, "user"));
  await refused(dir, ["issue", "edit", "1", "--title", "x"], "removed by the user");
  await refused(dir, ["evidence", "add", "1", "--source", "D001:4"], "removed by the user");
  // ...and a paragraph cannot rely on removed items.
  await ok(dir, ["draft", "new", "--kind", "outline", "--title", "Outline"]);
  await refused(
    dir,
    ["para", "add", "1", "--text", "x", "--relies", "chrono:1"],
    "removed by the user",
  );
  await refused(
    dir,
    ["para", "add", "1", "--text", "x", "--relies", "evidence:2"],
    "removed by the user",
  );
});

Deno.test("Claude cannot delete what a draft paragraph relies on", async () => {
  const dir = await removedWork();
  await ok(dir, ["draft", "new", "--kind", "outline", "--title", "Outline"]);
  await ok(dir, [
    "para",
    "add",
    "1",
    "--text",
    "x",
    "--source",
    "D001:1",
    "--relies",
    "chrono:1",
    "--relies",
    "evidence:1",
  ]);
  await refused(dir, ["chrono", "rm", "1"], "relied on by draft paragraph 1");
  await refused(dir, ["evidence", "rm", "1"], "relied on by draft paragraph 1");
  await refused(dir, ["issue", "rm", "1"], "relied on by draft paragraph 1");
  // Once the paragraph no longer relies on them, they can go, and no link is left dangling.
  await ok(dir, ["para", "edit", "1", "--relies", "chrono:2"]);
  await ok(dir, ["chrono", "rm", "1"]);
  await ok(dir, ["issue", "rm", "1"]);
  await ok(dir, ["para", "rm", "1"]);
});

Deno.test("store deletes leave no paragraph link pointing at a deleted item", () => {
  const s = PublicStore.open(":memory:", { create: true });
  s.publishDocument({ id: "D001", title: "Messages", body: "a\nb\nc", sensitivity: "mine" });
  const c = s.addChronology({ event_date: "2025-01-01", description: "x", sources: [] }, "user");
  const i = s.addIssue({ title: "Issue" }, "user");
  const e1 = s.addEvidence(i, { doc_id: "D001", line_start: 1, line_end: 1 }, "user");
  const e2 = s.addEvidence(i, { doc_id: "D001", line_start: 2, line_end: 2 }, "user");
  const d = s.createDraft({ kind: "outline", title: "O" }, "user");
  const p = s.addParagraph(d, "Text", "user");
  s.setParagraphLinks(p, [
    { target_type: "chronology", target_id: c },
    { target_type: "evidence", target_id: e1 },
    { target_type: "evidence", target_id: e2 },
  ]);
  assertEquals(s.paragraphsRelyingOn("chronology", c), [p]);
  s.deleteChronology(c);
  s.deleteEvidence(e1);
  assertEquals(s.listParagraphLinks(p), [{ target_type: "evidence", target_id: e2 }]);
  s.deleteIssue(i);
  assertEquals(s.listParagraphLinks(p), []);
  assertThrows(() => s.getEvidence(e2));
  s.close();
});

// ── what Claude read ────────────────────────────────────────────────────────

Deno.test("search shows only hits it logs: every line Claude sees is in the log", async () => {
  const dir = await canonDir();
  const n = MAX_LOGGED_HITS + 50;
  withStore(dir, (s) =>
    s.publishDocument({
      id: "D003",
      title: "Notes",
      body: Array.from({ length: n }, (_, i) => `Note ${i + 1} about swimming`).join("\n"),
      sensitivity: "mine",
    }));
  for (const json of [false, true]) {
    const r = await ok(dir, [
      "search",
      "swimming",
      "--limit",
      String(n + 10),
      ...(json ? ["--json"] : []),
    ]);
    const shown: string[] = json
      ? JSON.parse(r.out).map((h: { doc_id: string; line: number }) => `${h.doc_id}:${h.line}`)
      : r.out.split("\n").filter((l) => /^D\d{3}:\d+ /.test(l)).map((l) => l.split(" ")[0]);
    const d = logged(dir, "cli:search").at(-1)!;
    assertEquals(d.query, "swimming");
    const hits = d.hits as { doc: string; line: number }[];
    assertEquals(hits.map((h) => `${h.doc}:${h.line}`), shown, "every hit shown is logged");
    assertEquals(hits.length, MAX_LOGGED_HITS);
    assertEquals(d.total, MAX_LOGGED_HITS);
    if (!json) assertStringIncludes(r.out, `showing the first ${MAX_LOGGED_HITS} matches`);
  }
  await ok(dir, ["search", "temperature"]);
  assertEquals(logged(dir, "cli:search").at(-1)?.hits, [{ doc: "D001", line: 7 }]);
});

Deno.test("docs show logs the lines it returned, not the range asked for", async () => {
  const dir = await canonDir();
  await ok(dir, ["docs", "show", "D001"]);
  await ok(dir, ["docs", "show", "D001", "--lines", "5-99"]);
  await ok(dir, ["docs", "show", "D001", "--lines", "3"]);
  await ok(dir, ["docs", "show", "D001", "--lines", "50-60"]);
  assertEquals(logged(dir, "cli:docs_show").map((d) => d.lines), ["1-7", "5-7", "3", ""]);
});

Deno.test("claudeReads and logForDoc collect every read of a document through the CLI", async () => {
  const dir = await canonDir();
  const start = new Date().toISOString();
  await ok(dir, ["docs", "show", "D001", "--lines", "1-2"]);
  await ok(dir, ["search", "temperature"]);
  await ok(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-29",
    "--text",
    "Unwell",
    "--source",
    "D001:7",
    "--source",
    "D002:9",
  ]);
  await ok(dir, ["chrono", "list"]);
  await ok(dir, ["issue", "add", "--title", "Medical care"]);
  await ok(dir, ["evidence", "add", "1", "--source", "D001:7"]);
  await ok(dir, ["issue", "show", "1"]);
  withStore(dir, (s) => {
    const reads = s.claudeReads("D001", { from: start });
    assertEquals(reads.map((r) => [r.action, r.lines]), [
      ["cli:docs_show", "1-2"],
      ["cli:search", "7"],
      ["cli:chrono_list", "7"],
      ["cli:issue_show", "7"],
    ]);
    assertEquals(s.claudeReads("D002").map((r) => r.action), ["cli:chrono_list"]);
    assertEquals(s.claudeReads("D001", { to: "2000-01-01" }), []);
    const actions = s.logForDoc("D001").map((r) => r.action);
    for (const a of ["cli:docs_show", "cli:search", "cli:chrono_list", "cli:issue_show"]) {
      assert(actions.includes(a), a);
    }
    // Malformed details written by hand are skipped, not fatal.
    s.db.prepare(
      "INSERT INTO ai_log(ts, actor, action, detail) VALUES ('t', 'claude', 'x', 'nope')",
    )
      .run();
    s.db.prepare(
      `INSERT INTO ai_log(ts, actor, action, detail) VALUES ('t', 'claude', 'x', '{"hits":[1,"D001",null]}')`,
    ).run();
    assertEquals(s.claudeReads("D001").length, reads.length);
  });
});

// ── entities, guide, originals ─────────────────────────────────────────────

Deno.test("entities prints the user's description of each role", async () => {
  const dir = await canonDir();
  withStore(dir, (s) =>
    s.setEntities([
      { role: "mother", kind: "person", description: "The applicant; the children live with her" },
      { role: "father", kind: "person", description: null },
    ]));
  const r = await ok(dir, ["entities"]);
  assertStringIncludes(r.out, "ABOUT");
  assertStringIncludes(r.out, "The applicant; the children live with her");
  const json = JSON.parse((await ok(dir, ["entities", "--json"])).out);
  assertEquals(
    json.find((e: { role: string }) => e.role === "mother").description,
    "The applicant; the children live with her",
  );
});

Deno.test("the case guide has the drafting, citing, advice and checking rules", () => {
  for (
    const s of [
      "Never write the witness's feelings, opinions",
      "[In your own words:",
      "--source D001:3",
      "--relies chrono:N",
      "No outcome predictions and no legal advice",
      'Respond to "Can\'t check" notes',
      "What you read through casefile is recorded",
      "from a subpoena or the court",
    ]
  ) assertStringIncludes(CLAUDE_GUIDE, s);
  assert(!/discovery or\s+subpoena material/.test(CLAUDE_GUIDE), "old withheld wording");
});

Deno.test("nothing the new commands print contains an original value", async () => {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  await seedCanon(s);
  await s.setOrigin("D002", "other_side");
  s.close();
  await ok(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit of {{mother}}"]);
  await ok(dir, ["para", "add", "1", "--text", "{{mother.first}} waited.", "--source", "D001:1"]);
  let all = "";
  for (
    const argv of [
      ["para", "list", "1"],
      ["para", "show", "1"],
      ["draft", "show", "1"],
      ["docs", "show", "D002"],
      ["docs", "list", "--json"],
      ["entities"],
      ["log", "--json"],
    ]
  ) {
    const r = await cli(dir, argv);
    all += r.out + r.err;
  }
  for (const secret of [...SECRETS, "Anna", "Okafor", "Kiama"]) {
    assert(!all.includes(secret), `CLI printed "${secret}"`);
  }
});

Deno.test("the real CLI takes repeated --source and --relies", async () => {
  const dir = await canonDir();
  await ok(dir, ["chrono", "add", "--date", "2025-03-14", "--text", "Late", "--source", "D001:1"]);
  await ok(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-22",
    "--text",
    "Swimming",
    "--source",
    "D001:5",
  ]);
  await ok(dir, ["draft", "new", "--kind", "outline", "--title", "Outline"]);
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--deny-net",
      CLI,
      "para",
      "add",
      "1",
      "--text",
      "{{father.first}} was late.",
      "--source",
      "D001:3",
      "--source",
      "D001:5-6",
      "--relies",
      "chrono:1",
      "--relies",
      "chrono:2",
    ],
    cwd: dir,
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  withStore(dir, (s) => {
    assertEquals(s.listParagraphSources(1).length, 2);
    assertEquals(s.listParagraphLinks(1).length, 2);
  });
  assertEquals(logged(dir, "cli:para_add").at(-1)?.sources, ["D001:3", "D001:5-6"]);
});

// ── gate parity (security review) ───────────────────────────────────────────

Deno.test("chrono edit, like chrono rm, is refused while a paragraph relies on the entry", async () => {
  const dir = await removedWork();
  await ok(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit"]);
  await ok(dir, ["para", "add", "1", "--text", "x", "--source", "D001:1", "--relies", "chrono:1"]);
  await refused(
    dir,
    ["chrono", "edit", "1", "--text", "Something else"],
    "relied on by draft paragraph 1",
  );
  await refused(
    dir,
    ["chrono", "edit", "1", "--source", "D001:7"],
    "relied on by draft paragraph 1",
  );
  withStore(dir, (s) => {
    const e = s.getChronology(1);
    assertEquals(e.description, "{{father}} late");
    assertEquals(e.sources, [{ doc_id: "D001", line_start: 1, line_end: 2 }]);
  });
});

Deno.test("chrono edit logs the new date and sources", async () => {
  const dir = await removedWork();
  await ok(dir, ["chrono", "edit", "2", "--date", "2025-03-23", "--source", "D001:5-6"]);
  assertEquals(logged(dir, "cli:chrono_edit").at(-1), {
    id: 2,
    date: "2025-03-23",
    sources: ["D001:5-6"],
  });
});

Deno.test("evidence under a removed issue: rm is refused like add, and no paragraph may rely on it", async () => {
  const dir = await removedWork();
  withStore(dir, (s) => s.softRemove("issue", 1, "user"));
  await refused(dir, ["evidence", "rm", "1"], "removed by the user");
  withStore(dir, (s) => assertEquals(s.getEvidence(1).doc_id, "D001"));
  await ok(dir, ["draft", "new", "--kind", "outline", "--title", "Outline"]);
  await refused(
    dir,
    ["para", "add", "1", "--text", "x", "--relies", "evidence:1"],
    "its issue was removed by the user",
  );
});

Deno.test("Claude cannot overwrite or delete the user's edits to Claude's paragraph", async () => {
  const dir = await canonDir();
  await ok(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit"]);
  await ok(dir, ["para", "add", "1", "--text", "Claude's version.", "--source", "D001:3"]);
  // The user edits it in the app: it stays Claude's (needs adopting) but holds the user's words.
  withStore(
    dir,
    (s) => s.updateParagraph(1, "My own wording.", "claude", { keepClaudeBody: true }),
  );
  await refused(dir, ["para", "edit", "1", "--text", "Claude again."], "edited by the user");
  await refused(dir, ["para", "edit", "1", "--source", "D001:4"], "edited by the user");
  await refused(dir, ["para", "rm", "1"], "edited by the user");
  withStore(dir, (s) => {
    assertEquals(s.getParagraph(1).body, "My own wording.");
    assertEquals(s.listParagraphSources(1), [{ doc_id: "D001", line_start: 3, line_end: 3 }]);
  });
  // Claude's own edits leave it editable.
  await ok(dir, ["para", "add", "1", "--text", "Second."]);
  await ok(dir, ["para", "edit", "2", "--text", "Second, revised."]);
  await ok(dir, ["para", "rm", "2"]);
});
