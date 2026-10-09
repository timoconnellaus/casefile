import type { EntityKind } from "../entities.ts";
import type { Detector, Span } from "./types.ts";
import { fold, unfold } from "../fold.ts";

/**
 * Australian identifier rules. Deterministic, offline, and checksum-validated where a
 * checksum exists (TFN, ABN, ACN, Medicare). Patterns never cross a line break, so a
 * replacement can never change a document's line numbering (ADR 0005).
 */

const SP = "[ \\t]"; // horizontal whitespace only
const digits = (s: string) => s.replace(/\D/g, "");

export function isValidTfn(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 9) return false;
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  const sum = [...d].reduce((acc, c, i) => acc + Number(c) * w[i], 0);
  return sum % 11 === 0;
}

export function isValidAbn(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 11) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const n = [...d].map(Number);
  n[0] -= 1;
  return n.reduce((acc, x, i) => acc + x * w[i], 0) % 89 === 0;
}

export function isValidAcn(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 9) return false;
  const w = [8, 7, 6, 5, 4, 3, 2, 1];
  const sum = [...d.slice(0, 8)].reduce((acc, c, i) => acc + Number(c) * w[i], 0);
  return (10 - (sum % 10)) % 10 === Number(d[8]);
}

export function isValidMedicare(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/[2-6]/.test(d[0])) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9];
  const sum = [...d.slice(0, 8)].reduce((acc, c, i) => acc + Number(c) * w[i], 0);
  return sum % 10 === Number(d[8]);
}

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
export const DATE =
  `(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?${SP}+(?:${MONTHS})${SP}*,?${SP}+\\d{4}|(?:${MONTHS})${SP}+\\d{1,2}(?:st|nd|rd|th)?,?${SP}+\\d{4})`;

const STREET_TYPES =
  "Street|St|Road|Rd|Avenue|Ave|Av|Crescent|Cres|Place|Pl|Drive|Dr|Court|Ct|Parade|Pde|Highway|Hwy|Lane|Ln|Way|Close|Cl|Boulevard|Blvd|Bvd|Terrace|Tce|Circuit|Cct|Grove|Gr|Esplanade|Esp|Square|Sq|Track|Trail|Rise|Row|Mews|Walk|Loop";
const STATES = "NSW|VIC|QLD|SA|WA|TAS|NT|ACT";

interface Rule {
  name: string;
  kind: EntityKind;
  re: RegExp;
  /** Capture group holding the identifying part (default: whole match). */
  group?: number;
  validate?: (s: string) => boolean;
  confidence: number;
  /**
   * Suggested role for a new entity found by this rule ("medicare_1"); the next free number is
   * used when it is taken. Without one, the kind's prefix is used ("id_1").
   */
  roleHint?: string;
}

const RULES: Rule[] = [
  {
    name: "email",
    kind: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    confidence: 0.99,
  },
  {
    name: "date_of_birth",
    kind: "date_of_birth",
    re: new RegExp(
      `(?:\\bborn(?:${SP}+on)?|\\bD\\.?O\\.?B\\.?|\\bdate${SP}+of${SP}+birth)[ \\t:,-]{0,6}(?:(?:is|was)${SP}+)?(${DATE})`,
      "gi",
    ),
    group: 1,
    confidence: 0.97,
  },
  {
    name: "medicare",
    kind: "identifier",
    re: new RegExp(`\\b[2-6]\\d{3}${SP}?\\d{5}${SP}?\\d(?:${SP}?-?${SP}?\\d)?\\b`, "g"),
    validate: isValidMedicare,
    confidence: 0.98,
    roleHint: "medicare_1",
  },
  {
    name: "tfn",
    kind: "identifier",
    re: new RegExp(`\\b\\d{3}${SP}?\\d{3}${SP}?\\d{3}\\b`, "g"),
    validate: isValidTfn,
    confidence: 0.9,
    roleHint: "tfn_1",
  },
  {
    name: "abn",
    kind: "identifier",
    re: new RegExp(`\\b\\d{2}${SP}?\\d{3}${SP}?\\d{3}${SP}?\\d{3}\\b`, "g"),
    validate: isValidAbn,
    confidence: 0.98,
    roleHint: "abn_1",
  },
  {
    name: "acn",
    kind: "identifier",
    re: new RegExp(`\\bACN${SP}*:?${SP}*(\\d{3}${SP}?\\d{3}${SP}?\\d{3})\\b`, "gi"),
    group: 1,
    validate: isValidAcn,
    confidence: 0.98,
  },
  {
    name: "phone_mobile",
    kind: "phone",
    re: new RegExp(`(?<![\\d+])(?:\\+?61${SP}?4|04)\\d{2}${SP}?\\d{3}${SP}?\\d{3}\\b`, "g"),
    confidence: 0.97,
  },
  {
    name: "phone_landline",
    kind: "phone",
    re: new RegExp(
      `(?<![\\d+])(?:\\(0[2378]\\)${SP}?|0[2378]${SP}?|\\+?61${SP}?[2378]${SP}?)\\d{4}${SP}?\\d{4}\\b`,
      "g",
    ),
    confidence: 0.95,
  },
  {
    name: "bsb",
    kind: "identifier",
    re: /\b\d{3}-\d{3}\b/g,
    confidence: 0.85,
  },
  {
    name: "account_number",
    kind: "identifier",
    re: new RegExp(
      `\\b(?:account|acct|a/c)(?:${SP}+(?:no\\.?|number|#))?${SP}*:?${SP}*(\\d[\\d ]{4,14}\\d)\\b`,
      "gi",
    ),
    group: 1,
    confidence: 0.9,
  },
  {
    name: "licence_or_passport",
    kind: "identifier",
    re: new RegExp(
      `\\b(?:licen[cs]e|passport|registration|rego|card)(?:${SP}+(?:no\\.?|number|#))?${SP}*:?${SP}*([A-Z0-9]*\\d[A-Z0-9]{4,11})\\b`,
      "gi",
    ),
    group: 1,
    confidence: 0.85,
  },
  {
    name: "court_file_number",
    kind: "identifier",
    re: /(?<![A-Za-z0-9])(?:\([A-Z]\))?[A-Z]{3}\d{3,6}\/\d{4}\b/g,
    confidence: 0.95,
    roleHint: "file_number",
  },
  {
    name: "street_address",
    kind: "address",
    re: new RegExp(
      `\\b(?:(?:Unit|Apt|Apartment|Flat|Lot)${SP}+\\d+[A-Za-z]?,?${SP}+)?(?:\\d+[A-Za-z]?/)?\\d+[A-Za-z]?(?:-\\d+)?${SP}+(?:[A-Z][a-zA-Z'-]+${SP}+){1,3}(?:${STREET_TYPES})\\b\\.?(?:,?${SP}+(?:[A-Z][a-zA-Z'-]+${SP}+){1,3}(?:${STATES})(?:${SP}+\\d{4})?)?`,
      "g",
    ),
    confidence: 0.93,
  },
  {
    name: "suburb_state_postcode",
    kind: "place",
    re: new RegExp(`\\b(?:[A-Z][a-zA-Z'-]+${SP}+){1,3}(?:${STATES})${SP}+\\d{4}\\b`, "g"),
    confidence: 0.92,
  },
  {
    // "@miaokafor09": a social-media handle. Handles are chosen by people, often from their names,
    // so every handle counts as an identifier (not only ones containing a known name).
    name: "social_handle",
    kind: "identifier",
    re:
      /(?<![A-Za-z0-9._%+@-])@(?=[A-Za-z0-9_.]*[A-Za-z])[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,29}[A-Za-z0-9_])?/g,
    confidence: 0.9,
  },
  {
    name: "social_profile_url",
    kind: "identifier",
    re:
      /\b(?:https?:\/\/)?(?:www\.)?(?:facebook|fb|instagram|twitter|x|tiktok|linkedin|snapchat)\.com\/[A-Za-z0-9._\-/]+/gi,
    confidence: 0.95,
  },
];

