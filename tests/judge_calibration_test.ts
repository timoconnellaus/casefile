/**
 * The extra checks' recorded calibration (ADR 14) still holds: each backend, run on the labelled
 * evaluation set at its recorded threshold, gives the precision and recall recorded next to the
 * questions in `judge/questions.ts`. SYNTHETIC data only (ADR 11).
 *
 * The real models are big, so these run only when they are available:
 * - on this computer: the pinned model's folder exists in `CASEFILE_JUDGE_MODEL_CACHE` or the
 *   usual model folder (`deno task judge-eval local` downloads it);
 * - the language model: `CASEFILE_TEST_LLM_URL` and `CASEFILE_TEST_LLM_MODEL` name the model the
 *   figures were recorded for.
 * The evaluation set itself is always checked.
 */
import { assert, assertEquals } from "@std/assert";
import { defaultModelDir } from "../src/core/detect/ner.ts";
import { metricsAt, scoreExamples } from "../src/core/judge/evaluate.ts";
import {
  DEFAULT_JUDGE_MODEL,
  judgeModelDownloaded,
  loadNliModel,
  LocalJudge,
} from "../src/core/judge/local.ts";
import { LlmJudge } from "../src/core/judge/llm.ts";
import { type QuestionId, QUESTIONS, THRESHOLDS } from "../src/core/judge/questions.ts";
import type { Judge, JudgeBackendId } from "../src/core/judge/types.ts";
import { EVAL_SETS } from "./fixtures/judge_eval.ts";
import { CANON_ENTITIES } from "./fixtures/canon.ts";

const QUESTION_IDS = Object.keys(QUESTIONS) as QuestionId[];

Deno.test("the evaluation set: both labels for every question, and no real values", () => {
  const values = CANON_ENTITIES.flatMap((e) =>
    [e.full, e.first, e.surname, ...(e.aliases ?? [])].filter((v): v is string => !!v)
  );
  for (const q of QUESTION_IDS) {
    const set = EVAL_SETS[q];
    const pos = set.filter((e) => e.flag).length;
    assert(pos >= 10 && set.length - pos >= 6, `${q}: ${pos} of ${set.length} should flag`);
    for (const ex of set) {
      const text = Object.values(ex.fields).join("\n");
      for (const v of values) {
        assert(!new RegExp(`\\b${v}\\b`).test(text), `${q} example names ${v}: ${text}`);
      }
    }
  }
});

async function checkRecorded(backend: JudgeBackendId, judge: Judge) {
  for (const q of QUESTION_IDS) {
    const t = THRESHOLDS[q][backend];
    assert(t.calibration, `${q}/${backend} has no calibration`);
    const m = metricsAt(await scoreExamples(judge, q, EVAL_SETS[q]), t.value);
    const round = (x: number) => Math.round(x * 100) / 100;
    assertEquals(
      [m.n, round(m.precision), round(m.recall)],
      [t.calibration.n, t.calibration.precision, t.calibration.recall],
      `${q}/${backend}`,
    );
  }
}

const cache = Deno.env.get("CASEFILE_JUDGE_MODEL_CACHE") ?? defaultModelDir();
const haveModel = await judgeModelDownloaded(DEFAULT_JUDGE_MODEL, cache).catch(() => false);

Deno.test({
  name: "on this computer: the recorded precision and recall hold",
  ignore: !haveModel,
  fn: async () => {
    await checkRecorded("local", new LocalJudge(() => loadNliModel(DEFAULT_JUDGE_MODEL, cache)));
  },
});

const llmUrl = Deno.env.get("CASEFILE_TEST_LLM_URL");
const llmModel = Deno.env.get("CASEFILE_TEST_LLM_MODEL");
const recordedFor = THRESHOLDS.fair_reading.llm.calibration?.model ?? "";

Deno.test({
  name: "the language model: the recorded precision and recall hold",
  ignore: !llmUrl || !llmModel || !recordedFor.startsWith(llmModel),
  fn: async () => {
    await checkRecorded(
      "llm",
      new LlmJudge(
        { baseUrl: llmUrl!, model: llmModel!, trustLocalServer: true },
        { timeoutMs: 300_000 },
      ),
    );
  },
});
