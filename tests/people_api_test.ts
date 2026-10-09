/**
 * People and search (W1-E, ADR 15): who's who groups and counts, colour slots, the relationship
 * description Claude sees, where an entity appears, nickname impact, and search with true totals.
 * SYNTHETIC data only (ADR 11); the CANON case (docs/rebuild/CANON.md).
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import type { CaseSession } from "../src/core/session.ts";
import { changeEntity, withEntityLock } from "../src/core/people.ts";
import { InvalidInputError } from "../src/core/publicdb.ts";
import { CANON_PALETTE, D001_LINES, D002_LINES, seedCanon } from "./fixtures/canon.ts";
import { type Client, NEW_NAME, withCase } from "./helpers/app.ts";
import { searchGroups } from "../src/app/ui/model.js";

/** Invented extra people and places, so who's who has CANON's totals (18 / 14 / 9). */
const EXTRA_PEOPLE = [
  "Harriet Quill",
  "Oswin Talbot",
  "Petra Vance",
  "Rufus Hale",
  "Selina Marsh",
  "Tobias Wren",
  "Ursula Penn",
  "Victor Lyle",
  "Wilma Crane",
  "Xavier Moss",
  "Yolanda Brook",
  "Zeke Thorne",
];
const EXTRA_PLACES: [string, "place" | "organisation" | "school"][] = [
  ["Albion Park", "place"],
  ["Shellharbour", "place"],
  ["Jamberoo", "place"],
  ["Minnamurra", "place"],
  ["Bombo Dental", "organisation"],
  ["Werri Swim Club", "organisation"],
  ["Gerroa Pharmacy", "organisation"],
  ["Foxground Motors", "organisation"],
  ["Kiama High School", "school"],
  ["Berry Montessori", "school"],
];

async function canonApp(opts: { omitAliases?: string[]; extras?: boolean } = {}) {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanon(s, { omitAliases: opts.omitAliases });
  if (opts.extras) {
    for (const full of EXTRA_PEOPLE) s.registry.add({ kind: "person", full });
    for (const [full, kind] of EXTRA_PLACES) s.registry.add({ kind, full });
    await s.saveRegistry();
  }
  return { ...t, s };
}

/** Everything in public.db (every table), as text: what Claude can read. */
function publicDump(s: CaseSession): string {
  const tables = s.store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'lines_fts%'",
  ).all() as { name: string }[];
  return JSON.stringify(
    tables.map((t) => s.store.db.prepare(`SELECT * FROM "${t.name}"`).all()),
  );
}

function logCount(s: CaseSession): number {
  return (s.store.db.prepare("SELECT COUNT(*) AS n FROM ai_log").get() as { n: number }).n;
}

async function people(user: Client, query = "") {
  const r = await user.get(`/api/people${query}`);
  assertEquals(r.status, 200, r.text);
  return r.json;
}

// ── who's who ────────────────────────────────────────────────────────────

