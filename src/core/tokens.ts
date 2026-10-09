/**
 * Token grammar (ADR 0005).
 *
 *   {{role}}          the entity's full form, e.g. "Jane Smith"
 *   {{role.first}}    first name, e.g. "Jane"
 *   {{role.surname}}  surname, e.g. "Smith"
 *   {{role.title}}    honorific + surname, e.g. "Ms Smith"
 *
 * A role is lower-case snake case starting with a letter: mother, child_1, school_2.
 * Anything that looks like a token but does not match the grammar exactly is "malformed".
 */

export const FORMS = ["first", "surname", "title"] as const;
export type Form = "full" | typeof FORMS[number];

export const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

const STRICT = /\{\{([a-z][a-z0-9_]{0,47})(?:\.(first|surname|title))?\}\}/y;

export interface TokenRef {
  start: number;
  end: number;
  role: string;
  form: Form;
  raw: string;
}

export interface Malformed {
  start: number;
  end: number;
  raw: string;
}

export function isValidRole(role: string): boolean {
  return ROLE_PATTERN.test(role);
}

export function formatToken(role: string, form: Form = "full"): string {
  if (!isValidRole(role)) throw new Error(`Invalid role name: ${JSON.stringify(role)}`);
  return form === "full" ? `{{${role}}}` : `{{${role}.${form}}}`;
}

/** Scan text for tokens. Every `{{` and every stray `}}` is accounted for. */
export function parseTokens(text: string): { tokens: TokenRef[]; malformed: Malformed[] } {
  const tokens: TokenRef[] = [];
  const malformed: Malformed[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    const strayClose = text.indexOf("}}", i);
    if (open === -1 && strayClose === -1) break;
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      malformed.push({ start: strayClose, end: strayClose + 2, raw: "}}" });
      i = strayClose + 2;
      continue;
    }
    STRICT.lastIndex = open;
    const m = STRICT.exec(text);
    if (m) {
      tokens.push({
        start: open,
        end: open + m[0].length,
        role: m[1],
        form: (m[2] as Form | undefined) ?? "full",
        raw: m[0],
      });
      i = open + m[0].length;
    } else {
      // Report up to the next closing braces on the same line, or the end of the word.
      const close = text.indexOf("}}", open + 2);
      const nl = text.indexOf("\n", open);
      let end: number;
      if (close !== -1 && (nl === -1 || close < nl) && close - open < 60) end = close + 2;
      else end = open + 2 + (/^[^\s{}]*/.exec(text.slice(open + 2))![0].length);
      malformed.push({ start: open, end, raw: text.slice(open, end) });
      i = end;
    }
  }
  return { tokens, malformed };
}

export type Resolver = (role: string, form: Form) => string | undefined;

export interface RenderResult {
  text: string;
  unknown: TokenRef[];
  malformed: Malformed[];
}

export interface RenderOptions {
  /** How to show an unknown token. Defaults to leaving it in place. */
  onUnknown?: (t: TokenRef) => string;
  onMalformed?: (m: Malformed) => string;
}

/** Re-identify: swap tokens for real values. Unknown and malformed tokens are reported, never dropped. */
export function renderTokens(
  text: string,
  resolve: Resolver,
  opts: RenderOptions = {},
): RenderResult {
  const { tokens, malformed } = parseTokens(text);
  const marks = [
    ...tokens.map((t) => ({ kind: "token" as const, start: t.start, end: t.end, t })),
    ...malformed.map((m) => ({ kind: "malformed" as const, start: m.start, end: m.end, m })),
  ].sort((a, b) => a.start - b.start);
  const unknown: TokenRef[] = [];
  let out = "";
  let pos = 0;
  for (const mark of marks) {
    out += text.slice(pos, mark.start);
    if (mark.kind === "token") {
      const value = resolve(mark.t.role, mark.t.form);
      if (value === undefined) {
        unknown.push(mark.t);
        out += opts.onUnknown ? opts.onUnknown(mark.t) : mark.t.raw;
      } else {
        out += value;
      }
    } else {
      out += opts.onMalformed ? opts.onMalformed(mark.m) : mark.m.raw;
    }
    pos = mark.end;
  }
  out += text.slice(pos);
  return { text: out, unknown, malformed };
}

/**
 * A piece of re-identified text: plain text, a resolved token (`t` is the real value), or an
 * unknown or malformed token left in place (`t` is the raw token, as `renderTokens` leaves it).
 */
export type Seg =
  | { t: string }
  | { t: string; role: string; form: Form }
  | { t: string; unknown: true; raw: string }
  | { t: string; malformed: true; raw: string };

export interface SegmentResult {
  /** Joining every `t` gives `renderTokens(text, resolve).text`. Plain runs are merged. */
  segs: Seg[];
  unknown: TokenRef[];
  malformed: Malformed[];
}

/**
 * Re-identify into segments, so a client can colour names and show which token each came from.
 * Same rules as `renderTokens`: unknown and malformed tokens are reported, never dropped.
 */
export function renderSegments(text: string, resolve: Resolver): SegmentResult {
  const { tokens, malformed } = parseTokens(text);
  const marks = [
    ...tokens.map((t) => ({ start: t.start, end: t.end, t, m: undefined })),
    ...malformed.map((m) => ({ start: m.start, end: m.end, t: undefined, m })),
  ].sort((a, b) => a.start - b.start);
  const segs: Seg[] = [];
  const unknown: TokenRef[] = [];
  const plain = (t: string) => {
    if (!t) return;
    const last = segs.at(-1);
    if (last && !("role" in last || "unknown" in last || "malformed" in last)) last.t += t;
    else segs.push({ t });
  };
  let pos = 0;
  for (const mark of marks) {
    plain(text.slice(pos, mark.start));
    if (mark.t) {
      const value = resolve(mark.t.role, mark.t.form);
      if (value === undefined) {
        unknown.push(mark.t);
        segs.push({ t: mark.t.raw, unknown: true, raw: mark.t.raw });
      } else segs.push({ t: value, role: mark.t.role, form: mark.t.form });
    } else if (mark.m) {
      segs.push({ t: mark.m.raw, malformed: true, raw: mark.m.raw });
    }
    pos = mark.end;
  }
  plain(text.slice(pos));
  return { segs, unknown, malformed };
}

/** Check text written on the Claude side: every token must be well-formed and refer to a known role. */
export function validateTokens(
  text: string,
  knownRoles: ReadonlySet<string>,
): { ok: boolean; unknown: TokenRef[]; malformed: Malformed[] } {
  const { tokens, malformed } = parseTokens(text);
  const unknown = tokens.filter((t) => !knownRoles.has(t.role));
  return { ok: unknown.length === 0 && malformed.length === 0, unknown, malformed };
}
