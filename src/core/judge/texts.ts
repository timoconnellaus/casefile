import type { SourceRef } from "../publicdb.ts";
import type { CaseSession, StoredDoc } from "../session.ts";
import { findLeaks } from "../tokenise.ts";
import type { JudgeState } from "./types.ts";

/**
 * The only way to build what an extra check sees (ADR 14). Every backend gets exactly what Claude
 * may see, and nothing more:
 * - document text only from documents shared with Claude now, as `publishedView` gives it (with
 *   names replaced, after its leak check); withheld, exposed and unreviewed documents give nothing;
 * - Claude's notes and draft sentences as public.db holds them (Claude can read those anyway);
 * - and then a leak check of every field against who's who as it is now, so a value learnt since
 *   (a new nickname, say) is never sent even where Claude's own text still shows it.
 * Anything that fails is a refusal with a reason, never a partial state.
 */

export type Gated = { state: JudgeState } | { refused: string };

/** The text of a document as Claude may see it now, or null when Claude may not. */
async function sharedDoc(
  s: CaseSession,
  docId: string,
): Promise<{ body: string; title: string; ignore: string[] } | null> {
  let doc: StoredDoc;
  try {
    doc = await s.getDoc(docId);
  } catch {
    return null;
  }
  if (doc.status !== "published") return null;
  const view = s.publishedView(doc);
  if (view.withheld || view.body === null) return null;
  return { body: view.body, title: view.title, ignore: s.honouredIgnore(doc.ignore ?? []) };
}

/** Leak-check every field, with values the cited documents leave as written still allowed. */
function seal(s: CaseSession, fields: Record<string, string>, ignore: string[]): Gated {
  for (const v of Object.values(fields)) {
    if (findLeaks(v, s.registry, ignore).length) {
      return { refused: "It shows a name or number casefile knows, so it isn't sent anywhere." };
    }
  }
  return { state: Object.freeze({ ...fields }) as unknown as JudgeState };
}

/** The lines `refs` cite, joined, if every one is in a shared document. */
async function citedText(
  s: CaseSession,
  refs: SourceRef[],
): Promise<{ text: string; ignore: string[] } | { refused: string }> {
  if (!refs.length) return { refused: "It cites no lines." };
  const parts: string[] = [];
  const ignore: string[] = [];
  for (const r of refs) {
    const doc = await sharedDoc(s, r.doc_id);
    if (!doc) return { refused: "It cites a document Claude can't see now." };
    const lines = doc.body.split("\n");
    if (r.line_start < 1 || r.line_end < r.line_start || r.line_end > lines.length) {
      return { refused: "It cites lines that aren't in the document." };
    }
    parts.push(...lines.slice(r.line_start - 1, r.line_end));
    ignore.push(...doc.ignore);
  }
  return { text: parts.join("\n"), ignore };
}

/** `fair_reading`: Claude's note and the lines it cites. */
export async function claimState(
  s: CaseSession,
  claim: string,
  refs: SourceRef[],
): Promise<Gated> {
  if (!claim.trim()) return { refused: "There's no note to check." };
  const cited = await citedText(s, refs);
  if ("refused" in cited) return cited;
  return seal(s, { claim, cited_lines: cited.text }, cited.ignore);
}

/** `feeling_or_opinion`: one sentence of a draft, as public.db holds it. */
export function sentenceState(s: CaseSession, sentence: string): Gated {
  if (!sentence.trim()) return { refused: "There's no sentence to check." };
  return seal(s, { sentence }, []);
}

/** How much of a document `origin_hint` reads: its title and first lines (as `originHints`). */
export const OPENING_LINES = 15;

/** `origin_hint`: a shared document's title and opening lines. */
export async function openingState(s: CaseSession, docId: string): Promise<Gated> {
  const doc = await sharedDoc(s, docId);
  if (!doc) return { refused: "Claude can't see this document now, so it isn't checked." };
  const opening = [doc.title, ...doc.body.split("\n").slice(0, OPENING_LINES)].join("\n");
  return seal(s, { opening_lines: opening }, doc.ignore);
}

/**
 * What "Test the connection" sends: a fixed, invented sentence, never anything from the case.
 * (Synthetic text, ADR 11.)
 */
export const TEST_STATE = Object.freeze({
  sentence: "On 3 May 2024 {{father.first}} collected {{child_1.first}} from school at 3pm.",
}) as unknown as JudgeState;
