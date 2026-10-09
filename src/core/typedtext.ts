import { exposedValues, type ExposureTrigger } from "./exposure.ts";
import type { ChronologyRow, EvidenceRow, IssueRow, NoteRow, ParagraphRow } from "./publicdb.ts";
import type { CaseSession } from "./session.ts";
import { findLeaks, tokeniseKnown } from "./tokenise.ts";

/**
 * Re-checking text already in public.db when who's who learns a value (ADR 27).
 *
 * Text the user types in the app is tokenised when it is saved, but only against the values known
 * then: a nickname added later ("Annie"), or a person first found in a later document, can already
 * be sitting as written in a note, a chronology entry, an issue, an evidence note or a paragraph,
 * where Claude can read it. Every change to who's who (`saveRegistry`, after the shared documents'
 * exposure check) therefore scans that text again with the known-values matcher:
 *
 * - **The user's own text** (the ledger says the user wrote it: `user_item`, or a paragraph's
 *   `authorship` with no Claude text in it) is re-tokenised: each value becomes its token, the
 *   ledger records the new content as still the user's, and their marks (removed, dealt with)
 *   carry over. Checks on it lapse ("Changed since you checked"), as for any change to it.
 * - **Anything else** is left as written and listed for the user (vault only): Claude's own work,
 *   and text whose author casefile cannot confirm (draft titles, tags, document details, a
 *   paragraph the user rewrote from Claude's). Rewriting text Claude wrote would tell Claude which
 *   of its words is a real name (a probe, ADR 3), so casefile never does it.
 * - Text where the value cannot be replaced cleanly (an ambiguous match, a leak-only part such as a
 *   middle name) is also left and listed.
 *
 * The record of each re-check (what changed, what was left, and the values, which are real) is
 * kept in the vault file `typed-text-rechecks`. The AI-use log gets the number of the user's items
 * changed and nothing else: how many of Claude's items name someone would confirm Claude's
 * guesses.
 */

/** Vault file of re-checks that found something (JSON array of `TypedTextRecheck`, oldest first). */
export const TYPED_TEXT_RECHECKS_FILE = "typed-text-rechecks";
const KEEP = 200;

export type TypedTextKind =
  | "note"
  | "chronology"
  | "issue"
  | "evidence"
  | "paragraph"
  | "draft_title"
  | "tag"
  | "doc_details";

export interface TypedTextItem {
  kind: TypedTextKind;
  /** The item's id (a paragraph's own id; a tag or document details: the document id). */
  id: string;
  /** Roles whose values were showing. */
  roles: string[];
}

export interface TypedTextLeft extends TypedTextItem {
  /** claude: not the user's text; unconfirmed: casefile can't tell; unclear: can't replace cleanly. */
  why: "claude" | "unconfirmed" | "unclear";
}

export interface TypedTextRecheck {
  at: string;
  replaced: TypedTextItem[];
  left: TypedTextLeft[];
  /** The values found (real values: vault only, never logged). */
  triggers: ExposureTrigger[];
}

/** A plain-words label for an item, for the app's screens (no values). */
export function typedTextLabel(i: Pick<TypedTextItem, "kind" | "id">): string {
  switch (i.kind) {
    case "note":
      return `note ${i.id}`;
    case "chronology":
      return `chronology entry ${i.id}`;
    case "issue":
      return `issue ${i.id}`;
    case "evidence":
      return `evidence link ${i.id}`;
    case "paragraph":
      return `draft paragraph ${i.id}`;
    case "draft_title":
      return `the title of draft ${i.id}`;
    case "tag":
      return `a tag on ${i.id}`;
    case "doc_details":
      return `the details of ${i.id}`;
  }
}

export async function listTypedTextRechecks(session: CaseSession): Promise<TypedTextRecheck[]> {
  return await session.readVaultJson<TypedTextRecheck[]>(TYPED_TEXT_RECHECKS_FILE, []);
}

/** One field of one item, with how to rewrite it if it is the user's. */
interface Field {
  kind: TypedTextKind;
  id: string;
  text: string;
  /** Rewrites the item with `next` and records it as the user's; absent: never rewritten. */
  rewrite?: (next: string) => Promise<void>;
  /** Whether the user wrote it (checked only when the text shows a value). */
  mine: () => Promise<boolean>;
}

const no = () => Promise.resolve(false);

