// Draft (W2-6): one draft laid out like the filed document. Each paragraph shows its state
// (Your words / Drafted by Claude — needs you / — rewritten by you, adopt to confirm / — adopted),
// its sources and what it relies on. The right column holds the one open Rewrite / Edit / "Use
// these words as my own" panel, then the export check. Affidavits also get a heading (kept in the
// vault only), annexures and a jurat. Copy follows DESIGN-SPEC §3 and §6.
import { h } from "../dom.js";
import { api, ApiError, download, listPeople } from "../lib.js";
import { formatDay, lineRange, parseRef, plural, segmentsFromText } from "../model.js";
import {
  ActorLabel,
  announce,
  Badge,
  Callout,
  CheckList,
  ConfirmBar,
  confirmDialog,
  ExtraCheck,
  Field,
  FlagBadge,
  Icon,
  Key,
  linkEntities,
  Segments,
  showToast,
  SourcePanel,
  Toggle,
} from "../components/index.js";
import { DraftsAside, kindWord, LegalHelp } from "./drafts.js";

const CHECK_FORM = "[check against the Court’s current affidavit form]";
const PLACEHOLDER = /\[\s*in\s+your\s+own\s+words[^\]]*\]?/gi;
const PARA_STATES = ["user", "claude_adopted", "claude_rewritten", "claude_needs_you"];
const COUNT_KEY = {
  user: "user",
  claude_adopted: "adopted",
  claude_rewritten: "rewritten",
  claude_needs_you: "needsYou",
};

/** Answers to "Did you see this yourself or read it?" (API values saw | read | unsure). */
const FACT_ANSWERS = [
  { value: "saw", label: "I saw or did this myself" },
  { value: "read", label: "I read it, or someone told me" },
  { value: "unsure", label: "I’m not sure" },
];

// ── text helpers ─────────────────────────────────────────────────────────────

