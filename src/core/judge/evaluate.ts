import { flagScore, type QuestionId, QUESTIONS } from "./questions.ts";
import type { Judge, JudgeState } from "./types.ts";

/**
 * Measuring a backend on a labelled evaluation set (ADR 14): each example's flag score
 * (`flagScore`, higher = more reason to flag) next to whether it should be flagged, and the
 * threshold that serves that backend best. Used by `scripts/judge-eval.ts` and the calibration
 * test; never by the app.
 */

export interface Example {
  /** State fields, with names already replaced (synthetic only, ADR 11). */
  fields: Record<string, string>;
  /** Whether casefile should raise a flag for it. */
  flag: boolean;
}

export interface Scored {
  score: number;
  flag: boolean;
}

export interface Metrics {
  threshold: number;
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Ask `judge` one question about each example, one at a time. */
export async function scoreExamples(
  judge: Judge,
  q: QuestionId,
  examples: Example[],
  onEach?: (i: number) => void,
): Promise<Scored[]> {
  const out: Scored[] = [];
  for (const [i, ex] of examples.entries()) {
    // Synthetic evaluation text, not case text: the gate (`texts.ts`) is for the case.
    const state = ex.fields as unknown as JudgeState;
    const answers = await judge.judge(state, { [q]: QUESTIONS[q] });
    out.push({ score: flagScore(q, answers[q]), flag: ex.flag });
    onEach?.(i);
  }
  return out;
}

/** Precision and recall of "flag when score ≥ threshold". */
export function metricsAt(scored: Scored[], threshold: number): Metrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const s of scored) {
    const raised = s.score >= threshold;
    if (raised && s.flag) tp++;
    else if (raised) fp++;
    else if (s.flag) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { threshold, n: scored.length, tp, fp, fn, tn, precision, recall, f1 };
}

/**
 * The threshold with the best F1. Candidates are the midpoints between neighbouring observed
 * scores (rounded to four places: small models' scores bunch near 0 or 1); on a tie the one in the
 * widest gap wins, so the threshold sits as far as it can from the examples on either side.
 */
export function bestThreshold(scored: Scored[]): Metrics {
  const u = [...new Set(scored.map((s) => s.score))].sort((a, b) => a - b);
  let best: Metrics | null = null;
  let bestGap = -1;
  for (let i = 0; i + 1 < u.length; i++) {
    const t = Math.round(((u[i] + u[i + 1]) / 2) * 1e4) / 1e4;
    if (t <= u[i] || t > u[i + 1]) continue; // the gap is too small for four places
    const m = metricsAt(scored, t);
    const gap = u[i + 1] - u[i];
    if (!best || m.f1 > best.f1 || (m.f1 === best.f1 && gap > bestGap)) {
      best = m;
      bestGap = gap;
    }
  }
  return best ?? metricsAt(scored, 0.5);
}
