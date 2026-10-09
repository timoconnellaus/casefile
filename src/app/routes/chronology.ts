import {
  chronologyState,
  ownStatementOnly,
  type UsedIn,
  userRemoved,
} from "../../core/checking.ts";
import { cantCheck, CantCheckError } from "../../core/claimcheck.ts";
import { StaleItemError } from "../../core/ledger.ts";
import { type ChronologyRow, parseSourceRef } from "../../core/publicdb.ts";
import type { CheckRow } from "../../core/states.ts";
import {
  type ErrorMapper,
  HttpError,
  num,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Draft paragraphs using an item, with draft titles re-identified. */
export function usedInOut(ctx: RouteContext, list: UsedIn[]) {
  return list.map((u) => ({ ...u, draftTitle: ctx.plain(u.draftTitle) }));
}

/** Notes for display, "dealt with" only as the user recorded it (ADR 8 amendment). */
export async function notesOut(ctx: RouteContext, type?: string, target?: string) {
  const { s } = ctx;
  const list = (await ctx.notes(type, target)) as { id: number }[];
  return await Promise.all(list.map(async (n) => {
    const done = await s().ledger.noteDoneByUser(s().store.getNote(n.id));
    return { ...n, done: done !== null, done_at: done, done_by: done !== null ? "user" : null };
  }));
}

/** The two-part (or one-part) check the user ticks before marking Claude's work as checked. */
export function checkFlags(b: Record<string, unknown>, names: string[]): Record<string, boolean> {
  const missing = names.filter((n) => b[n] !== true);
  if (missing.length) {
    throw new HttpError(400, "Tick each box to confirm what you checked.", { missing });
  }
  return Object.fromEntries(names.map((n) => [n, true]));
}

/**
 * Why a "mark as checked" (or an adoption) was refused with 409. Each has its own `code` and flag,
 * so the UI never has to guess from the message:
 * - `cant_check` (`cantCheck: true`, with the `checks` rows saying why): casefile can't check it;
 * - `stale` (`stale: true`): it changed since the user was shown it (version mismatch).
 */
export type ConflictCode = "cant_check" | "stale";

/** Refuse to mark as checked what casefile can't check (409, with the rows saying why). */
export function refuseCantCheck(ctx: RouteContext, checks: CheckRow[]): never {
  throw new HttpError(409, new CantCheckError(checks).message, {
    code: "cant_check" satisfies ConflictCode,
    cantCheck: true,
    checks: ctx.checks(checks),
  });
}

/** The chronology: Claude's and the user's entries, with their sources and checks. */
export function chronologyRoutes(ctx: RouteContext): Route[] {
  const { s, show, plain, guardedSave } = ctx;

  const entryOut = async (
    r: ChronologyRow,
    removedAt: string | null,
    removed: Awaited<ReturnType<typeof userRemoved>>,
  ) => {
    const c = await chronologyState(s(), r);
    return {
      id: r.id,
      event_date: r.event_date,
      description: show(r.description),
      // "You" only for items the app recorded as the user's (created_by is Claude-writable).
      created_by: await s().isUserItem("chronology", r) ? "user" : "claude",
      verified: c.verified,
      version: await s().itemVersion("chronology", r),
      verified_at: c.verified ? r.verified_at : null,
      state: c.state,
      checks: ctx.checks(c.checks),
      lapsed: c.lapsed,
      ownStatementOnly: await ownStatementOnly(s(), r.sources),
      sources: await ctx.sources(r.sources),
      removed_at: removedAt,
      issues: s().store.issuesForSources(r.sources, removed).map((i) => ({
        id: i.id,
        title: plain(i.title),
      })),
      usedIn: usedInOut(ctx, s().store.usedIn({ type: "chronology", id: r.id }, r.sources)),
      notes: await notesOut(ctx, "chrono", String(r.id)),
    };
  };

  return [
    // ── chronology ──────────────────────────────────────────────────────────
    route("GET", "/api/chronology", async ({ url }) => {
      const wantRemoved = url.searchParams.get("removed") === "1";
      // public.db's removed_at is Claude-writable: what the user removed comes from the ledger.
      await s().ledger.reconcileMarks();
      const removed = await userRemoved(s());
      const out = [];
      for (const r of s().store.listChronology({ includeRemoved: true })) {
        const at = await s().ledger.removedByUser("chronology", r);
        if ((at !== null) !== wantRemoved) continue;
        out.push(await entryOut(r, at, removed));
      }
      return out;
    }),
    route("POST", "/api/chronology", async ({ body }) => {
      const b = await body();
      const entry = {
        event_date: str(b.event_date, "date"),
        description: await s().tokeniseUserText(str(b.description, "description")),
        sources: (Array.isArray(b.sources) ? b.sources : []).filter(Boolean).map((x: string) =>
          parseSourceRef(x)
        ),
      };
      const id = s().store.addChronology(entry, "user");
      await s().recordUserItem("chronology", id, entry);
      return { id };
    }),
    route("PATCH", "/api/chronology/:id", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const cur = s().store.getChronology(id);
      if (await s().ledger.removedByUser("chronology", cur) !== null) {
        throw new HttpError(409, "Restore this entry before changing it.");
      }
      const desc = typeof b.description === "string" ? b.description : "";
      // Unchanged text is not re-tokenised; changed text may not keep a name Claude wrote.
      const descChanged = Boolean(desc) && desc !== plain(cur.description);
      await guardedSave(`chrono:${id}`, descChanged ? [[desc, [cur.description]]] : []);
      const wasUsers = await s().isUserItem("chronology", cur);
      const patch = {
        event_date: b.event_date || undefined,
        description: descChanged ? await s().tokeniseUserText(desc) : undefined,
        sources: Array.isArray(b.sources)
          ? b.sources.filter(Boolean).map((x: string) => parseSourceRef(x))
          : undefined,
      };
      // The user's own edit withdraws their check: it is "To check", not "Changed since you
      // checked" (that is for changes the user did not make).
      if (patch.event_date || patch.description || patch.sources) {
        await s().unverify("chronology", id);
      }
      s().store.updateChronology(id, patch);
      if (wasUsers) {
        // The user's own entry stays theirs: record the content the app just wrote.
        await s().recordUserItem("chronology", id, {
          event_date: patch.event_date ?? cur.event_date,
          description: patch.description ?? cur.description,
          sources: patch.sources ?? cur.sources,
        });
      }
      return { ok: true };
    }),
    route("DELETE", "/api/chronology/:id", async ({ params }) => {
      const id = num(params.id, "id");
      s().store.getChronology(id);
      await s().ledger.forgetMarks("chronology", id);
      await s().deleteChronology(id);
      return { ok: true };
    }),
    route("POST", "/api/chronology/:id/remove", async ({ params }) => {
      const id = num(params.id, "id");
      const r = s().store.getChronology(id);
      await s().ledger.removeItem("chronology", id);
      // Drafts relying on it, so the UI can warn.
      return {
        ok: true,
        usedIn: usedInOut(ctx, s().store.usedIn({ type: "chronology", id }, r.sources)),
      };
    }),
    route("POST", "/api/chronology/:id/restore", async ({ params }) => {
      await s().ledger.restoreItem("chronology", num(params.id, "id"));
      return { ok: true };
    }),
    route("POST", "/api/chronology/:id/verify", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const version = str(b.version, "version");
      const flags = checkFlags(b, ["quoteAccurate", "fairReading"]);
      const c = await chronologyState(s(), s().store.getChronology(id));
      if (cantCheck(c.checks)) refuseCantCheck(ctx, c.checks);
      await s().ledger.verifyChronology(id, version, flags);
      return { ok: true };
    }),
    route("POST", "/api/chronology/:id/unverify", async ({ params }) => {
      await s().unverify("chronology", num(params.id, "id"));
      return { ok: true };
    }),
  ];
}

export const chronologyErrors: ErrorMapper[] = [
  (e) =>
    e instanceof CantCheckError
      ? {
        status: 409,
        body: { error: e.message, code: "cant_check" satisfies ConflictCode, cantCheck: true },
      }
      : undefined,
  // Verifying (chronology, evidence, issue) or adopting a paragraph with an old `version`.
  (e) =>
    e instanceof StaleItemError
      ? {
        status: 409,
        body: { error: e.message, code: "stale" satisfies ConflictCode, stale: true },
      }
      : undefined,
];
