import {
  defaultModelDir,
  downloadPinnedModel,
  loadPinnedClassifier,
  type ModelFiles,
  modelFilesDir,
  type NerModelSpec,
  withPinnedModel,
} from "../detect/ner.ts";
import {
  type Answer,
  type Judge,
  JudgeError,
  type JudgeQuestion,
  type JudgeState,
  type NliRecipe,
} from "./types.ts";

/**
 * The extra-check backend on this computer (ADR 14): a small natural-language-inference model
 * run through transformers.js, pinned and loaded the way the name finder is (ADR 12): the files
 * are checked against SHA-256 hashes fixed below, served to transformers.js from memory, and
 * downloaded once from Hugging Face at a pinned commit. Nothing is sent anywhere when it runs.
 *
 * NLI answers "does this premise entail this hypothesis?". Each question carries a recipe
 * (`JudgeQuestion.nli`) saying how to ask it that way.
 */

/**
 * Xenova/nli-deberta-v3-xsmall (cross-encoder/nli-deberta-v3-xsmall, ONNX q8, about 87 MB). Hashes
 * checked on 2026-10-09 against a fresh HTTPS download at this commit; the weights' hash also
 * matches the Hub's LFS SHA-256. Chosen over mobilebert-uncased-mnli and
 * distilbert-base-uncased-mnli on the evaluation set (ADR 14 amendment).
 */
export const DEFAULT_JUDGE_MODEL: NerModelSpec = {
  id: "Xenova/nli-deberta-v3-xsmall",
  revision: "2a4f614a701367a02d51389039afc998faeda637",
  files: {
    "config.json": "ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53",
    "tokenizer.json": "a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df",
    "tokenizer_config.json": "d8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f",
    "onnx/model_quantized.onnx": "3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6",
  },
};

/** Raw scores for one premise and hypothesis. */
export interface NliLogits {
  entailment: number;
  neutral: number;
  contradiction: number;
}

/** What the backend needs from a model; injectable for tests. */
export interface NliModel {
  logits(premise: string, hypothesis: string): Promise<NliLogits>;
}

function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
}

/**
 * Labels in double braces mean nothing to a small model: `{{father.first}}` becomes "father",
 * `{{child_1}}` "child 1". Roles never contain a name (ADR 5), so this adds nothing identifying.
 */
export function plainLabels(text: string): string {
  return text.replace(
    /\{\{([a-z][a-z0-9_]*)(?:\.[a-z]+)?\}\}/g,
    (_m, role: string) => role.replace(/_/g, " "),
  );
}

/** Answer one question by its recipe. */
export async function answerByNli(
  model: NliModel,
  state: Readonly<Record<string, string>>,
  q: JudgeQuestion,
): Promise<Answer> {
  const recipe: NliRecipe | undefined = q.nli;
  if (!recipe) throw new JudgeError("This check can't run on this computer.", "refused");
  const field = (name: string) => {
    const v = state[name];
    if (typeof v !== "string") throw new JudgeError("This check is missing its text.", "refused");
    return plainLabels(v);
  };
  const premise = field(recipe.premise);
  const refuse = () => new JudgeError("This check can't run on this computer.", "refused");
  if (recipe.mode === "pair" || recipe.mode === "single") {
    if (q.type !== "noul") throw refuse();
    const hypothesis = recipe.mode === "pair" ? field(recipe.hypothesis) : recipe.hypothesis;
    const l = await model.logits(premise, hypothesis);
    const noul = recipe.mode === "pair"
      ? softmax([l.entailment, l.neutral, l.contradiction])[0]
      : softmax([l.entailment, l.contradiction])[0];
    return { type: "noul", noul };
  }
  // Zero-shot: the entailment score of each option's hypothesis, compared across options.
  if (q.type !== "choice") throw refuse();
  const labels = Object.keys(recipe.hypotheses);
  const scores: number[] = [];
  for (const k of labels) {
    scores.push((await model.logits(premise, recipe.hypotheses[k])).entailment);
  }
  const p = softmax(scores);
  const probabilities = Object.fromEntries(
    Object.keys(q.criteria).map((k) => [k, labels.includes(k) ? p[labels.indexOf(k)] : 0]),
  );
  const best = Math.max(...p);
  return { type: "choice", choice: labels[p.indexOf(best)], probabilities, confidence: best };
}

