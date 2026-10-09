/**
 * Run casefile's extra checks on the labelled evaluation set and print, per question, each
 * backend's best threshold with its precision and recall (ADR 14). The results go into
 * `THRESHOLDS` in `src/core/judge/questions.ts` by hand, with the date and model.
 *
 *   deno task judge-eval local [--model <candidate>] [--cache <dir>]
 *   deno task judge-eval llm --url http://127.0.0.1:1234/v1 --model qwen/qwen3.6-35b-a3b
 *   deno task judge-eval jev        (needs TYPESAFE_API_KEY: in .env locally, or the environment)
 *
 * The evaluation set is synthetic (tests/fixtures/judge_eval.ts, ADR 11); no case is opened.
 * `jev` sends those synthetic sentences to TypeSafe and is billed to the key's account.
 */
import { parseArgs } from "@std/cli/parse-args";
import { defaultModelDir, type NerModelSpec } from "../src/core/detect/ner.ts";
import { bestThreshold, metricsAt, scoreExamples } from "../src/core/judge/evaluate.ts";
import { JEV_MODEL, JevJudge } from "../src/core/judge/jev.ts";
import { DEFAULT_JUDGE_MODEL, loadNliModel, LocalJudge } from "../src/core/judge/local.ts";
import { LlmJudge } from "../src/core/judge/llm.ts";
import { type QuestionId, QUESTIONS, THRESHOLDS } from "../src/core/judge/questions.ts";
import type { Judge, JudgeBackendId } from "../src/core/judge/types.ts";
import { EVAL_SETS } from "../tests/fixtures/judge_eval.ts";

/** Other pinned NLI models compared with the default when it was chosen (2026-10-09). */
const CANDIDATES: Record<string, NerModelSpec> = {
  "deberta-v3-xsmall": DEFAULT_JUDGE_MODEL,
  "mobilebert-mnli": {
    id: "Xenova/mobilebert-uncased-mnli",
    revision: "8b0ea66ab7b190bba77418ba03b67d69cfc9a1ee",
    files: {
      "config.json": "93b1698798a8ff921b49c40d3afa7584342b94b06fde7851d342134eadaf61c7",
      "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      "tokenizer_config.json": "cbba05b96360d6653cf739f5cd890b10a46cc7ea77a5301abb8273ca1859f3d8",
      "onnx/model_quantized.onnx":
        "1dc36bc1f41b1d1da9e8f28f69f8dc6fa316410b2cde057756ddfb7083a48021",
    },
  },
  "distilbert-mnli": {
    id: "Xenova/distilbert-base-uncased-mnli",
    revision: "fddd480db7392a87114a6813c6acb5ede13ff4ee",
    files: {
      "config.json": "7d897374b56613fb8579c623dd89bbc01ab9795612b3d1d546cd5658232a5c7a",
      "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      "tokenizer_config.json": "2bbf2ea55c232406706144b907ca020cd7528a78e3e4741115be3b3566542b0b",
      "onnx/model_quantized.onnx":
        "5b7e374d8d1e44149fafa498efe80166f740914b3e53bcfa6115fb3ecaca0945",
    },
  },
};

const args = parseArgs(Deno.args, {
  string: ["model", "url", "cache", "question"],
  boolean: ["verbose"],
});
const backend = String(args._[0] ?? "") as JudgeBackendId;
let judge: Judge;
let modelName: string;
if (backend === "local") {
  const name = args.model ?? "deberta-v3-xsmall";
  const spec = CANDIDATES[name];
  if (!spec) throw new Error(`--model: one of ${Object.keys(CANDIDATES).join(", ")}`);
  judge = new LocalJudge(() => loadNliModel(spec, args.cache ?? defaultModelDir()));
  modelName = `${spec.id}@${spec.revision.slice(0, 7)}`;
} else if (backend === "llm") {
  if (!args.url || !args.model) throw new Error("llm needs --url and --model");
  // The evaluation set is synthetic, so vouching for the server here sends nothing from a case.
  judge = new LlmJudge(
    { baseUrl: args.url, model: args.model, trustLocalServer: true },
    { timeoutMs: 300_000 },
  );
  modelName = args.model;
} else if (backend === "jev") {
  const key = Deno.env.get("TYPESAFE_API_KEY");
  if (!key) throw new Error("jev needs TYPESAFE_API_KEY (in .env, or the environment)");
  judge = new JevJudge(key);
  modelName = JEV_MODEL;
} else {
  throw new Error("usage: judge-eval local|llm|jev [options]");
}

const only = args.question as QuestionId | undefined;
const date = new Date().toISOString().slice(0, 10);
console.log(`Backend ${backend}, model ${modelName}, ${date}\n`);
for (const q of Object.keys(QUESTIONS) as QuestionId[]) {
  if (only && q !== only) continue;
  const examples = EVAL_SETS[q];
  const t0 = performance.now();
  const scored = await scoreExamples(judge, q, examples, (i) => {
    Deno.stderr.writeSync(new TextEncoder().encode(`\r${q}: ${i + 1}/${examples.length}`));
  });
  const secs = (performance.now() - t0) / 1000;
  Deno.stderr.writeSync(new TextEncoder().encode("\n"));
  const best = bestThreshold(scored);
  const current = metricsAt(scored, THRESHOLDS[q][backend].value);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(
    `${q} (n=${best.n}, ${scored.filter((s) => s.flag).length} should flag, ${
      secs.toFixed(1)
    } s)\n` +
      `  best:    threshold ${best.threshold.toFixed(4)}  precision ${pct(best.precision)}  ` +
      `recall ${pct(best.recall)}  (tp ${best.tp}, fp ${best.fp}, fn ${best.fn}, tn ${best.tn})\n` +
      `  current: threshold ${current.threshold.toFixed(4)}  precision ${
        pct(current.precision)
      }  recall ${pct(current.recall)}`,
  );
  if (args.verbose) {
    for (const [i, s] of scored.entries()) {
      console.log(
        `    ${s.flag ? "F" : "-"} ${s.score.toFixed(3)}  ${
          JSON.stringify(examples[i].fields).slice(0, 110)
        }`,
      );
    }
  }
}
