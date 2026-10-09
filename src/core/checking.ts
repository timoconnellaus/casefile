import {
  cantCheck,
  checkClaim,
  chronologyClaim,
  type CitedLines,
  missingCitation,
} from "./claimcheck.ts";

export { chronologyClaim };
import type { EntityKind } from "./kinds.ts";
import type { LapsedCheck } from "./ledger.ts";
import {
  type ChronologyRow,
  type EvidenceRow,
  InvalidInputError,
  type IssueRow,
  type SourceRef,
  type UsedIn,
} from "./publicdb.ts";

export type { UsedIn };
import type { CaseSession } from "./session.ts";
import type { CheckRow, WorkState } from "./states.ts";
import { parseTokens } from "./tokens.ts";

/**
 * Checking Claude's work against its sources (ADR 8 amendment): the app-side glue between the
 * pure checks (`claimcheck.ts`), the ledger and the vault. App only (it takes a `CaseSession`).
 * Everything here reads cited lines from the vault, never public.db.
 */

/** Every line a citation points at, or none if any of them cannot be quoted (fail closed). */
async function fullLines(s: CaseSession, ref: SourceRef) {
  const lines = await s.citedLines(ref.doc_id, ref.line_start, ref.line_end);
  return lines && lines.length === ref.line_end - ref.line_start + 1 ? lines : [];
}

/** Each known role's entity kind. */
export function kindsOf(s: CaseSession): Map<string, EntityKind> {
  return new Map(s.registry.list().map((e) => [e.role, e.kind]));
}

/** The tokenised lines each citation points at, from the vault (empty when not quotable). */
export async function citedFor(s: CaseSession, refs: SourceRef[]): Promise<CitedLines[]> {
  return await Promise.all(
    refs.map(async (ref) => ({
      ref: { doc_id: ref.doc_id, line_start: ref.line_start, line_end: ref.line_end },
      lines: await fullLines(s, ref),
    })),
  );
}

export async function chronologyChecks(s: CaseSession, r: ChronologyRow): Promise<CheckRow[]> {
  const rows = checkClaim(chronologyClaim(r), await citedFor(s, r.sources), kindsOf(s));
  return r.sources.length ? rows : [missingCitation(), ...rows];
}

export async function evidenceChecks(s: CaseSession, e: EvidenceRow): Promise<CheckRow[]> {
  return checkClaim(e.note ?? "", await citedFor(s, [e]), kindsOf(s));
}

/** Checked · Can't check · Changed since you checked · To check, in that order of precedence. */
export function workState(
  o: { verified: boolean; cantCheck: boolean; lapsed: LapsedCheck | null },
): WorkState {
  if (o.verified) return "checked";
  if (o.cantCheck) return "cant_check";
  if (o.lapsed) return "changed";
  return "to_check";
}

export interface ItemCheck {
  verified: boolean;
  state: WorkState;
  checks: CheckRow[];
  lapsed: LapsedCheck | null;
}

export async function chronologyState(s: CaseSession, r: ChronologyRow): Promise<ItemCheck> {
  const verified = await s.ledger.isChronologyVerified(r);
  const checks = await chronologyChecks(s, r);
  const lapsed = verified ? null : await s.ledger.lapsedCheck("chronology", r.id);
  return {
    verified,
    checks,
    lapsed,
    state: workState({ verified, cantCheck: cantCheck(checks), lapsed }),
  };
}

export async function evidenceState(s: CaseSession, e: EvidenceRow): Promise<ItemCheck> {
  const verified = await s.ledger.isEvidenceVerified(e);
  const checks = await evidenceChecks(s, e);
  const lapsed = verified ? null : await s.ledger.lapsedCheck("evidence", e.id);
  return {
    verified,
    checks,
    lapsed,
    state: workState({ verified, cantCheck: cantCheck(checks), lapsed }),
  };
}

/** Labels in an issue's title or description that casefile does not know. */
export function issueUnknownLabels(s: CaseSession, i: IssueRow): string[] {
  const kinds = kindsOf(s);
  return [
    ...new Set(
      parseTokens(`${i.title}\n${i.description ?? ""}`).tokens.filter((t) => !kinds.has(t.role))
        .map((t) => t.raw),
    ),
  ];
}

/** The issue description's state ("describes the question fairly"). */
export async function issueDescState(s: CaseSession, i: IssueRow): Promise<ItemCheck> {
  const verified = await s.ledger.isIssueVerified(i);
  const unknown = issueUnknownLabels(s, i);
  const checks: CheckRow[] = unknown.map((raw) => ({
    kind: "entity",
    text: raw,
    ok: null,
    level: "danger",
    message: `${raw} is a label casefile doesn't know, so it can't be checked.`,
  }));
  const lapsed = verified ? null : await s.ledger.lapsedCheck("issue", i.id);
  return {
    verified,
    checks,
    lapsed,
    state: workState({ verified, cantCheck: unknown.length > 0, lapsed }),
  };
}

