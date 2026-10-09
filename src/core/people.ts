/**
 * Who's who for the app (ADR 15): groups, colour slots, where each entity appears, what adding a
 * nickname would touch, the relationship description shown to Claude, and search across the case.
 *
 * Everything here reads the vault (originals, replacements, tokenised text) and is for the app's
 * API only. Nothing here writes public.db, and the CLI must not import it (tests/boundary_test.ts).
 */
import {
  checkColour,
  type Entity,
  ENTITY_KINDS,
  type EntityForms,
  type EntityKind,
  EntityRegistry,
  roleTokenRe,
} from "./entities.ts";
import { isValidRole } from "./tokens.ts";
import type { TypedTextRecheck } from "./typedtext.ts";
import { findKnownSpans } from "./detect/pipeline.ts";
import {
  checkSuggestions,
  llmSuggestions,
  type ReviewEntry,
  type ReviewItem,
  type ReviewSuggestion,
  reviewSuggestions,
  ruleSuggestions,
  settle,
  type TidyEntry,
  type TidyOptions,
  type TidyResult,
} from "./detect/tidy.ts";
import { findRuleSpans } from "./detect/rules.ts";
import { foldValue } from "./fold.ts";
import { InvalidInputError, NotFoundError } from "./publicdb.ts";
import type { CaseSession, StoredDoc } from "./session.ts";
import type { DocState } from "./states.ts";
import { findLeaks } from "./tokenise.ts";
import { parseTokens } from "./tokens.ts";

/** Who's who tabs: People · Places & organisations · Numbers & dates. */
export type EntityGroup = "people" | "places" | "numbers";

export const ENTITY_GROUPS: EntityGroup[] = ["people", "places", "numbers"];

const GROUP_OF: Record<EntityKind, EntityGroup> = {
  person: "people",
  place: "places",
  organisation: "places",
  school: "places",
  other: "places",
  address: "numbers",
  phone: "numbers",
  email: "numbers",
  identifier: "numbers",
  date_of_birth: "numbers",
};

export function entityGroup(kind: EntityKind): EntityGroup {
  return GROUP_OF[kind];
}

/**
 * The chip label for a number or date (DESIGN-SPEC §4): `phone`, `email`, `address`, `dob`, and for
 * identifiers the type its role names (`medicare_1` → `medicare`, `file_number`), else `id`.
 * Null for people, places and organisations.
 */
export function idType(e: Pick<Entity, "role" | "kind">): string | null {
  switch (e.kind) {
    case "phone":
    case "email":
    case "address":
      return e.kind;
    case "date_of_birth":
      return "dob";
    case "identifier": {
      const m = /^(medicare|tfn|abn|file_number|acn|licence|passport|crn)(?:_\d+)?$/.exec(e.role);
      return m ? m[1] : "id";
    }
    default:
      return null;
  }
}

/** How many times `role` is named, as a token, in tokenised `text`. */
export function countRole(text: string | null | undefined, role: string): number {
  return text ? [...text.matchAll(roleTokenRe(role))].length : 0;
}

// ── documents ──────────────────────────────────────────────────────────────

function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Every document in the vault, in id order (decrypted; the session caches them). */
async function allDocs(s: CaseSession): Promise<StoredDoc[]> {
  return await Promise.all((await s.listDocs()).map((d) => s.getDoc(d.id)));
}

/**
 * Where each role appears in the documents: a published document's replacements, or a pending
 * one's proposals that name an existing entity. `lines` are 1-based.
 */
function mentionsIn(d: StoredDoc): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const add = (role: string, start: number) => {
    const l = out.get(role) ?? [];
    l.push(lineAt(d.original, start));
    out.set(role, l);
  };
  if (d.status === "published") {
    for (const r of d.replacements) add(r.role, r.start);
  } else {
    for (const p of d.proposals) {
      if (p.proposal.type === "existing") add(p.proposal.role, p.start);
    }
  }
  return out;
}

