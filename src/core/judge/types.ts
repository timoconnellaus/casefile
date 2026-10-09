import type { JudgeBackendId } from "../states.ts";

export type { JudgeBackendId };

/**
 * casefile's extra checks (ADR 14): typed judgements over text with names replaced. One
 * interface, three backends (`local.ts`, `llm.ts`, `jev.ts`). A judge only answers questions; what
 * an answer means (a flag or nothing) is decided in code (`questions.ts`, `run.ts`), and nothing a
 * judge says ever marks anything checked, adopted or shared.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
/** Instructions and criteria may be plain text or structured (Jev's `EntryType`). */
export type Entry = string | Json[] | { [k: string]: Json };

/** The probability that one condition holds (Jev "Noul"). */
export interface NoulQuestion {
  type: "noul";
  instructions: Entry;
  criteria: { true: Entry; false: Entry };
}

/** One option from a closed set. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: Entry;
  criteria: Record<string, Entry>;
}

/** A position on an ordered rubric (2–10 levels, from level 0). */
export interface ScoreQuestion {
  type: "score";
  instructions: Entry;
  criteria: Entry[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** Probability (0–1) that the condition holds. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** Over every option; sums to 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Expected level (may be fractional). */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/**
 * How the classifier on this computer answers a question (it can't read instructions): an NLI
 * model asks whether `premise` (a state field) entails a hypothesis.
 * - `pair`: the hypothesis is another state field (a claim against its cited lines); a noul's
 *   answer is the entailment probability.
 * - `single`: one fixed hypothesis; a noul's answer is entailment against contradiction.
 * - `labels`: one fixed hypothesis per option of a choice, compared with each other the way
 *   zero-shot classification does. Options without one get probability 0.
 */
export type NliRecipe =
  | { mode: "pair"; premise: string; hypothesis: string }
  | { mode: "single"; premise: string; hypothesis: string }
  | { mode: "labels"; premise: string; hypotheses: Record<string, string> };

/** A question as casefile asks it: the shared shape plus the local classifier's recipe. */
export type JudgeQuestion = Question & { nli?: NliRecipe };

declare const GATED: unique symbol;

/**
 * The text a judge may see: string fields built only by `texts.ts`, from what Claude may see
 * (shared documents' text with names replaced, Claude's notes and drafts in public.db), after a
 * leak check. The brand makes "anything else" a type error; it is not a runtime value.
 */
export type JudgeState = Readonly<Record<string, string>> & { readonly [GATED]: true };

export interface Judge {
  readonly backend: JudgeBackendId;
  /**
   * Answer every question about `state`, by the same keys. Throws `JudgeError` when it can't (the
   * backend is refused, unreachable or answers nonsense): a failed check is never an answer.
   */
  judge(
    state: JudgeState,
    questions: Record<string, JudgeQuestion>,
  ): Promise<Record<string, Answer>>;
}

/** An extra check that could not run. `message` is plain English and never quotes case text. */
export class JudgeError extends Error {
  constructor(
    message: string,
    readonly code: "refused" | "unavailable" | "bad_answer" = "unavailable",
  ) {
    super(message);
    this.name = "JudgeError";
  }
}

/** Check a backend's answers have the shape each question asked for. */
export function checkAnswers(
  questions: Record<string, JudgeQuestion>,
  answers: Record<string, unknown>,
  who: string,
): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const prob = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id] as Record<string, unknown> | undefined;
    const bad = () => new JudgeError(`${who} gave an answer casefile couldn't read.`, "bad_answer");
    if (!a || typeof a !== "object" || a.type !== q.type) throw bad();
    if (q.type === "noul") {
      if (!prob(a.noul)) throw bad();
      out[id] = { type: "noul", noul: a.noul as number };
    } else {
      const p = a.probabilities as Record<string, unknown> | undefined;
      const keys = q.type === "choice"
        ? Object.keys(q.criteria)
        : q.criteria.map((_, i) => String(i));
      if (!p || typeof p !== "object" || !keys.every((k) => prob(p[k]))) throw bad();
      if (!prob(a.confidence)) throw bad();
      const probabilities = Object.fromEntries(keys.map((k) => [k, p[k] as number]));
      if (q.type === "choice") {
        if (typeof a.choice !== "string" || !keys.includes(a.choice)) throw bad();
        out[id] = {
          type: "choice",
          choice: a.choice,
          probabilities,
          confidence: a.confidence as number,
        };
      } else {
        if (typeof a.score !== "number" || !Number.isFinite(a.score)) throw bad();
        out[id] = {
          type: "score",
          score: a.score,
          probabilities,
          confidence: a.confidence as number,
        };
      }
    }
  }
  return out;
}

/** The question as a remote backend receives it: no local recipe. */
export function wireQuestion(q: JudgeQuestion): Question {
  return q.type === "noul"
    ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
    : q.type === "choice"
    ? { type: "choice", instructions: q.instructions, criteria: q.criteria }
    : { type: "score", instructions: q.instructions, criteria: q.criteria };
}
