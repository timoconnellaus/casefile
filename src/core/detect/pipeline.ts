import type { EntityKind, EntityRegistry } from "../entities.ts";
import { normaliseVariant, splitPersonName } from "../entities.ts";
import type { Form } from "../tokens.ts";
import { fold, type Folded, foldValue, unfold } from "../fold.ts";
import { DATE, findRuleSpans, harmlessShape } from "./rules.ts";
import { parseTokens } from "../tokens.ts";
import { type Detector, sourceRank, type Span } from "./types.ts";

/**
 * Detection pipeline (ADR 0006): rules → known entities → optional NER → optional LLM, then
 * name parts of any newly found person ("Daniel", "Okafor", "Mr Okafor").
 *
 * Results are merged into non-overlapping spans, and each span gets a proposal:
 *   existing   — an entity already in the registry
 *   new        — an entity to create (spans of the same new entity share a `key`)
 *   ambiguous  — several possibilities (e.g. a surname shared by a parent and a child);
 *                the user must choose before the document can be published.
 */

export interface Option {
  /** An existing role, or the key of a new entity. */
  ref: string;
  form: Form;
  isNew: boolean;
}

export type Proposal =
  | { type: "existing"; role: string; form: Form }
  | { type: "new"; key: string; kind: EntityKind; full: string; roleHint?: string; form: Form }
  | { type: "ambiguous"; options: Option[] };

export interface ProposedSpan extends Span {
  id: string;
  proposal: Proposal;
}

export interface NewEntityProposal {
  key: string;
  kind: EntityKind;
  full: string;
  roleHint?: string;
  first?: string;
  surname?: string;
}

export interface DetectOptions {
  registry: EntityRegistry;
  detectors?: Detector[];
  /** Strings the user has marked as not identifying (compared case-insensitively). */
  ignore?: Iterable<string>;
}

export interface DetectResult {
  spans: ProposedSpan[];
  /** New entities referred to by `new` and `ambiguous` proposals. */
  newEntities: NewEntityProposal[];
  /** Detectors that failed; their absence is reported to the user, not hidden. */
  errors: { detector: string; message: string }[];
}

const WORD = /[\p{L}\p{N}]/u;
const TITLES = "Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Master";

const isWord = (ch: string | undefined) => ch !== undefined && WORD.test(ch);

/**
 * Whole-word test in folded text. A plural or possessive plural ("the Okafors", "Okafors'") still
 * counts as the word: a trailing "s" followed by a non-word character is allowed.
 */
function isWordBoundary(text: string, start: number, end: number): boolean {
  if (isWord(text[start - 1])) return false;
  if (!isWord(text[end])) return true;
  return (text[end] === "s" || text[end] === "S") && !isWord(text[end + 1]);
}

/**
 * Original-text ranges of every whole-word occurrence of `needle`, matched on folded text (NFKC,
 * apostrophes, whitespace runs, and case unless `caseSensitive`; see fold.ts).
 */
function findAll(
  text: string | Folded,
  needle: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  const hay = typeof text === "string" ? fold(text, { lower: !caseSensitive }) : text;
  const n = fold(needle, { lower: !caseSensitive }).text.trim();
  if (!n) return [];
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while ((i = hay.text.indexOf(n, i)) !== -1) {
    if (isWordBoundary(hay.text, i, i + n.length)) out.push(unfold(hay, i, i + n.length));
    i += n.length;
  }
  return out;
}

/**
 * Find every occurrence of every known entity variant (case-insensitive, whole words, plurals,
 * folded as in fold.ts). The leak check, tokenising user text and the probe guard all use this.
 */