/** Paragraph body segments with `[In your own words …]` placeholders shown as their own block. */
function BodyText(segs, interactive) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) out.push(Segments(run, { interactive }));
    run = [];
  };
  for (const seg of segs ?? []) {
    if (seg.role || seg.unknown || seg.malformed) {
      run.push(seg);
      continue;
    }
    const t = seg.t ?? "";
    let last = 0;
    for (const m of t.matchAll(PLACEHOLDER)) {
      if (m.index > last) run.push({ t: t.slice(last, m.index) });
      flush();
      out.push(h("span", { class: "draft-ph" }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < t.length) run.push({ t: t.slice(last) });
  }
  flush();
  return out;
}

/**
 * The paragraph fact by fact, as casefile split and checked it (`p.facts` from the API). Adoption
 * records the answers against exactly these, in order.
 */
function factsOf(p) {
  return (p.facts ?? []).map((f) => ({
    text: f.text?.text ?? "",
    segs: f.text?.segs ?? [],
    checks: f.checks ?? [],
  }));
}

/** "Paragraphs 4, 5 and 6" / "Paragraph 4". */
function paraList(ns) {
  const u = [...new Set(ns)];
  if (u.length === 1) return `paragraph ${u[0]}`;
  return `paragraphs ${u.slice(0, -1).join(", ")} and ${u.at(-1)}`;
}

/** "14 March 2025 chronology entry" for a relied-on item (its `date` from the API). */
function reliesTitle(r) {
  if (r.type === "chronology") {
    return r.date ? `${formatDay(r.date)} chronology entry` : "chronology entry";
  }
  return "evidence link";
}

// ── the view ─────────────────────────────────────────────────────────────────

/** #/draft/:id */
export default async function view(main, params, ctx) {
  const id = Number(params.id);
  const st = {
    draft: null,
    drafts: [],
    people: { byRole: new Map(), list: [] },
    hl: false,
    srcOpen: new Set(),
    /** The one open panel: {type: "adopt"|"rewrite"|"edit", para: id, ...form state} */
    panel: null,
    exportConfirm: null,
    /** A protected address is in the export: {format, confirm, addresses} (W3-1). */
    exportSafety: null,
  };

  const load = async () => {
    const [draft, drafts, entities] = await Promise.all([
      api("GET", `/api/drafts/${id}`),
      api("GET", "/api/drafts"),
      st.people.list.length ? null : listPeople(),
    ]);
    st.draft = draft;
    st.drafts = drafts;
    if (entities) {
      st.people.list = entities;
      st.people.byRole = new Map(entities.map((e) => [e.role, e]));
    }
    // A panel for a paragraph that is gone, or that no longer offers that panel, closes.
    const p = st.panel && paraById(st.panel.para);
    if (st.panel && (!p || !panelFits(st.panel.type, p))) st.panel = null;
  };

  const paraById = (pid) => st.draft?.paragraphs.find((p) => p.id === pid) ?? null;
  const panelFits = (type, p) =>
    type === "edit"
      ? p.state === "user"
      : type === "rewrite"
      ? p.state === "claude_needs_you" || p.state === "claude_rewritten"
      : (p.state === "claude_needs_you" || p.state === "claude_rewritten") && !p.hasPlaceholder;

  /** Reload and redraw, keeping the scroll position; then run `after` (e.g. move focus). */
  const refresh = async (after) => {
    const y = document.scrollingElement?.scrollTop ?? 0;
    await load();
    render();
    if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    after?.();
    ctx.refreshCounts?.();
  };

  /** Run an action; errors become a danger toast. */
  const act = (fn) => async (ev) => {
    const btn = ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (e) {
      console.error(e);
      showToast(e.message ?? String(e), { tone: "danger" });
    } finally {
      if (btn?.isConnected) btn.disabled = false;
    }
  };

  const focusPara = (pid) => {
    const el = main.querySelector(`#para-${pid}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
  };

  // ── panels: only one open at a time ────────────────────────────────────────

  let side = null;

  const openPanel = (type, pid) => {
    const p = paraById(pid);
    st.panel = {
      type,
      para: pid,
      text: type === "edit" || p?.state === "claude_rewritten" ? p?.body?.text ?? "" : "",
      sources: (p?.sources ?? []).map((s) => s.ref).join(", "),
      answers: {},
      own: false,
      words: false,
    };
    syncSelection();
    renderSide();
    side.querySelector("#ctx-title")?.focus();
  };

  const closePanel = () => {
    const pid = st.panel?.para;
    const type = st.panel?.type;
    st.panel = null;
    syncSelection();
    renderSide();
    const back = main.querySelector(`[data-panel="${type}:${pid}"]`) ??
      main.querySelector(`#para-${pid}`);
    back?.focus();
  };

  /** Mark the paragraph the open panel is about, and every opener's aria-expanded. */
  const syncSelection = () => {
    for (const el of main.querySelectorAll(".draft-para")) {
      el.classList.toggle("is-selected", st.panel?.para === Number(el.dataset.para));
    }
    for (const b of main.querySelectorAll("[data-panel]")) {
      const open = st.panel && b.dataset.panel === `${st.panel.type}:${st.panel.para}`;
      b.setAttribute("aria-expanded", String(Boolean(open)));
    }
  };

  // ── paragraph actions ──────────────────────────────────────────────────────

  const saveSources = async (p, value) => {
    const refs = value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const bad = refs.filter((r) => !parseRef(r));
    if (bad.length) {
      throw new Error(`“${bad[0]}” isn’t a line reference. Use D001:3 or D001:1-2.`);
    }
    const norm = refs.map((r) => {
      const x = parseRef(r);
      return `${x.doc}:${x.start}${x.end !== x.start ? `-${x.end}` : ""}`;
    });
    const before = (p.sources ?? []).map((s) => s.ref).join(",");
    if (norm.join(",") === before) return false;
    await api("PUT", `/api/paragraphs/${p.id}/sources`, { sources: norm });
    return true;
  };

  const saveText = async (p) => {
    const text = st.panel.text.trim();
    if (!text) throw new Error("Write the paragraph first.");
    const sourcesChanged = await saveSources(p, st.panel.sources);
    let state = p.state;
    if (text !== (p.body?.text ?? "").trim()) {
      const r = await api("PUT", `/api/paragraphs/${p.id}`, { text });
      state = r.state ?? state;
    } else if (!sourcesChanged) {
      throw new Error("Nothing has changed.");
    }
    const n = p.n;
    st.panel = null;
    const msg = state === "claude_rewritten"
      ? `Saved your version of paragraph ${n}. Next: “Use these words as my own” to confirm it.`
      : `Saved paragraph ${n}.`;
    await refresh(() => focusPara(p.id));
    announce(msg);
    showToast(msg, { glyph: "check" });
  };

  const adopt = async (p, facts) => {
    await api("POST", `/api/paragraphs/${p.id}/adopt`, {
      ownKnowledge: true,
      ownWords: true,
      version: p.version,
      facts: facts.map((f, i) => ({ text: f.text, answer: st.panel.answers[i] })),
    });
    st.panel = null;
    const msg =
      `Paragraph ${p.n} is adopted. It still shows “Drafted by Claude”, and the Log records your answers.`;
    await refresh(() => focusPara(p.id));
    announce(msg);
    showToast(msg, {
      glyph: "check",
      undo: async () => {
        await api("POST", `/api/paragraphs/${p.id}/unadopt`);
        await refresh(() => focusPara(p.id));
        announce(`Paragraph ${p.n}: adoption withdrawn.`);
      },
    });
  };

  const withdraw = async (p) => {
    await api("POST", `/api/paragraphs/${p.id}/unadopt`);
    await refresh(() => focusPara(p.id));
    const msg = `Paragraph ${p.n}: adoption withdrawn. It needs you again.`;
    announce(msg);
    showToast(msg);
  };

  const remove = async (p) => {
    const ok = await confirmDialog(
      `Delete paragraph ${p.n}?`,
      p.draftedByClaude
        ? "The paragraph Claude drafted is removed from this draft. The Log keeps a record that it was deleted."
        : "Your paragraph is removed from this draft.",
      "Delete paragraph",
      true,
    );
    if (!ok) return;
    await api("DELETE", `/api/paragraphs/${p.id}`);
    if (st.panel?.para === p.id) st.panel = null;
    await refresh(() => main.querySelector("h1")?.focus());
    announce(`Paragraph ${p.n} deleted.`);
  };

  // ── render: paragraphs ─────────────────────────────────────────────────────

  const opener = (type, p, label, variant) =>
    h("button", {
      type: "button",
      class: variant === "primary"
        ? "btn btn-primary btn-lg"
        : variant === "link"
        ? "btn-link"
        : "btn btn-lg",
      "data-panel": `${type}:${p.id}`,
      "aria-expanded": "false",
      "aria-controls": "ctx-panel",
      "aria-label": `${label}, paragraph ${p.n}`,
      onclick: () => openPanel(type, p.id),
    }, label);

  const SourcesBlock = (p) => {
    if (!p.sources?.length) return null;
    const open = st.srcOpen.has(p.id);
    const regionId = `src-${p.id}`;
    const region = h(
      "div",
      { id: regionId, class: "draft-sources vstack gap-sm", hidden: !open },
      open ? p.sources.map((s) => SourceFigure(s)) : null,
    );
    const btn = h(
      "button",
      {
        type: "button",
        class: "draft-srcbtn",
        "aria-expanded": String(open),
        "aria-controls": regionId,
        "aria-label": `Sources for paragraph ${p.n}: ${p.sources.map((s) => s.ref).join(", ")}`,
        onclick: () => {
          const now = !st.srcOpen.has(p.id);
          if (now) st.srcOpen.add(p.id);
          else st.srcOpen.delete(p.id);
          btn.setAttribute("aria-expanded", String(now));
          btn.querySelector(".icon")?.classList.toggle("is-open", now);
          region.hidden = !now;
          region.replaceChildren(...(now ? p.sources.map((s) => SourceFigure(s)) : []));
        },
      },
      h("span", { class: open ? "draft-caret is-open" : "draft-caret" }, Icon("chevron")),
      "Sources · ",
      h("span", { class: "mono" }, p.sources.map((s) => s.ref.replace("-", "–")).join(" · ")),
    );
    return [btn, region];
  };

  const SourceFigure = (s) => {
    if (s.withheld || !s.citable) {
      return Callout({
        tone: "danger",
        title: `${s.ref} can’t be quoted`,
        children: s.withheld
          ? "This document is withheld from Claude, so it can’t be cited. Choose another source."
          : "casefile can’t find these lines: the document is missing, not shared, or shorter.",
      });
    }
    return SourcePanel({
      doc: s.doc,
      title: s.docTitle ?? s.doc,
      start: s.lineStart,
      end: s.lineEnd,
      // ±2 lines of context around the cited ones (from the API, each marked cited or not).
      lines: s.lines ?? s.quote ?? [],
      context: 2,
      mode: "real",
    });
  };

  const ProblemChecks = (p) => {
    if (p.state === "user" || p.state === "claude_adopted") return null;
    const rows = (p.checks ?? []).filter((c) => c.level !== "ok" && c.kind !== "placeholder");
    if (!rows.length) return null;
    return h(
      "div",
      { class: "draft-flags" },
      h("span", { class: "draft-flags-by" }, ActorLabel("app")),
      CheckList({
        rows,
        heading: null,
        caveat: null,
      }),
    );
  };

  const ReliesNote = (p) => {
    const open = (p.relies ?? []).filter((r) => r.state !== "checked");
    if (!open.length) return null;
    return h(
      "ul",
      { class: "draft-relies" },
      open.map((r) =>
        h(
          "li",
          {},
          Badge("work", r.state, { small: true }),
          h(
            "span",
            {},
            r.state === "cant_check" ? "It relied on an item that no longer exists." : [
              "It relies on the ",
              h(
                "a",
                { href: r.type === "chronology" ? "#/chronology" : "#/issues" },
                reliesTitle(r),
              ),
              ", which you haven’t checked against the source yet.",
            ],
          ),
        )
      ),
    );
  };

  const Notes = (p) =>
    (p.notes ?? []).map((n) =>
      h(
        "p",
        { class: "draft-note" },
        ActorLabel(n.created_by === "user" ? "user" : "claude", { note: true }),
        " ",
        Segments(n.body?.segs ?? [{ t: n.body?.text ?? "" }], { interactive: st.hl }),
      )
    );

  const Actions = (p) => {
    if (p.state === "user") return null;
    if (p.state === "claude_adopted") {
      return h(
        "div",
        { class: "draft-actions" },
        h(
          "span",
          { class: "muted" },
          p.adopted_at ? `You adopted it on ${formatDay(p.adopted_at)}` : "You adopted it",
        ),
        h("button", {
          type: "button",
          class: "btn-link",
          "aria-label": `Withdraw adoption of paragraph ${p.n}`,
          onclick: act(() => withdraw(p)),
        }, "Withdraw"),
      );
    }
    const whyId = `why-${p.id}`;
    const adoptBtn = p.hasPlaceholder
      ? h("button", {
        type: "button",
        class: "btn btn-lg",
        disabled: true,
        "aria-describedby": whyId,
      }, "Use these words as my own…")
      : opener(
        "adopt",
        p,
        "Use these words as my own…",
        p.state === "claude_rewritten" ? "primary" : "secondary",
      );
    const rewriteBtn = opener(
      "rewrite",
      p,
      p.state === "claude_rewritten" ? "Edit my version" : "Rewrite in my own words",
      p.state === "claude_rewritten" ? "secondary" : "primary",
    );
    return h(
      "div",
      { class: "draft-actions" },
      p.state === "claude_rewritten" ? [adoptBtn, rewriteBtn] : [rewriteBtn, adoptBtn],
      p.state === "claude_needs_you"
        ? h("button", {
          type: "button",
          class: "btn-link",
          "aria-label": `Delete paragraph ${p.n}`,
          onclick: act(() => remove(p)),
        }, "Delete")
        : null,
      p.hasPlaceholder
        ? h(
          "p",
          { id: whyId, class: "draft-why" },
          "Fill in the placeholder first — it can’t be adopted with it still there.",
        )
        : null,
    );
  };

  const Paragraph = (p) =>
    h(
      "div",
      {
        id: `para-${p.id}`,
        class: ["draft-para", st.panel?.para === p.id && "is-selected"],
        "data-para": String(p.id),
        tabindex: "-1",
        "aria-label": `Paragraph ${p.n}`,
        role: "group",
      },
      h("span", { class: "draft-pnum", "aria-hidden": "true" }, `${p.n}.`),
      h(
        "div",
        { class: "draft-pmain" },
        h(
          "div",
          { class: "draft-phead" },
          Badge("para", p.state),
          p.state === "user" ? opener("edit", p, "Edit", "link") : null,
        ),
        h("p", { class: "draft-ptext" }, BodyText(p.body?.segs, st.hl)),
        p.hasPlaceholder && p.state !== "user"
          ? h(
            "p",
            { class: "draft-note" },
            ActorLabel("claude", { note: true }),
            " I don’t write feelings or opinions in your affidavit. Only you can say this part.",
          )
          : null,
        ProblemChecks(p),
        ReliesNote(p),
        Notes(p),
        Actions(p),
        SourcesBlock(p),
      ),
    );

  // ── render: heading, annexures, jurat (affidavits) ─────────────────────────

  const personName = (role) => st.people.byRole.get(role)?.forms?.full ?? null;

  const HeadingSection = (d) => {
    const hd = d.heading ?? {};
    const people = st.people.list.filter((e) => e.kind === "person");
    const roleSelect = (name, value) =>
      h(
        "select",
        { name },
        h("option", { value: "" }, "Choose someone"),
        people.map((e) =>
          h("option", { value: e.role, selected: e.role === value }, e.forms?.full ?? e.role)
        ),
      );
    const text = (name, value, placeholder) =>
      h("input", {
        type: "text",
        name,
        value: value ?? "",
        placeholder,
        maxlength: "300",
        autocomplete: "off",
      });
    const oathRadio = (value, label) =>
      h(
        "label",
        { class: "draft-radio" },
        h("input", { type: "radio", name: "oath", value, checked: hd.oath === value }),
        label,
      );
    const form = h(
      "form",
      {
        class: "draft-heading-form",
        "aria-labelledby": "heading-title",
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            const f = new FormData(form);
            const body = Object.fromEntries(
              ["fileNumber", "deponent", "applicant", "respondent", "occupation", "address", "oath"]
                .map((k) => [k, String(f.get(k) ?? "").trim() || null]),
            );
            await api("PUT", `/api/drafts/${id}/heading`, body);
            await refresh(() => main.querySelector("#heading-save")?.focus());
            announce("Heading saved. It stays on this computer; Claude never sees it.");
            showToast("Heading saved", { glyph: "check" });
          })();
        },
      },
      h(
        "div",
        { class: "draft-heading-grid" },
        Field({ label: "File number", control: text("fileNumber", hd.fileNumber, "PAC…") }),
        Field({
          label: "Deponent (the person making this affidavit)",
          control: roleSelect("deponent", hd.deponent),
        }),
        Field({ label: "Applicant", control: roleSelect("applicant", hd.applicant) }),
        Field({ label: "Respondent", control: roleSelect("respondent", hd.respondent) }),
        Field({ label: "Occupation", control: text("occupation", hd.occupation, "") }),
        Field({
          label: "Address",
          control: text("address", hd.address, ""),
          hint: "Check whether your address must be shown, or can be withheld for safety.",
        }),
      ),
      h(
        "fieldset",
        { class: "draft-oath" },
        h("legend", {}, "Will you swear or affirm this affidavit?"),
        h(
          "div",
          { class: "hstack" },
          oathRadio("sworn", "Sworn (on oath)"),
          oathRadio("affirmed", "Affirmed"),
        ),
        h("p", { class: "muted" }, "Either is fine. Choose before you sign."),
      ),
      h(
        "div",
        { class: "hstack" },
        h("button", { id: "heading-save", type: "submit", class: "btn btn-lg" }, "Save heading"),
        h(
          "span",
          { class: "muted" },
          "The heading stays on this computer, in the locked part of the case. Claude never sees it.",
        ),
      ),
    );
    return h(
      "section",
      {
        id: "draft-heading",
        class: "draft-block",
        "aria-labelledby": "heading-title",
        tabindex: "-1",
      },
      h(
        "div",
        { class: "draft-block-head" },
        h("h2", { id: "heading-title", class: "eyebrow" }, "Heading"),
        h("span", { class: "draft-checkform" }, CHECK_FORM),
      ),
      h(
        "div",
        { class: "draft-court" },
        h("div", {}, "FEDERAL CIRCUIT AND FAMILY COURT OF AUSTRALIA"),
        h("div", {}, "AFFIDAVIT"),
      ),
      form,
    );
  };

  const oathWords = (hd) =>
    hd?.oath === "affirmed"
      ? "affirm"
      : hd?.oath === "sworn"
      ? "make oath"
      : "[make oath / affirm — choose above]";

  const Opening = (d) => {
    const hd = d.heading ?? {};
    return h(
      "p",
      { class: "draft-ptext draft-opening" },
      `I, ${personName(hd.deponent) ?? "[your full name]"}, of ${hd.address ?? "[address]"}, ${
        hd.occupation ?? "[occupation]"
      }, `,
      h("span", { class: "draft-oathword" }, oathWords(hd)),
      " and say:",
    );
  };

  const Annexures = (d) => {
    const byDoc = new Map();
    for (const p of d.paragraphs) {
      for (const s of p.sources ?? []) {
        if (!byDoc.has(s.doc)) byDoc.set(s.doc, { title: s.docTitle ?? s.doc, paras: [] });
        const e = byDoc.get(s.doc);
        if (!e.paras.includes(p)) e.paras.push(p);
      }
    }
    return h(
      "section",
      {
        id: "draft-annexures",
        class: "draft-block",
        "aria-labelledby": "annex-title",
        tabindex: "-1",
      },
      h(
        "div",
        { class: "draft-block-head" },
        h("h2", { id: "annex-title", class: "section-title" }, "Annexures"),
        h("span", { class: "draft-checkform" }, CHECK_FORM),
      ),
      h(
        "p",
        {},
        "Annexures must be the original documents — the screenshots, letters or PDFs themselves — not retyped text. casefile can’t attach originals yet: attach each original yourself when you file.",
      ),
      byDoc.size
        ? h(
          "div",
          { class: "dtable-wrap" },
          h(
            "table",
            { class: "dtable draft-cites", role: "table" },
            h("caption", { class: "sr" }, "Documents this draft cites"),
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { scope: "col" }, "Document"),
                h("th", { scope: "col" }, "Used in"),
                h("th", { scope: "col" }, h("span", { class: "sr" }, "Actions")),
              ),
            ),
            h(
              "tbody",
              {},
              [...byDoc].map(([doc, e]) =>
                h(
                  "tr",
                  {},
                  h("th", { scope: "row" }, h("span", { class: "mono" }, doc), " · ", e.title),
                  h(
                    "td",
                    {},
                    "Paragraph",
                    e.paras.length > 1 ? "s " : " ",
                    e.paras.map((p, i) => [
                      i ? (i === e.paras.length - 1 ? " and " : ", ") : "",
                      h("button", {
                        type: "button",
                        class: "btn-link",
                        "aria-label": `Go to paragraph ${p.n}`,
                        onclick: () => focusPara(p.id),
                      }, String(p.n)),
                    ]),
                  ),
                  h(
                    "td",
                    {},
                    h(
                      "a",
                      { href: `#/doc/${doc}`, "aria-label": `Open document ${doc}` },
                      "Open document",
                    ),
                  ),
                )
              ),
            ),
          ),
        )
        : h("p", { class: "muted" }, "No paragraph cites a document yet."),
      byDoc.size ? AnnexureMarks() : null,
    );
  };

  // ── annexure marks (W3-1): kept on this computer only, never shown to Claude ──

  /** Marks such as AT-1 for the cited documents; on export a citation becomes "annexure AT-1". */
  const AnnexureMarks = () => {
    const box = h(
      "div",
      { class: "vstack gap-sm draft-marks" },
      h("p", { class: "muted" }, "Loading marks…"),
    );
    const draw = (data, values) => {
      const inputs = new Map();
      const rows = data.docs.filter((x) => x.title !== null).map((x) => {
        const input = h("input", {
          type: "text",
          id: `mark-${x.doc}`,
          value: values[x.doc] ?? "",
          maxlength: "20",
          autocomplete: "off",
          class: "draft-mark-input",
          placeholder: data.suggested[x.doc] ?? "",
        });
        inputs.set(x.doc, input);
        return h(
          "div",
          { class: "draft-mark-row" },
          h("label", { for: input.id }, h("span", { class: "mono" }, x.doc), ` · ${x.title}`),
          input,
        );
      });
      const current = () =>
        Object.fromEntries([...inputs].map(([doc, el]) => [doc, el.value.trim() || null]));
      box.replaceChildren(
        h("h3", { class: "eyebrow" }, "Annexure marks"),
        h(
          "p",
          {},
          `Give each document you will annex a mark such as ${data.prefix}-1. On export, a citation of it becomes “annexure ${data.prefix}-1”. Marks stay on this computer: Claude never sees them.`,
        ),
        ...rows,
        h(
          "div",
          { class: "hstack" },
          h("button", {
            type: "button",
            class: "btn",
            onclick: () => draw(data, { ...data.suggested, ...data.marks }),
          }, `Suggest marks (${data.prefix}-1, ${data.prefix}-2…)`),
          h("button", {
            type: "button",
            class: "btn btn-primary btn-lg", // a primary action: 44 px (spec §7, QA G9)
            id: "marks-save",
            onclick: act(async () => {
              const r = await api("PUT", `/api/drafts/${id}/annexures`, { marks: current() });
              data.marks = r.marks;
              draw(data, r.marks);
              box.querySelector("#marks-save")?.focus();
              const n = Object.keys(r.marks).length;
              announce(n ? `Saved ${plural(n, "annexure mark")}.` : "Annexure marks cleared.");
              showToast(n ? `Saved ${plural(n, "annexure mark")}` : "Marks cleared", {
                glyph: "check",
              });
            }),
          }, "Save marks"),
        ),
      );
    };
    api("GET", `/api/drafts/${id}/annexures`)
      .then((data) => draw(data, data.marks))
      .catch((e) =>
        box.replaceChildren(h("p", { class: "muted" }, `Couldn’t load marks: ${e.message}`))
      );
    return box;
  };

  const Jurat = (d) => {
    const hd = d.heading ?? {};
    const how = hd.oath === "affirmed"
      ? "Affirmed"
      : hd.oath === "sworn"
      ? "Sworn"
      : "Sworn / affirmed";
    const row = (label, value) =>
      h(
        "div",
        { class: "draft-jurat-row" },
        h("span", { class: "muted" }, label),
        h("span", {}, value),
      );
    return h(
      "section",
      { class: "draft-block", "aria-labelledby": "jurat-title" },
      h(
        "div",
        { class: "draft-block-head" },
        h("h2", { id: "jurat-title", class: "section-title" }, "Signing (jurat)"),
        h("span", { class: "draft-checkform" }, CHECK_FORM),
      ),
      h(
        "div",
        { class: "draft-jurat" },
        row(`${how} by the deponent at`, "[place]"),
        row("on", "[date — filled in when you sign]"),
        row("Signature of deponent", ""),
        row("Before me (signature of witness)", ""),
        row(
          "Name and qualification of witness",
          "[who can witness an affidavit — check the Court’s current form]",
        ),
      ),
      h(
        "p",
        { class: "muted" },
        "Sign in front of the witness, on paper or as the Court allows. casefile doesn’t sign or witness anything.",
      ),
    );
  };

  const AddParagraph = () => {
    const ta = h("textarea", { id: "draft-newp", rows: "4" });
    return h(
      "form",
      {
        class: "draft-add vstack gap-sm",
        "aria-label": "Add a paragraph",
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            const text = ta.value.trim();
            if (!text) throw new Error("Write the paragraph first.");
            const r = await api("POST", `/api/drafts/${id}/paragraphs`, { text });
            await refresh(() => focusPara(r.id));
            announce("Paragraph added in your words.");
          })();
        },
      },
      h(
        "label",
        { for: "draft-newp" },
        "Add a paragraph in your own words ",
        h("span", { class: "muted" }, "(real names are fine — Claude sees them replaced)"),
      ),
      ta,
      h("div", {}, h("button", { type: "submit", class: "btn btn-lg" }, "Add paragraph")),
    );
  };

  // ── render: the right column ───────────────────────────────────────────────

  const PanelHead = (title, p) =>
    h(
      "div",
      { class: "hstack between draft-panel-head" },
      h("h2", { id: "ctx-title", tabindex: "-1" }, title),
      h("button", {
        type: "button",
        class: "btn-link",
        "aria-label": `Close paragraph ${p.n} panel`,
        onclick: closePanel,
      }, "Close"),
    );

  const SourcesField = (p) => {
    const input = h("input", {
      type: "text",
      value: st.panel.sources,
      autocomplete: "off",
      oninput: (e) => (st.panel.sources = e.target.value),
    });
    return Field({
      label: "Sources (document lines)",
      control: input,
      hint: `The lines paragraph ${p.n} is based on, like D001:3 or D001:1-2, separated by commas.`,
    });
  };

  const EditPanel = (p) => {
    const ta = h("textarea", {
      id: "panel-text",
      rows: "8",
      oninput: (e) => (st.panel.text = e.target.value),
    }, "");
    ta.value = st.panel.text;
    return h(
      "section",
      { id: "ctx-panel", class: "draft-panel vstack", "aria-labelledby": "ctx-title" },
      PanelHead(`Edit paragraph ${p.n}`, p),
      h("label", { for: "panel-text" }, "Your words"),
      ta,
      SourcesField(p),
      h(
        "div",
        { class: "hstack" },
        h("button", {
          type: "button",
          class: "btn btn-primary btn-lg",
          onclick: act(() => saveText(p)),
        }, "Save"),
        h("button", { type: "button", class: "btn btn-lg", onclick: closePanel }, "Cancel"),
        h("span", { class: "spacer" }),
        h("button", {
          type: "button",
          class: "btn btn-danger",
          "aria-label": `Delete paragraph ${p.n}`,
          onclick: act(() => remove(p)),
        }, "Delete"),
      ),
    );
  };

  const RewritePanel = (p) => {
    const problems = (p.checks ?? []).filter((c) => c.level !== "ok" && c.kind !== "placeholder");
    const tip = p.hasPlaceholder
      ? "Replace the placeholder with what you saw yourself. Claude doesn’t write feelings or opinions for you."
      : problems.length
      ? "casefile found something the sources don’t show (listed below). Say only what you know yourself, and how you know it."
      : "Say only what you know yourself, the way you would say it.";
    const ta = h("textarea", {
      id: "panel-text",
      rows: "8",
      placeholder: "Write it the way you would say it…",
      oninput: (e) => {
        st.panel.text = e.target.value;
        save.disabled = !e.target.value.trim();
      },
    });
    ta.value = st.panel.text;
    const save = h("button", {
      type: "button",
      class: "btn btn-primary btn-lg",
      disabled: !st.panel.text.trim(),
      onclick: act(() => saveText(p)),
    }, "Save my version");
    return h(
      "section",
      { id: "ctx-panel", class: "draft-panel vstack", "aria-labelledby": "ctx-title" },
      PanelHead(`Rewrite paragraph ${p.n} in your own words`, p),
      h(
        "div",
        { class: "vstack gap-sm" },
        h("span", { class: "eyebrow", id: "claude-version" }, "Claude’s version, for reference"),
        h(
          "blockquote",
          { class: "draft-quote", "aria-labelledby": "claude-version" },
          BodyText(segmentsFromText(p.claude_body ?? p.body?.text ?? ""), false),
        ),
      ),
      problems.length
        ? CheckList({
          rows: problems,
          heading: "casefile checked",
          headingLevel: "h3",
          caveat: null,
        })
        : null,
      ExtraCheck({ type: "paragraph", id: p.id, label: `paragraph ${p.n}` }),
      h("p", {}, tip),
      h("label", { for: "panel-text" }, "Your version"),
      ta,
      SourcesField(p),
      h(
        "div",
        { class: "hstack" },
        save,
        h("button", { type: "button", class: "btn btn-lg", onclick: closePanel }, "Cancel"),
      ),
      h(
        "p",
        { class: "muted" },
        "After you save, it shows as “Drafted by Claude — rewritten by you, adopt to confirm”. You then confirm it with “Use these words as my own”.",
      ),
    );
  };

  const AdoptPanel = (p) => {
    const facts = factsOf(p);
    const panel = st.panel;
    const reason = h("p", { id: "adopt-why", class: "draft-why" });
    const adoptBtn = h("button", {
      type: "button",
      class: "btn btn-primary btn-lg",
      "aria-describedby": "adopt-why",
      onclick: act(() => adopt(p, facts)),
    }, "Use as my own");
    const update = () => {
      const left = facts.filter((_, i) => !panel.answers[i]).length;
      const unsure = facts.some((_, i) => panel.answers[i] === "unsure");
      const ticks = (panel.own ? 0 : 1) + (panel.words ? 0 : 1);
      const parts = [];
      if (left) parts.push(`answer ${left} more question${left > 1 ? "s" : ""}`);
      if (ticks) parts.push(`tick ${ticks === 2 ? "both statements" : "1 more statement"}`);
      const ready = !left && !ticks && !unsure;
      reason.textContent = unsure
        ? "You’re not sure about part of it. Use “Rewrite in my own words” to say only what you know, then come back."
        : ready
        ? `Ready. Paragraph ${p.n} will show “Drafted by Claude — adopted”, and the Log will record your answers.`
        : `Not yet: ${parts.join(" and ")} to use these words as your own.`;
      adoptBtn.disabled = !ready;
    };

    const factBlock = (f, i) => {
      const name = `fact-${p.id}-${i}`;
      const hint = h(
        "p",
        { class: "draft-why", hidden: !(panel.answers[i] && panel.answers[i] !== "saw") },
        panel.answers[i] === "unsure"
          ? "If you’re not sure, leave it out or say what you do know."
          : "Say in the paragraph who told you, or what you read — an affidavit should show what you know yourself and what you learned from someone else.",
      );
      return h(
        "fieldset",
        { class: "draft-fact" },
        h("legend", {}, "“", Segments(f.segs, { interactive: false }), "”"),
        f.checks.length
          ? CheckList({
            rows: f.checks,
            heading: null,
            caveat: null,
          })
          : h(
            "p",
            { class: "muted" },
            "casefile found nothing in this sentence it can check against the sources. Only you can say whether it’s right.",
          ),
        h("p", { class: "draft-fact-q", id: `${name}-q` }, "Did you see this yourself or read it?"),
        h(
          "div",
          { class: "draft-fact-opts", role: "radiogroup", "aria-labelledby": `${name}-q` },
          FACT_ANSWERS.map((o) =>
            h(
              "label",
              { class: "draft-radio" },
              h("input", {
                type: "radio",
                name,
                value: o.value,
                checked: panel.answers[i] === o.value,
                onchange: () => {
                  panel.answers[i] = o.value;
                  hint.hidden = o.value === "saw";
                  hint.textContent = o.value === "unsure"
                    ? "If you’re not sure, leave it out or say what you do know."
                    : "Say in the paragraph who told you, or what you read — an affidavit should show what you know yourself and what you learned from someone else.";
                  update();
                },
              }),
              o.label,
            )
          ),
        ),
        hint,
      );
    };

    const tick = (key, label) =>
      h(
        "label",
        { class: "draft-check" },
        h("input", {
          type: "checkbox",
          checked: panel[key],
          onchange: (e) => {
            panel[key] = e.target.checked;
            update();
          },
        }),
        label,
      );

    const reliesList = (p.relies ?? []).length
      ? h(
        "ul",
        { class: "draft-relies" },
        p.relies.map((r) =>
          h(
            "li",
            {},
            Badge("work", r.state, { small: true }),
            h(
              "span",
              {},
              h(
                "a",
                { href: r.type === "chronology" ? "#/chronology" : "#/issues" },
                reliesTitle(r),
              ),
              ": ",
              r.label ?? "",
            ),
          )
        ),
      )
      : null;

    const node = h(
      "section",
      { id: "ctx-panel", class: "draft-panel vstack", "aria-labelledby": "ctx-title" },
      PanelHead(`Use these words as my own — paragraph ${p.n}`, p),
      Badge("para", p.state),
      h("blockquote", { class: "draft-quote" }, BodyText(p.body?.segs, false)),
      ExtraCheck({ type: "paragraph", id: p.id, label: `paragraph ${p.n}` }),
      h(
        "p",
        { class: "muted" },
        p.state === "claude_rewritten"
          ? "Drafted by Claude · rewritten by you · this history stays on the paragraph"
          : "Drafted by Claude · not rewritten · this history stays on the paragraph",
      ),
      h(
        "div",
        { class: "vstack gap-sm" },
        h("h3", {}, "What the sources say"),
        p.sources?.length ? p.sources.map((s) => SourceFigure(s)) : h(
          "p",
          { class: "muted" },
          "This paragraph cites no document lines, so casefile can’t check it. Only you can say whether it’s right.",
        ),
      ),
      reliesList
        ? h("div", { class: "vstack gap-sm" }, h("h3", {}, "What it relies on"), reliesList)
        : null,
      h(
        "div",
        { class: "vstack gap-sm" },
        h("h3", {}, "Fact by fact"),
        facts.map(factBlock),
        h(
          "p",
          { class: "muted small" },
          "casefile’s checks only look for names, dates and numbers. Whether it’s true is for you to say.",
        ),
      ),
      h(
        "fieldset",
        { class: "vstack gap-sm draft-attest" },
        h("legend", {}, "Before you adopt"),
        tick("own", "This is true, and it is from my own knowledge."),
        tick("words", "These are my own words — it is how I would say it."),
      ),
      reason,
      h(
        "div",
        { class: "hstack" },
        adoptBtn,
        h("button", { type: "button", class: "btn btn-lg", onclick: closePanel }, "Cancel"),
      ),
      h(
        "p",
        { class: "muted" },
        "The paragraph keeps its “Drafted by Claude” label, and the Log records your answers. Affidavits must be from your own knowledge and in your own words (the Court’s rules on AI, PD-AI 4.9).",
      ),
    );
    update();
    return node;
  };

  /** The rows of "Before you export": blockers or flags, unknown labels, and reminders. */
  const exportRows = (d) => {
    const ec = d.exportCheck;
    const rows = [];
    const add = (level, text, go) => rows.push({ level, text, go });
    const issues = ec.kind === "affidavit" ? ec.blockers : ec.flags;
    for (const b of issues) {
      const msg = b.reason === "needs_you"
        ? "drafted by Claude — rewrite it, or use it as your own"
        : b.reason === "rewritten"
        ? "rewritten by you — use these words as your own to confirm"
        : b.reason === "placeholder"
        ? "fill in the placeholder in your own words"
        : b.message;
      add(
        b.reason === "fact" ? "danger" : "attention",
        `Paragraph ${b.n}: ${msg}`,
        () => focusPara(b.paragraph),
      );
    }
    for (const t of ec.badTokens ?? []) {
      const n = d.paragraphs.find((p) => p.id === t.paragraph)?.n;
      add(
        "danger",
        `${
          n ? `Paragraph ${n}` : "Title"
        }: casefile doesn’t know the label ${t.token}. Ask Claude to fix it, or rewrite it.`,
        n ? () => focusPara(t.paragraph) : null,
      );
    }
    for (const p of d.paragraphs) {
      for (const r of p.relies ?? []) {
        if (r.state === "checked") continue;
        add(
          "attention",
          `Paragraph ${p.n} relies on a ${reliesTitle(r)} still ${
            r.state === "cant_check" ? "missing" : "To check"
          }`,
          () => focusPara(p.id),
        );
      }
    }
    if (ec.kind === "affidavit") {
      const hd = d.heading ?? {};
      const missing = [];
      if (!hd.oath) missing.push("choose sworn or affirmed");
      const details = [
        [hd.fileNumber, "file number"],
        [hd.deponent, "deponent"],
        [hd.occupation, "occupation"],
        [hd.address, "address"],
      ].filter(([v]) => !v).map(([, w]) => w);
      if (details.length) {
        missing.push(
          `add the ${
            details.length > 1
              ? `${details.slice(0, -1).join(", ")} and ${details.at(-1)}`
              : details[0]
          }`,
        );
      }
      if (missing.length) {
        add("attention", `Heading: ${missing.join(", and ")}`, () => {
          const el = main.querySelector("#draft-heading");
          el?.scrollIntoView({ block: "start" });
          el?.focus();
        });
      }
    }
    if (!(ec.badTokens ?? []).length) {
      add("ok", "casefile checked: every name matches someone in Who’s who", null);
    }
    return rows;
  };

  // ── export dialogs (W3-1): Word, text, Markdown, provenance; the safety confirmation ──

  const EXPORT_MIME = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    rtf: "application/rtf",
    text: "text/plain",
    markdown: "text/markdown",
    provenance: "text/markdown",
  };

  /** Fetch one export and save it. A protected address opens the safety confirmation instead. */
  const doExport = async (format, confirm, confirmSafety = false) => {
    const q = new URLSearchParams();
    if (format !== "provenance") q.set("format", format);
    if (confirm) q.set("confirm", "1");
    if (confirmSafety) q.set("confirmSafety", "1");
    const path = format === "provenance" ? "provenance" : "export";
    const res = await fetch(`/api/drafts/${id}/${path}?${q}`, { credentials: "same-origin" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.safetyConfirm) {
        st.exportSafety = { format, confirm, addresses: body.addresses ?? [] };
        renderSide();
        side.querySelector(".draft-safety")?.focusPrimary?.();
        return;
      }
      throw new ApiError(res.status, body);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
      `draft-${id}.${
        format === "docx" || format === "rtf" ? format : format === "text" ? "txt" : "md"
      }`;
    // A .docx is binary: keep its bytes as they are.
    download(
      name,
      format === "docx" ? await res.arrayBuffer() : await res.text(),
      EXPORT_MIME[format],
    );
    const msg = `Exported ${name}. Check your downloads folder.`;
    announce(msg);
    showToast(msg, { glyph: "check" });
  };

  /** "This export includes a protected address": confirm, or go back and change it. */
  const SafetyConfirm = () => {
    const x = st.exportSafety;
    const people = [...new Set(x.addresses.map((a) => a.person).filter(Boolean))]
      .map((r) => st.people.byRole.get(r)?.forms?.full ?? "someone");
    const who = people.length ? people.join(" and ") : "someone marked safety-sensitive";
    const back = () => {
      st.exportSafety = null;
      renderSide();
      side.querySelector(`[data-export="${x.format}"]`)?.focus();
    };
    // An address, or other details (a phone, an email, a number) linked to that person.
    const onlyAddress = x.addresses.every((a) => !a.kind || a.kind === "address");
    const bar = ConfirmBar({
      title: onlyAddress
        ? "This export includes a protected address"
        : "This export includes protected details",
      summary: onlyAddress
        ? `It includes an address of ${who}, who is marked safety-sensitive. Check before you give this file to anyone — the other side, a lawyer or the Court. To leave it out, change the address in the heading or the paragraph first.`
        : `It includes contact details or an address of ${who}, who is marked safety-sensitive. Check before you give this file to anyone — the other side, a lawyer or the Court. To leave them out, change the heading or the paragraph first.`,
      confirmLabel: onlyAddress ? "Export with the address" : "Export with these details",
      danger: true,
      onConfirm: act(async () => {
        st.exportSafety = null;
        await doExport(x.format, x.confirm, true);
        renderSide();
        side.querySelector(`[data-export="${x.format}"]`)?.focus();
      }),
      onCancel: back,
    });
    bar.classList.add("draft-safety");
    return bar;
  };

  const tryExport = async (format) => {
    const d = st.draft;
    if (d.exportCheck.flags.length && d.exportCheck.kind !== "affidavit") {
      st.exportConfirm = format;
      renderSide();
      side.querySelector(".confirmbar")?.focusPrimary?.();
      return;
    }
    try {
      await doExport(format, false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await refresh();
        showToast(
          e.body?.needsConfirm
            ? "Something changed: check the list before exporting."
            : "Export is blocked: the list shows what to do first.",
          { tone: "danger" },
        );
        return;
      }
      throw e;
    }
  };

  const ExportSection = (d) => {
    const ec = d.exportCheck;
    const affidavit = ec.kind === "affidavit";
    const rows = exportRows(d);
    const blocking = [...new Set(ec.blockers.map((b) => b.n))];
    const disabled = !ec.ready;
    const reason = (ec.badTokens ?? []).length
      ? "Export is blocked until every label is one casefile knows (▲ above)."
      : affidavit && blocking.length
      ? `Export for filing is available once ${paraList(blocking)} ${
        blocking.length > 1 ? "are" : "is"
      } your own words or adopted. The ● items without a paragraph number are reminders; they don’t block export.`
      : affidavit
      ? "Ready to export. The ● items are reminders — check them before you sign."
      : ec.flags.length
      ? `You’ll be asked to confirm the ${plural(ec.flags.length, "flagged item")} when you export.`
      : "Ready to export.";
    const glyph = { ok: "check", attention: "dot", danger: "triangle" };
    const sr = { ok: "Done:", attention: "To do:", danger: "Doesn’t match:" };
    return h(
      "section",
      { class: "vstack draft-export", "aria-labelledby": "exp-title" },
      h("h2", { id: "exp-title", class: "eyebrow" }, "Before you export"),
      h(
        "ul",
        { class: "draft-exp-list" },
        rows.map((r) => {
          const inner = [
            h("span", { class: `check-glyph draft-g--${r.level}` }, Icon(glyph[r.level])),
            h("span", {}, h("span", { class: "sr" }, `${sr[r.level]} `), r.text),
          ];
          return h(
            "li",
            {},
            r.go
              ? h("button", { type: "button", class: "draft-exp-row", onclick: r.go }, inner)
              : h("span", { class: "draft-exp-row" }, inner),
          );
        }),
      ),
      h("p", { id: "exp-why", class: "draft-why" }, reason),
      st.exportConfirm
        ? ConfirmBar({
          title: "Export with flagged items?",
          summary: `${plural(ec.flags.length, "thing")} in this draft ${
            ec.flags.length === 1 ? "is" : "are"
          } Claude’s and not checked by you (listed above). They will be exported as they are.`,
          confirmLabel: "Export anyway",
          onConfirm: act(async () => {
            const f = st.exportConfirm;
            st.exportConfirm = null;
            await doExport(f, true);
            renderSide();
            if (st.exportSafety) side.querySelector(".draft-safety")?.focusPrimary?.();
            else side.querySelector(`[data-export="${f}"]`)?.focus();
          }),
          onCancel: () => {
            st.exportConfirm = null;
            renderSide();
            side.querySelector("[data-export]")?.focus();
          },
        })
        : null,
      st.exportSafety ? SafetyConfirm() : null,
      h(
        "div",
        { class: "hstack" },
        h("button", {
          type: "button",
          class: "btn btn-primary btn-lg",
          disabled,
          "data-export": "docx",
          "aria-describedby": "exp-why",
          onclick: act(() => tryExport("docx")),
        }, "Export for Word (.docx)"),
        h("button", {
          type: "button",
          class: "btn btn-lg",
          disabled,
          "data-export": "rtf",
          "aria-describedby": "exp-why",
          onclick: act(() => tryExport("rtf")),
        }, "Export as .rtf"),
        h("button", {
          type: "button",
          class: "btn btn-lg",
          disabled,
          "data-export": "text",
          "aria-describedby": "exp-why",
          onclick: act(() => tryExport("text")),
        }, "Export as text"),
        h("button", {
          type: "button",
          class: "btn btn-lg",
          disabled,
          "data-export": "markdown",
          "aria-describedby": "exp-why",
          onclick: act(() => tryExport("markdown")),
        }, "Export as Markdown"),
      ),
      h(
        "p",
        { class: "muted" },
        `Exports save to your computer’s downloads, never into the case folder Claude works in. To make a PDF, open the .docx in Word and Save as PDF.${
          affidavit
            ? " Check the layout against the Court’s current affidavit form before you sign."
            : ""
        }`,
      ),
      h(
        "p",
        {},
        h("button", {
          type: "button",
          class: "btn-link",
          "data-export": "provenance",
          onclick: act(() => doExport("provenance", false)),
        }, "Download the provenance report (.md)"),
        h(
          "span",
          { class: "muted" },
          " — whose words each paragraph is, from what casefile recorded. Useful if the Court asks how AI was used.",
        ),
      ),
    );
  };

  const CitationsSection = (d) => {
    const first = d.paragraphs.flatMap((p) => p.sources ?? []).find((s) => s.docTitle);
    return h(
      "section",
      { class: "vstack gap-sm", "aria-labelledby": "conv-title" },
      h("h2", { id: "conv-title", class: "eyebrow" }, "How citations change on export"),
      h(
        "p",
        {},
        "Line references like ",
        h("span", { class: "mono" }, "D002:9"),
        " mean nothing to the Court. On export they become the document’s title and line, or its annexure mark (such as “annexure AT-1”) if you gave it one. A citation of your own earlier affidavit becomes “my affidavit sworn [date], para 4” once you record on that document’s page when you swore or affirmed it.",
      ),
      first
        ? h(
          "p",
          { class: "draft-conv mono" },
          first.ref.replace("-", "–"),
          " → ",
          `${first.docTitle}, ${lineRange(first.lineStart, first.lineEnd)}`,
        )
        : null,
      d.exportCheck.kind === "affidavit"
        ? h("span", { class: "draft-checkform" }, CHECK_FORM)
        : null,
    );
  };

  function renderSide() {
    const d = st.draft;
    const p = st.panel && paraById(st.panel.para);
    const panel = !p
      ? null
      : st.panel.type === "adopt"
      ? AdoptPanel(p)
      : st.panel.type === "rewrite"
      ? RewritePanel(p)
      : EditPanel(p);
    // Escape closes the open panel and returns focus to the button that opened it.
    panel?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePanel();
    });
    side.replaceChildren(
      ...[panel, ExportSection(d), CitationsSection(d), LegalHelp()].filter(Boolean),
    );
  }

  // ── render: the whole screen ───────────────────────────────────────────────

  function render() {
    const d = st.draft;
    const affidavit = d.exportCheck.kind === "affidavit";
    const counts = d.counts ?? {};
    const countBadges = PARA_STATES.filter((s) => counts[COUNT_KEY[s]]).map((s) => {
      const b = Badge("para", s);
      b.querySelector(".badge-text")?.append(` · ${counts[COUNT_KEY[s]]}`);
      return b;
    });

    // Key: everyone named in the paragraphs, with a count; shown only with Highlight people.
    const seen = new Map();
    for (const p of d.paragraphs) {
      for (const s of p.body?.segs ?? []) {
        if (!s.role) continue;
        const e = seen.get(s.role) ?? {
          role: s.role,
          name: personName(s.role) ?? s.t,
          kind: s.kind,
          colour: s.colour,
          count: 0,
        };
        e.count += 1;
        seen.set(s.role, e);
      }
    }

    const article = h(
      "article",
      {
        class: ["draft-doc", "ent-notint", !st.hl && "ent-plain"],
        "aria-label": affidavit ? "Affidavit" : kindWord(d.kind),
      },
      affidavit ? HeadingSection(d) : null,
      affidavit ? Opening(d) : null,
      d.paragraphs.length ? d.paragraphs.map(Paragraph) : h(
        "p",
        { class: "muted" },
        "No paragraphs yet. Add one below, or ask Claude to draft some.",
      ),
      AddParagraph(),
      affidavit ? Annexures(d) : null,
      affidavit ? Jurat(d) : null,
    );

    const colMain = h(
      "div",
      { class: "col-main draft-main" },
      h(
        "div",
        { class: "page-head draft-head" },
        h("h1", {}, d.title ?? "Untitled draft"),
        h(
          "span",
          { class: "muted" },
          `${kindWord(d.kind)} · draft · ${plural(d.paragraphs.length, "paragraph")}`,
        ),
        h("span", { class: "spacer" }),
        Toggle({
          label: "Highlight people",
          pressed: st.hl,
          onChange: (on) => {
            st.hl = on;
            render();
            main.querySelector(".draft-head .toggle")?.focus();
          },
        }),
        h("button", {
          type: "button",
          class: "btn btn-quiet",
          onclick: act(async () => {
            const ok = await confirmDialog(
              `Delete “${d.title}”?`,
              "The draft and its paragraphs are removed. The Log keeps a record that it was deleted.",
              "Delete draft",
              true,
            );
            if (!ok) return;
            await api("DELETE", `/api/drafts/${id}`);
            announce("Draft deleted.");
            ctx.navigate("#/drafts");
          }),
        }, "Delete draft"),
      ),
      h(
        "div",
        { class: "draft-body vstack" },
        d.kindChanged
          ? Callout({
            tone: "danger",
            title: "This draft’s kind was changed outside casefile",
            children:
              "casefile keeps the kind you chose when you made it, and checks it as that kind.",
          })
          : null,
        h(
          "div",
          { class: "draft-counts" },
          countBadges,
          d.factsToCheck
            ? FlagBadge("attention", "dot", `${plural(d.factsToCheck, "fact")} to check`)
            : null,
          h(
            "span",
            { class: "muted" },
            "“Drafted by Claude” stays on a paragraph for good, even after you rewrite or adopt it.",
          ),
        ),
        st.hl && seen.size
          ? Key({
            entries: [...seen.values()],
            help: "Colour shows on screen only — never in the export.",
          })
          : null,
        article,
      ),
    );

    side = h("div", { class: ["draft-side-inner", "ent-notint", !st.hl && "ent-plain"] });
    renderSide();

    const cols = h(
      "div",
      { class: "columns draft-cols" },
      DraftsAside({ drafts: st.drafts, current: id, navigate: ctx.navigate }),
      colMain,
      h("aside", { class: "col-side draft-side", "aria-label": "Paragraph and export" }, side),
    );
    main.replaceChildren(cols);
    if (st.hl) linkEntities(cols);
  }

  await load();
  render();
}
