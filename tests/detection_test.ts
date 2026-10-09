/**
 * Detection gaps found by the security review (finding 5). SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { findRuleSpans } from "../src/core/detect/rules.ts";
import { detect } from "../src/core/detect/pipeline.ts";
import { EntityRegistry } from "../src/core/entities.ts";
import { findLeaks, tokeniseKnown } from "../src/core/tokenise.ts";
import { foldValue } from "../src/core/fold.ts";
import { CaseSession } from "../src/core/session.ts";
import { join } from "@std/path";
import { tempDir } from "./fixtures/synthetic.ts";
import { PASS } from "./fixtures/case.ts";

function registry() {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Anna Jessica Thornbury", role: "mother" });
  r.add({ kind: "person", full: "Daniel Okafor", role: "father" });
  r.add({ kind: "person", full: "Mia Okafor", role: "child_1" });
  r.add({ kind: "person", full: "Jo Pemberton", role: "relative_1" });
  r.add({ kind: "person", full: "Siobhan O'Brien", role: "friend_1" });
  r.add({ kind: "address", full: "14 Banksia Crescent, Gerringong NSW 2534", role: "home" });
  r.add({ kind: "school", full: "Kiama Downs Public School", role: "school" });
  r.add({ kind: "organisation", full: "Little Gumnuts Childcare", role: "childcare" });
  return r;
}

const leaked = (text: string, r = registry()) => findLeaks(text, r).map((l) => l.text);

Deno.test("plurals and possessive plurals of known values are caught", () => {
  assertEquals(leaked("We met the Okafors at the park."), ["Okafor"]);
  assertEquals(leaked("The Okafors' car was outside."), ["Okafor"]);
  assertEquals(tokeniseKnown("the Thornburys", registry()).text, "the {{mother.surname}}s");
});

Deno.test("Unicode apostrophes in names and possessives are matched", () => {
  assertEquals(leaked("Siobhan O’Brien called."), ["Siobhan O’Brien"]);
  assertEquals(leaked("OʼBrien said so."), ["OʼBrien"]);
  assertEquals(leaked("It was Annaʼs turn."), ["Anna"]);
  assertEquals(leaked("It was Anna’s turn."), ["Anna"]);
});

Deno.test("NFKC-equivalent forms are matched and mapped back to exact offsets", () => {
  const text = "Then Ｍｉａ left."; // full-width "Mia"
  const leaks = findLeaks(text, registry());
  assertEquals(leaks.map((l) => text.slice(l.start, l.end)), ["Ｍｉａ"]);
  assertEquals(tokeniseKnown(text, registry()).text, "Then {{child_1.first}} left.");
  // A ligature that expands under NFKC still maps back to whole characters.
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Fiona Smith", role: "aunt" });
  assertEquals(findLeaks("ﬁona said", r).map((l) => l.text), ["ﬁona"]);
  // Rules run on folded text too: full-width digits in a phone number.
  assertEquals(
    findRuleSpans("Call ０４１２ 345 678").map((s) => s.label),
    ["phone_mobile"],
  );
});

Deno.test("role names may not contain two-letter name words", () => {
  const r = registry();
  assertEquals(r.revealingWords("aunty_jo"), ["jo"]);
  assertEquals(r.revealingWords("maternal_aunt"), []);
});

Deno.test("a date straight after a person's name is flagged as a possible date of birth", () => {
  assertEquals(leaked("Mia (3/3/2017) started school."), ["Mia", "3/3/2017"]);
  assertEquals(leaked("{{child_1}} (3/3/2017) started school."), ["3/3/2017"]);
  assertEquals(leaked("{{child_1.first}}, 3 March 2017, was there."), ["3 March 2017"]);
  // Other dates are kept (ADR 6).
  assertEquals(leaked("On 14/03/2025 {{father}} was late."), []);
});

Deno.test("detection proposes a date after a new person's name as a date of birth", async () => {
  const r = new EntityRegistry();
  const result = await detect("Harper Nguyen (12/05/2016) is the child.", {
    registry: r,
    detectors: [{
      name: "fake",
      findsNames: true,
      detect: () =>
        Promise.resolve([{
          start: 0,
          end: 13,
          text: "Harper Nguyen",
          kind: "person" as const,
          source: "ner" as const,
          confidence: 0.9,
        }]),
    }],
  });
  assert(result.spans.some((s) => s.kind === "date_of_birth" && s.text === "12/05/2016"));
});

Deno.test("social handles are identifiers", () => {
  assertEquals(findRuleSpans("Message me @miaokafor09 tonight.").map((s) => s.text), [
    "@miaokafor09",
  ]);
  assertEquals(leaked("Her account @mia.o_09."), ["@mia.o_09"]);
  // Email addresses stay emails; a lone @ or "@ 3pm" is not a handle.
  assertEquals(findRuleSpans("jo@example.com").map((s) => s.label), ["email"]);
  assertEquals(findRuleSpans("meet @ 3pm, or @3").length, 0);
});

Deno.test("middle names, suburbs, streets and distinctive organisation words are leak-checked", () => {
  assertEquals(leaked("Jessica was there."), ["Jessica"]);
  assertEquals(leaked("We drove to Gerringong."), ["Gerringong"]);
  assertEquals(leaked("They live on Banksia Crescent."), ["Banksia Crescent"]);
  assertEquals(leaked("She goes to Kiama Downs now."), ["Kiama Downs"]);
  assertEquals(leaked("Pick-up from Little Gumnuts."), ["Little Gumnuts"]);
  // Not used to tokenise: "Jessica" alone would re-identify as the full name.
  assertEquals(tokeniseKnown("Jessica was there.", registry()).text, "Jessica was there.");
  // Generic words alone are not flagged.
  assertEquals(leaked("The public school and the childcare centre."), []);
});

Deno.test("every variant form round-trips: detect, tokenise, leak check, re-identify", async () => {
  const s = await CaseSession.create(join(await tempDir(), "case"), PASS, "T", {
    kdfIterations: 1_000,
  });
  s.registry.add({ kind: "person", full: "Anna Jessica Thornbury", role: "mother" });
  s.registry.add({ kind: "person", full: "Siobhan O'Brien", role: "friend_1" });
  s.registry.add({ kind: "person", full: "Zoë Pemberton", role: "cousin" });
  s.registry.add({ kind: "person", full: "Fiona Smith", role: "aunt" });
  s.registry.add({ kind: "person", full: "Anne-Marie Lee", role: "neighbour" });
  await s.saveRegistry();
  const forms = [
    "Anna",
    "ANNA",
    "Ｒｅｂｅｃｃａ", // full-width
    "Anna’s", // possessive, typographic apostrophe
    "Annaʼs", // possessive, modifier-letter apostrophe
    "An​na", // zero-width space inside
    "Reb­ecca", // soft hyphen inside
    "Thornburys", // plural
    "the Thornburys'", // possessive plural
    "Anna  Jessica   Thornbury", // runs of spaces
    "Anna Jessica Thornbury", // no-break and em spaces
    "Ms  Thornbury", // title, odd spacing
    "Siobhan OʼBrien",
    "O’Brien",
    "Zoë Pemberton", // decomposed accent
    "ﬁona", // ligature
    "Anne‑Marie Lee", // non-breaking hyphen
  ];
  const prefixes = ["", "x ", "\u{1F600} é ", "Ｚ ", "(", "​"];
  const lines = forms.flatMap((f, i) =>
    prefixes.map((p, j) => `${p}${f}${[".", ",", ")", " said hi", "", "!"][(i + j) % 6]}`)
  );
  const original = lines.join("\n") + "\n";
  const doc = await s.importText({ title: "Notes", text: original });
  for (const sp of doc.proposals) {
    assertEquals(sp.proposal.type, "existing", `${JSON.stringify(sp.text)} is a known value`);
  }
  const published = await s.publishWithDefaults(doc.id);
  assertEquals(await s.auditPublished(), [], "no leaks remain");
  const tokenised = published.tokenised!;
  assertEquals(tokenised.split("\n").length, original.split("\n").length, "lines preserved");
  const back = s.reidentify(tokenised).text.split("\n");
  original.split("\n").forEach((line, i) => {
    assertEquals(foldValue(back[i]), foldValue(line), `line ${i + 1} re-identifies`);
    for (
      const name of ["anna", "thornbury", "siobhan", "brien", "pemberton", "fiona", "marie"]
    ) {
      assert(!foldValue(tokenised.split("\n")[i]).includes(name), `line ${i + 1}: ${name}`);
    }
  });
  s.close();
});

Deno.test("a person named like an institution or a generic word is still caught", async () => {
  const r = new EntityRegistry();
  r.add({ kind: "person", full: "Harper Court", role: "person_1" });
  assertEquals(r.revealingWords("court_dad"), ["court"]);
  const result = await detect("Ms Court arrived.", {
    registry: new EntityRegistry(),
    detectors: [{
      name: "fake",
      detect: () =>
        Promise.resolve([{
          start: 3,
          end: 8,
          text: "Court",
          kind: "person" as const,
          source: "ner" as const,
          confidence: 0.9,
        }]),
    }],
  });
  assert(result.spans.some((s) => s.text === "Court"), "a person called Court is not dropped");
});
