import type { EntityKind } from "../kinds.ts";
import { type EntityRegistry, normaliseVariant } from "../entities.ts";
import { isValidRole } from "../tokens.ts";
import { harmlessShape } from "./rules.ts";
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
      if (["person", "address", "phone", "email", "identifier", "date_of_birth"].includes(e.kind)) {
        // The model may only clear things that look harmless; a name is never one.
        if (!harmlessShape(e.forms.full, e.kind)) continue;
      }
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
  const fetchFn = opts.fetch ?? fetch;
  const where = await classifyEndpoint(settings, fetchFn);
  const p = LlmDetector.permitted(where, settings);
  if (!p.ok) {
    throw new Error(
      where.local
        ? "casefile can't confirm this language model runs on this computer, so it won't send it anything. You can vouch for the server under Finding names."
        : "This language model isn't on this computer, so casefile won't send it anything unless you allow that under Finding names.",
    );
  }
  const chat = new ChatCompletions(settings, { fetch: fetchFn, timeoutMs: opts.timeoutMs });
  const order = [...entries].sort((a, b) =>
    Number(b.kind === "person") - Number(a.kind === "person") || a.kind.localeCompare(b.kind)
  );
  const out: TidySuggestion[] = [];
  for (let i = 0; i < order.length; i += BATCH) {
    const batch = order.slice(i, i + BATCH);
    let reply: string;
    try {
      reply = await chat.complete([
        { role: "system", content: TIDY_PROMPT },
        { role: "user", content: JSON.stringify({ entries: batch }) },
      ]);
    } catch (e) {
      // ChatCompletions' messages never quote the reply.
      throw new Error(
        /did not answer within/.test(String(e))
          ? "The language model took too long to answer."
          : "casefile couldn't get an answer from the language model.",
      );
    }
    let parsed: unknown;
    try {
      parsed = extractJson(reply);
    } catch {
      throw new Error("The language model's answer wasn't in the form casefile asked for.");
    }
    out.push(...checkSuggestions(parsed, registry, "llm"));
  }
  return out;
}
