// To check (W2-7): one queue of everything waiting for the user, most serious first, then oldest
// (GET /api/to-check, ADR 0018). Filters by What and Who, the next step per item, an empty state
// and a context panel. casefile never marks Claude's work as checked for the user, so this screen
// only shows and links; the checking happens on each item's own screen.
import { clear, h } from "../dom.js";
import { api } from "../lib.js";
import { plural } from "../model.js";
import { ActorLabel, Badge, EmptyState, listShortcuts } from "../components/index.js";

/** Badge domain for each item kind (DESIGN-SPEC §3). */
const DOMAIN = {
  document: "doc",
  chronology: "work",
  evidence: "work",
  issue: "work",
  paragraph: "para",
};

/** One line under each group heading: what the group is and why it matters. */
const GROUP_NOTES = {
  "Exposed documents": "Claude could read a name or number here. Fix these first.",
  "Documents to review": "Check the names before Claude sees them.",
  "Chronology entries": "Claude wrote these. Compare each with the lines it cites.",
  "Evidence links": "Claude linked these lines to an issue.",
  "Affidavit paragraphs": "An affidavit must be in your own words.",
  "Draft paragraphs": "Claude drafted these. Rewrite them or use them as your own.",
  "Issue descriptions": "Claude described these questions. Check the wording is fair.",
};

const WHO = [
  { id: "all", label: "Anyone" },
  { id: "claude", label: "Claude" },
  { id: "user", label: "You" },
  { id: "app", label: "casefile checked" },
];

/** The short label on the next-step link (the full sentence is the API's `next`). */
export function nextLabel(item) {
  switch (item.kind) {
    case "document":
      return item.state === "exposed" ? `Re-check ${item.where?.doc ?? item.id}` : "Check names";
    case "chronology":
    case "evidence":
      if (item.state === "cant_check") return "See what Claude cited";
      if (item.state === "changed") return "Check again";
      return item.kind === "evidence" ? "Check link" : "Check against the document";
    case "paragraph":
      return item.state === "claude_rewritten" ? "Adopt to confirm" : "Rewrite or adopt";
    case "issue":
      return item.state === "cant_check" ? "See what Claude wrote" : "Check description";
    default:
      return "Open";
  }
}

/** Where the item is: a cited line, or the screen it lives on. */
function whereOf(item) {
  const w = item.where ?? {};
  if (w.doc) {
    // "D001:1–2 +1": the first cited range, and how many more sources (QA T1).
    const range = w.line ? `${w.line}${w.line_end ? `–${w.line_end}` : ""}` : "";
    const label = `${range ? `${w.doc}:${range}` : w.doc}${w.more ? ` +${w.more}` : ""}`;
    const spoken = `${range ? `${w.doc} ${w.line_end ? "lines" : "line"} ${range}` : w.doc}${
      w.more ? `, and ${w.more} more ${w.more === 1 ? "source" : "sources"}` : ""
    }`;
    return {
      label,
      aria: spoken,
      href: w.line ? `#/doc/${w.doc}:${w.line}` : `#/doc/${w.doc}`,
      mono: true,
    };
  }
  const label = item.kind === "paragraph" ? "Draft" : item.kind === "issue" ? "Issues" : "Open";
  // Distinct names for repeated links (spec §7, QA T2): "Open Affidavit of …, paragraph 4".
  return { label, aria: `Open ${item.detail}`, href: w.href, mono: false };
}

