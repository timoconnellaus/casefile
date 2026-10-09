/**
 * casefile's extra checks, unit by unit (ADR 14): the backends' requests and failures, the local
 * classifier's recipes, and the policy that turns answers into flags. SYNTHETIC data only (ADR 11).
 */
import { assert, assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import type { FetchFn } from "../src/core/detect/llm.ts";
import { createJudge } from "../src/core/judge/factory.ts";
import { JEV_ENDPOINT, JEV_MODEL, JevJudge } from "../src/core/judge/jev.ts";
import { answersFromReply, LlmJudge } from "../src/core/judge/llm.ts";
import { answerByNli, LocalJudge, type NliModel, plainLabels } from "../src/core/judge/local.ts";
import {
  calibrated,
  flagScore,
  QUESTION_FIELDS,
  QUESTIONS,
  raises,
  stricterOrigin,
  THRESHOLDS,
} from "../src/core/judge/questions.ts";
import { TEST_STATE } from "../src/core/judge/texts.ts";
import { JudgeError, type JudgeState } from "../src/core/judge/types.ts";
import { bestThreshold, metricsAt } from "../src/core/judge/evaluate.ts";

const state = (f: Record<string, string>) => f as unknown as JudgeState;
const FEELING = { feeling_or_opinion: QUESTIONS.feeling_or_opinion };

function stubFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchFn = (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(answer(url, init));
  };
  return { fetchFn, calls };
}

// ── Jev ────────────────────────────────────────────────────────────────────

Deno.test("Jev: the request is the pinned model, the state's fields and the questions without recipes", async () => {
  const { fetchFn, calls } = stubFetch(() =>
    Response.json({
      model: JEV_MODEL,
      answers: { feeling_or_opinion: { type: "noul", noul: 0.8 } },
    })
  );
  const a = await new JevJudge("ts-key-12345678", { fetch: fetchFn }).judge(TEST_STATE, FEELING);
  assertEquals(a.feeling_or_opinion, { type: "noul", noul: 0.8 });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, JEV_ENDPOINT);
  assertEquals(calls[0].init?.redirect, "error");
  assertEquals(new Headers(calls[0].init?.headers).get("authorization"), "Bearer ts-key-12345678");
  const body = JSON.parse(String(calls[0].init?.body));
  assertEquals(Object.keys(body).sort(), ["model", "questions", "state"]);
  assertEquals(body.model, "jev-1.13.0");
  assertEquals(body.state, { ...TEST_STATE });
  assertEquals(Object.keys(body.questions.feeling_or_opinion).sort(), [
    "criteria",
    "instructions",
    "type",
  ]);
});

Deno.test("Jev: a refused key, a busy service and nonsense are errors, never answers, and never echo the reply", async () => {
  const echo = "ECHO-of-the-text-sent";
  for (
    const [status, code] of [[401, "refused"], [403, "refused"], [500, "unavailable"]] as const
  ) {
    const { fetchFn } = stubFetch(() => new Response(echo, { status }));
    const e = await assertRejects(
      () => new JevJudge("k-12345678", { fetch: fetchFn }).judge(TEST_STATE, FEELING),
      JudgeError,
    );
    assertEquals(e.code, code);
    assert(!e.message.includes(echo));
  }
  // Busy: one retry, then an error.
  const busy = stubFetch(() => new Response(echo, { status: 429 }));
  await assertRejects(
    () =>
      new JevJudge("k-12345678", { fetch: busy.fetchFn, retryAfterMs: 1 }).judge(
        TEST_STATE,
        FEELING,
      ),
    JudgeError,
    "busy",
  );
  assertEquals(busy.calls.length, 2);
  // An answer of the wrong type or out of range.
  for (
    const answers of [
      {},
      { feeling_or_opinion: { type: "choice", choice: "x" } },
      { feeling_or_opinion: { type: "noul", noul: 1.5 } },
    ]
  ) {
    const { fetchFn } = stubFetch(() => Response.json({ answers }));
    await assertRejects(
      () => new JevJudge("k-12345678", { fetch: fetchFn }).judge(TEST_STATE, FEELING),
      JudgeError,
    );
  }
  // Unreachable.
  const down: FetchFn = () => Promise.reject(new TypeError("connection refused"));
  await assertRejects(
    () => new JevJudge("k-12345678", { fetch: down }).judge(TEST_STATE, FEELING),
    JudgeError,
    "couldn't reach Jev",
  );
});

// ── language model ─────────────────────────────────────────────────────────

