/**
 * Re-checking text already in public.db when a nickname is added (ADR 27): the user's own notes,
 * chronology entries, issues, evidence notes and paragraphs get the value replaced by its token
 * and stay theirs; Claude's work and text casefile can't attribute are left and listed. SYNTHETIC
 * data only (ADR 11).
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { CaseSession } from "../src/core/session.ts";
import { changeEntity } from "../src/core/people.ts";
import { listTypedTextRechecks, TYPED_TEXT_RECHECKS_FILE } from "../src/core/typedtext.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const PASS = "a long test passphrase";

async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  s.detectors = []; // no name finder: "Annie" is not caught when the user types it
  await seedCanon(s, { omitAliases: ["Annie"] });
  return { dir, s };
}

/** What the user types, saved as the app's routes save it. */
async function userNote(s: CaseSession, text: string) {
  const body = await s.tokeniseUserText(text);
  const id = s.store.addNote("document", "D001", body, "user");
  await s.recordUserItem("note", id, { target_type: "document", target_id: "D001", body });
  return id;
}

async function userChronology(s: CaseSession, text: string) {
  const entry = {
    event_date: "2025-03-21",
    description: await s.tokeniseUserText(text),
    sources: [],
  };
  const id = s.store.addChronology(entry, "user");
  await s.recordUserItem("chronology", id, entry);
  return id;
}

async function userParagraph(s: CaseSession, text: string) {
  const draft = s.store.createDraft({ kind: "outline", title: "Outline" }, "user");
  const body = await s.tokeniseUserText(text);
  const id = s.store.addParagraph(draft, body, "user");
  await s.attestUserAuthorship({ id, draft_id: draft, body });
  return { draft, id };
}

async function addAnnie(s: CaseSession) {
  const mother = s.registry.get("mother")!;
  return await changeEntity(s, "mother", { aliases: [...mother.aliases, "Annie"] });
}

Deno.test("a nickname added later is replaced in the user's own text, which stays theirs", async () => {
  const { s } = await newCase();
  const note = await userNote(s, "Annie called about the changeover.");
  const chrono = await userChronology(s, "Annie refused the changeover.");
  const para = await userParagraph(s, "On 21 March Annie kept the children.");
  // An issue with the nickname in its title and its description, and an evidence note.
  const issue = s.store.addIssue({
    title: await s.tokeniseUserText("Whether Annie keeps to the orders"),
    description: await s.tokeniseUserText("Annie missed two changeovers."),
  }, "user");
  await s.recordUserItem("issue", issue, s.store.getIssue(issue));
  const ev = {
    doc_id: "D001",
    line_start: 1,
    line_end: 1,
    note: await s.tokeniseUserText("Annie says so herself."),
    stance: "supports" as const,
  };
  const evId = s.store.addEvidence(issue, ev, "user");
  await s.recordUserItem("evidence", evId, { ...ev, issue_id: issue });
  for (const t of [s.store.getNote(note).body, s.store.getChronology(chrono).description]) {
    assert(t.includes("Annie"), "saved as typed: casefile did not know the nickname yet");
  }

  const r = await addAnnie(s);
  assertExists(r.typedText);
  assertEquals(
    r.typedText.replaced.map((i) => `${i.kind}:${i.id}`).sort(),
    [
      `chronology:${chrono}`,
      `evidence:${evId}`,
      `issue:${issue}`,
      `note:${note}`,
      `paragraph:${para.id}`,
    ].sort(),
  );
  assertEquals(r.typedText.left, []);
  const texts = [
    s.store.getNote(note).body,
    s.store.getChronology(chrono).description,
    s.store.getParagraph(para.id).body,
    s.store.getIssue(issue).title,
    s.store.getIssue(issue).description,
    s.store.getEvidence(evId).note,
  ];
  for (const t of texts) {
    assert(!t.includes("Annie"), t);
    assert(t.includes("{{mother"), t);
  }
  // Still the user's (the ledger records the new content), so nothing turns into Claude's work.
  assert(await s.isUserItem("note", s.store.getNote(note)));
  assert(await s.isUserItem("chronology", s.store.getChronology(chrono)));
  assert(await s.isUserItem("issue", s.store.getIssue(issue)));
  assert(await s.isUserItem("evidence", s.store.getEvidence(evId)));
  assert(await s.hasUserAuthorship(s.store.getParagraph(para.id)));

  // Recorded in the vault with the value; the log has the count only.
  const rec = await listTypedTextRechecks(s);
  assertEquals(rec.length, 1);
  assert(rec[0].triggers.some((t) => t.role === "mother" && t.value === "Annie"));
  const log = s.store.listLog(50).filter((l) => l.action === "typed_text_rechecked");
  assertEquals(log.length, 1);
  assertEquals(JSON.parse(String(log[0].detail)), { count: 5 });
  for (const l of s.store.listLog(200)) assert(!String(l.detail).includes("Annie"));
  s.close();
});

