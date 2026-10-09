import { chronologyClaim, splitSentences } from "../claimcheck.ts";
import type { SourceRef } from "../publicdb.ts";
import type { CaseSession } from "../session.ts";
import type { JudgeFlag } from "../states.ts";
import { FLAG_COPY, type QuestionId, QUESTIONS, raises, stricterOrigin } from "./questions.ts";
import { claimState, type Gated, openingState, sentenceState, TEST_STATE } from "./texts.ts";
import { type Answer, type Judge, JudgeError } from "./types.ts";

/**
 * Running casefile's extra checks on one item (ADR 14). The judge answers; this module decides
 * what an answer means. It only ever returns flags for the user to look at: it writes nothing but
 * one log row of counts, and nothing that marks an item checked, adopted or shared calls it.
 */

export type JudgeItemType = "chronology" | "evidence" | "paragraph" | "document";

export interface JudgeOutcome {
  backend: Judge["backend"];
  flags: JudgeFlag[];
  /** Questions answered. */
  judgements: number;
  /** Parts that were not sent, with why (e.g. "It cites a document Claude can't see now."). */
  notChecked: string[];
}

/** At most this many sentences of one paragraph are checked. */
export const MAX_SENTENCES = 30;

function where(refs: SourceRef[]): string {
  return refs.map((r) =>
    r.line_start === r.line_end
      ? `${r.doc_id}:${r.line_start}`
      : `${r.doc_id}:${r.line_start}-${r.line_end}`
  ).join(", ");
}

/**
 * Run the extra checks for one item and return its flags. The log gets one row, whatever
 * happens: which backend, how many judgements, how many flags (and whether it failed). Never the
 * item, the text, the questions or the answers: an item id next to a flag count would tell Claude
 * the answer.
 */
export async function judgeItem(
  s: CaseSession,
  judge: Judge,
  item: { type: JudgeItemType; id: string | number },
): Promise<JudgeOutcome> {
  const out: JudgeOutcome = { backend: judge.backend, flags: [], judgements: 0, notChecked: [] };
  let failed = false;
  const ask = async (gated: Gated, q: QuestionId): Promise<Answer | null> => {
    if ("refused" in gated) {
      out.notChecked.push(gated.refused);
      return null;
    }
    const answers = await judge.judge(gated.state, { [q]: QUESTIONS[q] });
    out.judgements++;
    return answers[q];
  };
  const flag = (q: QuestionId, message: string, extra: Partial<JudgeFlag> = {}) =>
    out.flags.push({
      kind: "judgement",
      question: q,
      level: "attention",
      message,
      ...extra,
      backend: judge.backend,
    });
  try {
    if (item.type === "chronology") {
      const r = s.store.getChronology(Number(item.id));
      const a = await ask(await claimState(s, chronologyClaim(r), r.sources), "fair_reading");
      if (a && raises("fair_reading", a, judge.backend)) {
        flag("fair_reading", FLAG_COPY.fair_reading, { where: where(r.sources) });
      }
    } else if (item.type === "evidence") {
      const e = s.store.getEvidence(Number(item.id));
      const refs = [{ doc_id: e.doc_id, line_start: e.line_start, line_end: e.line_end }];
      const a = await ask(await claimState(s, e.note ?? "", refs), "fair_reading");
      if (a && raises("fair_reading", a, judge.backend)) {
        flag("fair_reading", FLAG_COPY.fair_reading, { where: where(refs) });
      }
    } else if (item.type === "paragraph") {
      const p = s.store.getParagraph(Number(item.id));
      const sentences = splitSentences(p.body);
      if (sentences.length > MAX_SENTENCES) {
        out.notChecked.push(`Only the first ${MAX_SENTENCES} sentences were checked.`);
      }
      for (const sentence of sentences.slice(0, MAX_SENTENCES)) {
        const f = await ask(sentenceState(s, sentence.text), "feeling_or_opinion");
        if (f && raises("feeling_or_opinion", f, judge.backend)) {
          flag("feeling_or_opinion", FLAG_COPY.feeling_or_opinion, { text: sentence.text });
        }
        if (!sentence.cites.length) continue;
        const a = await ask(await claimState(s, sentence.text, sentence.cites), "fair_reading");
        if (a && raises("fair_reading", a, judge.backend)) {
          flag("fair_reading", FLAG_COPY.fair_reading, {
            text: sentence.text,
            where: where(sentence.cites),
          });
        }
      }
    } else {
      const doc = await s.getDoc(String(item.id));
      const a = await ask(await openingState(s, doc.id), "origin_hint");
      const judged = a && raises("origin_hint", a, judge.backend)
        ? stricterOrigin(a, doc.origin ?? null)
        : null;
      if (judged) {
        flag("origin_hint", FLAG_COPY.origin_hint(judged, doc.origin ?? null), { where: doc.id });
      }
    }
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (out.judgements || failed) {
      s.log("user", "judge_ran", {
        backend: judge.backend,
        judgements: out.judgements,
        flags: out.flags.length,
        ...(failed ? { failed: true } : {}),
      });
    }
  }
  return out;
}

/**
 * "Test the connection": one fixed, invented sentence (`TEST_STATE`), never case text. Returns
 * nothing on success and throws `JudgeError` with plain words otherwise. Logged as counts.
 */
export async function testJudge(s: CaseSession, judge: Judge): Promise<void> {
  let ok = false;
  try {
    const answers = await judge.judge(TEST_STATE, {
      feeling_or_opinion: QUESTIONS.feeling_or_opinion,
    });
    if (answers.feeling_or_opinion?.type !== "noul") {
      throw new JudgeError("The check answered, but not in the expected way.", "bad_answer");
    }
    ok = true;
  } finally {
    s.log("user", "judge_tested", { backend: judge.backend, ok });
  }
}
