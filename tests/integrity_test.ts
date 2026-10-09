/**
 * Integrity of what the app shows and records, when Claude writes public.db directly (security
 * review findings 4 and 7, and the follow-up review of the attestation ledger).
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  adoptParagraph,
  paragraphState,
  userAddParagraph,
  userCreateDraft,
} from "../src/core/drafting.ts";
import { CantCheckError } from "../src/core/claimcheck.ts";
import { CaseSession, StaleItemError, type StoredDoc } from "../src/core/session.ts";
import { PASS, publishedCase } from "./fixtures/case.ts";

function sql(s: CaseSession, query: string, ...args: (string | number | null)[]) {
  s.store.db.prepare(query).run(...args);
}

const ATTEST = { ownKnowledge: true as const, ownWords: true as const };

// ── finding 4: public.db is reconciled with the vault ───────────────────────

Deno.test("reconcilePublic restores tampered lines, titles and bodies, and removes fake documents", async () => {
  const { s, dir, docId } = await publishedCase();
  const original = s.store.getLines(docId);
  const title = s.store.getDocument(docId).title;
  s.close();

  // While the app is closed, Claude rewrites a line, the title and adds a document of its own.
  const c = await CaseSession.open(dir, PASS);
  sql(c, "DELETE FROM lines WHERE doc_id = ? AND line_no = 5", docId);
  sql(c, "INSERT INTO lines(doc_id, line_no, text) VALUES (?, 5, ?)", docId, "Invented quote.");
  sql(c, "UPDATE documents SET title = 'Something else' WHERE id = ?", docId);
  sql(
    c,
    "INSERT INTO documents(id, title, sensitivity, withheld, body, line_count, published_at) VALUES ('D999', 'Fake', 'none', 0, 'x', 1, '2025')",
  );
  c.close();

  const s2 = await CaseSession.open(dir, PASS);
  assertEquals(s2.store.getLines(docId), original);
  assertEquals(s2.store.getDocument(docId).title, title);
  assertEquals(s2.store.hasDocument("D999"), false);
  const entry = s2.store.listLog(50).find((l) => l.action === "public_store_repaired");
  assert(entry, "the repair is logged");
  assertEquals(JSON.parse(entry.detail).docs.sort(), [docId, "D999"]);
  // A search for the invented text finds nothing; the real text is found again.
  assertEquals(s2.store.search("Invented"), []);
  assert(s2.store.search("separated").length > 0);
  // Nothing to repair the second time.
  assertEquals(await s2.reconcilePublic(), []);
  s2.close();
});

Deno.test("a corrupted search index is rebuilt on open", async () => {
  const { s, dir } = await publishedCase();
  sql(s, "INSERT INTO lines_fts(rowid, text) VALUES (999999, 'phantom words')");
  s.close();
  const s2 = await CaseSession.open(dir, PASS);
  assert(s2.store.searchIndexOk());
  assertEquals(s2.store.search("phantom"), []);
  s2.close();
});

Deno.test("quotes for the user come from the vault, not public.db", async () => {
  const { s, docId } = await publishedCase();
  const vaultLine = (await s.citedLines(docId, 5, 5))![0].text;
  sql(s, "UPDATE lines SET text = 'Invented quote.' WHERE doc_id = ? AND line_no = 5", docId);
  assertEquals((await s.citedLines(docId, 5, 5))![0].text, vaultLine);
  assertEquals(await s.citedLines("D999", 1, 1), null);
  assertEquals(await s.citedLines("../x", 1, 1), null);
  s.close();
});

Deno.test("a verification covers the cited lines: if they change it no longer holds", async () => {
  const { s, docId } = await publishedCase();
  const id = s.store.addChronology(
    {
      event_date: "2025-03-14",
      description: "Late pickup.",
      sources: [{ doc_id: docId, line_start: 8, line_end: 8 }],
    },
    "claude",
  );
  await s.verifyChronology(id);
  assert(await s.isChronologyVerified(s.store.getChronology(id)));

  // Change the cited line in the vault (e.g. a re-publish with different redactions).
  const doc = await s.getDoc(docId);
  const lines = doc.tokenised!.split("\n");
  lines[7] = "4. Something else happened.";
  await s.vault.writeJson(`doc-${docId.toLowerCase()}`, { ...doc, tokenised: lines.join("\n") });
  const fresh = await CaseSession.open(s.paths.root, PASS); // reads the vault again
  s.close();
  assertEquals(await fresh.isChronologyVerified(fresh.store.getChronology(id)), false);
  fresh.close();
});

// ── follow-up review: races between the app's check and its write ──────────

Deno.test("verifying refuses an item that changed after the user was shown it", async () => {
  const { s, docId } = await publishedCase();
  const id = s.store.addChronology(
    {
      event_date: "2025-03-14",
      description: "Late pickup.",
      sources: [{ doc_id: docId, line_start: 8, line_end: 8 }],
    },
    "claude",
  );
  const shown = await s.itemVersion("chronology", s.store.getChronology(id));
  // Claude edits the entry after the app displayed it, before the user clicks Verify.
  sql(s, "UPDATE chronology SET description = 'Something else.' WHERE id = ?", id);
  await assertRejects(() => s.verifyChronology(id, shown), StaleItemError);
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  // With the current version it works.
  await s.verifyChronology(id, await s.itemVersion("chronology", s.store.getChronology(id)));
  assert(await s.isChronologyVerified(s.store.getChronology(id)));
  s.close();
});

Deno.test("adopting refuses a paragraph Claude changed after the user read it", async () => {
  const { s } = await publishedCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(draft, "First version.", "claude");
  const shown = await s.itemVersion("paragraph", s.store.getParagraph(para));
  sql(s, "UPDATE paragraphs SET body = 'Second version.' WHERE id = ?", para);
  await assertRejects(() => adoptParagraph(s, para, ATTEST, { version: shown }), StaleItemError);
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
});

Deno.test("Claude replacing the user's new paragraph right after it is written is not attested as the user's", async () => {
  const { s } = await publishedCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  // Simulate Claude writing between the app's insert and any read-back.
  const add = s.store.addParagraph.bind(s.store);
  s.store.addParagraph = (d, body, author, after) => {
    const id = add(d, body, author, after);
    sql(s, "UPDATE paragraphs SET body = 'Claude text.' WHERE id = ?", id);
    return id;
  };
  const id = await userAddParagraph(s, draft, "My own words about the handover.");
  assertEquals(await paragraphState(s, s.store.getParagraph(id)), "claude_needs_you");
  s.close();
});

Deno.test("concurrent ledger writes do not lose attestations or revive revoked ones", async () => {
  const { s, dir, docId } = await publishedCase();
  const src = [{ doc_id: docId, line_start: 8, line_end: 8 }];
  const a = s.store.addChronology(
    { event_date: "2025-01-01", description: "A.", sources: src },
    "claude",
  );
  const b = s.store.addChronology(
    { event_date: "2025-01-02", description: "B.", sources: src },
    "claude",
  );
  const c = s.store.addChronology(
    { event_date: "2025-01-03", description: "C.", sources: src },
    "claude",
  );
  await s.verifyChronology(c);

  // Verify a and b at the same time, and unverify c while verifying a third time in parallel:
  // the revocation was requested after the attestation started, so it must win.
  await Promise.all([
    s.verifyChronology(a),
    s.verifyChronology(b),
    s.verifyChronology(c),
    s.unverify("chronology", c),
  ]);
  const check = async (x: CaseSession) => [
    await x.isChronologyVerified(x.store.getChronology(a)),
    await x.isChronologyVerified(x.store.getChronology(b)),
    await x.isChronologyVerified(x.store.getChronology(c)),
  ];
  assertEquals(await check(s), [true, true, false]);
  s.close();
  const s2 = await CaseSession.open(dir, PASS);
  assertEquals(await check(s2), [true, true, false], "the vault agrees after reopening");
  s2.close();
});

// ── finding 7: created_by is not trusted on its own ─────────────────────────

Deno.test("an item shows as the user's only if the app recorded it, with its content", async () => {
  const { s } = await publishedCase();
  // Claude forges created_by on its own note.
  const forged = s.store.addNote("case", "case", "Claude's suggestion.", "claude");
  sql(s, "UPDATE notes SET created_by = 'user' WHERE id = ?", forged);
  assertEquals(await s.isUserItem("note", s.store.getNote(forged)), false);

  // The user's note, recorded by the app.
  const note = { target_type: "case", target_id: "case", body: "My note." };
  const mine = s.store.addNote(note.target_type, note.target_id, note.body, "user");
  await s.recordUserItem("note", mine, note);
  assert(await s.isUserItem("note", s.store.getNote(mine)));

  // Claude rewrites the user's note: it no longer counts as the user's.
  sql(s, "UPDATE notes SET body = 'Claude words.' WHERE id = ?", mine);
  assertEquals(await s.isUserItem("note", s.store.getNote(mine)), false);
  s.close();
});

Deno.test("a reused id does not inherit the user's authorship", async () => {
  const { s } = await publishedCase();
  const issue = { title: "Handover delays", description: "" };
  const id = s.store.addIssue(issue, "user");
  await s.recordUserItem("issue", id, issue);
  // Claude deletes the user's issue and inserts its own with the same id.
  sql(s, "DELETE FROM issues WHERE id = ?", id);
  sql(
    s,
    "INSERT INTO issues(id, title, description, created_by, created_at, updated_at) VALUES (?, 'Claude issue', '', 'user', '2025', '2025')",
    id,
  );
  assertEquals(await s.isUserItem("issue", s.store.getIssue(id)), false);
  s.close();
});

Deno.test("a document's cached copy is not shared with callers", async () => {
  const { s, docId } = await publishedCase();
  const d: StoredDoc = await s.getDoc(docId);
  d.tokenised = "mutated";
  assertNotEquals((await s.getDoc(docId)).tokenised, "mutated");
  s.close();
});

Deno.test("a revoke requested after a verify always wins, however the two interleave", async () => {
  const { s, docId } = await publishedCase();
  const src = [{ doc_id: docId, line_start: 8, line_end: 8 }];
  const id = s.store.addChronology(
    { event_date: "2025-01-01", description: "A.", sources: src },
    "claude",
  );
  const verified = async () => await s.isChronologyVerified(s.store.getChronology(id));
  for (let i = 0; i < 40; i++) {
    // Verify, then (requested last) unverify, concurrently.
    await Promise.all([s.verifyChronology(id), s.unverify("chronology", id)]);
    assertEquals(await verified(), false, `round ${i}: revoke requested last`);
    // The other order: the verify was requested last, so it holds.
    await Promise.all([s.unverify("chronology", id), s.verifyChronology(id)]);
    assertEquals(await verified(), true, `round ${i}: verify requested last`);
  }
  // A check that is in flight when a revoke is requested does not report "verified".
  const check = s.isChronologyVerified(s.store.getChronology(id));
  const revoke = s.unverify("chronology", id);
  assertEquals(await check, false);
  await revoke;
  s.close();
});

Deno.test("a document read that overlaps a save does not put the old version back in the cache", async () => {
  const { s: fresh, docId } = await publishedCase();
  fresh.forgetCachedDocs();
  // Slow down the next vault read of a document, after it has read the old version.
  const read = fresh.vault.readJson.bind(fresh.vault);
  let slow = true;
  // deno-lint-ignore no-explicit-any
  (fresh.vault as any).readJson = async (name: string) => {
    const v = await read(name);
    if (slow && name.startsWith("doc-")) {
      slow = false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return v;
  };
  const old = fresh.getDoc(docId); // reads the old version, then stalls
  await new Promise((r) => setTimeout(r, 5));
  await fresh.setOrigin(docId, "other_side"); // saves a new version meanwhile
  assertEquals((await old).origin, "mine");
  assertEquals((await fresh.getDoc(docId)).origin, "other_side");
  fresh.close();
});

Deno.test("an item citing a document the vault has not published cannot be verified", async () => {
  const { s, docId } = await publishedCase();
  // Claude inserts a fake public document and cites it.
  sql(
    s,
    "INSERT INTO documents(id, title, sensitivity, withheld, body, line_count, published_at) VALUES ('D999', 'Fake', 'none', 0, 'x', 1, '2025')",
  );
  const id = s.store.addChronology(
    {
      event_date: "2025-01-01",
      description: "A.",
      sources: [{ doc_id: docId, line_start: 8, line_end: 8 }, {
        doc_id: "D999",
        line_start: 1,
        line_end: 1,
      }],
    },
    "claude",
  );
  await assertRejects(() => s.verifyChronology(id), CantCheckError);
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  s.close();
});
