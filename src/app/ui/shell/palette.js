// ⌘K "Search everything": document lines, people, chronology and issues, grouped with totals
// (GET /api/search/all).
import { h } from "../dom.js";
import { api } from "../lib.js";
import { searchGroups, segmentsFromText } from "../model.js";
import { Segments } from "../components/entity.js";
import { Icon } from "../components/icons.js";
import { restoreFocus } from "../components/dialog.js";

/** Fetch grouped results for `q`. */
async function searchAll(q) {
  return searchGroups(await api("GET", `/api/search/all?q=${encodeURIComponent(q)}`));
}

/**
 * Open the palette.
 * @param {{initial?: string, search?: (q: string) => Promise<ReturnType<typeof searchGroups>>,
 *   navigate?: (href: string) => void}} [opts]
 */
export function openPalette(opts = {}) {
  if (document.querySelector("dialog.palette")) return;
  const opener = document.activeElement;
  let navigated = false;
  const search = opts.search ?? searchAll;
  const navigate = opts.navigate ?? ((href) => (location.hash = href));
  const listId = "palette-results";
  const input = h("input", {
    type: "search",
    class: "palette-input",
    placeholder: "Search documents, people, chronology and issues",
    autocomplete: "off",
    role: "combobox",
    "aria-expanded": false,
    "aria-controls": listId,
    "aria-autocomplete": "list",
    "aria-label": "Search everything",
    value: opts.initial ?? "",
  });
  const status = h("p", { class: "palette-status muted", role: "status" });
  const results = h("div", {
    id: listId,
    class: "palette-results",
    role: "listbox",
    "aria-label": "Results",
  });
  /** @type {{el: HTMLElement, href: string}[]} */
  let options = [];
  let active = -1;
  let seq = 0;
  let timer;

  const setActive = (i) => {
    if (!options.length) return;
    active = (i + options.length) % options.length;
    options.forEach((o, j) => o.el.setAttribute("aria-selected", String(j === active)));
    input.setAttribute("aria-activedescendant", options[active].el.id);
    options[active].el.scrollIntoView({ block: "nearest" });
  };
  const go = (href) => {
    navigated = true; // the new screen moves focus to its h1
    dlg.close();
    navigate(href);
  };

  const render = (groups, q) => {
    options = [];
    active = -1;
    input.removeAttribute("aria-activedescendant");
    const total = groups.reduce((n, g) => n + g.total, 0);
    status.textContent = !q.trim()
      ? "Type a name, a word or a date. Real names work."
      : total === 0
      ? `No matches for “${q}”.`
      : `${total} ${total === 1 ? "match" : "matches"}`;
    input.setAttribute("aria-expanded", String(total > 0));
    results.replaceChildren(
      ...groups.map((g, gi) => {
        const hid = `pg-${gi}`;
        return h(
          "div",
          { role: "group", "aria-labelledby": hid, class: "palette-group" },
          h(
            "div",
            { id: hid, class: "palette-group-head eyebrow", role: "presentation" },
            g.label,
            h(
              "span",
              { class: "num" },
              g.items.length < g.total ? ` ${g.items.length} of ${g.total}` : ` ${g.total}`,
            ),
          ),
          g.items.map((it) => {
            const el = h(
              "div",
              {
                id: `po-${options.length}`,
                role: "option",
                class: "palette-option",
                "aria-selected": false,
                onclick: () => go(it.href),
                onmousemove: () => setActive(options.findIndex((o) => o.el === el)),
              },
              h("span", { class: "palette-title mono" }, it.title),
              h(
                "span",
                { class: "palette-text" },
                it.segs
                  ? Segments(it.segs, { interactive: false })
                  : Segments(segmentsFromText(it.text ?? ""), { interactive: false }),
              ),
            );
            options.push({ el, href: it.href });
            return el;
          }),
        );
      }),
    );
  };

  const run = () => {
    const q = input.value;
    const mine = ++seq;
    clearTimeout(timer);
    if (!q.trim()) return render([], q);
    status.textContent = "Searching…";
    timer = setTimeout(async () => {
      try {
        const groups = await search(q);
        if (mine === seq) render(groups, q);
      } catch (e) {
        if (mine === seq) status.textContent = e.message ?? "Search failed.";
      }
    }, 180);
  };

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      go(options[active].href);
    }
  });

  const dlg = h(
    "dialog",
    { class: "palette", "aria-label": "Search everything" },
    h(
      "div",
      { class: "palette-bar" },
      Icon("search", { size: 14 }),
      input,
      h("button", {
        type: "button",
        class: "btn btn-quiet",
        "aria-label": "Close search",
        onclick: () => dlg.close(),
      }, h("kbd", { class: "kbd" }, "Esc")),
    ),
    status,
    results,
  );
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (!navigated) restoreFocus(opener);
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close(); // click on the backdrop
  });
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
  run();
}
