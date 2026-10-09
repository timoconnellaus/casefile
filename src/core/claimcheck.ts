import type { EntityKind } from "./kinds.ts";
import type { SourceRef } from "./publicdb.ts";
import type { CheckRow } from "./states.ts";
import { parseTokens } from "./tokens.ts";

/**
 * Deterministic checks of a claim (a chronology entry, an evidence note, a draft sentence) against
 * the lines it cites: entity tokens, dates, numbers, feeling words, placeholders, citations (ADR 8,
 * "Checking against the source"). Pure functions over tokenised text: no I/O, no clock, no
 * randomness, so the same input always gives the same rows in the same order.
 *
 * Messages keep the claim's tokens (e.g. "{{child_2.first}} is not in D001:1–2"); the app
 * re-identifies them for the user. Nothing here ever sees a real name.
 */

/** Cited lines, tokenised, for one citation. `lines` is empty when they cannot be quoted. */
export interface CitedLines {
  ref: SourceRef;
  lines: { line: number; text: string }[];
}

/** Verification refused: casefile cannot check this item (ADR 8). Mapped to HTTP 409. */
export class CantCheckError extends Error {
  constructor(readonly checks: CheckRow[]) {
    super(
      "casefile can't check this against its sources, so it can't be marked as checked. " +
        "Ask Claude to correct it, or remove it.",
    );
    this.name = "CantCheckError";
  }
}

/** The row for an item that must cite a source and cites none (e.g. a chronology entry). */
export function missingCitation(): CheckRow {
  return {
    kind: "citation",
    text: "",
    ok: false,
    level: "danger",
    message: "No source is cited.",
  };
}

/**
 * Whether these rows make an item "Can't check": an entity that is unknown or not in the cited
 * lines, or a citation that is missing or cannot be quoted.
 */
export function cantCheck(rows: CheckRow[]): boolean {
  return rows.some((r) => (r.kind === "entity" || r.kind === "citation") && r.ok !== true);
}

/**
 * What a chronology entry claims: its description, preceded by its date when the date names a
 * month or a day (a bare year is too coarse to check).
 */
export function chronologyClaim(r: { event_date: string; description: string }): string {
  return /^\d{4}-\d{2}/.test(r.event_date) ? `${r.event_date} ${r.description}` : r.description;
}

// ── references ─────────────────────────────────────────────────────────────

/** "D001:1–2" (en dash) for messages. */
function refText(r: SourceRef): string {
  return r.line_start === r.line_end
    ? `${r.doc_id}:${r.line_start}`
    : `${r.doc_id}:${r.line_start}–${r.line_end}`;
}

/** "D001:1-2" for `where` (the store's own format). */
function refWhere(r: SourceRef): string {
  return r.line_start === r.line_end
    ? `${r.doc_id}:${r.line_start}`
    : `${r.doc_id}:${r.line_start}-${r.line_end}`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

// ── dates ──────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
const ORD = "(?:st|nd|rd|th)?";

/** A date as written: the year or the day may be missing, never the month. */
interface DateVal {
  y?: number;
  m: number;
  d?: number;
}

function validDate(v: DateVal): boolean {
  return v.m >= 1 && v.m <= 12 && (v.d === undefined || (v.d >= 1 && v.d <= 31)) &&
    (v.y === undefined || (v.y >= 1900 && v.y <= 2199));
}

function year(s: string): number {
  return s.length === 2 ? 2000 + Number(s) : Number(s);
}

/** Date patterns, most specific first. Each match is blanked out before the next pattern runs. */
const DATE_PATTERNS: [RegExp, (m: RegExpExecArray) => DateVal][] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => ({ y: +m[1], m: +m[2], d: +m[3] })],
  [
    /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/g,
    (m) => ({ y: year(m[3]), m: +m[2], d: +m[1] }),
  ],
  [
    new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"),
    (m) => ({ y: +m[3], m: MONTHS[m[2].toLowerCase()], d: +m[1] }),
  ],
  [
    new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})${ORD},?\\s+(\\d{4})\\b`, "gi"),
    (m) => ({ y: +m[3], m: MONTHS[m[1].toLowerCase()], d: +m[2] }),
  ],
  [/\b(\d{4})-(\d{2})\b(?!-)/g, (m) => ({ y: +m[1], m: +m[2] })],
  [
    new RegExp(`\\b${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"),
    (m) => ({ y: +m[2], m: MONTHS[m[1].toLowerCase()] }),
  ],
  [
    new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH_RE}\\b`, "gi"),
    (m) => ({ m: MONTHS[m[2].toLowerCase()], d: +m[1] }),
  ],
  [
    new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})${ORD}\\b(?![:.]\\d)`, "gi"),
    (m) => ({ m: MONTHS[m[1].toLowerCase()], d: +m[2] }),
  ],
];

