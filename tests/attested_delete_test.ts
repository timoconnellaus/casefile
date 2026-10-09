/**
 * Design review fixes: Claude must not delete (or edit) work the user verified, adopted or wrote,
 * neither through the CLI nor, undetected, with raw SQL; and deleting an issue must not cascade to
 * the user's evidence (public.db schema v3). SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { normaliseArgv, run, STRING_FLAGS } from "../src/cli/commands.ts";
import { type AdoptionAttestation, adoptParagraph } from "../src/core/drafting.ts";
import { PublicStore } from "../src/core/publicdb.ts";
import { CaseSession } from "../src/core/session.ts";
import { PASS, publishedCase } from "./fixtures/case.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const ATTEST: AdoptionAttestation = { ownKnowledge: true, ownWords: true };
const CHRONO_TEXT = "{{father.first}} collected the children late from {{school}} after training.";

async function cli(dir: string, argv: string[]) {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: ["json", "help"],
    collect: ["source"],
    string: STRING_FLAGS,
  });
  return await run(args, { cwd: dir, env: {}, readStdin: () => Promise.resolve("") });
}

/** Claude's raw SQL, as from a shell (sqlite3 and Python leave foreign keys off). */
function rawSql(dir: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(join(dir, "public.db"), { enableForeignKeyConstraints: false });
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** A case where Claude wrote a chronology entry, an issue with evidence and an affidavit paragraph. */
async function claudeWork() {
  const { s, dir, docId } = await publishedCase();
  const chrono = s.store.addChronology(
    {
      event_date: "2025-03-14",
      description: CHRONO_TEXT,
      // Line 9 names the father and the school, so casefile can check it (W1-C).
      sources: [{ doc_id: docId, line_start: 9, line_end: 9 }],
    },
    "claude",
  );
  const issue = s.store.addIssue({ title: "Changeover arrangements" }, "claude");
  const evidence = s.store.addEvidence(
    issue,
    { doc_id: docId, line_start: 1, line_end: 1, note: "Late collection" },
    "claude",
  );
  const draft = s.store.createDraft({ kind: "affidavit", title: "Affidavit" }, "claude");
  const para = s.store.addParagraph(draft, "I am the mother of {{child_1.first}}.", "claude");
  return { s, dir, docId, chrono, issue, evidence, draft, para };
}

// ── bug 1: the CLI refuses to change what the user verified or adopted ──────

Deno.test("CLI refuses to edit or remove a chronology entry the user verified", async () => {
  const { s, dir, chrono } = await claudeWork();
  await s.verifyChronology(chrono);
  await s.settled();
  s.close();
  for (
    const argv of [
      ["chrono", "rm", String(chrono)],
      ["chrono", "edit", String(chrono), "--text", "Something else"],
    ]
  ) {
    const r = await cli(dir, argv);
    assertEquals(r.code, 1, r.err);
    assertStringIncludes(r.err, "verified by the user");
    assertStringIncludes(r.err, `casefile note add --on chrono:${chrono}`);
  }
  const store = PublicStore.open(join(dir, "public.db"));
  assertEquals(store.getChronology(chrono).description, CHRONO_TEXT);
  store.close();
});

Deno.test("CLI refuses to edit or remove a verified issue or verified evidence", async () => {
  const { s, dir, issue, evidence } = await claudeWork();
  await s.verifyIssue(issue);
  await s.verifyEvidence(evidence);
  await s.settled();
  s.close();
  for (
    const argv of [
      ["issue", "rm", String(issue)],
      ["issue", "edit", String(issue), "--title", "Other"],
      ["evidence", "rm", String(evidence)],
    ]
  ) {
    const r = await cli(dir, argv);
    assertEquals(r.code, 1, `${argv.join(" ")}: ${r.err}`);
    assertStringIncludes(r.err, "verified by the user");
    assertStringIncludes(r.err, `casefile note add --on issue:${issue}`);
  }
  const store = PublicStore.open(join(dir, "public.db"));
  assertEquals(store.getIssue(issue).title, "Changeover arrangements");
  assertEquals(store.getEvidence(evidence).id, evidence);
  store.close();
});

Deno.test("CLI refuses to edit or remove a paragraph the user adopted", async () => {
  const { s, dir, para } = await claudeWork();
  await adoptParagraph(s, para, ATTEST);
  await s.settled();
  s.close();
  for (
    const argv of [
      ["para", "rm", String(para)],
      ["para", "edit", String(para), "--text", "Different words."],
    ]
  ) {
    const r = await cli(dir, argv);
    assertEquals(r.code, 1, r.err);
    assertStringIncludes(r.err, "adopted by the user");
    assertStringIncludes(r.err, `casefile note add --on para:${para}`);
  }
  // Leaving a note is still allowed.
  const note = await cli(dir, ["note", "add", "--on", `para:${para}`, "--text", "Consider a date"]);
  assertEquals(note.code, 0, note.err);
});

Deno.test("CLI still removes Claude's own unverified work", async () => {
  const { s, dir, chrono, issue, evidence, para } = await claudeWork();
  s.close();
  assertEquals((await cli(dir, ["chrono", "rm", String(chrono)])).code, 0);
  assertEquals((await cli(dir, ["para", "rm", String(para)])).code, 0);
  // An issue with only Claude's unverified evidence goes, and its evidence with it (explicitly).
  const r = await cli(dir, ["issue", "rm", String(issue)]);
  assertEquals(r.code, 0, r.err);
  const store = PublicStore.open(join(dir, "public.db"));
  assertThrows(() => store.getEvidence(evidence));
  store.close();
});

// ── bug 2: issue rm must not take the user's evidence with it ────────────────

Deno.test("CLI issue rm is refused while the issue has the user's evidence", async () => {
  const { s, dir, docId, issue } = await claudeWork();
  const userEv = s.store.addEvidence(
    issue,
    { doc_id: docId, line_start: 2, line_end: 2, note: "My own note" },
    "user",
  );
  s.close();
  const r = await cli(dir, ["issue", "rm", String(issue)]);
  assertEquals(r.code, 1, r.err);
  assertStringIncludes(r.err, "evidence the user added, verified or removed");
  assertStringIncludes(r.err, `#${userEv}`);
  const store = PublicStore.open(join(dir, "public.db"));
  assertEquals(store.getEvidence(userEv).note, "My own note");
  store.close();
});

Deno.test("CLI issue rm is refused while the issue has verified evidence", async () => {
  const { s, dir, issue, evidence } = await claudeWork();
  await s.verifyEvidence(evidence);
  await s.settled();
  s.close();
  const r = await cli(dir, ["issue", "rm", String(issue)]);
  assertEquals(r.code, 1, r.err);
  assertStringIncludes(r.err, `#${evidence}`);
});

/**
 * Turn a fresh public.db into a v2 one: without the v4 additions (`downgradeToV3`), and `evidence`
 * with ON DELETE CASCADE, user_version 2.
 */
function downgradeToV2(path: string) {
  downgradeToV3(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN;
    DROP TABLE evidence;
    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '', stance TEXT NOT NULL DEFAULT 'supports',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      verified_at TEXT, verified_sig TEXT
    );
    PRAGMA user_version = 2;
    COMMIT;`);
  db.close();
}

/** Undo schema v4 on a fresh public.db (see V4_CHANGES in publicdb.ts): user_version 3. */
function downgradeToV3(path: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN;
    DROP TABLE paragraph_sources;
    DROP TABLE paragraph_links;
    ALTER TABLE documents DROP COLUMN withheld_reason;
    ALTER TABLE entities DROP COLUMN description;
    ALTER TABLE notes DROP COLUMN done_at;
    ALTER TABLE notes DROP COLUMN done_by;
    ALTER TABLE chronology DROP COLUMN removed_at;
    ALTER TABLE chronology DROP COLUMN removed_by;
    ALTER TABLE evidence DROP COLUMN removed_at;
    ALTER TABLE evidence DROP COLUMN removed_by;
    ALTER TABLE issues DROP COLUMN removed_at;
    ALTER TABLE issues DROP COLUMN removed_by;
    PRAGMA user_version = 3;
    COMMIT;`);
  db.close();
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

Deno.test("schema v3 migration keeps evidence rows and removes the cascade from issues", async () => {
  const path = join(await tempDir(), "public.db");
  PublicStore.open(path, { create: true }).close();
  downgradeToV2(path);
  // A v2 database with an issue and evidence (one verified, ids not contiguous).
  const v2 = new DatabaseSync(path);
  assertEquals(userVersion(v2), 2);
  v2.exec(`
    INSERT INTO issues(id, title, created_by, created_at, updated_at) VALUES (4, 'Issue', 'claude', 't', 't');
    INSERT INTO evidence(id, issue_id, doc_id, line_start, line_end, note, stance, created_by, created_at, verified_at, verified_sig)
      VALUES (7, 4, 'D001', 1, 2, 'user note', 'supports', 'user', 't', NULL, NULL),
             (9, 4, 'D001', 3, 3, 'checked', 'undermines', 'claude', 't', 'vt', 'sig');`);
  // The v2 columns (v4 adds removed_at and removed_by).
  const cols =
    "id, issue_id, doc_id, line_start, line_end, note, stance, created_by, created_at, verified_at, verified_sig";
  const before = JSON.stringify(v2.prepare(`SELECT ${cols} FROM evidence ORDER BY id`).all());
  v2.close();

  const store = PublicStore.open(path); // migrates (through v3 to the current version)
  assertEquals(userVersion(store.db), 4);
  assertEquals(
    JSON.stringify(store.db.prepare(`SELECT ${cols} FROM evidence ORDER BY id`).all()),
    before,
  );
  const sql = (store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'evidence'").get() as {
    sql: string;
  }).sql;
  assert(!/cascade/i.test(sql), sql);
  // With foreign keys on (the CLI and app), deleting the issue directly fails...
  assertThrows(() => store.db.prepare("DELETE FROM issues WHERE id = 4").run());
  store.close();

  // ...and with them off (sqlite3, Python), the issue goes but the evidence stays.
  rawSqlAt(path, "DELETE FROM issues WHERE id = 4");
  const after = new DatabaseSync(path);
  assertEquals(
    (after.prepare("SELECT id FROM evidence ORDER BY id").all() as { id: number }[]).map((r) =>
      r.id
    ),
    [7, 9],
  );
  after.close();
});

