import type { ClaudeSetup } from "./session.ts";
import type { Origin } from "./publicdb.ts";
import type { OriginHint } from "./states.ts";

/**
 * Where documents came from (ADR 7): whether a document's text may be shared with Claude, and
 * suggestions from stamps in its text.
 */

/**
 * Why a document of this origin is withheld from Claude, or null if it may be shared (ADR 7, as
 * amended for v2):
 *
 * - not asked yet (`null`): always withheld ("not_asked");
 * - `under_order` and `not_sure`: always withheld, on any plan;
 * - consumer plan: anything but `mine` is withheld;
 * - commercial plan: `other_side` and `court_or_subpoena` stay withheld until the user shares that
 *   one document explicitly (`released`). Switching plan never shares anything by itself.
 */
export function withheldReason(
  origin: Origin | null,
  setup: ClaudeSetup,
  released: boolean,
): "origin" | "not_asked" | null {
  // Whitelist, so a missing or unknown value (a corrupt vault file) is withheld, never shared.
  if (origin === null || origin === undefined) return "not_asked";
  if (origin === "mine") return null;
  if (!shareableOnCommercial(origin)) return "origin";
  return setup === "commercial" && released === true ? null : "origin";
}

/** Whether a document of this origin could be shared on a commercial plan (one at a time). */
export function shareableOnCommercial(origin: Origin | null): boolean {
  return origin === "other_side" || origin === "court_or_subpoena";
}

/** How many lines from the top of a document are searched for a stamp. */
export const HINT_LINES = 15;

/** Stamps, strongest first. Each names the origin it suggests and why, in plain words. */
const STAMPS: { re: RegExp; origin: Origin; reason: string }[] = [
  {
    re:
      /\bproduced\s+(?:under|pursuant\s+to|in\s+(?:answer|response)\s+to)\s+(?:a\s+|the\s+)?subpoena\b/i,
    origin: "court_or_subpoena",
    reason: 'It says "produced under subpoena".',
  },
  {
    re: /\b(?:suppression|non-publication)\s+order\b/i,
    origin: "under_order",
    reason: "It mentions a suppression or non-publication order.",
  },
  {
    re: /\bsubpoena(?:ed|s)?\b/i,
    origin: "court_or_subpoena",
    reason: "It mentions a subpoena.",
  },
  {
    re: /\b(?:discovery|disclosure)\b/i,
    origin: "other_side",
    reason: "It mentions discovery or disclosure, so it may have come from the other side.",
  },
];

/**
 * A suggested origin from a stamp near the top of a document ("Produced under subpoena"), or null.
 * Only a suggestion: the user always answers "Where did you get this document?" themselves.
 * Runs on the original (app side only); the hint holds no text from the document.
 */
export function originHints(text: string): OriginHint | null {
  const lines = text.split("\n").slice(0, HINT_LINES);
  for (const stamp of STAMPS) {
    const i = lines.findIndex((l) => stamp.re.test(l));
    if (i !== -1) return { origin: stamp.origin, reason: stamp.reason, line: i + 1 };
  }
  return null;
}
