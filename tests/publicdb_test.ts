import { assert, assertEquals, assertThrows } from "@std/assert";
import { InvalidInputError, parseSourceRef, PublicStore } from "../src/core/publicdb.ts";

function store() {
  const s = PublicStore.open(":memory:");
  s.setEntities([{ role: "mother", kind: "person" }, { role: "father", kind: "person" }]);
  s.publishDocument({
    id: "D001",
    title: "Messages",
    sensitivity: "mine",
    body:
      "{{mother.first}}: where are you?\n{{father.first}}: traffic, collecting {{child_1}} now\nthird line",
  });
  return s;
}

Deno.test("source references parse and validate against real lines", () => {
  assertEquals(parseSourceRef("D001:2-3"), { doc_id: "D001", line_start: 2, line_end: 3 });
  assertEquals(parseSourceRef("D001:2"), { doc_id: "D001", line_start: 2, line_end: 2 });
  assertThrows(() => parseSourceRef("D001:3-2"), InvalidInputError);
  assertThrows(() => parseSourceRef("doc1:1"), InvalidInputError);
  const s = store();
  s.checkSourceRef({ doc_id: "D001", line_start: 1, line_end: 3 });
  assertThrows(
    () => s.checkSourceRef({ doc_id: "D001", line_start: 1, line_end: 4 }),
    InvalidInputError,
  );
  assertThrows(
    () => s.checkSourceRef({ doc_id: "D404", line_start: 1, line_end: 1 }),
    InvalidInputError,
  );
});

Deno.test("documents are stored line by line and searchable with line numbers", () => {
  const s = store();
  assertEquals(s.getLines("D001", 2, 2), [{
    line_no: 2,
    text: "{{father.first}}: traffic, collecting {{child_1}} now",
  }]);
  const hits = s.search("traffic");
  assertEquals(hits.map((h) => [h.doc_id, h.line]), [["D001", 2]]);
  assert(hits[0].snippet.includes("[traffic]"));
  // FTS syntax in the query does not throw.
  assertEquals(s.search('"unbalanced OR ('), []);
});

Deno.test("withheld documents have no text, cannot be searched or cited", () => {
  const s = store();
  s.publishDocument({
    id: "D002",
    title: "[withheld]",
    sensitivity: "court_or_subpoena",
    body: null,
  });
  assertEquals(s.getDocument("D002").withheld, 1);
  assertEquals(s.getLines("D002"), []);
  assertThrows(
    () => s.checkSourceRef({ doc_id: "D002", line_start: 1, line_end: 1 }),
    InvalidInputError,
  );
  // Publishing again with text replaces the withheld version, and the reverse removes the text.
  s.publishDocument({
    id: "D002",
    title: "Subpoenaed records",
    sensitivity: "court_or_subpoena",
    body: "secret school records",
  });
  assertEquals(s.search("school").length, 1);
  s.publishDocument({
    id: "D002",
    title: "[withheld]",
    sensitivity: "court_or_subpoena",
    body: null,
  });
  assertEquals(s.search("school"), []);
});

Deno.test("Claude's chronology entries must cite a source; edits clear verification", () => {
  const s = store();
  assertThrows(
    () => s.addChronology({ event_date: "2025-03-14", description: "x", sources: [] }, "claude"),
    InvalidInputError,
  );
  assertThrows(
    () => s.addChronology({ event_date: "14/03/2025", description: "x", sources: [] }, "user"),
    InvalidInputError,
  );
  const id = s.addChronology({
    event_date: "2025-03-14",
    description: "{{father}} late",
    sources: [parseSourceRef("D001:2")],
  }, "claude");
  s.setChronologyVerification(id, "2025-01-01T00:00:00Z", "sig");
  s.updateChronology(id, { description: "{{father}} very late" });
  assertEquals(s.getChronology(id).verified_at, null);
  assertEquals(s.listChronology({ from: "2025-03", to: "2025-03-31" }).length, 1);
  assertEquals(s.listChronology({ from: "2025-04" }).length, 0);
});

Deno.test("issues hold evidence with a stance", () => {
  const s = store();
  const issue = s.addIssue({ title: "Changeovers" }, "claude");
  const ev = s.addEvidence(issue, {
    ...parseSourceRef("D001:1-2"),
    note: "late",
    stance: "supports",
  }, "claude");
  assertEquals(s.listEvidence(issue).map((e) => [e.id, e.stance]), [[ev, "supports"]]);
  assertThrows(
    () => s.addEvidence(issue, { ...parseSourceRef("D001:9"), stance: "supports" }, "claude"),
    InvalidInputError,
  );
  s.deleteIssue(issue);
  assertEquals(s.listIssues(), []);
});

Deno.test("paragraphs keep order when inserted between others", () => {
  const s = store();
  const d = s.createDraft({ kind: "affidavit", title: "Affidavit of {{mother}}" }, "user");
  const a = s.addParagraph(d, "First", "user");
  const c = s.addParagraph(d, "Third", "claude");
  const b = s.addParagraph(d, "Second", "claude", a);
  assertEquals(s.listParagraphs(d).map((p) => p.id), [a, b, c]);
  assertEquals(s.getParagraph(c).claude_body, "Third");
  s.setParagraphAdoption(c, "now", "sig");
  s.updateParagraph(c, "Third, edited", "user");
  const p = s.getParagraph(c);
  assertEquals([p.author, p.claude_body, p.adopted_at], ["user", "Third", null]);
  // A light user edit keeps the paragraph Claude's without overwriting Claude's text.
  s.updateParagraph(b, "Second, lightly edited", "claude", { keepClaudeBody: true });
  const q = s.getParagraph(b);
  assertEquals([q.author, q.body, q.claude_body], ["claude", "Second, lightly edited", "Second"]);
  s.updateParagraph(b, "Second, by Claude", "claude");
  assertEquals(s.getParagraph(b).claude_body, "Second, by Claude");
});

Deno.test("renaming a role rewrites tokens everywhere, including the search index", () => {
  const s = store();
  const issue = s.addIssue({ title: "Conduct of {{father}}" }, "claude");
  s.addNote("case", "case", "Ask {{father.first}} about {{father_2}}", "claude");
  s.renameRoleInText("father", "dad");
  assertEquals(s.getIssue(issue).title, "Conduct of {{dad}}");
  assertEquals(s.listNotes()[0].body, "Ask {{dad.first}} about {{father_2}}");
  assert(s.getDocument("D001").body!.includes("{{dad.first}}"));
  assertEquals(s.search("dad").map((h) => h.line), [2]);
  assertEquals(s.search("father"), []);
});

Deno.test("tags are normalised and filter the document list", () => {
  const s = store();
  s.addTag("D001", "Messages ", "claude");
  assertEquals(s.tagsFor("D001"), ["messages"]);
  assertEquals(s.listDocuments({ tag: "MESSAGES" }).length, 1);
  assertThrows(() => s.addTag("D001", "<script>", "claude"), InvalidInputError);
});

Deno.test("the AI-use log records actor and detail", () => {
  const s = store();
  s.log("claude", "cli:search", { query: "traffic" });
  const [row] = s.listLog(1);
  assertEquals([row.actor, row.action, JSON.parse(row.detail).query], [
    "claude",
    "cli:search",
    "traffic",
  ]);
});
