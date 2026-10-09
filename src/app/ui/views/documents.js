// Documents list (W2-2; wb/Documents.dc.html): filters by status, where it came from, type and
// tag; the Exposed — re-check panel; import; the table (DataTable: sort, 50/100/200 paging,
// selection) with bulk actions; and what casefile knows about the case.
import { clear, h } from "../dom.js";
import { action, api, listPeople } from "../lib.js";
import { badgeFor, formatDay, plural, STATES } from "../model.js";
import {
  announce,
  Badge,
  Button,
  Callout,
  ConfirmBar,
  DataTable,
  Field,
  Icon,
  openDialog,
  showToast,
} from "../components/index.js";
import {
  citedItems,
  CitedRow,
  day,
  linesText,
  NOT_ASKED,
  OriginConfirm,
  originLabel,
  ORIGINS,
} from "./document.js";
import { ImportPanel } from "./import.js";

// ── type groups (doc_type is free text, mostly Claude's) ─────────────────────

const TYPE_GROUPS = [
  { id: "messages", label: "Messages", re: /message|text|sms|chat|whatsapp|signal/i },
  { id: "letters", label: "Letters & emails", re: /letter|e-?mail|correspondence/i },
  {
    id: "school",
    label: "School & medical",
    re: /school|medical|doctor|hospital|certificate|childcare|report card|swimming|club/i,
  },
  {
    id: "court",
    label: "Affidavits & court",
    re: /affidavit|court|order|subpoena|report|notice|application|orders|judgment/i,
  },
];

/** The type group of a document: a TYPE_GROUPS id, "other", or "none" (no type yet). */
export function typeGroup(docType) {
  if (!docType) return "none";
  return TYPE_GROUPS.find((g) => g.re.test(docType))?.id ?? "other";
}

/** Status order for sorting: most serious first. */
const STATUS_RANK = { exposed: 0, needs_review: 1, withheld: 2, shared: 3 };
const ORIGIN_KEYS = [...ORIGINS.map((o) => o.id), "none"];

// Filters, sort and the review queue survive re-renders within the session.
const filters = { status: "all", origin: "all", type: "all", tag: null, q: "" };
let tableSort = { key: "date", dir: "desc" };
const QUEUE_KEY = "casefile.docs.reviewQueue";

