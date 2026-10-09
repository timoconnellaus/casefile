// CheckList (spec §5): what casefile checked itself, one row per check:
// "✓ 14 March 2025 appears in D002:9" / "▲ Lachlan is not in D001:1–2".
import { h } from "../dom.js";
import { checkRow } from "../model.js";
import { Segments } from "./entity.js";
import { Icon } from "./icons.js";

/**
 * @param {{
 *   rows: Array<{level?: "ok"|"attention"|"danger", ok?: boolean|null, message?: string,
 *     text?: string, segs?: object[]}>,
 *   heading?: string|null,
 *   caveat?: string|null,
 *   headingLevel?: "h2"|"h3"|"h4",
 * }} opts
 */
export function CheckList(opts) {
  const id = `cl-${Math.random().toString(36).slice(2, 8)}`;
  const heading = opts.heading === null ? null : h(
    opts.headingLevel ?? "h3",
    { id },
    opts.heading ?? "casefile checked the details against the cited lines",
  );
  const caveat = opts.caveat === null ? null : h(
    "p",
    { class: "muted small" },
    opts.caveat ??
      "These checks only look for names, dates and numbers. Whether Claude read the source fairly is for you to judge.",
  );
  const list = opts.rows.length
    ? h(
      "ul",
      { class: "checklist" },
      opts.rows.map((r) => {
        const row = checkRow(r);
        return h(
          "li",
          { class: row.className },
          h("span", { class: "check-glyph" }, Icon(row.glyph)),
          h(
            "span",
            {},
            h("span", { class: "sr" }, `${row.sr} `),
            r.segs ? Segments(r.segs) : row.message,
          ),
        );
      }),
    )
    : h("p", { class: "muted" }, "Nothing to check automatically in this entry.");
  return h(
    "section",
    { class: "vstack", "aria-labelledby": heading ? id : null },
    heading,
    list,
    caveat,
  );
}