export function findKnownSpans(
  text: string,
  registry: EntityRegistry,
  opts: { leak?: boolean } = {},
): Span[] {
  const spans: Span[] = [];
  const lower = fold(text, { lower: true });
  for (const v of registry.variants({ leak: opts.leak })) {
    if (v.text.includes("\n")) continue;
    for (const r of findAll(lower, v.text, false)) {
      spans.push({
        ...r,
        text: text.slice(r.start, r.end),
        kind: v.entity.kind,
        source: "known",
        confidence: 1,
        label: v.leakOnly ? `${v.entity.role}.part` : `${v.entity.role}.${v.form}`,
      });
    }
  }
  // Titles of known people, e.g. "Mr Okafor", even if that exact form was never seen.
  for (const e of registry.list()) {
    if (e.kind !== "person" || !e.forms.surname) continue;
    const surname = escapeRe(foldValue(e.forms.surname));
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${TITLES})\\.? ${surname}(?:s)?(?![\\p{L}\\p{N}])`,
      "giu",
    );
    for (const m of lower.text.matchAll(re)) {
      const len = m[0].endsWith("s") && !surname.endsWith("s") ? m[0].length - 1 : m[0].length;
      const r = unfold(lower, m.index!, m.index! + len);
      spans.push({
        ...r,
        text: text.slice(r.start, r.end),
        kind: "person",
        source: "known",
        confidence: 1,
        label: `${e.role}.title`,
      });
    }
  }
  return spans;
}

const DOB_AFTER_NAME = new RegExp(`^[ \\t]*(?:\\(|,)[ \\t]*(${DATE})(?![\\d/.-])`);

/**
 * A date written straight after a person's name — "Mia (3/3/2017)", "Mia, 3/3/2017," — is very
 * likely their date of birth (dates are otherwise kept, ADR 6). `nameEnds` are offsets where a
 * person's name ends; person tokens (`{{child_1}}`) in tokenised text count as names too.
 */
export function findDobsAfterNames(
  text: string,
  registry: EntityRegistry,
  nameEnds: number[],
): Span[] {
  const ends = new Set(nameEnds);
  for (const t of parseTokens(text).tokens) {
    if (registry.get(t.role)?.kind === "person") ends.add(t.end);
  }
  const out: Span[] = [];
  for (const end of ends) {
    const m = DOB_AFTER_NAME.exec(text.slice(end, end + 40));
    if (!m) continue;
    const start = end + m[0].length - m[1].length;
    out.push({
      start,
      end: start + m[1].length,
      text: m[1],
      kind: "date_of_birth",
      source: "rule",
      confidence: 0.8,
      label: "date_after_name",
    });
  }
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Trim whitespace and stray punctuation; split at line breaks so a span never spans lines. */
export function normaliseSpan(text: string, s: Span): Span[] {
  let { start, end } = s;
  while (start < end && /[\s("'‘“]/.test(text[start])) start++;
  while (end > start && /[\s.,;:!?)"'’”]/.test(text[end - 1])) end--;
  // Keep a trailing full stop that belongs to an abbreviation like "St." only if inside the span.
  if (end <= start) return [];
  const pieces: Span[] = [];
  let pieceStart = start;
  for (let i = start; i <= end; i++) {
    if (i === end || text[i] === "\n") {
      let a = pieceStart;
      let b = i;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) pieces.push({ ...s, start: a, end: b, text: text.slice(a, b) });
      pieceStart = i + 1;
    }
  }
  return pieces;
}

/**
 * Resolve overlaps. Stronger source wins (manual > rule > known > llm > ner), then the longer
 * span, then higher confidence.
 */
export function mergeSpans(spans: Span[]): Span[] {
  const ordered = [...spans].sort((a, b) =>
    sourceRank(a.source) - sourceRank(b.source) ||
    (b.end - b.start) - (a.end - a.start) ||
    b.confidence - a.confidence ||
    a.start - b.start
  );
  const kept: Span[] = [];
  for (const s of ordered) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Courts, tribunals, agencies and document headings. Naming them identifies no one, so model
 * detections of exactly these are dropped. Rules (phone numbers, addresses…) are unaffected.
 */
const GENERIC_INSTITUTIONS = new RegExp(
  "^(?:the\\s+)?(?:" + [
    "affidavit",
    "orders?",
    "notice",
    "subpoena",
    "annexure(?:\\s+\\w+)?",
    "exhibit(?:\\s+\\w+)?",
    "australia",
    "commonwealth(?:\\s+of\\s+australia)?",
    "new south wales|victoria|queensland|south australia|western australia|tasmania|northern territory|australian capital territory",
    "nsw|vic|qld|sa|wa|tas|nt|act",
    "federal circuit(?:\\s+and\\s+family)?\\s+court(?:\\s+of\\s+australia)?(?:\\s*\\(division\\s+[12]\\))?",
    "federal circuit",
    "family court(?:\\s+of\\s+(?:australia|western australia))?",
    "high court(?:\\s+of\\s+australia)?",
    "federal court(?:\\s+of\\s+australia)?",
    "local court|district court|supreme court|children'?s court|magistrates'? court",
    "court",
    "abn|acn|tfn|bsb|crn",
    "medicare|centrelink|services australia|child support(?:\\s+agency)?|australian taxation office|ato",
    "department of communities and justice|dcj|police|nsw police(?:\\s+force)?",
    "family law act|family law act 1975",
  ].join("|") + ")$",
  "i",
);

export function isGenericInstitution(text: string): boolean {
  return GENERIC_INSTITUTIONS.test(text.replace(/\s+/g, " ").trim());
}

function newKey(kind: EntityKind, full: string) {
  return `new:${kind}:${normaliseVariant(full)}`;
}

export async function detect(text: string, opts: DetectOptions): Promise<DetectResult> {
  const ignore = new Set([...(opts.ignore ?? [])].map(normaliseVariant));
  const errors: DetectResult["errors"] = [];
  const raw: Span[] = [
    ...findRuleSpans(text),
    // Leak-only parts (middle names, suburbs…) are flagged for review as well.
    ...findKnownSpans(text, opts.registry, { leak: true }),
  ];
  for (const d of opts.detectors ?? []) {
    try {
      raw.push(...await d.detect(text));
    } catch (e) {
      errors.push({ detector: d.name, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const keep = (s: Span) =>
    !ignore.has(normaliseVariant(s.text)) &&
    // Models flag courts, agencies and headings as organisations; they identify no one. Only
    // non-person spans are dropped: a person may well be called "Court" or "West".
    !((s.source === "ner" || s.source === "llm") && s.kind !== "person" &&
      isGenericInstitution(s.text)) &&
    // Models also flag times, dates and amounts ("5:01 PM"); they identify no one (ADR 25).
    !((s.source === "ner" || s.source === "llm") && harmlessShape(s.text, s.kind));
  const merged = mergeSpans(raw.flatMap((s) => normaliseSpan(text, s)).filter(keep));

  // New entities: anything found by a model (or rule) that the registry does not know.
  const news = new Map<string, NewEntityProposal>();
  for (const s of merged) {
    if (s.source === "known" || opts.registry.candidates(s.text).length) continue;
    const key = newKey(s.kind, s.text);
    const existing = news.get(key);
    if (existing) {
      existing.roleHint ??= s.roleHint;
      continue;
    }
    const ne: NewEntityProposal = { key, kind: s.kind, full: s.text, roleHint: s.roleHint };
    if (s.kind === "person") Object.assign(ne, splitPersonName(s.text));
    news.set(key, ne);
  }
  // A lone first name or surname that a model reported separately ("Mia") is a name part of a new
  // person found in full ("Mia Okafor"), not a different person.
  for (const [key, ne] of news) {
    if (ne.kind !== "person" || /\s/.test(ne.full.trim())) continue;
    const n = normaliseVariant(ne.full);
    const owner = [...news.values()].some((o) =>
      o !== ne && o.kind === "person" &&
      (normaliseVariant(o.first ?? "") === n || normaliseVariant(o.surname ?? "") === n)
    );
    if (owner) news.delete(key);
  }

  // Search the whole document for every new value, and for the name parts of new people.
  const extra: Span[] = [];
  for (const ne of news.values()) {
    for (const r of findAll(text, ne.full, false)) {
      extra.push({
        ...r,
        text: text.slice(r.start, r.end),
        kind: ne.kind,
        source: "ner",
        confidence: 0.9,
        label: "repeat",
      });
    }
    if (ne.kind !== "person") continue;
    for (const part of [ne.first, ne.surname]) {
      if (!part || part.length < 2) continue;
      // Name parts are matched case-sensitively, so "Rose" the person is not "rose" the flower.
      for (const r of findAll(text, part, true)) {
        extra.push({
          ...r,
          text: text.slice(r.start, r.end),
          kind: "person",
          source: "ner",
          confidence: 0.8,
          label: "name part",
        });
      }
    }
    if (ne.surname) {
      const re = new RegExp(`\\b(?:${TITLES})\\.?[ \\t]+${escapeRe(ne.surname)}\\b`, "g");
      for (const m of text.matchAll(re)) {
        extra.push({
          start: m.index!,
          end: m.index! + m[0].length,
          text: m[0],
          kind: "person",
          source: "ner",
          confidence: 0.85,
          label: "title",
        });
      }
    }
  }
  const withNames = mergeSpans([
    ...merged,
    ...extra.flatMap((s) => normaliseSpan(text, s)).filter(keep),
  ]);
  const final = mergeSpans([
    ...withNames,
    ...findDobsAfterNames(
      text,
      opts.registry,
      withNames.filter((s) => s.kind === "person").map((s) => s.end),
    ).filter(keep),
  ]);

  const spans: ProposedSpan[] = final.map((s, i) => ({
    ...s,
    id: `s${i + 1}`,
    proposal: propose(s, opts.registry, news),
  }));
  const usedKeys = new Set<string>();
  for (const s of spans) {
    if (s.proposal.type === "new") usedKeys.add(s.proposal.key);
    if (s.proposal.type === "ambiguous") {
      for (const o of s.proposal.options) if (o.isNew) usedKeys.add(o.ref);
    }
  }
  return { spans, newEntities: [...news.values()].filter((n) => usedKeys.has(n.key)), errors };
}

const TITLE_RE = new RegExp(`^(?:${TITLES})\\.?\\s+(\\S.*)$`, "i");

function propose(
  s: Span,
  registry: EntityRegistry,
  news: Map<string, NewEntityProposal>,
): Proposal {
  const options: Option[] = registry.candidates(s.text).map((c) => ({
    ref: c.entity.role,
    form: c.form,
    isNew: false,
  }));
  const n = normaliseVariant(s.text);
  const title = TITLE_RE.exec(s.text);
  for (const ne of news.values()) {
    if (normaliseVariant(ne.full) === n && ne.kind === s.kind) {
      options.push({ ref: ne.key, form: "full", isNew: true });
    } else if (ne.kind === "person" && s.kind === "person") {
      if (ne.first && ne.first === s.text) {
        options.push({ ref: ne.key, form: "first", isNew: true });
      } else if (ne.surname && ne.surname === s.text) {
        options.push({ ref: ne.key, form: "surname", isNew: true });
      } else if (
        ne.surname && title && normaliseVariant(title[1]) === normaliseVariant(ne.surname)
      ) {
        options.push({ ref: ne.key, form: "title", isNew: true });
      }
    }
  }
  // A span the registry knows exactly is not also offered as a new entity.
  const unique = options.filter((o, i) =>
    options.findIndex((p) => p.ref === o.ref && p.form === o.form) === i
  );
  if (unique.length === 1) {
    const o = unique[0];
    if (!o.isNew) return { type: "existing", role: o.ref, form: o.form };
    const ne = news.get(o.ref)!;
    return {
      type: "new",
      key: ne.key,
      kind: ne.kind,
      full: ne.full,
      roleHint: ne.roleHint,
      form: o.form,
    };
  }
  if (unique.length > 1) return { type: "ambiguous", options: unique };
  // Nothing matched (e.g. a known-variant span whose entity was since removed): treat as new.
  const key = newKey(s.kind, s.text);
  if (!news.has(key)) news.set(key, { key, kind: s.kind, full: s.text, roleHint: s.roleHint });
  return { type: "new", key, kind: s.kind, full: s.text, roleHint: s.roleHint, form: "full" };
}
