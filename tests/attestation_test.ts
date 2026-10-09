import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ProposedSpan } from "../src/core/detect/pipeline.ts";
import {
  type AdoptionAttestation,
  adoptParagraph,
  ExportBlockedError,
  paragraphState,
  unadoptParagraph,
  userAddParagraph,
  userCreateDraft,
  userEditParagraph,
} from "../src/core/drafting.ts";
import { exportDraftFile } from "../src/core/export/draft.ts";
import { CaseSession, type PublishRequest } from "../src/core/session.ts";
import {
  AFFIDAVIT,
  AFFIDAVIT_TITLE,
  FAKE_NER_NAMES,
  FakeNameDetector,
  PEOPLE,
  tempDir,
} from "./fixtures/synthetic.ts";

/**
 * The attestation ledger and authorship attestations (ADR 0008, 0009). Each test plays Claude
 * writing straight into public.db with SQL, which it can do because it has a shell (ADR 0003).
 */

const PASS = "a long test passphrase";
const ATTEST: AdoptionAttestation = { ownKnowledge: true, ownWords: true };
const CLAUDE_TEXT =
  "On 14 March 2025 {{father.first}} collected the children 90 minutes late from {{school}}.";

async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  s.detectors = [new FakeNameDetector(FAKE_NER_NAMES)];
  const doc = await s.importText({ origin: "mine", title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const { request, unresolved } = s.defaultPublishRequest(doc);
  const fatherKey = doc.newEntities.find((n) => n.full === PEOPLE.father)?.key;
  const resolved = unresolved.map((sp: ProposedSpan) => {
    if (sp.proposal.type !== "ambiguous") throw new Error("not ambiguous");
    const opt = sp.proposal.options.find((o) => o.ref === fatherKey || o.ref === "father")!;
    return { start: sp.start, end: sp.end, ref: opt.ref, form: opt.form };
  });
  const req: PublishRequest = { ...request, replacements: [...request.replacements, ...resolved] };
  await s.publish(doc.id, req);
  return { dir, s, docId: doc.id };
}

function claudeAffidavit(s: CaseSession) {
  const draft = s.store.createDraft(
    { kind: "affidavit", title: "Affidavit of {{mother}}" },
    "claude",
  );
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  return { draft, para };
}

function sql(s: CaseSession, query: string, ...args: (string | number | null)[]) {
  s.store.db.prepare(query).run(...args);
}

// ── finding 1: unsigned authorship ─────────────────────────────────────────

Deno.test("Claude marking its own paragraph as the user's does not get it past export", async () => {
  const { s } = await newCase();
  const { draft, para } = claudeAffidavit(s);
  sql(s, "UPDATE paragraphs SET author = 'user', claude_body = NULL WHERE id = ?", para);
  const p = s.store.getParagraph(para);
  assertEquals(p.author, "user", "the stored flag says user");
  assertEquals(await paragraphState(s, p), "claude_needs_you");
  const err = await assertRejects(() => exportDraftFile(s, draft, "markdown"), ExportBlockedError);
  assertEquals(err.needsReview, [para]);

  // A light edit by the user leaves it Claude's (and puts the flag back), rather than treating the
  // forged flag as the user's paragraph.
  const r = await userEditParagraph(
    s,
    para,
    "On 14 March 2025 Daniel collected the children 95 minutes late from " +
      `${PEOPLE.school}.`,
  );
  assertEquals(r.state, "claude_rewritten");
  assertEquals(s.store.getParagraph(para).author, "claude");
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_rewritten");
  await assertRejects(() => exportDraftFile(s, draft, "markdown"), ExportBlockedError);

  // The user can still adopt it deliberately.
  await adoptParagraph(s, para, ATTEST);
  await exportDraftFile(s, draft, "markdown");
  s.close();
});

Deno.test("Claude cannot borrow a user paragraph's authorship for its own text", async () => {
  const { s } = await newCase();
  const draft = await userCreateDraft(s, "affidavit", `Affidavit of ${PEOPLE.mother}`);
  const mine = await userAddParagraph(s, draft, `I am the mother of ${PEOPLE.child1}.`);
  assertEquals(await paragraphState(s, s.store.getParagraph(mine)), "user");
  sql(s, "UPDATE paragraphs SET body = ? WHERE id = ?", "{{father}} was never late.", mine);
  assertEquals(await paragraphState(s, s.store.getParagraph(mine)), "claude_needs_you");
  await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  s.close();
});

Deno.test("a paragraph the user wrote, and a rewrite they adopted, export before and after reopening", async () => {
  const { dir, s } = await newCase();
  const draft = await userCreateDraft(s, "affidavit", `Affidavit of ${PEOPLE.mother}`);
  const p1 = await userAddParagraph(s, draft, `I am the mother of ${PEOPLE.child1}.`);
  const c = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  await userEditParagraph(
    s,
    c,
    "That Friday I waited at the school gate with both kids until half past four, because " +
      `${PEOPLE.father} did not turn up when he said he would.`,
  );
  await userEditParagraph(s, p1, `I am the mother of ${PEOPLE.child1} and ${PEOPLE.child2}.`);
  assertEquals(await paragraphState(s, s.store.getParagraph(p1)), "user");
  assertEquals(await paragraphState(s, s.store.getParagraph(c)), "claude_rewritten");
  await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  await adoptParagraph(s, c, ATTEST);
  const out = await exportDraftFile(s, draft, "text");
  assert(out.content.includes(`1. I am the mother of ${PEOPLE.child1} and ${PEOPLE.child2}.`));
  s.close();

  const again = await CaseSession.open(dir, PASS);
  assertEquals(await paragraphState(again, again.store.getParagraph(p1)), "user");
  assertEquals(await paragraphState(again, again.store.getParagraph(c)), "claude_adopted");
  await exportDraftFile(again, draft, "text");
  // Withdrawn after reopening, the rewrite record still holds.
  await unadoptParagraph(again, c);
  assertEquals(await paragraphState(again, again.store.getParagraph(c)), "claude_rewritten");
  again.close();
});

// ── finding 2: unsigned baseline ───────────────────────────────────────────

Deno.test("garbage in claude_body does not turn a light user edit into a rewrite", async () => {
  const { s } = await newCase();
  const { para } = claudeAffidavit(s);
  sql(s, "UPDATE paragraphs SET claude_body = ? WHERE id = ?", "zzz qqq xxx www", para);
  const r = await userEditParagraph(
    s,
    para,
    "On 14 March 2025 Daniel collected the children 95 minutes late from " +
      `${PEOPLE.school}.`,
  );
  assertEquals(r.state, "claude_rewritten");
  const p = s.store.getParagraph(para);
  assertEquals(p.author, "claude");
  assertEquals(p.claude_body, "zzz qqq xxx www", "a light edit leaves claude_body alone");
  assertEquals(await paragraphState(s, p), "claude_rewritten");
  s.close();
});

// ── finding 3: replay after revocation ─────────────────────────────────────

Deno.test("restoring an adoption's signature after it was withdrawn does not re-adopt", async () => {
  const { s } = await newCase();
  const { draft, para } = claudeAffidavit(s);
  const adopted = await adoptParagraph(s, para, ATTEST);
  assertEquals(await paragraphState(s, adopted), "claude_adopted");
  await unadoptParagraph(s, para);
  sql(
    s,
    "UPDATE paragraphs SET adopted_at = ?, adopted_sig = ? WHERE id = ?",
    adopted.adopted_at,
    adopted.adopted_sig,
    para,
  );
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  s.close();
});

Deno.test("an adoption replayed after a user edit does not count", async () => {
  const { s } = await newCase();
  const { para } = claudeAffidavit(s);
  const adopted = await adoptParagraph(s, para, ATTEST);
  // A light edit clears the adoption; Claude then puts back the old text and the old signature.
  await userEditParagraph(
    s,
    para,
    "On 14 March 2025 Daniel collected the children 95 minutes late from " +
      `${PEOPLE.school}.`,
  );
  sql(
    s,
    "UPDATE paragraphs SET body = ?, adopted_at = ?, adopted_sig = ? WHERE id = ?",
    adopted.body,
    adopted.adopted_at,
    adopted.adopted_sig,
    para,
  );
  assertEquals(await paragraphState(s, s.store.getParagraph(para)), "claude_needs_you");
  s.close();
});

async function verifiables(s: CaseSession, docId: string) {
  const chrono = s.store.addChronology(
    {
      event_date: "2025-03-14",
      description: "{{father}} collected the children late",
      sources: [{ doc_id: docId, line_start: 9, line_end: 9 }],
    },
    "claude",
  );
  const issue = s.store.addIssue({ title: "Lateness" }, "claude");
  const evidence = s.store.addEvidence(
    issue,
    { doc_id: docId, line_start: 9, line_end: 9, note: "late" },
    "claude",
  );
  await s.verifyChronology(chrono);
  await s.verifyIssue(issue);
  await s.verifyEvidence(evidence);
  return { chrono, issue, evidence };
}

async function verifiedState(
  s: CaseSession,
  ids: { chrono: number; issue: number; evidence: number },
) {
  return [
    await s.isChronologyVerified(s.store.getChronology(ids.chrono)),
    await s.isIssueVerified(s.store.getIssue(ids.issue)),
    await s.isEvidenceVerified(s.store.getEvidence(ids.evidence)),
  ];
}

Deno.test("restoring a verification's signature after unverify does not re-verify", async () => {
  const { s, docId } = await newCase();
  const ids = await verifiables(s, docId);
  assertEquals(await verifiedState(s, ids), [true, true, true]);
  const saved = {
    chrono: s.store.getChronology(ids.chrono),
    issue: s.store.getIssue(ids.issue),
    evidence: s.store.getEvidence(ids.evidence),
  };
  await s.unverify("chronology", ids.chrono);
  await s.unverify("issue", ids.issue);
  await s.unverify("evidence", ids.evidence);
  assertEquals(await verifiedState(s, ids), [false, false, false]);
  for (
    const [table, row] of [
      ["chronology", saved.chrono],
      ["issues", saved.issue],
      ["evidence", saved.evidence],
    ] as const
  ) {
    sql(
      s,
      `UPDATE ${table} SET verified_at = ?, verified_sig = ? WHERE id = ?`,
      row.verified_at,
      row.verified_sig,
      row.id,
    );
  }
  assertEquals(await verifiedState(s, ids), [false, false, false]);
  s.close();
});

Deno.test("the ledger survives closing and reopening the case", async () => {
  const { dir, s, docId } = await newCase();
  const ids = await verifiables(s, docId);
  const { para } = claudeAffidavit(s);
  const adopted = await adoptParagraph(s, para, ATTEST);
  const saved = s.store.getIssue(ids.issue);
  await s.unverify("issue", ids.issue);
  s.close();

  // Claude replays the withdrawn verification while the app is closed.
  const again = await CaseSession.open(dir, PASS);
  sql(
    again,
    "UPDATE issues SET verified_at = ?, verified_sig = ? WHERE id = ?",
    saved.verified_at,
    saved.verified_sig,
    ids.issue,
  );
  assertEquals(await verifiedState(again, ids), [true, false, true]);
  assertEquals(
    await paragraphState(again, again.store.getParagraph(para)),
    "claude_adopted",
    `adoption at ${adopted.adopted_at} still counts`,
  );
  again.close();
});

Deno.test("records deleted through the app take their attestations with them", async () => {
  const { s, docId } = await newCase();
  const ids = await verifiables(s, docId);
  const old = s.store.getChronology(ids.chrono);
  await s.deleteChronology(ids.chrono);
  // SQLite reuses the highest rowid: recreate an identical entry and replay the old signature.
  const reborn = s.store.addChronology(
    { event_date: old.event_date, description: old.description, sources: old.sources },
    "claude",
  );
  assertEquals(reborn, ids.chrono);
  sql(
    s,
    "UPDATE chronology SET verified_at = ?, verified_sig = ? WHERE id = ?",
    old.verified_at,
    old.verified_sig,
    reborn,
  );
  assertEquals(await s.isChronologyVerified(s.store.getChronology(reborn)), false);
  s.close();
});

// ── stale entries and failed writes (security review of the ledger) ──────────

async function verifiedEntry(s: CaseSession, docId: string) {
  const id = s.store.addChronology(
    {
      event_date: "2025-03-14",
      description: "{{father}} was late",
      sources: [{ doc_id: docId, line_start: 9, line_end: 9 }],
    },
    "claude",
  );
  await s.verifyChronology(id);
  return { id, row: s.store.getChronology(id) };
}

Deno.test("an edited attestation stays dead even if the old content is put back", async () => {
  const { s, docId } = await newCase();
  const { id, row } = await verifiedEntry(s, docId);
  sql(s, "UPDATE chronology SET description = ? WHERE id = ?", "{{mother}} was late", id);
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  // Restore exactly what the user verified, with its signature.
  sql(
    s,
    "UPDATE chronology SET description = ?, verified_at = ?, verified_sig = ? WHERE id = ?",
    row.description,
    row.verified_at,
    row.verified_sig,
    id,
  );
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  s.close();
});

Deno.test("an attestation edited while the app was closed is dropped on open", async () => {
  const { dir, s, docId } = await newCase();
  const { id, row } = await verifiedEntry(s, docId);
  sql(s, "UPDATE chronology SET description = ? WHERE id = ?", "{{mother}} was late", id);
  s.close();
  const s2 = await CaseSession.open(dir, PASS);
  sql(
    s2,
    "UPDATE chronology SET description = ?, verified_at = ?, verified_sig = ? WHERE id = ?",
    row.description,
    row.verified_at,
    row.verified_sig,
    id,
  );
  s2.close();
  const s3 = await CaseSession.open(dir, PASS);
  assertEquals(await s3.isChronologyVerified(s3.store.getChronology(id)), false);
  s3.close();
});

Deno.test("a failed ledger write never leaves memory more trusting than the vault", async () => {
  const { dir, s, docId } = await newCase();
  const original = s.vault.writeJson.bind(s.vault);
  const failing = () => Promise.reject(new Error("disk full"));

  // Signing: the write fails, so the entry must not count.
  const id = s.store.addChronology({
    event_date: "2025-03-14",
    description: "x",
    sources: [{ doc_id: docId, line_start: 1, line_end: 1 }],
  }, "user");
  s.vault.writeJson = failing;
  await assertRejects(() => s.verifyChronology(id), Error, "not saved");
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  s.vault.writeJson = original;

  // Revoking: the write fails, but the revocation holds for this session...
  const { id: id2 } = await verifiedEntry(s, docId);
  s.vault.writeJson = failing;
  await assertRejects(() => s.unverify("chronology", id2), Error, "not saved");
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id2)), false);
  s.vault.writeJson = original;
  // ...and the next successful write saves it, so it does not come back after reopening.
  const { id: id3 } = await verifiedEntry(s, docId);
  s.close();
  const s2 = await CaseSession.open(dir, PASS);
  const row2 = s2.store.getChronology(id2);
  assertEquals(await s2.isChronologyVerified(row2), false);
  assert(await s2.isChronologyVerified(s2.store.getChronology(id3)));
  s2.close();
});
