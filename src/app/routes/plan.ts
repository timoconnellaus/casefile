import { shareableOnCommercial } from "../../core/origin.ts";
import { type ClaudeSetup, conditionsMet, PlanConditionsError } from "../../core/session.ts";
import {
  type ErrorMapper,
  HttpError,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/**
 * The Claude plan as recorded by the user, with its conditions (ADR 7). A commercial plan needs
 * all three conditions; recording it shares nothing by itself.
 */
export function planRoutes({ s }: RouteContext): Route[] {
  /** The plan, and which documents could be shared one at a time or stay withheld. */
  const view = async () => {
    const session = s();
    const docs = await session.listDocInfo();
    const plan = session.settings.plan ?? null;
    const describe = (d: (typeof docs)[number]) => ({
      id: d.id,
      title: d.title,
      origin: d.origin,
      state: d.state,
    });
    return {
      setup: session.effectiveSetup,
      conditions: plan?.conditions ?? null,
      at: plan?.at ?? null,
      attested: plan
        ? await session.isAttested("plan", "current", {
          setup: plan.setup,
          conditions: plan.conditions ?? null,
        })
        : false,
      // On a commercial plan these could be shared, one at a time, by the user.
      couldShare: docs
        .filter((d) => d.state === "withheld" && shareableOnCommercial(d.origin))
        .map(describe),
      // Withheld whatever the plan: under an order, not sure, or not asked yet.
      stillWithheld: docs
        .filter((d) => d.state === "withheld" && !shareableOnCommercial(d.origin))
        .map((d) => ({ ...describe(d), reason: d.withheldReason })),
    };
  };
  return [
    route("GET", "/api/plan", view),
    route("POST", "/api/plan", async ({ body }) => {
      const b = await body();
      const setup = str(b.setup, "setup") as ClaudeSetup;
      if (setup !== "consumer" && setup !== "commercial") throw new HttpError(400, "Bad setup");
      const c = b.conditions;
      const conditions = c && typeof c === "object"
        ? {
          closedEnvironment: c.closedEnvironment === true,
          noTraining: c.noTraining === true,
          thisCaseOnly: c.thisCaseOnly === true,
        }
        : null;
      if (setup === "commercial" && !conditionsMet(conditions)) throw new PlanConditionsError();
      const r = await s().setClaudeSetup(setup, conditions);
      return { ...(await view()), withdrawn: r.withdrawn };
    }),
  ];
}

export const planErrors: ErrorMapper[] = [
  (e) =>
    e instanceof PlanConditionsError
      ? { status: 400, body: { error: e.message, conditions: false } }
      : undefined,
];
