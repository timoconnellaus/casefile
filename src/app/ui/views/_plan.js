// The Claude plan, shared by Settings and Getting started: the commercial three-condition panel
// (PD-AI 5.5), recording a plan, and the words both screens use for plans, origins and days.
import { h } from "../dom.js";
import { api } from "../lib.js";
import { announce, showToast } from "../components/index.js";
import { formatDay, plural } from "../model.js";

/** Where a document came from (ADR 7), in plain words. */
export const ORIGIN_LABELS = {
  mine: "Mine",
  other_side: "From the other side",
  court_or_subpoena: "From a subpoena or the court",
  under_order: "Under an order or undertaking",
  not_sure: "Not sure",
};

/** Why a withheld document stays withheld on any plan. */
function stillWithheldWhy(d) {
  if (d.origin === "under_order") return "Under an order or undertaking (check the order itself)";
  if (d.origin === "not_sure") return "Not sure (until you decide)";
  return "Not asked yet (until you say where it came from)";
}

export const PLAN_LABELS = {
  consumer: "Free, Pro or Max (consumer)",
  commercial: "Team, Enterprise or API (commercial)",
};

/** "today", or "3 Sep 2025". */
export function whenDay(iso, short = true) {
  if (!iso) return "";
  const d = new Date(iso);
  const t = new Date();
  if (
    d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  ) return "today";
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
  return formatDay(local, short);
}

/** A link to a document. */
function docLink(d) {
  return h("a", { href: `#/doc/${encodeURIComponent(d.id)}` }, d.id);
}

/**
 * The commercial plan panel (PD-AI 5.5): three conditions, what could then be shared, and what
 * stays withheld. Recording the plan shares nothing by itself.
 * @param {{plan: any, onConfirm: (conditions: object) => unknown, onCancel: () => unknown,
 *   headingLevel?: "h2"|"h3"|"h4"}} opts
 */
export function CommercialPanel(opts) {
  const id = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const H = opts.headingLevel ?? "h3";
  const conds = [
    [
      "closedEnvironment",
      "The information stays in a closed environment that others can’t access, and Anthropic is bound by confidentiality terms I could enforce.",
    ],
    ["noTraining", "It won’t be used to train any AI model."],
    ["thisCaseOnly", "I’ll use it only for this case."],
  ];
  const boxes = conds.map(([k, text]) => {
    const box = h("input", { type: "checkbox", id: `${id}-${k}`, "data-k": k });
    return {
      k,
      box,
      row: h("label", { class: "set-tick", for: box.id }, box, h("span", {}, text)),
    };
  });
  const confirm = h("button", {
    type: "button",
    class: "btn btn-primary btn-lg",
    "aria-disabled": "true",
    "aria-describedby": `${id}-need`,
    onclick: async (ev) => {
      if (!boxes.every((b) => b.box.checked)) {
        announce("Tick all three to confirm a commercial plan.");
        boxes.find((b) => !b.box.checked)?.box.focus();
        return;
      }
      const btn = ev.currentTarget;
      btn.setAttribute("aria-disabled", "true");
      try {
        await opts.onConfirm(Object.fromEntries(boxes.map((b) => [b.k, true])));
      } finally {
        if (btn.isConnected) sync();
      }
    },
  }, "Confirm commercial plan");
  const need = h("span", { id: `${id}-need`, class: "muted" });
  const sync = () => {
    const all = boxes.every((b) => b.box.checked);
    confirm.setAttribute("aria-disabled", String(!all));
    need.textContent = all ? "" : "Tick all three to confirm.";
  };
  for (const b of boxes) b.box.addEventListener("change", sync);
  sync();

  const could = opts.plan?.couldShare ?? [];
  const still = opts.plan?.stillWithheld ?? [];
  const withheldTotal = could.length + still.length;
  const panel = h(
    "div",
    {
      class: "set-commercial",
      role: "region",
      "aria-labelledby": `${id}-h`,
      onkeydown: (e) => {
        if (e.key === "Escape") opts.onCancel();
      },
    },
    h(H, { id: `${id}-h`, class: "set-commercial-title" }, "Switch to a commercial plan?"),
    h(
      "p",
      {},
      "Only confirm what you have checked in your plan’s terms. If you aren’t sure about any of these, keep the consumer plan setting.",
    ),
    h(
      "fieldset",
      { class: "vstack" },
      h(
        "legend",
        { class: "set-legend" },
        "I’m satisfied that, under my plan’s terms (PD-AI 5.5):",
      ),
      boxes.map((b) => b.row),
    ),
    h(
      "div",
      { class: "vstack gap-sm" },
      h(H === "h2" ? "h3" : "h4", { class: "set-subtitle" }, "What could then be shared"),
      could.length
        ? [
          h(
            "p",
            {},
            "These become available to share, with names replaced. Nothing goes to Claude until you share each one yourself.",
          ),
          h(
            "ul",
            { class: "set-doclist" },
            could.map((d) =>
              h(
                "li",
                {},
                docLink(d),
                ` ${d.title ? `${d.title} · ` : "· "}${ORIGIN_LABELS[d.origin] ?? ""}`,
              )
            ),
          ),
        ]
        : h(
          "p",
          {},
          "No documents kept from Claude are from the other side or from a subpoena or the court, so nothing new could be shared.",
        ),
      still.length
        ? h(
          "div",
          { class: "vstack gap-sm" },
          h("p", {}, "Still withheld whatever your plan:"),
          h(
            "ul",
            { class: "set-doclist" },
            still.map((d) =>
              h("li", {}, docLink(d), ` ${d.title ? `${d.title} · ` : "· "}${stillWithheldWhy(d)}`)
            ),
          ),
        )
        : null,
      withheldTotal
        ? h(
          "p",
          { class: "muted" },
          `That is all ${plural(withheldTotal, "document")} kept from Claude.`,
        )
        : null,
    ),
    h(
      "p",
      {},
      "Your answers and the date are recorded in the AI-use log, so you can explain this if the Court asks (PD-AI 4.11).",
    ),
    h(
      "div",
      { class: "hstack set-actions" },
      confirm,
      h(
        "button",
        { type: "button", class: "btn btn-lg", onclick: () => opts.onCancel() },
        "Cancel",
      ),
      need,
    ),
  );
  panel.focusFirst = () => boxes[0].box.focus();
  return panel;
}

/** Record a plan and say what happened. Returns the new /api/plan view. */
export async function recordPlan(setup, conditions) {
  const r = await api("POST", "/api/plan", conditions ? { setup, conditions } : { setup });
  const withdrawn = r.withdrawn ?? [];
  const msg = setup === "commercial"
    ? "Commercial plan recorded in the AI-use log. Nothing has been shared; share each document yourself."
    : `Consumer plan recorded in the AI-use log.${
      withdrawn.length
        ? ` ${plural(withdrawn.length, "document")} from the other side or a subpoena ${
          withdrawn.length === 1 ? "was" : "were"
        } withdrawn from Claude.`
        : ""
    }`;
  showToast(msg, { glyph: "check" });
  announce(msg);
  return r;
}