export class LocalJudge implements Judge {
  readonly backend = "local" as const;
  private loaded?: Promise<NliModel>;

  /** `model` may be a loader; it is called on first use, so a failed load is reported then. */
  constructor(private model: NliModel | (() => Promise<NliModel>)) {}

  private load(): Promise<NliModel> {
    if (typeof this.model !== "function") return Promise.resolve(this.model);
    if (!this.loaded) {
      const p = this.model();
      this.loaded = p;
      p.catch(() => {
        if (this.loaded === p) this.loaded = undefined;
      });
    }
    return this.loaded;
  }

  async judge(
    state: JudgeState,
    questions: Record<string, JudgeQuestion>,
  ): Promise<Record<string, Answer>> {
    let model: NliModel;
    try {
      model = await this.load();
    } catch (e) {
      if (e instanceof JudgeError) throw e;
      throw new JudgeError(
        "casefile couldn't start its checker on this computer. It downloads about 90 MB the first " +
          "time; check the internet connection and try again.",
      );
    }
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) out[id] = await answerByNli(model, state, q);
    return out;
  }
}

async function nliFromFiles(spec: NerModelSpec, files: ModelFiles): Promise<NliModel> {
  // deno-lint-ignore no-explicit-any
  const { tokenizer, model, labels }: any = await withPinnedModel(spec, files, async (tf) => {
    const opts = { revision: spec.revision };
    const tokenizer = await tf.AutoTokenizer.from_pretrained(spec.id, opts);
    const model = await tf.AutoModelForSequenceClassification.from_pretrained(spec.id, {
      ...opts,
      dtype: "q8",
    });
    const id2label = model.config?.id2label ?? {};
    const labels = Object.fromEntries(
      Object.entries(id2label).map(([i, l]) => [String(l).toLowerCase(), Number(i)]),
    );
    return { tokenizer, model, labels };
  });
  for (const k of ["entailment", "neutral", "contradiction"]) {
    if (typeof labels[k] !== "number") throw new Error(`The checker model has no ${k} label`);
  }
  return {
    async logits(premise, hypothesis) {
      const inputs = tokenizer(premise, { text_pair: hypothesis, truncation: true });
      const { logits } = await model(inputs);
      const d = logits.data as Float32Array;
      return {
        entailment: d[labels.entailment],
        neutral: d[labels.neutral],
        contradiction: d[labels.contradiction],
      };
    },
  };
}

const loaders = new Map<string, Promise<NliModel>>();

/**
 * Load the pinned checker model once per process: verified in memory, downloaded on first use
 * (the only network access), and given to transformers.js as bytes, never as a path or URL.
 */
export function loadNliModel(
  spec: NerModelSpec = DEFAULT_JUDGE_MODEL,
  cacheDir = defaultModelDir(),
): Promise<NliModel> {
  const key = `${spec.id}\0${spec.revision}\0${cacheDir}`;
  let p = loaders.get(key);
  if (!p) {
    const modelDir = modelFilesDir(spec, cacheDir);
    p = loadPinnedClassifier<NliModel>({
      modelDir,
      pin: spec.files,
      download: () => downloadPinnedModel(spec, modelDir),
      load: (files) => nliFromFiles(spec, files),
    });
    loaders.set(key, p);
    p.catch(() => loaders.delete(key));
  }
  return p;
}

/** Whether the pinned model's folder is there (it is verified again when loaded). */
export async function judgeModelDownloaded(
  spec: NerModelSpec = DEFAULT_JUDGE_MODEL,
  cacheDir = defaultModelDir(),
): Promise<boolean> {
  try {
    return (await Deno.lstat(modelFilesDir(spec, cacheDir))).isDirectory;
  } catch {
    return false;
  }
}