Deno.test("the user's marks carry over: a removed item stays removed, a note stays dealt with", async () => {
  const { s } = await newCase();
  const note = await userNote(s, "Annie called.");
  await s.ledger.markNoteDone(note, true);
  const chrono = await userChronology(s, "Annie refused the changeover.");
  await s.ledger.removeItem("chronology", chrono);
  assert(await s.ledger.removedByUser("chronology", s.store.getChronology(chrono)) !== null);

  const r = await addAnnie(s);
  assertEquals(r.typedText!.replaced.length, 2);
  const row = s.store.getChronology(chrono);
  assert(!row.description.includes("Annie"));
  assert(await s.ledger.removedByUser("chronology", row) !== null, "still removed");
  assert(row.removed_at !== null, "still hidden from Claude");
  assert(await s.ledger.noteDoneByUser(s.store.getNote(note)) !== null, "still dealt with");
  s.close();
});

Deno.test("Claude's text and text casefile can't attribute are left as written, and listed", async () => {
  const { s } = await newCase();
  // Claude's note naming "Annie": rewriting it would confirm Claude's guess (a probe).
  const claudeNote = s.store.addNote("document", "D001", "Maybe Annie is the mother?", "claude");
  // A chronology entry marked as the user's in public.db only, with no ledger record (forged).
  const forged = s.store.addChronology(
    { event_date: "2025-03-21", description: "Annie refused.", sources: [] },
    "user",
  );
  // A paragraph the user rewrote from Claude's text: Claude's words may still be in it.
  const draft = s.store.createDraft({ kind: "outline", title: "Annie's outline" }, "user");
  const p = s.store.addParagraph(draft, "Claude wrote: Annie kept them.", "claude");
  s.store.updateParagraph(p, "I think Annie kept them.", "user");
  await s.attestUserAuthorship({ id: p, draft_id: draft, body: "I think Annie kept them." });
  // A tag: who wrote it is recorded only in public.db.
  s.store.addTag("D001", "about Annie", "user");

  const r = await addAnnie(s);
  assertEquals(r.typedText!.replaced, []);
  const left = Object.fromEntries(r.typedText!.left.map((i) => [`${i.kind}:${i.id}`, i.why]));
  assertEquals(left, {
    [`note:${claudeNote}`]: "claude",
    [`chronology:${forged}`]: "claude",
    [`paragraph:${p}`]: "claude",
    [`draft_title:${draft}`]: "unconfirmed",
    "tag:D001": "unconfirmed",
  });
  // Nothing was changed.
  assertEquals(s.store.getNote(claudeNote).body, "Maybe Annie is the mother?");
  assertEquals(s.store.getChronology(forged).description, "Annie refused.");
  assertEquals(s.store.getParagraph(p).body, "I think Annie kept them.");
  assertEquals(s.store.getDraft(draft).title, "Annie's outline");
  // Nothing about Claude's text reaches the log (its count would confirm a guess).
  assertEquals(s.store.listLog(50).filter((l) => l.action === "typed_text_rechecked"), []);
  // Recorded once; another change to who's who with the same items left adds no record.
  assertEquals((await listTypedTextRechecks(s)).length, 1);
  const again = await changeEntity(s, "father", { colour: 5 });
  assertEquals(again.typedText, null, "nothing new to report");
  assertEquals((await listTypedTextRechecks(s)).length, 1);
  assert((await s.readVaultJson<unknown[]>(TYPED_TEXT_RECHECKS_FILE, [])).length === 1);
  s.close();
});

Deno.test("a person added to who's who later is replaced in the user's notes too", async () => {
  const { s } = await newCase();
  // A new person the user typed about before casefile knew them.
  const note = await userNote(s, "Speak to Jarrah Whitlock about the reports.");
  s.registry.add({
    role: "school_counsellor",
    kind: "person",
    full: "Jarrah Whitlock",
    first: "Jarrah",
    surname: "Whitlock",
  });
  const r = await s.saveRegistry();
  assertEquals(r!.replaced.map((i) => i.kind), ["note"]);
  const body = s.store.getNote(note).body;
  assert(!body.includes("Jarrah"), body);
  assert(body.includes("{{school_counsellor"), body);
  s.close();
});
