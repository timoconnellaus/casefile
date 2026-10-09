/**
 * Paste (ADR 0019): view, copy and "Add to a draft as Claude's". Every use is logged with counts
 * only; pasted text added to a draft is Claude's and needs the user. CANON case. SYNTHETIC only.
 */
import { assert, assertEquals } from "@std/assert";
import { paragraphState } from "../src/core/drafting.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { dumpPublic } from "./fixtures/case.ts";
import { SECRETS } from "./fixtures/synthetic.ts";
import { withCase } from "./helpers/app.ts";

const PASTED =
  "On 14 March 2025 {{father.first}} collected {{child_1.first}} late (D001:1-2).\n\n" +
  "{{child_2.first}} was at {{childcare}}.";

async function canonApp() {
  const t = await withCase({ detectorFactory: () => [] });
  const s = t.state.session!;
  await seedCanon(s);
  return { ...t, s };
}

function logOf(s: { store: { listLog(n: number): { action: string; detail: string }[] } }) {
  return s.store.listLog(1000);
}

Deno.test("paste view re-identifies, checks per sentence and logs counts only", async () => {
  const { user, s } = await canonApp();
  const r = await user.post("/api/paste/view", { text: PASTED + " {{stranger}} too." });
  assertEquals(r.status, 200, r.text);
  assert(r.json.rich.text.startsWith("On 14 March 2025 Daniel collected Mia late"));
  assertEquals(r.json.unknown, ["{{stranger}}"]);
  assert(Array.isArray(r.json.sentences) && r.json.sentences.length >= 1);
  for (const sen of r.json.sentences) {
    assert(["checked", "not_checked", "cant_check"].includes(sen.state));
    assert(Array.isArray(sen.cites) && Array.isArray(sen.checks));
    assertEquals(typeof sen.text.text, "string");
  }
  // A sentence with an unknown token can't be checked.
  const withStranger = r.json.sentences.find((x: { text: { text: string } }) =>
    x.text.text.includes("{{stranger}}")
  );
  assertEquals(withStranger.state, "cant_check");

  const viewed = logOf(s).filter((l) => l.action === "paste_viewed");
  assertEquals(viewed.length, 1);
  const detail = JSON.parse(viewed[0].detail);
  assertEquals(detail.chars, PASTE_WITH_STRANGER.length);
  assertEquals(detail.paragraphs, 2);
  assertEquals(detail.unknown, 1);
  for (const bit of ["{{father", "collected", "stranger", ...SECRETS]) {
    assert(!viewed[0].detail.includes(bit), `log has "${bit}"`);
  }
  assertEquals((await user.post("/api/paste/view", { text: "" })).status, 400);
  assertEquals((await user.post("/api/paste/view", { text: "x".repeat(200_001) })).status, 400);
});

const PASTE_WITH_STRANGER = PASTED + " {{stranger}} too.";

Deno.test("copying is logged without content", async () => {
  const { user, s } = await canonApp();
  assertEquals((await user.post("/api/paste/copied", { chars: 120 })).status, 200);
  assertEquals((await user.post("/api/paste/copied", { chars: "lots" })).status, 200);
  const copied = logOf(s).filter((l) => l.action === "paste_copied").map((l) =>
    JSON.parse(l.detail)
  );
  assertEquals(copied, [{}, { chars: 120 }]);
});

Deno.test("adding a paste to a draft stores Claude's paragraphs that need the user", async () => {
  const { user, s } = await canonApp();
  const draft = (await user.post("/api/drafts", { kind: "affidavit", title: "Affidavit" })).json.id;
  const r = await user.post("/api/paste/add-to-draft", { draftId: draft, text: PASTED });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.ids.length, 2);
  assertEquals(r.json.state, "claude_needs_you");
  for (const id of r.json.ids) {
    const p = s.store.getParagraph(id);
    assertEquals(p.author, "claude");
    assertEquals(await paragraphState(s, p), "claude_needs_you");
  }
  assertEquals(s.store.getParagraph(r.json.ids[1]).body, "{{child_2.first}} was at {{childcare}}.");
  const added = logOf(s).filter((l) => l.action === "paste_added");
  assertEquals(added.map((l) => JSON.parse(l.detail)), [{ draft, paragraphs: 2 }]);

  // The affidavit cannot be exported until each is adopted.
  const exp = await user.get(`/api/drafts/${draft}/export`);
  assertEquals(exp.status, 409);
  assertEquals(exp.json.needsReview, r.json.ids);

  // Undo: delete the paragraphs that were added.
  for (const id of r.json.ids) {
    assertEquals((await user.req("DELETE", `/api/paragraphs/${id}`)).status, 200);
  }
  assertEquals(s.store.listParagraphs(draft).length, 0);
});

Deno.test("a paste naming a real person in plain text is refused and stores nothing (probing)", async () => {
  const { user, s } = await canonApp();
  const draft = (await user.post("/api/drafts", { kind: "outline", title: "Outline" })).json.id;
  const before = dumpPublic(s.store);
  // Claude guessed names in its answer; tokenising them would tell it which guesses were right.
  const r = await user.post("/api/paste/add-to-draft", {
    draftId: draft,
    text: "Sarah Anna Jessica collected the kids.\n\nIt was late.",
  });
  assertEquals(r.status, 400);
  assertEquals(dumpPublic(s.store), before);
  assertEquals((await s.securityLog()).map((e) => e.event), ["possible_probe"]);
  assertEquals(
    (await user.post("/api/paste/add-to-draft", { draftId: 999, text: "x" })).status,
    404,
  );
  assertEquals(
    (await user.post("/api/paste/add-to-draft", { draftId: draft, text: "\n\n  \n" })).status,
    400,
  );
});