Deno.test("who's who: CANON group totals, palette slots and identifier types", async () => {
  const { user } = await canonApp({ extras: true });
  const all = await people(user);
  assertEquals(all.groups, { people: 18, places: 14, numbers: 9 });
  assertEquals(all.total, 41);
  assertEquals(all.entities.length, 41);
  assertEquals(
    all.palette.map((p: { hex: string }) => p.hex),
    CANON_PALETTE,
  );
  assertEquals(
    all.palette.map((p: { owner: string | null }) => p.owner),
    ["mother", "father", "child_1", "child_2", null, null],
  );
  // The spare slots are #99DDFF and #EEDD88, and free.
  assertEquals(
    all.palette.filter((p: { owner: string | null }) => p.owner === null)
      .map((p: { hex: string }) => p.hex),
    ["#99DDFF", "#EEDD88"],
  );
  // deno-lint-ignore no-explicit-any
  const by = (role: string) => all.entities.find((e: any) => e.role === role);
  assertEquals(by("mother").safety, true);
  assertEquals(by("mother").colour, 0);
  assertEquals(by("mother").aliases, ["Annie", "Ana"]);
  assertEquals(by("mother").forms.title, "Ms Thornbury");
  assertEquals(by("mother").group, "people");
  assertEquals(by("mother").idType, null);
  assertEquals(by("school").group, "places");
  assertEquals(by("school").colour, null);
  assertEquals(by("mothers_home").group, "numbers");
  assertEquals(by("mothers_home").idType, "address");
  assertEquals(by("medicare_1").idType, "medicare");
  assertEquals(by("tfn_1").idType, "tfn");
  assertEquals(by("abn_1").idType, "abn");
  assertEquals(by("file_number").idType, "file_number");
  assertEquals(by("dob_2").idType, "dob");
  assertEquals(by("phone_1").idType, "phone");
  assertEquals(by("email_1").idType, "email");
  // Counts come from the vault's replacements: Anna in D001 lines 1, 3, 4, 5, 7 and D002.
  assertEquals(by("child_2").docs, 2);
  const lachlanD001 = D001_LINES.filter((l) => l.includes("Lachlan")).length;
  const lachlanD002 = D002_LINES.join("\n").split("Lachlan").length - 1;
  assertEquals(by("child_2").mentions, lachlanD001 + lachlanD002);
  assertEquals(by("person_1").docs, 0);

  // Tabs, search and paging, with true totals.
  const tab = await people(user, "?group=numbers&offset=2&limit=3");
  assertEquals(tab.total, 9);
  assertEquals(tab.entities.length, 3);
  assertEquals(tab.offset, 2);
  const q = await people(user, "?q=thornbury");
  // The email address has "thornbury" in it too.
  assertEquals(q.entities.map((e: { role: string }) => e.role).sort(), [
    "email_1",
    "maternal_grandmother",
    "mother",
  ]);
  assertEquals(q.groups, { people: 2, places: 0, numbers: 1 });
  assertEquals((await people(user, "?q=ana")).entities[0].role, "mother");
  assertEquals((await user.get("/api/people?group=nope")).status, 400);
  assertEquals((await user.get("/api/people?limit=-1")).status, 400);
});

Deno.test("who's who, usage and impact need the session cookie", async () => {
  const { other } = await canonApp();
  for (
    const path of [
      "/api/people",
      "/api/entities/mother/usage",
      "/api/entities/mother/alias-impact?alias=Annie",
      "/api/search/all?q=Mia",
    ]
  ) {
    const r = await other.get(path);
    assertEquals(r.status, 401, path);
    assert(!r.text.includes("Anna"), path);
  }
});

Deno.test("link suggestions: an unlinked detail labelled as someone's is suggested, never linked for the user", async () => {
  const { user, s } = await canonApp();
  s.registry.update("mothers_home", { relatedTo: null });
  await s.saveRegistry();
  const r = await user.get("/api/people/link-suggestions");
  assertEquals(r.status, 200, r.text);
  assert(
    r.json.suggestions.some((x: { role: string; person: string; safety: boolean }) =>
      x.role === "mothers_home" && x.person === "mother" && x.safety === true
    ),
    r.text,
  );
  assert(!r.text.includes("Banksia"), "labels only, never the value");
  assertEquals(s.registry.get("mothers_home")?.relatedTo ?? null, null, "not linked by itself");
  const p = (await user.get("/api/people")).json;
  assert(p.linkSuggestions.some((x: { role: string }) => x.role === "mothers_home"));
  // The user confirms it in People.
  assertEquals(
    (await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: "mother" })).status,
    200,
  );
  const after = (await user.get("/api/people/link-suggestions")).json.suggestions;
  assert(!after.some((x: { role: string }) => x.role === "mothers_home"));
});

// ── colour slots ─────────────────────────────────────────────────────────