/** Dates in `text`, and the text with them blanked out (so their digits are not numbers). */
function extractDates(text: string): { dates: DateVal[]; rest: string } {
  const found: { at: number; v: DateVal }[] = [];
  let rest = text;
  for (const [re, make] of DATE_PATTERNS) {
    re.lastIndex = 0;
    const hits: { start: number; end: number; v: DateVal }[] = [];
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      const v = make(m);
      if (validDate(v)) hits.push({ start: m.index, end: m.index + m[0].length, v });
    }
    for (const h of hits) {
      found.push({ at: h.start, v: h.v });
      rest = blank(rest, h.start, h.end);
    }
  }
  found.sort((a, b) => a.at - b.at);
  return { dates: found.map((f) => f.v), rest };
}

function dateKey(v: DateVal): string {
  return `${v.y ?? "?"}-${v.m}-${v.d ?? "?"}`;
}

function dateText(v: DateVal): string {
  return [v.d, MONTH_NAMES[v.m - 1], v.y].filter((x) => x !== undefined).join(" ");
}

/** A claimed date is in a source if the parts both give agree, and a claimed day is there. */
function dateMatches(claim: DateVal, src: DateVal): boolean {
  if (claim.m !== src.m) return false;
  if (claim.y !== undefined && src.y !== undefined && claim.y !== src.y) return false;
  if (claim.d !== undefined && claim.d !== src.d) return false;
  return true;
}

// ── numbers ────────────────────────────────────────────────────────────────

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};

/** Unit spellings → a canonical unit and, for durations, how many of the base unit. */
const UNITS: [RegExp, string, number?][] = [
  [/^(?:minutes?|mins?)$/i, "minutes", 1],
  [/^(?:hours?|hrs?)$/i, "minutes", 60],
  [/^days?$/i, "days", 1],
  [/^(?:weeks?|wks?)$/i, "days", 7],
  [/^fortnights?$/i, "days", 14],
  [/^months?$/i, "months", 1],
  [/^(?:years?|yrs?)$/i, "months", 12],
  [/^times$/i, "times"],
  [/^(?:km|kilometres?|kilometers?)$/i, "km"],
  [/^(?:metres?|meters?)$/i, "m"],
  [/^dollars?$/i, "$"],
  [/^(?:%|percent|per cent)$/i, "%"],
  [/^(?:kg|kilograms?)$/i, "kg"],
  [/^nights?$/i, "nights"],
];
const UNIT_WORDS =
  "(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|fortnights?|months?|years?|yrs?|times|km|kilometres?|kilometers?|metres?|meters?|dollars?|percent|per cent|%|kg|kilograms?|nights?)";

interface NumVal {
  /** As written, for the message. */
  text: string;
  value: number;
  /** Canonical unit; "" for a bare number; "time" for a clock time (minutes after midnight). */
  unit: string;
}

