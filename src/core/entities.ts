import { type Form, formatToken, isValidRole } from "./tokens.ts";
import { foldValue } from "./fold.ts";

/**
 * The entity registry is the token key: it maps each role to the real strings it stands for.
 * It lives only in the vault (ADR 0003). The public store sees roles and kinds, never values.
 */

import { ENTITY_KINDS, type EntityKind } from "./kinds.ts";

export { ENTITY_KINDS, type EntityKind };

export interface EntityForms {
  full: string;
  first?: string;
  surname?: string;
  title?: string;
}

export interface Entity {
  role: string;
  kind: EntityKind;
  forms: EntityForms;
  /** Extra strings that mean this entity and render as its full form, e.g. a nickname. */
  aliases: string[];
  /** Colour slot (palette index 0–5) for this entity in the UI; null or absent: neutral ink. */
  colour?: number | null;
  /** Safety-sensitive: never left as written, address hidden until shown. */
  safety?: boolean;
  /** The user's relationship description, tokenised; published to `entities.description`. */
  description?: string | null;
  /**
   * The person this address, number, place or organisation belongs to ("her address"), by role.
   * Vault only, never published (ADR 15, amendment 3): which details are whose is not Claude's
   * business. A safety-sensitive person's linked details are treated as safety-sensitive.
   */
  relatedTo?: string | null;
}

export interface VariantMatch {
  entity: Entity;
  form: Form;
  text: string;
  /** A part that identifies but is not a renderable form (see `leakOnlyParts`). */
  leakOnly?: boolean;
}

/**
 * The six colour slots (DESIGN-SPEC §4, Paul Tol "light", colour-blind-safe on dark). An entity
 * holds a slot *index* (0–5) in the vault; the hex values are for the UI only and never reach
 * public.db (ADR 15). Everyone else shows in neutral ink.
 */
export const PALETTE = ["#FFAABB", "#77AADD", "#44BB99", "#BBCC33", "#99DDFF", "#EEDD88"] as const;

/** Slots the parties and children get by default when they are first added (ADR 15). */
export const DEFAULT_COLOURS: Readonly<Record<string, number>> = {
  mother: 0,
  father: 1,
  child_1: 2,
  child_2: 3,
};

/** A colour slot another entity already holds. */
export class ColourTakenError extends Error {
  constructor(readonly colour: number, readonly owner: string) {
    super(`That colour is already used for ${owner}. Take it from them first.`);
    this.name = "ColourTakenError";
  }
}

/** Throws unless `c` is a palette index or null (neutral). */
export function checkColour(c: unknown): number | null {
  if (c === null) return null;
  if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= PALETTE.length) {
    throw new RangeError(`Colour must be a slot from 0 to ${PALETTE.length - 1}, or null`);
  }
  return c;
}

/** `{{role}}` or `{{role.form}}` for one role, globally. */
export function roleTokenRe(role: string): RegExp {
  if (!isValidRole(role)) throw new Error(`Invalid role name: ${JSON.stringify(role)}`);
  return new RegExp(`\\{\\{${role}(\\.(?:first|surname|title))?\\}\\}`, "g");
}

/** Replace every token of `role` in `text` with what `to` gives for its form. */
export function swapRoleTokens(text: string, role: string, to: (form: Form) => string): string {
  return text.replace(roleTokenRe(role), (_m, f) => to(f ? f.slice(1) as Form : "full"));
}

const TITLE_RE = /^(Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Master)\.?\s+(\S.*)$/i;

const KIND_PREFIX: Record<EntityKind, string> = {
  person: "person",
  place: "place",
  organisation: "org",
  school: "school",
  address: "address",
  phone: "phone",
  email: "email",
  identifier: "id",
  date_of_birth: "dob",
  other: "other",
};

