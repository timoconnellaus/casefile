/**
 * Finding 8: withholding a document removes the details and tags set while it was visible, and the
 * passphrase lockout is capped so another local process cannot keep the user out for long.
 */
import { assertEquals } from "@std/assert";
import { lockoutMs, MAX_LOCKOUT_MS } from "../src/app/state.ts";
import { publishedCase } from "./fixtures/case.ts";

const COMMERCIAL = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };

Deno.test("switching back to consumer clears details and tags of withheld documents", async () => {
  const { s, docId } = await publishedCase();
  await s.setOrigin(docId, "court_or_subpoena");
  await s.setClaudeSetup("commercial", COMMERCIAL);
  await s.release(docId); // visible to Claude
  s.store.setDocumentMeta(docId, { doc_type: "affidavit", author_role: "{{mother}}" }, "claude");
  s.store.addTag(docId, "violence", "claude");
  await s.setClaudeSetup("consumer"); // withheld again
  const row = s.store.getDocument(docId);
  assertEquals(row.withheld, 1);
  assertEquals([row.doc_type, row.doc_date, row.author_role, row.source], [null, null, null, null]);
  assertEquals(row.meta_by, "app");
  assertEquals(s.store.tagsFor(docId), []);
  s.close();
});

Deno.test("Claude marking a visible document as already withheld does not keep its details", async () => {
  const { s, docId } = await publishedCase();
  await s.setOrigin(docId, "court_or_subpoena");
  await s.setClaudeSetup("commercial", COMMERCIAL);
  await s.release(docId);
  s.store.setDocumentMeta(docId, { doc_type: "affidavit" }, "claude");
  s.store.addTag(docId, "violence", "claude");
  // Claude flips the flag first, so the row looks as if it had been withheld all along.
  s.store.db.prepare("UPDATE documents SET withheld = 1, meta_by = 'user' WHERE id = ?").run(docId);
  await s.setClaudeSetup("consumer");
  assertEquals(s.store.getDocument(docId).doc_type, null);
  assertEquals(s.store.tagsFor(docId), []);
  s.close();
});

Deno.test("the passphrase lockout never exceeds two minutes", () => {
  assertEquals([lockoutMs(1), lockoutMs(2), lockoutMs(3), lockoutMs(4)], [0, 0, 2000, 4000]);
  assertEquals(MAX_LOCKOUT_MS, 120_000);
  assertEquals(lockoutMs(50), MAX_LOCKOUT_MS);
});
