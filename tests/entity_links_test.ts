/**
 * A detail (address, number) can belong to a person (`relatedTo`, ADR 15 amendment 3), so marking
 * the person safety-sensitive covers "her address" too. The link is vault only: never in public.db.
 * Also GET /api/entities/:role. SYNTHETIC data only (ADR 11); the CANON case.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { SafetyError } from "../src/core/session.ts";
import type { CaseSession } from "../src/core/session.ts";
import { EntityRegistry } from "../src/core/entities.ts";
import { seedCanon } from "./fixtures/canon.ts";
import { withCase } from "./helpers/app.ts";

async function canonApp() {
  const t = await withCase();
  const s = t.state.session!;
  await seedCanon(s);
  return { ...t, s };
}

/** Everything in public.db (every table), as text: what Claude can read. */
function publicDump(s: CaseSession): string {
  const tables = s.store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'lines_fts%'",
  ).all() as { name: string }[];
  return JSON.stringify(tables.map((t) => s.store.db.prepare(`SELECT * FROM "${t.name}"`).all()));
}

Deno.test("GET /api/entities/:role: one who's who row, plus the details linked to a person", async () => {
  const { user, s } = await canonApp();
  try {
    const r = await user.get("/api/entities/mother");
    assertEquals(r.status, 200, r.text);
    assertEquals(r.json.role, "mother");
    assertEquals(r.json.forms.full, "Anna Thornbury");
    assertEquals(r.json.group, "people");
    assertEquals(r.json.linked, []);
    for (const k of ["colour", "safety", "safetyVia", "relatedTo", "docs", "mentions"]) {
      assert(k in r.json, k);
    }
    // The same shape as a /api/people row.
    const row = (await user.get("/api/people")).json.entities.find((
      e: { role: string },
    ) => e.role === "mother");
    const { linked: _l, ...one } = r.json;
    assertEquals(one, row);
    assertEquals((await user.get("/api/entities/nobody_here")).status, 404);
    assertEquals((await user.get("/api/entities/mother", { cookie: "" })).status, 401);
    void s;
  } finally {
    await user.post("/api/lock");
  }
});

Deno.test("an address linked to a safety-sensitive person is safety-sensitive too, in the vault only", async () => {
  const { user, s } = await canonApp();
  try {
    // CANON marks her safety-sensitive; start without it.
    assertEquals((await user.req("PATCH", "/api/entities/mother", { safety: false })).status, 200);
    const entitiesBefore = s.store.listEntities();
    const link = await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: "mother" });
    assertEquals(link.status, 200, link.text);
    let home = (await user.get("/api/entities/mothers_home")).json;
    assertEquals([home.relatedTo, home.safety, home.safetyVia], ["mother", false, null]);
    assertEquals(
      (await user.get("/api/entities/mother")).json.linked,
      [{ role: "mothers_home", kind: "address", group: "numbers", idType: "address" }],
    );
    // Marking her safety-sensitive covers her address.
    await user.req("PATCH", "/api/entities/mother", { safety: true });
    home = (await user.get("/api/entities/mothers_home")).json;
    assertEquals([home.safety, home.safetyVia], [false, "mother"]);
    assertEquals(s.registry.safetyOf("mothers_home"), { safety: true, via: "mother" });
    // Nothing about the link or the flag reached public.db.
    assert(!/relatedTo|related_to|safety/i.test(publicDump(s)), "link or flag in public.db");
    assertEquals(s.store.listEntities(), entitiesBefore);
    // The log row says only which role changed.
    const rows = s.store.listLog(5).filter((l) => l.action === "entity_updated");
    assert(
      rows.every((l) =>
        JSON.stringify(JSON.parse(String(l.detail))).match(/^\{"role":"[a-z_0-9]+"\}$/)
      ),
    );
    // Renaming the person keeps the link; unlinking clears it.
    assertEquals((await user.req("PATCH", "/api/entities/mother", { role: "mum" })).status, 200);
    assertEquals((await user.get("/api/entities/mothers_home")).json.relatedTo, "mum");
    await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: null });
    home = (await user.get("/api/entities/mothers_home")).json;
    assertEquals([home.relatedTo, home.safetyVia], [null, null]);
    // The link survives locking (it is in the vault's registry).
    await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: "mum" });
    const reg = new EntityRegistry(s.registry.toJSON());
    assertEquals(reg.get("mothers_home")!.relatedTo, "mum");
  } finally {
    await user.post("/api/lock");
  }
});

Deno.test("relatedTo must name another person; a person can't belong to someone", async () => {
  const { user, s } = await canonApp();
  try {
    const bad: [string, unknown][] = [
      ["mothers_home", "nobody_here"],
      ["mothers_home", "school"], // not a person
      ["mothers_home", "mothers_home"],
      ["mothers_home", 42],
      ["mothers_home", "Anna"], // a value, not a role
      ["child_1", "mother"], // a person
    ];
    for (const [role, to] of bad) {
      const r = await user.req("PATCH", `/api/entities/${role}`, { relatedTo: to });
      assertEquals(r.status, 400, `${role} → ${to}: ${r.text}`);
      assert(!r.text.includes("Anna Thornbury"));
    }
    assertEquals(s.registry.get("mothers_home")!.relatedTo ?? null, null, "nothing written");
    // A person with details linked can't stop being a person while they are linked.
    await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: "mother" });
    const r = await user.req("PATCH", "/api/entities/mother", { kind: "organisation" });
    assertEquals(r.status, 400, r.text);
    assertEquals(s.registry.get("mother")!.kind, "person");
  } finally {
    await user.post("/api/lock");
  }
});

