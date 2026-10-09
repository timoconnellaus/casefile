// Merging and removing who's who entries, and "Tidy up who's who" suggestions (ADR 25).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { CaseSession, type PublishRequest, type StoredDoc } from "../src/core/session.ts";
import { InvalidInputError } from "../src/core/publicdb.ts";
import type { FetchFn } from "../src/core/detect/llm.ts";
import {
  checkSuggestions,
  harmlessShape,
  ruleSuggestions,
  settle,
} from "../src/core/detect/tidy.ts";
import { suggestTidy, tidyEntries } from "../src/core/people.ts";
import { EntityRegistry, splitPersonName } from "../src/core/entities.ts";
import { FakeNameDetector, tempDir } from "./fixtures/synthetic.ts";
import { withCase } from "./helpers/app.ts";

const PASS = "a long test passphrase";

// A court form as a PDF reads: the father is written two ways, and a time was flagged.
const FORM = `Applicant: Anna Thornbury
Respondent: OKAFOR, Daniel
1. The father, Daniel Okafor, collected the children at 5:01 PM.
2. OKAFOR, Daniel did not attend the handover.
`;

/** Finds the people on the form, as a model would, and (by mistake) the time. */
function formDetector() {
  return new FakeNameDetector([
    { text: "Anna Thornbury", kind: "person", roleHint: "mother" },
    { text: "Daniel Okafor", kind: "person", roleHint: "father" },
    { text: "OKAFOR, Daniel", kind: "person" },
    // A model flagging a time: detection drops it (ADR 25), so tests add it by hand below.
    { text: "5:01 PM", kind: "other" },
  ]);
}

async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  s.detectors = [formDetector()];
  return { dir, s };
}

/** Publish, resolving any ambiguous span with its first option. */
async function publishForm(s: CaseSession): Promise<StoredDoc> {
  const doc = await s.importText({ origin: "mine", title: "Form", text: FORM, source: "f.pdf" });
  const { request, unresolved } = s.defaultPublishRequest(doc);
  assert(!doc.proposals.some((p) => p.text === "5:01 PM"), "a time is not proposed");
  // As a case made before that fix would have it: the time was replaced as an entry.
  const t = FORM.indexOf("5:01 PM");
  const req: PublishRequest = {
    ...request,
    newEntities: [...request.newEntities, { ref: "t", kind: "other", full: "5:01 PM" }],
    replacements: [
      ...request.replacements,
      { start: t, end: t + 7, ref: "t", form: "full" },
      ...unresolved.map((u) => {
        const o = (u.proposal as { options: { ref: string; form: "full" }[] }).options[0];
        return { start: u.start, end: u.end, ref: o.ref, form: o.form };
      }),
    ],
  };
  return await s.publish(doc.id, req);
}

const roles = (s: CaseSession) => s.registry.list().map((e) => e.role).sort();

Deno.test("the form makes a duplicate father and an entry for a time", async () => {
  const { s } = await newCase();
  await publishForm(s);
  assertEquals(roles(s), ["father", "mother", "other_1", "person_1"]);
  s.close();
});

Deno.test("merging folds one entry into another everywhere, including Claude's work", async () => {
  const { s } = await newCase();
  const doc = await publishForm(s);
  const note = s.store.addNote("case", "case", "{{person_1}} missed the handover", "claude");
  await s.mergeEntity("person_1", "father");
  assertEquals(roles(s), ["father", "mother", "other_1"]);
  const father = s.registry.get("father")!;
  // "OKAFOR, Daniel" is the surname and first name the father already has: only the spelling is kept.
  assertEquals(father.aliases, ["OKAFOR, Daniel"]);
  const body = s.store.getDocument(doc.id).body!;
  assert(!body.includes("person_1"), body);
  assert(!/OKAFOR|Okafor|Daniel/.test(body), body);
  assertEquals(body.match(/\{\{father\}\}/g)?.length, 3);
  assertEquals(s.store.getNote(note).body, "{{father}} missed the handover");
  assertEquals(s.store.knownRoles().has("person_1"), false);
  const vault = await s.getDoc(doc.id);
  assert(vault.replacements.every((r) => r.role !== "person_1"));
  assertEquals(s.docState(vault), "shared");
  // A new document with the other spelling now finds the father.
  const next = await s.importText({ origin: "mine", title: "Next", text: "OKAFOR, Daniel\n" });
  assert(
    next.proposals.some((p) => p.proposal.type === "existing" && p.proposal.role === "father"),
  );
  s.close();
});

Deno.test("merging is refused for an entry into itself or one that doesn't exist", async () => {
  const { s } = await newCase();
  await publishForm(s);
  await assertRejects(() => s.mergeEntity("father", "father"), InvalidInputError);
  await assertRejects(() => s.mergeEntity("person_9", "father"), InvalidInputError);
  // A person can't be merged into a time (or a number into a person).
  await assertRejects(
    () => s.mergeEntity("person_1", "other_1"),
    InvalidInputError,
    "different kinds",
  );
  assertEquals(roles(s), ["father", "mother", "other_1", "person_1"]);
  s.close();
});

