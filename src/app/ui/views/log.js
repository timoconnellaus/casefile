// AI-use log (W2-7): the "If the Court asks" summary (GET /api/court-summary, wording fixed in
// core so the UI cannot overstate it; ADR 0018) and the full log (GET /api/log/entries), grouped
// by date with plain labels, filters, the log check and a download (GET /api/log/export).
import { clear, h } from "../dom.js";
import { api } from "../lib.js";
import { formatDay, plural } from "../model.js";
import {
  ActorLabel,
  announce,
  Callout,
  copyText,
  EmptyState,
  FlagBadge,
  Segmented,
} from "../components/index.js";

const PAGE = 100;

const WHO = [
  { id: "all", label: "Everyone" },
  { id: "claude", label: "Claude" },
  { id: "user", label: "You" },
  { id: "app", label: "casefile" },
];

/** "Tuesday 7 October 2025" in local time. */
function dayHeading(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return formatDay(ts);
  return d.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).replace(",", "");
}

function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "14:41" in local time. */
function timeOf(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {any} _ctx */
export default async function view(main, _params, _ctx) {
  const [summary, first] = await Promise.all([
    api("GET", "/api/court-summary"),
    api("GET", `/api/log/entries?limit=${PAGE}`),
  ]);

  clear(
    main,
    h(
      "div",
      { class: "log" },
      h("h1", {}, "AI-use log"),
      courtSummary(summary),
      fullLog(summary, first),
    ),
  );
}

// ── "If the Court asks" ──────────────────────────────────────────────────────

/**
 * The summary's heading as this screen's first mention of the practice direction: plain English
 * first, then the number (spec §6, QA L1). The copied text keeps the summary's own title.
 */
export function plainTitle(title) {
  const t = String(title ?? "");
  const m = /^If the Court asks: use of AI \(PD-AI ([\d.]+)\)$/.exec(t);
  if (m) return `If the Court asks about AI use (the Court’s rules on AI, PD-AI ${m[1]})`;
  return t.replace(/\(PD-AI ([\d.]+)\)/, "(the Court’s rules on AI, PD-AI $1)");
}

function courtSummary(s) {
  const msg = h("span", { class: "muted small", role: "status" });
  const copy = async () => {
    if (await copyText(s.text)) {
      // The copy is recorded: what left casefile, and when, belongs in the AI-use log.
      try {
        await api("POST", "/api/court-summary/copied");
        msg.textContent = "Copied the summary. Recorded in the log.";
      } catch {
        msg.textContent = "Copied the summary.";
      }
    } else {
      msg.textContent = "casefile couldn’t copy. Select the text and copy it yourself.";
    }
  };
  return h(
    "section",
    { class: "log-court", "aria-labelledby": "log-court-h" },
    h(
      "div",
      { class: "vstack gap-sm" },
      h("h2", { id: "log-court-h", class: "log-court-title" }, plainTitle(s.title)),
      h("p", { class: "log-measure" }, s.intro),
      h(
        "p",
        { class: "log-measure" },
        "Read these answers before you rely on them. They show what casefile recorded, not more.",
      ),
    ),
    (s.sections ?? []).map((sec) =>
      h(
        "section",
        { class: "log-court-sec", "aria-labelledby": `log-sec-${sec.id}` },
        h("h3", { id: `log-sec-${sec.id}`, class: "log-q" }, sec.title),
        h("ul", { class: "log-lines" }, sec.lines.map((l) => h("li", {}, l))),
        sec.id === "open" && s.figures?.open?.total
          ? h("a", { href: "#/to-check" }, "Open To check")
          : null,
      )
    ),
    h(
      "div",
      { class: "hstack log-court-actions" },
      h("button", { type: "button", class: "btn btn-primary btn-lg", onclick: copy }, "Copy"),
      msg,
    ),
  );
}

// ── the full log ─────────────────────────────────────────────────────────────

function fullLog(summary, first) {
  const filters = { who: "all", what: "", doc: "", from: "", to: "" };
  const categories = first.categories ?? [];
  const allTotal = first.total;
  let rows = first.rows;
  let total = first.total;
  let lastDay = null;
  let lastBody = null;

  const body = h("div", { id: "log-full", class: "vstack gap-lg" });
  const count = h("div", { class: "muted small", role: "status" });
  const groups = h("div", { class: "vstack gap-lg" });
  const more = h("div", {});

  const what = h(
    "select",
    { class: "log-select", onchange: (e) => setFilter({ what: e.target.value }) },
    h("option", { value: "" }, "Everything"),
    categories.map((c) => h("option", { value: c.id }, c.label)),
  );
  const docError = h("span", { id: "log-doc-err", class: "danger-text small", hidden: true });
  const doc = h("input", {
    type: "text",
    class: "log-input log-doc",
    placeholder: "e.g. D006",
    inputmode: "text",
    autocomplete: "off",
    "aria-describedby": "log-doc-err",
    onchange: (e) => {
      const v = e.target.value.trim().toUpperCase();
      if (v && !/^D\d+$/.test(v)) {
        docError.hidden = false;
        docError.textContent = "Type a document number like D006.";
        e.target.setAttribute("aria-invalid", "true");
        return;
      }
      docError.hidden = true;
      e.target.removeAttribute("aria-invalid");
      e.target.value = v;
      setFilter({ doc: v });
    },
  });
  const from = h("input", {
    type: "date",
    class: "log-input",
    onchange: (e) => setFilter({ from: e.target.value }),
  });
  const to = h("input", {
    type: "date",
    class: "log-input",
    onchange: (e) => setFilter({ to: e.target.value }),
  });
  const who = Segmented({
    label: "Who",
    options: WHO,
    value: "all",
    onChange: (id) => setFilter({ who: id }),
  });

  const filtered = () =>
    filters.who !== "all" || filters.what || filters.doc || filters.from || filters.to;

  function query(offset) {
    const q = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
    if (filters.who !== "all") q.set("actor", filters.who);
    for (const k of ["what", "doc", "from", "to"]) if (filters[k]) q.set(k, filters[k]);
    return `/api/log/entries?${q}`;
  }

  async function setFilter(change) {
    Object.assign(filters, change);
    const r = await api("GET", query(0));
    rows = r.rows;
    total = r.total;
    render();
    announce(count.textContent);
  }

  function clearFilters() {
    Object.assign(filters, { who: "all", what: "", doc: "", from: "", to: "" });
    what.value = "";
    doc.value = "";
    from.value = "";
    to.value = "";
    docError.hidden = true;
    who.setValue("all");
    setFilter({});
  }

  function rowEl(e) {
    const forged = e.record === "forged";
    const whoCell = e.who === "Unknown"
      ? FlagBadge("danger", "triangle", "Unknown")
      : e.actor === "claude"
      ? ActorLabel("claude")
      : e.actor === "user"
      ? ActorLabel("user")
      : h("span", {}, e.who);
    const notes = [];
    if (e.doc) notes.push(h("a", { class: "mono", href: `#/doc/${e.doc}` }, e.doc));
    if (e.note) notes.push(h("span", { class: "small" }, e.note));
    if (forged) {
      notes.push(
        FlagBadge("danger", "triangle", "Not written by casefile"),
        h(
          "span",
          { class: "small" },
          "casefile didn’t write this entry, or it was changed afterwards. Don’t rely on it.",
        ),
      );
    } else if (e.record === "pending") {
      notes.push(h("span", { class: "muted small" }, "Not sealed into the log yet"));
    }
    return h(
      "tr",
      { class: forged ? "log-forged" : null },
      h("th", { scope: "row", class: "mono muted log-time" }, timeOf(e.ts)),
      h("td", { class: "nowrap" }, whoCell),
      h("td", {}, e.label),
      h("td", {}, h("span", { class: "hstack log-detail" }, notes)),
    );
  }

  function table(label) {
    const tbody = h("tbody", {});
    const t = h(
      "div",
      { class: "log-day" },
      h("h3", { class: "log-day-title" }, label),
      h(
        "div",
        { class: "log-table-wrap" },
        h(
          "table",
          { class: "log-table" },
          h("caption", { class: "sr" }, `Log entries for ${label}`),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col", class: "log-col-time" }, "Time"),
              h("th", { scope: "col", class: "log-col-who" }, "Who"),
              h("th", { scope: "col" }, "What"),
              h("th", { scope: "col", class: "log-col-detail" }, "Detail"),
            ),
          ),
          tbody,
        ),
      ),
    );
    return { t, tbody };
  }

  function appendRows(list) {
    for (const e of list) {
      const k = dayKey(e.ts);
      if (k !== lastDay || !lastBody) {
        const { t, tbody } = table(dayHeading(e.ts));
        groups.append(t);
        lastDay = k;
        lastBody = tbody;
      }
      lastBody.append(rowEl(e));
    }
  }

  function renderMore() {
    clear(
      more,
      rows.length < total
        ? h("button", {
          type: "button",
          class: "btn",
          onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            const r = await api("GET", query(rows.length));
            rows = rows.concat(r.rows);
            total = r.total;
            appendRows(r.rows);
            renderCount();
            renderMore();
            announce(count.textContent);
          },
        }, `Show ${Math.min(PAGE, total - rows.length)} more`)
        : null,
    );
  }

  function renderCount() {
    count.textContent = filtered()
      ? `Showing ${rows.length} of ${plural(total, "matching entry", "matching entries")}.`
      : `Showing the ${
        plural(rows.length, "most recent entry", "most recent entries")
      } of ${total}.`;
  }

  function render() {
    clear(groups);
    lastDay = null;
    lastBody = null;
    if (!rows.length) {
      groups.append(
        EmptyState({
          message: "Nothing in the log matches these filters.",
          action: h(
            "button",
            { type: "button", class: "btn", onclick: clearFilters },
            "Clear filters",
          ),
        }),
      );
    } else appendRows(rows);
    renderCount();
    renderMore();
  }

  body.append(
    logCheck(summary.figures?.log, allTotal),
    h(
      "div",
      { class: "log-filters", role: "group", "aria-label": "Filter the log" },
      who,
      h("label", { class: "log-field" }, h("span", { class: "muted" }, "What"), what),
      h(
        "label",
        { class: "log-field" },
        h("span", { class: "muted" }, "Document"),
        doc,
      ),
      h("label", { class: "log-field" }, h("span", { class: "muted" }, "From"), from),
      h("label", { class: "log-field" }, h("span", { class: "muted" }, "To"), to),
      h("div", { class: "spacer" }),
      h("a", { class: "btn", href: "/api/log/export", download: "" }, "Download full log"),
    ),
    docError,
    count,
    groups,
    more,
  );
  render();

  const toggle = h("button", {
    type: "button",
    class: "btn",
    "aria-expanded": true,
    "aria-controls": "log-full",
    onclick: () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide full log" : "Show full log";
      body.hidden = !open;
    },
  }, "Hide full log");

  return h(
    "section",
    { class: "vstack gap-lg", "aria-labelledby": "log-full-h" },
    h("div", { class: "hstack" }, h("h2", { id: "log-full-h" }, "Full log"), toggle),
    body,
  );
}

