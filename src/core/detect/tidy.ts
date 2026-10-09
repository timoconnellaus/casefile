import type { EntityKind } from "../kinds.ts";
import { type EntityRegistry, normaliseVariant } from "../entities.ts";
import { isValidRole } from "../tokens.ts";
import { harmlessShape } from "./rules.ts";
import { chunkText } from "./chunk.ts";
import {
  ChatCompletions,
  classifyEndpoint,
  extractJson,
  type FetchFn,
  LlmDetector,
  type LlmEndpointSettings,
  sanitiseRole,
} from "./llm.ts";

/**
 * "Tidy up who's who" (ADR 25): suggestions to merge entries that are one person or place written
 * two ways, to give entries a label that says who they are to the case, and to stop replacing
 * entries that identify no one (a time of day). Some come from rules, the rest from the language
 * model the user set up under Finding names, which reads the entries' real values and a few lines
 * around them, under the same rules as the name pass (ADR 12: local only unless allowed).
 *
 * Suggestions only: nothing changes until the user accepts one, and every accepted one goes
 * through the same checks as doing it by hand (`mergeEntity`, `changeEntity`, `removeEntity`).
 * Suggestions and their reasons are shown in the app only; they are never written to public.db.
 */

export type TidySuggestion =
  | { type: "merge"; from: string; into: string; why: string; source: TidySource }
  | { type: "rename"; role: string; to: string; why: string; source: TidySource }
  | { type: "remove"; role: string; why: string; source: TidySource };

export type TidySource = "rule" | "llm";

/** One entry as the model sees it: its label, kind, values, and lines where it appears. */
export interface TidyEntry {
  role: string;
  kind: EntityKind;
  values: string[];
  description?: string | null;
  context: string[];
}

export interface TidyResult {
  suggestions: TidySuggestion[];
  /** Whether the language model was asked, and why not or what went wrong. */
  llm: { ran: boolean; error?: string };
}

// ── rules ──────────────────────────────────────────────────────────────────

export { harmlessShape };

/** A person's name as a set of words, ignoring order, case, commas and titles. */
function nameKey(value: string): string {
  return normaliseVariant(value)
    .replace(/[,.]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(mr|mrs|ms|miss|mx|dr|prof|master)$/.test(w))
    .sort()
    .join(" ");
}

/**
 * Whether two people's values are one name: the same words in another order or case ("OKAFOR,
 * Daniel"), or one full name inside the other (a middle name added). Names of one word are never
 * enough. Returns the reason, or null.
 */
function sameName(a: string[], b: string[]): string | null {
  const words = (vs: string[]) =>
    vs.map(nameKey).filter((k) => k.includes(" ")).map((k) => k.split(" "));
  for (const x of words(a)) {
    for (const y of words(b)) {
      if (x.join(" ") === y.join(" ")) {
        return "The same name, written in a different order or with different capitals.";
      }
      const [short, long] = x.length < y.length ? [x, y] : [y, x];
      if (short.length >= 2 && short.every((w) => long.includes(w))) {
        return "One name is the other with a middle name added.";
      }
    }
  }
  return null;
}

const GENERIC_ROLE = /^[a-z]+(?:_[a-z]+)*_\d+$/;

/** Suggestions that need no model: harmless shapes, and one name written in two word orders. */
export function ruleSuggestions(entries: TidyEntry[]): TidySuggestion[] {
  const out: TidySuggestion[] = [];
  for (const e of entries) {
    const why = harmlessShape(e.values[0] ?? "", e.kind);
    if (why && e.values.every((v) => harmlessShape(v, e.kind))) {
      out.push({ type: "remove", role: e.role, why, source: "rule" });
    }
  }
  const people = entries.filter((e) => e.kind === "person");
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i];
      const b = people[j];
      const why = sameName(a.values, b.values);
      if (!why) continue;
      // Keep the entry with the meaningful label; fold the generic one into it.
      const [from, into] = GENERIC_ROLE.test(a.role) && !GENERIC_ROLE.test(b.role)
        ? [a, b]
        : [b, a];
      out.push({
        type: "merge",
        from: from.role,
        into: into.role,
        why,
        source: "rule",
      });
    }
  }
  return out;
}