Deno.test("removing an entry leaves its value as written, with the reason", async () => {
  const { s } = await newCase();
  const doc = await publishForm(s);
  s.store.addNote("case", "case", "At {{other_1}} the children were collected", "claude");
  await assertRejects(() => s.removeEntity("other_1", "  "), InvalidInputError, "Say why");
  await s.removeEntity("other_1", "A time of day");
  assertEquals(s.registry.get("other_1"), undefined);
  const body = s.store.getDocument(doc.id).body!;
  assert(body.includes("5:01 PM"), body);
  assert(!body.includes("other_1"));
  const vault = await s.getDoc(doc.id);
  assertEquals(vault.ignoreReasons?.["5:01 PM"], "A time of day");
  assertEquals(s.docState(vault), "shared");
  assert(s.store.listNotes().some((n) => n.body === "At 5:01 PM the children were collected"));
  s.close();
});

Deno.test("removing is refused for safety-sensitive entries and values another entry has", async () => {
  const { s } = await newCase();
  await publishForm(s);
  s.registry.update("mother", { safety: true });
  await assertRejects(
    () => s.removeEntity("mother", "not needed"),
    InvalidInputError,
    "safety-sensitive",
  );
  // person_1's "OKAFOR, Daniel" shares "Daniel" with the father: merge, don't remove.
  await assertRejects(
    () => s.removeEntity("person_1", "duplicate"),
    InvalidInputError,
    "Merge this entry",
  );
  // A longer value with someone else's name inside it would put that name in Claude's notes.
  s.registry.add({ kind: "other", full: "Anna Thornbury Pty Ltd", role: "other_9" });
  await assertRejects(() => s.removeEntity("other_9", "x"), InvalidInputError, "contains");
  // Anything a rule always replaces stays replaced.
  s.registry.add({ kind: "other", full: "0412 555 019", role: "other_8" });
  await assertRejects(() => s.removeEntity("other_8", "x"), InvalidInputError, "looks like");
  s.close();
});

Deno.test("merging an entry still waiting for review updates its proposals", async () => {
  const { s } = await newCase();
  await publishForm(s);
  const doc = await s.importText({ origin: "mine", title: "Later", text: "OKAFOR, Daniel\n" });
  assert(
    doc.proposals.some((p) => p.proposal.type === "existing" && p.proposal.role === "person_1"),
  );
  await s.mergeEntity("person_1", "father");
  const after = await s.getDoc(doc.id);
  assert(
    after.proposals.every((p) => p.proposal.type !== "existing" || p.proposal.role !== "person_1"),
  );
  assert(
    after.proposals.some((p) => p.proposal.type === "existing" && p.proposal.role === "father"),
  );
  s.close();
});

Deno.test("a name written SURNAME, Given names splits the right way round", () => {
  assertEquals(splitPersonName("OKAFOR, Daniel James"), { first: "Daniel", surname: "OKAFOR" });
  assertEquals(splitPersonName("Daniel Okafor"), { first: "Daniel", surname: "Okafor" });
});

// ── suggestions ────────────────────────────────────────────────────────────

Deno.test("harmless shapes: times, dates and amounts, never a date of birth", () => {
  assertEquals(harmlessShape("5:01 PM", "other"), "It is a time of day.");
  assertEquals(harmlessShape("14 March 2025", "other"), "It is an ordinary date.");
  assertEquals(harmlessShape("$1,250.00", "other"), "It is an amount of money.");
  assertEquals(harmlessShape("90 minutes", "other"), "It is a length of time.");
  assertEquals(harmlessShape("3/3/2017", "date_of_birth"), null);
  assertEquals(harmlessShape("Kiama Downs", "place"), null);
});

Deno.test("security: names that look like months or bare numbers are never harmless", () => {
  for (const v of ["Marcus", "June", "Augustine", "May", "Octavia", "Junee", "Sunday", "12", "7"]) {
    assertEquals(harmlessShape(v, "other"), null, v);
  }
  assertEquals(harmlessShape("June 2025", "other"), "It is an ordinary date.");
  // Whatever it looks like, a person, number or contact detail is never harmless.
  for (const k of ["person", "address", "phone", "email", "identifier", "date_of_birth"] as const) {
    assertEquals(harmlessShape("5:01 PM", k), null, k);
  }
});

Deno.test("security: a model detection of a person called June or Marcus is kept", async () => {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  s.detectors = [
    new FakeNameDetector([
      { text: "June", kind: "person" },
      { text: "Marcus", kind: "other" },
    ]),
  ];
  const doc = await s.importText({ origin: "mine", title: "N", text: "June met Marcus.\n" });
  assertEquals(doc.proposals.map((p) => p.text).sort(), ["June", "Marcus"]);
  s.close();
});