Deno.test("colour: a taken slot is refused, a spare one given, and none of it reaches public.db", async () => {
  const { user, s } = await canonApp();
  const taken = await user.req("PATCH", "/api/entities/maternal_grandmother", { colour: 0 });
  assertEquals(taken.status, 409, taken.text);
  assertEquals(taken.json.owner, "mother");
  assertEquals(s.registry.get("maternal_grandmother")?.colour, undefined);

  const give = await user.req("PATCH", "/api/entities/maternal_grandmother", { colour: 4 });
  assertEquals(give.status, 200, give.text);
  let p = await people(user);
  assertEquals(p.palette[4].owner, "maternal_grandmother");

  // Neutral ink frees the slot for someone else.
  assertEquals((await user.req("PATCH", "/api/entities/mother", { colour: null })).status, 200);
  assertEquals(
    (await user.req("PATCH", "/api/entities/class_teacher", { colour: 0 })).status,
    200,
  );
  p = await people(user);
  assertEquals(p.palette[0].owner, "class_teacher");
  // deno-lint-ignore no-explicit-any
  assertEquals(p.entities.find((e: any) => e.role === "mother").colour, null);

  for (const bad of [6, -1, 1.5, "1", true]) {
    const r = await user.req("PATCH", "/api/entities/father", { colour: bad });
    assertEquals(r.status, 400, `colour ${JSON.stringify(bad)}`);
  }
  assertEquals((await user.req("PATCH", "/api/entities/mother", { safety: "yes" })).status, 400);
  assertEquals((await user.req("PATCH", "/api/entities/nobody", { colour: 5 })).status, 404);

  // Kept in the vault (survives a reload), never in public.db.
  assertEquals(s.registry.get("class_teacher")?.colour, 0);
  const dump = publicDump(s);
  for (const hex of CANON_PALETTE) assert(!dump.includes(hex.slice(1)), hex);
  assert(!/"(colou?r|safety)"/i.test(dump), "no colour or safety field in public.db");
  assertEquals(Object.keys(s.store.listEntities()[0]).sort(), ["description", "kind", "role"]);
});

// ── relationship description (shown to Claude) ───────────────────────────

Deno.test("description: any real name, nickname, part or number is refused, and nothing is written", async () => {
  const { user, s } = await canonApp();
  const before = publicDump(s);
  const refused = [
    "Anna's mother", // first name
    "anna’s mother", // folded: case and apostrophe
    "Annie's mum", // alias
    "Ana's mum", // alias
    "Ms Thornbury's mother", // title form
    "Thornbury side of the family", // surname
    "lives at 14 Banksia Crescent", // part of an address
    "Lives in Gerringong", // suburb of an address
    "call on 0412 345 678", // known identifier
    "call on 0499 111 222", // identifier-like, not known
    `friend of ${NEW_NAME}`, // a name the detectors find, not yet in who's who
    "the aunt {{aunt}}", // unknown token
    "the aunt {{bad token}}", // malformed
  ];
  for (const text of refused) {
    const r = await user.req("PATCH", "/api/entities/maternal_grandmother", {
      description: text,
    });
    assertEquals(r.status, 400, `${text}: ${r.text}`);
    assertEquals(s.registry.get("maternal_grandmother")?.description, undefined, text);
  }
  // public.db is byte for byte what it was (no description, no log row).
  assertEquals(publicDump(s), before);
});

