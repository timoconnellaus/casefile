// Ask casefile's extra check (ADR 14) about one item: a button, then its flags as CheckList-style
// rows. Flags only ask the user to look again; nothing here marks, changes or shares anything.
import { h } from "../dom.js";
import { api, errorText } from "../lib.js";
import { checkRow } from "../model.js";
import { Segments } from "./entity.js";
import { announce } from "./feedback.js";
import { Icon } from "./icons.js";

/**
 * @param {{type: "chronology"|"evidence"|"paragraph"|"document", id: string|number,
 *   label: string}} opts `label` names the item for the button's accessible name.
 */
export function ExtraCheck({ type, id, label }) {
  const out = h("div", { class: "vstack extracheck-out", role: "status" });
  const btn = h("button", {
    type: "button",
    class: "btn",
    "aria-label": `Ask casefile’s extra check about ${label}`,
    onclick: async () => {
      btn.disabled = true;
      out.replaceChildren(h("p", { class: "muted" }, "Asking casefile’s extra check…"));
      try {
        const r = await api("POST", "/api/judge/check", { type, id });
        out.replaceChildren(...result(r));
        announce(
          r.flags.length
            ? `casefile’s extra check points out ${r.flags.length} ${
              r.flags.length === 1 ? "thing" : "things"
            } to look at.`
            : "casefile’s extra check found nothing to point out.",
        );
      } catch (e) {
        out.replaceChildren(h("p", {}, errorText(e)));
      } finally {
        btn.disabled = false;
      }
    },
  }, "Ask casefile’s extra check");
  return h("div", { class: "vstack extracheck" }, h("div", {}, btn), out);
}

/** @param {{flags: any[], notChecked: string[], judgements: number}} r */
function result(r) {
  const rows = r.flags.map((f) => {
    const row = checkRow({ level: "attention", ok: false, message: f.message });
    return h(
      "li",
      { class: row.className },
      h("span", { class: "check-glyph" }, Icon(row.glyph)),
      h(
        "span",
        { class: "vstack" },
        h("span", {}, h("span", { class: "sr" }, `${row.sr} `), f.message),
        f.segs ? h("span", { class: "muted" }, "“", Segments(f.segs), "”") : null,
      ),
    );
  });
  return [
    rows.length
      ? h("ul", { class: "checklist" }, rows)
      : r.judgements
      ? h("p", {}, "casefile’s extra check found nothing to point out.")
      : null,
    ...r.notChecked.map((n) => h("p", { class: "muted" }, `Not checked: ${n}`)),
    h(
      "p",
      { class: "muted small" },
      "The extra check only points things out. It never marks anything as checked, and it can be wrong both ways.",
    ),
  ];
}