// ── the language model ─────────────────────────────────────────────────────

export const TIDY_PROMPT = `You tidy the list of people, places and details found in an Australian
family-law case. Each entry has a label (role), a kind, the ways it is written (values) and a few
lines where it appears. Reply with JSON only, in exactly this shape:
{"suggestions":[
 {"type":"merge","from":"<role>","into":"<role>","why":"..."},
 {"type":"rename","role":"<role>","to":"<new_role>","why":"..."},
 {"type":"remove","role":"<role>","why":"..."}
]}

merge: two entries are the same person, place, school, organisation or detail written differently
("OKAFOR, Daniel" and "Daniel Okafor"; "Dan" and "Daniel Okafor"; a suburb and the same suburb in
capitals). "into" is the entry to keep: prefer the one whose label already says who it is. Never
merge two different people, such as a parent and a child who share a surname.

rename: the label does not say who the entry is to the case (person_3, org_2, other_1, mother_2).
"to" is a short snake_case relationship such as mother, father, child_1, maternal_grandmother,
fathers_partner, childrens_school, mothers_employer, family_doctor, family_home, mothers_lawyer.
It must describe the relationship only and must NEVER contain any word of any value. Only suggest
a rename when the lines make the relationship clear.

remove: the entry identifies no one and was flagged by mistake: a time, an ordinary date, an
amount, a heading, a court or a government agency. Never suggest removing a name, an address, a
phone number, an email, an identification number or a date of birth.

"why": one short sentence. If nothing needs tidying, reply {"suggestions":[]}.`;

/** Kinds "Tidy up" never suggests removing. */
const NEVER_REMOVE: ReadonlySet<EntityKind> = new Set([
  "person",
  "address",
  "phone",
  "email",
  "identifier",
  "date_of_birth",
]);

/** Entries per request; the people come first so merges among them are seen together. */
const BATCH = 60;

interface RawSuggestion {
  type?: unknown;
  from?: unknown;
  into?: unknown;
  role?: unknown;
  to?: unknown;
  why?: unknown;
}

/**
 * Keep only suggestions casefile could carry out: roles that exist, a merge between two entries
 * of the same kind, a new label that is valid, free and gives nothing away, and no removal of
 * anything that can't be harmless.
 */
export function checkSuggestions(
  parsed: unknown,
  registry: EntityRegistry,
  source: TidySource,
): TidySuggestion[] {
  const list = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) throw new Error('The reply had no "suggestions" list');
  const out: TidySuggestion[] = [];
  const allValues = registry.variants({ leak: true }).map((v) => ({
    text: v.text,
    kind: v.entity.kind,
  }));
  const why = (s: RawSuggestion) =>
    typeof s.why === "string" ? s.why.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  for (const s of list as RawSuggestion[]) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "merge") {
      const from = registry.get(String(s.from));
      const into = registry.get(String(s.into));
      if (!from || !into || from === into || from.kind !== into.kind) continue;
      out.push({ type: "merge", from: from.role, into: into.role, why: why(s), source });
    } else if (s.type === "rename") {
      const e = registry.get(String(s.role));
      const to = sanitiseRole(s.to, allValues);
      if (!e || !to || to === e.role || !isValidRole(to) || registry.get(to)) continue;
      if (registry.revealingWords(to).length || /\d{3,}/.test(to)) continue;
      out.push({ type: "rename", role: e.role, to, why: why(s), source });
    } else if (s.type === "remove") {
      const e = registry.get(String(s.role));
      if (!e || registry.isSafetySensitive(e.role)) continue;
      // Never a name, contact detail, identifier or birth date, whatever it looks like (security
      // review): those are only ever merged or renamed.
      if (NEVER_REMOVE.has(e.kind)) continue;
      out.push({ type: "remove", role: e.role, why: why(s) || "Identifies no one.", source });
    }
  }
  return out;
}