Deno.test("description: a plain relationship is published; known tokens are shown with names", async () => {
  const { user, s } = await canonApp();
  let r = await user.req("PATCH", "/api/entities/maternal_grandmother", {
    description: "  The children's   maternal grandmother ",
  });
  assertEquals(r.status, 200, r.text);
  const row = s.store.listEntities().find((e) => e.role === "maternal_grandmother");
  assertEquals(row?.description, "The children's maternal grandmother");

  r = await user.req("PATCH", "/api/entities/class_teacher", {
    description: "{{child_1.first}}'s class teacher at {{school}}",
  });
  assertEquals(r.status, 200, r.text);
  assertEquals(
    s.store.listEntities().find((e) => e.role === "class_teacher")?.description,
    "{{child_1.first}}'s class teacher at {{school}}",
  );
  const p = await people(user);
  // deno-lint-ignore no-explicit-any
  const teacher = p.entities.find((e: any) => e.role === "class_teacher");
  assertEquals(teacher.description.text, "Mia's class teacher at Kiama Downs Public School");
  assertEquals(teacher.description.segs[0].role, "child_1");
  assertEquals(teacher.description.segs[0].colour, 2);

  // Renaming the role a description names rewrites it, in the vault and public.db.
  r = await user.req("PATCH", "/api/entities/school", { role: "primary_school" });
  assertEquals(r.status, 200, r.text);
  assertEquals(
    s.store.listEntities().find((e) => e.role === "class_teacher")?.description,
    "{{child_1.first}}'s class teacher at {{primary_school}}",
  );
  assertEquals(
    s.registry.get("class_teacher")?.description,
    "{{child_1.first}}'s class teacher at {{primary_school}}",
  );

  // Clearing it.
  r = await user.req("PATCH", "/api/entities/class_teacher", { description: null });
  assertEquals(r.status, 200, r.text);
  assertEquals(s.store.listEntities().find((e) => e.role === "class_teacher")?.description, null);
  assertEquals((await user.req("PATCH", "/api/entities/mother", { description: 5 })).status, 400);
  // The log names the role and the fields changed, never a value.
  const logged = s.store.listLog(5).find((l) => l.action === "entity_updated");
  assertEquals(JSON.parse(logged!.detail), { role: "class_teacher" });
});

Deno.test("safety flag is kept in the vault and shown in who's who", async () => {
  const { user, s } = await canonApp();
  assertEquals(
    (await user.req("PATCH", "/api/entities/father", { safety: true })).status,
    200,
  );
  assertEquals(s.registry.get("father")?.safety, true);
  // deno-lint-ignore no-explicit-any
  assertEquals((await people(user)).entities.find((e: any) => e.role === "father").safety, true);
  assertEquals(
    (await user.req("PATCH", "/api/entities/father", { safety: false })).status,
    200,
  );
  assertEquals(s.registry.get("father")?.safety, false);
});

// ── where someone appears ────────────────────────────────────────────────

Deno.test("usage lists documents with lines and state, chronology, issues and paragraphs", async () => {
  const { user, s } = await canonApp();
  const c = s.store.addChronology({
    event_date: "2025-03-29",
    description: "{{child_2.first}} had a temperature",
    sources: [{ doc_id: "D001", line_start: 7, line_end: 7 }],
  }, "claude");
  s.store.addChronology({
    event_date: "2025-03-22",
    description: "Swimming moved to Saturday",
    sources: [{ doc_id: "D001", line_start: 5, line_end: 5 }],
  }, "claude");
  const i = s.store.addIssue({ title: "Medical care", description: "{{child_2}}'s fever" }, "user");
  const d = s.store.createDraft({ kind: "affidavit", title: "Affidavit of {{mother}}" }, "user");
  const para = s.store.addParagraph(d, "{{child_2.first}} stayed home.", "user");
  // A pending document naming him.
  const pending = await s.importText({
    title: "Email from childcare centre",
    text: "Lachlan Okafor was absent today.",
    origin: "mine",
  });

  const r = await user.get("/api/entities/child_2/usage");
  assertEquals(r.status, 200, r.text);
  const u = r.json;
  assertEquals(u.documents.map((x: { id: string }) => x.id), ["D001", "D002", pending.id]);
  assertEquals(u.documents[0].lines, [7]);
  assertEquals(u.documents[0].state, "shared");
  assertEquals(u.documents[0].title, "Text messages, March 2025");
  assertEquals(u.documents[1].lines, [6, 8, 9]);
  assertEquals(u.documents[2].state, "needs_review");
  assertEquals(u.chronology.map((x: { id: number }) => x.id), [c]);
  assertEquals(u.chronology[0].description.text, "Lachlan had a temperature");
  assertEquals(u.issues.map((x: { id: number }) => x.id), [i]);
  assertEquals(u.issues[0].title.text, "Medical care");
  assertEquals(u.paragraphs, [{
    id: para,
    draft_id: d,
    draftTitle: "Affidavit of Anna Thornbury",
    n: 1,
  }]);
  assertEquals(u.totals, {
    documents: 3,
    mentions: u.documents.reduce((n: number, x: { mentions: number }) => n + x.mentions, 0),
    chronology: 1,
    issues: 1,
    paragraphs: 1,
  });
  assertEquals((await user.get("/api/entities/nobody/usage")).status, 404);
});

