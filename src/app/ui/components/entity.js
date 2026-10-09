// People and places in text (spec §4): EntityMark (real text), TokenChip (what Claude sees),
// EntityDot, Key (legend) and the linking controller (hover/focus/pin highlights every
// occurrence; others dim to 60%; a pointer must rest 150 ms first).
import { h } from "../dom.js";
import {
  colourClass,
  describeMark,
  entityShape,
  planSegments,
  roleLabel,
  shapeClass,
  tokenText,
} from "../model.js";
import { Icon } from "./icons.js";

// ── hidden descriptions (aria-describedby targets) ───────────────────────────

const descIds = new Map();
let descHost = null;

/** The id of a hidden element holding `text`, created once per distinct text. */
export function describeId(text) {
  if (descIds.has(text) && document.getElementById(descIds.get(text))) return descIds.get(text);
  if (!descHost || !descHost.isConnected) {
    descHost = document.getElementById("cf-descs") ??
      h("div", { id: "cf-descs", class: "sr" });
    if (!descHost.isConnected) document.body.append(descHost);
  }
  const id = `cf-desc-${descIds.size + 1}`;
  descHost.append(h("span", { id }, text));
  descIds.set(text, id);
  return id;
}

// ── marks and chips ──────────────────────────────────────────────────────────

function markAttrs(part, interactive) {
  return {
    class: part.className,
    "data-role": part.role,
    tabindex: interactive ? "0" : null,
    "aria-describedby": describeId(part.describe),
    title: part.describe,
  };
}

/**
 * A real name or value, coloured and underlined by kind.
 * @param {{t: string, role: string, form?: string, kind?: string, colour?: number|null,
 *   name?: string}} seg
 * @param {{interactive?: boolean}} [opts] interactive (default true): focusable, links occurrences
 */
export function EntityMark(seg, opts = {}) {
  const [part] = planSegments([seg], { mode: "real" });
  return h("span", markAttrs(part, opts.interactive !== false), part.text);
}

/**
 * The small tag drawn after a mark in the text on the review screen: "needs you" (attention) or
 * "kept" (left as written). Hidden from screen readers: the mark itself says so.
 * @param {"needs"|"kept"} kind
 */
export function MarkTag(kind) {
  return kind === "needs"
    ? h("span", { class: "mark-tag mark-tag--needs", "aria-hidden": "true", "data-skip": "" }, [
      Icon("dot"),
      "needs you",
    ])
    : h("span", { class: "mark-tag", "aria-hidden": "true", "data-skip": "" }, "kept");
}

/**
 * The label Claude sees, as a mono chip in the entity's colour.
 * Accepts a segment, or {role, form, kind, colour} with no text.
 */
export function TokenChip(seg, opts = {}) {
  if (seg.unknown || seg.malformed) return UnknownToken(seg.raw ?? seg.t);
  const [part] = planSegments([{ t: seg.t ?? seg.name ?? seg.role, ...seg }], { mode: "token" });
  return h("span", markAttrs(part, opts.interactive === true), part.text);
}

/** A token casefile doesn't know: shown in the danger style so it can't be missed. */
export function UnknownToken(raw) {
  return h(
    "span",
    {
      class: "token token--unknown",
      "aria-describedby": describeId("Not a label casefile knows. Check this."),
    },
    Icon("triangle"),
    raw,
  );
}

/** A small swatch: round for people, square for places, dotted ring for numbers. */
export function EntityDot(e) {
  return h("span", {
    class: `ent-dot ent-dot--${entityShape(e.kind ?? "person")} ${colourClass(e)}`,
    "aria-hidden": "true",
  });
}

/**
 * Text made of segments. mode "real" shows marks, "token" shows chips. `roleChips`: after each
 * name in neutral ink, a small chip with its role ("Margaret  maternal grandmother"), as the
 * mockups show while names are highlighted (people without a colour are otherwise unmarked).
 * @param {Array<object|string>} segs
 * @param {{mode?: "real"|"token", interactive?: boolean, className?: string,
 *   roleChips?: boolean}} [opts]
 */
export function Segments(segs, opts = {}) {
  const interactive = opts.interactive !== false;
  const parts = planSegments(segs, { mode: opts.mode ?? "real" });
  const node = h(
    "span",
    { class: ["segs", opts.className] },
    parts.map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "unknown") return UnknownToken(p.text);
      return h("span", markAttrs(p, interactive), p.text);
    }),
  );
  return opts.roleChips ? withRoleChips(node) : node;
}

/**
 * Add role chips after the neutral-ink names in `node` (Segments' `roleChips`), for text built
 * elsewhere (a source panel's lines). Safe to call again: a name keeps one chip. Hidden from
 * screen readers, which already hear the role in the mark's description.
 * @template {Element} T @param {T} node @returns {T}
 */
export function withRoleChips(node) {
  for (const el of node.querySelectorAll(".ent.ent-ink[data-role]")) {
    if (el.nextElementSibling?.classList.contains("role-chip")) continue;
    el.after(h("span", { class: "role-chip", "aria-hidden": "true" }, roleLabel(el.dataset.role)));
  }
  return node;
}

// ── key (legend) ─────────────────────────────────────────────────────────────

/**
 * The key: one pin button per coloured person (name, chip, count), the underline shapes, and a
 * "Show everyone" button while something is pinned. Put it inside the same root you pass to
 * linkEntities() so its buttons link with the text.
 * @param {{entries: {role: string, name: string, kind?: string, colour?: number|null,
 *   count?: number}[], shapes?: boolean, help?: string|null, title?: string}} opts
 */