function fields(session: CaseSession): Field[] {
  const st = session.store;
  const ledger = session.ledger;
  const out: Field[] = [];
  for (const n of st.listNotes()) {
    out.push({
      kind: "note",
      id: String(n.id),
      text: n.body,
      mine: () => session.isUserItem("note", n),
      rewrite: async (body) => {
        st.updateNoteBody(n.id, body);
        const after: NoteRow = st.getNote(n.id);
        await session.recordUserItem("note", n.id, after);
        await ledger.carryMarks("note", n, after);
      },
    });
  }
  for (const c of st.listChronology({ includeRemoved: true })) {
    out.push({
      kind: "chronology",
      id: String(c.id),
      text: c.description,
      mine: () => session.isUserItem("chronology", c),
      rewrite: async (description) => {
        st.updateChronology(c.id, { description });
        const after: ChronologyRow = st.getChronology(c.id);
        await session.recordUserItem("chronology", c.id, after);
        await ledger.carryMarks("chronology", c, after);
      },
    });
  }
  for (const i of st.listIssues({ includeRemoved: true })) {
    // Title and description are one item: rewritten together, from the row as it is then.
    const rewriteIssue = async (field: "title" | "description", next: string) => {
      const before: IssueRow = st.getIssue(i.id);
      st.updateIssue(i.id, { [field]: next });
      const after = st.getIssue(i.id);
      await session.recordUserItem("issue", i.id, after);
      await ledger.carryMarks("issue", before, after);
    };
    const mine = () => session.isUserItem("issue", st.getIssue(i.id));
    out.push({
      kind: "issue",
      id: String(i.id),
      text: i.title,
      mine,
      rewrite: (t) => rewriteIssue("title", t),
    });
    out.push({
      kind: "issue",
      id: String(i.id),
      text: i.description ?? "",
      mine,
      rewrite: (t) => rewriteIssue("description", t),
    });
    for (const e of st.listEvidence(i.id, { includeRemoved: true })) {
      out.push({
        kind: "evidence",
        id: String(e.id),
        text: e.note ?? "",
        mine: () => session.isUserItem("evidence", e),
        rewrite: async (note) => {
          st.updateEvidence(e.id, { note });
          const after: EvidenceRow = st.getEvidence(e.id);
          await session.recordUserItem("evidence", e.id, after);
          await ledger.carryMarks("evidence", e, after);
        },
      });
    }
  }
  for (const d of st.listDrafts()) {
    // Draft titles have no authorship record, so they are never rewritten.
    out.push({ kind: "draft_title", id: String(d.id), text: d.title, mine: no });
    for (const p of st.listParagraphs(d.id)) {
      out.push({
        kind: "paragraph",
        id: String(p.id),
        text: p.body,
        // A rewrite of Claude's paragraph may keep Claude's words: never rewritten.
        mine: async () =>
          p.author === "user" && p.claude_body === null &&
          await session.hasUserAuthorship(p as ParagraphRow),
        rewrite: async (body) => {
          st.updateParagraph(p.id, body, "user");
          await session.attestUserAuthorship({ id: p.id, draft_id: p.draft_id, body });
        },
      });
    }
  }
  for (const doc of st.listDocuments()) {
    // Tags and document details record who wrote them only in public.db: never rewritten.
    for (const tag of st.tagsFor(doc.id)) {
      out.push({ kind: "tag", id: doc.id, text: tag, mine: no });
    }
    for (const v of [doc.doc_type, doc.source]) {
      if (v) out.push({ kind: "doc_details", id: doc.id, text: v, mine: no });
    }
  }
  return out;
}

/**
 * Re-check the text in public.db that is not a document's body or title (those are the exposure
 * check's) against who's who as it is now. Rewrites the user's own text, lists the rest, records
 * what it found in the vault and returns what is new to the user (`left`: only items the last
 * re-check had not listed); null when there is nothing new.
 */
export async function recheckTypedText(session: CaseSession): Promise<TypedTextRecheck | null> {
  const replaced: TypedTextItem[] = [];
  const left: TypedTextLeft[] = [];
  const triggers: ExposureTrigger[] = [];
  for (const f of fields(session)) {
    if (!f.text) continue;
    const found = exposedValues(session, f.text, []);
    if (!found.length) continue;
    triggers.push(...found);
    const roles = [...new Set(found.map((t) => t.role))].sort();
    const item = { kind: f.kind, id: f.id, roles };
    if (!f.rewrite || !(await f.mine())) {
      left.push({ ...item, why: f.rewrite ? "claude" : "unconfirmed" });
      continue;
    }
    const { text: next, ambiguous } = tokeniseKnown(f.text, session.registry);
    if (ambiguous.length || findLeaks(next, session.registry).length || next === f.text) {
      left.push({ ...item, why: "unclear" });
      continue;
    }
    try {
      await f.rewrite(next);
      replaced.push(item);
    } catch {
      left.push({ ...item, why: "unclear" });
    }
  }
  if (!replaced.length && !left.length) return null;
  const seen = new Set<string>();
  const record: TypedTextRecheck = {
    at: new Date().toISOString(),
    replaced: merge(replaced),
    left: merge(left),
    triggers: triggers.filter((t) => {
      const k = `${t.role}\0${t.value}`;
      return !seen.has(k) && (seen.add(k), true);
    }),
  };
  // Only a re-check that found something new is kept: the same items left as before are not
  // recorded again on every change to who's who.
  const all = await listTypedTextRechecks(session);
  const last = all.at(-1);
  const same = last && !record.replaced.length &&
    JSON.stringify(last.left) === JSON.stringify(record.left);
  if (!same) {
    all.push(record);
    await session.writeVaultJson(TYPED_TEXT_RECHECKS_FILE, all.slice(-KEEP));
  }
  // The count of the user's items only (see above).
  if (record.replaced.length) {
    session.log("app", "typed_text_rechecked", { count: record.replaced.length });
  }
  // What is new to the user: items left that the last re-check had not already listed (as they
  // are now), so an unrelated change doesn't report them again. The vault record has them all.
  const before = new Set((last?.left ?? []).map((i) => JSON.stringify(i)));
  const fresh = record.left.filter((i) => !before.has(JSON.stringify(i)));
  if (!record.replaced.length && !fresh.length) return null;
  return { ...record, left: fresh };
}

/** One entry per item (an issue's title and description are one item). */
function merge<T extends TypedTextItem>(list: T[]): T[] {
  const out = new Map<string, T>();
  for (const i of list) {
    const k = `${i.kind}:${i.id}`;
    const prev = out.get(k);
    if (!prev) out.set(k, { ...i });
    else prev.roles = [...new Set([...prev.roles, ...i.roles])].sort();
  }
  return [...out.values()];
}
