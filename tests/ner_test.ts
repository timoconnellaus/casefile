import { assert, assertEquals, assertRejects } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { chunkText } from "../src/core/detect/chunk.ts";
import {
  alignTokens,
  DEFAULT_NER_SPEC,
  groupPredictions,
  loadTransformersClassifier,
  modelFilesDir,
  ModelPinError,
  NerDetector,
  type TokenClassifier,
  type TokenPrediction,
} from "../src/core/detect/ner.ts";
import { detect } from "../src/core/detect/pipeline.ts";
import { EntityRegistry } from "../src/core/entities.ts";
import { AFFIDAVIT, PEOPLE, tempDir } from "./fixtures/synthetic.ts";

/** Predictions for the listed token positions (1-based, as the real pipeline reports them). */
function preds(tokens: string[], labels: Record<number, string>, score = 0.95): TokenPrediction[] {
  return Object.entries(labels).map(([i, entity]) => ({
    entity,
    score,
    index: Number(i),
    word: tokens[Number(i) - 1],
  }));
}

/**
 * A BERT-like fake: splits on whitespace and punctuation (no word pieces) and labels any word in
 * `labels` (first word of a run B-, following words I-). Records each text it was asked about.
 */
class FakeClassifier implements TokenClassifier {
  calls: string[] = [];
  constructor(private labels: Record<string, string>) {}
  tokenize(text: string): string[] {
    return text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  }
  classify(text: string): Promise<TokenPrediction[]> {
    this.calls.push(text);
    const tokens = this.tokenize(text);
    const out: TokenPrediction[] = [];
    tokens.forEach((t, i) => {
      const type = this.labels[t];
      if (!type) return;
      const prev = out.at(-1);
      const bio = prev && prev.index === i && prev.entity.endsWith(type) ? "I" : "B";
      out.push({ entity: `${bio}-${type}`, score: 0.97, index: i + 1, word: t });
    });
    return Promise.resolve(out);
  }
}

Deno.test("alignTokens maps word pieces, ## continuations and [UNK] to offsets", () => {
  const text = "Mia went to Wollongong ☃ today, O'Brien-Smith said.";
  const tokens = [
    "Mia",
    "went",
    "to",
    "W",
    "##oll",
    "##ong",
    "##ong",
    "[UNK]",
    "today",
    ",",
    "O",
    "'",
    "Brien",
    "-",
    "Smith",
    "said",
    ".",
  ];
  const offs = alignTokens(text, tokens);
  const got = offs.map((o) => (o ? text.slice(o.start, o.end) : null));
  assertEquals(got, [
    "Mia",
    "went",
    "to",
    "W",
    "oll",
    "ong",
    "ong",
    "☃",
    "today",
    ",",
    "O",
    "'",
    "Brien",
    "-",
    "Smith",
    "said",
    ".",
  ]);
});

Deno.test("alignTokens: [UNK] stops at punctuation, and a piece that cannot be placed is null", () => {
  const text = "☃☃, Bob";
  assertEquals(
    alignTokens(text, ["[UNK]", ",", "Bob"]).map((o) => o && text.slice(o.start, o.end)),
    ["☃☃", ",", "Bob"],
  );
  assertEquals(alignTokens("abc", ["zzz", "abc"]).map((o) => o && [o.start, o.end]), [null, [
    0,
    3,
  ]]);
});

Deno.test("groupPredictions joins sub-words into one place", () => {
  const text = "She moved to Wollongong last year.";
  const tokens = ["She", "moved", "to", "W", "##oll", "##ong", "##ong", "last", "year", "."];
  const spans = groupPredictions(
    text,
    tokens,
    preds(tokens, { 4: "B-LOC", 5: "B-LOC", 6: "I-LOC", 7: "I-LOC" }),
    0.6,
  );
  assertEquals(spans.map((s) => [s.text, s.kind, s.source]), [["Wollongong", "place", "ner"]]);
  assertEquals(text.slice(spans[0].start, spans[0].end), "Wollongong");
});

Deno.test("groupPredictions keeps a hyphenated, apostrophised name together", () => {
  const text = "Ask O'Brien-Smith now";
  const tokens = ["Ask", "O", "'", "Brien", "-", "Smith", "now"];
  // As the real model does: the hyphen is not an entity and Smith restarts with B-.
  const spans = groupPredictions(
    text,
    tokens,
    preds(tokens, { 2: "I-PER", 3: "I-PER", 4: "I-PER", 6: "B-PER" }),
    0.6,
  );
  assertEquals(spans.map((s) => s.text), ["O'Brien-Smith"]);
});