/** Drop repeats and contradictions: an entry merged away is not also renamed or removed. */
export function settle(all: TidySuggestion[]): TidySuggestion[] {
  const out: TidySuggestion[] = [];
  const mergedAway = new Set<string>();
  const touched = new Set<string>();
  for (const s of all.filter((x) => x.type === "merge")) {
    if (s.type !== "merge") continue;
    if (mergedAway.has(s.from) || mergedAway.has(s.into) || touched.has(s.from)) continue;
    mergedAway.add(s.from);
    touched.add(s.into);
    out.push(s);
  }
  const done = new Set<string>();
  for (const s of all) {
    if (s.type === "merge") continue;
    if (mergedAway.has(s.role) || done.has(`${s.type}:${s.role}`)) continue;
    if (s.type === "rename" && done.has(`remove:${s.role}`)) continue;
    if (s.type === "remove") {
      // A removal wins over a rename of the same entry.
      const i = out.findIndex((o) => o.type === "rename" && o.role === s.role);
      if (i !== -1) out.splice(i, 1);
    }
    done.add(`${s.type}:${s.role}`);
    out.push(s);
  }
  // Two renames to the same new label: keep the first.
  const labels = new Set<string>();
  return out.filter((s) => {
    if (s.type !== "rename") return true;
    if (labels.has(s.to)) return false;
    labels.add(s.to);
    return true;
  });
}

export interface TidyOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
}

/** A chat with the language model, if casefile may send it original text (ADR 12). */
async function permittedChat(
  settings: LlmEndpointSettings,
  opts: TidyOptions,
): Promise<ChatCompletions> {
  const fetchFn = opts.fetch ?? fetch;
  // Checked every time, never cached: the user can switch the server to a cloud model.
  const where = await classifyEndpoint(settings, fetchFn);
  const p = LlmDetector.permitted(where, settings);
  if (!p.ok) {
    throw new Error(
      where.local
        ? "casefile can't confirm this language model runs on this computer, so it won't send it anything. You can vouch for the server under Finding names."
        : "This language model isn't on this computer, so casefile won't send it anything unless you allow that under Finding names.",
    );
  }
  return new ChatCompletions(settings, { fetch: fetchFn, timeoutMs: opts.timeoutMs });
}

/** One question to the model, answered as parsed JSON; errors never quote the reply. */
async function ask(chat: ChatCompletions, system: string, user: string): Promise<unknown> {
  let reply: string;
  try {
    reply = await chat.complete([{ role: "system", content: system }, {
      role: "user",
      content: user,
    }]);
  } catch (e) {
    throw new Error(
      /did not answer within/.test(String(e))
        ? "The language model took too long to answer."
        : "casefile couldn't get an answer from the language model.",
    );
  }
  try {
    return extractJson(reply);
  } catch {
    throw new Error("The language model's answer wasn't in the form casefile asked for.");
  }
}

/**
 * Ask the language model for suggestions about `entries`. Refuses (throws) when the endpoint may
 * send text off this computer and the user hasn't allowed that (ADR 12), checked every time.
 */
export async function llmSuggestions(
  settings: LlmEndpointSettings,
  entries: TidyEntry[],
  registry: EntityRegistry,
  opts: TidyOptions = {},
): Promise<TidySuggestion[]> {
  const chat = await permittedChat(settings, opts);
  const order = [...entries].sort((a, b) =>
    Number(b.kind === "person") - Number(a.kind === "person") || a.kind.localeCompare(b.kind)
  );
  const out: TidySuggestion[] = [];
  for (let i = 0; i < order.length; i += BATCH) {
    const parsed = await ask(
      chat,
      TIDY_PROMPT,
      JSON.stringify({ entries: order.slice(i, i + BATCH) }),
    );
    out.push(...checkSuggestions(parsed, registry, "llm"));
  }
  return out;
}