/** Document and mention counts per role, for the who's who list. */
export async function documentCounts(
  s: CaseSession,
): Promise<Map<string, { docs: number; mentions: number }>> {
  const out = new Map<string, { docs: number; mentions: number }>();
  for (const d of await allDocs(s)) {
    for (const [role, lines] of mentionsIn(d)) {
      const c = out.get(role) ?? { docs: 0, mentions: 0 };
      c.docs++;
      c.mentions += lines.length;
      out.set(role, c);
    }
  }
  return out;
}

/** Lines shown to the language model per entry, and their longest length (ADR 25). */
const TIDY_CONTEXT_LINES = 3;
const TIDY_CONTEXT_CHARS = 240;

/**
 * Who's who as "Tidy up" shows it to the language model (ADR 25): each entry's label, kind, real
 * values, description, and a few original lines where it appears. Vault data: it goes only to the
 * model the user set up under Finding names, and only if that model may have original text.
 */
export async function tidyEntries(s: CaseSession): Promise<TidyEntry[]> {
  const context = new Map<string, string[]>();
  for (const d of await allDocs(s)) {
    const lines = d.original.split("\n");
    for (const [role, at] of mentionsIn(d)) {
      const got = context.get(role) ?? [];
      for (const n of at) {
        if (got.length >= TIDY_CONTEXT_LINES) break;
        const line = (lines[n - 1] ?? "").replace(/\s+/g, " ").trim().slice(0, TIDY_CONTEXT_CHARS);
        if (line && !got.includes(line)) got.push(line);
      }
      context.set(role, got);
    }
  }
  return s.registry.list().map((e) => ({
    role: e.role,
    kind: e.kind,
    values: [e.forms.full, e.forms.first, e.forms.surname, e.forms.title, ...e.aliases]
      .filter((v): v is string => !!v)
      .filter((v, i, all) => all.indexOf(v) === i),
    description: e.description ? s.reidentify(e.description).text : null,
    context: context.get(e.role) ?? [],
  }));
}

/**
 * Suggestions for tidying who's who (ADR 25): from rules always, and from the language model
 * when one is set up. A model that can't be used or fails is reported in `llm.error`; the rules'
 * suggestions still come back. Logged as a count only.
 */
