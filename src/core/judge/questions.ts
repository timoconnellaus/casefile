import type { Origin } from "../publicdb.ts";
import type { Answer, JudgeBackendId, JudgeQuestion } from "./types.ts";

/**
 * Every question casefile's extra checks ask (ADR 14), with its criteria, the thresholds chosen
 * for each backend and what they were chosen on, and the words of each flag. Kept together so the
 * whole judgement surface can be reviewed in one place.
 *
 * Rules (ADR 14): a judge only answers these questions. Arithmetic, dates, lookups and policy
 * (which documents may be sent, what a flag means, whether anything is checked or shared) are in
 * code. A threshold is never carried from one backend, question wording or model version to
 * another without running the evaluation again (`scripts/judge-eval.ts` on
 * `tests/fixtures/judge_eval.ts`); changing a question's wording below means re-running it.
 */

export type QuestionId = "feeling_or_opinion" | "fair_reading" | "origin_hint";

/** The state fields each question reads (built by `texts.ts`). */
export const QUESTION_FIELDS: Record<QuestionId, readonly string[]> = {
  feeling_or_opinion: ["sentence"],
  fair_reading: ["claim", "cited_lines"],
  origin_hint: ["opening_lines"],
};

export const QUESTIONS: Record<QuestionId, JudgeQuestion> = {
  feeling_or_opinion: {
    type: "noul",
    instructions: {
      target:
        "`sentence`, one sentence of a draft affidavit, written in the first person by the person " +
        "swearing it. Labels in double braces such as {{father.first}} stand for people and places.",
      decision:
        "Does `sentence` state the writer's own feelings, beliefs, suspicions or opinions, rather " +
        "than only what happened, what was said or what they saw?",
    },
    criteria: {
      true: {
        meaning: "It says how the writer felt, what they believe, think, suspect or fear, or " +
          "gives their opinion or judgement of someone.",
        examples: ["I was frightened when he shouted.", "I believe he is not coping."],
      },
      false: {
        meaning: "It reports only events, dates, places, words said or written, or things the " +
          "writer did or saw, without saying how they felt about them.",
        examples: ["He collected the children at 4:31pm.", "I sent him a message at 3:05pm."],
      },
    },
    nli: {
      mode: "single",
      premise: "sentence",
      hypothesis: "This sentence expresses an emotion or an opinion.",
    },
  },
  fair_reading: {
    type: "noul",
    instructions: {
      target: "`claim`, a note Claude wrote about a case, and `cited_lines`, the lines it cites. " +
        "Labels in double braces such as {{father.first}} stand for people and places; the same " +
        "label means the same person.",
      decision: "Is `claim` a fair reading of `cited_lines`: is everything it says supported by " +
        "them, with nothing changed, overstated or added?",
    },
    criteria: {
      true: {
        meaning: "Every fact in `claim` (who, what, when, how much) is stated in or plainly " +
          "follows from `cited_lines`. Shorter wording or leaving details out is fine.",
      },
      false: {
        meaning: "`claim` states something `cited_lines` do not: a different person, time, " +
          "number or event, a stronger or weaker version, a motive, an admission or a detail " +
          "that is not there, or the opposite of what they say.",
      },
    },
    nli: { mode: "pair", premise: "cited_lines", hypothesis: "claim" },
  },
  origin_hint: {
    type: "choice",
    instructions: {
      target: "`opening_lines`, the title and first lines of a document in an Australian family " +
        "law case, kept by one of the parties (the user). Labels in double braces stand for people.",
      decision: "Where does this document most likely come from?",
    },
    criteria: {
      mine: "Written, sent or kept by the user: their own messages, notes, diary, emails, " +
        "budgets, or their own affidavit or court documents.",
      other_side: "From the other party or their lawyers: their affidavit, outline, letters or " +
        "documents served on the user.",
      court_or_subpoena:
        "Produced under a subpoena or notice to produce, or copied from the court file: " +
        "records of a school, doctor, police or department.",
      under_order: "Made or released under a court order or marked confidential by an order: " +
        "a family report, an expert's or independent children's lawyer's report.",
      unclear: "None of these can be told from the opening lines.",
    },
    nli: {
      mode: "labels",
      premise: "opening_lines",
      hypotheses: {
        mine: "This is a personal document.",
        other_side: "This is an official document from the other party's lawyer.",
        court_or_subpoena: "This is an official document produced under a subpoena.",
        under_order: "This is an official report prepared under a court order.",
      },
    },
  },
};

/** How far each origin is kept from Claude (ADR 7); a hint only matters if it is stricter. */
const ORIGIN_RANK: Record<Origin, number> = {
  mine: 0,
  other_side: 1,
  court_or_subpoena: 1,
  not_sure: 2,
  under_order: 2,
};

const RESTRICTED: Origin[] = ["other_side", "court_or_subpoena", "under_order"];

/**
 * Each question's answer as one number where higher means "more reason to flag", so every
 * question has one threshold per backend and the evaluation measures the flag decision itself.
 */
export function flagScore(q: QuestionId, a: Answer): number {
  if (q === "feeling_or_opinion" && a.type === "noul") return a.noul;
  if (q === "fair_reading" && a.type === "noul") return 1 - a.noul;
  if (q === "origin_hint" && a.type === "choice") {
    return RESTRICTED.reduce((n, o) => n + (a.probabilities[o] ?? 0), 0);
  }
  throw new Error(`${q}: unexpected answer type ${a.type}`);
}