Deno.test("rules suggest merging a name written backwards and removing a time", async () => {
  const { s } = await newCase();
  await publishForm(s);
  const entries = await tidyEntries(s);
  const person = entries.find((e) => e.role === "person_1")!;
  assert(person.context.some((l) => l.includes("Respondent")));
  const got = settle(ruleSuggestions(entries));
  assertEquals(
    got.map((g) => g.type === "merge" ? `merge ${g.from}>${g.into}` : `${g.type} ${g.role}`),
    ["merge person_1>father", "remove other_1"],
  );
  s.close();
});

Deno.test("model suggestions are checked: unknown roles, revealing labels and removing names are dropped", () => {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Anna Thornbury", role: "mother" });
  r.add({ kind: "person", full: "Joan Thornbury", role: "person_1" });
  r.add({ kind: "person", full: "Bob Smith", role: "person_2" });
  r.add({ kind: "school", full: "Kiama Downs Public School", role: "school_1" });
  r.add({ kind: "other", full: "5:01 PM", role: "other_1" });
  // A person whose "name" is a time is still a person: never removed on a suggestion.
  r.add({ kind: "person", full: "5:01 PM", role: "person_3" });
  const got = checkSuggestions(
    {
      suggestions: [
        { type: "rename", role: "person_1", to: "maternal_grandmother", why: "Her mother." },
        { type: "rename", role: "person_2", to: "thornbury_friend", why: "leaks" },
        { type: "rename", role: "school_1", to: "mother", why: "taken" },
        { type: "merge", from: "person_9", into: "mother", why: "unknown" },
        { type: "merge", from: "school_1", into: "mother", why: "different kinds" },
        { type: "remove", role: "person_2", why: "not needed" },
        { type: "remove", role: "person_3", why: "a time" },
        { type: "remove", role: "other_1", why: "A time." },
      ],
    },
    r,
    "llm",
  );
  assertEquals(
    got.map((g) =>
      g.type === "rename" ? `rename ${g.role}>${g.to}` : `${g.type} ${"role" in g ? g.role : ""}`
    ),
    ["rename person_1>maternal_grandmother", "remove other_1"],
  );
});

Deno.test("Tidy up asks the local model, and refuses a remote one without sending anything", async () => {
  const { s } = await newCase();
  await publishForm(s);
  const calls: string[] = [];
  const fetchFn: FetchFn = (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/tags")) return Promise.resolve(new Response("", { status: 404 }));
    const sent = JSON.parse(String(init?.body));
    assert(String(sent.messages[1].content).includes("Respondent"));
    return Promise.resolve(Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            suggestions: [
              { type: "merge", from: "person_1", into: "father", why: "Same man." },
              { type: "rename", role: "other_1", to: "handover_time", why: "A time." },
              { type: "remove", role: "other_1", why: "A time of day." },
            ],
          }),
        },
      }],
    }));
  };
  await s.updateSettings({
    llm: { baseUrl: "http://127.0.0.1:1234/v1", model: "m", trustLocalServer: true },
  });
  const r = await suggestTidy(s, { fetch: fetchFn });
  assertEquals(r.llm, { ran: true });
  assertEquals(r.suggestions.map((x) => x.type), ["merge", "remove"]);
  const log = s.store.listLog().find((l) => l.action === "entity_suggestions")!;
  assert(!JSON.stringify(log).includes("Okafor"));

  calls.length = 0;
  await s.updateSettings({ llm: { baseUrl: "https://llm.example.com/v1", model: "m" } });
  const remote = await suggestTidy(s, { fetch: fetchFn });
  assertEquals(remote.llm.ran, false);
  assert(remote.llm.error?.includes("isn't on this computer"));
  assert(calls.every((u) => !u.includes("chat/completions")));
  // The rules still answer.
  assertEquals(remote.suggestions.length, 2);
  s.close();
});

// ── the API ────────────────────────────────────────────────────────────────

Deno.test("API: tidy suggests, merge and remove carry it out, and bad requests are refused", async () => {
  const t = await withCase();
  const s = t.state.session!;
  s.detectors = [formDetector()];
  await publishForm(s);
  const tidy = await t.user.post("/api/people/tidy", {});
  assertEquals(tidy.status, 200, tidy.text);
  assertEquals(tidy.json.llm.ran, false);
  assertEquals(tidy.json.suggestions.length, 2);
  assertEquals((await t.user.post("/api/entities/person_1/merge", {})).status, 400);
  assertEquals((await t.user.post("/api/entities/nobody/merge", { into: "father" })).status, 404);
  const m = await t.user.post("/api/entities/person_1/merge", { into: "father" });
  assertEquals(m.status, 200, m.text);
  assertEquals((await t.user.post("/api/entities/other_1/remove", { reason: "" })).status, 400);
  const r = await t.user.post("/api/entities/other_1/remove", { reason: "A time of day" });
  assertEquals(r.status, 200, r.text);
  assertEquals(roles(s), ["father", "mother"]);
  // Signed out: refused.
  assertEquals((await t.other.post("/api/people/tidy", {})).status, 401);
  s.close();
});
