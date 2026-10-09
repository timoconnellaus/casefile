import { assertEquals, assertThrows } from "@std/assert";
import {
  ColourTakenError,
  EntityRegistry,
  PALETTE,
  personNameWords,
  roleTokenRe,
} from "../src/core/entities.ts";
import { findLeaks, tokeniseKnown } from "../src/core/tokenise.ts";

function family() {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Daniel Okafor", role: "father" });
  r.add({ kind: "person", full: "Mia Okafor", role: "child_1" });
  r.add({ kind: "school", full: "Kiama Downs Public School" });
  return r;
}

Deno.test("person names are split into first and surname forms", () => {
  const r = family();
  assertEquals(r.get("father")!.forms, {
    full: "Daniel Okafor",
    first: "Daniel",
    surname: "Okafor",
  });
});

Deno.test("roles are allocated from hints, de-duplicated, or numbered by kind", () => {
  const r = family();
  assertEquals(r.get("school_1")?.kind, "school");
  assertEquals(r.allocateRole("person", "Father"), "father_2");
  assertEquals(r.allocateRole("person", "the mother!"), "the_mother");
  assertEquals(r.allocateRole("phone"), "phone_1");
  assertEquals(r.allocateRole("person", "123"), "person_1");
});

Deno.test("a surname shared by two people is ambiguous", () => {
  const r = family();
  assertEquals(r.match("Okafor"), undefined);
  assertEquals(r.candidates("Okafor").map((c) => c.entity.role).sort(), ["child_1", "father"]);
  assertEquals(r.candidates("Mr Okafor").length, 2);
  assertEquals(r.match("daniel")?.entity.role, "father");
  assertEquals(r.match("Daniel")?.form, "first");
});

Deno.test("a learned title form makes the title unambiguous", () => {
  const r = family();
  r.learnTitle("father", "Mr Okafor");
  assertEquals(r.match("Mr Okafor")?.entity.role, "father");
  assertEquals(r.resolve("father", "title"), "Mr Okafor");
});

Deno.test("resolve falls back to the full form", () => {
  const r = family();
  assertEquals(r.resolve("school_1", "first"), "Kiama Downs Public School");
  assertEquals(r.resolve("nobody", "full"), undefined);
});

Deno.test("rename keeps the entity and rejects clashes or bad names", () => {
  const r = family();
  r.rename("school_1", "school");
  assertEquals(r.get("school")?.forms.full, "Kiama Downs Public School");
  assertEquals(r.get("school_1"), undefined);
  assertThrows(() => r.rename("school", "father"));
  assertThrows(() => r.rename("school", "School"));
  assertThrows(() => r.rename("nobody", "x"));
});

Deno.test("variants are longest first and include aliases", () => {
  const r = family();
  r.update("father", { aliases: ["Dan"] });
  const texts = r.variants().map((v) => v.text);
  assertEquals(texts[0], "Kiama Downs Public School");
  assertEquals(texts.includes("Dan"), true);
  assertEquals(r.match("dan")?.entity.role, "father");
});

Deno.test("registry round-trips through JSON", () => {
  const r = family();
  const copy = new EntityRegistry(JSON.parse(JSON.stringify(r.toJSON())));
  assertEquals(copy.list(), r.list());
  // The copy is independent.
  copy.rename("father", "dad");
  assertEquals(r.get("father") !== undefined, true);
});

// ── colour slots, safety and descriptions (ADR 15) ─────────────────────────

Deno.test("the parties and children get their default colour slot when added", () => {
  const r = new EntityRegistry();
  const mother = r.add({ kind: "person", full: "Anna Thornbury", role: "mother" });
  r.add({ kind: "person", full: "Daniel Okafor", role: "father" });
  r.add({ kind: "person", full: "Mia Okafor", role: "child_1" });
  r.add({ kind: "person", full: "Lachlan Okafor", role: "child_2" });
  const gran = r.add({ kind: "person", full: "Margaret Thornbury", role: "maternal_grandmother" });
  const school = r.add({ kind: "school", full: "Kiama Downs Public School" });
  assertEquals(mother.colour, 0);
  assertEquals(r.get("father")?.colour, 1);
  assertEquals(r.get("child_1")?.colour, 2);
  assertEquals(r.get("child_2")?.colour, 3);
  assertEquals(gran.colour, undefined);
  assertEquals(school.colour, undefined);
  assertEquals(PALETTE.length, 6);
  assertEquals(
    r.palette().map((p) => [p.index, p.hex, p.owner]),
    [
      [0, "#FFAABB", "mother"],
      [1, "#77AADD", "father"],
      [2, "#44BB99", "child_1"],
      [3, "#BBCC33", "child_2"],
      [4, "#99DDFF", null],
      [5, "#EEDD88", null],
    ],
  );
});

Deno.test("a taken colour slot is refused; null gives neutral ink and frees the slot", () => {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Anna Thornbury", role: "mother" });
  r.add({ kind: "person", full: "Margaret Thornbury", role: "maternal_grandmother" });
  const err = assertThrows(() => r.setColour("maternal_grandmother", 0), ColourTakenError);
  assertEquals(err.owner, "mother");
  assertEquals(r.get("maternal_grandmother")?.colour, undefined);
  r.setColour("maternal_grandmother", 4);
  assertEquals(r.colourOwner(4), "maternal_grandmother");
  // Taking your own slot again is fine.
  r.setColour("maternal_grandmother", 4);
  r.setColour("mother", null);
  assertEquals(r.get("mother")?.colour, null);
  r.setColour("maternal_grandmother", 0);
  assertEquals(r.colourOwner(0), "maternal_grandmother");
  assertEquals(r.colourOwner(4), undefined);
  assertThrows(() => r.setColour("mother", 6), RangeError);
  assertThrows(() => r.setColour("mother", 1.5), RangeError);
  assertThrows(() => r.setColour("mother", -1), RangeError);
  assertThrows(() => r.setColour("nobody", 5));
});

