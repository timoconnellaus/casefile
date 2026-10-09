// Drafts (W2-6): the list of drafts, each with what still needs the user ("N need you",
// "N facts to check"), and a form for a new draft. The list is also the left column of the Draft
// screen (views/draft.js), so the pieces it shares are exported here.
import { h } from "../dom.js";
import { api } from "../lib.js";
import { plural } from "../model.js";
import { announce, EmptyState, ExternalLink, Field, FlagBadge } from "../components/index.js";

/** Draft kinds the API accepts, with the words shown for them. */
export const KIND_LABELS = {
  affidavit: "Affidavit",
  outline: "Case outline",
  submission: "Submission",
  letter: "Letter",
  other: "Other",
};

/** "affidavit", "case outline" … for "affidavit · 7 paragraphs". */
export function kindWord(kind) {
  return (KIND_LABELS[kind] ?? kind ?? "draft").toLowerCase();
}

/** Paragraphs that still need the user: Claude's, not yet adopted (needs you or rewritten). */
export function needYouCount(d) {
  return (d.counts?.needsYou ?? 0) + (d.counts?.rewritten ?? 0);
}

/** What a draft still needs from the user, as count badges. */
export function DraftNeeds(d) {
  const need = needYouCount(d);
  const facts = d.factsToCheck ?? 0;
  const out = [];
  if (need) out.push(FlagBadge("attention", "dot", `${need} need${need === 1 ? "s" : ""} you`));
  if (facts) out.push(FlagBadge("attention", "dot", `${plural(facts, "fact")} to check`));
  if (!out.length) out.push(FlagBadge("neutral", "check", "Nothing needs you"));
  return h("span", { class: "drafts-needs" }, out);
}

/**
 * The drafts list. On the Draft screen `current` marks the open draft (aria-current).
 * @param {{drafts: object[], current?: number|null}} opts
 */
export function DraftsList(opts) {
  if (!opts.drafts.length) return h("p", { class: "muted" }, "No drafts yet.");
  return h(
    "ul",
    { class: "drafts-list" },
    opts.drafts.map((d) =>
      h(
        "li",
        {},
        h(
          "a",
          {
            class: "drafts-item",
            href: `#/draft/${d.id}`,
            "aria-current": d.id === opts.current ? "page" : null,
          },
          h("span", { class: "drafts-title" }, d.title ?? "Untitled"),
          h(
            "span",
            { class: "drafts-meta" },
            `${kindWord(d.kind)} · ${plural(d.paragraphs ?? 0, "paragraph")}`,
          ),
          DraftNeeds(d),
        ),
      )
    ),
  );
}

/** Why outlines and letters are checked more lightly than affidavits. */
export function LighterCheckNote() {
  return h(
    "p",
    { class: "drafts-note" },
    "Outlines and letters get a lighter check before export: any fact Claude wrote that you haven’t checked against its source is flagged, and you confirm it. Only affidavits need every Claude paragraph rewritten or used as your own.",
  );
}

/** "Not legal advice", with where to get free help (opened in the web browser). */
export function LegalHelp() {
  return h(
    "p",
    { class: "drafts-legal" },
    "casefile and Claude can’t give legal advice. Free help: ",
    ExternalLink("legal_aid_nsw"),
    " · ",
    ExternalLink("family_advice_line"),
    ".",
  );
}

/**
 * Form for a new draft: kind and title. Calls onCreated(id) once the draft exists.
 * @param {{onCreated: (id: number) => void, onCancel?: () => void}} opts
 */
export function NewDraftForm(opts) {
  const kind = h(
    "select",
    { name: "kind" },
    Object.entries(KIND_LABELS).map(([v, label]) => h("option", { value: v }, label)),
  );
  const title = h("input", { type: "text", name: "title", maxlength: "200" });
  const error = h("p", { class: "danger-text", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg" }, "Create draft");
  const form = h(
    "form",
    {
      class: "drafts-new vstack",
      "aria-label": "New draft",
      onsubmit: async (e) => {
        e.preventDefault();
        const t = title.value.trim();
        if (!t) {
          error.hidden = false;
          error.textContent = "Give the draft a title.";
          title.focus();
          return;
        }
        submit.disabled = true;
        try {
          const r = await api("POST", "/api/drafts", { kind: kind.value, title: t });
          announce(`Draft “${t}” created`);
          opts.onCreated(r.id);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    Field({ label: "Kind of draft", control: kind }),
    Field({
      label: "Title",
      control: title,
      hint: "Real names are fine: Claude sees the title with names replaced.",
    }),
    error,
    h(
      "div",
      { class: "hstack" },
      submit,
      opts.onCancel
        ? h("button", { type: "button", class: "btn btn-lg", onclick: opts.onCancel }, "Cancel")
        : null,
    ),
  );
  form.focusFirst = () => kind.focus();
  return form;
}

/**
 * The left column of the Draft screen: heading, "+ New draft", the list and the note.
 * @param {{drafts: object[], current?: number|null, navigate: (hash: string) => void}} opts
 */
export function DraftsAside(opts) {
  const slot = h("div", {});
  const closeForm = () => {
    slot.replaceChildren();
    newBtn.setAttribute("aria-expanded", "false");
    newBtn.focus();
  };
  const newBtn = h("button", {
    type: "button",
    class: "btn",
    "aria-expanded": "false",
    onclick: () => {
      if (slot.firstChild) return closeForm();
      const f = NewDraftForm({
        onCreated: (id) => opts.navigate(`#/draft/${id}`),
        onCancel: closeForm,
      });
      slot.append(f);
      newBtn.setAttribute("aria-expanded", "true");
      f.focusFirst();
    },
  }, "+ New draft");
  return h(
    "aside",
    { class: "col-side col-side--left drafts-aside", "aria-labelledby": "drafts-aside-h" },
    h(
      "div",
      { class: "hstack between" },
      h("h2", { id: "drafts-aside-h", class: "eyebrow" }, "Drafts"),
      newBtn,
    ),
    slot,
    DraftsList(opts),
    LighterCheckNote(),
  );
}

/** #/drafts */
export default async function view(main, _params, ctx) {
  const drafts = await api("GET", "/api/drafts");
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Drafts")),
    h(
      "div",
      { class: "page-body drafts-page" },
      h(
        "section",
        { class: "vstack", "aria-labelledby": "drafts-h" },
        h("h2", { id: "drafts-h", class: "section-title" }, "Your drafts"),
        drafts.length ? DraftsList({ drafts }) : EmptyState({
          message:
            "No drafts yet. Start an affidavit, an outline or a letter below, or ask Claude to draft one.",
        }),
        LighterCheckNote(),
      ),
      h(
        "section",
        { class: "vstack drafts-new-section", "aria-labelledby": "drafts-new-h" },
        h("h2", { id: "drafts-new-h", class: "section-title" }, "Start a new draft"),
        NewDraftForm({ onCreated: (id) => ctx.navigate(`#/draft/${id}`) }),
      ),
      LegalHelp(),
    ),
  );
}