// ── nickname impact ──────────────────────────────────────────────────────

Deno.test("alias impact: documents containing a nickname, split shared / pending / withheld", async () => {
  const { user, s } = await canonApp({ omitAliases: ["Annie"] });
  // D003: shared, "Annie" as written (it was not known when shared).
  const d3 = await s.importText({
    title: "Handover note",
    text: "Pick-up at 3pm.\nAnnie said she would bring the bags.",
    origin: "mine",
  });
  await s.publishWithDefaults(d3.id);
  // D004: withheld (from the other side).
  const d4 = await s.importText({
    title: "Letter from the other side's lawyer",
    text: "Our client says annie was late.",
    origin: "other_side",
  });
  await s.publishWithDefaults(d4.id);
  // D005: still to review.
  const d5 = await s.importText({
    title: "School reports",
    text: "ANNIE signed it.",
    origin: "mine",
  });
  // D006: "Annie" only inside a longer word: no match.
  await s.importText({ title: "Notes", text: "Shannie is calmer.", origin: "mine" });
  const logs = logCount(s);
  const dump = publicDump(s);

  const r = await user.get("/api/entities/mother/alias-impact?alias=%20Annie%20");
  assertEquals(r.status, 200, r.text);
  const imp = r.json;
  assertEquals(imp.alias, "Annie");
  assertEquals(imp.known, false);
  assertEquals(imp.clash, []);
  assertEquals(imp.shared, [{
    id: d3.id,
    title: "Handover note",
    state: "shared",
    count: 1,
    lines: [2],
    visible: 1,
  }]);
  assertEquals(imp.withheld.map((h: { id: string }) => h.id), [d4.id]);
  assertEquals(imp.withheld[0].visible, 0);
  assertEquals(imp.pending.map((h: { id: string }) => h.id), [d5.id]);
  assertEquals(imp.wouldExpose, [d3.id]);
  assertEquals(imp.total, 3);

  // An existing nickname (for removal): Ana is known and appears nowhere.
  const ana = (await user.get("/api/entities/mother/alias-impact?alias=Ana")).json;
  assertEquals(ana.known, true);
  assertEquals(ana.total, 0);
  // A nickname that is someone else's name.
  assertEquals(
    (await user.get("/api/entities/mother/alias-impact?alias=Mia")).json.clash,
    ["child_1"],
  );
  assertEquals((await user.get("/api/entities/mother/alias-impact?alias=B")).status, 400);
  assertEquals((await user.get("/api/entities/nobody/alias-impact?alias=Annie")).status, 404);

  // Reading impact or usage writes nothing Claude can see: no log row, no change to public.db.
  await user.get("/api/entities/mother/usage");
  assertEquals(logCount(s), logs);
  assertEquals(publicDump(s), dump);
});

// ── search ───────────────────────────────────────────────────────────────

