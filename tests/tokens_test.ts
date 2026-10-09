import { assertEquals, assertThrows } from "@std/assert";
import { formatToken, parseTokens, renderTokens, validateTokens } from "../src/core/tokens.ts";

const resolver = (role: string, form: string) => {
  const db: Record<string, Record<string, string>> = {
    mother: {
      full: "Anna Thornbury",
      first: "Anna",
      surname: "Thornbury",
      title: "Ms Thornbury",
    },
    child_1: { full: "Mia Okafor", first: "Mia" },
  };
  return db[role]?.[form] ?? db[role]?.full;
};

Deno.test("formatToken builds the four forms", () => {
  assertEquals(formatToken("mother"), "{{mother}}");
  assertEquals(formatToken("mother", "first"), "{{mother.first}}");
  assertEquals(formatToken("child_1", "surname"), "{{child_1.surname}}");
  assertThrows(() => formatToken("Mother"));
  assertThrows(() => formatToken("1child"));
  assertThrows(() => formatToken("a b"));
});

Deno.test("parseTokens finds valid tokens and offsets", () => {
  const t = "Hi {{mother.first}}, see {{child_1}}.";
  const { tokens, malformed } = parseTokens(t);
  assertEquals(malformed, []);
  assertEquals(tokens.map((x) => [x.role, x.form, t.slice(x.start, x.end)]), [
    ["mother", "first", "{{mother.first}}"],
    ["child_1", "full", "{{child_1}}"],
  ]);
});

Deno.test("parseTokens reports every malformed variant", () => {
  const cases = [
    "{{Mother}}",
    "{{mother.nickname}}",
    "{{ mother }}",
    "{{mother",
    "mother}}",
    "{{}}",
    "{mother}",
  ];
  for (const c of cases.slice(0, 6)) {
    const { tokens, malformed } = parseTokens(c);
    assertEquals(tokens.length, 0, c);
    assertEquals(malformed.length >= 1, true, c);
  }
  // Single braces are ordinary text.
  assertEquals(parseTokens("{mother}").malformed, []);
});

Deno.test("renderTokens re-identifies, keeps unknown tokens and reports them", () => {
  const r = renderTokens(
    "{{mother.title}} told {{child_1.first}} about {{grandmother}} and {{mothr",
    resolver,
  );
  assertEquals(r.text, "Ms Thornbury told Mia about {{grandmother}} and {{mothr");
  assertEquals(r.unknown.map((u) => u.role), ["grandmother"]);
  assertEquals(r.malformed.map((m) => m.raw), ["{{mothr"]);
});

Deno.test("renderTokens falls back to the full form when a form is missing", () => {
  assertEquals(renderTokens("{{child_1.surname}}", resolver).text, "Mia Okafor");
});

Deno.test("renderTokens can decorate unknown and malformed tokens", () => {
  const r = renderTokens("{{nobody}} {{Bad}}", resolver, {
    onUnknown: (t) => `<unknown ${t.role}>`,
    onMalformed: (m) => `<bad ${m.raw}>`,
  });
  assertEquals(r.text, "<unknown nobody> <bad {{Bad}}>");
});

Deno.test("validateTokens rejects unknown roles and malformed tokens", () => {
  const roles = new Set(["mother", "father"]);
  assertEquals(validateTokens("{{mother}} and {{father.first}}", roles).ok, true);
  assertEquals(validateTokens("plain text", roles).ok, true);
  const v = validateTokens("{{mother}} {{uncle}} {{father.nick}}", roles);
  assertEquals(v.ok, false);
  assertEquals(v.unknown.map((u) => u.role), ["uncle"]);
  assertEquals(v.malformed.length, 1);
});