Deno.test("update refuses a taken colour before changing anything else", () => {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Anna Thornbury", role: "mother" });
  r.add({ kind: "person", full: "Daniel Okafor", role: "father" });
  assertThrows(() => r.update("father", { aliases: ["Dan"], colour: 0 }), ColourTakenError);
  assertEquals(r.get("father")?.aliases, []);
  assertEquals(r.get("father")?.colour, 1);
  r.update("father", { safety: true, description: "{{mother}}'s former partner" });
  assertEquals(r.get("father")?.safety, true);
  assertEquals(r.get("father")?.description, "{{mother}}'s former partner");
  r.update("father", { safety: false, description: "" });
  assertEquals(r.get("father")?.safety, false);
  assertEquals(r.get("father")?.description, null);
});

Deno.test("a saved registry from before colour slots gets the defaults; a chosen null is kept", () => {
  const legacy = [
    { role: "mother", kind: "person" as const, forms: { full: "Anna Thornbury" }, aliases: [] },
    {
      role: "father",
      kind: "person" as const,
      forms: { full: "Daniel Okafor" },
      aliases: [],
      colour: null,
    },
    // child_1's slot was given to someone else; child_1 must not take it back.
    {
      role: "maternal_grandmother",
      kind: "person" as const,
      forms: { full: "Margaret Thornbury" },
      aliases: [],
      colour: 2,
    },
    { role: "child_1", kind: "person" as const, forms: { full: "Mia Okafor" }, aliases: [] },
  ];
  const r = new EntityRegistry(legacy);
  assertEquals(r.get("mother")?.colour, 0);
  assertEquals(r.get("father")?.colour, null);
  assertEquals(r.get("maternal_grandmother")?.colour, 2);
  assertEquals(r.get("child_1")?.colour, undefined);
});

Deno.test("renaming a role rewrites it in every description", () => {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Anna Thornbury", role: "person_1" });
  r.add({ kind: "person", full: "Margaret Thornbury", role: "maternal_grandmother" });
  r.update("maternal_grandmother", {
    description: "{{person_1}}'s mother ({{person_1.first}}), not {{person_10}}",
  });
  r.rename("person_1", "mother");
  assertEquals(
    r.get("maternal_grandmother")?.description,
    "{{mother}}'s mother ({{mother.first}}), not {{person_10}}",
  );
  // A role renamed to a default-colour role takes its slot if free.
  assertEquals(r.get("mother")?.colour, 0);
});

Deno.test("roleTokenRe matches exactly one role's tokens", () => {
  const text = "{{child_1}} {{child_1.first}} {{child_10}} {{child_1.bad}} {{child_1x}}";
  assertEquals([...text.matchAll(roleTokenRe("child_1"))].map((m) => m[0]), [
    "{{child_1}}",
    "{{child_1.first}}",
  ]);
  assertThrows(() => roleTokenRe("bad role"));
});

// ── every name word identifies (security review after merge) ─────────────

Deno.test("every capitalised word of a person's full name and nicknames is matchable, particles aside", () => {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Margaret Thornbury", role: "maternal_grandmother" });
  // The full name changes; the surname form does not (it is set separately).
  r.update("maternal_grandmother", { full: "Margaret Ellery", aliases: ["Peggy Sue"] });
  r.add({ kind: "person", full: "Ludwig van Beethoven", role: "person_1" });
  r.add({ kind: "person", full: "Maria de la Cruz", role: "person_2" });
  r.add({ kind: "person", full: "Ahmed bin Rashid", role: "person_3" });
  r.add({ kind: "person", full: "Siobhan O'Brien", role: "person_4" });
  r.add({ kind: "person", full: "Anna Smith-Jones", role: "person_5" });
  const leak = (role: string) =>
    r.variants({ leak: true }).filter((v) => v.entity.role === role && v.leakOnly)
      .map((v) => v.text).sort();
  assertEquals(leak("maternal_grandmother"), ["Ellery", "Peggy", "Sue"]);
  // Ludwig and Beethoven are the first and surname forms already; "van" is a particle.
  assertEquals(leak("person_1"), []);
  assertEquals(leak("person_2"), []);
  assertEquals(leak("person_3"), []);
  assertEquals(leak("person_4"), ["Brien"]);
  assertEquals(leak("person_5"), ["Jones", "Smith"]);
  // Not tokenising forms: they never become tokens on their own...
  assertEquals(tokeniseKnown("Ellery called", r).text, "Ellery called");
  // ...the leak check finds them...
  assertEquals(findLeaks("Ellery called", r).map((l) => l.text), ["Ellery"]);
  assertEquals(findLeaks("van der Berg called", r), []);
  // ...and the longest form still wins when tokenising.
  assertEquals(
    tokeniseKnown("Margaret Ellery called; Peggy Sue too", r).text,
    "{{maternal_grandmother}} called; {{maternal_grandmother}} too",
  );
  assertEquals(findLeaks("{{maternal_grandmother}} called", r), []);
});

Deno.test("personNameWords skips titles, particles, lower-case words and initials", () => {
  assertEquals(personNameWords("Dr Jane van der Merwe-Smith Jr"), [
    "Jane",
    "Merwe-Smith",
    "Merwe",
    "Smith",
  ]);
  assertEquals(personNameWords("J. R. Hartley"), ["Hartley"]);
  assertEquals(personNameWords("Mohammed bin Salman Al Saud"), ["Mohammed", "Salman", "Saud"]);
});