Deno.test("search/all: real names across documents, people, chronology and issues with true totals", async () => {
  const { user, s } = await canonApp();
  s.store.addChronology({
    event_date: "2025-03-14",
    description: "{{father.first}} collected {{child_1.first}} late",
    sources: [{ doc_id: "D002", line_start: 9, line_end: 9 }],
  }, "claude");
  s.store.addIssue({ title: "{{child_1.first}}'s schooling" }, "user");
  s.store.addIssue({ title: "Communication between parents" }, "user");
  const withheld = await s.importText({
    title: "Daniel's affidavit, May 2025",
    text: "Mia Okafor is doing well.",
    origin: "other_side",
  });
  await s.publishWithDefaults(withheld.id);

  const mia = (s: string) => s.toLowerCase().includes("mia");
  const expected = D001_LINES.filter(mia).length + D002_LINES.filter(mia).length + 1;

  const r = await user.get("/api/search/all?q=MIA&limit=2");
  assertEquals(r.status, 200, r.text);
  const res = r.json;
  assertEquals(res.totals.lines, expected);
  assertEquals(res.lines.length, 2);
  assertEquals(res.totals.people, 1);
  assertEquals(res.people[0].role, "child_1");
  assertEquals(res.people[0].colour, 2);
  assertEquals(res.totals.chronology, 1);
  assertEquals(res.chronology[0].description.text, "Daniel collected Mia late");
  assertEquals(res.totals.issues, 1);
  assertEquals(res.issues[0].title.text, "Mia's schooling");
  assertEquals(res.total, expected + 1 + 1 + 1);
  const first = res.lines[0];
  assertEquals(first.doc_id, "D001");
  assertEquals(first.line, 1);
  assertEquals(first.text.text, D001_LINES[0]);
  assertExists(first.text.segs.find((x: { role?: string }) => x.role === "child_1"));
  assertEquals(first.docTitle, "Text messages, March 2025");
  assertEquals(first.docState, "shared");

  // Paging through the rest gives exactly the total, the withheld document included.
  const rest = (await user.get(`/api/search/all?q=mia&offset=2&limit=200`)).json;
  assertEquals(rest.lines.length, expected - 2);
  const last = rest.lines.at(-1);
  assertEquals([last.doc_id, last.docState], [withheld.id, "withheld"]);

  // Every word must match.
  const two = (await user.get("/api/search/all?q=Daniel%20traffic")).json;
  assertEquals(two.totals.lines, 1);
  assertEquals(two.lines[0].text.text, D001_LINES[1]);
  // Empty query.
  assertEquals((await user.get("/api/search/all?q=%20")).json.total, 0);
  assertEquals((await user.get("/api/search/all?q=x&limit=nope")).status, 400);
});

Deno.test("search/all: the palette's searchGroups reads the route's real output (QA G1)", async () => {
  const { user, s } = await canonApp();
  s.store.addIssue({ title: "{{child_1.first}}'s schooling" }, "user");
  const res = (await user.get("/api/search/all?q=Mia")).json;
  assert(res.total > 0);
  const groups = searchGroups(res);
  assertEquals(
    groups.reduce((n: number, g: { total: number }) => n + g.total, 0),
    res.total,
  );
  const kinds = groups.map((g: { kind: string }) => g.kind);
  assert(
    kinds.includes("lines") && kinds.includes("people") && kinds.includes("issues"),
    kinds.join(),
  );
  // deno-lint-ignore no-explicit-any
  const person = groups.find((g: any) => g.kind === "people").items[0];
  assertEquals(person.href, "#/people/child_1");
});

Deno.test("search/all counts from the vault, so rows Claude adds to public.db do not change totals", async () => {
  const { user, s } = await canonApp();
  const before = (await user.get("/api/search/all?q=Mia")).json.totals.lines;
  // Claude writes a fake line into public.db's index (it can open the file).
  s.store.db.prepare("INSERT INTO lines(doc_id, line_no, text) VALUES ('D001', 99, ?)")
    .run("{{child_1.first}} forged line");
  assertEquals((await user.get("/api/search/all?q=Mia")).json.totals.lines, before);
  assertEquals((await user.get("/api/search/all?q=forged")).json.totals.lines, 0);
});

Deno.test("search/all finds lines in documents still to review, from their originals", async () => {
  const { user, s } = await canonApp();
  const d = await s.importText({
    title: "School reports term 2",
    text: "Term 2 report\nMia reads well above her level.",
    origin: "mine",
  });
  const res = (await user.get("/api/search/all?q=above%20her")).json;
  assertEquals(res.totals.lines, 1);
  assertEquals(res.lines[0].doc_id, d.id);
  assertEquals(res.lines[0].line, 2);
  assertEquals(res.lines[0].docState, "needs_review");
  assertEquals(res.lines[0].text.text, "Mia reads well above her level.");
  assertEquals(res.lines[0].text.segs, [{ t: "Mia reads well above her level." }]);
});

// ── one change, checked as a whole (security review after merge) ─────────

