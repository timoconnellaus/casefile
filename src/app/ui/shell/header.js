// AppHeader (spec §5): brand · case name · sections (with the To-check count) · search (⌘K) ·
// "Locks after N min idle" · Lock. The same on every screen; aria-current marks the section.
import { h } from "../dom.js";
import { idleNote } from "../model.js";
import { NAV } from "../routes.js";

/**
 * @param {{
 *   label: string,
 *   current: string|null,
 *   toCheck?: number|null,
 *   idleMinutes?: number,
 *   onSearch: (query: string) => void,
 *   onLock: () => unknown,
 *   nav?: typeof NAV,
 *   dev?: boolean,
 * }} opts
 * @returns {HTMLElement & {setCount: (n: number|null) => void,
 *   setIdleMinutes: (m: number) => void, setLabel: (label: string) => void,
 *   setCurrent: (id: string|null) => void}}
 */
export function AppHeader(opts) {
  const countEls = [];
  const linkById = new Map();
  const navLinks = (opts.nav ?? NAV).map((item) => {
    // The visible "(14)" is hidden from screen readers; the link's name says "To check, 14
    // waiting" once (QA G6).
    const count = item.count
      ? h(
        "span",
        { class: "nav-count", hidden: true, "aria-hidden": "true" },
        h("span", {
          class: "num",
        }, ""),
      )
      : null;
    const link = h(
      "a",
      {
        href: item.href,
        class: "nav-link",
        "aria-current": item.id === opts.current ? "page" : null,
      },
      item.label,
      count,
    );
    if (count) countEls.push({ count, link, label: item.label });
    linkById.set(item.id, link);
    return link;
  });

  const search = h("input", {
    type: "search",
    class: "appsearch-input",
    placeholder: "Search",
    autocomplete: "off",
    "aria-keyshortcuts": "Meta+K Control+K",
    "aria-haspopup": "dialog",
  });
  const open = () => {
    const q = search.value;
    search.value = "";
    opts.onSearch(q);
  };
  search.addEventListener("input", open);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      open();
    }
  });
  search.addEventListener("click", open);

  const caseName = h("span", { class: "case-name", hidden: !opts.label }, opts.label ?? "");
  const idle = h("span", { class: "idle-note" }, idleNote(opts.idleMinutes));
  const header = h(
    "header",
    { class: "appheader" },
    h(
      "div",
      { class: "appheader-brand" },
      h(
        "a",
        { class: "brand", href: "#/start", "aria-label": "casefile: Getting started" },
        "casefile",
      ),
      // A development run (ADR 22): never to be taken for the copy in daily use.
      opts.dev
        ? h("span", { class: "dev-mark", title: "Development copy: the example case only" }, "dev")
        : null,
      caseName,
    ),
    h("nav", { class: "appnav", "aria-label": "Sections" }, navLinks),
    h("div", { class: "spacer" }),
    h(
      "label",
      { class: "appsearch" },
      h("span", { class: "sr" }, "Search the case"),
      search,
      h("kbd", { class: "kbd", "aria-hidden": "true" }, "⌘K"),
    ),
    idle,
    h("button", {
      type: "button",
      class: "btn",
      title: "Close the case and forget the passphrase",
      onclick: opts.onLock,
    }, "Lock"),
  );

  const setCount = (n) => {
    for (const { count, link, label } of countEls) {
      const show = typeof n === "number";
      count.hidden = !show;
      if (show) {
        count.children[0].textContent = `(${n})`;
        count.classList.toggle("nav-count--zero", n === 0);
        link.setAttribute("aria-label", `${label}, ${n} waiting`);
      } else link.removeAttribute("aria-label");
    }
  };
  setCount(opts.toCheck ?? null);
  /** "Locks after N min idle", after Settings changes it. */
  const setIdleMinutes = (m) => (idle.textContent = idleNote(m));
  /** The case's name, after Settings renames it. */
  const setLabel = (label) => {
    caseName.textContent = label ?? "";
    caseName.hidden = !label;
  };
  /** Mark the section now shown (the header stays put while screens change). */
  const setCurrent = (id) => {
    for (const [itemId, link] of linkById) {
      if (itemId === id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  };
  return Object.assign(header, { setCount, setIdleMinutes, setLabel, setCurrent });
}
