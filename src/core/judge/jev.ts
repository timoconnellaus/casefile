import type { FetchFn } from "../detect/llm.ts";
import {
  type Answer,
  checkAnswers,
  type Judge,
  JudgeError,
  type JudgeQuestion,
  type JudgeState,
  wireQuestion,
} from "./types.ts";

/**
 * Jev by TypeSafe AI as an extra-check backend (ADR 14): a hosted decision model with typed
 * answers, reached over HTTPS. It is only ever given a `JudgeState`, which `texts.ts` builds from
 * what Claude may see (text with names replaced, never withheld or exposed documents). Off by
 * default; the API key lives in the vault's settings and is used only here, server-side.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Pinned, not the `jev-latest` alias: thresholds are chosen for one model version, and an alias
 * could change the answers without a code change (ADR 14).
 */
export const JEV_MODEL = "jev-1.13.0";

/** TypeSafe's terms as ADR 14 read them, and when they were last checked. Shown in Settings. */
export const JEV_TERMS = {
  checked: "2026-10-07",
  /** No training on inputs, by default (privacy policy). */
  privacy: "https://typesafe.ai/legal/privacy-policy",
  /** Retention not stated for ordinary accounts; hosted in the United States. */
  legal: "https://docs.typesafe.ai/legal",
} as const;

export interface JevOptions {
  fetch?: FetchFn;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /** Wait before the one retry after a 429 or 529, when the reply doesn't say. Default 2 s. */
  retryAfterMs?: number;
}

export class JevJudge implements Judge {
  readonly backend = "jev" as const;
  private fetchFn: FetchFn;

  constructor(private apiKey: string, private opts: JevOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async judge(
    state: JudgeState,
    questions: Record<string, JudgeQuestion>,
  ): Promise<Record<string, Answer>> {
    if (!this.apiKey) throw new JudgeError("Jev has no key. Add it in Settings.", "refused");
    const body = JSON.stringify({
      // Only the state's own fields; the type brand is not a value.
      state: Object.fromEntries(Object.entries(state)),
      model: JEV_MODEL,
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [id, wireQuestion(q)]),
      ),
    });
    let res = await this.post(body);
    if (res.status === 429 || res.status === 529) {
      // Busy: wait as asked (at most 10 s) and try once more.
      const after = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0
        ? Math.min(after * 1000, 10_000)
        : this.opts.retryAfterMs ?? 2000;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
      res = await this.post(body);
    }
    if (!res.ok) {
      // Never echo the reply: it could quote the text sent.
      await res.body?.cancel();
      throw new JudgeError(
        res.status === 401 || res.status === 403
          ? "Jev didn't accept the key. Check it in Settings."
          : res.status === 429 || res.status === 529
          ? "Jev is busy. Try again in a minute."
          : `Jev couldn't answer (error ${res.status}).`,
        res.status === 401 || res.status === 403 ? "refused" : "unavailable",
      );
    }
    const reply = await res.json().catch(() => null) as { answers?: unknown } | null;
    if (!reply || typeof reply.answers !== "object" || reply.answers === null) {
      throw new JudgeError("Jev gave an answer casefile couldn't read.", "bad_answer");
    }
    return checkAnswers(questions, reply.answers as Record<string, unknown>, "Jev");
  }

  private async post(body: string): Promise<Response> {
    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: ac.signal,
        // A redirect would re-send the text and the key to wherever it points.
        redirect: "error",
      });
      const buf = await res.arrayBuffer();
      return new Response(buf.byteLength ? buf : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (e) {
      if (e instanceof JudgeError) throw e;
      throw new JudgeError(
        ac.signal.aborted
          ? `Jev didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : "casefile couldn't reach Jev. Check the internet connection.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
