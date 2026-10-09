import { InvalidInputError, NotFoundError } from "../core/publicdb.ts";
import type { AppState } from "./state.ts";
import { type ErrorMapper, HttpError, makeContext, type Route } from "./routes/context.ts";
import { caseErrors, caseRoutes } from "./routes/case.ts";
import { settingsErrors, settingsRoutes } from "./routes/settings.ts";
import { docsErrors, docsRoutes } from "./routes/docs.ts";
import { planErrors, planRoutes } from "./routes/plan.ts";
import { entitiesErrors, entitiesRoutes } from "./routes/entities.ts";
import { searchErrors, searchRoutes } from "./routes/search.ts";
import { chronologyErrors, chronologyRoutes } from "./routes/chronology.ts";
import { issuesErrors, issuesRoutes } from "./routes/issues.ts";
import { notesErrors, notesRoutes } from "./routes/notes.ts";
import { draftsErrors, draftsRoutes } from "./routes/drafts.ts";
import { pasteErrors, pasteRoutes } from "./routes/paste.ts";
import { logErrors, logRoutes } from "./routes/log.ts";
import { overviewErrors, overviewRoutes } from "./routes/overview.ts";
import { exportErrors, exportRoutes } from "./routes/export.ts";
import { judgeErrors, judgeRoutes } from "./routes/judge.ts";

/**
 * JSON API for the desktop UI. Everything returned here is for the user's eyes: tokens are
 * re-identified to real names. Text the user sends is tokenised before it reaches public.db.
 *
 * The routes live in `routes/*.ts`, one module per area; each exports `<area>Routes(ctx)` and
 * `<area>Errors` (its domain errors' HTTP mappings).
 */

export { HttpError };
export type { Route };

export function buildRoutes(state: AppState): Route[] {
  const ctx = makeContext(state);
  return [
    // First: `/api/chronology/export` must not be read as a chronology entry id.
    ...exportRoutes(ctx),
    ...caseRoutes(ctx),
    ...settingsRoutes(ctx),
    ...docsRoutes(ctx),
    ...planRoutes(ctx),
    ...entitiesRoutes(ctx),
    ...pasteRoutes(ctx),
    ...searchRoutes(ctx),
    ...chronologyRoutes(ctx),
    ...issuesRoutes(ctx),
    ...draftsRoutes(ctx),
    ...notesRoutes(ctx),
    ...logRoutes(ctx),
    ...overviewRoutes(ctx),
    ...judgeRoutes(ctx),
  ];
}

/** Mappings every route shares, checked after the modules' own. */
const GENERAL_ERRORS: ErrorMapper[] = [
  (e) => e instanceof NotFoundError ? { status: 404, body: { error: e.message } } : undefined,
  (e) => e instanceof InvalidInputError ? { status: 400, body: { error: e.message } } : undefined,
  (e) => e instanceof SyntaxError ? { status: 400, body: { error: "Malformed JSON" } } : undefined,
];

/** Every error mapping, in the order they are tried: HttpError, then each module's, then general. */
export const ERROR_MAPPERS: ErrorMapper[] = [
  (e) =>
    e instanceof HttpError
      ? { status: e.status, body: { error: e.message, ...e.body } }
      : undefined,
  ...caseErrors,
  ...settingsErrors,
  ...docsErrors,
  ...planErrors,
  ...entitiesErrors,
  ...pasteErrors,
  ...searchErrors,
  ...chronologyErrors,
  ...issuesErrors,
  ...draftsErrors,
  ...notesErrors,
  ...logErrors,
  ...overviewErrors,
  ...exportErrors,
  ...judgeErrors,
  ...GENERAL_ERRORS,
];

/** Map domain errors to HTTP responses. */
export function errorResponse(e: unknown): { status: number; body: Record<string, unknown> } {
  for (const map of ERROR_MAPPERS) {
    const r = map(e);
    if (r) return r;
  }
  // Unexpected errors can carry document text or paths in their messages; don't send them on.
  return { status: 500, body: { error: "Something went wrong. Try again, or restart casefile." } };
}