Deno.test("groupPredictions: B-/I- runs make one entity; adjacent B- words are separate", () => {
  const text = "Daniel Okafor met Mia Lachlan";
  const tokens = text.split(" ");
  const spans = groupPredictions(
    text,
    tokens,
    preds(tokens, { 1: "B-PER", 2: "I-PER", 4: "B-PER", 5: "B-PER" }),
    0.6,
  );
  assertEquals(spans.map((s) => s.text), ["Daniel Okafor", "Mia", "Lachlan"]);
});

Deno.test("groupPredictions never joins across a line break", () => {
  const text = "AFFIDAVIT\nFederal Circuit";
  const tokens = ["AFFIDAVIT", "Federal", "Circuit"];
  const spans = groupPredictions(
    text,
    tokens,
    preds(tokens, { 1: "B-ORG", 2: "I-ORG", 3: "I-ORG" }),
    0.6,
  );
  assertEquals(spans.map((s) => s.text), ["AFFIDAVIT", "Federal Circuit"]);
});

Deno.test("groupPredictions: different types next to each other stay separate", () => {
  const text = "Daniel Kiama";
  const tokens = text.split(" ");
  const spans = groupPredictions(text, tokens, preds(tokens, { 1: "B-PER", 2: "I-LOC" }), 0.6);
  assertEquals(spans.map((s) => [s.text, s.kind]), [["Daniel", "person"], ["Kiama", "place"]]);
});

Deno.test("groupPredictions widens a partly tagged word to the whole word", () => {
  const text = "in Wollongong.";
  const tokens = ["in", "W", "##oll", "##ong", "##ong", "."];
  const spans = groupPredictions(text, tokens, preds(tokens, { 3: "B-LOC", 4: "I-LOC" }), 0.6);
  assertEquals(spans.map((s) => s.text), ["Wollongong"]);
});

Deno.test("groupPredictions: schools, MISC and low scores", () => {
  const text = "Kiama Downs Public School and Australian Okafor Joinery";
  const tokens = text.split(" ");
  const ps = [
    ...preds(tokens, { 1: "B-ORG", 2: "I-ORG", 3: "I-ORG", 4: "I-ORG" }),
    ...preds(tokens, { 6: "B-MISC" }),
    ...preds(tokens, { 7: "B-ORG", 8: "I-ORG" }, 0.4),
  ];
  const spans = groupPredictions(text, tokens, ps, 0.6);
  assertEquals(spans.map((s) => [s.text, s.kind]), [["Kiama Downs Public School", "school"]]);
  // At a lower threshold the organisation appears, still as an organisation.
  const low = groupPredictions(text, tokens, ps, 0.3);
  assertEquals(low.map((s) => [s.text, s.kind]), [
    ["Kiama Downs Public School", "school"],
    ["Okafor Joinery", "organisation"],
  ]);
  // A place tagged LOC that is really a school becomes a school; "High Court" is not one.
  const t2 = "Little Gumnuts Childcare near the High Court";
  const k2 = t2.split(" ");
  assertEquals(
    groupPredictions(
      t2,
      k2,
      preds(k2, { 1: "B-LOC", 2: "I-LOC", 3: "I-LOC", 6: "B-ORG", 7: "I-ORG" }),
      0.6,
    ).map((s) => [s.text, s.kind]),
    [["Little Gumnuts Childcare", "school"], ["High Court", "organisation"]],
  );
});

Deno.test("chunkText breaks at line ends and covers the text exactly", () => {
  const text = "aaaa\nbbbb\ncccccccccccc dd\n";
  const chunks = chunkText(text, 8);
  assertEquals(chunks.map((c) => c.text).join(""), text);
  for (const c of chunks) {
    assert(c.text.length <= 8);
    assertEquals(text.slice(c.offset, c.offset + c.text.length), c.text);
  }
  assertEquals(chunks[0].text, "aaaa\n");
});

Deno.test("NerDetector offsets are correct across several chunks", async () => {
  const fake = new FakeClassifier({
    Anna: "PER",
    Thornbury: "PER",
    Mia: "PER",
    Gerringong: "LOC",
  });
  const det = new NerDetector(fake, { chunkChars: 120 });
  const spans = await det.detect(AFFIDAVIT);
  assert(fake.calls.length > 3, `expected several chunks, got ${fake.calls.length}`);
  assert(spans.length > 0);
  for (const s of spans) assertEquals(AFFIDAVIT.slice(s.start, s.end), s.text);
  const texts = spans.map((s) => s.text);
  assert(texts.includes("Anna Thornbury"));
  assert(texts.includes("Gerringong"));
  assertEquals(texts.filter((t) => t === "Mia").length, AFFIDAVIT.split("Mia").length - 1);
});

