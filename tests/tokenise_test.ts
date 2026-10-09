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

Deno.test("findLeaks sees every change to who's who, however it is made (cached matcher)", () => {
  // The variants the leak check looks for are remembered between documents (a document list
  // checks every one). A value learnt since must be found at once, or the check fails open.
  const r = reg();
  const text = "{{mother}} saw Danny and Mrs Ellery at Banksia Crescent.";
  assertEquals(findLeaks(text, r), []);
  r.update("father", { aliases: ["Danny"] }); // through the registry
  assertEquals(findLeaks(text, r).map((l) => l.text), ["Danny"]);
  r.list().find((e) => e.role === "mother")!.forms.surname = "Ellery"; // in place
  assertEquals(findLeaks(text, r).map((l) => l.text), ["Danny", "Mrs Ellery"]);
  r.add({ kind: "address", full: "14 Banksia Crescent, Gerringong NSW 2534" }); // a new entity
  assertEquals(findLeaks(text, r).map((l) => l.text), ["Danny", "Mrs Ellery", "Banksia Crescent"]);
  r.remove("father");
  assertEquals(findLeaks(text, r).map((l) => l.text), ["Mrs Ellery", "Banksia Crescent"]);
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