export function Key(opts) {
  const headingId = `key-h-${Math.random().toString(36).slice(2, 8)}`;
  const clearBtn = h("button", {
    type: "button",
    class: "btn-link key-clear",
    hidden: true,
    "data-key-clear": "",
  }, "Show everyone");
  const entries = opts.entries.map((e) => {
    const tok = tokenText(e.role);
    const count = e.count != null ? `, ${e.count} ${e.count === 1 ? "time" : "times"}` : "";
    return h(
      "button",
      {
        type: "button",
        class: "key-item",
        "data-role": e.role,
        "aria-pressed": false,
        "aria-label": `Keep highlighted: ${e.name}, Claude sees ${tok}${count}`,
      },
      EntityDot(e),
      h("span", {}, e.name),
      h("span", { class: `token ${colourClass(e)}` }, tok),
      e.count != null ? h("span", { class: "key-count num" }, `×${e.count}`) : null,
    );
  });
  return h(
    "section",
    { class: "key", "aria-labelledby": headingId },
    h(
      "div",
      { class: "key-row" },
      h("h2", { id: headingId, class: "eyebrow key-title" }, opts.title ?? "Key"),
      entries,
      clearBtn,
    ),
    opts.shapes === false ? null : h(
      "div",
      { class: "key-shapes" },
      h(
        "span",
        {},
        h("span", { class: "shape-sample ent-solid", "aria-hidden": "true" }, "Solid"),
        " person",
      ),
      h(
        "span",
        {},
        h("span", { class: "shape-sample ent-dashed", "aria-hidden": "true" }, "Dashed"),
        " place or organisation",
      ),
      h(
        "span",
        {},
        h("span", { class: "shape-sample ent-dotted", "aria-hidden": "true" }, "Dotted"),
        " number or date",
      ),
      opts.help === null ? null : h(
        "span",
        { class: "muted" },
        opts.help ??
          "Parents and children have their own colour; everyone else is plain ink. Point at or tab to a name to see everywhere it appears; click to keep it highlighted.",
      ),
    ),
  );
}

// ── linking controller ───────────────────────────────────────────────────────

const HOVER_DELAY = 150;

/**
 * Link every element with data-role inside `root`: hover (after 150 ms) or focus highlights all
 * occurrences and dims the rest to 60%; click or Enter pins. Returns {pin, clear, destroy}.
 * `onPin(role, el)` is called whenever the pinned role changes (null when cleared), with the
 * element that was clicked to pin it.
 * @param {HTMLElement} root
 * @param {{onPin?: (role: string|null, el: Element|null) => void}} [opts]
 */
export function linkEntities(root, opts = {}) {
  let hover = null;
  let pinned = null;
  let timer;

  const apply = () => {
    const active = hover ?? pinned;
    root.classList.toggle("is-linking", Boolean(active));
    for (const el of root.querySelectorAll("[data-role]")) {
      el.classList.toggle("is-on", el.dataset.role === active);
      if (el.matches("button.key-item")) {
        el.setAttribute("aria-pressed", String(el.dataset.role === pinned));
      }
    }
    for (const b of root.querySelectorAll("[data-key-clear]")) b.hidden = !pinned;
  };
  const roleOf = (t) => (t instanceof Element ? t.closest("[data-role]") : null);
  const setPin = (role, el = null) => {
    pinned = pinned === role ? null : role;
    apply();
    opts.onPin?.(pinned, el);
  };

  const onOver = (e) => {
    const el = roleOf(e.target);
    if (!el || !root.contains(el)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      hover = el.dataset.role;
      apply();
    }, HOVER_DELAY);
  };
  const onOut = (e) => {
    const from = roleOf(e.target);
    const to = roleOf(e.relatedTarget);
    if (!from || (to && to.dataset.role === from.dataset.role)) return;
    clearTimeout(timer);
    if (hover) {
      hover = null;
      apply();
    }
  };
  const onFocusIn = (e) => {
    const el = roleOf(e.target);
    if (!el) return;
    clearTimeout(timer);
    hover = el.dataset.role;
    apply();
  };
  const onFocusOut = () => {
    clearTimeout(timer);
    if (hover) {
      hover = null;
      apply();
    }
  };
  const onClick = (e) => {
    if (e.target instanceof Element && e.target.closest("[data-key-clear]")) {
      pinned = null;
      hover = null;
      apply();
      opts.onPin?.(null, null);
      return;
    }
    const el = roleOf(e.target);
    if (el) setPin(el.dataset.role, el);
  };
  const onKey = (e) => {
    const el = roleOf(e.target);
    if (!el || el.tagName === "BUTTON") return; // buttons already click on Enter/Space
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setPin(el.dataset.role, el);
    } else if (e.key === "Escape" && pinned) {
      pinned = null;
      apply();
      opts.onPin?.(null, null);
    }
  };

  root.addEventListener("mouseover", onOver);
  root.addEventListener("mouseout", onOut);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  return {
    pin(role) {
      pinned = role;
      apply();
      opts.onPin?.(pinned, null);
    },
    clear() {
      pinned = null;
      hover = null;
      apply();
      opts.onPin?.(null, null);
    },
    destroy() {
      clearTimeout(timer);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
    },
  };
}

export { describeMark, shapeClass };
