/**
 * Text folding for matching known values (ADR 6). Names can be written in many equivalent ways:
 * full-width or compatibility characters ("Ｒｅｂｅｃｃａ"), decomposed accents, typographic
 * apostrophes ("O’Brien", "Oʼbrien"), odd spacing ("Anna  Thornbury"). Matching runs on a folded
 * copy of the text, and every folded character remembers which original characters it came from,
 * so a match maps back to exact offsets in the original.
 *
 * Folding: NFKC per character (a base character with its combining marks), every apostrophe-like
 * character becomes `'` and every dash-like one `-`, invisible format characters (zero-width
 * space, soft hyphen…) are dropped, every run of horizontal whitespace becomes one space, and
 * optionally lower case. Line breaks are kept, so a match never crosses a line. Homoglyphs from
 * other scripts (Cyrillic "а") are not folded.
 */

export interface Folded {
  text: string;
  /** For each folded UTF-16 unit, the original [start, end) it came from. */
  starts: number[];
  ends: number[];
}

const APOSTROPHES = /[’‘ʼʻʽ`´′＇]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
/** Invisible format characters (zero-width space/joiners, soft hyphen, BOM…) are skipped. */
const FORMAT = /^\p{Cf}$/u;
const HSPACE = /^[^\S\n]$/u;
const MARK = /\p{M}/u;

export function fold(text: string, opts: { lower: boolean }): Folded {
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const emit = (s: string, a: number, b: number) => {
    out += s;
    for (let k = 0; k < s.length; k++) {
      starts.push(a);
      ends.push(b);
    }
  };
  let i = 0;
  while (i < text.length) {
    const start = i;
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    i += cp.length;
    if (FORMAT.test(cp)) continue;
    if (HSPACE.test(cp) || HSPACE.test(cp.normalize("NFKC"))) {
      while (i < text.length) {
        const next = String.fromCodePoint(text.codePointAt(i)!);
        if (!(HSPACE.test(next) || HSPACE.test(next.normalize("NFKC")))) break;
        i += next.length;
      }
      emit(" ", start, i);
      continue;
    }
    let unit = cp;
    while (i < text.length) {
      const next = String.fromCodePoint(text.codePointAt(i)!);
      if (!MARK.test(next)) break;
      unit += next;
      i += next.length;
    }
    let f = unit.normalize("NFKC").replace(APOSTROPHES, "'").replace(DASHES, "-");
    if (opts.lower) f = f.toLowerCase();
    emit(f, start, i);
  }
  return { text: out, starts, ends };
}

/** Folded text of a value, for comparing values with each other (lower case, trimmed). */
export function foldValue(s: string): string {
  return fold(s, { lower: true }).text.trim();
}

/** Map a match [i, j) in folded text back to the original text's [start, end). */
export function unfold(f: Folded, i: number, j: number): { start: number; end: number } {
  return { start: f.starts[i], end: f.ends[j - 1] };
}