Deno.test("language model: answers are read into typed answers; probabilities are normalised", () => {
  const a = answersFromReply(
    { feeling_or_opinion: QUESTIONS.feeling_or_opinion, origin_hint: QUESTIONS.origin_hint },
    {
      answers: {
        feeling_or_opinion: { p: 0.9 },
        origin_hint: { probabilities: { mine: 1, other_side: 3 } },
      },
    },
  );
  assertEquals(a.feeling_or_opinion, { type: "noul", noul: 0.9 });
  const o = a.origin_hint;
  assert(o.type === "choice");
  assertEquals(o.choice, "other_side");
  assertAlmostEquals(o.probabilities.other_side, 0.75);
  assertEquals(o.probabilities.unclear, 0);
  for (const bad of [{}, { answers: {} }, { answers: { feeling_or_opinion: { p: "high" } } }]) {
    let threw = false;
    try {
      answersFromReply(FEELING, bad);
    } catch (e) {
      threw = e instanceof JudgeError;
    }
    assert(threw, JSON.stringify(bad));
  }
});

Deno.test("language model: a remote endpoint is refused before anything is sent; local ones get reasoning_effort none", async () => {
  const remote = stubFetch(() => new Response("", { status: 500 }));
  await assertRejects(
    () =>
      new LlmJudge({ baseUrl: "https://llm.example.com/v1", model: "m" }, { fetch: remote.fetchFn })
        .judge(TEST_STATE, FEELING),
    JudgeError,
    "isn't on this computer",
  );
  assertEquals(remote.calls.length, 0);
  const local = stubFetch((url) =>
    url.endsWith("/api/tags") ? new Response("", { status: 404 }) : Response.json({
      choices: [{
        message: {
          content: '<think></think>```json\n{"answers":{"feeling_or_opinion":{"p":0.2}}}\n```',
        },
      }],
    })
  );
  const j = new LlmJudge(
    { baseUrl: "http://127.0.0.1:1234/v1", model: "m", trustLocalServer: true },
    { fetch: local.fetchFn },
  );
  assertEquals((await j.judge(TEST_STATE, FEELING)).feeling_or_opinion, {
    type: "noul",
    noul: 0.2,
  });
  const chat = local.calls.find((c) => c.url.endsWith("/chat/completions"))!;
  const body = JSON.parse(String(chat.init?.body));
  assertEquals(body.reasoning_effort, "none");
  assertEquals(body.temperature, 0);
  const user = JSON.parse(body.messages[1].content);
  assertEquals(user.state, { ...TEST_STATE });
  assert(!("nli" in user.questions.feeling_or_opinion));
});

// ── on this computer ───────────────────────────────────────────────────────

Deno.test("on this computer: labels become plain role words, and each recipe gives the right answer type", async () => {
  assertEquals(
    plainLabels("{{father.first}} collected {{child_1}} from {{school}}."),
    "father collected child 1 from school.",
  );
  const seen: [string, string][] = [];
  const model: NliModel = {
    logits(premise, hypothesis) {
      seen.push([premise, hypothesis]);
      return Promise.resolve(
        hypothesis.includes("subpoena")
          ? { entailment: 5, neutral: 0, contradiction: 0 }
          : { entailment: 0, neutral: 0, contradiction: 0 },
      );
    },
  };
  // pair: entailment over all three labels.
  const fair = await answerByNli(
    model,
    { claim: "{{mother.first}} waited.", cited_lines: "Where are you?" },
    QUESTIONS.fair_reading,
  );
  assert(fair.type === "noul");
  assertAlmostEquals(fair.noul, 1 / 3);
  assertEquals(seen[0], ["Where are you?", "mother waited."]);
  // single: entailment against contradiction.
  const feel = await answerByNli(model, { sentence: "x" }, QUESTIONS.feeling_or_opinion);
  assert(feel.type === "noul");
  assertAlmostEquals(feel.noul, 0.5);
  // labels: the subpoena hypothesis wins; "unclear" has no hypothesis, so 0.
  const origin = await answerByNli(model, { opening_lines: "x" }, QUESTIONS.origin_hint);
  assert(origin.type === "choice");
  assertEquals(origin.choice, "court_or_subpoena");
  assertEquals(origin.probabilities.unclear, 0);
  // A missing field is refused, not guessed.
  await assertRejects(() => answerByNli(model, {}, QUESTIONS.fair_reading), JudgeError);
});