/** Generic words that may appear in both a role name and a value without identifying anyone. */
const GENERIC_WORDS = new Set(
  ("the of and for at in on de la le van von mr mrs ms miss dr to by or an jr sr st rd no " +
    "school public primary high secondary college grammar academy childcare care centre center " +
    "kindergarten preschool early learning family day club sports football soccer netball church " +
    "hospital clinic medical practice health services service pty ltd limited company group trust " +
    "street st road rd avenue ave lane drive way place court crescent parade highway north south east west " +
    "department police station court office bank council community").split(" "),
);

/**
 * Words of a value, for comparing with role words. Two-letter words count ("Jo" in "Jo Pemberton"
 * must not be usable as `aunty_jo`); generic ones are dropped by the caller.
 */
const TITLE_WORDS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "master"]);

function wordsOf(s: string): string[] {
  return foldValue(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !/^\d+$/.test(w));
}

const STATES_RE = /\b(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i;

/**
 * Parts of a value that identify on their own but are not forms the token can render: a person's
 * middle names, an address's street and suburb, an organisation's or school's distinctive words
 * ("Kiama Downs" of "Kiama Downs Public School"). They are checked by the leak check and flagged
 * by detection, never used to tokenise (re-identifying "Jessica" as the full name would be wrong).
 */
function leakOnlyParts(e: Entity): string[] {
  const full = e.forms.full.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  if (e.kind === "person") {
    // Every name word of the full name and of each nickname: middle names, and a surname the
    // `surname` form does not hold ("Ellery" of "Margaret Ellery" when surname is unset or
    // different). Hyphenated and apostrophe'd names add their parts ("Smith-Jones" → "Jones",
    // "O'Brien" → "Brien").
    for (const v of [full, ...e.aliases]) out.push(...personNameWords(v));
  } else if (e.kind === "address") {
    const pieces = full.split(",").map((p) => p.trim()).filter(Boolean);
    // "14 Banksia Crescent" -> "Banksia Crescent"
    const street = pieces[0]?.replace(
      /^(?:(?:Unit|Apt|Flat|Lot)\s+\S+\s+)?[\d/A-Za-z-]*\d[\w/-]*\s+/i,
      "",
    );
    if (street && street !== pieces[0]) out.push(street);
    // "Gerringong NSW 2534" -> "Gerringong"
    for (const p of pieces.slice(1)) {
      const suburb = p.replace(/\b\d{4}\b/g, "").replace(STATES_RE, "").replace(/\s+/g, " ").trim();
      if (suburb.length >= 3) out.push(suburb);
    }
  } else if (e.kind === "organisation" || e.kind === "school") {
    // Runs of distinctive (non-generic) words.
    let run: string[] = [];
    const flush = () => {
      if (run.length) out.push(run.join(" "));
      run = [];
    };
    for (const w of full.split(" ")) {
      if (GENERIC_WORDS.has(foldValue(w).replace(/[^\p{L}\p{N}]/gu, ""))) flush();
      else run.push(w);
    }
    flush();
  }
  const seen = new Set(
    [e.forms.full, e.forms.first, e.forms.surname, e.forms.title, ...e.aliases]
      .filter(Boolean).map((v) => foldValue(v!)),
  );
  return [...new Set(out)].filter((p) => p.length >= 2 && !seen.has(foldValue(p)));
}

/** Name particles and suffixes that identify no one on their own. */
const NAME_PARTICLES = new Set(
  ("de da das del della dei der den di do dos du la le les lo van von ver vander ten ter te " +
    "bin binti bint ibn ben bat al el abu ap mac o d st jr sr ii iii iv").split(" "),
);

/**
 * Words of a person's name that identify them on their own: each word (and each part of a
 * hyphenated or apostrophe'd word) starting with a capital letter, at least two letters long,
 * that is not a title or particle ("de", "van", "bin", "O'"). Lower-case words ("van" in
 * "Ludwig van Beethoven") are particles by the way they are written.
 */
export function personNameWords(value: string): string[] {
  const out: string[] = [];
  const words = value.replace(/\s+/g, " ").trim().replace(TITLE_RE, "$2").split(" ");
  for (const w of words) {
    const clean = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    const pieces = [clean, ...clean.split(/[-'’‘ʼ]/)];
    for (const p of new Set(pieces)) {
      const f = foldValue(p);
      if (p.length < 2 || !/^\p{Lu}/u.test(p)) continue;
      if (NAME_PARTICLES.has(f) || TITLE_WORDS.has(f)) continue;
      out.push(p);
    }
  }
  return out;
}

/** How values are compared: folded as for matching (NFKC, apostrophes, spacing, lower case). */
export function normaliseVariant(s: string): string {
  return foldValue(s);
}

/** Split a person's full name into first and surname forms when it is unambiguous. */
export function splitPersonName(full: string): Pick<EntityForms, "first" | "surname"> {
  // Court forms and lists write "SURNAME, Given names" (ADR 25).
  const comma = /^([^,]+),\s*([^,]+)$/.exec(full.replace(/\s+/g, " ").trim());
  if (comma) {
    const surname = comma[1].trim();
    const first = comma[2].trim().split(" ")[0];
    return surname && first ? { first, surname } : {};
  }
  const parts = full.replace(/\s+/g, " ").trim().split(" ");
  if (parts.length < 2) return {};
  return { first: parts[0], surname: parts[parts.length - 1] };
}

export class EntityRegistry {
  #entities = new Map<string, Entity>();

  constructor(entities: Entity[] = []) {
    for (const e of entities) this.#insert(structuredClone(e));
    // Registries saved before colour slots existed: the parties and children get their default
    // slot (an explicit null means the user chose neutral, and is kept).
    for (const e of this.#entities.values()) {
      if (e.colour === undefined) this.#defaultColour(e);
    }
    // A link that doesn't name another person (an older or altered registry) is dropped, so it
    // can't attach later to whoever is next given that role.
    for (const e of this.#entities.values()) {
      if (e.relatedTo === undefined || e.relatedTo === null) continue;
      const to = typeof e.relatedTo === "string" ? this.#entities.get(e.relatedTo) : undefined;
      if (!to || to === e || to.kind !== "person" || e.kind === "person") e.relatedTo = null;
    }
  }

  /** Give `e` its role's default slot, if it has one and the slot is free. */
  #defaultColour(e: Entity) {
    const c = DEFAULT_COLOURS[e.role];
    if (c !== undefined && this.colourOwner(c) === undefined) e.colour = c;
  }

  /** The role holding colour slot `c`, if any. */
  colourOwner(c: number): string | undefined {
    for (const e of this.#entities.values()) if (e.colour === c) return e.role;
    return undefined;
  }

  /** Every slot with its hex value (UI only) and the role holding it, if any. */
  palette(): { index: number; hex: string; owner: string | null }[] {
    return PALETTE.map((hex, index) => ({ index, hex, owner: this.colourOwner(index) ?? null }));
  }

  /**
   * Give `role` colour slot `colour`, or neutral ink with null. A slot another entity holds is
   * refused (`ColourTakenError`): the user takes it from them first.
   */
  setColour(role: string, colour: number | null): Entity {
    const e = this.#entities.get(role);
    if (!e) throw new Error(`No such role: ${role}`);
    const c = checkColour(colour);
    if (c !== null) {
      const owner = this.colourOwner(c);
      if (owner !== undefined && owner !== role) throw new ColourTakenError(c, owner);
    }
    e.colour = c;
    return e;
  }

  #insert(e: Entity) {
    if (!isValidRole(e.role)) throw new Error(`Invalid role name: ${JSON.stringify(e.role)}`);
    if (this.#entities.has(e.role)) throw new Error(`Role already exists: ${e.role}`);
    this.#entities.set(e.role, e);
  }

  list(): Entity[] {
    return [...this.#entities.values()];
  }

  get(role: string): Entity | undefined {
    return this.#entities.get(role);
  }

  roles(): Set<string> {
    return new Set(this.#entities.keys());
  }

  toJSON(): Entity[] {
    return this.list();
  }

  /** Pick an unused role name. Uses the suggestion if it is valid and free, else kind_N. */
  allocateRole(kind: EntityKind, suggestion?: string): string {
    const clean = suggestion?.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (clean && isValidRole(clean)) {
      if (!this.#entities.has(clean)) return clean;
      for (let n = 2;; n++) if (!this.#entities.has(`${clean}_${n}`)) return `${clean}_${n}`;
    }
    const prefix = KIND_PREFIX[kind];
    for (let n = 1;; n++) if (!this.#entities.has(`${prefix}_${n}`)) return `${prefix}_${n}`;
  }

  add(
    input:
      & { kind: EntityKind; full: string; role?: string; aliases?: string[] }
      & Partial<EntityForms>,
  ): Entity {
    const role = input.role ?? this.allocateRole(input.kind);
    const forms: EntityForms = { full: input.full.trim() };
    if (input.kind === "person") Object.assign(forms, splitPersonName(forms.full));
    for (const f of ["first", "surname", "title"] as const) {
      if (input[f]) forms[f] = input[f]!.trim();
    }
    const e: Entity = { role, kind: input.kind, forms, aliases: input.aliases ?? [] };
    this.#insert(e);
    this.#defaultColour(e);
    return e;
  }

  rename(oldRole: string, newRole: string): Entity {
    const e = this.#entities.get(oldRole);
    if (!e) throw new Error(`No such role: ${oldRole}`);
    if (oldRole === newRole) return e;
    if (!isValidRole(newRole)) throw new Error(`Invalid role name: ${JSON.stringify(newRole)}`);
    if (this.#entities.has(newRole)) throw new Error(`Role already exists: ${newRole}`);
    this.#entities.delete(oldRole);
    e.role = newRole;
    this.#entities.set(newRole, e);
    // Links to this person follow the new role.
    for (const other of this.#entities.values()) {
      if (other.relatedTo === oldRole) other.relatedTo = newRole;
    }
    // Descriptions are tokenised text, so they name roles too.
    const re = roleTokenRe(oldRole);
    for (const other of this.#entities.values()) {
      if (other.description) {
        other.description = other.description.replace(
          re,
          (_m, f) => `{{${newRole}${f ?? ""}}}`,
        );
      }
    }
    if (e.colour === undefined) this.#defaultColour(e);
    return e;
  }

  /**
   * Change an entity. `description` must already be tokenised and checked (ADR 15:
   * `checkDescription` in people.ts); "" or null clears it. A taken `colour` is refused before
   * anything changes.
   */
  update(
    role: string,
    patch: Partial<EntityForms> & {
      kind?: EntityKind;
      aliases?: string[];
      colour?: number | null;
      safety?: boolean;
      description?: string | null;
      relatedTo?: string | null;
    },
  ): Entity {
    const e = this.#entities.get(role);
    if (!e) throw new Error(`No such role: ${role}`);
    if (patch.colour !== undefined) this.setColour(role, patch.colour);
    if (patch.relatedTo !== undefined) e.relatedTo = patch.relatedTo || null;
    if (patch.safety !== undefined) e.safety = patch.safety === true;
    if (patch.description !== undefined) e.description = patch.description || null;
    if (patch.kind) e.kind = patch.kind;
    if (patch.aliases) e.aliases = patch.aliases;
    for (const f of ["full", "first", "surname", "title"] as const) {
      if (patch[f] !== undefined) {
        if (f === "full") e.forms.full = patch.full!.trim();
        else if (patch[f] === "") delete e.forms[f];
        else e.forms[f] = patch[f]!.trim();
      }
    }
    return e;
  }

  /**
   * Fold entity `from` into `into` (ADR 25): `from`'s values become `into`'s forms or other names,
   * links and descriptions that named `from` name `into`, and `from` is gone. Returns, for each of
   * `from`'s forms, the form of `into` its tokens become: the same form when the value matches one
   * of `into`'s (or fills one it lacks), else `full` (the value is kept as another name, which
   * renders as the full form, like any nickname).
   */
  merge(from: string, into: string): Record<Form, Form> {
    const a = this.#entities.get(from);
    const b = this.#entities.get(into);
    if (!a) throw new Error(`No such role: ${from}`);
    if (!b) throw new Error(`No such role: ${into}`);
    if (a === b) throw new Error("An entry can't be merged into itself");
    const map = { full: "full", first: "full", surname: "full", title: "full" } as Record<
      Form,
      Form
    >;
    // Compared without stray punctuation at either end ("OKAFOR," is "Okafor").
    const norm = (v: string) => normaliseVariant(v).replace(/^[\s,.;:]+|[\s,.;:]+$/g, "");
    const known = () => [
      ...(["full", "first", "surname", "title"] as const)
        .filter((f) => b.forms[f])
        .map((f) => ({ f, v: norm(b.forms[f]!) })),
      ...b.aliases.map((v) => ({ f: "full" as Form, v: norm(v) })),
    ];
    for (const f of ["full", "first", "surname", "title"] as const) {
      const v = a.forms[f];
      if (!v) continue;
      const same = known().find((k) => k.v === norm(v));
      if (same) map[f] = same.f;
      else if (f !== "full" && b.kind === "person" && !b.forms[f]) {
        b.forms[f] = v;
        map[f] = f;
      } else b.aliases.push(v);
    }
    for (const v of a.aliases) {
      if (!known().some((k) => k.v === norm(v))) b.aliases.push(v);
    }
    if (a.safety) b.safety = true;
    if (!b.relatedTo && a.relatedTo && a.relatedTo !== into) b.relatedTo = a.relatedTo;
    if ((b.colour === undefined || b.colour === null) && typeof a.colour === "number") {
      b.colour = a.colour;
    }
    const swap = (t: string) => swapRoleTokens(t, from, (f) => formatToken(into, map[f]));
    if (!b.description && a.description) b.description = a.description;
    this.#entities.delete(from);
    for (const other of this.#entities.values()) {
      if (other.relatedTo === from) other.relatedTo = other === b ? null : into;
      if (other.description) other.description = swap(other.description);
    }
    return map;
  }

  remove(role: string): void {
    this.#entities.delete(role);
    for (const other of this.#entities.values()) {
      if (other.relatedTo === role) other.relatedTo = null;
    }
  }

  /** The details (addresses, numbers, places) linked to person `role` with `relatedTo`. */
  linkedTo(role: string): Entity[] {
    return this.list().filter((e) => e.relatedTo === role);
  }

  /**
   * Whether `role` is safety-sensitive: its own flag, or the flag of the person it belongs to
   * (`relatedTo`), so marking a person hides "their address" too. `via` names that person.
   */
  safetyOf(role: string): { safety: boolean; via: string | null } {
    const e = this.#entities.get(role);
    if (!e) return { safety: false, via: null };
    if (e.safety === true) return { safety: true, via: null };
    const owner = e.relatedTo ? this.#entities.get(e.relatedTo) : undefined;
    return owner?.safety === true
      ? { safety: true, via: owner.role }
      : { safety: false, via: null };
  }

  /**
   * True if `role`'s values must be treated as safety-sensitive everywhere (no "Leave as written",
   * dropped from honoured ignores, warnings on copy): its own flag or its person's.
   */
  isSafetySensitive(role: string): boolean {
    return this.safetyOf(role).safety;
  }

  /** Every role whose values are safety-sensitive (own flag, or linked to such a person). */
  safetyRoles(): string[] {
    return this.list().filter((e) => this.isSafetySensitive(e.role)).map((e) => e.role);
  }

  /**
   * Problems with the `relatedTo` links as they stand (empty when all are sound): each must name
   * another entity that is a person, and a person can't belong to someone.
   */
  linkProblems(): string[] {
    const out: string[] = [];
    for (const e of this.#entities.values()) {
      if (!e.relatedTo) continue;
      const to = this.#entities.get(e.relatedTo);
      if (e.kind === "person") out.push(`${e.role}: a person can’t belong to someone else`);
      else if (e.relatedTo === e.role) out.push(`${e.role}: can’t belong to itself`);
      else if (!to) out.push(`${e.role}: no one is called ${e.relatedTo}`);
      else if (to.kind !== "person") out.push(`${e.role}: ${to.role} is not a person`);
    }
    return out;
  }

  /**
   * Role names are visible to Claude (ADR 5), so they must not contain any word of any entity's
   * value ("anna_mum" would leak a name). Returns the offending words, if any.
   */
  revealingWords(role: string, extraValues: string[] = [], extraKind?: EntityKind): string[] {
    const values = new Set<string>();
    // Generic words are exempt for places and organisations ("school", "court"), but not for
    // people: someone may be surnamed Court or West. Titles are always exempt.
    const addValue = (v: string, person: boolean) =>
      wordsOf(v).filter((w) => person ? !TITLE_WORDS.has(w) : !GENERIC_WORDS.has(w))
        .forEach((w) => values.add(w));
    for (const v of this.variants({ leak: true })) addValue(v.text, v.entity.kind === "person");
    extraValues.forEach((v) => addValue(v, extraKind === "person"));
    return role.toLowerCase().split(/[_\d]+/).filter((w) => values.has(w));
  }

  /**
   * Every string that identifies an entity, with the form it should become. Longest first. With
   * `leak`, also the leak-only parts (middle names, suburbs, distinctive words; `leakOnly: true`),
   * which the leak check and detection use but tokenising does not.
   */
  variants(opts: { leak?: boolean } = {}): VariantMatch[] {
    const out: VariantMatch[] = [];
    for (const e of this.#entities.values()) {
      out.push({ entity: e, form: "full", text: e.forms.full });
      for (const f of ["first", "surname", "title"] as const) {
        const v = e.forms[f];
        if (v) out.push({ entity: e, form: f, text: v });
      }
      for (const a of e.aliases) out.push({ entity: e, form: "full", text: a });
      if (opts.leak) {
        for (const p of leakOnlyParts(e)) {
          out.push({ entity: e, form: "full", text: p, leakOnly: true });
        }
      }
    }
    return out
      .filter((v) => v.text.trim().length > 0)
      .sort((a, b) => b.text.length - a.text.length);
  }

  /** Resolve a token back to its real value. Missing forms fall back to the full form. */
  resolve(role: string, form: Form): string | undefined {
    const e = this.#entities.get(role);
    if (!e) return undefined;
    if (form === "full") return e.forms.full;
    return e.forms[form] ?? e.forms.full;
  }

  /**
   * Find which entity and form a piece of text refers to.
   * Handles "Ms Smith" style titles by matching the surname of a known person.
   */
  match(text: string): VariantMatch | undefined {
    const c = this.candidates(text);
    return c.length === 1 ? c[0] : undefined;
  }

  /**
   * All entities a piece of text could refer to. More than one means it is ambiguous
   * (e.g. a surname shared by a parent and child) and a person has to decide.
   */
  candidates(text: string): VariantMatch[] {
    const n = normaliseVariant(text);
    const byRole = new Map<string, VariantMatch>();
    for (const v of this.variants()) {
      if (normaliseVariant(v.text) === n && !byRole.has(v.entity.role)) {
        byRole.set(v.entity.role, { ...v, text });
      }
    }
    if (byRole.size === 0) {
      const t = TITLE_RE.exec(text.trim());
      if (t) {
        const surname = normaliseVariant(t[2]);
        for (const e of this.list()) {
          if (
            e.kind === "person" && e.forms.surname && normaliseVariant(e.forms.surname) === surname
          ) {
            byRole.set(e.role, { entity: e, form: "title", text });
          }
        }
      }
    }
    return [...byRole.values()];
  }

  /** Record that `text` is the title form of a person, if that form is not yet known. */
  learnTitle(role: string, text: string): void {
    const e = this.#entities.get(role);
    if (e && !e.forms.title && TITLE_RE.test(text.trim())) e.forms.title = text.trim();
  }

  token(role: string, form: Form = "full"): string {
    if (!this.#entities.has(role)) throw new Error(`No such role: ${role}`);
    return formatToken(role, form);
  }
}
