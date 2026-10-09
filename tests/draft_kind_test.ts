/**
 * Draft kinds are recorded in the vault (security review, finding 2). `drafts.kind` is in
 * public.db, so Claude could turn an affidavit into an outline to get unreviewed paragraphs past
 * the export gate (ADR 9).
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  ExportBlockedError,
  ExportNeedsConfirmError,
  userCreateDraft,
} from "../src/core/drafting.ts";
import { exportDraftFile } from "../src/core/export/draft.ts";
import { CaseSession } from "../src/core/session.ts";
import { publishedCase } from "./fixtures/case.ts";

import { PASS } from "./fixtures/case.ts";
const CLAUDE_TEXT = "On 14 March 2025 {{father.first}} collected the children late.";

function sql(s: CaseSession, query: string, ...args: (string | number | null)[]) {
  s.store.db.prepare(query).run(...args);
}

Deno.test("changing the user's affidavit to an outline in public.db does not unblock export", async () => {
  const { s } = await publishedCase();
  const draft = await userCreateDraft(s, "affidavit", "Affidavit");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  sql(s, "UPDATE drafts SET kind = 'outline' WHERE id = ?", draft);
  const err = await assertRejects(() => exportDraftFile(s, draft, "markdown"), ExportBlockedError);
  assertEquals(err.needsReview, [para]);
  assertEquals((await s.draftKind(s.store.getDraft(draft))).changed, true);
  s.close();
});

Deno.test("a Claude affidavit the app has seen stays an affidavit, across reopening", async () => {
  const { s, dir } = await publishedCase();
  const draft = s.store.createDraft({ kind: "affidavit", title: "Affidavit" }, "claude");
  const para = s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  await s.recordDraftKinds(); // the app lists the drafts
  s.close();

  // While the app is closed, Claude changes the kind.
  const s1 = await CaseSession.open(dir, PASS);
  sql(s1, "UPDATE drafts SET kind = 'letter' WHERE id = ?", draft);
  s1.close();
  const s2 = await CaseSession.open(dir, PASS);
  const err = await assertRejects(() => exportDraftFile(s2, draft, "text"), ExportBlockedError);
  assertEquals(err.needsReview, [para]);
  s2.close();
});

Deno.test("a draft whose kind was never recorded is treated as an affidavit", async () => {
  const { s } = await publishedCase();
  const draft = s.store.createDraft({ kind: "outline", title: "Outline" }, "claude");
  s.store.addParagraph(draft, CLAUDE_TEXT, "claude");
  await assertRejects(() => exportDraftFile(s, draft, "text"), ExportBlockedError);
  // Once the app has seen it as an outline, it exports with the user confirming the flags (ADR 9).
  await s.recordDraftKinds();
  await assertRejects(() => exportDraftFile(s, draft, "text"), ExportNeedsConfirmError);
  assertEquals(
    (await exportDraftFile(s, draft, "text", { confirm: true })).filename.startsWith("outline-"),
    true,
  );
  s.close();
});
