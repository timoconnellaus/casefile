/**
 * Exposures (ADR 7): a shared document found to show a known value after a change to who's who is
 * withdrawn at once, recorded in the vault with Claude's reads in the window, and re-shared only
 * after a re-check. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { normaliseArgv, run, STRING_FLAGS } from "../src/cli/commands.ts";
import { CaseSession, LeakError, SafetyError } from "../src/core/session.ts";
import { EXPOSURE_CHECK_FAILED_FILE, listExposures } from "../src/core/exposure.ts";
import { changeEntity } from "../src/core/people.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { dumpPublic } from "./fixtures/case.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const PASS = "a long test passphrase";
const COMMERCIAL = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };

/** D006, a letter from the other side's lawyer: 14 lines, "Annie" on lines 4 and 13. */
const D006_LINES = [
  "Dear Ms Thornbury,",
  "",
  "We act for Daniel in this matter.",
  "Our client says Annie refused the changeover on 21 March 2025.",
  "Our client says Mia was upset at the handover.",
  "Our client proposes changeovers at the school gate.",
  "Our client proposes that Lachlan attend swimming on Saturdays.",
  "Please respond within 14 days.",
  "We note the matter is listed in May.",
  "Our client is willing to attend mediation.",
  "Our client asks that the children call him on Sundays.",
  "Our client reserves his rights.",
  "Annie may contact our office to discuss.",
  "Yours faithfully",
];

async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Parenting matter 2025", { kdfIterations: 1_000 });
  s.detectors = [];
  return { dir, s };
}

/** Run the Claude-facing CLI in-process against the case folder. */
async function cli(dir: string, argv: string[]) {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: ["json", "help"],
    collect: ["source"],
    string: STRING_FLAGS,
  });
  return await run(args, { cwd: dir, env: {}, readStdin: () => Promise.resolve("") });
}

async function importDoc(s: CaseSession, title: string, text: string, origin = "mine" as const) {
  return await s.importText({ title, text, origin });
}

Deno.test("CANON D006: a nickname added later withdraws the shared letter, records the exposure, and re-check re-shares it", async () => {
  const { dir, s } = await newCase();
  await seedCanon(s, { omitAliases: ["Annie"] }); // D001, D002
  // D003-D005: other documents, so the letter is D006 as in CANON.
  for (const t of ["School records, 2024", "Subpoena material", "Court material"]) {
    const d = await s.importText({ title: t, text: "Nothing here.", origin: "court_or_subpoena" });
    await s.publishWithDefaults(d.id);
  }
  const d6 = await importDoc(s, "Letter from the other side's lawyer", D006_LINES.join("\n"));
  assertEquals(d6.id, "D006");
  await s.publishWithDefaults(d6.id);
  assertEquals(s.docState(await s.getDoc("D006")), "shared");
  assert(s.store.getDocument("D006").body!.includes("Annie refused"), "shared as written");
  // D015 and D016 (here D007, D008) are still to review, and also mention Annie.
  const d15 = await importDoc(s, "Email from childcare centre", "Annie picked up Mia at 3pm.");
  const d16 = await importDoc(s, "School reports term 2", "Annie attended the interview.");
  // Claude's chronology entry citing D006, checked by the user.
  const chrono = s.store.addChronology(
    { event_date: "2025-03-21", description: "Changeover refused", sources: [] },
    "user",
  );
  s.store.db.prepare(
    "INSERT INTO chronology_sources(entry_id, doc_id, line_start, line_end) VALUES (?, 'D006', 4, 4)",
  )
    .run(chrono);
  await s.verifyChronology(chrono);
  assert(await s.isChronologyVerified(s.store.getChronology(chrono)));

  // Claude reads lines 1-12 through the CLI.
  const read = await cli(dir, ["docs", "show", "D006", "--lines", "1-12"]);
  assertEquals(read.code, 0, read.err);
  assert(read.out.includes("Annie refused"));

  // The user adds the nickname "Annie".
  const mother = s.registry.get("mother")!;
  await s.updateEntity("mother", { aliases: [...mother.aliases, "Annie"] });

  // D006 is withdrawn at once: no body, no lines, nothing searchable.
  const row = s.store.getDocument("D006");
  assertEquals([row.withheld, row.body, row.withheld_reason], [1, null, "exposed"]);
  assertEquals(s.store.rawLines("D006"), []);
  assertEquals(s.store.search("refused"), []);
  assert(!dumpPublic(s.store).includes("Annie refused"), "no copy of the text in public.db");
  assertEquals(s.docState(await s.getDoc("D006")), "exposed");
  // The log names the document and the reason, never the value.
  const logged = s.store.logForDoc("D006").filter((r) => r.action === "document_withdrawn");
  assertEquals(logged.length, 1);
  assertEquals(JSON.parse(logged[0].detail), { doc: "D006", reason: "exposed" });
  assert(!JSON.stringify(s.store.listLog(1000)).includes("Annie"), "no value in the AI-use log");

  // The exposure, in the vault: the window, Claude's read, and the new matches.
  const [exp] = await listExposures(s);
  assertExists(exp);
  assertEquals(exp.doc, "D006");
  assertEquals(exp.roles, ["mother"]);
  assertEquals(exp.resharedAt, null);
  assert(exp.sharedAt <= exp.foundAt && exp.foundAt === exp.withdrawnAt);
  assertEquals(exp.claudeReads.map((r) => r.lines), ["1-12"]);
  assertEquals(exp.newMatchesIn.sort(), [d15.id, d16.id]);
  // Those pending documents were detected again and now propose the mother.
  for (const id of [d15.id, d16.id]) {
    const d = await s.getDoc(id);
    assert(
      d.proposals.some((p) => p.proposal.type === "existing" && p.proposal.role === "mother"),
      id,
    );
  }
  // It cannot be shared one at a time while exposed, even on a commercial plan.
  await s.setClaudeSetup("commercial", COMMERCIAL);
  await assertRejects(() => s.release("D006"));
  await s.setClaudeSetup("consumer");

  // Re-check and re-share.
  const r = await s.recheck("D006");
  assertEquals(r, { id: "D006", state: "shared", unresolved: 0 });
  const back = s.store.getDocument("D006");
  assertEquals(back.withheld, 0);
  assert(back.body!.includes("{{mother}} refused"), back.body!);
  assert(!back.body!.includes("Annie"));
  const [closed] = await listExposures(s);
  assertExists(closed.resharedAt);
  assertEquals(s.docState(await s.getDoc("D006")), "shared");
  // The checked chronology entry's cited line changed: the check no longer holds ("changed").
  assertEquals(await s.isChronologyVerified(s.store.getChronology(chrono)), false);
  s.close();
});

