/** public.db schema v4 (wave 0): migration from v3, and the new store accessors. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  InvalidInputError,
  legacySensitivity,
  originFromStored,
  ORIGINS,
  parseOrigin,
  PublicStore,
} from "../src/core/publicdb.ts";
import { tempDir } from "./fixtures/synthetic.ts";

/** The v3 schema as it shipped (a frozen copy: real v3 databases look like this). */
const V3_SCHEMA = `
CREATE TABLE case_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entities (role TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TABLE documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  doc_type TEXT, doc_date TEXT, author_role TEXT, source TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'none', withheld INTEGER NOT NULL DEFAULT 0, body TEXT,
  line_count INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL, meta_by TEXT NOT NULL DEFAULT 'app'
);
CREATE TABLE lines (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, line_no INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (doc_id, line_no));
CREATE VIRTUAL TABLE lines_fts USING fts5(text, content='lines', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN INSERT INTO lines_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER lines_ad AFTER DELETE ON lines BEGIN INSERT INTO lines_fts(lines_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TABLE tags (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, tag TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY (doc_id, tag));
CREATE TABLE chronology (id INTEGER PRIMARY KEY, event_date TEXT NOT NULL, description TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, verified_sig TEXT);
CREATE TABLE chronology_sources (entry_id INTEGER NOT NULL REFERENCES chronology(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL);
CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, verified_sig TEXT);
CREATE TABLE evidence (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id),
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '', stance TEXT NOT NULL DEFAULT 'supports',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, verified_at TEXT, verified_sig TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, body TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE drafts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE paragraphs (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position REAL NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, claude_body TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, adopted_at TEXT, adopted_sig TEXT);
CREATE TABLE ai_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', chain TEXT, chain_kind TEXT);
PRAGMA user_version = 3;
`;

async function v3Db(): Promise<string> {
  const path = join(await tempDir(), "public.db");
  const db = new DatabaseSync(path);
  db.exec(V3_SCHEMA);
  const legacy: [string, string, number][] = [
    ["D001", "none", 0],
    ["D002", "discovery", 1],
    ["D003", "subpoena", 1],
    ["D004", "suppression", 1],
    ["D005", "restricted", 0],
  ];
  for (const [id, sens, withheld] of legacy) {
    db.prepare(
      "INSERT INTO documents(id, title, sensitivity, withheld, body, line_count, published_at) VALUES (?, 't', ?, ?, ?, 1, 'p')",
    ).run(id, sens, withheld, withheld ? null : "{{mother}} wrote");
  }
  db.exec(`
    INSERT INTO entities(role, kind) VALUES ('mother', 'person');
    INSERT INTO chronology VALUES (1, '2025-03-14', 'Late', 'claude', 't', 't', NULL, NULL);
    INSERT INTO issues VALUES (1, 'Changeovers', '', 'claude', 't', 't', NULL, NULL);
    INSERT INTO evidence VALUES (1, 1, 'D001', 1, 1, '', 'supports', 'claude', 't', NULL, NULL);
    INSERT INTO notes VALUES (1, 'doc', 'D001', 'A note', 'claude', 't');`);
  db.close();
  return path;
}

const version = (s: PublicStore) =>
  (s.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

Deno.test("a v3 public.db migrates to v4: origin values mapped, withheld reasons set", async () => {
  const path = await v3Db();
  const store = PublicStore.open(path);
  assertEquals(version(store), 4);
  const docs = store.listDocuments().map((d) => [d.id, d.sensitivity, d.withheld_reason]);
  assertEquals(docs, [
    ["D001", "mine", null],
    ["D002", "other_side", "origin"],
    ["D003", "court_or_subpoena", "origin"],
    ["D004", "under_order", "origin"],
    ["D005", "not_sure", null],
  ]);
  // New columns are empty; old rows are kept and stay listed.
  assertEquals(store.listEntities(), [{ role: "mother", kind: "person", description: null }]);
  assertEquals(store.getChronology(1).removed_at, null);
  assertEquals(store.listChronology().length, 1);
  assertEquals(store.listIssues().length, 1);
  assertEquals(store.listEvidence(1).length, 1);
  assertEquals([store.getNote(1).done_at, store.getNote(1).done_by], [null, null]);
  assertEquals(store.listParagraphSources(1), []);
  store.close();
  // Opening again does nothing more.
  const again = PublicStore.open(path);
  assertEquals(version(again), 4);
  assertEquals(again.getDocument("D002").sensitivity, "other_side");
  again.close();
});

Deno.test("a new store and a migrated one have the same tables and columns", async () => {
  const shape = (s: PublicStore) =>
    (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]).map((t) => [
      t.name,
      (s.db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[])
        .map((c) => c.name).sort(),
    ]);
  const migrated = PublicStore.open(await v3Db());
  const fresh = PublicStore.open(":memory:", { create: true });
  assertEquals(shape(fresh), shape(migrated));
  migrated.close();
  fresh.close();
});