/** "Log checked: no changes found since …", from the summary's own check of the sealed log. */
function logCheck(log, entries) {
  if (!log) return null;
  const since = log.since ? ` since ${formatDay(log.since)}` : "";
  const pending = log.pending
    ? h(
      "span",
      { class: "muted" },
      `${
        plural(log.pending, "recent entry by Claude is", "recent entries by Claude are")
      } not sealed into the log yet; casefile seals them the next time it writes to the log.`,
    )
    : null;
  if (!log.intact) {
    // A lost record of the last entry is not a changed entry: say what casefile can't rule out.
    const lostOnly = Boolean(log.headLost) &&
      !(log.recorded ?? []).some((k) => !k.startsWith("head_")) &&
      (log.problem ?? "").startsWith("the record of the log's last entry");
    return Callout({
      tone: "danger",
      title: lostOnly
        ? "Log checked: casefile can’t rule out removed entries"
        : "Log checked: casefile found a problem",
      children: [
        h(
          "p",
          {},
          `${log.problem ?? "An entry doesn’t match its seal."}${
            log.problem ? "." : ""
          } Entries marked “Not written by casefile” below can’t be relied on.`,
        ),
        pending,
      ],
    });
  }
  return h(
    "div",
    { class: "log-check" },
    h(
      "span",
      {},
      h("span", { "aria-hidden": "true" }, "✓ "),
      `Log checked: no changes found${since} (${plural(entries, "entry", "entries")}). `,
      h("span", { class: "muted" }, "casefile checked"),
    ),
    h(
      "span",
      { class: "muted" },
      "This shows the entries weren’t changed after casefile wrote them. It can’t show anything Claude did outside casefile, because that is never recorded.",
    ),
    pending,
  );
}
