import { assertEquals, assertThrows } from "@std/assert";
import { EntityRegistry } from "../src/core/entities.ts";
import { applyTokens, findLeaks, tokeniseKnown } from "../src/core/tokenise.ts";

function reg() {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Anna Thornbury", role: "mother" });
  r.add({ kind: "person", full: "Daniel Okafor", role: "father" });
  r.add({ kind: "person", full: "Mia Okafor", role: "child_1" });
  return r;
}

Deno.test("applyTokens replaces spans and keeps line numbering", () => {
  const text = "Anna\nThornbury said\nhi";
  const out = applyTokens(text, [{ start: 0, end: 14, role: "mother", form: "full" }]);
  assertEquals(out, "{{mother}}\n said\nhi");
  assertEquals(out.split("\n").length, text.split("\n").length);
});

Deno.test("applyTokens rejects overlaps and bad ranges", () => {
  assertThrows(() =>
    applyTokens("abcdef", [{ start: 0, end: 3, role: "a", form: "full" }, {
      start: 2,
      end: 4,
      role: "b",
      form: "full",
    }])
  );
  assertThrows(() => applyTokens("abc", [{ start: 2, end: 9, role: "a", form: "full" }]));
});

Deno.test("findLeaks finds known values and identifiers left in tokenised text", () => {
  const r = reg();
  const leaks = findLeaks("{{mother}} met daniel at 3pm. Call 0412 345 678. {{father.first}}.", r);
  assertEquals(leaks.map((l) => l.text), ["daniel", "0412 345 678"]);
});

Deno.test("findLeaks ignores values inside tokens and ignored strings", () => {
  const r = new EntityRegistry();
  r.add({ kind: "school", full: "School", role: "school" }); // a value equal to part of a token name
  assertEquals(findLeaks("{{school}}", r), []);
  assertEquals(findLeaks("the School gate", r, ["school"]), []);
});

Deno.test("tokeniseKnown replaces unambiguous values and reports ambiguous ones", () => {
  const r = reg();
  const { text, ambiguous } = tokeniseKnown(
    "Anna told Mia that Okafor was late; Daniel Okafor agreed.",
    r,
  );
  assertEquals(
    text,
    "{{mother.first}} told {{child_1.first}} that Okafor was late; {{father}} agreed.",
  );
  assertEquals(ambiguous, [{ text: "Okafor", roles: ["father", "child_1"] }]);
});