Deno.test("a document withheld by origin is not an exposure, and stays withheld until re-checked", async () => {
  const { s } = await newCase();
  await seedCanon(s, { omitAliases: ["Annie"] });
  const d = await s.importText({
    title: "Daniel's affidavit, May 2025",
    text: "Annie was late again.",
    origin: "other_side",
  });
  await s.publishWithDefaults(d.id);
  const mother = s.registry.get("mother")!;
  await s.updateEntity("mother", { aliases: [...mother.aliases, "Annie"] });
  assertEquals(await listExposures(s), [], "Claude never had it");
  assertEquals(s.docState(await s.getDoc(d.id)), "withheld");
  // Origin changed to the user's own: the stale text must not be shared.
  const r = await s.setOrigin(d.id, "mine");
  assertEquals(r.withdrawn, false);
  assertEquals(s.store.getDocument(d.id).body, null);
  assertEquals(s.store.getDocument(d.id).withheld_reason, "exposed");
  assertEquals(s.docState(await s.getDoc(d.id)), "needs_review");
  // A commercial share is refused too.
  await s.setOrigin(d.id, "other_side");
  await s.setClaudeSetup("commercial", COMMERCIAL);
  await assertRejects(() => s.release(d.id), LeakError);
  assertEquals(s.store.getDocument(d.id).body, null);
  s.close();
});

Deno.test("an exposure found while the app was closed is withdrawn and recorded on open", async () => {
  const { dir, s } = await newCase();
  await seedCanon(s, { omitAliases: ["Annie"] });
  const d = await importDoc(s, "Letter", "Annie rang.");
  await s.publishWithDefaults(d.id);
  // Who's who changes in the vault, but the follow-through never ran (the app stopped).
  const mother = s.registry.get("mother")!;
  mother.aliases.push("Annie");
  await s.vault.writeJson("entities", s.registry.toJSON());
  assert(s.store.getDocument(d.id).body!.includes("Annie"));
  s.close();
  const again = await CaseSession.open(dir, PASS);
  assertEquals(again.store.getDocument(d.id).body, null);
  assertEquals((await listExposures(again)).map((e) => e.doc), [d.id]);
  again.close();
});

Deno.test("marking someone safety-sensitive withdraws a document that left their name as written", async () => {
  const { s } = await newCase();
  await seedCanon(s);
  s.registry.get("mother")!.safety = false;
  await s.saveRegistry();
  const d = await importDoc(s, "Note", "Anna rang at noon.");
  await s.publish(d.id, {
    newEntities: [],
    replacements: [],
    ignore: ["Anna"],
    ignoreReasons: { Anna: "a different Anna" },
  });
  assert(s.store.getDocument(d.id).body!.includes("Anna"));
  await s.updateEntity("mother", { safety: true });
  assertEquals(s.store.getDocument(d.id).body, null, "withdrawn: safety values are never kept");
  assertEquals((await listExposures(s)).map((e) => e.doc), [d.id]);
  // Re-check replaces it (the earlier "leave as written" no longer counts) and re-shares.
  const r = await s.recheck(d.id);
  assertEquals(r.state, "shared");
  assertEquals(s.store.getDocument(d.id).body, "{{mother.first}} rang at noon.");
  s.close();
});