// ── while a document is reviewed (ADR 25 amendment) ────────────────────────

/** A new finding in the document under review, as the model sees it. */
export interface ReviewItem {
  /** `n1`, `n2`…: the model's handle for it. */
  id: string;
  /** The detector's key (`new:person:…`), which the review screen's decisions use. */
  key: string;
  kind: EntityKind;
  value: string;
  /** The label casefile would give it now. */
  label: string;
}

/** Someone already in who's who, as the model sees them. */
export interface ReviewEntry {
  role: string;
  kind: EntityKind;
  values: string[];
  description?: string | null;
}

export type ReviewSuggestion =
  | {
    type: "same";
    key: string;
    as: string;
    why: string;
    source: TidySource;
    /**
     * People whose names share nothing ("Gaz" and "Gareth Pemberton" might be one, "Gareth
     * Pemberton" and the father are not): the model may have matched a role, not a name. Shown
     * with a warning and never applied by "Use all".
     */
    caution?: boolean;
  }
  | { type: "label"; key: string; to: string; why: string; source: TidySource }
  | { type: "leave"; key: string; why: string; source: TidySource };

export const REVIEW_PROMPT = `You help de-identify an Australian family-law document before it is
shared. You get part of the document, the people and details already known in the case
("known", each with a label), and the new findings in this document ("found", each with an id).
For each found item, at most one suggestion. Reply with JSON only, in exactly this shape:
{"suggestions":[
 {"type":"same","item":"n2","as":"<known label or another found id>","why":"..."},
 {"type":"label","item":"n3","to":"<new_label>","why":"..."},
 {"type":"leave","item":"n4","why":"..."}
]}

same: the found item IS a known entry or another found item, written differently: the same name
in another order or case, a short form or nickname of it ("OKAFOR, Daniel", "Dan" and "Daniel
Okafor"; a school in capitals). The names must match. A person with a different name is a
different person, even if they have the same role in the case ("the respondent", "the partner"):
give that found item a label instead. Never join two different people, such as a parent and a
child who share a surname.

label: what Claude should call a found item that is someone or something new: a short snake_case
relationship that says who it is to the case, such as maternal_grandmother, fathers_partner,
childrens_school, mothers_employer, family_doctor, family_home, mothers_lawyer, child_3. It must
NEVER contain any word of any name or value. Only when the document makes the relationship clear.

leave: the found item identifies no one and was flagged by mistake: a time, an ordinary date, an
amount, a heading, a court or a government agency. Never for a name, an address, a phone number,
an email, an identification number or a date of birth.

"why": one short sentence. If nothing applies, reply {"suggestions":[]}.`;

/** Characters of the document per request: enough to see who someone is to the case. */
const REVIEW_CHUNK = 6000;

const kindGroup = (k: EntityKind) =>
  ["place", "organisation", "school", "other"].includes(k) ? "places" : k;

/**
 * Keep only review suggestions casefile could carry out: a known item, a "same" between items of a
 * compatible kind (never itself), a label that is valid, free and gives nothing away, and "leave"
 * only for kinds that can be harmless and values that hide no one else's.
 */