Deno.test("NerDetector splits a chunk that has too many word pieces for the model", async () => {
  const fake = new FakeClassifier({ Anna: "PER" });
  const text = "word ".repeat(300) + "Anna\n";
  const spans = await new NerDetector(fake, { chunkChars: 5000, maxTokens: 100 }).detect(text);
  for (const c of fake.calls) assert(fake.tokenize(c).length <= 100);
  assertEquals(spans.map((s) => text.slice(s.start, s.end)), ["Anna"]);
});

Deno.test("NerDetector with a failing loader reports through the pipeline and can retry", async () => {
  let attempts = 0;
  const det = new NerDetector(() => {
    attempts++;
    return Promise.reject(new Error("model download failed"));
  });
  const r = await detect("Email x@y.com", { registry: new EntityRegistry(), detectors: [det] });
  assertEquals(r.errors, [{ detector: "ner", message: "model download failed" }]);
  await detect("x", { registry: new EntityRegistry(), detectors: [det] });
  assertEquals(attempts, 2);
});

Deno.test({
  name: "real NER model finds the synthetic family (CASEFILE_TEST_NER=1)",
  ignore: !Deno.env.get("CASEFILE_TEST_NER"),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const det = new NerDetector(() => loadTransformersClassifier());
    const spans = await det.detect(AFFIDAVIT);
    for (const s of spans) assertEquals(AFFIDAVIT.slice(s.start, s.end), s.text);
    console.log(spans.map((s) => `${s.kind}\t${s.confidence.toFixed(2)}\t${s.text}`).join("\n"));
    const persons = spans.filter((s) => s.kind === "person").map((s) => s.text);
    for (const name of [PEOPLE.mother, PEOPLE.father]) {
      assert(persons.includes(name), `NER missed ${name}: ${persons.join(", ")}`);
    }
    // Through the pipeline, every name in the affidavit ends up covered.
    const r = await detect(AFFIDAVIT, { registry: new EntityRegistry(), detectors: [det] });
    assertEquals(r.errors, []);
    const covered = (needle: string) => {
      let i = -1;
      while ((i = AFFIDAVIT.indexOf(needle, i + 1)) !== -1) {
        if (!r.spans.some((s) => s.start <= i && s.end >= i + needle.length)) return false;
      }
      return true;
    };
    for (const n of ["Anna", "Thornbury", "Daniel", "Okafor", "Mia", "Lachlan"]) {
      assert(covered(n), `pipeline left "${n}" uncovered`);
    }
  },
});

Deno.test({
  name: "real NER model loads only from verified bytes in memory (CASEFILE_TEST_NER=1)",
  ignore: !Deno.env.get("CASEFILE_TEST_NER"),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // A verified copy of the model in a fresh cache folder (the test above downloads it).
    await loadTransformersClassifier();
    const cacheDir = await tempDir("casefile-ner-cache-");
    await copy(modelFilesDir(DEFAULT_NER_SPEC), modelFilesDir(DEFAULT_NER_SPEC, cacheDir));

    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (input: string | URL | Request) => {
      fetched.push(String(input));
      return Promise.reject(new Error("no network"));
    };
    try {
      // The library asks for a file that is not in the pin: the load fails, nothing is fetched.
      const { "tokenizer_config.json": _, ...files } = DEFAULT_NER_SPEC.files;
      const partial = { ...DEFAULT_NER_SPEC, files };
      await Deno.remove(join(modelFilesDir(partial, cacheDir), "tokenizer_config.json"));
      const err = await assertRejects(
        () => loadTransformersClassifier(partial, cacheDir),
        ModelPinError,
      );
      assert(err.files.some((f) => f.startsWith("tokenizer_config.json")), err.message);

      // With every pinned file present the model loads and works, without touching the network.
      const cacheDir2 = await tempDir("casefile-ner-cache-");
      await copy(modelFilesDir(DEFAULT_NER_SPEC), modelFilesDir(DEFAULT_NER_SPEC, cacheDir2));
      const det = new NerDetector(() => loadTransformersClassifier(DEFAULT_NER_SPEC, cacheDir2));
      const persons = (await det.detect(AFFIDAVIT)).filter((s) => s.kind === "person");
      assert(persons.some((s) => s.text === PEOPLE.mother));
      assertEquals(fetched, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
});
