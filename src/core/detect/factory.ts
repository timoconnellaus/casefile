import { type FetchFn, LlmDetector, type LlmEndpointSettings } from "./llm.ts";
import {
  checkModelSpec,
  loadTransformersClassifier,
  NerDetector,
  type NerModelSpec,
  type TokenClassifier,
} from "./ner.ts";
import type { Detector } from "./types.ts";

/** The parts of `CaseSettings` (session.ts) that choose detectors. */
export interface DetectorSettings {
  llm: LlmEndpointSettings | null;
  nerEnabled: boolean;
  /** A NER model other than the default, with its commit and file hashes (ADR 12). */
  nerModel?: Partial<NerModelSpec>;
}

export interface DetectorDeps {
  /** Loads the NER model; called on first detection, so a failed load is reported then. */
  loadClassifier?: () => Promise<TokenClassifier>;
  fetch?: FetchFn;
  llmTimeoutMs?: number;
}

/**
 * The optional model detectors for a case (ADR 6, ADR 12): NER first if enabled, then the LLM
 * pass if an endpoint is configured. Rules and known entities always run inside the pipeline.
 */
export function createDetectors(settings: DetectorSettings, deps: DetectorDeps = {}): Detector[] {
  const out: Detector[] = [];
  if (settings.nerEnabled) {
    out.push(
      new NerDetector(
        deps.loadClassifier ??
          // Verifies the pinned files in memory and loads the model from those bytes (ADR 12).
          (() => loadTransformersClassifier(checkModelSpec(settings.nerModel))),
      ),
    );
  }
  if (settings.llm && settings.llm.baseUrl.trim() && settings.llm.model.trim()) {
    out.push(
      new LlmDetector(settings.llm, { fetch: deps.fetch, timeoutMs: deps.llmTimeoutMs }),
    );
  }
  return out;
}