export function findRuleSpans(text: string): Span[] {
  const spans: Span[] = [];
  // Rules run on folded text (NFKC, so full-width digits and letters count; see fold.ts) and
  // their matches are mapped back to the original.
  const f = fold(text, { lower: false });
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of f.text.matchAll(rule.re)) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (!value) continue;
      const offsetInMatch = g === 0 ? 0 : m[0].indexOf(value);
      const trimmed = value.replace(/[.,]+$/, "");
      if (rule.validate && !rule.validate(trimmed)) continue;
      const { start, end } = unfold(
        f,
        m.index! + offsetInMatch,
        m.index! + offsetInMatch + trimmed.length,
      );
      spans.push({
        start,
        end,
        text: text.slice(start, end),
        kind: rule.kind,
        source: "rule",
        confidence: rule.confidence,
        label: rule.name,
        ...(rule.roleHint ? { roleHint: rule.roleHint } : {}),
      });
    }
  }
  // Where rules overlap (an address containing a suburb, a number valid as both ACN and TFN),
  // keep the longest match, then the most confident.
  const kept: Span[] = [];
  for (
    const sp of spans.sort((a, b) =>
      (b.end - b.start) - (a.end - a.start) || b.confidence - a.confidence
    )
  ) {
    if (!kept.some((k) => sp.start < k.end && k.start < sp.end)) kept.push(sp);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export class RuleDetector implements Detector {
  readonly name = "rules";
  detect(text: string): Promise<Span[]> {
    return Promise.resolve(findRuleSpans(text));
  }
}

// ── harmless shapes (ADR 25) ───────────────────────────────────────────────

// Every shape needs a digit, and each word must be exactly a month, unit or "am"/"pm": "Marcus",
// "June" or "Augustine" alone is a name, never a date (security review, ADR 25).
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const TIME =
  /^\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?$|^\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)$/i;
const DATE_ONLY = new RegExp(
  `^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?(?:\\s+\\d{4})?$` +
    `|^${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?$` +
    `|^${MONTH}\\.?\\s+\\d{4}$` +
    `|^\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{2}|\\d{4})$|^\\d{4}-\\d{2}-\\d{2}$`,
  "i",
);
const AMOUNT = /^(?:aud\s*)?\$\s?\d[\d,]*(?:\.\d{2})?$|^\d[\d,]*(?:\.\d{2})?\s*(?:dollars|aud)$/i;
const DURATION =
  /^\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?)$/i;

/** Kinds a harmless shape can apply to: never a name, contact detail, identifier or birth date. */
const SHAPE_KINDS: ReadonlySet<EntityKind> = new Set(["other", "place", "organisation"]);

/**
 * Why a value identifies no one by its shape alone (a time, a date…), or null. Model detections
 * of such values are dropped (pipeline.ts), and "Tidy up" suggests no longer replacing them.
 * Only for kinds `other`, `place` and `organisation`: a person, address, phone, email, identifier
 * or date of birth is identifying whatever it looks like.
 */
export function harmlessShape(value: string, kind: EntityKind): string | null {
  const v = value.replace(/\s+/g, " ").trim();
  if (!SHAPE_KINDS.has(kind) || !/\d/.test(v)) return null;
  if (TIME.test(v)) return "It is a time of day.";
  if (DATE_ONLY.test(v)) return "It is an ordinary date.";
  if (AMOUNT.test(v)) return "It is an amount of money.";
  if (DURATION.test(v)) return "It is a length of time.";
  return null;
}