export async function suggestTidy(
  s: CaseSession,
  opts: TidyOptions & { useLlm?: boolean } = {},
): Promise<TidyResult> {
  const entries = await tidyEntries(s);
  const all = checkSuggestions(
    { suggestions: ruleSuggestions(entries) },
    s.registry,
    "rule",
  );
  const llm = s.settings.llm;
  const result: TidyResult = { suggestions: [], llm: { ran: false } };
  if (opts.useLlm !== false && llm && llm.baseUrl.trim() && llm.model.trim() && entries.length) {
    try {
      all.push(...await llmSuggestions(llm, entries, s.registry, opts));
      result.llm = { ran: true };
    } catch (e) {
      result.llm = { ran: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else if (opts.useLlm !== false) {
    result.llm = { ran: false, error: "No language model is set up under Finding names." };
  }
  result.suggestions = settle(all);
  s.store.log("app", "entity_suggestions", {
    suggestions: result.suggestions.length,
    llm: result.llm.ran,
  });
  return result;
}

/**
 * Suggestions for a document still under review (ADR 25 amendment): for each new finding, whether
 * it is someone already listed or another finding written differently, what to call it, or that
 * it identifies no one. The language model reads the whole original document. Nothing changes
 * until the user accepts a suggestion on the review screen and shares the document.
 */
export async function suggestForReview(
  s: CaseSession,
  docId: string,
  opts: TidyOptions & { useLlm?: boolean } = {},
): Promise<{ suggestions: ReviewSuggestion[]; llm: { ran: boolean; error?: string } }> {
  const doc = await s.getDoc(docId);
  if (doc.status === "published") {
    throw new InvalidInputError("This document is already shared. Use Tidy up in People instead.");
  }
  const used = new Set<string>();
  for (const p of doc.proposals) {
    if (p.proposal.type === "new") used.add(p.proposal.key);
    if (p.proposal.type === "ambiguous") {
      for (const o of p.proposal.options) if (o.isNew) used.add(o.ref);
    }
  }
  const items: ReviewItem[] = doc.newEntities.filter((n) => used.has(n.key)).map((n, i) => ({
    id: `n${i + 1}`,
    key: n.key,
    kind: n.kind,
    value: n.full,
    label: n.roleHint ?? "",
  }));
  const known: ReviewEntry[] = s.registry.list().map((e) => ({
    role: e.role,
    kind: e.kind,
    values: [e.forms.full, e.forms.first, e.forms.surname, e.forms.title, ...e.aliases]
      .filter((v): v is string => !!v),
    description: e.description ? s.reidentify(e.description).text : null,
  }));
  // A value that hides someone else's, or that a rule always replaces, is never "left as written".
  const knownIn = (v: string) =>
    findKnownSpans(v, s.registry, { leak: true }).length > 0 || findRuleSpans(v).length > 0;
  const r = await reviewSuggestions(
    s.settings.llm,
    doc.original,
    items,
    known,
    s.registry,
    knownIn,
    opts,
  );
  s.store.log("app", "review_suggestions", {
    doc: doc.id,
    suggestions: r.suggestions.length,
    llm: r.llm.ran,
  });
  return r;
}

function getEntity(s: CaseSession, role: string): Entity {
  const e = s.registry.get(role);
  if (!e) throw new NotFoundError(`person or place "${role}"`);
  return e;
}

/** "Where she appears": documents, chronology, issues and draft paragraphs naming `role`. */
export async function roleUsage(s: CaseSession, role: string) {
  getEntity(s, role);
  const documents = [];
  for (const d of await allDocs(s)) {
    const lines = mentionsIn(d).get(role);
    if (!lines) continue;
    documents.push({
      id: d.id,
      title: d.title,
      state: s.docState(d),
      mentions: lines.length,
      lines: [...new Set(lines)].sort((a, b) => a - b),
    });
  }
  const chronology = s.store.listChronology()
    .filter((c) => countRole(c.description, role) > 0)
    .map((c) => ({ id: c.id, event_date: c.event_date, description: c.description }));
  const issues = s.store.listIssues()
    .filter((i) => countRole(i.title, role) + countRole(i.description, role) > 0)
    .map((i) => ({ id: i.id, title: i.title }));
  const paragraphs = [];
  for (const dr of s.store.listDrafts()) {
    for (const p of s.store.listParagraphs(dr.id)) {
      if (countRole(p.body, role) > 0) {
        paragraphs.push({ id: p.id, draft_id: dr.id, draftTitle: dr.title, n: p.position });
      }
    }
  }
  return {
    role,
    documents,
    chronology,
    issues,
    paragraphs,
    totals: {
      documents: documents.length,
      mentions: documents.reduce((n, d) => n + d.mentions, 0),
      chronology: chronology.length,
      issues: issues.length,
      paragraphs: paragraphs.length,
    },
  };
}

/** One document `aliasImpact` found the nickname in. */
export interface AliasHit {
  id: string;
  title: string;
  state: DocState;
  /** Occurrences in the original. */
  count: number;
  lines: number[];
  /** Occurrences Claude can read as written right now (shared, outside any replacement). */
  visible: number;
}

/**
 * What adding (or removing) nickname `alias` for `role` touches: the documents whose originals
 * contain it, split by state, using the same matcher as the leak check. A shared document with
 * `visible > 0` would be exposed by adding it. `clash` lists other entities the text already
 * means.
 */
export async function aliasImpact(s: CaseSession, role: string, alias: string) {
  getEntity(s, role);
  const a = alias.replace(/\s+/g, " ").trim();
  if (a.length < 2) throw new InvalidInputError("A nickname needs at least two characters");
  const probe = new EntityRegistry([{
    role: "alias",
    kind: "other",
    forms: { full: a },
    aliases: [],
  }]);
  const clash = s.registry.candidates(a).map((c) => c.entity.role).filter((r) => r !== role);
  const shared: AliasHit[] = [];
  const pending: AliasHit[] = [];
  const withheld: AliasHit[] = [];
  for (const d of await allDocs(s)) {
    const spans = findKnownSpans(d.original, probe);
    if (!spans.length) continue;
    const state = s.docState(d);
    let visible = 0;
    if (state === "shared" && d.tokenised !== undefined) {
      const tokens = parseTokens(d.tokenised).tokens;
      visible = findKnownSpans(d.tokenised, probe)
        .filter((sp) => !tokens.some((t) => sp.start < t.end && t.start < sp.end)).length;
    }
    const hit: AliasHit = {
      id: d.id,
      title: d.title,
      state,
      count: spans.length,
      lines: [...new Set(spans.map((sp) => lineAt(d.original, sp.start)))].sort((x, y) => x - y),
      visible,
    };
    (state === "needs_review" ? pending : state === "withheld" ? withheld : shared).push(hit);
  }
  return {
    role,
    alias: a,
    known: s.registry.get(role)!.aliases.some((x) => foldValue(x) === foldValue(a)),
    clash,
    shared,
    pending,
    withheld,
    wouldExpose: shared.filter((h) => h.visible > 0).map((h) => h.id),
    total: shared.length + pending.length + withheld.length,
  };
}

// ── the relationship description ───────────────────────────────────────────

export const DESCRIPTION_MAX = 300;

const DESCRIPTION_NAMES =
  "Claude reads this description, so it can't contain a name, nickname or number. " +
  "Describe the relationship instead, e.g. \u201Cthe children\u2019s maternal grandmother\u201D.";

/**
 * Check and tokenise a relationship description (ADR 15). It is published to
 * `entities.description`, so Claude reads it: it must not contain any real name, nickname,
 * identifying part or number, even one casefile could replace with a token. Known values and
 * identifier-like text are refused outright (tokenising "Anna's mother" would hand Claude
 * `{{mother.first}}`'s mother, which says the description was about a name); then the text goes
 * through `tokeniseUserText`, whose detectors refuse names not yet in who's who. Tokens the user
 * types (`{{child_1}}`) are allowed if they are known. Returns null for an empty description.
 *
 * `registry` is who's who as it will be once the change this description is part of is applied
 * (`changeEntity`): a nickname or name added in the same change must count as known. The text is
 * checked against it *and* the current registry (a value being removed is still a value).
 */
export async function checkDescription(
  s: CaseSession,
  text: string,
  registry: EntityRegistry = s.registry,
): Promise<string | null> {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > DESCRIPTION_MAX) {
    throw new InvalidInputError(`Keep the description under ${DESCRIPTION_MAX} characters`);
  }
  if (findLeaks(t, registry).length || findLeaks(t, s.registry).length) {
    throw new InvalidInputError(DESCRIPTION_NAMES);
  }
  const out = await s.tokeniseUserText(t);
  // Belt and braces: whatever tokenising did, the result must name nothing as plain text.
  if (findLeaks(out, registry).length) {
    throw new InvalidInputError("Claude reads this description, so it can't contain a name.");
  }
  const parsed = parseTokens(out);
  const unknown = parsed.tokens.filter((x) => !registry.get(x.role)).map((x) => x.raw);
  if (unknown.length || parsed.malformed.length) {
    throw new InvalidInputError(
      `Unknown label(s) in the description: ${
        [...unknown, ...parsed.malformed.map((m) => m.raw)].join(", ")
      }`,
    );
  }
  return out;
}

/** A change to one entity, as the user asked for it (`PATCH /api/entities/:role`). */
export interface EntityChange extends Partial<EntityForms> {
  /** New role name (public: checked like any role name). */
  role?: string;
  kind?: EntityKind;
  aliases?: string[];
  colour?: number | null;
  safety?: boolean;
  /** Untokenised text as the user typed it; null or "" clears it. */
  description?: string | null;
  /** The person this detail belongs to (a role), or null to unlink. Vault only (ADR 15, am. 3). */
  relatedTo?: string | null;
}

/** Role names end in at most a short number ("child_2"); a long digit run could carry an ID. */
const LONG_DIGITS = /\d{4,}/;

/**
 * Run `fn` under the session's entity lock (`CaseSession.withEntityLock`): after every change to
 * who's who already queued, and before any queued later. `changeEntity` holds it from its first
 * check to its last write; publish, renames and entity updates take the same lock, so two changes
 * can never be checked against each other's "before" and a publish never swaps in a stale copy.
 */
export function withEntityLock<T>(s: CaseSession, fn: () => Promise<T>): Promise<T> {
  return s.withEntityLock(fn);
}

/** What a change will do, worked out (synchronously) against who's who as it is right now. */
interface ChangePlan {
  target: string;
  rest: Omit<EntityChange, "role" | "description">;
  descriptionsCleared: string[];
}

/**
 * Check `change` against the session's registry as it is at this moment, without awaiting: apply
 * it to a copy, then check every field that reaches public.db against the copy (and the current
 * registry). `description`, if given, is checked as text that will be stored as it is. Throws on
 * any problem. Because it never awaits, a caller that writes in the same tick writes exactly what
 * was checked.
 */
function planChange(
  s: CaseSession,
  role: string,
  change: EntityChange,
): ChangePlan & { copy: EntityRegistry } {
  getEntity(s, role);
  const copy = new EntityRegistry(s.registry.toJSON());
  const before = new Map(s.registry.list().map((e) => [e.role, s.registry.revealingWords(e.role)]));

  // Field types and values.
  if (change.kind !== undefined && !(ENTITY_KINDS as readonly string[]).includes(change.kind)) {
    throw new InvalidInputError(`Bad kind; one of ${ENTITY_KINDS.join(", ")}`);
  }
  if (change.colour !== undefined) {
    try {
      checkColour(change.colour);
    } catch (e) {
      throw new InvalidInputError((e as Error).message);
    }
  }
  if (change.safety !== undefined && typeof change.safety !== "boolean") {
    throw new InvalidInputError("safety must be true or false");
  }
  if (
    change.relatedTo !== undefined && change.relatedTo !== null &&
    (typeof change.relatedTo !== "string" || !isValidRole(change.relatedTo))
  ) {
    throw new InvalidInputError("relatedTo must be someone in who’s who, or null");
  }

  // The change, on the copy.
  let target = role;
  if (change.role !== undefined && change.role !== role) {
    const r = change.role;
    if (!isValidRole(r)) {
      throw new InvalidInputError(
        `Role names use lower-case letters, digits and _, starting with a letter`,
      );
    }
    if (LONG_DIGITS.test(r)) {
      throw new InvalidInputError(
        `Role names are visible to Claude, so they can only end in a short number like "child_2"`,
      );
    }
    if (copy.get(r)) throw new InvalidInputError(`The role name "${r}" is already used`);
    copy.rename(role, r);
    target = r;
  }
  const { role: _r, description, ...rest } = change;
  copy.update(target, rest); // a taken colour throws ColourTakenError here, before any write

  // Links between people and their details, as they will be (a kind change can break one).
  const linkProblems = copy.linkProblems().filter((p) => !s.registry.linkProblems().includes(p));
  if (linkProblems.length) {
    const e = copy.get(target)!;
    throw new InvalidInputError(
      e.kind === "person" && copy.linkedTo(target).length && change.kind
        ? `Details belong to this person (${
          copy.linkedTo(target).map((x) => x.role).join(", ")
        }). Unlink them before changing what kind of entry this is.`
        : e.kind === "person" && e.relatedTo
        ? "A person can’t belong to someone else. Link their address or number to them instead."
        : `Choose a person for this to belong to (${linkProblems[0]}).`,
    );
  }

  // Role names, as they will be.
  for (const e of copy.list()) {
    const was = e.role === target ? [] : before.get(e.role) ?? [];
    const now = copy.revealingWords(e.role).filter((w) => !was.includes(w));
    if (now.length) {
      throw new InvalidInputError(
        e.role === target && target !== role
          ? `The role name "${target}" contains "${now.join(", ")}", which is part of a real ` +
            `value. Role names are visible to Claude; use a relationship like "mother" or ` +
            `"maternal_grandmother".`
          : `This would make the role name "${e.role}" give away "${now.join(", ")}". ` +
            `Role names are visible to Claude: rename "${e.role}" first.`,
      );
    }
  }

  // The description, against who's who as it will be (and as it is).
  if (description !== undefined) {
    if (description !== null && typeof description !== "string") {
      throw new InvalidInputError("description must be text");
    }
    const d = description === null ? "" : description.replace(/\s+/g, " ").trim();
    if (d) {
      if (findLeaks(d, copy).length || findLeaks(d, s.registry).length) {
        throw new InvalidInputError(DESCRIPTION_NAMES);
      }
      const parsed = parseTokens(d);
      const unknown = parsed.tokens.filter((x) => !copy.get(x.role)).map((x) => x.raw);
      if (unknown.length || parsed.malformed.length) {
        throw new InvalidInputError(
          `Unknown label(s) in the description: ${
            [...unknown, ...parsed.malformed.map((m) => m.raw)].join(", ")
          }`,
        );
      }
    }
    copy.update(target, { description: d || null });
  }

  // Descriptions already published that would now name someone are withdrawn.
  const descriptionsCleared = copy.list()
    .filter((e) => e.description && findLeaks(e.description, copy).length)
    .map((e) => e.role);
  return { copy, target, rest, descriptionsCleared };
}

/**
 * Change an entity: rename it, change its forms, nicknames, kind, colour, safety flag or
 * description. The one path the app uses (ADR 15), so every rule applies to every field:
 *
 * - The whole change is applied first to a copy of who's who, and every check runs against the copy
 *   (who's who as it will be), so a nickname, name or role added in the same request counts.
 * - What reaches public.db is checked: the new role name (valid, no long numbers, no word of any
 *   value as it will be), every *other* role name (a new value must not make one revealing), the
 *   kind (one of `ENTITY_KINDS`) and the description (`checkDescription`).
 * - A description already published that names someone once the change is applied (e.g. "Annie's ex"
 *   before "Annie" was added as a nickname) is withdrawn in the same save; its roles are returned in
 *   `descriptionsCleared` so the user can be told.
 * - Nothing is written unless every check passes.
 * - Races: changes run one at a time (`withEntityLock`), and because the checks await (detectors,
 *   the rename), they are run again synchronously against the registry as it then is,
 *   immediately before each write, so a publish or import that changed who's who meanwhile is
 *   caught and the change refused.
 */
export function changeEntity(
  s: CaseSession,
  role: string,
  change: EntityChange,
): Promise<{ role: string; descriptionsCleared: string[]; typedText: TypedTextRecheck | null }> {
  return withEntityLock(s, async () => {
    // 1. Check everything against who's who as it will be.
    const first = planChange(s, role, change);
    // 2. The detectors (awaits): new names not yet in who's who.
    let desc: string | null | undefined = undefined;
    if (change.description !== undefined) {
      desc = change.description === null
        ? null
        : await checkDescription(s, change.description, first.copy);
    }
    const final: EntityChange = { ...change };
    if (desc !== undefined) final.description = desc;
    let current = role;
    // 3. Rename (awaits). Re-checked in the same tick as the rename's own synchronous part.
    if (first.target !== role) {
      planChange(s, role, final);
      const renaming = s.renameEntity(role, first.target);
      current = first.target;
      await renaming;
    }
    // 4. Re-check against who's who as it is now, and write in the same tick.
    const { role: _r, ...afterRename } = final;
    const plan = planChange(s, current, afterRename);
    for (const r of plan.descriptionsCleared) {
      if (r !== current) s.registry.update(r, { description: null });
    }
    const patch: Parameters<CaseSession["updateEntity"]>[1] = { ...plan.rest };
    if (desc !== undefined) patch.description = desc;
    if (plan.descriptionsCleared.includes(current)) patch.description = null;
    let typedText: TypedTextRecheck | null = null;
    if (Object.keys(patch).length || plan.descriptionsCleared.length) {
      // `updateEntity` changes the registry before its first await, so this is the state checked.
      typedText = await s.updateEntity(current, patch);
    }
    return { role: current, descriptionsCleared: plan.descriptionsCleared, typedText };
  });
}

// ── search ─────────────────────────────────────────────────────────────────

export interface SearchOptions {
  offset?: number;
  limit?: number;
}

/** Folded words of a query; a line matches when it contains every one. */
function queryWords(q: string): string[] {
  return foldValue(q).split(/\s+/).filter(Boolean);
}

function matches(words: string[], ...texts: (string | null | undefined)[]): boolean {
  const hay = texts.filter(Boolean).map((t) => foldValue(t!)).join("\n");
  return words.every((w) => hay.includes(w));
}

/**
 * Search the whole case with real names (for the app's ⌘K): every document line in the vault
 * (published documents' text with names shown, pending documents' originals), who's who,
 * chronology and issues. `totals` count every match; only the lines are paged.
 * `show` re-identifies tokenised text.
 */
export async function searchAll(s: CaseSession, q: string, opts: SearchOptions = {}) {
  const words = queryWords(q);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const empty = { lines: 0, people: 0, chronology: 0, issues: 0 };
  if (!words.length) {
    return {
      q,
      total: 0,
      totals: empty,
      offset,
      limit,
      lines: [],
      people: [],
      chronology: [],
      issues: [],
    };
  }
  const lines: {
    doc_id: string;
    line: number;
    tokenised: string | null;
    plain: string;
    docTitle: string;
    docState: DocState;
  }[] = [];
  for (const d of await allDocs(s)) {
    const state = s.docState(d);
    const tok = d.status === "published" && d.tokenised !== undefined
      ? d.tokenised.split("\n")
      : null;
    const orig = d.original.split("\n");
    const n = tok ? tok.length : orig.length;
    for (let i = 0; i < n; i++) {
      const plain = tok ? s.reidentify(tok[i]).text : orig[i];
      if (matches(words, plain)) {
        lines.push({
          doc_id: d.id,
          line: i + 1,
          tokenised: tok ? tok[i] : null,
          plain,
          docTitle: d.title,
          docState: state,
        });
      }
    }
  }
  const people = s.registry.list().filter((e) =>
    matches(
      words,
      e.role,
      e.forms.full,
      e.forms.first,
      e.forms.surname,
      e.forms.title,
      ...e.aliases,
    )
  ).map((e) => ({
    role: e.role,
    kind: e.kind,
    group: entityGroup(e.kind),
    name: e.forms.full,
    colour: e.colour ?? null,
  }));
  const chronology = s.store.listChronology().filter((c) =>
    matches(words, c.event_date, s.reidentify(c.description).text)
  ).map((c) => ({ id: c.id, event_date: c.event_date, description: c.description }));
  const issues = s.store.listIssues().filter((i) =>
    matches(words, s.reidentify(i.title).text, s.reidentify(i.description).text)
  ).map((i) => ({ id: i.id, title: i.title }));
  const totals = {
    lines: lines.length,
    people: people.length,
    chronology: chronology.length,
    issues: issues.length,
  };
  return {
    q,
    total: totals.lines + totals.people + totals.chronology + totals.issues,
    totals,
    offset,
    limit,
    lines: lines.slice(offset, offset + limit),
    people,
    chronology,
    issues,
  };
}
