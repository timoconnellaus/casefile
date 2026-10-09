import type { FetchFn } from "../detect/llm.ts";
import type { CaseSettings, JudgeSettings } from "../session.ts";
import { JevJudge } from "./jev.ts";
import { LlmJudge } from "./llm.ts";
import { loadNliModel, LocalJudge, type NliModel } from "./local.ts";
import type { Judge } from "./types.ts";

/** Extra checks run on this computer unless the user chooses otherwise; Jev is off (ADR 14). */
export const DEFAULT_JUDGE_SETTINGS: JudgeSettings = { backend: "local" };

export function judgeSettingsOf(settings: Pick<CaseSettings, "judge">): JudgeSettings {
  return settings.judge ?? DEFAULT_JUDGE_SETTINGS;
}

export interface JudgeDeps {
  /** For the language model and Jev (tests pass a stub). */
  fetch?: FetchFn;
  /** Loads the classifier on this computer (tests pass a fake). */
  loadNli?: () => Promise<NliModel>;
  llmTimeoutMs?: number;
  jevTimeoutMs?: number;
}

/**
 * The judge the case's settings choose, or null when none can run: extra checks off, no language
 * model set up (it is the one under Finding names), or Jev chosen without a key.
 */
export function createJudge(
  settings: Pick<CaseSettings, "judge" | "llm">,
  deps: JudgeDeps = {},
): Judge | null {
  const j = judgeSettingsOf(settings);
  switch (j.backend) {
    case "local":
      return new LocalJudge(deps.loadNli ?? (() => loadNliModel()));
    case "llm":
      return settings.llm && settings.llm.baseUrl.trim() && settings.llm.model.trim()
        ? new LlmJudge(settings.llm, { fetch: deps.fetch, timeoutMs: deps.llmTimeoutMs })
        : null;
    case "jev":
      return j.jevKey
        ? new JevJudge(j.jevKey, { fetch: deps.fetch, timeoutMs: deps.jevTimeoutMs })
        : null;
    default:
      return null;
  }
}
