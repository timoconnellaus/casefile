import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ProposedSpan } from "../src/core/detect/pipeline.ts";
import {
  CaseSession,
  LeakError,
  PlanConditionsError,
  type PublishRequest,
  UnresolvedError,
} from "../src/core/session.ts";
import { InvalidInputError } from "../src/core/publicdb.ts";
import { WrongPassphraseError } from "../src/core/vault.ts";
import {
  AFFIDAVIT,
  AFFIDAVIT_TITLE,
  FAKE_NER_NAMES,
  FakeNameDetector,
  MESSAGES,
  MESSAGES_TITLE,
  SECRETS,
  tempDir,
} from "./fixtures/synthetic.ts";

const COMMERCIAL = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };

const PASS = "a long test passphrase";

async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  s.detectors = [new FakeNameDetector(FAKE_NER_NAMES)];
  return { dir, s };
}

/** Resolve ambiguous spans the way a careful user would for the synthetic family. */
function resolveAmbiguous(
  doc: { newEntities: { key: string; full: string }[] },
  spans: ProposedSpan[],
) {
  const keyFor = (full: string) => doc.newEntities.find((n) => n.full === full)?.key;
  const fatherKey = keyFor("Daniel Okafor");
  return spans.map((s) => {
    if (s.proposal.type !== "ambiguous") throw new Error("not ambiguous");
    // Every bare "Okafor" / "Mr Okafor" in the fixtures refers to the father.
    const opt = s.proposal.options.find((o) => o.ref === fatherKey || o.ref === "father")!;
    return { start: s.start, end: s.end, ref: opt.ref, form: opt.form };
  });
}

async function publishAffidavit(s: CaseSession) {
  const doc = await s.importText({
    origin: "mine",
    title: AFFIDAVIT_TITLE,
    text: AFFIDAVIT,
    source: "affidavit.txt",
  });
  const { request, unresolved } = s.defaultPublishRequest(doc);
  await assertRejects(() => s.publishWithDefaults(doc.id), UnresolvedError);
  assert(
    unresolved.some((u) => u.text === "Mr Okafor"),
    "the shared surname should need a decision",
  );
  const req: PublishRequest = {
    ...request,
    replacements: [...request.replacements, ...resolveAmbiguous(doc, unresolved)],
  };
  return await s.publish(doc.id, req);
}

/** Read every file Claude could read (everything except the vault) as text. */
async function claudeVisibleText(dir: string): Promise<string> {
  let all = "";
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory && e.name !== "vault") await walk(p);
      else if (e.isFile) all += new TextDecoder("latin1").decode(await Deno.readFile(p));
    }
  };
  await walk(dir);
  return all;
}

Deno.test("end to end: nothing identifying reaches the Claude-visible files", async () => {
  const { dir, s } = await newCase();
  const published = await publishAffidavit(s);
  const roles = s.registry.list().map((e) => e.role).sort();
  for (const r of ["mother", "father", "child_1", "child_2", "school", "childcare"]) {
    assert(roles.includes(r), r);
  }
  // Title is tokenised too.
  assertEquals(s.store.getDocument(published.id).title, "Affidavit of {{mother}}");
  s.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const visible = await claudeVisibleText(dir);
  for (const secret of SECRETS) {
    assert(!visible.includes(secret), `"${secret}" leaked into Claude-visible files`);
  }
  s.close();
});

Deno.test("re-identification restores the original exactly", async () => {
  const { s } = await newCase();
  const doc = await publishAffidavit(s);
  const body = s.store.getDocument(doc.id).body!;
  const r = s.reidentify(body);
  assertEquals(r.unknown, []);
  assertEquals(r.malformed, []);
  // Forms render as written: first names, the learned title, and the full names.
  assertEquals(r.text, AFFIDAVIT);
  assertEquals(body.split("\n").length, AFFIDAVIT.split("\n").length);
  s.close();
});

Deno.test("a second document reuses known entities without new decisions", async () => {
  const { dir, s } = await newCase();
  await publishAffidavit(s);
  const before = s.registry.list().length;
  const doc = await s.importText({ origin: "mine", title: MESSAGES_TITLE, text: MESSAGES });
  const published = await s.publishWithDefaults(doc.id);
  assertEquals(s.registry.list().length, before);
  const body = s.store.getDocument(published.id).body!;
  assert(body.includes("{{mother.first}}: Where are you?"));
  assert(body.includes("{{father.title}}, this is the third time"));
  assertEquals(s.reidentify(body).text, MESSAGES);
  s.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const visible = await claudeVisibleText(dir);
  for (const secret of SECRETS) assert(!visible.includes(secret), `"${secret}" leaked`);
  s.close();
});