function canonUnit(word: string | undefined, value: number): { unit: string; value: number } {
  if (!word) return { unit: "", value };
  for (const [re, unit, factor] of UNITS) {
    if (re.test(word.trim())) return { unit, value: factor ? value * factor : value };
  }
  return { unit: "", value };
}

function clock(h: number, min: number, ampm: string | undefined): number | null {
  if (min > 59) return null;
  let hh = h;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    hh = h % 12 + (ampm.toLowerCase().startsWith("p") ? 12 : 0);
  } else if (h > 23) return null;
  return hh * 60 + min;
}

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])|\b(\d{1,2}):(\d{2})\b/gi;
const NUM_RE = new RegExp(
  `(?<![\\w.,:/$-])(\\$)?(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)(?:\\s*${UNIT_WORDS})?(?![\\w%])`,
  "gi",
);
const WORD_NUM_RE = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join("|")})\\s+${UNIT_WORDS}\\b`,
  "gi",
);

/** Numbers (with units) and clock times in `text`, which has had its dates blanked out. */
function extractNumbers(text: string): NumVal[] {
  const out: { at: number; v: NumVal }[] = [];
  for (const m of text.matchAll(TIME_RE)) {
    const v = m[3] !== undefined
      ? clock(+m[1], m[2] ? +m[2] : 0, m[3])
      : clock(+m[4], +m[5], undefined);
    if (v !== null) out.push({ at: m.index!, v: { text: m[0].trim(), value: v, unit: "time" } });
  }
  const rest = text.replace(TIME_RE, (s) => " ".repeat(s.length));
  for (const m of rest.matchAll(NUM_RE)) {
    const raw = Number(m[2].replaceAll(",", ""));
    const u = m[1] ? { unit: "$", value: raw } : canonUnit(m[3], raw);
    out.push({ at: m.index!, v: { text: m[0].trim(), value: u.value, unit: u.unit } });
  }
  for (const m of rest.matchAll(WORD_NUM_RE)) {
    const u = canonUnit(m[2], WORD_NUMBERS[m[1].toLowerCase()]);
    out.push({ at: m.index!, v: { text: m[0].trim(), value: u.value, unit: u.unit } });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map((o) => o.v);
}

/** A claimed number is in a source with the same value and unit (or no unit on either side). */
function numberMatches(claim: NumVal, src: NumVal): boolean {
  if (claim.value !== src.value) return false;
  if (claim.unit === "time" || src.unit === "time") return claim.unit === src.unit;
  return claim.unit === src.unit || src.unit === "" || claim.unit === "";
}

// ── feelings and placeholders ──────────────────────────────────────────────

/** Words that describe a feeling or opinion: casefile cannot check them, only point them out. */
const FEELINGS = [
  "afraid",
  "angry",
  "annoyed",
  "anxious",
  "ashamed",
  "devastated",
  "distraught",
  "distressed",
  "embarrassed",
  "frightened",
  "furious",
  "happy",
  "heartbroken",
  "humiliated",
  "hurt",
  "intimidated",
  "nervous",
  "panicked",
  "sad",
  "scared",
  "shocked",
  "terrified",
  "threatened",
  "traumatised",
  "traumatized",
  "unhappy",
  "unsafe",
  "upset",
  "worried",
  "felt",
  "feel",
  "feels",
  "feeling",
];
const FEELING_RE = new RegExp(`\\b(${FEELINGS.join("|")})\\b`, "gi");

const PLACEHOLDER_RE =
  /\[(?:in your own words|insert|tbc|tbd|todo|xx+|\.\.\.|…)[^\]]*\]|\b(?:TODO|TBC|TBD)\b|\?\?\?+|\bX{2,}\b/gi;

// ── entities ───────────────────────────────────────────────────────────────

/** "child_2" → "child": roles that differ only by their number are one family. */
function family(role: string): string {
  return role.replace(/_\d+$/, "");
}

function rolesIn(text: string): Set<string> {
  return new Set(parseTokens(text).tokens.map((t) => t.role));
}

/** The text with tokens blanked out (so labels are not read as numbers or words). */
function withoutTokens(text: string): string {
  let out = text;
  for (const t of parseTokens(text).tokens.reverse()) out = blank(out, t.start, t.end);
  return out;
}

function tokenFor(role: string, form: string): string {
  return form === "full" ? `{{${role}}}` : `{{${role}.${form}}}`;
}

// ── checkClaim ─────────────────────────────────────────────────────────────

/**
 * Check a tokenised claim against its cited lines. `kinds` maps each role to its entity kind (to
 * tell a swap of two children from an unrelated name). Returns one row per thing checked, in a
 * fixed order: citations, entities, dates, numbers, feelings, placeholders.
 *
 * Entities (by role, whatever the form): found in the cited lines: ✓. Found, but missing from a
 * citation that names others of its kind from the claim (it may describe the same moment without
 * them): ▲, still found. Found nowhere: ▲ not found, and if a role of the same kind the claim does
 * not name is there instead (the same family first, e.g. child_1 / child_2) it may have been mixed
 * up. A role casefile does not know: ▲, cannot be checked. Not found or unknown entities, and
 * missing or unquotable citations, make the item "Can't check" (`cantCheck`).
 */
export function checkClaim(
  claimTokenised: string,
  cited: CitedLines[],
  kinds: Map<string, EntityKind>,
): CheckRow[] {
  const rows: CheckRow[] = [];
  const quotable = cited.filter((c) => c.lines.length > 0);
  const srcText = new Map(quotable.map((c) => [c, c.lines.map((l) => l.text).join("\n")]));
  const refs = (cs: CitedLines[]) => joinAnd(cs.map((c) => refText(c.ref)));
  const wheres = (cs: CitedLines[]) => cs.map((c) => refWhere(c.ref)).join(", ");

  // Citations. With none at all, only unknown labels and placeholders can be checked; whether
  // a citation is required is the caller's rule (`missingCitation`).
  for (const c of cited) {
    if (c.lines.length) continue;
    rows.push({
      kind: "citation",
      text: refText(c.ref),
      ok: false,
      level: "danger",
      where: refWhere(c.ref),
      message: `${
        refText(c.ref)
      } can't be quoted: it is not a shared document, or not those lines.`,
    });
  }

  // Entities, once per role, in order of first mention.
  const claimTokens = parseTokens(claimTokenised).tokens;
  const claimRoles = new Set(claimTokens.map((t) => t.role));
  const srcRoles = new Map(quotable.map((c) => [c, rolesIn(srcText.get(c)!)]));
  const seen = new Set<string>();
  for (const tok of claimTokens) {
    if (seen.has(tok.role)) continue;
    seen.add(tok.role);
    const kind = kinds.get(tok.role);
    if (!kind) {
      rows.push({
        kind: "entity",
        text: tok.raw,
        ok: null,
        level: "danger",
        message: `${tok.raw} is a label casefile doesn't know, so it can't be checked.`,
      });
      continue;
    }
    if (quotable.length === 0) continue; // nothing to look in (the citation rows say why)
    const inSrc = quotable.filter((c) => srcRoles.get(c)!.has(tok.role));
    if (inSrc.length === 0) {
      // Someone else of the same kind, not named in the claim, in the cited lines instead?
      const others = new Set<string>();
      for (const c of quotable) {
        for (const r of srcRoles.get(c)!) {
          if (!claimRoles.has(r) && kinds.get(r) === kind) others.add(r);
        }
      }
      const sameFamily = [...others].filter((r) => family(r) === family(tok.role));
      const swap = sameFamily[0] ?? (others.size === 1 ? [...others][0] : undefined);
      const other = swap ? tokenFor(swap, tok.form) : undefined;
      rows.push({
        kind: "entity",
        text: tok.raw,
        ok: false,
        level: "danger",
        where: wheres(quotable),
        message: other
          ? `May have mixed up ${tok.raw} and ${other}: ${refs(quotable)} ${
            quotable.length > 1 ? "name" : "names"
          } ${other}, not ${tok.raw}.`
          : `${tok.raw} is not in ${refs(quotable)}.`,
      });
      continue;
    }
    const flagged = quotable.filter((c) =>
      !srcRoles.get(c)!.has(tok.role) &&
      [...srcRoles.get(c)!].some((r) => claimRoles.has(r) && kinds.get(r) === kind)
    );
    rows.push(
      flagged.length
        ? {
          kind: "entity",
          text: tok.raw,
          ok: true,
          level: "danger",
          where: wheres(flagged),
          message: `${tok.raw} is not in ${refs(flagged)}, only in ${refs(inSrc)}.`,
        }
        : {
          kind: "entity",
          text: tok.raw,
          ok: true,
          level: "ok",
          where: wheres(inSrc),
          message: `${tok.raw} appears in ${refs(inSrc)}.`,
        },
    );
  }

  // Dates and numbers: the claim's, against each quotable citation's.
  const claimPlain = withoutTokens(claimTokenised);
  const claimDates = extractDates(claimPlain);
  const parsed = quotable.map((c) => {
    const d = extractDates(withoutTokens(srcText.get(c)!));
    return { c, dates: d.dates, numbers: extractNumbers(d.rest) };
  });
  const seenDates = new Set<string>();
  for (const d of claimDates.dates) {
    const key = dateKey(d);
    if (seenDates.has(key) || quotable.length === 0) continue;
    seenDates.add(key);
    const inSrc = parsed.filter((p) => p.dates.some((s) => dateMatches(d, s))).map((p) => p.c);
    if (inSrc.length) {
      rows.push({
        kind: "date",
        text: dateText(d),
        ok: true,
        level: "ok",
        where: wheres(inSrc),
        message: `${dateText(d)} appears in ${refs(inSrc)}.`,
      });
    } else {
      const there = [...new Set(parsed.flatMap((p) => p.dates).map(dateText))];
      rows.push({
        kind: "date",
        text: dateText(d),
        ok: false,
        level: "attention",
        where: wheres(quotable),
        message: `${dateText(d)} is not in the cited lines${
          there.length ? `; they have ${joinAnd(there)}` : ""
        }.`,
      });
    }
  }
  const seenNums = new Set<string>();
  for (const n of extractNumbers(claimDates.rest)) {
    const key = `${n.value}|${n.unit}`;
    if (seenNums.has(key) || quotable.length === 0) continue;
    seenNums.add(key);
    const inSrc = parsed.filter((p) => p.numbers.some((s) => numberMatches(n, s))).map((p) => p.c);
    rows.push(
      inSrc.length
        ? {
          kind: "number",
          text: n.text,
          ok: true,
          level: "ok",
          where: wheres(inSrc),
          message: `${n.text} appears in ${refs(inSrc)}.`,
        }
        : {
          kind: "number",
          text: n.text,
          ok: false,
          level: "attention",
          where: wheres(quotable),
          message: `${n.text} is not in the cited lines.`,
        },
    );
  }

  // Feelings: pointed out, with whether the cited lines say it too.
  const seenFeel = new Set<string>();
  for (const m of claimPlain.matchAll(FEELING_RE)) {
    const w = m[1].toLowerCase();
    if (seenFeel.has(w)) continue;
    seenFeel.add(w);
    const re = new RegExp(`\\b${w}\\b`, "i");
    const inSrc = quotable.filter((c) => re.test(withoutTokens(srcText.get(c)!)));
    rows.push(
      inSrc.length
        ? {
          kind: "feeling",
          text: m[1],
          ok: true,
          level: "ok",
          where: wheres(inSrc),
          message: `“${m[1]}” appears in ${refs(inSrc)}.`,
        }
        : {
          kind: "feeling",
          text: m[1],
          ok: null,
          level: "attention",
          message: quotable.length
            ? `“${m[1]}” describes a feeling or opinion; the cited lines don't say it.`
            : `“${m[1]}” describes a feeling or opinion; casefile can't check it.`,
        },
    );
  }

  // Placeholders left in.
  const seenPh = new Set<string>();
  for (const m of claimPlain.matchAll(PLACEHOLDER_RE)) {
    if (seenPh.has(m[0])) continue;
    seenPh.add(m[0]);
    rows.push({
      kind: "placeholder",
      text: m[0],
      ok: false,
      level: "attention",
      message: `Still has a placeholder: ${m[0]}`,
    });
  }

  return rows;
}

