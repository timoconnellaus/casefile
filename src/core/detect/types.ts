import type { EntityKind } from "../entities.ts";

export type SpanSource = "rule" | "known" | "ner" | "llm" | "manual";

/** A stretch of original text believed to identify someone or something. Offsets are UTF-16 indices. */
export interface Span {
  start: number;
  end: number;
  text: string;
  kind: EntityKind;
  source: SpanSource;
  /** 0..1 */
  confidence: number;
  /** Rule name, NER label, or the LLM's reason. */
  label?: string;
  /** Suggested role name for a new entity, e.g. "mother". */
  roleHint?: string;
}

export interface Detector {
  readonly name: string;
  /** True for detectors that look for names (NER, LLM), as opposed to identifier patterns. */
  readonly findsNames?: boolean;
  detect(text: string): Promise<Span[]>;
}

/** Ranking used when spans overlap: lower is stronger. */
const SOURCE_RANK: Record<SpanSource, number> = { manual: 0, rule: 1, known: 2, llm: 3, ner: 4 };

export function sourceRank(s: SpanSource): number {
  return SOURCE_RANK[s];
}
