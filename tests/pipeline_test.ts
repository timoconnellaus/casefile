import { assert, assertEquals } from "@std/assert";
import { detect, mergeSpans, normaliseSpan } from "../src/core/detect/pipeline.ts";
import type { Span } from "../src/core/detect/types.ts";
import { EntityRegistry } from "../src/core/entities.ts";
import {
  AFFIDAVIT,
  FailingDetector,
  FAKE_NER_NAMES,
  FakeNameDetector,
} from "./fixtures/synthetic.ts";

const span = (start: number, end: number, source: Span["source"], confidence = 0.9): Span => ({
  start,
  end,
  text: "x".repeat(end - start),
  kind: "person",
  source,
  confidence,
});

Deno.test("mergeSpans prefers stronger sources, then longer spans", () => {
  const merged = mergeSpans([
    span(0, 10, "ner"),
    span(2, 5, "rule"),
    span(20, 30, "ner"),
    span(18, 35, "llm"),
  ]);
  assertEquals(merged.map((s) => [s.start, s.end, s.source]), [[2, 5, "rule"], [18, 35, "llm"]]);
  assertEquals(mergeSpans([span(0, 4, "ner"), span(0, 9, "ner")]).map((s) => s.end), [9]);
});

Deno.test("normaliseSpan trims punctuation and splits at line breaks", () => {
  const text = ' "Jane Smith", and\nBob ';
  const pieces = normaliseSpan(text, { ...span(0, text.length, "llm"), text });
  assertEquals(pieces.map((p) => p.text), ['Jane Smith", and', "Bob"]);
  assertEquals(
    normaliseSpan("(Jane)", { ...span(0, 6, "ner"), text: "(Jane)" }).map((p) => p.text),
    ["Jane"],
  );
});

Deno.test("rules alone catch identifiers but not names", async () => {
  const r = await detect(AFFIDAVIT, { registry: new EntityRegistry() });
  const labels = new Set(r.spans.map((s) => s.label));
  for (
    const l of [
      "email",
      "phone_mobile",
      "medicare",
      "tfn",
      "abn",
      "street_address",
      "date_of_birth",
      "court_file_number",
    ]
  ) {
    assert(labels.has(l), `missing ${l}`);
  }
  assert(!r.spans.some((s) => s.text.includes("Anna")));
});

Deno.test("names found once are found everywhere, with name parts and titles", async () => {
  const r = await detect(AFFIDAVIT, {
    registry: new EntityRegistry(),
    detectors: [new FakeNameDetector(FAKE_NER_NAMES)],
  });
  const texts = r.spans.map((s) => s.text);
  // "Kiama Downs Public School" appears twice; the fake detector only reports the first.
  assertEquals(texts.filter((t) => t === "Kiama Downs Public School").length, 2);
  // First names on their own.
  assert(texts.includes("Mia"));
  assert(texts.includes("Daniel"));
  // A shared surname with a title is ambiguous between the three Okafors.
  const mr = r.spans.find((s) => s.text === "Mr Okafor")!;
  assertEquals(mr.proposal.type, "ambiguous");
  if (mr.proposal.type === "ambiguous") assertEquals(mr.proposal.options.length, 3);
  // "Daniel's" → the first name is found inside the possessive.
  assert(r.spans.some((s) => s.text === "Daniel" && AFFIDAVIT.slice(s.end, s.end + 2) === "'s"));
  // The longer organisation name wins over the surname inside it.
  assert(texts.includes("Okafor Joinery"));
  // Every span's text matches its offsets.
  for (const s of r.spans) assertEquals(AFFIDAVIT.slice(s.start, s.end), s.text);
  // New entities carry the role hints.
  assertEquals(r.newEntities.find((n) => n.full === "Anna Thornbury")?.roleHint, "mother");
});

Deno.test("known entities are proposed as existing, ambiguous surnames need a decision", async () => {
  const reg = new EntityRegistry();
  reg.add({ kind: "person", full: "Daniel Okafor", role: "father" });
  reg.add({ kind: "person", full: "Mia Okafor", role: "child_1" });
  const r = await detect("Daniel told Mia. Okafor signed. Mr Okafor left.", { registry: reg });
  const byText = Object.fromEntries(r.spans.map((s) => [s.text, s.proposal]));
  assertEquals(byText["Daniel"], { type: "existing", role: "father", form: "first" });
  assertEquals(byText["Mia"], { type: "existing", role: "child_1", form: "first" });
  assertEquals(byText["Okafor"].type, "ambiguous");
  assertEquals(byText["Mr Okafor"].type, "ambiguous");
});

Deno.test("ignored strings are not proposed", async () => {
  const r = await detect("Call 0412 345 678", {
    registry: new EntityRegistry(),
    ignore: ["0412 345 678"],
  });
  assertEquals(r.spans, []);
});

Deno.test("a failing detector is reported, not hidden, and rules still run", async () => {
  const r = await detect("Email x@y.com", {
    registry: new EntityRegistry(),
    detectors: [new FailingDetector()],
  });
  assertEquals(r.errors, [{ detector: "broken", message: "model not available" }]);
  assertEquals(r.spans.length, 1);
});

Deno.test("name parts are matched case-sensitively", async () => {
  const r = await detect("Rose Hill visited. The rose garden.", {
    registry: new EntityRegistry(),
    detectors: [new FakeNameDetector([{ text: "Rose Hill", kind: "person" }])],
  });
  assertEquals(r.spans.map((s) => s.text), ["Rose Hill"]);
});

Deno.test("courts, agencies and headings found by a model are not proposed", async () => {
  const text =
    "AFFIDAVIT\nFederal Circuit and Family Court of Australia\nMedicare wrote to Kiama Downs Public School.";
  const r = await detect(text, {
    registry: new EntityRegistry(),
    detectors: [
      new FakeNameDetector([
        { text: "AFFIDAVIT", kind: "organisation" },
        { text: "Federal Circuit and Family Court of Australia", kind: "organisation" },
        { text: "Medicare", kind: "organisation" },
        { text: "Kiama Downs Public School", kind: "school" },
      ]),
    ],
  });
  assertEquals(r.spans.map((s) => s.text), ["Kiama Downs Public School"]);
});

Deno.test("a lone first name reported by a model is a name part, not a new person", async () => {
  const text = "Mia Okafor is seven. Mia likes school.";
  const r = await detect(text, {
    registry: new EntityRegistry(),
    detectors: [
      new FakeNameDetector([{ text: "Mia Okafor", kind: "person" }, {
        text: "likes school",
        kind: "other",
      }, { text: "Mia", kind: "person" }]),
    ],
  });
  const mia = r.spans.find((s) => s.text === "Mia")!;
  assertEquals(mia.proposal.type, "new");
  if (mia.proposal.type === "new") {
    assertEquals([mia.proposal.full, mia.proposal.form], ["Mia Okafor", "first"]);
  }
  assertEquals(r.newEntities.filter((n) => n.kind === "person").map((n) => n.full), ["Mia Okafor"]);
});
