import type { CaseSession } from "./session.ts";
import type { Exposure } from "./states.ts";
import { findKnownSpans } from "./detect/pipeline.ts";
import type { Span } from "./detect/types.ts";
import { normaliseVariant } from "./entities.ts";
import { parseTokens } from "./tokens.ts";

/**
 * Exposures (ADR 7): shared documents found to show a known name or number, withdrawn, and what
 * Claude read through casefile meanwhile. Kept in the vault file `exposures`.
 *
 * A document is checked for names when it is shared (the leak check, ADR 6). A value the case only
 * learns later — a nickname added as an alias, a person found in another document — can already be
 * sitting, as written, in a document Claude has. Every change to who's who therefore re-checks
 * every shared document (`withdrawExposed`): any that now shows a known value is withdrawn at once
 * (its text leaves public.db), and an exposure is recorded here, in the vault. Nothing about the
 * value goes into the AI-use log: the log row names only the document and the reason.
 */

/** Vault file holding the exposures (a JSON array of `Exposure`, oldest first). */
export const EXPOSURES_FILE = "exposures";

export async function listExposures(session: CaseSession): Promise<StoredExposure[]> {
  return await session.readVaultJson<StoredExposure[]>(EXPOSURES_FILE, []);
}

/**
 * The values that triggered exposure `e` (app only). Exposures recorded before triggers were
 * kept are worked out again from the document's stored text while it is still withdrawn.
 */
export async function exposureTriggers(
  session: CaseSession,
  e: StoredExposure,
): Promise<ExposureTrigger[]> {
  if (e.triggers) return e.triggers;
  try {
    const doc = await session.getDoc(e.doc);
    if (!doc.exposure) return [];
    return sortTriggers([
      ...exposedValues(session, doc.tokenised ?? "", doc.ignore),
      ...exposedValues(session, doc.tokenisedTitle ?? "", doc.ignore),
    ]);
  } catch {
    return [];
  }
}

/**
 * Which known value made a document an exposure, for the app only (e.g. `{role: "mother", kind:
 * "alias", value: "Annie"}`: "a nickname you added: Annie"). It holds a real value, so it is kept in
 * the vault's `exposures` file and shown to the user; it is never logged and never reaches
 * public.db.
 */
export interface ExposureTrigger {
  role: string;
  /** Which of the person's values it is: a nickname or other spelling, a name form, or a part. */
  kind: "alias" | "full" | "first" | "surname" | "title" | "part";
  /** The value as who's who has it (not as written in the document). */
  value: string;
}

/** An exposure as kept in the vault: with the values that triggered it (app only). */
export type StoredExposure = Exposure & { triggers?: ExposureTrigger[] };

/** How sure a trigger is the one the user would recognise first: nicknames, then names. */
const TRIGGER_ORDER: ExposureTrigger["kind"][] = [
  "alias",
  "full",
  "first",
  "surname",
  "title",
  "part",
];

/**
 * Known values that appear as written (outside tokens, not left as written by the user) in
 * `tokenised`, one per role and value, nicknames first. Includes leak-only parts (a middle name,
 * a street). App only: these are real values.
 */
export function exposedValues(
  session: CaseSession,
  tokenised: string,
  ignore: Iterable<string>,
): ExposureTrigger[] {
  const ignored = new Set(session.honouredIgnore(ignore).map(normaliseVariant));
  const tokens = parseTokens(tokenised).tokens;
  const spans: ExposureTrigger[] = [];
  for (const s of findKnownSpans(tokenised, session.registry, { leak: true })) {
    if (tokens.some((t) => s.start < t.end && t.start < s.end)) continue;
    if (ignored.has(normaliseVariant(s.text))) continue;
    const trigger = triggerOf(session, s);
    if (trigger) spans.push(trigger);
  }
  return sortTriggers(spans);
}

