// Route handlers are uniformly async, whether or not a given one awaits.
// deno-lint-ignore-file require-await
import { typedTextLabel, type TypedTextRecheck } from "../../core/typedtext.ts";
import { ColourTakenError, type Entity, type EntityKind } from "../../core/entities.ts";
import {
  aliasImpact,
  changeEntity,
  documentCounts,
  ENTITY_GROUPS,
  type EntityChange,
  type EntityGroup,
  entityGroup,
  idType,
  roleUsage,
  suggestTidy,
} from "../../core/people.ts";
import { foldValue } from "../../core/fold.ts";
import { labelLinkSuggestions } from "../../core/export/safety.ts";
import type { ErrorMapper, Rich, Route, RouteContext } from "./context.ts";
import { HttpError, route } from "./context.ts";

/**
 * People, places and identifiers (the registry), as the user sees them. Everything here reads the
 * vault (real values, counts from originals) and is for the app only (ADR 3, ADR 15).
 */
export function entitiesRoutes({ s, show, state }: RouteContext): Route[] {
  const intParam = (v: string | null, name: string, fallback: number): number => {
    if (v === null || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Bad ${name}`);
    return n;
  };

  /** One who's who row. */
  const person = (
    e: Entity,
    counts: Map<string, { docs: number; mentions: number }>,
  ): PersonView => ({
    role: e.role,
    kind: e.kind,
    group: entityGroup(e.kind),
    idType: idType(e),
    forms: { ...e.forms },
    aliases: [...e.aliases],
    colour: e.colour ?? null,
    safety: e.safety === true,
    safetyVia: s().registry.safetyOf(e.role).via,
    relatedTo: e.relatedTo ?? null,
    description: e.description ? show(e.description) : null,
    docs: counts.get(e.role)?.docs ?? 0,
    mentions: counts.get(e.role)?.mentions ?? 0,
  });

  return [
    // ── entities ────────────────────────────────────────────────────────────
    /**
     * Who's who: `?q=` filters on any value or the role, `?group=people|places|numbers` picks a
     * tab, `?offset=&limit=` pages. `groups` counts every match per tab (before the group filter
     * and paging); `total` counts every match in the chosen tab.
     */
    route("GET", "/api/people", async ({ url }) => {
      const sp = url.searchParams;
      const group = sp.get("group") || null;
      if (group !== null && !ENTITY_GROUPS.includes(group as EntityGroup)) {
        throw new HttpError(400, "Bad group");
      }
      const offset = intParam(sp.get("offset"), "offset", 0);
      const limit = intParam(sp.get("limit"), "limit", 0); // 0: all
      const words = foldValue(sp.get("q") ?? "").split(/\s+/).filter(Boolean);
      const reg = s().registry;
      const matching = reg.list().filter((e) => {
        if (!words.length) return true;
        const hay = [e.role, ...Object.values(e.forms), ...e.aliases]
          .map((v) => foldValue(String(v))).join("\n");
        return words.every((w) => hay.includes(w));
      });
      const groups = { people: 0, places: 0, numbers: 0 };
      for (const e of matching) groups[entityGroup(e.kind)]++;
      const inGroup = group ? matching.filter((e) => entityGroup(e.kind) === group) : matching;
      const counts = await documentCounts(s());
      const page = limit ? inGroup.slice(offset, offset + limit) : inGroup.slice(offset);
      return {
        palette: reg.palette(),
        groups,
        total: inGroup.length,
        offset,
        entities: page.map((e) => person(e, counts)),
        // Details whose label reads as someone's but that aren't linked to anyone yet (security
        // review: export protects them by label until linked). The user confirms each in People.
        linkSuggestions: labelLinkSuggestions(reg),
      };
    }),
    /**
     * The same suggestions alone, for the app to mention when a case is opened: `{role, person,
     * safety}` for each unlinked detail whose label reads as a person's (`mothers_home` →
     * `mother`). Nothing is linked until the user confirms it with PATCH relatedTo.
     */
    route("GET", "/api/people/link-suggestions", async () => ({
      suggestions: labelLinkSuggestions(s().registry),
    })),
    /**
     * One who's who entry (the same shape as a `/api/people` row), plus `linked`: the details that
     * belong to this person (`relatedTo`). 404 for an unknown role.
     */
    route("GET", "/api/entities/:role", async ({ params }) => {
      const reg = s().registry;
      const e = reg.get(params.role);
      if (!e) throw new HttpError(404, "No one in who’s who has that label");
      const counts = await documentCounts(s());
      return {
        ...person(e, counts),
        linked: reg.linkedTo(e.role).map((x) => ({
          role: x.role,
          kind: x.kind,
          group: entityGroup(x.kind),
          idType: idType(x),
        })),
      };
    }),
    route("GET", "/api/entities/:role/usage", async ({ params }) => {
      const u = await roleUsage(s(), params.role);
      return {
        ...u,
        chronology: u.chronology.map((c) => ({ ...c, description: show(c.description) })),
        issues: u.issues.map((i) => ({ ...i, title: show(i.title) })),
        paragraphs: u.paragraphs.map((p) => ({ ...p, draftTitle: show(p.draftTitle).text })),
      };
    }),
    route("GET", "/api/entities/:role/alias-impact", async ({ params, url }) => {
      const alias = url.searchParams.get("alias") ?? "";
      return await aliasImpact(s(), params.role, alias);
    }),
    /**
     * "Tidy up who's who" (ADR 25): suggested merges, labels and removals, from rules and from the
     * language model set up under Finding names (if any). Nothing changes until one is accepted.
     */
    route("POST", "/api/people/tidy", async ({ body }) => {
      const b = await body();
      return await suggestTidy(s(), {
        useLlm: b.useLlm !== false,
        fetch: state.opts.tidyFetch,
      });
    }),
    /** Merge this entry into `into` (ADR 25): one person or place written two ways. */
    route("POST", "/api/entities/:role/merge", async ({ params, body }) => {
      const b = await body();
      if (typeof b.into !== "string" || !b.into) throw new HttpError(400, "into must be a role");
      if (!s().registry.get(params.role)) throw new HttpError(404, "No such entry");
      await s().mergeEntity(params.role, b.into);
      return { ok: true, role: b.into };
    }),
    /** Stop replacing this entry (ADR 25): it identifies no one. Needs a reason. */
    route("POST", "/api/entities/:role/remove", async ({ params, body }) => {
      const b = await body();
      if (typeof b.reason !== "string") throw new HttpError(400, "reason must be text");
      if (!s().registry.get(params.role)) throw new HttpError(404, "No such entry");
      await s().removeEntity(params.role, b.reason);
      return { ok: true };
    }),
    route("PATCH", "/api/entities/:role", async ({ params, body }) => {
      const b = await body();
      const change: EntityChange = {};
      for (const k of ["full", "first", "surname", "title", "role", "kind"] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== "string") throw new HttpError(400, `${k} must be text`);
        (change as Record<string, unknown>)[k] = b[k]; // kind is checked in core
      }
      if (b.aliases !== undefined) {
        if (!Array.isArray(b.aliases)) throw new HttpError(400, "aliases must be a list");
        change.aliases = b.aliases.filter((a: unknown) => typeof a === "string" && a.trim());
      }
      if ("colour" in b) change.colour = b.colour;
      if ("safety" in b) change.safety = b.safety;
      if ("description" in b) change.description = b.description;
      if ("relatedTo" in b) change.relatedTo = b.relatedTo === "" ? null : b.relatedTo;
      // Every check (against who's who as it will be) runs before anything is written.
      const r = await changeEntity(s(), params.role, change);
      // Only the role: which attributes changed (a colour, the safety flag) is not Claude's business.
      s().log("user", "entity_updated", { role: r.role });
      return {
        ok: true,
        role: r.role,
        descriptionsCleared: r.descriptionsCleared,
        typedText: typedTextView(r.typedText),
      };
    }),
  ];
}

/**
 * What re-checking the text in public.db found after a change to who's who (ADR 27), in the
 * words People shows: item labels only, never the values.
 */
function typedTextView(r: TypedTextRecheck | null) {
  if (!r) return null;
  return {
    replaced: r.replaced.map((i) => ({ kind: i.kind, id: i.id, label: typedTextLabel(i) })),
    left: r.left.map((i) => ({ kind: i.kind, id: i.id, label: typedTextLabel(i), why: i.why })),
  };
}

/** A who's who row (`GET /api/people`). */
export interface PersonView {
  role: string;
  kind: EntityKind;
  group: EntityGroup;
  idType: string | null;
  forms: Entity["forms"];
  aliases: string[];
  colour: number | null;
  /** Own safety-sensitive flag. */
  safety: boolean;
  /** Set when this detail is safety-sensitive because the person it belongs to is (their role). */
  safetyVia: string | null;
  /** The person this detail belongs to (role), vault only. */
  relatedTo: string | null;
  description: Rich | null;
  docs: number;
  mentions: number;
}

export const entitiesErrors: ErrorMapper[] = [
  (e) =>
    e instanceof ColourTakenError
      ? { status: 409, body: { error: e.message, colour: e.colour, owner: e.owner } }
      : undefined,
];