function key(item) {
  return `${item.kind}:${item.id}`;
}

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {any} _ctx */
export default async function view(main, _params, _ctx) {
  const data = await api("GET", "/api/to-check");
  const items = data.items ?? [];
  const state = { what: "all", who: "all", sel: items[0] ? key(items[0]) : null };

  const status = h("div", { class: "tc-status", role: "status", "aria-live": "polite" });
  const list = h("div", {
    class: "tc-list",
    role: "region",
    "aria-label": "To check list",
    tabindex: "0",
  });
  const whatGroup = h("div", { class: "tc-filter", role: "group", "aria-labelledby": "tc-f-what" });
  const whoGroup = h("div", { class: "tc-filter", role: "group", "aria-labelledby": "tc-f-who" });

  // Display order: the groups in the API's order, items within a group in the API's order (most
  // serious first, then oldest). Arrow keys follow the same order as the screen.
  const groupOrder = (data.groups ?? []).map((g) => g.what);
  const rank = (i) => {
    const g = groupOrder.indexOf(i.what);
    return g < 0 ? groupOrder.length : g;
  };
  const ordered = items.map((item, n) => ({ item, n }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.n - b.n).map((x) => x.item);
  const visible = () =>
    ordered.filter((i) =>
      (state.what === "all" || i.what === state.what) &&
      (state.who === "all" || i.actor === state.who)
    );

  function filterButton(label, count, pressed, onclick) {
    return h(
      "button",
      { type: "button", class: "tc-filter-btn", "aria-pressed": pressed, onclick },
      h("span", {}, label),
      h("span", { class: "num muted" }, String(count)),
    );
  }

  function renderFilters() {
    const groups = data.groups ?? [];
    clear(
      whatGroup,
      h("h2", { id: "tc-f-what", class: "eyebrow tc-filter-title" }, "What"),
      filterButton("Everything", items.length, state.what === "all", () => pick({ what: "all" })),
      groups.map((g) =>
        filterButton(g.what, g.count, state.what === g.what, () => pick({ what: g.what }))
      ),
    );
    clear(
      whoGroup,
      h("h2", { id: "tc-f-who", class: "eyebrow tc-filter-title" }, "Who"),
      WHO.map((w) =>
        filterButton(
          w.label,
          w.id === "all" ? items.length : items.filter((i) => i.actor === w.id).length,
          state.who === w.id,
          () => pick({ who: w.id }),
        )
      ),
    );
  }

  function pick(change) {
    const focusWhat = change.what !== undefined;
    Object.assign(state, change);
    const shown = visible();
    if (!shown.some((i) => key(i) === state.sel)) state.sel = shown[0] ? key(shown[0]) : null;
    renderFilters();
    renderList();
    // Keep focus on the pressed filter after re-rendering the buttons.
    const group = focusWhat ? whatGroup : whoGroup;
    group.querySelector('[aria-pressed="true"]')?.focus();
  }

  function row(item) {
    const where = whereOf(item);
    const next = nextLabel(item);
    const danger = item.level === "danger";
    return h(
      "tr",
      {
        role: "row",
        class: key(item) === state.sel ? "is-selected" : null,
        "data-key": key(item),
        onfocusin: () => select(key(item), false),
        onclick: () => select(key(item), false),
      },
      h(
        "th",
        { scope: "row", role: "rowheader", class: "tc-what" },
        h("a", { class: "tc-what-link", href: item.where?.href }, item.detail),
        h("div", { class: "muted small tc-next" }, item.next),
      ),
      h(
        "td",
        { role: "cell", class: "tc-where" },
        where.href
          ? h("a", {
            class: where.mono ? "mono small" : "small",
            href: where.href,
            "aria-label": where.aria,
          }, where.label)
          : "",
      ),
      h("td", { role: "cell", class: "nowrap" }, ActorLabel(item.actor)),
      h("td", { role: "cell" }, Badge(DOMAIN[item.kind], item.state)),
      h(
        "td",
        { role: "cell", class: "nowrap tc-action" },
        h("a", {
          class: danger ? "btn btn-primary btn-lg" : "btn",
          href: item.where?.href,
          "aria-label": `${next}: ${item.detail}`,
          "data-next": "",
        }, next),
      ),
    );
  }

  function renderList() {
    const shown = visible();
    status.textContent = items.length
      ? `Showing ${shown.length} of ${plural(items.length, "item")}.`
      : "Nothing is waiting for you.";
    if (!items.length) {
      clear(
        list,
        EmptyState({
          title: "✓ All done",
          message:
            "Every document has been reviewed, and everything Claude wrote has been checked against the documents. New work from Claude will appear here.",
          action: h("a", { class: "btn", href: "#/start" }, "Ask Claude to do something"),
        }),
      );
      return;
    }
    if (!shown.length) {
      clear(
        list,
        EmptyState({
          message: "Nothing to check for this filter.",
          action: h("button", {
            type: "button",
            class: "btn",
            onclick: () => pick({ what: "all", who: "all" }),
          }, "Show everything"),
        }),
      );
      return;
    }
    const order = (data.groups ?? []).map((g) => g.what);
    for (const i of shown) if (!order.includes(i.what)) order.push(i.what);
    clear(
      list,
      ...order.map((what, gi) => {
        const rows = shown.filter((i) => i.what === what);
        if (!rows.length) return null;
        const danger = what === "Exposed documents";
        const hid = `tc-g-${gi}`;
        return h(
          "section",
          { class: danger ? "tc-group tc-group--danger" : "tc-group", "aria-labelledby": hid },
          h(
            "div",
            { class: "tc-group-head" },
            h(
              "h2",
              { id: hid, class: "tc-group-title" },
              danger ? h("span", { class: "danger-text tiny", "aria-hidden": "true" }, "▲") : null,
              h("span", {}, what),
              h("span", { class: "num muted tc-group-count" }, String(rows.length)),
            ),
            GROUP_NOTES[what] ? h("span", { class: "muted" }, GROUP_NOTES[what]) : null,
          ),
          h(
            "div",
            { class: "tc-table-wrap" },
            h(
              "table",
              // Explicit roles keep the table's semantics when narrow screens stack it as cards.
              { class: "tc-table", role: "table" },
              h("caption", { class: "sr" }, `${what}: ${plural(rows.length, "item")}`),
              h(
                "thead",
                { role: "rowgroup" },
                h(
                  "tr",
                  {},
                  h("th", { scope: "col", role: "columnheader", class: "tc-col-what" }, "What"),
                  h("th", { scope: "col", role: "columnheader" }, "Where"),
                  h("th", { scope: "col", role: "columnheader" }, "Who"),
                  h("th", { scope: "col", role: "columnheader" }, "State"),
                  h("th", { scope: "col", role: "columnheader" }, "Next step"),
                ),
              ),
              h("tbody", { role: "rowgroup" }, rows.map(row)),
            ),
          ),
        );
      }),
    );
  }

  /** Select a row; with `focus`, move focus to its link so a screen reader reads it. */
  function select(k, focus) {
    if (state.sel !== k) {
      state.sel = k;
      for (const tr of list.querySelectorAll("tr[data-key]")) {
        tr.classList.toggle("is-selected", tr.dataset.key === k);
      }
    }
    if (focus) list.querySelector(`tr[data-key="${k}"] .tc-what-link`)?.focus();
  }

  function move(by) {
    const keys = visible().map(key);
    if (!keys.length) return;
    const i = keys.indexOf(state.sel);
    const to = i < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, i + by));
    select(keys[to], true);
  }

  listShortcuts(list, {
    ArrowDown: () => move(1),
    ArrowUp: () => move(-1),
    Enter: (e) => {
      // Enter on a link does what the link says; on the list itself it opens the next step.
      const own = e.target instanceof HTMLElement ? e.target.closest("a, button") : null;
      if (own) own.click();
      else list.querySelector(`tr[data-key="${state.sel}"] [data-next]`)?.click();
    },
  }, { enabled: true }); // arrows and Enter aren't single-letter shortcuts: always on (QA T3)

  const hint = items.length
    ? h(
      "div",
      { class: "muted small" },
      "When the list has focus: ",
      h("kbd", { class: "kbd" }, "↑"),
      " ",
      h("kbd", { class: "kbd" }, "↓"),
      " move · ",
      h("kbd", { class: "kbd" }, "↵"),
      " open the next step",
    )
    : null;

  renderFilters();
  renderList();

  clear(
    main,
    h(
      "div",
      { class: "tc" },
      h(
        "aside",
        { class: "tc-filters", "aria-label": "Filters" },
        whatGroup,
        whoGroup,
        h(
          "p",
          { class: "muted small tc-filters-note" },
          "Sorted most serious first, then oldest. Things stay here until you check them — casefile never marks Claude’s work as checked for you.",
        ),
      ),
      h(
        "div",
        { class: "tc-main" },
        h(
          "div",
          { class: "tc-head" },
          h("h1", {}, "To check"),
          h("span", { class: "muted" }, "Everything across the case that needs you, in one list."),
        ),
        h("div", { class: "tc-bar" }, status, h("div", { class: "spacer" }), hint),
        list,
      ),
      contextPanel(items),
    ),
  );
}

