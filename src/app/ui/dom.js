// DOM helpers with no dependencies. All text goes through text nodes, never innerHTML, because
// documents contain arbitrary text. Inline styles are refused: the CSP is style-src 'self', so a
// style attribute would be blocked anyway, and the design system lives in classes (ADR 0020).

const SVG_NS = "http://www.w3.org/2000/svg";

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === "style") {
      throw new Error(
        "casefile UI: inline styles are not allowed (CSP style-src 'self'); use a class",
      );
    }
    if (k === "innerHTML" || k === "outerHTML") {
      throw new Error("casefile UI: innerHTML is not allowed; pass children instead");
    }
    // aria-* and data-* keep false as "false" (aria-pressed="false" matters).
    if (typeof v === "boolean" && (k.startsWith("aria-") || k.startsWith("data-"))) {
      el.setAttribute(k, String(v));
      continue;
    }
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.setAttribute("class", Array.isArray(v) ? cls(...v) : v);
    else if (k === "value" && "value" in el) el.value = v;
    else if (k === "checked" && "checked" in el) el.checked = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "ref" && typeof v === "function") v(el);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Create an element: h("div", {class: "x", onclick: fn}, child, "text", [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  return append(el, children);
}

/** Create an SVG element (for icons). Presentation attributes only, no style. */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  return append(el, children);
}

export function clear(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** Join class names, skipping falsy ones: cls("btn", on && "is-on") */
export function cls(...names) {
  return names.flat().filter(Boolean).join(" ");
}

let uid = 0;
/** A page-unique id with a readable prefix. */
export function uniqueId(prefix = "cf") {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * The text offset of a DOM point (a selection end) within text split across `marks`: elements
 * that each carry their own starting offset in `data-off`, in document order. A point before a
 * mark snaps to its start; a point after them all, to the end of the last. Null when the point
 * can't be compared (it is in another document).
 * @param {Element[]} marks @param {Node} node @param {number} offset
 * @returns {number|null}
 */
export function pointOffset(marks, node, offset) {
  const r = document.createRange();
  for (const el of marks) {
    r.selectNodeContents(el);
    let cmp;
    try {
      cmp = r.comparePoint(node, offset);
    } catch {
      return null;
    }
    if (cmp < 0) return Number(/** @type {HTMLElement} */ (el).dataset.off);
    if (cmp === 0) {
      const pre = document.createRange();
      pre.setStart(el, 0);
      pre.setEnd(node, offset);
      return Number(/** @type {HTMLElement} */ (el).dataset.off) + pre.toString().length;
    }
  }
  const last = /** @type {HTMLElement|undefined} */ (marks.at(-1));
  return last ? Number(last.dataset.off) + (last.textContent ?? "").length : null;
}
