/** Wave 0 split api.ts into routes/*.ts; the route set must be exactly what it was. */
import { assertEquals } from "@std/assert";
import { buildRoutes, errorResponse } from "../src/app/api.ts";
import { HttpError } from "../src/app/routes/context.ts";
import { InvalidInputError, NotFoundError } from "../src/core/publicdb.ts";
import { LeakError, ProbeError, UnresolvedError } from "../src/core/session.ts";
import { ExportBlockedError } from "../src/core/drafting.ts";
import { WrongPassphraseError } from "../src/core/vault.ts";
import { setup } from "./helpers/app.ts";

/**
 * Every route in api.ts before the split (method, path, and whether it is open), less the
 * deprecated ones W3-4 removed (`REMOVED`).
 */
const BEFORE_SPLIT = [
  "GET /api/status open",
  "POST /api/case/create open",
  "POST /api/case/open open",
  "POST /api/lock",
  "POST /api/case/passphrase",
  "GET /api/settings",
  "PUT /api/settings",
  "POST /api/settings/check-llm",
  "GET /api/docs",
  "POST /api/docs/import",
  "GET /api/docs/:id/review",
  "POST /api/docs/:id/redetect",
  "POST /api/docs/:id/publish",
  "DELETE /api/docs/:id",
  "GET /api/docs/:id",
  "GET /api/docs/:id/claude-view",
  "PUT /api/docs/:id/meta",
  "POST /api/docs/:id/tags",
  "DELETE /api/docs/:id/tags/:tag",
  "GET /api/audit",
  "PATCH /api/entities/:role",
  "GET /api/chronology",
  "POST /api/chronology",
  "PATCH /api/chronology/:id",
  "DELETE /api/chronology/:id",
  "POST /api/chronology/:id/verify",
  "POST /api/chronology/:id/unverify",
  "GET /api/issues",
  "POST /api/issues",
  "DELETE /api/issues/:id",
  "POST /api/issues/:id/verify",
  "POST /api/issues/:id/unverify",
  "POST /api/issues/:id/evidence",
  "DELETE /api/evidence/:id",
  "POST /api/evidence/:id/verify",
  "POST /api/evidence/:id/unverify",
  "GET /api/drafts",
  "POST /api/drafts",
  "GET /api/drafts/:id",
  "PATCH /api/drafts/:id",
  "DELETE /api/drafts/:id",
  "POST /api/drafts/:id/paragraphs",
  "PUT /api/paragraphs/:id",
  "DELETE /api/paragraphs/:id",
  "POST /api/paragraphs/:id/adopt",
  "POST /api/paragraphs/:id/unadopt",
  "GET /api/drafts/:id/export",
  "GET /api/notes",
  "POST /api/notes",
  "DELETE /api/notes/:id",
  "GET /api/log",
  "GET /api/security-log",
  "GET /api/log/verify",
];

/** Deprecated routes removed in the W3-4 cleanup, once no screen used them. */
const REMOVED = [
  "POST /api/settings/claude-setup", // POST /api/plan records the plan with its conditions
  "POST /api/docs/:id/sensitivity", // PUT /api/docs/:id/origin
  "GET /api/entities", // GET /api/people (the role routes stay)
  "GET /api/search", // GET /api/search/all
  "GET /api/stats", // the To-check queue and Court summary
  "POST /api/reidentify", // POST /api/paste/view
];

// Wave 1 adds routes, so this checks that every route api.ts had is still there, unchanged
// (method, path and openness), and that no route is duplicated.
Deno.test("the split route modules keep every route api.ts had", async () => {
  const { state } = await setup();
  const routes = buildRoutes(state).map((r) => {
    let i = 0;
    const path = r.pattern.source.slice(1, -1).replaceAll("\\/", "/")
      .replaceAll("([^/]+)", () => `:${r.keys[i++]}`);
    return `${r.method} ${path}${r.open ? " open" : ""}`;
  });
  assertEquals(routes.length, new Set(routes).size, "no duplicates");
  assertEquals(BEFORE_SPLIT.filter((r) => !routes.includes(r)), [], "routes missing");
  assertEquals(REMOVED.filter((r) => routes.includes(r)), [], "deprecated routes are gone");
  // Only the three routes that were open before may be open.
  assertEquals(
    routes.filter((r) => r.endsWith(" open")).sort(),
    BEFORE_SPLIT.filter((r) => r.endsWith(" open")).sort(),
  );
});

Deno.test("errors map to the same responses as before the split", () => {
  const cases: [unknown, number, string?][] = [
    [new HttpError(418, "teapot", { x: 1 }), 418],
    [new WrongPassphraseError(), 401],
    [new LeakError([]), 409],
    [new UnresolvedError([]), 409],
    [new ExportBlockedError(1, [], []), 409],
    [new NotFoundError("thing"), 404],
    [new ProbeError(["mother"]), 400],
    [new InvalidInputError("bad"), 400],
    [new SyntaxError("x"), 400, "Malformed JSON"],
    [new Error("secret text"), 500],
  ];
  for (const [e, status, error] of cases) {
    const r = errorResponse(e);
    assertEquals(r.status, status, String(e));
    if (error) assertEquals(r.body.error, error);
  }
  assertEquals(errorResponse(new HttpError(418, "teapot", { x: 1 })).body, {
    error: "teapot",
    x: 1,
  });
  assertEquals(
    Object.keys(errorResponse(new UnresolvedError([])).body).sort(),
    ["error", "unresolved"],
  );
});
