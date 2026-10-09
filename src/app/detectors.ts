import { createDetectors } from "../core/detect/factory.ts";
import { classifyEndpoint, LlmDetector } from "../core/detect/llm.ts";
import type { Detector } from "../core/detect/types.ts";
import type { CaseSettings } from "../core/session.ts";
import type { LlmCheck } from "./state.ts";

/** Build the optional detectors (NER, LLM) from a case's settings (ADR 12). */
export function appDetectorFactory(settings: CaseSettings): Detector[] {
  return createDetectors(settings);
}

/** Tell the user whether their LLM endpoint keeps text on this machine, and whether it will be used. */
export async function appLlmChecker(
  settings: CaseSettings,
): Promise<LlmCheck & { permitted: boolean; why?: string }> {
  const llm = settings.llm!;
  const where = await classifyEndpoint(llm);
  const p = LlmDetector.permitted(where, llm);
  return { ...where, permitted: p.ok, why: p.why };
}
