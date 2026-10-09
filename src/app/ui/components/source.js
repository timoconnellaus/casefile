// SourcePanel (spec §5): the cited lines with ±2 lines of context, the document name, a line
// link and "Open document". Can start closed ("Show the cited lines") so a check button can stay
// disabled until the source has been shown.
import { h } from "../dom.js";
import { formatRef, lineRange, refHref, sourceWindow } from "../model.js";
import { Segments } from "./entity.js";

/**
 * @param {{
 *   doc: string, title: string, own?: boolean,
 *   start: number, end?: number,
 *   lines: Array<{line: number, text?: string, segs?: object[]}|string>,
 *   context?: number,
 *   mode?: "real"|"token",
 *   open?: boolean,
 *   onShow?: () => void,
 * }} opts `lines` may be the whole document or just a window; only start-2..end+2 are shown.
 */
export function SourcePanel(opts) {
  const end = opts.end ?? opts.start;
  const ref = { doc: opts.doc, start: opts.start, end };
  const label = formatRef(ref);
  const listLabel = `${opts.doc} ${lineRange(opts.start, end)}, with nearby lines`;
  const body = h("div", { class: "src-body" });

  const showLines = () => {
    const rows = sourceWindow(opts.lines, opts.start, end, opts.context ?? 2);
    body.replaceChildren(
      h(
        "ol",
        { class: "src-lines", "aria-label": listLabel },
        rows.map((l) =>
          h(
            "li",
            { class: l.cited ? "is-cited" : "is-context" },
            h("span", { class: "src-ln", "aria-hidden": "true" }, String(l.line)),
            h(
              "span",
              { class: "src-text" },
              h("span", { class: "sr" }, `${l.cited ? "Cited line" : "Line"} ${l.line}: `),
              l.segs ? Segments(l.segs, { mode: opts.mode ?? "real" }) : (l.text ?? ""),
            ),
          )
        ),
      ),
    );
  };
  const showButton = h("button", {
    type: "button",
    class: "btn",
    "aria-label": `Show the cited lines from ${label}`,
    onclick: () => {
      showLines();
      opts.onShow?.();
      body.querySelector("ol")?.setAttribute("tabindex", "-1");
      body.querySelector("ol")?.focus();
    },
  }, "Show the cited lines");

  if (opts.open === false) {
    body.append(h("div", { class: "src-closed" }, h("span", {}, "Not opened yet."), showButton));
  } else showLines();

  return h(
    "figure",
    { class: "src" },
    h(
      "figcaption",
      { class: "src-head" },
      h(
        "span",
        {},
        h("span", { class: "mono" }, opts.doc),
        " · ",
        opts.title,
        opts.own ? h("span", { class: "src-own" }, " (your own statement)") : null,
      ),
      h(
        "span",
        { class: "hstack" },
        h("a", { class: "mono", href: refHref(ref) }, label),
        h("a", { href: `#/doc/${opts.doc}` }, "Open document"),
      ),
    ),
    body,
  );
}