/** The side panel: what the waiting items hold up, how checking works, and Paste. */
function contextPanel(items) {
  const exposed = items.filter((i) => i.kind === "document" && i.state === "exposed");
  const affidavit = items.filter((i) => i.what === "Affidavit paragraphs");
  const waiting = [
    affidavit.length
      ? h(
        "li",
        {},
        `An affidavit can’t be exported until you have used each paragraph Claude drafted as your own words (${
          plural(affidavit.length, "paragraph")
        } waiting here).`,
      )
      : null,
    h("li", {}, "The “If the Court asks” summary only counts things you have checked."),
    ...exposed.map((i) =>
      h("li", {}, `${i.where?.doc ?? i.id} stays withdrawn from Claude until you re-check it.`)
    ),
  ];
  return h(
    "aside",
    { class: "tc-context", "aria-label": "What this list holds up" },
    items.length
      ? h(
        "section",
        { class: "vstack gap-sm", "aria-labelledby": "tc-ctx-wait" },
        h("h2", { id: "tc-ctx-wait", class: "tc-ctx-title" }, "What’s waiting on this list"),
        h("ul", { class: "tc-ctx-list" }, waiting),
      )
      : null,
    h(
      "section",
      { class: "vstack gap-sm", "aria-labelledby": "tc-ctx-how" },
      h("h2", { id: "tc-ctx-how", class: "tc-ctx-title" }, "How checking works"),
      h(
        "p",
        {},
        "“Check against the document” opens the lines Claude cited, with two lines either side. casefile also checks that each name, date and number in Claude’s entry appears in those lines. You decide whether the entry is fair.",
      ),
      h("a", { href: "#/chronology" }, "See it in the Chronology"),
    ),
    h(
      "section",
      { class: "vstack gap-sm", "aria-labelledby": "tc-ctx-paste" },
      h("h2", { id: "tc-ctx-paste", class: "tc-ctx-title" }, "Text from Claude’s chat"),
      h(
        "p",
        {},
        "Paste something Claude wrote to read it with real names, checked sentence by sentence.",
      ),
      h("a", { href: "#/paste" }, "See Claude’s text with real names"),
    ),
  );
}
