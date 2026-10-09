import type { Origin, SourceRef, WithheldReason } from "./publicdb.ts";

/**
 * The state vocabulary (DESIGN-SPEC §3): one word per state, shared by the app, the API and the
 * CLI. Types only, so the Claude-facing CLI may import this module.
 */

export type { Origin, WithheldReason };

/** A document: Needs review · Shared with Claude · Withheld from Claude · Exposed — re-check. */
export type DocState = "needs_review" | "shared" | "withheld" | "exposed";

/**
 * Claude's work (chronology entry, evidence link, issue description): To check · Checked against
 * source · Changed since you checked · Can't check.
 */
export type WorkState = "to_check" | "checked" | "changed" | "cant_check";

/**
 * A draft paragraph: Your words · Drafted by Claude — needs you · — rewritten by you, adopt to
 * confirm · — adopted.
 */
export type ParaState = "user" | "claude_needs_you" | "claude_rewritten" | "claude_adopted";

/** One row of a CheckList: something casefile checked itself, and what it found. */
export interface CheckRow {
  kind: "entity" | "date" | "number" | "feeling" | "placeholder" | "citation";
  /** What was checked, e.g. "14 March 2025" or a token such as "{{child_2}}". */
  text: string;
  /** true: found; false: not found; null: cannot be checked by casefile. */
  ok: boolean | null;
  level: "ok" | "attention" | "danger";
  /** Where it was looked for, e.g. "D001:1-2". */
  where?: string;
  /** Plain-English line for the user, e.g. "Lachlan is not in D001:1–2". */
  message: string;
}

/**
 * Where casefile's extra checks run (ADR 14): `local` a classifier on this computer, `llm` a
 * language model the user set up, `jev` Jev by TypeSafe (text with names replaced only).
 */
export type JudgeBackendId = "local" | "llm" | "jev";

/**
 * One flag from casefile's extra checks (ADR 14): something for the user to look at. It is never
 * a `CheckRow`, so it can never make an item "Can't check", and nothing that marks an item
 * checked, adopted or shared reads it.
 */
export interface JudgeFlag {
  kind: "judgement";
  /** The question it answers (`judge/questions.ts`). */
  question: string;
  /** Always attention: an extra check only asks the user to look again. */
  level: "attention";
  /** Plain English, starting "casefile's extra check thinks…". */
  message: string;
  /** What it is about, e.g. a sentence, with names replaced. */
  text?: string;
  /** Where it applies, e.g. "D001:1-2". */
  where?: string;
  backend: JudgeBackendId;
}

/** A suggestion of a document's origin from a stamp in its text ("Produced under subpoena"). */
export interface OriginHint {
  origin: Origin;
  /** Why, in plain words. */
  reason: string;
  /** The line the stamp is on (1-based). */
  line: number;
}

/**
 * A shared document found to show a known name or number (e.g. after a nickname was added),
 * withdrawn at once, and what Claude read through casefile while it was visible.
 */
export interface Exposure {
  doc: string;
  /** Roles whose values were visible. */
  roles: string[];
  sharedAt: string;
  foundAt: string;
  withdrawnAt: string;
  resharedAt: string | null;
  /** Claude's reads of the document through casefile between sharedAt and withdrawnAt. */
  claudeReads: { ts: string; lines: string }[];
  /** Pending documents in which the same value was newly found. */
  newMatchesIn: string[];
}

/** A citation as stored (re-exported for modules that only need the vocabulary). */
export type { SourceRef };