function rawSqlAt(path: string, sql: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(sql);
  db.close();
}

Deno.test("a v1 public.db migrates through v2 and v3 to v4", async () => {
  const path = join(await tempDir(), "public.db");
  PublicStore.open(path, { create: true }).close();
  downgradeToV2(path);
  rawSqlAt(
    path,
    "ALTER TABLE ai_log DROP COLUMN chain; ALTER TABLE ai_log DROP COLUMN chain_kind; PRAGMA user_version = 1;",
  );
  const store = PublicStore.open(path);
  assertEquals(userVersion(store.db), 4);
  store.log("app", "x");
  assertEquals(store.listLog(1)[0].chain_kind, null);
  store.close();
});

Deno.test("the store's deleteIssue deletes the issue's evidence explicitly", async () => {
  const { s, issue, evidence } = await claudeWork();
  s.store.deleteIssue(issue);
  assertThrows(() => s.store.getEvidence(evidence));
  s.close();
});

// ── bug 1 (and 2c): attested items deleted with raw SQL are reported, not silently pruned ──

Deno.test("raw-SQL deletes of verified, adopted and user-written items are reported on open", async () => {
  const { s, dir, docId, chrono, issue, para } = await claudeWork();
  await s.verifyChronology(chrono);
  await adoptParagraph(s, para, ATTEST);
  // Evidence the user added in the app (recorded as theirs).
  const written = {
    issue_id: issue,
    doc_id: docId,
    line_start: 2,
    line_end: 2,
    note: "Pickup was at 6pm",
    stance: "supports" as const,
  };
  const userEv = s.store.addEvidence(issue, written, "user");
  await s.recordUserItem("evidence", userEv, written);
  await s.settled();
  assertEquals(await s.securityLog(), []);
  s.close();

  // Claude, with a shell, deletes them behind the CLI's back.
  rawSql(dir, "DELETE FROM chronology WHERE id = ?", chrono);
  rawSql(dir, "DELETE FROM paragraphs WHERE id = ?", para);
  rawSql(dir, "DELETE FROM evidence WHERE id = ?", userEv);

  const s2 = await CaseSession.open(dir, PASS);
  await s2.settled();
  const events = (await s2.securityLog()).filter((e) => e.event === "attested_item_deleted");
  const byTarget = new Map(events.map((e) => [e.target, e]));
  const c = byTarget.get(`chronology:${chrono}`);
  assert(c, JSON.stringify(events));
  assertEquals(c.kind, "chronology");
  assertEquals(c.id, String(chrono));
  assertEquals(c.lastAttested?.label, "2025-03-14");
  assertEquals(c.lastAttested?.text, CHRONO_TEXT.slice(0, 80));
  const p = byTarget.get(`paragraph:${para}`);
  assert(p, JSON.stringify(events));
  assertStringIncludes(p.lastAttested!.text, "I am the mother of");
  const e = byTarget.get(`user_item:evidence/${userEv}`);
  assert(e, JSON.stringify(events));
  assertEquals(e.lastAttested?.text, "Pickup was at 6pm");
  // Nothing about the content reaches public.db: the log says only how many.
  const logged = s2.store.listLog(50).find((l) =>
    l.action === "attested_items_deleted_outside_app"
  );
  assert(logged);
  assert(!logged.detail.includes("Pickup"));
  s2.close();

  // Reported once, then pruned: opening again adds nothing.
  const s3 = await CaseSession.open(dir, PASS);
  await s3.settled();
  assertEquals(
    (await s3.securityLog()).filter((e) => e.event === "attested_item_deleted").length,
    events.length,
  );
  s3.close();
});

Deno.test("deleting a verified issue with raw SQL is reported; deleting through the app is not", async () => {
  const { s, dir, chrono, issue } = await claudeWork();
  await s.verifyIssue(issue);
  await s.verifyChronology(chrono);
  // The user deletes the chronology entry in the app: no security event.
  await s.deleteChronology(chrono);
  await s.settled();
  s.close();
  rawSql(dir, "DELETE FROM issues WHERE id = ?", issue);
  const s2 = await CaseSession.open(dir, PASS);
  await s2.settled();
  const targets = (await s2.securityLog()).map((e) => e.target);
  assertEquals(targets, [`issue:${issue}`]);
  s2.close();
});