/** A threshold and the evaluation it was chosen on (null: not evaluated, see `calibrated`). */
export interface Threshold {
  /** Flag when `flagScore` is at least this. */
  value: number;
  calibration: {
    /** When, and on what model, the evaluation ran. */
    date: string;
    model: string;
    /** Examples in the evaluation set. */
    n: number;
    precision: number;
    recall: number;
  } | null;
}

const LOCAL_MODEL = "Xenova/nli-deberta-v3-xsmall@2a4f614 (q8)";
const LLM_MODEL = "qwen/qwen3.6-35b-a3b in LM Studio, reasoning_effort none";
const JEV = "jev-1.13.0";

/**
 * Thresholds per question and backend, each chosen by `scripts/judge-eval.ts` on
 * `tests/fixtures/judge_eval.ts` (synthetic, labelled) as the best F1, with its precision and recall
 * there. The set is small and the local recipes' hypotheses were chosen on it too, so these
 * figures are optimistic; they say the check is roughly sound, not how often it is right on a
 * real case. A backend with `calibration: null` has not been run on the set: its threshold is a
 * neutral 0.5, Settings says its checks are not tuned yet, and it must be calibrated before anyone
 * relies on how often it flags.
 *
 * The language model's figures hold only for the model named: another model set up under Finding
 * names is a different backend for this purpose and needs its own run.
 */
export const THRESHOLDS: Record<QuestionId, Record<JudgeBackendId, Threshold>> = {
  feeling_or_opinion: {
    local: {
      value: 0.998,
      calibration: { date: "2026-10-09", model: LOCAL_MODEL, n: 36, precision: 0.85, recall: 0.94 },
    },
    llm: {
      value: 0.5,
      calibration: { date: "2026-10-09", model: LLM_MODEL, n: 36, precision: 1, recall: 1 },
    },
    jev: {
      value: 0.475,
      calibration: { date: "2026-10-09", model: JEV, n: 36, precision: 1, recall: 1 },
    },
  },
  fair_reading: {
    local: {
      value: 0.7027,
      calibration: { date: "2026-10-09", model: LOCAL_MODEL, n: 28, precision: 0.88, recall: 1 },
    },
    llm: {
      value: 0.525,
      calibration: { date: "2026-10-09", model: LLM_MODEL, n: 28, precision: 0.93, recall: 0.93 },
    },
    jev: {
      value: 0.79,
      calibration: { date: "2026-10-09", model: JEV, n: 28, precision: 1, recall: 1 },
    },
  },
  origin_hint: {
    local: {
      value: 0.5893,
      calibration: { date: "2026-10-09", model: LOCAL_MODEL, n: 18, precision: 1, recall: 0.92 },
    },
    llm: {
      value: 0.495,
      calibration: { date: "2026-10-09", model: LLM_MODEL, n: 18, precision: 1, recall: 0.83 },
    },
    // Low because Jev's scores are: the father's affidavit scored 0.09 and the user's own text
    // messages 0.06, so the margin is thin. A false flag only asks the user to look again.
    jev: {
      value: 0.075,
      calibration: { date: "2026-10-09", model: JEV, n: 18, precision: 1, recall: 1 },
    },
  },
};

/** True when every question has been evaluated for this backend. */
export function calibrated(backend: JudgeBackendId): boolean {
  return Object.values(THRESHOLDS).every((t) => t[backend].calibration !== null);
}

const ORIGIN_WORDS: Record<Origin, string> = {
  mine: "from you",
  other_side: "from the other side",
  court_or_subpoena: "from a subpoena or the court",
  under_order: "under a court order",
  not_sure: "from somewhere you're not sure of",
};

/** The words of each flag (DESIGN-SPEC §6: calm, specific, says what to do next). */
export const FLAG_COPY = {
  feeling_or_opinion:
    "casefile's extra check thinks this sentence gives feelings or opinions. Only the person " +
    "swearing the affidavit can say those, so make sure they are in that person's own words.",
  fair_reading:
    "casefile's extra check thinks Claude's note may say more than, or something different from, " +
    "the cited lines. Read them side by side before you tick “it is a fair reading”.",
  origin_hint: (judged: Origin, recorded: Origin | null) =>
    `casefile's extra check thinks this document may have come ${ORIGIN_WORDS[judged]}, not ${
      recorded ? ORIGIN_WORDS[recorded] : "where you said"
    }. If so, change where it came from. casefile hasn't changed anything.`,
} as const;

/** Whether an answer raises a flag, by this backend's threshold. Policy, in code (ADR 14). */
export function raises(q: QuestionId, a: Answer, backend: JudgeBackendId): boolean {
  return flagScore(q, a) >= THRESHOLDS[q][backend].value;
}

/**
 * The origin an `origin_hint` answer points to, when it is stricter than the one the user gave:
 * the most likely of the restricted origins. Null: nothing to say.
 */
export function stricterOrigin(a: Answer, recorded: Origin | null): Origin | null {
  if (a.type !== "choice") return null;
  const best = RESTRICTED.reduce((x, y) =>
    (a.probabilities[y] ?? 0) > (a.probabilities[x] ?? 0) ? y : x
  );
  return ORIGIN_RANK[best] > ORIGIN_RANK[recorded ?? "not_sure"] ? best : null;
}