// ── splitSentences ─────────────────────────────────────────────────────────

const CITE_RE = /\b([A-Z]\d{3,}):(\d+)(?:\s*[-–]\s*(\d+))?/g;
const ONE_CITE = String.raw`[A-Z]\d{3,}:\d+(?:\s*[-–]\s*\d+)?`;
/** A parenthesised or bracketed group of citations, e.g. "(D001:3; D002:9–10)". */
const CITE_GROUP_RE = new RegExp(
  String.raw`\s*[(\[]\s*(?:see\s+)?${ONE_CITE}(?:\s*[,;]\s*(?:and\s+)?${ONE_CITE})*\s*[)\]]`,
  "g",
);
const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|No|Nos|Jr|Sr|vs|etc|e\.g|i\.e|cf|para|paras)\.$/i;

function citesIn(text: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    if (start >= 1 && end >= start) out.push({ doc_id: m[1], line_start: start, line_end: end });
  }
  return out;
}

/**
 * Split text into sentences, with the citations written inline in each (e.g. "(D001:3)"). A
 * citation group just after a sentence's full stop belongs to that sentence. The returned text
 * has its citation groups removed and its spaces collapsed; tokens are never split.
 */
export function splitSentences(text: string): { text: string; cites: SourceRef[] }[] {
  const src = text.trim();
  if (!src) return [];
  const groups = [...src.matchAll(CITE_GROUP_RE)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    cites: citesIn(m[0]),
  }));
  const tokens = parseTokens(src).tokens;
  const out: { text: string; cites: SourceRef[] }[] = [];
  let cur = "";
  let cites: SourceRef[] = [];
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) out.push({ text: t, cites });
    else if (cites.length && out.length) out[out.length - 1].cites.push(...cites);
    cur = "";
    cites = [];
  };
  let i = 0;
  while (i < src.length) {
    const g = groups.find((x) => x.start === i);
    if (g) {
      // A group before any text of a new sentence belongs to the sentence before.
      if (!cur.trim() && out.length) out[out.length - 1].cites.push(...g.cites);
      else cites.push(...g.cites);
      i = g.end;
      continue;
    }
    const t = tokens.find((x) => x.start === i);
    if (t) {
      cur += t.raw;
      i = t.end;
      continue;
    }
    const ch = src[i++];
    cur += ch;
    if (ch === "\n" && src[i] === "\n") {
      flush();
      continue;
    }
    if (!".!?".includes(ch)) continue;
    // Closing quotes or brackets stay with the sentence.
    while (i < src.length && /["'”’)]/.test(src[i])) cur += src[i++];
    // A citation group right after the stop belongs to this sentence (and a stop after it).
    const after = groups.find((x) => x.start === i);
    if (after) {
      cites.push(...after.cites);
      i = after.end;
      if (src[i] === ".") i++;
    }
    const next = src.slice(i);
    const endsSentence = next.trim() === "" || /^\s+["'“‘(]?[A-Z0-9{]/.test(next);
    const decimal = ch === "." && /\d$/.test(cur.slice(0, -1)) && /^\d/.test(next);
    if (endsSentence && !decimal && !(ch === "." && ABBREV.test(cur.trimEnd()))) flush();
  }
  flush();
  return out;
}
