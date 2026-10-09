import { docAuthor } from "../checking.ts";
import { InvalidInputError } from "../publicdb.ts";
import type { CaseSession } from "../session.ts";
import { formatDate } from "../summary.ts";

/**
 * The user's earlier affidavits (ADR 0027): which documents in the case are affidavits the user
 * swore or affirmed, and on what date. Kept in the vault only (`earlier-affidavits`), never in
 * public.db or the log (which records `earlier_affidavit_set {doc, set}`), and the CLI cannot read
 * it. On export, inside the app, a citation of one ("D002:9") becomes "my affidavit sworn
 * 2 April 2025, para 4": the paragraph number is read from the document's original text in the
 * vault, so nothing Claude can write decides it.
 *
 * "My" must be true of whoever speaks in the export, so a citation is written this way only when
 * the document's origin is the user's own (`mine`), the user recorded in the app that the
 * speaker wrote it (`docAuthor`), and every cited line is inside a numbered paragraph. Otherwise
 * the citation is written as before ("Title, line N").
 */

export const EARLIER_AFFIDAVITS_FILE = "earlier-affidavits";

export type Oath = "sworn" | "affirmed";

export interface EarlierAffidavit {
  oath: Oath;
  /** YYYY-MM-DD. */
  date: string;
}

interface StoredAffidavit extends EarlierAffidavit {
  /** The document's `importedAt` when this was saved: a different document never inherits it. */
  docImportedAt: string;
  at: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function realDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3]);
}

async function readAll(s: CaseSession): Promise<Record<string, StoredAffidavit>> {
  const all = await s.readVaultJson<Record<string, StoredAffidavit>>(EARLIER_AFFIDAVITS_FILE, {});
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

/** What the user recorded about document `docId` as an earlier affidavit, or null. */
export async function getEarlierAffidavit(
  s: CaseSession,
  docId: string,
): Promise<EarlierAffidavit | null> {
  const all = await readAll(s);
  const r = Object.hasOwn(all, docId) ? all[docId] : undefined;
  if (!r || (r.oath !== "sworn" && r.oath !== "affirmed") || !realDate(r.date)) return null;
  let doc;
  try {
    doc = await s.getDoc(docId);
  } catch {
    return null;
  }
  if (r.docImportedAt !== doc.importedAt) return null;
  return { oath: r.oath, date: r.date };
}

/**
 * The user records that document `docId` is an affidavit they swore or affirmed on `date`
 * (`{oath, date}`), or clears it (null). The date may not be in the future. Logged without the
 * date.
 */
export async function setEarlierAffidavit(
  s: CaseSession,
  docId: string,
  input: unknown,
  now: Date = new Date(),
): Promise<EarlierAffidavit | null> {
  const doc = await s.getDoc(docId); // NotFound for a document the vault doesn't have
  const all = await readAll(s);
  if (input === null) {
    delete all[docId];
    await s.writeVaultJson(EARLIER_AFFIDAVITS_FILE, all);
    s.log("user", "earlier_affidavit_set", { doc: docId, set: false });
    return null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidInputError("Send {oath, date}, or null to clear it");
  }
  const { oath, date } = input as Record<string, unknown>;
  if (oath !== "sworn" && oath !== "affirmed") {
    throw new InvalidInputError("oath is sworn or affirmed");
  }
  if (typeof date !== "string" || !realDate(date)) {
    throw new InvalidInputError("date is the day it was sworn or affirmed, as YYYY-MM-DD");
  }
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  if (date > today) throw new InvalidInputError("That date is in the future");
  all[docId] = { oath, date, docImportedAt: doc.importedAt, at: now.toISOString() };
  await s.writeVaultJson(EARLIER_AFFIDAVITS_FILE, all);
  s.log("user", "earlier_affidavit_set", { doc: docId, set: true });
  return { oath, date };
}

/** A line that starts a numbered paragraph: "4. On 14 March…", "12) I say…". */
const PARA_START = /^\s*\(?(\d{1,3})[.)]\s+\S/;

/**
 * The number of the paragraph that line `line` (1-based) of `text` belongs to: the nearest
 * numbered paragraph start at or above it, with no blank line in between. Null for a line in the
 * heading, a blank line, or one after a gap (the jurat, an annexure note).
 */
export function paragraphOfLine(text: string, line: number): number | null {
  const lines = text.split("\n");
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  for (let i = line - 1; i >= 0; i--) {
    if (!lines[i].trim()) return null;
    const m = PARA_START.exec(lines[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

/** "para 4", "paras 4–5", or null when a line in the range is not in a numbered paragraph. */
export function paragraphsOf(text: string, start: number, end: number): string | null {
  if (end < start) return null;
  const nums = new Set<number>();
  for (let l = start; l <= end; l++) {
    const n = paragraphOfLine(text, l);
    if (n === null) return null;
    nums.add(n);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  if (sorted.length === 1) return `para ${sorted[0]}`;
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  return sorted.length === hi - lo + 1 ? `paras ${lo}–${hi}` : `paras ${sorted.join(", ")}`;
}

/**
 * How casefile cites lines of a document as the speaker's earlier affidavit, or null when it
 * isn't one (see the module comment for the conditions). `speaker` is a role in who's who: the
 * affidavit's deponent, or the user's own role.
 */
export async function myAffidavitCitation(
  s: CaseSession,
  docId: string,
  start: number,
  end: number,
  speaker: string | null | undefined,
): Promise<string | null> {
  if (!speaker) return null;
  const rec = await getEarlierAffidavit(s, docId);
  if (!rec) return null;
  const doc = await s.getDoc(docId);
  if (doc.origin !== "mine") return null;
  if (await docAuthor(s, docId) !== speaker) return null;
  const paras = paragraphsOf(doc.original, start, end);
  if (!paras) return null;
  return `my affidavit ${rec.oath} ${formatDate(rec.date)}, ${paras}`;
}

/** The role that "my" means in an export: the affidavit's deponent, else the user's own role. */
export function exportSpeaker(s: CaseSession, deponent?: string | null): string | null {
  return deponent ?? s.settings.userRole ?? null;
}
