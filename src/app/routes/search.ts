import { searchAll } from "../../core/people.ts";
import { type ErrorMapper, HttpError, type Route, route, type RouteContext } from "./context.ts";

/** Searching the case's documents with real names. */
export function searchRoutes({ s, show }: RouteContext): Route[] {
  return [
    /**
     * Search everything with real names (⌘K). Reads the vault, not public.db's index (which Claude
     * can write), so `totals` are true counts of what the user's case holds. Lines are paged with
     * `?offset=&limit=` (limit at most 200).
     */
    route("GET", "/api/search/all", async ({ url }) => {
      const sp = url.searchParams;
      const int = (name: string): number | undefined => {
        const v = sp.get(name);
        if (v === null || v === "") return undefined;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Bad ${name}`);
        return n;
      };
      const r = await searchAll(s(), sp.get("q") ?? "", {
        offset: int("offset"),
        limit: int("limit"),
      });
      return {
        ...r,
        lines: r.lines.map((l) => ({
          doc_id: l.doc_id,
          line: l.line,
          text: l.tokenised === null
            ? { text: l.plain, segs: [{ t: l.plain }], unknown: [], malformed: [] }
            : show(l.tokenised),
          docTitle: l.docTitle,
          docState: l.docState,
        })),
        chronology: r.chronology.map((c) => ({ ...c, description: show(c.description) })),
        issues: r.issues.map((i) => ({ ...i, title: show(i.title) })),
      };
    }),
  ];
}

export const searchErrors: ErrorMapper[] = [];