Deno.test("publishing is blocked when a known value would remain", async () => {
  const { s } = await newCase();
  await publishAffidavit(s);
  const doc = await s.importText({ origin: "mine", title: "Note", text: "Anna rang Daniel." });
  const { request } = s.defaultPublishRequest(doc);
  // Drop the replacement for "Daniel": the leak check must catch it.
  const req = {
    ...request,
    replacements: request.replacements.filter((r) =>
      doc.original.slice(r.start, r.end) !== "Daniel"
    ),
  };
  const err = await assertRejects(() => s.publish(doc.id, req), LeakError);
  assertEquals(err.leaks.map((l) => [l.field, l.text]), [["body", "Daniel"]]);
  // Nothing was published and no entities were created by the failed attempt.
  assertEquals(s.store.hasDocument(doc.id), false);
  s.close();
});

Deno.test("an identifying title blocks publishing until it is changed", async () => {
  const { s } = await newCase();
  s.detectors = [];
  const doc = await s.importText({
    origin: "mine",
    title: "Call 0412 345 678",
    text: "Nothing identifying here.",
  });
  const err = await assertRejects(() => s.publishWithDefaults(doc.id), LeakError);
  assertEquals(err.leaks[0].field, "title");
  await s.publishWithDefaults(doc.id, { title: "Phone note" });
  assertEquals(s.store.getDocument(doc.id).title, "Phone note");
  s.close();
});

Deno.test("restricted material is withheld; a commercial plan shares nothing by itself (PD-AI 5.5)", async () => {
  const { s } = await newCase();
  s.detectors = [];
  const doc = await s.importText({
    title: "School records",
    text: "Attendance: 92 percent.",
    origin: "court_or_subpoena",
  });
  await s.publishWithDefaults(doc.id);
  let row = s.store.getDocument(doc.id);
  assertEquals([row.withheld, row.body, row.title], [1, null, "[withheld: subpoena material]"]);
  assertEquals(s.store.search("Attendance"), []);
  // Commercial needs all three conditions.
  await assertRejects(() => s.setClaudeSetup("commercial"), PlanConditionsError);
  await assertRejects(
    () =>
      s.setClaudeSetup("commercial", {
        closedEnvironment: true,
        noTraining: true,
        thisCaseOnly: false,
      }),
    PlanConditionsError,
  );
  assertEquals(s.settings.claudeSetup, "consumer");
  await s.setClaudeSetup("commercial", COMMERCIAL);
  // Switching shares nothing.
  assertEquals(s.store.getDocument(doc.id).body, null);
  // The user shares this one document explicitly.
  await s.release(doc.id);
  row = s.store.getDocument(doc.id);
  assertEquals([row.withheld, row.body], [0, "Attendance: 92 percent."]);
  // Back to consumer: withdrawn, and the share is forgotten.
  const back = await s.setClaudeSetup("consumer");
  assertEquals(back.withdrawn, [doc.id]);
  assertEquals(s.store.getDocument(doc.id).body, null);
  await s.setClaudeSetup("commercial", COMMERCIAL);
  assertEquals(s.store.getDocument(doc.id).body, null, "switching back never re-shares");
  // Marking an ordinary document as restricted withholds it immediately.
  const d2 = await s.importText({ origin: "mine", title: "Notes", text: "Plain notes" });
  await s.publishWithDefaults(d2.id);
  await s.setOrigin(d2.id, "other_side");
  assertEquals(s.store.getDocument(d2.id).withheld, 1);
  s.close();
});

Deno.test("under an order, not sure and not asked stay withheld on a commercial plan", async () => {
  const { s } = await newCase();
  s.detectors = [];
  await s.setClaudeSetup("commercial", COMMERCIAL);
  for (const origin of ["under_order", "not_sure", null] as const) {
    const doc = await s.importText({ title: "Notes", text: "Plain notes", origin });
    await s.publishWithDefaults(doc.id);
    assertEquals(s.store.getDocument(doc.id).body, null, String(origin));
    await assertRejects(() => s.release(doc.id), InvalidInputError);
    await assertRejects(() => s.publishWithDefaults(doc.id, { release: true }), InvalidInputError);
    assertEquals(s.store.getDocument(doc.id).body, null, String(origin));
  }
  s.close();
});

Deno.test("a new import is not asked yet and is withheld until the user says where it came from", async () => {
  const { s } = await newCase();
  s.detectors = [];
  const doc = await s.importText({ title: "Notes", text: "Plain notes" });
  assertEquals(doc.origin, null);
  await s.publishWithDefaults(doc.id);
  const row = s.store.getDocument(doc.id);
  assertEquals([row.withheld, row.body, row.withheld_reason], [1, null, "not_asked"]);
  assertEquals(s.store.rawLines(doc.id), []);
  const r = await s.setOrigin(doc.id, "mine");
  assertEquals(r, { state: "shared", withdrawn: false });
  assertEquals(s.store.getDocument(doc.id).body, "Plain notes");
  assertEquals(await s.setOrigin(doc.id, null), { state: "withheld", withdrawn: true });
  assertEquals(s.store.getDocument(doc.id).body, null);
  s.close();
});

