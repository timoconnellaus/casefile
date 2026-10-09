/** Which hash to visit for each route in src/app/ui/routes.js (scripts/browsercheck.ts). */
import { ROUTES } from "../../src/app/ui/routes.js";

export interface Screen {
  name: string;
  hash: string;
}

/** What the seeded case offers for the routes that take a parameter. */
export interface ScreenData {
  docs: { id: string; status: string; state: string }[];
  drafts: { id: number }[];
}

/**
 * One screen per route. Routes with a required parameter get one from `data`; an optional
 * parameter (`:role?`) is left off. Throws for a parameterised route it has no value for, so a
 * new route cannot be skipped silently.
 */
export function screensFor(data: ScreenData, routes = ROUTES): Screen[] {
  const toReview = data.docs.find((d) => d.status === "pending")?.id;
  const shared = data.docs.find((d) => d.state === "shared")?.id;
  const draft = data.drafts[0]?.id;
  const params: Record<string, string | undefined> = {
    review: toReview && `#/review/${toReview}`,
    document: shared && `#/doc/${shared}`,
    draft: draft !== undefined ? `#/draft/${draft}` : undefined,
  };
  return routes.map((r) => {
    if (!r.path.includes(":")) return { name: r.name, hash: r.path };
    if (params[r.name]) return { name: r.name, hash: params[r.name]! };
    if (/^[^:]*\/:\w+\?$/.test(r.path)) {
      return { name: r.name, hash: r.path.replace(/\/:\w+\?$/, "") };
    }
    throw new Error(`No value for ${r.path}: add one to screensFor()`);
  });
}
