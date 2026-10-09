// LinesTable: a document as a real <table>, line numbers as row headers (spec §7). Modes:
// "real" (You see), "token" (Claude sees) or "side" (both columns, side by side).
import { h } from "../dom.js";
import { Segments } from "./entity.js";

/**
 * @param {{
 *   caption: string,
 *   lines: {line: number, segs?: object[], text?: string}[],
 *   mode?: "real"|"token"|"side",
 *   highlight?: {start: number, end?: number}|null,
 * }} opts
 */
export function LinesTable(opts) {
  const mode = opts.mode ?? "real";
  const hl = opts.highlight;
  const isHl = (n) => hl && n >= hl.start && n <= (hl.end ?? hl.start);
  const cell = (l, m) =>
    h(
      "td",
      { class: m === "token" ? "lines-claude" : "lines-real" },
      l.segs ? Segments(l.segs, { mode: m }) : (l.text ?? ""),
    );
  const head = mode === "side"
    ? [
      h("th", { scope: "col", class: "lines-n" }, "Line"),
      h("th", { scope: "col", class: "eyebrow" }, "You see"),
      h("th", { scope: "col", class: "eyebrow lines-split" }, "Claude sees"),
    ]
    : [
      h("th", { scope: "col", class: "lines-n" }, "Line"),
      h("th", { scope: "col", class: "eyebrow" }, mode === "token" ? "Claude sees" : "You see"),
    ];
  return h(
    "table",
    { class: `lines-table lines-table--${mode}` },
    h("caption", { class: "sr" }, opts.caption),
    h("thead", {}, h("tr", {}, head)),
    h(
      "tbody",
      {},
      opts.lines.map((l) =>
        h(
          "tr",
          { id: `line-${l.line}`, class: isHl(l.line) ? "is-cited" : null },
          h("th", { scope: "row", class: "lines-n" }, String(l.line)),
          mode === "side" ? [cell(l, "real"), cell(l, "token")] : cell(l, mode),
        )
      ),
    ),
  );
}