export function checkReviewSuggestions(
  parsed: unknown,
  items: ReviewItem[],
  registry: EntityRegistry,
  source: TidySource,
  knownIn: (value: string) => boolean,
): ReviewSuggestion[] {
  const list = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) throw new Error('The reply had no "suggestions" list');
  const byId = new Map(items.map((i) => [i.id, i]));
  const values = [
    ...registry.variants({ leak: true }).map((v) => ({ text: v.text, kind: v.entity.kind })),
    ...items.map((i) => ({ text: i.value, kind: i.kind })),
  ];
  const why = (s: Record<string, unknown>) =>
    typeof s.why === "string" ? s.why.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const out: ReviewSuggestion[] = [];
  for (const s of list as Record<string, unknown>[]) {
    if (!s || typeof s !== "object") continue;
    const item = byId.get(String(s.item));
    if (!item) continue;
    if (s.type === "same") {
      const known = registry.get(String(s.as));
      const other = byId.get(String(s.as));
      const target = known ? known.role : other && other !== item ? other.key : null;
      const kind = known?.kind ?? other?.kind;
      if (!target || !kind || kindGroup(kind) !== kindGroup(item.kind)) continue;
      const theirs = known
        ? [known.forms.full, known.forms.first, known.forms.surname, ...known.aliases]
          .filter((v): v is string => !!v)
        : [other!.value];
      const caution = item.kind === "person" && !namesOverlap(item.value, theirs);
      // A new person is someone already listed only if a name says so: the model tends to match
      // a role ("the respondent") instead (security review of ADR 25's amendment). The user can
      // still choose that person by hand.
      if (caution && known && source === "llm") continue;
      out.push({
        type: "same",
        key: item.key,
        as: target,
        why: why(s),
        source,
        ...(caution ? { caution } : {}),
      });
    } else if (s.type === "label") {
      const to = sanitiseRole(s.to, values);
      if (!to || !isValidRole(to) || registry.get(to) || /\d{3,}/.test(to)) continue;
      if (registry.revealingWords(to, items.map((i) => i.value), item.kind).length) continue;
      out.push({ type: "label", key: item.key, to, why: why(s), source });
    } else if (s.type === "leave") {
      if (NEVER_REMOVE.has(item.kind) || knownIn(item.value)) continue;
      out.push({ type: "leave", key: item.key, why: why(s) || "Identifies no one.", source });
    }
  }
  return out;
}

/**
 * Whether a name shares a word with any of `values`, or one word starts the other ("Dan" and
 * "Daniel"), ignoring case, commas and titles. Nicknames that don't ("Bob", "Robert") don't count.
 */
export function namesOverlap(value: string, values: string[]): boolean {
  const words = (v: string) =>
    normaliseVariant(v).replace(/[,.]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 2 && !/^(mr|mrs|ms|miss|mx|dr|prof|master)$/.test(w));
  const mine = words(value);
  return values.some((v) =>
    words(v).some((w) =>
      mine.some((m) =>
        m === w || (Math.min(m.length, w.length) >= 3 && (m.startsWith(w) || w.startsWith(m)))
      )
    )
  );
}

/** Suggestions from rules alone: harmless shapes, and one name written two ways. */
export function reviewRuleSuggestions(
  items: ReviewItem[],
  known: ReviewEntry[],
): ReviewSuggestion[] {
  const out: ReviewSuggestion[] = [];
  for (const i of items) {
    const why = harmlessShape(i.value, i.kind);
    if (why) out.push({ type: "leave", key: i.key, why, source: "rule" });
  }
  for (const i of items.filter((x) => x.kind === "person")) {
    const k = known.find((e) => e.kind === "person" && sameName([i.value], e.values));
    if (k) {
      out.push({
        type: "same",
        key: i.key,
        as: k.role,
        why: sameName([i.value], k.values)!,
        source: "rule",
      });
      continue;
    }
  }
  // Two new people who are one: join the one without a label into the one with one ("father"),
  // else the later into the earlier.
  const people = items.filter((x) => x.kind === "person");
  for (let a = 0; a < people.length; a++) {
    for (let b = a + 1; b < people.length; b++) {
      const why = sameName([people[a].value], [people[b].value]);
      if (!why) continue;
      const [from, into] = !people[b].label || people[a].label
        ? [people[b], people[a]]
        : [people[a], people[b]];
      out.push({ type: "same", key: from.key, as: into.key, why, source: "rule" });
    }
  }
  // The same text found as two kinds that can be one ("organisation" and "school").
  for (const i of items) {
    const o = items.find((x) =>
      x !== i && items.indexOf(x) < items.indexOf(i) && kindGroup(x.kind) === kindGroup(i.kind) &&
      normaliseVariant(x.value) === normaliseVariant(i.value)
    );
    if (o) {
      out.push({
        type: "same",
        key: i.key,
        as: o.key,
        why: "The same text, found twice.",
        source: "rule",
      });
    }
  }
  return out;
}