function readQueue() {
  try {
    return JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function writeQueue(ids) {
  try {
    if (ids.length) sessionStorage.setItem(QUEUE_KEY, JSON.stringify(ids));
    else sessionStorage.removeItem(QUEUE_KEY);
  } catch {
    // no storage: the queue is a convenience only
  }
}

function matches(d) {
  if (filters.status !== "all" && d.state !== filters.status) return false;
  if (filters.origin !== "all" && (d.origin ?? "none") !== filters.origin) return false;
  if (filters.type !== "all" && typeGroup(d.doc_type) !== filters.type) return false;
  if (filters.tag && !(d.tags ?? []).includes(filters.tag)) return false;
  const q = filters.q.trim().toLowerCase();
  if (q && !d.id.toLowerCase().includes(q) && !d.title.toLowerCase().includes(q)) return false;
  return true;
}

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {object} ctx */
export default async function view(main, _params, ctx) {
  const [docs0, exposures, toCheck, entities] = await Promise.all([
    api("GET", "/api/docs"),
    api("GET", "/api/exposures").catch(() => []),
    api("GET", "/api/to-check").catch(() => null),
    listPeople().catch(() => []),
  ]);
  let docs = docs0;
  let selected = new Set();
  const live = h("div", { class: "sr", role: "status" });
  const say = (msg) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = msg), 30);
  };

  const exposureOf = (id) =>
    exposures.find((e) => e.doc === id && !e.resharedAt && e.state === "exposed");

  // ── the table ──
  const statusNote = (d) => {
    const ex = exposureOf(d.id);
    if (ex) {
      return `Visible to Claude ${day(ex.sharedAt)} – ${day(ex.withdrawnAt)} · withdrawn`;
    }
    if (d.state === "needs_review" && d.newMatch) {
      return `New match: ${triggerWords(d.newMatch.values?.[0])}`;
    }
    if (d.needsRecheck) return "Shows a known name: re-check";
    if (d.detectorErrors?.length) return "The name finder had a problem: review it";
    if (d.state === "needs_review" && d.undecided) {
      return `${plural(d.undecided, "finding")} ${d.undecided === 1 ? "needs" : "need"} you`;
    }
    return null;
  };
  const columns = [
    {
      key: "id",
      label: "ID",
      sortable: true,
      rowHeader: true,
      className: "docs-id mono",
      sortValue: (d) => Number(d.id.slice(1)),
    },
    {
      key: "title",
      label: "Title",
      sortable: true,
      className: "docs-title",
      sortValue: (d) => d.title.toLowerCase(),
      render: (d) =>
        h(
          "div",
          { class: "vstack docs-title-cell" },
          h("a", { href: `#/doc/${d.id}` }, d.title),
          d.tags?.length ? h("span", { class: "docs-tags muted" }, d.tags.join(" · ")) : null,
        ),
    },
    {
      key: "date",
      label: "Date",
      sortable: true,
      className: "nowrap",
      sortValue: (d) => d.doc_date || null,
      render: (d) =>
        d.doc_date ? formatDay(d.doc_date, true) : h("span", { class: "muted" }, "Not set"),
    },
    {
      key: "type",
      label: "Type",
      render: (d) => d.doc_type ?? h("span", { class: "muted" }, "—"),
    },
    {
      key: "origin",
      label: "Where it came from",
      render: (d) =>
        d.origin
          ? (d.origin === "mine" ? "It’s mine" : originLabel(d.origin))
          : h("span", { class: "docs-notasked" }, NOT_ASKED), // neutral ink (spec §1, QA D3)
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (d) => STATUS_RANK[d.state] ?? 9,
      render: (d) => {
        const note = statusNote(d);
        return h(
          "div",
          { class: "vstack docs-status" },
          Badge("doc", d.state, { small: true }),
          note
            ? h(
              "span",
              { class: d.state === "exposed" ? "docs-note danger-text" : "docs-note" },
              note,
            )
            : null,
        );
      },
    },
    {
      key: "cited",
      label: "Cited",
      numeric: true,
      render: (d) => (d.cited ? String(d.cited) : "—"),
    },
  ];

  const tableHost = h("div", { class: "docs-table" });
  let table = null;
  const filtered = () => docs.filter(matches);
  const buildTable = () => {
    table = DataTable({
      caption: "Documents. Documents without a date are listed first.",
      columns,
      rows: filtered(),
      rowKey: (d) => d.id,
      rowLabel: (d) => `${d.id} ${d.title}`,
      sort: tableSort,
      selectable: true,
      onSelect: (keys) => {
        selected = keys;
        renderBulk();
        say(keys.size ? `${keys.size} selected` : "Nothing selected");
      },
      // Kept for the next rebuild (after a reload).
      onSort: (sort, col) => {
        tableSort = sort;
        say(`Sorted by ${col.label}, ${sort.dir === "asc" ? "ascending" : "descending"}`);
      },
      empty: "No documents match these filters.",
    });
    tableHost.replaceChildren(table);
  };
  const refilter = () => {
    table.setRows(filtered());
    renderFacets();
    renderSummary();
    renderBulk();
  };
  const reload = async () => {
    docs = await api("GET", "/api/docs");
    selected = new Set();
    buildTable();
    renderFacets();
    renderSummary();
    renderBulk();
    ctx.refreshCounts?.();
  };

  // ── head and summary ──
  const summary = h("span", { class: "muted docs-summary" });
  const renderSummary = () => {
    const n = (s) => docs.filter((d) => d.state === s).length;
    const shown = filtered().length;
    const parts = [plural(docs.length, "document")];
    if (n("needs_review")) parts.push(`${n("needs_review")} need review`);
    if (n("exposed")) parts.push(`${n("exposed")} exposed`);
    summary.textContent = parts.join(" · ") +
      (shown !== docs.length ? ` · showing ${shown}` : "");
  };

  // ── facets (left) ──
  const facets = h("div", { class: "vstack gap-lg" });
  const facetButton = (label, count, pressed, onclick, glyph) =>
    h(
      "button",
      { type: "button", class: "docs-facet", "aria-pressed": pressed, onclick },
      h("span", { class: "docs-facet-label" }, glyph ? Icon(glyph) : null, label),
      count != null ? h("span", { class: "num muted" }, String(count)) : null,
    );
  const setFilter = (k, v) => {
    filters[k] = v;
    refilter();
    say(`${filtered().length} documents shown`);
  };
  const renderFacets = () => {
    const count = (fn) => docs.filter(fn).length;
    const group = (title, items) => {
      const id = `facet-${title.replace(/\W+/g, "-").toLowerCase()}`;
      return h(
        "section",
        { class: "docs-facets", "aria-labelledby": id },
        h("h2", { id, class: "eyebrow" }, title),
        h("div", { class: "vstack docs-facet-list", role: "group", "aria-labelledby": id }, items),
      );
    };
    const status = group("Status", [
      facetButton(
        "All documents",
        docs.length,
        filters.status === "all",
        () => setFilter("status", "all"),
      ),
      ...Object.keys(STATES.doc).map((s) =>
        facetButton(
          badgeFor("doc", s).label,
          count((d) => d.state === s),
          filters.status === s,
          () => setFilter("status", filters.status === s ? "all" : s),
          badgeFor("doc", s).glyph,
        )
      ),
    ]);
    const origin = group(
      "Where it came from",
      ORIGIN_KEYS.map((o) =>
        facetButton(
          o === "none" ? NOT_ASKED : originLabel(o),
          count((d) => (d.origin ?? "none") === o),
          filters.origin === o,
          () => setFilter("origin", filters.origin === o ? "all" : o),
        )
      ),
    );
    const typeItems = [...TYPE_GROUPS, { id: "other", label: "Other" }, {
      id: "none",
      label: "No type yet",
    }]
      .map((g) => ({ ...g, n: count((d) => typeGroup(d.doc_type) === g.id) }))
      .filter((g) => g.n > 0)
      .map((g) =>
        facetButton(
          g.label,
          g.n,
          filters.type === g.id,
          () => setFilter("type", filters.type === g.id ? "all" : g.id),
        )
      );
    const tagCounts = new Map();
    for (const d of docs) {
      for (const t of d.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    clear(
      facets,
      status,
      origin,
      group("Type", typeItems),
      tags.length
        ? group(
          "Tags",
          h(
            "div",
            { class: "chips" },
            tags.map(([t, n]) =>
              h(
                "button",
                {
                  type: "button",
                  class: "chip",
                  "aria-pressed": filters.tag === t,
                  onclick: () => setFilter("tag", filters.tag === t ? null : t),
                },
                t,
                h("span", { class: "chip-count num" }, String(n)),
              )
            ),
          ),
        )
        : null,
    );
  };

  // ── bulk actions ──
  const bulk = h("div", {
    class: "docs-bulk",
    role: "toolbar",
    "aria-label": "Actions for selected documents",
    hidden: true,
  });
  const bulkSlot = h("div", { class: "docs-bulk-confirm" });
  const selectedDocs = () => docs.filter((d) => selected.has(d.id));
  const renderBulk = () => {
    const sel = selectedDocs();
    bulk.hidden = sel.length === 0;
    if (!sel.length) {
      bulkSlot.replaceChildren();
      return;
    }
    const reviewable = sel.filter((d) => d.state === "needs_review" || d.state === "exposed");
    const taggable = sel.filter((d) => d.status === "published");
    clear(
      bulk,
      h("span", { class: "strong" }, `${sel.length} selected`),
      Button(
        reviewable.length && reviewable.length !== sel.length
          ? `Review ${reviewable.length} that need it`
          : "Review selected",
        {
          disabled: reviewable.length === 0,
          title: reviewable.length ? null : "None of these needs review.",
          onclick: () => reviewQueue(reviewable.map((d) => d.id)),
        },
      ),
      Button("Tag…", {
        disabled: taggable.length === 0,
        onclick: action(() => bulkTag(taggable, sel.length - taggable.length)),
      }),
      Button("Mark where they came from…", { onclick: action(() => bulkOrigin(sel)) }),
      h("span", { class: "spacer" }),
      Button("Clear selection", {
        variant: "quiet",
        onclick: () => {
          table.clearSelection();
          say("Selection cleared");
        },
      }),
    );
  };

  const reviewQueue = (ids) => {
    if (!ids.length) return;
    writeQueue(ids.slice(1));
    announce(
      ids.length > 1
        ? `Opening ${ids[0]} for review. The other ${ids.length - 1} wait here for you.`
        : `Opening ${ids[0]} for review.`,
    );
    ctx.navigate(`#/review/${ids[0]}`);
  };

  const bulkTag = async (taggable, skipped) => {
    const input = h("input", { type: "text", autocomplete: "off" });
    const ok = await openDialog({
      title: `Tag ${plural(taggable.length, "document")}`,
      body: [
        Field({
          label: "Tag",
          control: input,
          hint: "Claude sees tags. Names you type are replaced first.",
        }),
        skipped
          ? h(
            "p",
            { class: "muted" },
            `${plural(skipped, "selected document")} can’t be tagged until reviewed.`,
          )
          : null,
      ],
      actions: [{ label: "Cancel", value: null }, {
        label: "Add tag",
        value: true,
        variant: "primary",
      }],
    });
    const tag = input.value.trim();
    if (ok !== true || !tag) return;
    for (const d of taggable) await api("POST", `/api/docs/${d.id}/tags`, { tag });
    const msg = `Tagged ${plural(taggable.length, "document")} “${tag}”.`;
    showToast(msg, {
      undo: async () => {
        for (const d of taggable) {
          await api("DELETE", `/api/docs/${d.id}/tags/${encodeURIComponent(tag)}`);
        }
        announce("Tag removed again.");
        await reload();
      },
    });
    announce(msg);
    await reload();
  };

  const bulkOrigin = async (sel) => {
    const name = "bulk-origin";
    const fs = h(
      "fieldset",
      { class: "vstack gap-sm" },
      h(
        "legend",
        {},
        `Where did ${sel.length === 1 ? "this document" : "these documents"} come from?`,
      ),
      ORIGINS.map((o, i) =>
        h(
          "label",
          { class: "doc-origin" },
          h("input", { type: "radio", name, value: o.id, checked: i === 0 }),
          h(
            "span",
            { class: "vstack doc-origin-text" },
            h("span", {}, o.label),
            o.hint ? h("span", { class: "muted small" }, o.hint) : null,
          ),
        )
      ),
    );
    const ok = await openDialog({
      title: `Mark where ${plural(sel.length, "document")} came from`,
      body: [
        fs,
        h(
          "p",
          {},
          "Anything other than “It’s mine” withdraws them from Claude. You’ll see what that affects before anything changes.",
        ),
      ],
      actions: [{ label: "Cancel", value: null }, {
        label: "Continue",
        value: true,
        variant: "primary",
      }],
    });
    if (ok !== true) return;
    const next = fs.querySelector("input:checked").value;
    const changing = sel.filter((d) => d.origin !== next);
    if (!changing.length) {
      announce("Nothing to change.");
      return;
    }
    const impacts = await Promise.all(
      changing.map((d) => api("GET", `/api/docs/${d.id}/origin-impact?origin=${next}`)),
    );
    const apply = async () => {
      const prev = changing.map((d) => [d.id, d.origin]);
      let withdrawn = 0;
      for (const d of changing) {
        const r = await api("PUT", `/api/docs/${d.id}/origin`, { origin: next });
        if (r.withdrawn) withdrawn++;
      }
      bulkSlot.replaceChildren();
      const msg = `Marked ${plural(changing.length, "document")} “${originLabel(next)}”.${
        withdrawn ? ` ${plural(withdrawn, "document")} withdrawn from Claude.` : ""
      }`;
      announce(msg);
      showToast(msg, {
        undo: async () => {
          for (const [id, o] of prev) await api("PUT", `/api/docs/${id}/origin`, { origin: o });
          announce("Changed back.");
          await reload();
        },
      });
      await reload();
    };
    const withdrawing = changing.filter((_, i) => impacts[i].withdraw);
    if (!withdrawing.length) {
      await apply();
      return;
    }
    // One ConfirmBar for the lot: what is withdrawn, what cites it, what Claude read.
    const sum = (k) => impacts.reduce((n, im) => n + (im.citedBy?.[k]?.length ?? 0), 0);
    const reads = impacts.flatMap((im, i) =>
      (im.claudeReads ?? []).map((r) => ({ ...r, doc: changing[i].id }))
    );
    const many = withdrawing.length > 1;
    const fake = { id: many ? plural(withdrawing.length, "document") : withdrawing[0].id, many };
    const bar = OriginConfirm(fake, next, {
      citedBy: {
        chronology: Array(sum("chronology")),
        evidence: Array(sum("evidence")),
        paragraphs: Array(sum("paragraphs")),
        notes: Array(sum("notes")),
      },
      claudeReads: [],
    }, {
      title: `Mark ${plural(changing.length, "document")} “${originLabel(next)}”?`,
      onConfirm: action(apply),
      onCancel: () => {
        bulkSlot.replaceChildren();
        announce("Not changed.");
      },
    });
    if (reads.length) {
      bar.querySelector(".confirmbar-detail")?.lastElementChild?.previousElementSibling
        ?.replaceWith(
          h(
            "p",
            {},
            `The log shows Claude read ${
              reads.slice(0, 4).map((r) => `${r.doc} ${linesText(r.lines)} on ${day(r.ts, false)}`)
                .join(", ")
            }${
              reads.length > 4 ? ` and ${reads.length - 4} more` : ""
            }. Withdrawing stops further reading; it can’t undo what was already read.`,
          ),
        );
    }
    bulkSlot.replaceChildren(bar);
    bar.focusPrimary();
  };

  // ── continue a review queue started from a selection ──
  const queue = readQueue().filter((id) =>
    docs.some((d) => d.id === id && (d.state === "needs_review" || d.state === "exposed"))
  );
  writeQueue(queue);
  const queueCallout = queue.length
    ? Callout({
      tone: "info",
      title: `Next to review: ${queue[0]}`,
      children: h(
        "div",
        { class: "hstack" },
        h(
          "span",
          {},
          queue.length > 1
            ? `${queue.length} documents from your selection are left.`
            : "The last one from your selection.",
        ),
        Button(`Review ${queue[0]}`, { variant: "primary", onclick: () => reviewQueue(queue) }),
        Button("Forget the rest", {
          variant: "quiet",
          onclick: (e) => {
            writeQueue([]);
            e.currentTarget.closest(".callout")?.remove();
            say("Review list cleared");
          },
        }),
      ),
    })
    : null;

  // ── exposed panels ──
  const exposed = exposures.filter((e) => !e.resharedAt && e.state === "exposed");
  const exposedPanels = await Promise.all(
    exposed.map(async (e) => {
      const doc = await api("GET", `/api/docs/${e.doc}`).catch(() => null);
      const cited = doc ? citedItems(e.doc, doc.citedIn) : [];
      return ExposedPanel(e, cited, entities, ctx, reload);
    }),
  );

  // ── filter field ──
  const q = h("input", {
    type: "search",
    value: filters.q,
    placeholder: "Filter by ID or title",
    "aria-label": "Filter documents by ID or title",
    class: "docs-q",
    oninput: (e) => {
      filters.q = e.target.value;
      refilter();
    },
  });
  const resetBtn = Button("Show all", {
    variant: "quiet",
    onclick: () => {
      Object.assign(filters, { status: "all", origin: "all", type: "all", tag: null, q: "" });
      q.value = "";
      refilter();
      say(`${docs.length} documents shown`);
    },
  });

  buildTable();
  renderFacets();
  renderSummary();
  renderBulk();

  main.replaceChildren(
    h(
      "div",
      { class: "columns docs" },
      h(
        "aside",
        { class: "col-side col-side--left docs-filters", "aria-label": "Filters" },
        facets,
      ),
      h(
        "div",
        { class: "col-main docs-main vstack gap-lg" },
        h("div", { class: "docs-head" }, h("h1", {}, "Documents"), summary),
        queueCallout,
        exposedPanels,
        ImportPanel({ onImported: reload }),
        h("div", { class: "hstack docs-filterbar" }, q, resetBtn),
        bulk,
        bulkSlot,
        tableHost,
        live,
      ),
      CasePanel(docs, toCheck, ctx.settings),
    ),
  );
}

// ── Exposed — re-check ───────────────────────────────────────────────────────

const TRIGGER_KIND = {
  alias: "a nickname you added",
  full: "a name you added",
  first: "a first name you added",
  surname: "a surname you added",
  title: "a name you added",
  part: "part of a name or address you added",
};

const TRIGGER_NOUN = {
  alias: "The nickname",
  full: "The name",
  first: "The first name",
  surname: "The surname",
  title: "The name",
  part: "The value",
};

/** "a nickname you added: Annie", from an exposure or new-match trigger (app only). */
export function triggerWords(t) {
  if (!t) return "a name you added";
  return `${TRIGGER_KIND[t.kind] ?? "a name you added"}: ${t.value}`;
}

function ExposedPanel(e, cited, entities, ctx, reload) {
  const hid = `exposed-h-${e.doc}`;
  const names = e.roles.map((r) => {
    const ent = entities.find((x) => x.role === r);
    return { role: r, name: ent?.forms?.full ?? `{{${r}}}` };
  });
  const nameLinks = names.flatMap((n, i) => [
    i ? (i === names.length - 1 ? " and " : ", ") : "",
    h("a", { href: `#/people/${n.role}` }, n.name),
  ]);
  const reads = e.claudeReads ?? [];
  const readWords = reads.map((r) => `${linesText(r.lines)} on ${day(r.ts, false)}`).join(", ");
  const docs = [e.doc, ...(e.newMatchesIn ?? []).filter((d) => d !== e.doc)];
  const results = h("div", { class: "vstack gap-sm" });

  // Only the exposed document can be shared with Claude again by this; the others haven't been
  // shared yet and go to review.
  const toReview = docs.filter((d) => d !== e.doc);
  const listWords = (ids) =>
    ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : ids[0];
  const what = e.trigger ? `“${e.trigger.value}”` : "the name you added";

  let recheckBtn = null;
  const runRecheck = async () => {
    const r = await api("POST", "/api/docs/recheck", { docs });
    const review = r.results.filter((x) => x.state === "needs_review").map((x) => x.id);
    const shared = r.results.filter((x) => x.state === "shared").map((x) => x.id);
    const msg = [
      shared.length ? `${listWords(shared)} shared with Claude again.` : "",
      review.length
        ? `${listWords(review)} ${
          review.length === 1 ? "needs" : "need"
        } your decision on the new matches.`
        : "",
    ].filter(Boolean).join(" ") || "Re-checked.";
    const undo = shared.length
      ? async () => {
        for (const id of shared) await api("POST", `/api/docs/${id}/withdraw`);
        announce(`${listWords(shared)} withdrawn from Claude again.`);
        await reload();
      }
      : undefined;
    const said = h("p", { tabindex: "-1", class: "docs-recheck-result" }, msg);
    if (review.length) {
      writeQueue(review.slice(1));
      const go = h(
        "a",
        { class: "btn btn-primary btn-lg", href: `#/review/${review[0]}` },
        `Review ${review[0]}`,
      );
      results.replaceChildren(
        h(
          "div",
          { class: "vstack gap-sm" },
          said,
          h("p", {}, "Only the new matches need a decision."),
        ),
        h("div", { class: "hstack" }, go),
      );
      showToast(msg, { undo, returnFocus: go });
      go.focus();
    } else {
      results.replaceChildren(said);
      showToast(msg, { undo, returnFocus: said });
      said.focus();
    }
    await reload();
    ctx.refreshCounts?.();
  };

  // A ConfirmBar first (spec §5): re-checking can share a document with Claude again.
  const recheck = () => {
    const bar = ConfirmBar({
      title: docs.length > 1 ? `Re-check ${listWords(docs)}?` : `Re-check ${e.doc}?`,
      summary: [
        `${e.doc} is checked again against who’s who as it is now, so ${what} is replaced. `,
        h("strong", {}, `If nothing else is new, ${e.doc} is shared with Claude again`),
        " (unless where it came from keeps it back). If anything else turns up, it goes to review instead and isn’t shared.",
      ],
      detail: toReview.length
        ? h(
          "p",
          {},
          `${listWords(toReview)} ${
            toReview.length === 1 ? "hasn’t" : "haven’t"
          } been shared yet. ${
            toReview.length === 1 ? "It goes" : "They go"
          } to review so you can decide the new matches; nothing is shared with Claude from ${
            toReview.length === 1 ? "it" : "them"
          } until you do.`,
        )
        : null,
      confirmLabel: `Re-check and share ${e.doc} again`,
      onConfirm: action(runRecheck),
      onCancel: () => {
        results.replaceChildren();
        announce("Not re-checked.");
        recheckBtn?.focus();
      },
    });
    results.replaceChildren(bar);
    bar.focusPrimary();
  };

  return h(
    "section",
    { class: "docs-exposed", "aria-labelledby": hid },
    h(
      "div",
      { class: "hstack" },
      Badge("doc", "exposed"),
      h("h2", { id: hid }, `${e.doc} is withdrawn from Claude until you re-check it`),
    ),
    h(
      "p",
      {},
      e.trigger
        ? [
          `${
            TRIGGER_NOUN[e.trigger.kind] ?? "The name"
          } “${e.trigger.value}”, which you added for `,
          nameLinks,
          ` after sharing ${e.doc}, is written out in it. casefile has withdrawn ${e.doc} from Claude. `,
        ]
        : [
          "A name or nickname for ",
          nameLinks,
          ` that you added after sharing ${e.doc} is written out in it. casefile has withdrawn ${e.doc} from Claude. `,
        ],
      reads.length
        ? `The log shows Claude read ${readWords} of ${e.doc}, while it was shared.`
        : `The log shows no reads of ${e.doc} by Claude through casefile while it was shared.`,
    ),
    h(
      "p",
      {},
      reads.length ? "So Claude may have seen it in those lines. " : "",
      `Everything else you reviewed in ${e.doc} was replaced as before. Claude can’t read ${e.doc} again until you re-check it and share it.`,
      e.newMatchesIn?.length
        ? ` The same name also turned up in ${
          plural(e.newMatchesIn.length, "document")
        } you haven’t shared yet (${e.newMatchesIn.join(", ")}); they’ll show it as a new match.`
        : "",
    ),
    h(
      "p",
      { class: "docs-exposed-dates" },
      [
        // CANON: "Shared 28 Sep 2025 · Claude read lines 1–12 on 2 Oct 2025 · “Annie” added
        // 5 Oct 2025 · withdrawn 5 Oct 2025". casefile withdraws it as the name is added.
        `Shared ${day(e.sharedAt)}`,
        ...reads.map((r) => `Claude read ${linesText(r.lines)} on ${day(r.ts)}`),
        ...(e.trigger ? [`“${e.trigger.value}” added ${day(e.withdrawnAt)}`] : []),
        `withdrawn ${day(e.withdrawnAt)}`,
      ].join(" · "),
    ),
    h(
      "div",
      { class: "hstack" },
      recheckBtn = Button(
        docs.length > 1
          ? `Re-check ${docs.length} documents with new matches`
          : `Re-check ${e.doc}`,
        { variant: "primary", onclick: recheck },
      ),
      h("a", { href: "#/log" }, "See the log entry"),
      h("a", { href: `#/doc/${e.doc}` }, `Open ${e.doc}`),
    ),
    results,
    cited.length
      ? h(
        "div",
        { class: "vstack gap-sm docs-exposed-back" },
        h("h3", {}, `When you share ${e.doc} again, these go back to “To check”`),
        h(
          "p",
          { class: "muted" },
          "The lines they cite will change, so you’ll need to check them against the document again. Claude’s earlier work stays in your case.",
        ),
        h("ul", { class: "doc-cited-list" }, cited.map((c) => h("li", {}, CitedRow(c)))),
      )
      : null,
  );
}

// ── what casefile knows about this case ──────────────────────────────────────

function CasePanel(docs, toCheck, settings) {
  const commercial = settings?.claudeSetup === "commercial";
  const planAt = settings?.plan?.at ?? null;
  const withheld = docs.filter((d) => d.state === "withheld").length;
  const work = (toCheck?.groups ?? []).filter((g) => !/document/i.test(g.what));
  const workWords = work.map((g) => `${g.count} ${g.what.toLowerCase()}`);
  const workText = workWords.length > 1
    ? `${workWords.slice(0, -1).join(", ")} and ${workWords.at(-1)}`
    : workWords[0];
  const row = (label, on) =>
    h(
      "div",
      { class: "docs-case-row" },
      h("span", {}, label),
      h(
        "span",
        { class: "strong" },
        on === true ? [Icon("check"), " On"] : on === false ? "Off" : on,
      ),
    );
  const section = (title, ...children) =>
    h(
      "section",
      { class: "vstack gap-sm" },
      h("h3", { class: "docs-case-title" }, title),
      children,
    );
  return h(
    "aside",
    { class: "col-side docs-case", "aria-labelledby": "case-h" },
    h("h2", { id: "case-h", class: "section-title" }, "What casefile knows about this case"),
    section(
      "Your Claude plan",
      h(
        "p",
        { class: "strong" },
        // The mockup's "Claude Pro (consumer)"; casefile records consumer or commercial, not
        // which consumer plan (QA D4).
        commercial ? "Claude Team, Enterprise or API (commercial)" : "Claude Pro or Max (consumer)",
      ),
      h(
        "p",
        { class: "muted" },
        planAt
          ? `As you recorded it in Settings on ${day(planAt, false)}. `
          : "You haven’t recorded your plan in Settings yet, so casefile treats it as a consumer plan. ",
        commercial
          ? "Documents from the other side or from a subpoena or the court are shared only when you share each one. Documents under an order or undertaking, and those marked “Not sure”, are always withheld (PD-AI 5.5)."
          : "Under the Court’s rules on AI (PD-AI 5.5), documents from the other side, from a subpoena or the court, or under an order or undertaking are withheld from Claude on this plan. So are documents marked “Not sure”.",
      ),
      h(
        "p",
        {},
        h("span", { class: "num" }, String(withheld)),
        ` ${withheld === 1 ? "document is" : "documents are"} withheld for this reason.`,
      ),
      h("a", { href: "#/settings" }, "Change in Settings"),
    ),
    section(
      "Finding names",
      h(
        "div",
        { class: "vstack gap-sm" },
        row("Australian number and ID rules", true),
        row("Name finder on this computer", Boolean(settings?.nameDetection)),
        row("Optional language model", settings?.llm ? "Set up" : "Not used"),
      ),
      h(
        "p",
        { class: "muted" },
        "Nicknames and other spellings still need adding by hand in People.",
      ),
    ),
    section(
      "Claude’s work to check",
      h(
        "p",
        {},
        workText
          ? `${workText} ${
            work.reduce((n, g) => n + g.count, 0) === 1 ? "is" : "are"
          } waiting for you.`
          : "Nothing of Claude’s is waiting for you.",
      ),
      h("a", { href: "#/to-check" }, "Open To check"),
    ),
    section(
      "What casefile can’t see",
      h(
        "p",
        { class: "muted" },
        "casefile records what Claude does through casefile. If Claude opens files or searches another way, casefile has no record of it.",
      ),
    ),
  );
}
