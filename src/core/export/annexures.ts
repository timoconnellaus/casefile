import { InvalidInputError } from "../publicdb.ts";
import type { CaseSession } from "../session.ts";
import { getDraftHeading } from "../drafting.ts";
import { myAffidavitCitation } from "./affidavits.ts";

/**
 * Annexure marks for one draft (e.g. "AT-1"), kept in the vault only (ADR 0021). A mark starts
 * with the deponent's initials, so it identifies them: it is never written to public.db, never
 * logged (the log counts marks), and the CLI cannot read it. On export a citation of a marked
 * document ("D002:9") becomes "annexure AT-1".
 */

export function annexureFile(draftId: number): string {
  return `annexure-marks-${draftId}`;
}

interface StoredMarks {
  /** The draft's `created_at` when the marks were saved: a reused draft id does not inherit them. */
  draftCreatedAt: string;
  marks: Record<string, string>;
}

/** Up to 20 characters: letters and digits, with spaces, dots or hyphens between them. */
export const MARK_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 .-]{0,18}[A-Za-z0-9])?$/;
const DOC_RE = /^[A-Z]\d{3,}$/;
const MAX_MARKS = 200;

/** Citations in text, as Claude writes them: "D001:3", "D001:3-5". */
export const CITE_RE = /\b([A-Z]\d{3,}):(\d+)(?:[-–](\d+))?\b/g;

/** The draft's marks, by document id (empty if none, or if they belong to a deleted draft). */
export async function getAnnexureMarks(
  session: CaseSession,
  draftId: number,
): Promise<Record<string, string>> {
  const d = session.store.getDraft(draftId);
  const m = await session.readVaultJson<StoredMarks | null>(annexureFile(draftId), null);
  if (!m || m.draftCreatedAt !== d.created_at || !m.marks || typeof m.marks !== "object") {
    return {};
  }
  return { ...m.marks };
}

/**
 * Replace the draft's marks. `input` maps document ids to marks; an empty mark removes it. Marks
 * are unique within the draft (ignoring case). Logged with the count only.
 */
export async function setAnnexureMarks(
  session: CaseSession,
  draftId: number,
  input: unknown,
): Promise<Record<string, string>> {
  const d = session.store.getDraft(draftId);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidInputError("marks must map document ids to marks");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_MARKS) throw new InvalidInputError(`At most ${MAX_MARKS} marks`);
  const marks: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [doc, v] of entries) {
    if (!DOC_RE.test(doc)) throw new InvalidInputError(`Bad document id ${doc.slice(0, 20)}`);
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string") throw new InvalidInputError("Each mark must be text");
    const mark = v.trim().replace(/\s+/g, " ");
    if (!MARK_RE.test(mark)) {
      throw new InvalidInputError(
        "A mark is up to 20 letters or numbers, such as AT-1 (spaces, dots and hyphens between)",
      );
    }
    const key = mark.toLowerCase();
    if (seen.has(key)) throw new InvalidInputError(`The mark ${mark} is used twice`);
    seen.add(key);
    try {
      await session.getDoc(doc);
    } catch {
      throw new InvalidInputError(`There is no document ${doc}`);
    }
    marks[doc] = mark;
  }
  const stored: StoredMarks = { draftCreatedAt: d.created_at, marks };
  await session.writeVaultJson(annexureFile(draftId), stored);
  session.log("user", "annexure_marks_set", { draft: draftId, marks: Object.keys(marks).length });
  return marks;
}

/** "Anna Thornbury" → "AT". Letters only; at most four. */
export function initials(name: string): string {
  return name.split(/[\s-]+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ""))
    .filter((w) => w.length > 0 && w[0] === w[0].toUpperCase())
    .map((w) => w[0].toUpperCase())
    .join("")
    .slice(0, 4);
}

/** The prefix casefile suggests: the deponent's initials from the heading, or "A". */
export async function suggestedPrefix(session: CaseSession, draftId: number): Promise<string> {
  const h = await getDraftHeading(session, draftId);
  const name = h?.deponent ? session.registry.resolve(h.deponent, "full") : undefined;
  const i = name ? initials(name) : "";
  return /^[A-Za-z]+$/.test(i) ? i : "A";
}

/**
 * The documents a draft cites, in the order they are first cited: the paragraphs' sources, then
 * citations in their text. Each comes once.
 */
export function citedDocs(session: CaseSession, draftId: number): string[] {
  const out: string[] = [];
  const add = (d: string) => {
    if (!out.includes(d)) out.push(d);
  };
  for (const p of session.store.listParagraphs(draftId)) {
    for (const s of session.store.listParagraphSources(p.id)) add(s.doc_id);
    for (const m of p.body.matchAll(CITE_RE)) add(m[1]);
  }
  return out;
}

/**
 * Marks casefile suggests for a draft: `<prefix>-1`, `<prefix>-2`… in citation order, for the
 * cited documents that exist.
 */
export async function suggestMarks(
  session: CaseSession,
  draftId: number,
): Promise<Record<string, string>> {
  const prefix = await suggestedPrefix(session, draftId);
  const out: Record<string, string> = {};
  let n = 0;
  for (const doc of citedDocs(session, draftId)) {
    try {
      await session.getDoc(doc);
    } catch {
      continue;
    }
    out[doc] = `${prefix}-${++n}`;
  }
  return out;
}

/**
 * Turn citations in re-identified text into what a court reader understands: a marked document
 * becomes "annexure AT-1"; the speaker's own earlier affidavit "my affidavit sworn 2 April 2025,
 * para 4" (`myAffidavitCitation`, ADR 0027); any other document "Text messages, March 2025,
 * line 3" (or "…, lines 3–5"). Unknown documents are left as they are. `speaker` is the role
 * "my" means: the affidavit's deponent, or the user (`exportSpeaker`); without one, no citation
 * says "my".
 */
export async function convertCitationsWith(
  session: CaseSession,
  text: string,
  marks: Record<string, string>,
  opts: { speaker?: string | null } = {},
): Promise<string> {
  const titles = new Map<string, string | null>();
  const mine = new Map<string, string | null>();
  for (const m of text.matchAll(CITE_RE)) {
    if (!titles.has(m[1])) {
      try {
        titles.set(m[1], (await session.getDoc(m[1])).title);
      } catch {
        titles.set(m[1], null);
      }
    }
    const key = m[0];
    if (titles.get(m[1]) && !Object.hasOwn(marks, m[1]) && !mine.has(key)) {
      const a = Number(m[2]);
      mine.set(key, await myAffidavitCitation(session, m[1], a, Number(m[3] ?? a), opts.speaker));
    }
  }
  return text.replace(CITE_RE, (all, doc: string, a: string, b?: string) => {
    const title = titles.get(doc);
    if (!title) return all;
    if (Object.hasOwn(marks, doc)) return `annexure ${marks[doc]}`;
    const my = mine.get(all);
    if (my) return my;
    return b && b !== a ? `${title}, lines ${a}–${b}` : `${title}, line ${a}`;
  });
}

/** A source reference as a plain description (for tables): marks first, then title and lines. */
export async function describeSource(
  session: CaseSession,
  ref: { doc_id: string; line_start: number; line_end: number },
  marks: Record<string, string> = {},
  opts: { speaker?: string | null } = {},
): Promise<string> {
  const r = `${ref.doc_id}:${ref.line_start}${
    ref.line_end !== ref.line_start ? `-${ref.line_end}` : ""
  }`;
  return await convertCitationsWith(session, r, marks, opts);
}