Deno.test("origins: only origins are accepted as input; stored legacy values still read", () => {
  for (const o of ORIGINS) assertEquals(parseOrigin(o), o);
  for (const legacy of ["none", "discovery", "subpoena", "suppression", "restricted"]) {
    assertThrows(() => parseOrigin(legacy), InvalidInputError, undefined, legacy);
  }
  for (const bad of ["", "public", "toString", "__proto__", null, 3]) {
    assertThrows(() => parseOrigin(bad), InvalidInputError);
    assertThrows(() => originFromStored(bad), InvalidInputError);
  }
  // A vault document saved before schema v4 is still read (normaliseStoredDoc).
  assertEquals(originFromStored("none"), "mine");
  assertEquals(originFromStored("subpoena"), "court_or_subpoena");
  assertEquals(originFromStored("other_side"), "other_side");
  assertEquals(legacySensitivity("other_side"), "discovery");
  assertEquals(legacySensitivity(null), "restricted");
});

// ── accessors ───────────────────────────────────────────────────────────────

function storeWithWork() {
  const s = PublicStore.open(":memory:", { create: true });
  s.publishDocument({ id: "D001", title: "t", body: "a\nb\nc\nd", sensitivity: "mine" });
  s.publishDocument({ id: "D002", title: "t", body: "x\ny", sensitivity: "mine" });
  s.publishDocument({
    id: "D003",
    title: "[withheld]",
    body: null,
    sensitivity: "court_or_subpoena",
    withheld_reason: "origin",
  });
  const chrono = s.addChronology({
    event_date: "2025-03-14",
    description: "Late",
    sources: [{ doc_id: "D001", line_start: 1, line_end: 2 }, {
      doc_id: "D001",
      line_start: 4,
      line_end: 4,
    }],
  }, "claude");
  const issue = s.addIssue({ title: "Changeovers" }, "claude");
  const ev = s.addEvidence(issue, { doc_id: "D001", line_start: 3, line_end: 3 }, "claude");
  const draft = s.createDraft({ kind: "affidavit", title: "Affidavit" }, "claude");
  const para = s.addParagraph(draft, "On 14 March {{father}} was late.", "claude");
  const note = s.addNote("doc", "D001", "Check this", "claude");
  return { s, chrono, issue, ev, draft, para, note };
}

Deno.test("withheld_reason is stored only for withheld documents", () => {
  const { s } = storeWithWork();
  assertEquals(s.getDocument("D003").withheld_reason, "origin");
  s.publishDocument({
    id: "D003",
    title: "t",
    body: "now",
    sensitivity: "mine",
    withheld_reason: "origin",
  });
  assertEquals(s.getDocument("D003").withheld_reason, null);
  s.close();
});

Deno.test("paragraph sources and links round-trip; withheld documents cannot be sources", () => {
  const { s, para, chrono, ev } = storeWithWork();
  s.setParagraphSources(para, [
    { doc_id: "D002", line_start: 1, line_end: 2 },
    { doc_id: "D001", line_start: 3, line_end: 3 },
  ]);
  assertEquals(s.listParagraphSources(para), [
    { doc_id: "D001", line_start: 3, line_end: 3 },
    { doc_id: "D002", line_start: 1, line_end: 2 },
  ]);
  assertThrows(
    () => s.setParagraphSources(para, [{ doc_id: "D003", line_start: 1, line_end: 1 }]),
    InvalidInputError,
  );
  assertThrows(
    () => s.setParagraphSources(para, [{ doc_id: "D001", line_start: 1, line_end: 9 }]),
    InvalidInputError,
  );
  assertEquals(s.listParagraphSources(para).length, 2, "a refused set changes nothing");
  s.setParagraphLinks(para, [
    { target_type: "evidence", target_id: ev },
    { target_type: "chronology", target_id: chrono },
  ]);
  assertEquals(s.listParagraphLinks(para), [
    { target_type: "chronology", target_id: chrono },
    { target_type: "evidence", target_id: ev },
  ]);
  assertThrows(() => s.setParagraphLinks(para, [{ target_type: "chronology", target_id: 99 }]));
  // Deleting the paragraph deletes its sources and links.
  s.deleteParagraph(para);
  assertEquals(s.listParagraphSources(para), []);
  assertEquals(s.listParagraphLinks(para), []);
  s.close();
});

