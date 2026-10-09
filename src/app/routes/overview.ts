// Route handlers are uniformly async, whether or not a given one awaits.
// deno-lint-ignore-file require-await
import { courtSummary, toCheck } from "../../core/summary.ts";
import { type ErrorMapper, type Route, route, type RouteContext } from "./context.ts";

/** The To-check queue and the Court summary (ADR 0018). */
export function overviewRoutes({ s }: RouteContext): Route[] {
  return [
    // Everything waiting for the user, most serious first, then oldest.
    route("GET", "/api/to-check", async () => await toCheck(s())),
    // "If the Court asks" (PD-AI 4.11): fixed wording from core, built from signed records only.
    route("GET", "/api/court-summary", async () => await courtSummary(s())),
    // The user copied the summary (to give the Court, or a lawyer). Logged: what left casefile
    // and when matters for PD-AI 4.11. Nothing from the request is used.
    route("POST", "/api/court-summary/copied", async () => {
      s().log("user", "court_summary_copied");
      return { ok: true };
    }),
  ];
}

export const overviewErrors: ErrorMapper[] = [];