/** Which of a person's values a known-value span is (app only). */
function triggerOf(session: CaseSession, s: Span): ExposureTrigger | null {
  const [role, form] = (s.label ?? "").split(".");
  if (!role) return null;
  const e = session.registry.get(role);
  const folded = normaliseVariant(s.text);
  const alias = e?.aliases.find((a) => normaliseVariant(a) === folded);
  if (alias !== undefined) return { role, kind: "alias", value: alias };
  if (form === "part") return { role, kind: "part", value: s.text };
  const kind = (["full", "first", "surname", "title"] as const).find((f) => f === form) ?? "full";
  return { role, kind, value: kind === "title" ? s.text : e?.forms[kind] ?? s.text };
}

/** One per role and value, nicknames first. */
function sortTriggers(list: ExposureTrigger[]): ExposureTrigger[] {
  const out = new Map<string, ExposureTrigger>();
  for (const t of list) {
    const key = `${t.role}:${normaliseVariant(t.value)}`;
    if (!out.has(key)) out.set(key, t);
  }
  return [...out.values()].sort((a, b) =>
    TRIGGER_ORDER.indexOf(a.kind) - TRIGGER_ORDER.indexOf(b.kind) ||
    a.role.localeCompare(b.role) || a.value.localeCompare(b.value)
  );
}

/**
 * Roles whose known values appear as written (outside tokens, not left as written by the user) in
 * `tokenised`. Includes leak-only parts (a middle name, a street).
 */
export function exposedRoles(
  session: CaseSession,
  tokenised: string,
  ignore: Iterable<string>,
): string[] {
  return [...new Set(exposedValues(session, tokenised, ignore).map((t) => t.role))].sort();
}

/**
 * Re-check every shared document against who's who as it is now (run after every change to it).
 * Each shared document that now shows a known value is withdrawn at once and an exposure is
 * recorded; pending documents with new matches are detected again. `skip`: a document being
 * published right now (its own publish checks it). A document that cannot be read or checked is
 * withdrawn from public.db (fail closed) and listed in `failed` (logged, by id only).
 */
/** Vault file: the documents the last exposure check could not read (app only). */
export const EXPOSURE_CHECK_FAILED_FILE = "exposure-check-failed";