Deno.test("notes can be marked done and undone", () => {
  const { s, note } = storeWithWork();
  s.markNoteDone(note, "user");
  assert(s.getNote(note).done_at);
  assertEquals(s.getNote(note).done_by, "user");
  s.markNoteDone(note, "user", false);
  assertEquals([s.getNote(note).done_at, s.getNote(note).done_by], [null, null]);
  s.close();
});

Deno.test("soft remove and restore: removed items leave the lists unless asked for", () => {
  const { s, chrono, issue, ev } = storeWithWork();
  s.softRemove("chronology", chrono, "user");
  s.softRemove("evidence", ev, "user");
  s.softRemove("issue", issue, "user");
  assertEquals(s.listChronology(), []);
  assertEquals(s.listChronology({ includeRemoved: true }).length, 1);
  assertEquals(s.listIssues(), []);
  assertEquals(s.listIssues({ includeRemoved: true }).length, 1);
  assertEquals(s.listEvidence(issue), []);
  assertEquals(s.listEvidence(issue, { includeRemoved: true }).length, 1);
  const removed = s.listRemoved("chronology");
  assertEquals(removed.map((r) => [r.id, r.removed_by, r.sources.length]), [[chrono, "user", 2]]);
  assertEquals(s.listRemoved("evidence").map((r) => r.id), [ev]);
  assertEquals(s.listRemoved("issue").map((r) => r.id), [issue]);
  s.restore("chronology", chrono);
  assertEquals(s.listChronology().map((r) => r.id), [chrono]);
  assertEquals(s.listRemoved("chronology"), []);
  assertThrows(() => s.softRemove("chronology", 999, "user"));
  s.close();
});

Deno.test("citations of a document, and counts per document", () => {
  const { s, chrono, ev, para, note } = storeWithWork();
  s.setParagraphSources(para, [{ doc_id: "D001", line_start: 1, line_end: 1 }]);
  assertEquals(s.citationsOf("D001"), {
    chronology: [chrono],
    evidence: [ev],
    paragraphs: [para],
    notes: [note],
  });
  assertEquals(s.citationsOf("D002"), { chronology: [], evidence: [], paragraphs: [], notes: [] });
  // The chronology entry cites D001 twice but counts once.
  assertEquals(s.citationCounts(), { D001: 3 });
  s.softRemove("evidence", ev, "user");
  assertEquals(s.citationCounts(), { D001: 2 });
  assertEquals(s.citationsOf("D001").evidence, []);
  assertEquals(s.citationsOf("D001", { includeRemoved: true }).evidence, [ev]);
  s.close();
});

Deno.test("the log for a document: rows whose detail names it, malformed details ignored", () => {
  const { s } = storeWithWork();
  s.log("claude", "cli:docs_show", { doc: "D001", lines: "1-2" });
  s.log("claude", "cli:docs_show", { doc: "D002" });
  s.log("user", "verified", { what: "chronology", id: 1 });
  s.db.prepare(
    "INSERT INTO ai_log(ts, actor, action, detail) VALUES ('t', 'claude', 'x', 'not json')",
  )
    .run();
  s.log("app", "document_published", { doc: "D001" });
  assertEquals(s.logForDoc("D001").map((r) => r.action), ["cli:docs_show", "document_published"]);
  assertEquals(s.logForDoc("D009"), []);
  s.close();
});

Deno.test("entities carry a description", () => {
  const s = PublicStore.open(":memory:", { create: true });
  s.setEntities([
    { role: "mother", kind: "person", description: "{{child_1.first}}'s mother" },
    { role: "school", kind: "school" },
  ]);
  assertEquals(s.listEntities(), [
    { role: "mother", kind: "person", description: "{{child_1.first}}'s mother" },
    { role: "school", kind: "school", description: null },
  ]);
  s.close();
});