/**
 * One suggestion per finding, earlier ones first (rules come first): "same" chains are followed to
 * the end ("Dan" → "Daniel Okafor" → father becomes "Dan" → father) and cycles dropped; an item
 * other items are joined to keeps its own label suggestion.
 */
export function settleReview(all: ReviewSuggestion[]): ReviewSuggestion[] {
  const first = new Map<string, ReviewSuggestion>();
  for (const s of all) if (!first.has(s.key)) first.set(s.key, s);
  const resolve = (s: ReviewSuggestion): ReviewSuggestion | null => {
    if (s.type !== "same") return s;
    const seen = new Set([s.key]);
    let as = s.as;
    let caution = s.caution === true;
    for (;;) {
      const next = first.get(as);
      if (!next || next.type !== "same") break;
      if (seen.has(next.as) || seen.has(as)) return null;
      seen.add(as);
      as = next.as;
      // One doubtful link makes the whole chain doubtful.
      if (next.caution) caution = true;
    }
    return caution ? { ...s, as, caution } : { ...s, as };
  };
  const out: ReviewSuggestion[] = [];
  const labels = new Set<string>();
  for (const s of first.values()) {
    const r = resolve(s);
    if (!r) continue;
    if (r.type === "label") {
      if (labels.has(r.to)) continue;
      labels.add(r.to);
    }
    out.push(r);
  }
  return out;
}

/**
 * Suggestions for the findings of one document under review, from rules and (when one is set up)
 * the language model reading the whole document, chunk by chunk. A refused or failed model is
 * reported in `llm.error`; the rules' suggestions still come back.
 */
export async function reviewSuggestions(
  settings: LlmEndpointSettings | null,
  text: string,
  items: ReviewItem[],
  known: ReviewEntry[],
  registry: EntityRegistry,
  knownIn: (value: string) => boolean,
  opts: TidyOptions & { useLlm?: boolean } = {},
): Promise<{ suggestions: ReviewSuggestion[]; llm: { ran: boolean; error?: string } }> {
  const all: ReviewSuggestion[] = checkReviewSuggestions(
    {
      suggestions: reviewRuleSuggestions(items, known).map((s) => ({
        type: s.type,
        item: items.find((i) => i.key === s.key)!.id,
        as: s.type === "same" ? (items.find((i) => i.key === s.as)?.id ?? s.as) : undefined,
        to: s.type === "label" ? s.to : undefined,
        why: s.why,
      })),
    },
    items,
    registry,
    "rule",
    knownIn,
  );
  let llm: { ran: boolean; error?: string } = { ran: false };
  if (opts.useLlm === false || !items.length) {
    // nothing to ask
  } else if (!settings || !settings.baseUrl.trim() || !settings.model.trim()) {
    llm = { ran: false, error: "No language model is set up under Finding names." };
  } else {
    try {
      const chat = await permittedChat(settings, opts);
      const found = items.map((i) => ({ id: i.id, kind: i.kind, value: i.value, label: i.label }));
      for (const chunk of chunkText(text, REVIEW_CHUNK)) {
        if (!chunk.text.trim()) continue;
        const parsed = await ask(
          chat,
          REVIEW_PROMPT,
          JSON.stringify({ document: chunk.text, known, found }),
        );
        all.push(...checkReviewSuggestions(parsed, items, registry, "llm", knownIn));
      }
      llm = { ran: true };
    } catch (e) {
      llm = { ran: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { suggestions: settleReview(all), llm };
}
