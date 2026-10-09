import { createDetectors } from "../core/detect/factory.ts";
import { classifyEndpoint, LlmDetector } from "../core/detect/llm.ts";
import { checkModelSpec, loadTransformersClassifier } from "../core/detect/ner.ts";
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

/**
 * Download (the first time: about 110 MB from Hugging Face, pinned and hash-checked) and load the
 * name finder, when the user turns it on (ADR 26). The detector built afterwards uses the same
 * loaded model (`loadTransformersClassifier` keeps one per process); a failed load is not kept.
 */
export async function appNameFinderLoader(settings: CaseSettings): Promise<void> {
  await loadTransformersClassifier(checkModelSpec(settings.nerModel));
}
