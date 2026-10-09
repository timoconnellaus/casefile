// Route handlers are uniformly async, whether or not a given one awaits.
// deno-lint-ignore-file require-await
import type { Actor } from "../../core/publicdb.ts";
import { LOG_CATEGORIES, type LogCategory, logCsv, logEntries } from "../../core/summary.ts";
import { type ErrorMapper, HttpError, type Route, route, type RouteContext } from "./context.ts";

/** The AI-use log, its chain check, and the vault's security events. */
export function logRoutes({ s }: RouteContext): Route[] {
  return [
    // ── log ─────────────────────────────────────────────────────────────────
    route("GET", "/api/log", async ({ url }) => {
      const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 300));
      return Promise.resolve(
        s().store.listLog(limit).map((l) => ({ ...l, detail: JSON.parse(l.detail) })),
      );
    }),
    // Security events kept in the vault (possible probes; verified, adopted or user-written items
    // deleted outside the app), for the user only. A deleted item's last attested text is shown
    // with real names so the user can recognise and restore it.
    route(
      "GET",
      "/api/security-log",
      async () =>
        (await s().securityLog()).map((e) =>
          e.lastAttested
            ? {
              ...e,
              lastAttested: {
                ...e.lastAttested,
                label: s().reidentify(e.lastAttested.label).text,
                text: s().reidentify(e.lastAttested.text).text,
              },
            }
            : e
        ),
    ),
    route("GET", "/api/log/verify", async () => await s().verifyLog()),
    // The log as the user reads it: plain-language labels and categories, filtered and paged.
    route("GET", "/api/log/entries", async ({ url }) => {
      const q = url.searchParams;
      const what = q.get("what") || undefined;
      if (what && !LOG_CATEGORIES.some((c) => c.id === what)) {
        throw new HttpError(400, "Bad what");
      }
      const actor = q.get("actor") || undefined;
      if (actor && !["user", "claude", "app"].includes(actor)) {
        throw new HttpError(400, "Bad actor");
      }
      const doc = q.get("doc") || undefined;
      if (doc && !/^D\d+$/.test(doc)) throw new HttpError(400, "Bad doc");
      const date = (name: string) => {
        const v = q.get(name) || undefined;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Bad ${name}`);
        return v;
      };
      const int = (name: string, def: number, min: number, max: number) => {
        const v = q.get(name);
        if (v === null || v === "") return def;
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Bad ${name}`);
        return n;
      };
      return {
        categories: LOG_CATEGORIES,
        ...(await logEntries(s(), {
          what: what as LogCategory | undefined,
          actor: actor as Actor | undefined,
          doc,
          from: date("from"),
          to: date("to"),
          offset: int("offset", 0, 0, Number.MAX_SAFE_INTEGER),
          limit: int("limit", 100, 1, 500),
        })),
      };
    }),
    // Download the full log (CSV). The download itself is logged.
    route("GET", "/api/log/export", async () => {
      s().log("user", "log_exported");
      const csv = await logCsv(s());
      const day = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="casefile-ai-use-log-${day}.csv"`,
        },
      });
    }),
  ];
}

export const logErrors: ErrorMapper[] = [];