Deno.test("registry: links follow renames and are cleared when the person is removed", () => {
  const reg = new EntityRegistry();
  reg.add({ kind: "person", full: "Alex Example", role: "mother" });
  reg.add({ kind: "phone", full: "0400 000 000", role: "phone_1" });
  reg.update("phone_1", { relatedTo: "mother" });
  reg.update("mother", { safety: true });
  assertEquals(reg.safetyOf("phone_1"), { safety: true, via: "mother" });
  assertEquals(reg.safetyOf("mother"), { safety: true, via: null });
  reg.rename("mother", "parent_1");
  assertEquals(reg.get("phone_1")!.relatedTo, "parent_1");
  assertEquals(reg.linkProblems(), []);
  reg.remove("parent_1");
  assertEquals(reg.get("phone_1")!.relatedTo, null);
  assertEquals(reg.safetyOf("phone_1"), { safety: false, via: null });
});

// ── the protection follows the link on every server path (security review) ──

const ADDRESS = "14 Banksia Crescent, Gerringong NSW 2534";

Deno.test("a linked address of a safety-sensitive person can't be left as written, and an earlier 'leave as written' is withdrawn", async () => {
  const { user, s } = await canonApp();
  try {
    assertEquals(s.registry.get("mother")!.safety, true, "CANON marks her");
    assertEquals(s.registry.get("mothers_home")!.safety ?? false, false);
    // Shared with the address left as written while it was nobody's in particular.
    const d = await s.importText({
      title: "Note",
      text: `Moved to ${ADDRESS} in May.`,
      origin: "mine",
    });
    await s.publish(d.id, {
      newEntities: [],
      replacements: [],
      ignore: [ADDRESS, "Banksia Crescent", "Gerringong"],
      ignoreReasons: {
        [ADDRESS]: "an old address",
        "Banksia Crescent": "an old address",
        Gerringong: "an old address",
      },
    });
    assert(s.store.getDocument(d.id).body!.includes("Banksia"));
    // Linking it to her makes it safety-sensitive: the shared copy is withdrawn at once.
    const r = await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: "mother" });
    assertEquals(r.status, 200, r.text);
    assertEquals(s.store.getDocument(d.id).body, null, "withdrawn: a safety value was visible");
    assertEquals(s.honouredIgnore([ADDRESS]), [], "the old 'leave as written' no longer counts");
    // Asking again to leave it as written is refused outright.
    await s.reopen(d.id);
    await assertRejects(
      () =>
        s.publish(d.id, {
          newEntities: [],
          replacements: [],
          ignore: [ADDRESS],
          ignoreReasons: { [ADDRESS]: "still old" },
        }),
      SafetyError,
    );
    // The review screen and the paste warning see it as safety-sensitive too.
    const review = await user.get(`/api/docs/${d.id}/review`);
    assert(
      review.json.safetyRoles.includes("mothers_home"),
      JSON.stringify(review.json.safetyRoles),
    );
    const paste = await user.post("/api/paste/view", { text: "She lives at {{mothers_home}}." });
    assertEquals(paste.json.safety.map((x: { role: string }) => x.role), ["mothers_home"]);
    // Unmarking her, or unlinking it, lifts it again.
    await user.req("PATCH", "/api/entities/mothers_home", { relatedTo: null });
    assertEquals(s.registry.safetyRoles().includes("mothers_home"), false);
  } finally {
    await user.post("/api/lock");
  }
});

Deno.test("registry copies carry links deeply, and a dangling or bad link is dropped on load", () => {
  const reg = new EntityRegistry();
  reg.add({ kind: "person", full: "Alex Example", role: "mother" });
  reg.add({ kind: "address", full: "1 Example Street, Exampleton", role: "home_1" });
  reg.update("home_1", { relatedTo: "mother" });
  reg.update("mother", { safety: true });
  const copy = new EntityRegistry(reg.toJSON());
  copy.update("home_1", { relatedTo: null });
  copy.update("mother", { safety: false });
  assertEquals(reg.get("home_1")!.relatedTo, "mother", "the original is untouched");
  assertEquals(reg.safetyRoles().sort(), ["home_1", "mother"]);
  const loaded = new EntityRegistry([
    {
      role: "mother",
      kind: "person",
      forms: { full: "Alex Example" },
      aliases: [],
      relatedTo: "father",
    },
    {
      role: "home_1",
      kind: "address",
      forms: { full: "1 Example Street" },
      aliases: [],
      relatedTo: "gone",
    },
    {
      role: "home_2",
      kind: "address",
      forms: { full: "2 Example Street" },
      aliases: [],
      relatedTo: "home_2",
    },
    {
      role: "phone_1",
      kind: "phone",
      forms: { full: "0400 000 000" },
      aliases: [],
      relatedTo: "home_1",
    },
  ]);
  for (const r of ["mother", "home_1", "home_2", "phone_1"]) {
    assertEquals(loaded.get(r)!.relatedTo, null, r);
  }
  assertEquals(loaded.linkProblems(), []);
  // A person added later under the dangling name doesn't inherit the old link.
  loaded.add({ kind: "person", full: "Sam Example", role: "gone" });
  assertEquals(loaded.linkedTo("gone"), []);
});
