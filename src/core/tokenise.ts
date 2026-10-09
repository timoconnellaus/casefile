import type { EntityRegistry } from "./entities.ts";
import { normaliseVariant } from "./entities.ts";
import { findDobsAfterNames, findKnownSpans } from "./detect/pipeline.ts";
import { findRuleSpans } from "./detect/rules.ts";
import { type Form, formatToken, parseTokens } from "./tokens.ts";

export interface Replacement {
  start: number;
  end: number;
  role: string;
  form: Form;
}

/**
 * Replace spans of original text with tokens. Line breaks inside a span are kept after the token,
 * so line N of the tokenised text is always line N of the original (citations stay valid).
 */
export function applyTokens(text: string, replacements: Replacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos) throw new Error(`Overlapping replacements at ${r.start}`);
    if (r.end > text.length || r.end <= r.start) {
      throw new Error(`Bad replacement range ${r.start}-${r.end}`);
    }
    out += text.slice(pos, r.start);
    const newlines = text.slice(r.start, r.end).split("\n").length - 1;
    out += formatToken(r.role, r.form) + "\n".repeat(newlines);
    pos = r.end;
  }
  return out + text.slice(pos);
}

export interface Leak {
  start: number;
  end: number;
  text: string;
  reason: string;
}

/**
 * Last line of defence before anything is published (ADR 0006): the tokenised text must not
 * contain any known entity value, or anything the identifier rules recognise.
 */
export function findLeaks(
  tokenised: string,
  registry: EntityRegistry,
  ignore: Iterable<string> = [],
): Leak[] {
  const ignored = new Set([...ignore].map(normaliseVariant));
  const tokenRanges = parseTokens(tokenised).tokens;
  const insideToken = (s: number, e: number) => tokenRanges.some((t) => s < t.end && t.start < e);
  const leaks: Leak[] = [];
  const known = findKnownSpans(tokenised, registry, { leak: true });
  for (const s of known) {
    if (insideToken(s.start, s.end) || ignored.has(normaliseVariant(s.text))) continue;
    leaks.push({
      start: s.start,
      end: s.end,
      text: s.text,
      reason: `matches known value of ${s.label}`,
    });
  }
  const dobs = findDobsAfterNames(
    tokenised,
    registry,
    known.filter((s) => s.kind === "person").map((s) => s.end),
  );
  for (const s of [...findRuleSpans(tokenised), ...dobs]) {
    if (insideToken(s.start, s.end) || ignored.has(normaliseVariant(s.text))) continue;
    leaks.push({ start: s.start, end: s.end, text: s.text, reason: `looks like ${s.label}` });
  }
  // One leak per stretch of text: "O'Brien" inside "Siobhan O'Brien", or a surname shared by
  // two people, is reported once (the longest match).
  const sorted = leaks.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  return sorted.filter((l, i) =>
    !sorted.slice(0, i).some((k) => k.start <= l.start && l.end <= k.end)
  );
}

export interface KnownMatch {
  start: number;
  end: number;
  text: string;
  /** Every entity the text could be: one for a match `tokeniseKnown` replaces, more if ambiguous. */
  candidates: { role: string; form: Form }[];
}

/**
 * The known values in `text` exactly as `tokeniseKnown` sees them: longest match first, no
 * overlaps, each with the entities it could be. Anything that tokenises user text, and anything
 * that must predict what tokenising would reveal (the probe guard in `tokeniseUserText`), uses this
 * one function, so the two can never disagree about case, Unicode forms or spacing.
 */
export function knownMatches(text: string, registry: EntityRegistry): KnownMatch[] {
  const spans = findKnownSpans(text, registry).sort((a, b) =>
    a.start - b.start || (b.end - b.start) - (a.end - a.start)
  );
  const out: KnownMatch[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    const c = registry.candidates(s.text);
    if (!c.length) continue;
    out.push({
      start: s.start,
      end: s.end,
      text: s.text,
      candidates: c.map((m) => ({ role: m.entity.role, form: m.form })),
    });
    pos = s.end;
  }
  return out;
}

/** Convenience for text the user types in the app: tokenise every unambiguous known value. */
export function tokeniseKnown(
  text: string,
  registry: EntityRegistry,
): { text: string; ambiguous: { text: string; roles: string[] }[] } {
  const reps: Replacement[] = [];
  const ambiguous: { text: string; roles: string[] }[] = [];
  for (const m of knownMatches(text, registry)) {
    if (m.candidates.length === 1) {
      reps.push({ start: m.start, end: m.end, ...m.candidates[0] });
    } else ambiguous.push({ text: m.text, roles: m.candidates.map((c) => c.role) });
  }
  return { text: applyTokens(text, reps), ambiguous };
}