export async function withdrawExposed(
  session: CaseSession,
  opts: { skip?: string; pending?: boolean } = {},
): Promise<{ withdrawn: string[]; newMatchesIn: string[]; failed: string[] }> {
  const now = new Date().toISOString();
  const withdrawn: {
    doc: string;
    roles: string[];
    triggers: ExposureTrigger[];
    sharedAt: string;
  }[] = [];
  const pending: string[] = [];
  const failed: string[] = [];
  // Each document on its own: one that cannot be read must not stop the others being checked.
  const ids = (await session.vault.list("doc-")).map((n) => n.slice(4).toUpperCase()).sort();
  for (const id of ids) {
    const d = { id };
    if (d.id === opts.skip) continue;
    try {
      const doc = await session.getDoc(d.id);
      if (doc.status !== "published") {
        pending.push(d.id);
        continue;
      }
      if (doc.exposure) continue; // already withdrawn
      // Only documents Claude can read now are exposures. One withheld because of where it came
      // from stays withheld; `publishedView` re-runs the leak check before it could be shared.
      if (session.originView(doc) !== null) continue;
      if (!session.docLeaks(doc).length) continue;
      const triggers = sortTriggers([
        ...exposedValues(session, doc.tokenised ?? "", doc.ignore),
        ...exposedValues(session, doc.tokenisedTitle ?? "", doc.ignore),
      ]);
      const roles = [...new Set(triggers.map((t) => t.role))].sort();
      // Keep its details in the vault while it is withdrawn (ADR 7); re-sharing restores them.
      session.holdDetails(doc);
      doc.exposure = { foundAt: now, roles };
      // Withdraw from public.db first: if recording it in the vault fails, Claude still has
      // nothing (and the leak check in `publishedView` keeps it withheld on the next open).
      session.republish(doc);
      session.log("app", "document_withdrawn", { doc: doc.id, reason: "exposed" });
      withdrawn.push({
        doc: doc.id,
        roles,
        triggers,
        sharedAt: doc.sharedAt ?? doc.publishedAt ?? now,
      });
      await session.saveDoc(doc);
    } catch {
      // Fail closed: a document that could not be checked is taken from Claude.
      failed.push(d.id);
      if (session.store.hasDocument(d.id)) {
        const row = session.store.getDocument(d.id);
        if (row.body !== null) {
          session.store.publishDocument({
            id: d.id,
            title: "[withheld: being re-checked]",
            body: null,
            sensitivity: row.sensitivity,
            withheld_reason: "exposed",
          });
        }
      }
    }
  }
  // Pending documents: anything known that is not yet proposed is a new match; detect again.
  const newMatchesIn: string[] = [];
  for (const id of opts.pending === false ? [] : pending) {
    try {
      const doc = await session.getDoc(id);
      const ignored = new Set(session.honouredIgnore(doc.ignore ?? []).map(normaliseVariant));
      const fresh = findKnownSpans(doc.original, session.registry).filter((s) =>
        !ignored.has(normaliseVariant(s.text)) &&
        !doc.proposals.some((p) =>
          p.proposal.type === "existing" && p.start <= s.start && s.end <= p.end
        )
      );
      if (!fresh.length) continue;
      const after = await session.redetect(id);
      // What was newly found, for the Documents list ("New match: a nickname you added: Annie").
      // App only: vault, never logged.
      after.newMatch = {
        foundAt: now,
        values: sortTriggers(
          fresh.map((s) => triggerOf(session, s)).filter((t): t is ExposureTrigger => !!t),
        ),
        exposed: withdrawn.map((w) => w.doc),
      };
      await session.saveDoc(after);
      newMatchesIn.push(id);
    } catch {
      failed.push(id);
    }
  }
  if (withdrawn.length) {
    const all = await listExposures(session);
    for (const w of withdrawn) {
      all.push({
        doc: w.doc,
        roles: w.roles,
        sharedAt: w.sharedAt,
        foundAt: now,
        withdrawnAt: now,
        resharedAt: null,
        claudeReads: session.store.claudeReadsOf(w.doc, w.sharedAt, now),
        newMatchesIn,
        // Vault only (app): never logged, never in public.db.
        triggers: w.triggers,
      });
    }
    await session.writeVaultJson(EXPOSURES_FILE, all);
  }
  // Counts only in the log: Claude can read it, and which documents (often ones withheld from
  // Claude) show a value the user just added is itself identifying. The ids stay in the vault.
  if (newMatchesIn.length) {
    session.log("app", "documents_redetected", { count: newMatchesIn.length });
  }
  if (failed.length) {
    await session.writeVaultJson(EXPOSURE_CHECK_FAILED_FILE, { at: now, docs: failed });
    session.log("app", "exposure_check_failed", { count: failed.length });
  }
  return { withdrawn: withdrawn.map((w) => w.doc), newMatchesIn, failed };
}

/** A withdrawn document is shared again: close its open exposures. */
export async function markReshared(session: CaseSession, docId: string): Promise<void> {
  const all = await listExposures(session);
  const now = new Date().toISOString();
  let changed = false;
  for (const e of all) {
    if (e.doc === docId && e.resharedAt === null) {
      e.resharedAt = now;
      changed = true;
    }
  }
  if (changed) await session.writeVaultJson(EXPOSURES_FILE, all);
}

/**
 * A role renamed in who's who: the exposure records name it by its new role. They are history,
 * so a removed role is kept as it was.
 */
export async function renameInExposures(
  session: CaseSession,
  from: string,
  to: string,
): Promise<void> {
  const all = await listExposures(session);
  let changed = false;
  for (const e of all) {
    if (e.roles.includes(from)) {
      e.roles = e.roles.map((r) => r === from ? to : r);
      changed = true;
    }
    for (const t of e.triggers ?? []) {
      if (t.role === from) {
        t.role = to;
        changed = true;
      }
    }
  }
  if (changed) await session.writeVaultJson(EXPOSURES_FILE, all);
}
