// DataTable: a real <table> with a caption, column headers, optional sortable columns
// (aria-sort), optional row selection and client-side paging (50/100/200).
import { h } from "../dom.js";
import { Icon } from "./icons.js";

/**
 * @template Row
 * @param {{
 *   caption: string,
 *   columns: {key: string, label: string, sortable?: boolean, numeric?: boolean,
 *     rowHeader?: boolean, className?: string,
 *     render?: (row: Row) => string|Node|null, sortValue?: (row: Row) => unknown}[],
 *   rows: Row[],
 *   rowKey?: (row: Row) => string,
 *   rowLabel?: (row: Row) => string,
 *   sort?: {key: string, dir: "asc"|"desc"},
 *   pageSize?: number,
 *   pageSizes?: number[],
 *   selectable?: boolean,
 *   onSelect?: (keys: Set<string>) => void,
 *   onSort?: (sort: {key: string, dir: "asc"|"desc"}, column: {key: string, label: string}) => void,
 *   rowClass?: (row: Row) => string|null,
 *   empty?: string,
 * }} opts
 */
export function DataTable(opts) {
  const pageSizes = opts.pageSizes ?? [50, 100, 200];
  let rows = opts.rows;
  let sort = opts.sort ?? null;
  let pageSize = opts.pageSize ?? pageSizes[0];
  let page = 0;
  const selected = new Set();
  const key = opts.rowKey ?? ((r) => String(r.id));

  const table = h("table", { class: "dtable" });
  const pager = h("nav", { class: "pager", "aria-label": "Pages" });
  const wrap = h("div", { class: "dtable-wrap" }, table);
  const root = h("div", { class: "vstack dtable-root" }, wrap, pager);

  const valueOf = (col, r) => (col.sortValue ? col.sortValue(r) : r[col.key]);
  const sorted = () => {
    if (!sort) return rows;
    const col = opts.columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = valueOf(col, a);
      const y = valueOf(col, b);
      // Empty values (e.g. undated documents) sort first, whichever the direction.
      if (x == null || x === "") return y == null || y === "" ? 0 : -1;
      if (y == null || y === "") return 1;
      return (typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), "en-AU", { numeric: true })) * dir;
    });
  };

  /** Re-render, keeping keyboard focus on the same control (by its data-fk) when it is redrawn. */
  const render = () => {
    const had = root.contains(document.activeElement)
      ? /** @type {HTMLElement} */ (document.activeElement).dataset?.fk
      : undefined;
    draw();
    if (had) {
      const again =
        /** @type {HTMLElement|null} */ (root.querySelector(`[data-fk="${CSS.escape(had)}"]`));
      if (again && !(/** @type {HTMLButtonElement} */ (again).disabled)) again.focus();
      /** @type {HTMLElement|null} */ else {(root.querySelector("[data-fk]:not([disabled])"))
          ?.focus();}
    }
  };

  /** Tick or untick rows in place (no redraw, so focus stays on the checkbox: QA D2). */
  const syncSelection = (shown) => {
    for (const box of table.querySelectorAll("tbody input[data-row]")) {
      const on = selected.has(/** @type {HTMLElement} */ (box).dataset.row ?? "");
      /** @type {HTMLInputElement} */ (box).checked = on;
      box.closest("tr")?.classList.toggle("is-selected", on);
    }
    const all =
      /** @type {HTMLInputElement|null} */ (table.querySelector("thead input[type=checkbox]"));
    if (all) all.checked = shown.length > 0 && shown.every((r) => selected.has(key(r)));
  };

  const draw = () => {
    const all = sorted();
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    page = Math.min(page, pages - 1);
    const shown = all.slice(page * pageSize, (page + 1) * pageSize);
    const sortCol = sort && opts.columns.find((c) => c.key === sort.key);

    const head = h(
      "tr",
      {},
      opts.selectable
        ? h(
          "th",
          { scope: "col", class: "dtable-select" },
          h(
            "label",
            { class: "dtable-check" },
            h("input", {
              type: "checkbox",
              "aria-label": "Select all rows on this page",
              "data-fk": "sel:*",
              checked: shown.length > 0 && shown.every((r) => selected.has(key(r))),
              onchange: (e) => {
                for (const r of shown) {
                  e.target.checked ? selected.add(key(r)) : selected.delete(key(r));
                }
                syncSelection(shown);
                opts.onSelect?.(new Set(selected));
              },
            }),
          ),
        )
        : null,
      opts.columns.map((c) => {
        const active = sort?.key === c.key;
        const ariaSort = active
          ? (sort.dir === "asc" ? "ascending" : "descending")
          : c.sortable
          ? "none"
          : null;
        return h(
          "th",
          { scope: "col", "aria-sort": ariaSort, class: [c.numeric && "is-num", c.className] },
          c.sortable
            ? h(
              "button",
              {
                type: "button",
                class: "dtable-sort",
                "data-fk": `sort:${c.key}`,
                onclick: () => {
                  sort = { key: c.key, dir: active && sort.dir === "asc" ? "desc" : "asc" };
                  render();
                  opts.onSort?.({ ...sort }, c);
                },
              },
              c.label,
              Icon(active ? (sort.dir === "asc" ? "up" : "down") : "sort"),
            )
            : c.label,
        );
      }),
    );

    const body = shown.length
      ? shown.map((r) =>
        h(
          "tr",
          { class: [selected.has(key(r)) && "is-selected", opts.rowClass?.(r)] },
          opts.selectable
            ? h(
              "td",
              { class: "dtable-select" },
              h(
                "label",
                { class: "dtable-check" },
                h("input", {
                  type: "checkbox",
                  "aria-label": `Select ${opts.rowLabel ? opts.rowLabel(r) : key(r)}`,
                  "data-row": key(r),
                  "data-fk": `sel:${key(r)}`,
                  checked: selected.has(key(r)),
                  onchange: (e) => {
                    e.target.checked ? selected.add(key(r)) : selected.delete(key(r));
                    syncSelection(shown);
                    opts.onSelect?.(new Set(selected));
                  },
                }),
              ),
            )
            : null,
          opts.columns.map((c) =>
            h(
              c.rowHeader ? "th" : "td",
              { scope: c.rowHeader ? "row" : null, class: [c.numeric && "is-num", c.className] },
              c.render ? c.render(r) : String(r[c.key] ?? ""),
            )
          ),
        )
      )
      : h(
        "tr",
        {},
        h(
          "td",
          { colspan: opts.columns.length + (opts.selectable ? 1 : 0), class: "dtable-empty" },
          opts.empty ?? "Nothing to show.",
        ),
      );

    table.replaceChildren(
      h(
        "caption",
        { class: "sr" },
        opts.caption,
        sortCol
          ? `, sorted by ${sortCol.label} ${sort.dir === "asc" ? "ascending" : "descending"}`
          : "",
      ),
      h("thead", {}, head),
      h("tbody", {}, body),
    );

    const from = all.length ? page * pageSize + 1 : 0;
    const to = Math.min(all.length, (page + 1) * pageSize);
    const next = Math.min(pageSize, all.length - to);
    pager.replaceChildren(
      h("span", { class: "num" }, `${from}–${to} of ${all.length}`),
      h("span", { class: "spacer" }),
      h(
        "label",
        { class: "hstack muted" },
        "Rows per page",
        h(
          "select",
          {
            "data-fk": "size",
            onchange: (e) => {
              pageSize = Number(e.target.value);
              page = 0;
              render();
            },
          },
          pageSizes.map((n) =>
            h("option", { value: String(n), selected: n === pageSize }, String(n))
          ),
        ),
      ),
      h("button", {
        type: "button",
        class: "btn",
        "data-fk": "prev",
        disabled: page === 0,
        onclick: () => {
          page--;
          render();
        },
      }, "Previous"),
      h("button", {
        type: "button",
        class: "btn",
        "data-fk": "next",
        disabled: page >= pages - 1,
        onclick: () => {
          page++;
          render();
        },
      }, next > 0 ? `Next ${next}` : "Next"),
    );
    pager.hidden = all.length <= pageSizes[0];
  };

  draw();
  return Object.assign(root, {
    /** Replace the rows (keeps sort; returns to page 1). */
    setRows(next) {
      rows = next;
      page = 0;
      render();
    },
    selectedKeys: () => new Set(selected),
    /** The current sort (to keep it across a rebuild). */
    sortState: () => (sort ? { ...sort } : null),
    /** Untick every row (e.g. after a bulk action); calls onSelect with the empty set. */
    clearSelection() {
      if (!selected.size) return;
      selected.clear();
      opts.onSelect?.(new Set());
      render();
    },
  });
}
