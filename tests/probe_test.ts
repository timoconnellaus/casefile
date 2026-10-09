/**
 * Probing via re-tokenisation (security review, finding 1). Claude writes guessed names into text
 * the user later edits; tokenising the edit would turn the right guesses into tokens, which Claude
 * then reads back. Each test plays Claude writing straight into public.db.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { userEditParagraph } from "../src/core/drafting.ts";
import { ProbeError } from "../src/core/session.ts";
import { SECRETS } from "./fixtures/synthetic.ts";
import { dumpPublic, publishedCase } from "./fixtures/case.ts";

/** Claude's guesses: two are real names (Anna, Mia), three are not. */
const GUESSES = "On Tuesday Sarah Anna Jessica Priya Mia was late to school.";

Deno.test("a light user edit of Claude's guessed names is refused, not tokenised", async () => {
  const { s } = await publishedCase();
  const draft = s.store.createDraft({ kind: "affidavit", title: "Draft" }, "claude");
  const para = s.store.addParagraph(draft, GUESSES, "claude");
  const before = dumpPublic(s.store);

  // The user sees Claude's text (with the real names Claude guessed) and fixes one word.
  const edited = GUESSES.replace("Tuesday", "Wednesday");
  const err = await assertRejects(() => userEditParagraph(s, para, edited), ProbeError);
  assertEquals(err.roles, ["child_1", "mother"]);

  // public.db is exactly as it was: no text, timestamp or log row tells Claude anything.
  assertEquals(dumpPublic(s.store), before);
  // The attempt is recorded in the vault's security log, for the user, without names or roles.
  const events = await s.securityLog();
  assertEquals(events.map((e) => e.event), ["possible_probe"]);
  for (const secret of [...SECRETS, "child_1", "mother"]) {
    assert(!JSON.stringify(events).includes(secret), `security log must not mention ${secret}`);
  }
  s.close();
});

Deno.test("an edit that removes Claude's names, or uses tokens, is saved", async () => {
  const { s } = await publishedCase();
  const draft = s.store.createDraft({ kind: "affidavit", title: "Draft" }, "claude");
  const para = s.store.addParagraph(draft, GUESSES, "claude");
  const r = await userEditParagraph(
    s,
    para,
    "On Tuesday {{child_1.first}} was late to school because of traffic on the highway.",
  );
  assertEquals(r.paragraph.body.includes("Anna"), false);
  assert(r.paragraph.body.includes("{{child_1.first}}"));
  s.close();
});

Deno.test("the user typing a real name into Claude's text where Claude had none is tokenised", async () => {
  const { s } = await publishedCase();
  const draft = s.store.createDraft({ kind: "affidavit", title: "Draft" }, "claude");
  const para = s.store.addParagraph(draft, "On Tuesday the child was late to school.", "claude");
  const r = await userEditParagraph(s, para, "On Tuesday Mia was late to school.");
  assertEquals(r.paragraph.body, "On Tuesday {{child_1.first}} was late to school.");
  s.close();
});

Deno.test("tokeniseUserText with `replacing` refuses known values Claude wrote as plain text", async () => {
  const { s } = await publishedCase();
  await assertRejects(
    () => s.tokeniseUserText("Ms Thornbury", { replacing: ["Thornbury"], target: "doc:D001" }),
    ProbeError,
  );
  // Tokens in Claude's text are not plain text, so they do not count.
  assertEquals(
    await s.tokeniseUserText("Anna Thornbury", { replacing: ["{{mother}}"] }),
    "{{mother}}",
  );
  s.close();
});

Deno.test("the guard sees every form tokenising would replace (same matcher)", async () => {
  const { s } = await publishedCase();
  const forms = [
    "ANNA", // case
    "Anna\u2019s", // typographic apostrophe
    "Anna\u02BCs", // modifier-letter apostrophe
    "the Okafors", // plural
    "the Okafors'", // possessive plural
    "\uFF21\uFF4E\uFF4E\uFF41", // full-width letters
    "Anna  Thornbury", // double space
    "Anna\u00A0Thornbury", // no-break space
    "Ms  Thornbury", // title with odd spacing
  ];
  for (const form of forms) {
    const claude = `Then ${form} arrived at the school.`;
    const user = `Later ${form} arrived at the school.`;
    // Whatever tokenising would change in the user's text, the guard refuses.
    const tokenised = await s.tokeniseUserText(user).catch(() => null);
    assert(tokenised === null || tokenised !== user, `${form} is a known value`);
    await assertRejects(
      () => s.tokeniseUserText(user, { replacing: [claude] }),
      ProbeError,
      undefined,
      `guard misses ${JSON.stringify(form)}`,
    );
  }
  s.close();
});