// ── document authors (vault only) ──────────────────────────────────────────

/**
 * Vault file of who wrote each document, as the user recorded it in the app:
 * `{ "<doc id>": { role, at } }`. public.db's `author_role` is Claude-writable, so it never
 * decides anything; this record does. Minimal until the documents API records authorship itself
 * (package v3/docs-api): `docAuthor` is the one place that reads it.
 */
export const DOC_AUTHORS_FILE = "document-authors";

interface DocAuthorRecord {
  role: string;
  at: string;
}

/** Who wrote document `docId`, as the user recorded it in the app (vault), or null. */
export async function docAuthor(s: CaseSession, docId: string): Promise<string | null> {
  const all = await s.readVaultJson<Record<string, DocAuthorRecord>>(DOC_AUTHORS_FILE, {});
  const r = Object.hasOwn(all, docId) ? all[docId] : undefined;
  return typeof r?.role === "string" ? r.role : null;
}

/**
 * The user records who wrote document `docId` (a role in Who's who), or clears it (null). Kept in
 * the vault; the log records only that it changed.
 */
export async function setDocAuthor(
  s: CaseSession,
  docId: string,
  role: string | null,
): Promise<void> {
  await s.getDoc(docId); // NotFound for a document the vault doesn't have
  if (role !== null && !s.registry.get(role)) {
    throw new InvalidInputError("The author must be someone in Who's who");
  }
  const all = await s.readVaultJson<Record<string, DocAuthorRecord>>(DOC_AUTHORS_FILE, {});
  if (role === null) delete all[docId];
  else all[docId] = { role, at: new Date().toISOString() };
  await s.writeVaultJson(DOC_AUTHORS_FILE, all);
  s.log("user", "doc_author_set", { doc: docId });
}

/**
 * Keep the authors record in step with who's who, as `relatedTo` is: a renamed role follows
 * (`renamed`), and a record naming a role no longer in who's who is dropped, so it can't attach
 * later to whoever is next given that role. Called by the session whenever who's who is saved.
 */
export async function followDocAuthors(
  s: CaseSession,
  renamed?: { from: string; to: string },
): Promise<void> {
  const all = await s.readVaultJson<Record<string, DocAuthorRecord>>(DOC_AUTHORS_FILE, {});
  let changed = false;
  for (const [doc, r] of Object.entries(all)) {
    if (renamed && r?.role === renamed.from) {
      all[doc] = { ...r, role: renamed.to };
      changed = true;
    } else if (typeof r?.role !== "string" || !s.registry.get(r.role)) {
      delete all[doc];
      changed = true;
    }
  }
  if (changed) await s.writeVaultJson(DOC_AUTHORS_FILE, all);
}

/**
 * "Only source is your own statement": every cited document is the user's own (origin `mine`, in
 * the vault) and the user recorded in the app that they wrote it (`docAuthor`, vault), as the
 * role in `settings.userRole`. public.db's `author_role` is not used: Claude can write it.
 */
export async function ownStatementOnly(s: CaseSession, refs: SourceRef[]): Promise<boolean> {
  const role = s.settings.userRole;
  if (!role || refs.length === 0) return false;
  for (const id of new Set(refs.map((r) => r.doc_id))) {
    let origin;
    try {
      origin = (await s.getDoc(id)).origin;
    } catch {
      return false;
    }
    if (origin !== "mine") return false;
    if (await docAuthor(s, id) !== role) return false;
  }
  return true;
}

/** A draft paragraph that relies on an item. */
/** Union of `usedIn` lists, each paragraph once. */
export function mergeUsedIn(lists: UsedIn[][]): UsedIn[] {
  const seen = new Map<number, UsedIn>();
  for (const u of lists.flat()) if (!seen.has(u.paragraph_id)) seen.set(u.paragraph_id, u);
  return [...seen.values()].sort((a, b) => a.draft_id - b.draft_id || a.n - b.n);
}

/** Ids of the items the user removed (from the vault), by type. */
export async function userRemoved(
  s: CaseSession,
): Promise<{ chronology: Set<number>; evidence: Set<number>; issues: Set<number> }> {
  const out = {
    chronology: new Set<number>(),
    evidence: new Set<number>(),
    issues: new Set<number>(),
  };
  for (const r of s.store.listChronology({ includeRemoved: true })) {
    if (await s.ledger.removedByUser("chronology", r) !== null) out.chronology.add(r.id);
  }
  for (const i of s.store.listIssues({ includeRemoved: true })) {
    if (await s.ledger.removedByUser("issue", i) !== null) out.issues.add(i.id);
    for (const e of s.store.listEvidence(i.id, { includeRemoved: true })) {
      if (await s.ledger.removedByUser("evidence", e) !== null) out.evidence.add(e.id);
    }
  }
  return out;
}
