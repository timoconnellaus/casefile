/**
 * Every action the code logs has a plain-language label in the AI-use log (summary.ts LABELS),
 * labels and detail notes never echo free text from a row's detail, and copying the Court summary
 * is logged. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl } from "@std/path";
import { describeLogRow, LABELLED_ACTIONS, type SealedRow } from "../src/core/summary.ts";
import { withCase } from "./helpers/app.ts";

const SRC = fromFileUrl(new URL("../src/", import.meta.url));

/** Template actions (`cli:tag_${sub}`) and the values the code fills them with. */
const TEMPLATES: Record<string, string[]> = { "cli:tag_": ["add", "rm"] };

/**
 * Every action string in a `log("user"|"app"|"claude", <action>, …)` call in the source, across
 * line breaks, including both arms of a ternary and template prefixes.
 */
async function loggedActions(): Promise<{ actions: Set<string>; templates: Set<string> }> {
  const actions = new Set<string>();
  const templates = new Set<string>();
  const call = /\blog\(\s*"(?:user|app|claude)",\s*([^,]*?(?:\?[^:,]*:[^,]*?)?)\s*[,)]/gs;
  for await (const f of walk(SRC, { exts: [".ts"], includeDirs: false })) {
    const text = await Deno.readTextFile(f.path);
    for (const m of text.matchAll(call)) {
      const expr = m[1];
      for (const s of expr.matchAll(/"([a-z_:]+)"/g)) actions.add(s[1]);
      for (const t of expr.matchAll(/`([a-z_:]+)\$\{/g)) templates.add(t[1]);
      assert(
        /"[a-z_:]+"|`[a-z_:]+\$\{/.test(expr),
        `${f.path}: a log call whose action this test can't read: ${expr}`,
      );
    }
  }
  return { actions, templates };
}

Deno.test("every action the source logs has a plain-language label", async () => {
  const { actions, templates } = await loggedActions();
  // Sanity: the scan finds the calls (multi-line ones and ternaries included).
  for (
    const a of [
      "pd_ai_confirmed",
      "recovery_key_replaced",
      "recovery_key_created",
      "note_undone",
      "exposure_check_failed",
      "cli:docs_show",
    ]
  ) assert(actions.has(a), `scan missed ${a}`);
  assert(actions.size > 80, `only ${actions.size} actions found`);
  const missing = [...actions].filter((a) => !LABELLED_ACTIONS.has(a)).sort();
  assertEquals(missing, [], "actions logged without a label in summary.ts LABELS");
  for (const t of templates) {
    assert(TEMPLATES[t], `unknown template action ${t}\${…}: add it to TEMPLATES`);
    for (const v of TEMPLATES[t]) assert(LABELLED_ACTIONS.has(t + v), `${t + v} has no label`);
  }
  // No label is left for an action nothing logs any more (court_summary_copied is logged by a
  // route, so it is in the scan too).
  // Retired actions keep their labels: rows written by older builds are still in the log.
  const RETIRED = new Set(["reidentified_text"]); // POST /api/reidentify, removed in W3-4
  const stale = [...LABELLED_ACTIONS].filter((a) =>
    !actions.has(a) && !RETIRED.has(a) &&
    !Object.entries(TEMPLATES).some(([p, vs]) => vs.some((v) => p + v === a))
  );
  assertEquals(stale.sort(), [], "labels for actions nothing logs");
});

function row(action: string, detail: Record<string, unknown>, actor = "claude"): SealedRow {
  return {
    id: 1,
    ts: "2025-10-07T01:00:00.000Z",
    actor: actor as SealedRow["actor"],
    action,
    detail,
    record: "signed",
  } as SealedRow;
}

Deno.test("labels and notes show ids, citations and counts, never free text Claude wrote", () => {
  const secret = "Anna Thornbury";
  const cases: [string, Record<string, unknown>][] = [
    ["cli:chrono_add", { id: 3, sources: ["D001:1-2", secret, "D002:9"] }],
    ["cli:evidence_add", { id: 1, issue: 2, source: secret }],
    ["cli:note_add", { id: 1, on: `${secret} lives at` }],
    ["cli:search", { query: secret, hits: [{ doc: "D001", line: 1 }, { doc: secret }] }],
    ["cli:docs_show", { doc: secret, lines: "1-2" }],
    ["documents_redetected", { docs: ["D015", secret] }],
    ["pd_ai_confirmed", { items: ["help_improve_off", secret] }],
  ];
  for (const [action, detail] of cases) {
    const e = describeLogRow(row(action, detail));
    assert(!`${e.label} ${e.note ?? ""}`.includes(secret), `${action}: ${e.label} / ${e.note}`);
  }
  const chrono = describeLogRow(row("cli:chrono_add", cases[0][1]));
  assertEquals(chrono.note, "Cites D001:1–2 and D002:9");
  const search = describeLogRow(row("cli:search", cases[3][1]));
  assertEquals(search.note, "Results in D001");
  const conf = describeLogRow(row("pd_ai_confirmed", { items: ["help_improve_off"] }, "user"));
  assertEquals(conf.category, "settings");
  assertStringIncludes(conf.label, "PD-AI 5.4");
  assertEquals(conf.note, "“Help improve Claude” is off");
  const pub = describeLogRow(row("document_published", { doc: "D001", replacements: 3 }, "app"));
  assertEquals(pub.note, "3 names replaced");
  // An unlabelled action still reads as words, with no note.
  const other = describeLogRow(row("cli:something_new", {}));
  assertEquals([other.label, other.note], ["Claude: something new", null]);
});

Deno.test("POST /api/court-summary/copied logs the copy, and needs the session", async () => {
  const t = await withCase();
  try {
    assertEquals((await t.other.post("/api/court-summary/copied")).status, 401);
    const r = await t.user.post("/api/court-summary/copied");
    assertEquals(r.status, 200, r.text);
    const log = await t.user.get("/api/log/entries?limit=1");
    assertEquals(log.json.rows[0].action, "court_summary_copied");
    assertEquals(log.json.rows[0].label, "You copied the “If the Court asks” summary");
    assertEquals(log.json.rows[0].category, "case");
    assertEquals(log.json.rows[0].detail, {});
  } finally {
    t.state.session?.close();
  }
});