Deno.test("reopen does not carry a safety value's 'leave as written' into the next share", async () => {
  const { s } = await newCase();
  await seedCanon(s);
  s.registry.get("mother")!.safety = false;
  await s.saveRegistry();
  const d = await importDoc(s, "Note", "Anna rang at noon.");
  await s.publish(d.id, {
    newEntities: [],
    replacements: [],
    ignore: ["Anna"],
    ignoreReasons: { Anna: "a different Anna" },
  });
  // Marked safety-sensitive directly in the vault (no follow-through), then reviewed again.
  s.registry.get("mother")!.safety = true;
  await s.reopen(d.id);
  const doc = await s.getDoc(d.id);
  assert(
    doc.proposals.some((p) => p.proposal.type === "existing" && p.proposal.role === "mother"),
    "the value is proposed again",
  );
  // Sharing without replacing it is refused by the leak check, not by the old ignore.
  await assertRejects(
    () => s.publish(d.id, { newEntities: [], replacements: [] }),
    LeakError,
  );
  // Asking again to leave it as written is refused outright.
  await assertRejects(
    () =>
      s.publish(d.id, {
        newEntities: [],
        replacements: [],
        ignore: ["Anna"],
        ignoreReasons: { Anna: "still a different Anna" },
      }),
    SafetyError,
  );
  assertEquals(s.store.hasDocument(d.id), false);
  await s.publishWithDefaults(d.id);
  assertEquals(s.store.getDocument(d.id).body, "{{mother.first}} rang at noon.");
  s.close();
});

Deno.test("a nickname added while a publish is running survives, and the document is checked against it", async () => {
  const { dir, s } = await newCase();
  await seedCanon(s, { omitAliases: ["Annie"] });
  const d = await importDoc(s, "Note", "Annie rang Anna.");
  // A detector that holds the publish (it checks the title) until released.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const inPublish = new Promise<void>((r) => (started = r));
  s.detectors = [{
    name: "slow",
    detect: async () => {
      started();
      await gate;
      return [];
    },
  }];
  const publishing = s.publishWithDefaults(d.id);
  await inPublish;
  const mother = s.registry.get("mother")!;
  const adding = changeEntity(s, "mother", { aliases: [...mother.aliases, "Annie"] });
  release();
  await publishing;
  await adding;
  assert(s.registry.get("mother")!.aliases.includes("Annie"), "the nickname is not lost");
  const body = s.store.getDocument(d.id).body;
  assert(body === null || !body.includes("Annie"), `shared as written: ${body}`);
  assertEquals((await listExposures(s)).map((e) => e.doc), [d.id]);
  s.close();
  // And it is in the vault: a reopened case still knows it.
  const again = await CaseSession.open(dir, PASS);
  assert(again.registry.get("mother")!.aliases.includes("Annie"));
  assertEquals(again.store.getDocument(d.id).body, null);
  again.close();
});

Deno.test("a failed re-share leaves an exposed document withheld, and an unreadable one is withdrawn", async () => {
  const { s } = await newCase();
  await seedCanon(s, { omitAliases: ["Annie"] });
  const a = await importDoc(s, "Note A", "Annie rang.");
  const b = await importDoc(s, "Note B", "Plain words.");
  await s.publishWithDefaults(a.id);
  await s.publishWithDefaults(b.id);
  // B's vault file is damaged; the next check cannot read it.
  await s.vault.writeJson(s.docName(b.id), "not a document");
  s.forgetCachedDocs();
  const mother = s.registry.get("mother")!;
  await s.updateEntity("mother", { aliases: [...mother.aliases, "Annie"] });
  assertEquals(s.store.getDocument(a.id).body, null, "A is still withdrawn");
  assertEquals(s.store.getDocument(b.id).body, null, "B could not be checked: withdrawn");
  const failed = s.store.listLog(20).find((r) => r.action === "exposure_check_failed")!;
  // Counts only in the log Claude can read; which documents failed stays in the vault.
  assertEquals(JSON.parse(failed.detail), { count: 1 });
  assertEquals(
    (await s.readVaultJson<{ docs: string[] }>(EXPOSURE_CHECK_FAILED_FILE, { docs: [] })).docs,
    [b.id],
  );
  // Sharing A again without replacing the nickname is refused, and A stays withheld.
  await assertRejects(
    () => s.publish(a.id, { newEntities: [], replacements: [] }),
    LeakError,
  );
  assertEquals(s.store.getDocument(a.id).body, null);
  assertEquals(s.docState(await s.getDoc(a.id)), "exposed");
  s.close();
});

Deno.test("the log Claude can read names no document an exposure check matched or failed on", async () => {
  const { s } = await newCase();
  await seedCanon(s, { omitAliases: ["Annie"] });
  const shared = await importDoc(s, "Letter", "Annie called on Monday.");
  await s.publishWithDefaults(shared.id);
  const pending = await importDoc(s, "Notes", "Annie phoned the school.");
  const mother = s.registry.get("mother")!;
  await s.updateEntity("mother", { aliases: [...mother.aliases, "Annie"] });
  const row = s.store.listLog(50).find((r) => r.action === "documents_redetected");
  assertExists(row, "the pending document was looked at again");
  assert(!row.detail.includes(pending.id), "which pending document matched is not logged");
  assertEquals(JSON.parse(row.detail), { count: 1 });
  s.close();
});