Deno.test("on this computer: a model that can't load is a plain error, and loading is retried next time", async () => {
  let tries = 0;
  const j = new LocalJudge(() => {
    tries++;
    return Promise.reject(new Error("ModelPinError: tokenizer.json"));
  });
  await assertRejects(() => j.judge(TEST_STATE, FEELING), JudgeError, "about 90 MB");
  await assertRejects(() => j.judge(TEST_STATE, FEELING), JudgeError);
  assertEquals(tries, 2);
});

// ── the questions and the policy ───────────────────────────────────────────

Deno.test("every question has its fields, a local recipe and a threshold for every backend", () => {
  for (
    const [id, q] of Object.entries(QUESTIONS) as [
      keyof typeof QUESTIONS,
      typeof QUESTIONS[keyof typeof QUESTIONS],
    ][]
  ) {
    const text = JSON.stringify(q.instructions);
    for (const f of QUESTION_FIELDS[id]) assert(text.includes(`\`${f}\``), `${id} names ${f}`);
    assert(q.nli, `${id} has a recipe for this computer`);
    for (const b of ["local", "llm", "jev"] as const) {
      const t = THRESHOLDS[id][b];
      assert(t.value > 0 && t.value < 1, `${id}/${b}`);
    }
  }
  // Local and the language model were calibrated; Jev not yet (no key in this environment).
  assert(calibrated("local") && calibrated("llm"));
  assert(!calibrated("jev"));
});

Deno.test("policy: higher scores mean flag, and an origin hint only flags when it is stricter", () => {
  assertEquals(flagScore("fair_reading", { type: "noul", noul: 0.9 }), 1 - 0.9);
  assertEquals(flagScore("feeling_or_opinion", { type: "noul", noul: 0.9 }), 0.9);
  const subpoena = {
    type: "choice" as const,
    choice: "court_or_subpoena",
    confidence: 0.8,
    probabilities: {
      mine: 0.1,
      other_side: 0.05,
      court_or_subpoena: 0.8,
      under_order: 0.05,
      unclear: 0,
    },
  };
  assertAlmostEquals(flagScore("origin_hint", subpoena), 0.9);
  assert(raises("origin_hint", subpoena, "jev"));
  assertEquals(stricterOrigin(subpoena, "mine"), "court_or_subpoena");
  assertEquals(stricterOrigin(subpoena, "other_side"), null); // just as strict
  assertEquals(stricterOrigin(subpoena, "under_order"), null);
  // Thresholds are per backend: the same answer can flag on one and not another.
  const almost = { type: "noul" as const, noul: 0.99 };
  assert(raises("feeling_or_opinion", almost, "llm"));
  assert(!raises("feeling_or_opinion", almost, "local"));
});

Deno.test("evaluation: precision, recall and the threshold in the widest gap", () => {
  const scored = [
    { score: 0.1, flag: false },
    { score: 0.2, flag: false },
    { score: 0.8, flag: true },
    { score: 0.9, flag: true },
    { score: 0.85, flag: false },
  ];
  const m = metricsAt(scored, 0.5);
  assertEquals([m.tp, m.fp, m.fn, m.tn], [2, 1, 0, 2]);
  assertAlmostEquals(m.precision, 2 / 3);
  assertEquals(m.recall, 1);
  // Best F1 is either side of 0.85; the 0.2–0.8 gap is the widest of the ties.
  assertEquals(bestThreshold(scored).threshold, 0.5);
  assertEquals(bestThreshold([{ score: 0, flag: false }, { score: 1, flag: true }]).threshold, 0.5);
});

Deno.test("factory: off, missing settings and missing keys give no judge", () => {
  const llm = { baseUrl: "http://127.0.0.1:1234/v1", model: "m" };
  assertEquals(createJudge({ llm: null })?.backend, "local");
  assertEquals(createJudge({ llm: null, judge: { backend: "off" } }), null);
  assertEquals(createJudge({ llm: null, judge: { backend: "llm" } }), null);
  assertEquals(createJudge({ llm, judge: { backend: "llm" } })?.backend, "llm");
  assertEquals(createJudge({ llm, judge: { backend: "jev" } }), null);
  assertEquals(
    createJudge({ llm, judge: { backend: "jev", jevKey: "k-12345678" } })?.backend,
    "jev",
  );
});

Deno.test("the connection test sends only its invented sentence", () => {
  assertEquals(Object.keys(TEST_STATE), ["sentence"]);
  assert(TEST_STATE.sentence.includes("{{father.first}}"));
  assert(Object.isFrozen(TEST_STATE));
  // A plain state is never mistaken for a gated one at runtime either: the brand is type-only.
  assertEquals(JSON.stringify(state({ a: "b" })), '{"a":"b"}');
});
