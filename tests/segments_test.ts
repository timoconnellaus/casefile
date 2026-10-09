/** renderSegments (tokens.ts): re-identified text as segments the UI can colour. */
import { assertEquals } from "@std/assert";
import { type Form, renderSegments, renderTokens } from "../src/core/tokens.ts";

const VALUES: Record<string, string> = {
  mother: "Anna Thornbury",
  "mother.first": "Anna",
  school: "Kiama Downs Public School",
};
const resolve = (role: string, form: Form) =>
  VALUES[form === "full" ? role : `${role}.${form}`] ?? (VALUES[role] ? VALUES[role] : undefined);

Deno.test("segments: plain text, resolved tokens, unknown and malformed tokens", () => {
  const text = "{{mother.first}} took them to {{school}}; {{nobody}} saw {{Bad}} it.";
  const r = renderSegments(text, resolve);
  assertEquals(r.segs, [
    { t: "Anna", role: "mother", form: "first" },
    { t: " took them to " },
    { t: "Kiama Downs Public School", role: "school", form: "full" },
    { t: "; " },
    { t: "{{nobody}}", unknown: true, raw: "{{nobody}}" },
    { t: " saw " },
    { t: "{{Bad}}", malformed: true, raw: "{{Bad}}" },
    { t: " it." },
  ]);
  assertEquals(r.unknown.map((u) => u.raw), ["{{nobody}}"]);
  assertEquals(r.malformed.map((m) => m.raw), ["{{Bad}}"]);
});

Deno.test("segments join to exactly what renderTokens gives", () => {
  for (
    const text of [
      "",
      "No tokens at all.",
      "{{mother}}",
      "{{mother}}{{school}}",
      "a }} b {{ c {{mother.title}} {{x.y}}",
      "line one {{mother}}\nline two {{unknown_1}}",
    ]
  ) {
    const segs = renderSegments(text, resolve);
    const flat = renderTokens(text, resolve);
    assertEquals(segs.segs.map((s) => s.t).join(""), flat.text, text);
    assertEquals(segs.unknown, flat.unknown, text);
    assertEquals(segs.malformed, flat.malformed, text);
    // Plain runs are merged: no two plain segments in a row.
    segs.segs.forEach((s, i) => {
      const prev = segs.segs[i - 1];
      if (prev && Object.keys(prev).length === 1) {
        assertEquals(Object.keys(s).length > 1, true, `${text}: adjacent plain segments`);
      }
    });
  }
  assertEquals(renderSegments("", resolve).segs, []);
});