Deno.test("PATCH checks the description against who's who as it will be after the same request", async () => {
  const { user, s } = await canonApp();
  const dump = publicDump(s);
  const reg = JSON.stringify(s.registry.toJSON());
  const refused: [string, Record<string, unknown>][] = [
    // A nickname added in the same request.
    ["father", { aliases: ["Danno"], description: "Danno to his friends" }],
    ["mother", { aliases: ["Annie", "Ana", "Nina"], description: "Nina's mum" }],
    // A new first name, surname, full name or title in the same request.
    ["maternal_grandmother", { first: "Peggy", description: "Peggy to the children" }],
    ["maternal_grandmother", { full: "Margaret Ellery Thornbury", description: "née Ellery" }],
    ["class_teacher", { title: "Mrs Quayle", description: "Mrs Quayle at school" }],
    // A value being removed is still a value.
    ["mother", { aliases: [], description: "Ana's side" }],
  ];
  for (const [role, body] of refused) {
    const r = await user.req("PATCH", `/api/entities/${role}`, body);
    assertEquals(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assertEquals(JSON.stringify(s.registry.toJSON()), reg, `vault unchanged: ${role}`);
    assertEquals(publicDump(s), dump, `public.db unchanged: ${role}`);
  }
});

Deno.test("PATCH checks a new role name against values added in the same request, and every field Claude sees", async () => {
  const { user, s } = await canonApp();
  s.registry.add({ kind: "person", full: "Joanne Pemberton", role: "aunty_jo" });
  await s.saveRegistry();
  const dump = publicDump(s);
  const reg = JSON.stringify(s.registry.toJSON());
  const refused: [string, Record<string, unknown>][] = [
    // The new role names a nickname added in the same request.
    ["maternal_grandmother", { role: "nana_peg", aliases: ["Peg"] }],
    ["maternal_grandmother", { role: "gran_maggie", first: "Maggie" }],
    // A new value would make another, existing role name give it away.
    ["class_teacher", { aliases: ["Jo"] }],
    // Role names can't carry a number.
    ["phone_1", { role: "phone_0499111222" }],
    ["file_number", { role: "file_1234" }],
    ["phone_1", { role: "Phone One" }],
    ["phone_1", { role: "mother" }],
    // Kind is published: only the known kinds.
    ["school", { kind: "Anna" }],
    ["school", { kind: 7 }],
    ["school", { full: 7 }],
    ["mother", { aliases: "Annie" }],
  ];
  for (const [role, body] of refused) {
    const r = await user.req("PATCH", `/api/entities/${role}`, body);
    assertEquals(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assertEquals(
      JSON.stringify(s.registry.toJSON()),
      reg,
      `vault unchanged: ${JSON.stringify(body)}`,
    );
    assertEquals(publicDump(s), dump, `public.db unchanged: ${JSON.stringify(body)}`);
  }
  // Allowed: a plain rename with a short number, and a nickname with a description in one go.
  let r = await user.req("PATCH", "/api/entities/place_1", { role: "swimming_pool_2" });
  assertEquals(r.status, 200, r.text);
  r = await user.req("PATCH", "/api/entities/maternal_grandmother", {
    aliases: ["Peg"],
    description: "the children's maternal grandmother",
  });
  assertEquals(r.status, 200, r.text);
  assertEquals(s.registry.get("maternal_grandmother")?.aliases, ["Peg"]);
});

Deno.test("a description that a new nickname turns into a name is withdrawn in the same save", async () => {
  const { user, s } = await canonApp({ omitAliases: ["Annie"] });
  let r = await user.req("PATCH", "/api/entities/maternal_grandmother", {
    description: "Nina's mother",
  });
  assertEquals(r.status, 200, r.text); // "Nina" is not known yet
  r = await user.req("PATCH", "/api/entities/mother", { aliases: ["Ana", "Nina"] });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.descriptionsCleared, ["maternal_grandmother"]);
  assertEquals(s.registry.get("maternal_grandmother")?.description, null);
  assertEquals(
    s.store.listEntities().find((e) => e.role === "maternal_grandmother")?.description,
    null,
  );
  assert(!publicDump(s).includes("Nina"));
});

// ── a name word that is not a form (security review after merge) ─────────

Deno.test("a word of the full name that is not a form is caught when a document is shared", async () => {
  const { user, s } = await canonApp();
  // The full name changes; the surname form stays "Thornbury".
  let r = await user.req("PATCH", "/api/entities/maternal_grandmother", {
    full: "Margaret Ellery",
  });
  assertEquals(r.status, 200, r.text);
  assertEquals(s.registry.get("maternal_grandmother")?.forms.surname, "Thornbury");
  const doc = await s.importText({
    title: "Phone note",
    text: "Ellery called the school on Monday.",
    origin: "mine",
  });
  let published = true;
  try {
    await s.publishWithDefaults(doc.id);
  } catch {
    published = false; // refused: also fine
  }
  if (published) {
    const body = s.store.getDocument(doc.id).body ?? "";
    assert(!body.includes("Ellery"), body);
  }
  assert(!publicDump(s).includes("Ellery"), "Ellery never reaches public.db");

  // And in a description.
  r = await user.req("PATCH", "/api/entities/class_teacher", {
    description: "related to the Ellery family",
  });
  assertEquals(r.status, 400, r.text);
  // Including a full name set in the same request.
  r = await user.req("PATCH", "/api/entities/class_teacher", {
    full: "Priya Raman Quayle",
    description: "née Quayle",
  });
  assertEquals(r.status, 400, r.text);
  assert(!publicDump(s).includes("Quayle"));
});

// ── concurrent changes (security review after merge) ─────────────────────

Deno.test("two PATCHes at once: a nickname and a description using it never publish the name", async () => {
  for (const order of ["description first", "alias first"]) {
    const { user, s } = await canonApp({ omitAliases: ["Annie"] });
    const desc = () =>
      user.req("PATCH", "/api/entities/maternal_grandmother", { description: "Nina's mother" });
    const alias = () => user.req("PATCH", "/api/entities/mother", { aliases: ["Ana", "Nina"] });
    const [a, b] = order === "description first"
      ? await Promise.all([desc(), alias()])
      : await Promise.all([alias(), desc()]);
    assert([a.status, b.status].every((x) => x === 200 || x === 400), `${a.text} ${b.text}`);
    assertEquals(s.registry.get("mother")?.aliases, ["Ana", "Nina"], order);
    assert(!publicDump(s).includes("Nina"), `${order}: "Nina" reached public.db`);
    assert(
      !(s.registry.get("maternal_grandmother")?.description ?? "").includes("Nina"),
      `${order}: vault description names Nina`,
    );
  }
});

Deno.test("a name added while a description is being checked is caught before the write", async () => {
  const { s } = await canonApp();
  const before = publicDump(s);
  // Another request (an import's review, a publish) adds "Quentin Blake" while the detectors run.
  const orig = s.tokeniseUserText.bind(s);
  s.tokeniseUserText = async (text, opts) => {
    const out = await orig(text, opts);
    s.registry.add({ kind: "person", full: "Quentin Blake" });
    return out;
  };
  let refused = false;
  try {
    await changeEntity(s, "maternal_grandmother", { description: "Quentin's friend" });
  } catch (e) {
    refused = e instanceof InvalidInputError;
  }
  assert(refused, "refused");
  assertEquals(s.registry.get("maternal_grandmother")?.description, undefined);
  assertEquals(publicDump(s), before);
});

Deno.test("entity changes run one at a time", async () => {
  const { s } = await canonApp();
  const order: string[] = [];
  const slow = withEntityLock(s, async () => {
    order.push("a start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a end");
  });
  const fast = withEntityLock(s, () => {
    order.push("b");
    return Promise.resolve();
  });
  const failing = withEntityLock(s, () => Promise.reject(new Error("x")));
  const after = withEntityLock(s, () => {
    order.push("c");
    return Promise.resolve();
  });
  await Promise.all([slow, fast, failing.catch(() => {}), after]);
  assertEquals(order, ["a start", "a end", "b", "c"]);
});