Deno.test("renaming an entity updates every document and still re-identifies", async () => {
  const { s } = await newCase();
  const doc = await publishAffidavit(s);
  s.store.addIssue({ title: "Conduct of {{father}}" }, "claude");
  await s.renameEntity("father", "dad");
  const body = s.store.getDocument(doc.id).body!;
  assert(!/\{\{father[.}]/.test(body));
  assert(body.includes("{{dad.first}}"));
  assertEquals(s.store.listIssues()[0].title, "Conduct of {{dad}}");
  assertEquals(s.reidentify(body).text, AFFIDAVIT);
  assertEquals(s.store.knownRoles().has("dad"), true);
  s.close();
});

Deno.test("verification signatures detect tampering and forgery (ADR 0008)", async () => {
  const { s } = await newCase();
  const doc = await publishAffidavit(s);
  const id = s.store.addChronology(
    {
      event_date: "2025-03-14",
      description: "{{father}} collected the children late",
      sources: [{ doc_id: doc.id, line_start: 9, line_end: 9 }],
    },
    "claude",
  );
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  await s.verifyChronology(id);
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), true);
  // Claude (or anything else) edits the text directly in the database, keeping the old signature.
  s.store.db.prepare("UPDATE chronology SET description = ? WHERE id = ?").run(
    "{{mother}} collected the children late",
    id,
  );
  assertEquals(await s.isChronologyVerified(s.store.getChronology(id)), false);
  // A made-up verification is not accepted either.
  const issue = s.store.addIssue({ title: "Lateness" }, "claude");
  s.store.setIssueVerification(issue, new Date().toISOString(), "0".repeat(64));
  assertEquals(await s.isIssueVerified(s.store.getIssue(issue)), false);
  await s.verifyIssue(issue);
  assertEquals(await s.isIssueVerified(s.store.getIssue(issue)), true);
  s.close();
});

Deno.test("the case reopens with the passphrase and refuses a wrong one", async () => {
  const { dir, s } = await newCase();
  const doc = await publishAffidavit(s);
  s.close();
  await assertRejects(() => CaseSession.open(dir, "not the passphrase"), WrongPassphraseError);
  const again = await CaseSession.open(dir, PASS);
  assertEquals((await again.getDoc(doc.id)).original, AFFIDAVIT);
  assertEquals(again.registry.get("mother")?.forms.full, "Anna Thornbury");
  assertEquals(again.settings.label, "Test matter");
  again.close();
});

Deno.test("an audit finds values that become identifying after publishing", async () => {
  const { s } = await newCase();
  s.detectors = [];
  const doc = await s.importText({
    origin: "mine",
    title: "Note",
    text: "Annie dropped off the kids.",
  });
  await s.publishWithDefaults(doc.id);
  assertEquals(await s.auditPublished(), []);
  s.registry.add({ kind: "person", full: "Anna Thornbury", role: "mother", aliases: ["Annie"] });
  await s.saveRegistry();
  const audit = await s.auditPublished();
  assertEquals(audit.map((a) => [a.doc, a.leaks.map((l) => l.text)]), [[doc.id, ["Annie"]]]);
  s.close();
});

Deno.test("text the user types is tokenised before Claude can see it", async () => {
  const { s } = await newCase();
  await publishAffidavit(s);
  assertEquals(
    await s.tokeniseUserText("Ask Anna about Mia"),
    "Ask {{mother.first}} about {{child_1.first}}",
  );
  await assertRejects(() => s.tokeniseUserText("Okafor said"), Error, "Ambiguous");
  // A known phone number becomes its token; an unknown one is refused.
  assertEquals(await s.tokeniseUserText("call 0412 345 678"), "call {{phone_1}}");
  await assertRejects(() => s.tokeniseUserText("call 0499 999 999"), Error, "identifying");
  s.close();
});

Deno.test("a new name the user types is refused, not stored raw", async () => {
  const { s } = await newCase();
  await publishAffidavit(s);
  s.detectors = [
    new FakeNameDetector([...FAKE_NER_NAMES, { text: "Sarah Jones", kind: "person" }]),
  ];
  assertEquals(s.registry.match("Sarah Jones"), undefined, "not a known entity");
  const err = await assertRejects(
    () => s.tokeniseUserText("Ask Sarah Jones about Mia"),
    InvalidInputError,
  );
  assert(err.message.includes('"Sarah Jones"'), err.message);
  assert(err.message.includes("people or places"), err.message);
  // Known names still become tokens, including when the detector also finds them.
  assertEquals(
    await s.tokeniseUserText("Ask Anna Thornbury about Mia"),
    "Ask {{mother}} about {{child_1.first}}",
  );
  s.close();
});

Deno.test("the case folder contains Claude guidance that denies the vault", async () => {
  const { dir, s } = await newCase();
  const settings = JSON.parse(await Deno.readTextFile(join(dir, ".claude", "settings.json")));
  assert(settings.permissions.deny.includes("Read(./vault/**)"));
  assert((await Deno.readTextFile(join(dir, "CLAUDE.md"))).includes("casefile"));
  s.close();
});
