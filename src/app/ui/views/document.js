// Document view (W2-2; wb/Document.dc.html): one document as you see it, as Claude sees it, or
// side by side, with the key; where it came from (with the impact ConfirmBar), details, what cites
// it, and what Claude did with it through casefile. Also exports the helpers the Documents list
// shares (origin labels, "Cited in" items, dates).
import { append, h } from "../dom.js";
import { action, api, ApiError, errorText, listPeople } from "../lib.js";
import { colourClass, formatDay, tokenText } from "../model.js";
import {
  ActorLabel,
  announce,
  Badge,
  Button,
  Callout,
  ConfirmBar,
  EmptyState,
  ExtraCheck,
  Field,
  Icon,
  Key,
  LinesTable,
  linkEntities,
  openDialog,
  OriginalFile,
  Segmented,
  showToast,
  Tag,
} from "../components/index.js";

// ── shared vocabulary (also used by documents.js) ────────────────────────────

/** Where a document came from: the five answers, as at review (ADR 7), with a hint each. */
export const ORIGINS = [
  { id: "mine", label: "It’s mine (I wrote or received it)", hint: "" },
  { id: "other_side", label: "From the other side", hint: "Given to me in disclosure" },
  {
    id: "court_or_subpoena",
    label: "From a subpoena or the court",
    hint: "Including family reports",
  },
  {
    id: "under_order",
    label: "Under an order or undertaking",
    hint: "For example, a suppression order",
  },
  { id: "not_sure", label: "Not sure", hint: "Treated as restricted until you know" },
];

export const NOT_ASKED = "Not asked yet";

/** "It’s mine (I wrote or received it)", …, or "Not asked yet" for null. */
export function originLabel(origin) {
  return ORIGINS.find((o) => o.id === origin)?.label ?? NOT_ASKED;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A timestamp as a local day: "2 Oct 2025" (short) or "2 October 2025". */
export function day(iso, short = true) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
  return formatDay(ymd, short);
}

/** "2 Oct 2025, 2:14pm" */
export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  const hr = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? "am" : "pm";
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${hr}:${
    String(d.getMinutes()).padStart(2, "0")
  }${ampm}`;
}

/** "1-7" → "lines 1–7", "3" → "line 3", "all" → "all lines". */
export function linesText(lines) {
  const s = String(lines ?? "");
  if (!s || s === "all") return "all lines";
  const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(s);
  if (m) return m[1] === m[2] ? `line ${m[1]}` : `lines ${m[1]}–${m[2]}`;
  return `line ${s}`;
}

/** "line 3" / "lines 1–2" from a source ref. */
function refLines(r) {
  return linesText(
    r.line_end && r.line_end !== r.line_start
      ? `${r.line_start}-${r.line_end}`
      : String(r.line_start),
  );
}

// ── "Cited in": what cites a document, with its state ───────────────────────

const STANCE = {
  supports: "Helps your account",
  undermines: "Points the other way",
  context: "Background",
};

/**
 * /api/docs/:id `citedIn` items (each with its title, label, state and the lines of this document
 * it cites, from casefile) as rows for display:
 * {type, id, href, title, where, badge: [domain, state] | null, removed}.
 */
export function citedItems(_docId, citedIn) {
  const lines = (list) => (list ?? []).map(linesText).join(", ");
  const elsewhere = (list) =>
    list?.length ? ` (and ${list.map((r) => r.replace("-", "–")).join(", ")})` : "";
  return (citedIn ?? []).map((c) => {
    if (c.type === "chronology") {
      return {
        type: c.type,
        id: c.id,
        href: `#/chronology?entry=${c.id}`,
        title: `${c.date ? `${formatDay(c.date, true)} · ` : ""}${c.title ?? ""}`,
        where: `${c.label ?? "Chronology"} · ${lines(c.lines)}${elsewhere(c.others)}`,
        badge: c.state ? ["work", c.state] : null,
        removed: Boolean(c.removed),
      };
    }
    if (c.type === "evidence") {
      return {
        type: c.type,
        id: c.id,
        href: c.issue_id ? `#/issues/${c.issue_id}` : null,
        title: c.title || "An issue",
        where: `${c.label ?? "Evidence"} · ${lines(c.lines)} · ${STANCE[c.stance] ?? "Background"}`,
        badge: c.state ? ["work", c.state] : null,
        removed: Boolean(c.removed),
      };
    }
    if (c.type === "paragraph") {
      return {
        type: c.type,
        id: c.id,
        href: c.draft_id ? `#/draft/${c.draft_id}` : null,
        title: c.title ?? "",
        where: `${c.label ?? "Draft paragraph"}${c.lines?.length ? ` · ${lines(c.lines)}` : ""}`,
        badge: c.state ? ["para", c.state] : null,
        removed: false,
      };
    }
    return {
      type: c.type,
      id: c.id,
      href: null,
      title: c.title ?? "",
      where: c.label ?? "Note",
      badge: null,
      removed: false,
    };
  });
}

/** One "Cited in" row: a link with its place and state. */
export function CitedRow(item) {
  const inner = [
    h("span", { class: "doc-cited-title" }, item.title),
    h(
      "span",
      { class: "doc-cited-meta" },
      h("span", { class: "muted" }, item.where),
      item.removed ? Tag("Removed") : null,
      item.badge ? Badge(item.badge[0], item.badge[1], { small: true }) : null,
    ),
  ];
  return item.href
    ? h("a", { class: "doc-cited", href: item.href }, inner)
    : h("div", { class: "doc-cited" }, inner);
}

// ── "What Claude did through casefile" ───────────────────────────────────────

const SHOWN_WHILE = {
  "cli:chrono_list": "reading the chronology",
  "cli:issue_show": "reading an issue",
  "cli:draft_show": "reading a draft",
  "cli:para_list": "reading a draft’s paragraphs",
  "cli:para_show": "reading a paragraph",
};

/** Lines of `docId` named in a list like detail.hits / detail.cited. */
function linesIn(list, docId) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && x.doc === docId)
    .map((x) => (typeof x.lines === "string" ? x.lines : String(x.line ?? "")))
    .filter(Boolean);
}

/** Ranges such as "D001:1-2" naming this document, as "lines 1–2". */
function sourcesFor(list, docId) {
  return (Array.isArray(list) ? list : [list])
    .filter((s) => typeof s === "string" && s.startsWith(`${docId}:`))
    .map((s) => linesText(s.slice(docId.length + 1)));
}

/** A Claude log row about this document, as words after "Claude …". */
export function describeClaude(row, docId) {
  const d = row.detail ?? {};
  switch (row.action) {
    case "cli:docs_show":
      return d.lines === "" ? "opened it, but no lines were shown" : `read ${linesText(d.lines)}`;
    case "cli:search": {
      const l = linesIn(d.hits, docId);
      return `searched the documents and was shown ${l.length === 1 ? "line" : "lines"} ${
        l.join(", ")
      }`;
    }
    case "cli:docs_meta":
      return "set its type or date";
    case "cli:tag_add":
      return "tagged it";
    case "cli:tag_rm":
      return "removed a tag from it";
    case "cli:chrono_add":
    case "cli:chrono_edit": {
      const l = sourcesFor(d.sources, docId);
      const verb = row.action === "cli:chrono_add" ? "added" : "changed";
      return `${verb} a chronology entry${l.length ? ` citing ${l.join(", ")}` : ""}`;
    }
    case "cli:evidence_add": {
      const l = sourcesFor(d.source, docId);
      return `linked ${l.join(", ") || "lines"} to an issue`;
    }
    case "cli:note_add":
      return "added a note about it";
    default: {
      const l = linesIn(d.cited, docId);
      if (l.length) {
        return `was shown ${l.map(linesText).join(", ")} while ${
          SHOWN_WHILE[row.action] ?? "using casefile"
        }`;
      }
      return row.action.replace(/^cli:/, "").replace(/_/g, " ");
    }
  }
}

/** Claude's log rows for a document (casefile matches every row that names it). */
function claudeActivity(doc) {
  return (doc.activity ?? []).filter((r) => r.actor === "claude").sort((a, b) => a.id - b.id);
}

// ── the view ─────────────────────────────────────────────────────────────────

/** The text view, kept while moving between documents. */
let mode = "real";

/** @param {HTMLElement} main @param {{id: string, line?: string}} params @param {object} ctx */
export default async function view(main, params, ctx) {
  const id = params.id;
  const focusLine = params.line ? Number(params.line) : null;

  let doc;
  try {
    doc = await api("GET", `/api/docs/${id}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
      main.replaceChildren(
        h("div", { class: "page-head" }, h("h1", {}, `No document ${id}`)),
        h(
          "div",
          { class: "page-body" },
          EmptyState({
            message: `There is no document ${id} in this case.`,
            action: h("a", { class: "btn", href: "#/docs" }, "Go to Documents"),
          }),
        ),
      );
      return;
    }
    throw e;
  }
  const entities = await listPeople().catch(() => []);
  const cited = citedItems(doc.id, doc.citedIn);
  const activity = claudeActivity(doc);

  const rerender = async (focusSel) => {
    await view(main, params, ctx);
    ctx.refreshCounts?.();
    if (focusSel) main.querySelector(focusSel)?.focus();
  };

  const published = doc.status === "published";
  const shared = doc.state === "shared";
  const confirmSlot = h("div", { class: "doc-confirm" });
  const live = h("div", { class: "sr", role: "status" });

  // ── head ──
  const head = h(
    "div",
    { class: "page-head doc-head" },
    h(
      "nav",
      { class: "doc-crumb", "aria-label": "Breadcrumb" },
      h("a", { href: "#/docs" }, "Documents"),
      h("span", { "aria-hidden": "true" }, "/"),
      h("span", { class: "mono", "aria-current": "page" }, doc.id),
    ),
    h("h1", {}, doc.title),
    Badge("doc", doc.state),
    h("span", { class: "spacer" }),
  );

  let textWrap = null;
  let table = null;
  if (published) {
    textWrap = h("div", { class: "doc-text" });
    const renderText = () => {
      table = LinesTable({
        caption: mode === "side"
          ? `${doc.id} side by side: what you see and what Claude sees, line by line`
          : mode === "token"
          ? `${doc.id} as Claude sees it, line by line`
          : `${doc.id} as you see it, line by line`,
        lines: doc.lines,
        mode,
        highlight: focusLine ? { start: focusLine } : null,
      });
      textWrap.replaceChildren(table);
    };
    renderText();
    append(head, [
      Segmented({
        label: "View",
        options: [
          { id: "real", label: "You see" },
          { id: "token", label: "Claude sees" },
          { id: "side", label: "Side by side" },
        ],
        value: mode,
        onChange: (m) => {
          mode = m;
          renderText();
          finder?.refresh();
        },
      }),
      Button("Link selected lines…", {
        onclick: action(async () => {
          if (await linkLines(doc, selectedLines(table))) await rerender(`#cited-h-${doc.id}`);
        }),
        disabled: !shared,
        "aria-describedby": shared ? null : `${doc.id}-link-why`,
      }),
      shared ? null : h(
        "span",
        { id: `${doc.id}-link-why`, class: "sr" },
        "Only documents shared with Claude can be cited as evidence.",
      ),
      doc.state === "exposed" ? null : Button("Review again", {
        onclick: () => reviewAgain(doc, confirmSlot, ctx),
      }),
    ]);
  } else {
    head.append(
      h("a", { class: "btn btn-primary btn-lg", href: `#/review/${doc.id}` }, `Review ${doc.id}`),
    );
  }

  // ── callouts ──
  const callouts = h("div", { class: "doc-callouts" });
  if (doc.state === "exposed") {
    callouts.append(Callout({
      tone: "danger",
      title: "Exposed — re-check",
      children: [
        h(
          "p",
          {},
          `${doc.id} shows a name or number you added to People after sharing it, so casefile withdrew it from Claude. Claude can’t read it again until you re-check it and share it.`,
        ),
        h(
          "div",
          { class: "hstack" },
          Button(`Re-check ${doc.id}`, {
            variant: "primary",
            onclick: action(async () => {
              const r = await api("POST", "/api/docs/recheck", { docs: [doc.id] });
              const res = r.results[0];
              if (res?.state === "needs_review") {
                announce(`${doc.id} needs review. Opening it.`);
                ctx.navigate(`#/review/${doc.id}`);
                return;
              }
              showToast(`${doc.id} checked again: ${stateWords(res?.state)}.`);
              await rerender("h1");
            }),
          }),
          h("a", { href: "#/docs" }, "See the details on Documents"),
        ),
      ],
    }));
  }

  // ── key ──
  let key = null;
  if (published) {
    const counts = new Map();
    for (const l of doc.lines) {
      for (const s of l.segs ?? []) {
        if (!s.role) continue;
        const c = counts.get(s.role) ?? { role: s.role, kind: s.kind, colour: s.colour, count: 0 };
        c.count++;
        counts.set(s.role, c);
      }
    }
    const nameOf = (role) => entities.find((e) => e.role === role)?.forms?.full ?? `{{${role}}}`;
    const entries = [...counts.values()]
      .sort((a, b) => (a.colour ?? 99) - (b.colour ?? 99) || b.count - a.count)
      .map((c) => ({ ...c, name: nameOf(c.role) }));
    if (entries.length) key = h("div", { class: "doc-key" }, Key({ entries }));
  }

  // ── main column ──
  const mainCol = h("div", { class: "col-main doc-main" });
  if (published) mainCol.append(textWrap);
  else {
    mainCol.append(EmptyState({
      title: `${doc.id} hasn’t been reviewed yet`,
      message:
        "Claude can’t see it. Review the names and numbers casefile found, say where it came from, then share it with Claude or keep it withheld.",
      action: h("a", { class: "btn", href: `#/review/${doc.id}` }, `Review ${doc.id}`),
    }));
  }

  // ── side panel ──
  const side = h(
    "aside",
    { class: "col-side doc-side", "aria-label": "About this document" },
    OriginSection(doc, ctx, rerender),
    published ? DetailsSection(doc, rerender, entities) : null,
    CitedSection(doc, cited),
    ActivitySection(doc, activity),
  );

  // ── jump between one person's mentions, and rename their label ──
  const finder = published && key
    ? KeyFinder({ entities, textWrap, rerender, keys: ctx?.shortcuts !== false })
    : null;

  const body = h(
    "div",
    { class: "doc-body" },
    key,
    h("div", { class: "columns doc-columns" }, mainCol, side),
    finder?.bar,
  );
  main.replaceChildren(
    ...[head, OriginalFile(doc.id, doc.file), confirmSlot, callouts, body, live].filter(Boolean),
  );
  const linker = linkEntities(body, { onPin: (role, el) => finder?.pinned(role, el) });
  finder?.connect(linker);

  if (focusLine) main.querySelector(`#line-${focusLine}`)?.scrollIntoView({ block: "center" });
}

// ── key finder: Previous / Next through one entry's mentions, and Rename ──────

/**
 * The bar shown while a key entry (or a name in the text) is pinned: "Mother · 3 of 12 · line
 * 40", Previous / Next (also the n and p keys, unless shortcuts are off in Settings), Rename its
 * label everywhere, and Done.
 */
function KeyFinder({ entities, textWrap, rerender, keys }) {
  let role = null;
  let at = -1;
  let linker = null;
  let quiet = false;
  const label = h("span", { class: "doc-finder-label" });
  const pos = h("span", { class: "doc-finder-pos num", "aria-live": "polite" });
  const prev = Button("Previous", {
    onclick: () => step(-1),
    "aria-keyshortcuts": keys ? "p" : null,
    title: keys ? "Previous mention (p)" : null,
  });
  const next = Button("Next", {
    onclick: () => step(1),
    "aria-keyshortcuts": keys ? "n" : null,
    title: keys ? "Next mention (n)" : null,
  });
  const rename = Button("Rename…", { onclick: () => renameRole() });
  const done = Button("Done", { onclick: () => linker?.clear() });
  const bar = h(
    "div",
    { class: "doc-finder", role: "region", "aria-label": "Mentions", hidden: true },
    label,
    pos,
    h("span", { class: "spacer" }),
    prev,
    next,
    rename,
    done,
  );

  const entityOf = (r) => entities.find((e) => e.role === r);
  const nameOf = (r) => entityOf(r)?.forms?.full ?? tokenText(r);
  // One mark per mention: the "You see" column, or the "Claude sees" column on its own.
  const marks = () =>
    role
      ? [...textWrap.querySelectorAll(
        `${mode === "token" ? ".lines-claude" : ".lines-real"} [data-role="${CSS.escape(role)}"]`,
      )]
      : [];

  const show = (scroll) => {
    for (const el of textWrap.querySelectorAll(".is-current")) el.classList.remove("is-current");
    const all = marks();
    if (!role || !all.length) {
      pos.textContent = role ? "Not in this view" : "";
      prev.disabled = next.disabled = true;
      return;
    }
    prev.disabled = next.disabled = all.length < 2 && at >= 0;
    if (at < 0) {
      pos.textContent = `${all.length} ${all.length === 1 ? "mention" : "mentions"}`;
      return;
    }
    const el = all[at];
    el.classList.add("is-current");
    const line = el.closest("tr[id^='line-']")?.id.slice(5);
    pos.textContent = `${at + 1} of ${all.length}${line ? ` · line ${line}` : ""}`;
    if (scroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const step = (d) => {
    const all = marks();
    if (!all.length) return;
    at = at < 0 ? (d > 0 ? 0 : all.length - 1) : (at + d + all.length) % all.length;
    show(true);
  };

  const renameRole = async () => {
    if (!role) return;
    const from = role;
    const e = entityOf(from);
    const input = h("input", {
      type: "text",
      value: from,
      spellcheck: "false",
      autocomplete: "off",
      class: "mono",
    });
    const err = h("p", { class: "people-error", role: "alert" });
    const submit = async () => {
      const to = input.value.trim();
      if (!to || to === from) return false;
      await api("PATCH", `/api/entities/${encodeURIComponent(from)}`, { role: to });
      return to;
    };
    for (;;) {
      const go = openDialog({
        title: `Rename ${tokenText(from)}`,
        body: [
          h(
            "p",
            {},
            `What Claude sees instead of ${
              e?.forms?.full ?? "this"
            }. A relationship, never a name. Renaming updates every document, note and draft, and anything you checked that mentions ${
              e?.forms?.full ?? "it"
            } goes back to To check.`,
          ),
          Field({ label: "Label Claude sees", control: input }),
          err,
        ],
        actions: [
          { label: "Cancel", value: null },
          { label: "Rename everywhere", value: true, variant: "primary" },
        ],
      });
      queueMicrotask(() => {
        input.focus();
        input.select();
        input.onkeydown = (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            input.closest("dialog")?.querySelector(".btn-primary")?.click();
          }
        };
      });
      if ((await go) !== true) return;
      try {
        const to = await submit();
        if (!to) return;
        const msg = `Renamed ${tokenText(from)} to ${tokenText(to)} everywhere.`;
        announce(msg);
        showToast(msg, {
          undo: async () => {
            try {
              await api("PATCH", `/api/entities/${encodeURIComponent(to)}`, { role: from });
              announce(`Renamed back to ${tokenText(from)}.`);
              pendingPin = from;
              await rerender();
            } catch (x) {
              showToast(errorText(x), { tone: "danger" });
            }
          },
        });
        pendingPin = to;
        await rerender();
        return;
      } catch (x) {
        err.textContent = errorText(x);
      }
    }
  };

  const onKey = (ev) => {
    if (!keys || bar.hidden || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t instanceof Element && t.closest("input, textarea, select, [contenteditable], dialog")) {
      return;
    }
    if (ev.key === "n" || ev.key === "p") {
      ev.preventDefault();
      step(ev.key === "n" ? 1 : -1);
    }
  };
  document.addEventListener("keydown", onKey);

  return {
    bar,
    connect(l) {
      linker = l;
      // Rerendered after a rename: keep the renamed entry pinned.
      if (pendingPin && textWrap.isConnected) {
        const r = pendingPin;
        pendingPin = null;
        l.pin(r);
      }
      // The listener goes when the page does.
      const gone = new MutationObserver(() => {
        if (!bar.isConnected) {
          document.removeEventListener("keydown", onKey);
          gone.disconnect();
        }
      });
      gone.observe(document.body, { childList: true, subtree: true });
    },
    /** The linker pinned `r` (null: cleared), by clicking `el`. */
    pinned(r, el) {
      role = r;
      bar.hidden = !r;
      if (!r) {
        show(false);
        return;
      }
      label.replaceChildren(
        h("strong", {}, nameOf(r)),
        " ",
        h("span", { class: `token ${colourClass(entityOf(r) ?? {})}` }, tokenText(r)),
      );
      rename.setAttribute("aria-label", `Rename ${tokenText(r)} everywhere`);
      const all = marks();
      // A name clicked in the text starts there; a key entry jumps to the first mention.
      const i = el ? all.indexOf(el) : -1;
      at = i >= 0 ? i : all.length ? 0 : -1;
      show(i < 0 && !quiet);
    },
    /** The view changed (You see / Claude sees / Side by side): the same mention, highlighted. */
    refresh() {
      if (!role || !linker) return;
      const keep = at;
      quiet = true;
      linker.pin(role);
      quiet = false;
      at = Math.min(keep, marks().length - 1);
      show(true);
    },
  };
}

/** A role to pin again once the page is rebuilt after a rename. */
let pendingPin = null;

function stateWords(state) {
  return {
    shared: "it is shared with Claude",
    withheld: "it stays withheld from Claude",
    needs_review: "it needs review",
    exposed: "it still shows a known name or number",
  }[state] ?? "done";
}

// ── where it came from ───────────────────────────────────────────────────────

function planWords(settings) {
  const commercial = settings?.claudeSetup === "commercial";
  const recorded = Boolean(settings?.plan);
  const plan = commercial ? "a commercial plan" : "a consumer plan";
  const as = recorded ? "as you recorded it" : "you haven’t recorded your plan in Settings yet";
  return { commercial, text: `${plan}, ${as}` };
}

function OriginSection(doc, ctx, rerender) {
  const confirmSlot = h("div", { class: "doc-origin-confirm" });
  const hid = `origin-h-${doc.id}`;
  const plan = planWords(ctx.settings);
  const groupName = `origin-${doc.id}`;
  const radios = ORIGINS.map((o) =>
    h(
      "label",
      { class: "doc-origin" },
      h("input", {
        type: "radio",
        name: groupName,
        value: o.id,
        checked: doc.origin === o.id,
        onchange: (e) => choose(e.target.value),
      }),
      h(
        "span",
        { class: "vstack doc-origin-text" },
        h("span", {}, o.label),
        o.hint ? h("span", { class: "muted small" }, o.hint) : null,
      ),
    )
  );
  const reset = () => {
    for (const r of radios) {
      const input = r.querySelector("input");
      input.checked = input.value === doc.origin;
    }
  };

  const apply = async (next) => {
    const prev = doc.origin;
    const r = await api("PUT", `/api/docs/${doc.id}/origin`, { origin: next });
    const msg = r.withdrawn
      ? `${doc.id} withdrawn from Claude. Claude’s earlier work stays.`
      : `Changed to “${originLabel(next)}”: ${stateWords(r.state)}.`;
    announce(msg);
    showToast(msg, {
      undo: async () => {
        await api("PUT", `/api/docs/${doc.id}/origin`, { origin: prev });
        announce(`${doc.id} is back to “${originLabel(prev)}”.`);
        await rerender(`input[name="${groupName}"]:checked`);
      },
    });
    await rerender(`input[name="${groupName}"]:checked`);
  };

  const choose = async (next) => {
    confirmSlot.replaceChildren();
    if (next === doc.origin) return;
    try {
      const impact = await api(
        "GET",
        `/api/docs/${doc.id}/origin-impact?origin=${encodeURIComponent(next)}`,
      );
      if (!impact.withdraw) {
        await apply(next);
        return;
      }
      const bar = OriginConfirm(doc, next, impact, {
        onConfirm: action(() => apply(next)),
        onCancel: () => {
          confirmSlot.replaceChildren();
          reset();
          announce("Not changed.");
          radios.map((r) => r.querySelector("input")).find((i) => i.checked)?.focus();
        },
      });
      confirmSlot.replaceChildren(bar);
      bar.focusPrimary();
    } catch (e) {
      reset();
      showToast(e.message ?? String(e), { tone: "danger" });
    }
  };

  const canShare = plan.commercial && doc.state === "withheld" &&
    (doc.origin === "other_side" || doc.origin === "court_or_subpoena");

  return h(
    "section",
    { class: "doc-section", "aria-labelledby": hid },
    h("h2", { id: hid, class: "doc-section-title" }, "Where it came from"),
    doc.originHint && doc.origin === null
      ? Callout({
        tone: "info",
        title: `Suggestion: ${originLabel(doc.originHint.origin)}`,
        children: `${doc.originHint.reason} (line ${doc.originHint.line}). You decide.`,
      })
      : null,
    h(
      "fieldset",
      { class: "vstack gap-sm" },
      h("legend", { class: "sr" }, `Where did you get ${doc.id}?`),
      doc.origin === null
        ? h(
          "p",
          { class: "doc-notasked" },
          Icon("dot"),
          ` ${NOT_ASKED}: withheld from Claude until you answer.`,
        )
        : null,
      radios,
    ),
    // A second opinion on where a shared document came from (ADR 14): flags only.
    doc.state === "shared"
      ? ExtraCheck({ type: "document", id: doc.id, label: `where ${doc.id} came from` })
      : null,
    h(
      "p",
      { class: "doc-guidance" },
      plan.commercial
        ? `On your plan (${plan.text}), documents from the other side or from a subpoena or the court are shared only when you share each one. Anything under an order or undertaking, and anything marked “Not sure”, is always withheld under the Court’s rules on AI (PD-AI 5.5).`
        : `Anything except “It’s mine” is withheld from Claude on your plan (${plan.text}), under the Court’s rules on AI (PD-AI 5.5). “Not sure” is treated the same way.`,
    ),
    confirmSlot,
    canShare
      ? Button(`Share ${doc.id} with Claude`, {
        onclick: () => {
          const bar = ConfirmBar({
            title: `Share ${doc.id} with Claude?`,
            summary:
              `Claude will be able to read and search ${doc.id} through casefile, with names replaced.`,
            detail:
              "You recorded a commercial plan with no-training terms. You can change where it came from later to withdraw it.",
            confirmLabel: `Share ${doc.id} with Claude`,
            onConfirm: action(async () => {
              await api("POST", `/api/docs/${doc.id}/share`);
              announce(`${doc.id} shared with Claude.`);
              showToast(`${doc.id} shared with Claude.`);
              await rerender("h1");
            }),
            onCancel: () => confirmSlot.replaceChildren(),
          });
          confirmSlot.replaceChildren(bar);
          bar.focusPrimary();
        },
      })
      : null,
  );
}

/** The impact ConfirmBar for an origin change that withdraws documents from Claude. */
export function OriginConfirm(doc, next, impact, { onConfirm, onCancel, title }) {
  const c = impact.citedBy ?? {};
  const counts = [
    [c.chronology?.length ?? 0, "chronology entry", "chronology entries"],
    [c.evidence?.length ?? 0, "evidence link", "evidence links"],
    [c.paragraphs?.length ?? 0, "draft paragraph", "draft paragraphs"],
    [c.notes?.length ?? 0, "note", "notes"],
  ].filter(([n]) => n > 0);
  const reads = impact.claudeReads ?? [];
  return ConfirmBar({
    title: title ?? `Change ${doc.id} to “${originLabel(next)}”?`,
    summary:
      `casefile will withdraw ${doc.id} from Claude straight away. Claude won’t be able to read or search ${
        doc.many ? "them" : "it"
      } through casefile.`,
    detail: [
      counts.length
        ? [
          h(
            "p",
            {},
            `Claude’s earlier work from ${
              doc.many ? "them" : doc.id
            } stays in your case. Nothing is deleted, and you can review or remove it yourself:`,
          ),
          h(
            "ul",
            { class: "doc-impact" },
            counts.map(([n, one, many]) =>
              h("li", {}, h("span", { class: "num" }, String(n)), ` ${n === 1 ? one : many}`)
            ),
          ),
        ]
        : h("p", {}, `Nothing in your case cites ${doc.many ? "them" : doc.id}.`),
      h(
        "p",
        {},
        reads.length
          ? `The log shows Claude read ${
            reads.map((r) => `${linesText(r.lines)} on ${day(r.ts, false)}`).join(", ")
          }. Withdrawing stops further reading; it can’t undo what was already read.`
          : `The log shows no reads of ${doc.many ? "them" : doc.id} by Claude through casefile.`,
      ),
      h(
        "p",
        {},
        "Claude loses its type, date and tags too, because they describe the document. casefile keeps them for you, and Undo brings them back.",
      ),
    ],
    confirmLabel: `Withdraw ${doc.id} from Claude`,
    danger: true,
    onConfirm,
    onCancel,
  });
}

// ── details ──────────────────────────────────────────────────────────────────

function DetailsSection(doc, rerender, entities = []) {
  const hid = `details-h-${doc.id}`;
  const m = doc.meta ?? {};
  // Who wrote it, as the user says: kept in casefile's locked store, where Claude can't change it.
  const people = entities.filter((e) => e.kind === "person");
  const wroteId = `doc-wrote-${doc.id}`;
  const wrote = h(
    "select",
    {
      id: wroteId,
      onchange: action(async () => {
        const role = wrote.value || null;
        await api("PUT", `/api/docs/${doc.id}/author`, { role });
        const who = people.find((p) => p.role === role);
        const msg = who
          ? `Saved: ${who.forms?.full ?? role} wrote ${doc.id}.`
          : "Saved: not recorded.";
        announce(msg);
        showToast(msg);
        await rerender(`#${wroteId}`);
      }),
    },
    h("option", { value: "", selected: !doc.author }, "Not recorded"),
    people.map((p) =>
      h("option", { value: p.role, selected: doc.author === p.role }, p.forms?.full ?? p.role)
    ),
  );
  // An affidavit the user swore or affirmed earlier (vault only): exports cite it as "my
  // affidavit sworn 2 April 2025, para 4".
  const affId = `doc-affidavit-${doc.id}`;
  const oath = h(
    "select",
    { id: affId },
    h("option", { value: "", selected: !doc.affidavit }, "No"),
    h("option", { value: "sworn", selected: doc.affidavit?.oath === "sworn" }, "Yes, sworn"),
    h(
      "option",
      { value: "affirmed", selected: doc.affidavit?.oath === "affirmed" },
      "Yes, affirmed",
    ),
  );
  const oathDate = h("input", {
    type: "date",
    id: `${affId}-date`,
    value: doc.affidavit?.date ?? "",
  });
  const saveAffidavit = Button("Save affidavit details", {
    onclick: action(async () => {
      if (oath.value && !oathDate.value) {
        announce("Choose the date you swore or affirmed it.");
        showToast("Choose the date you swore or affirmed it.", { tone: "danger" });
        oathDate.focus();
        return;
      }
      await api(
        "PUT",
        `/api/docs/${doc.id}/affidavit`,
        oath.value ? { oath: oath.value, date: oathDate.value } : { affidavit: null },
      );
      const msg = oath.value
        ? `Saved: exports cite ${doc.id} as your affidavit ${oath.value} on that date.`
        : `Saved: ${doc.id} is not one of your affidavits.`;
      announce(msg);
      showToast(msg);
      await rerender(`#${affId}`);
    }),
  });
  const type = h("input", { type: "text", value: m.doc_type ?? "", autocomplete: "off" });
  const date = h("input", { type: "date", value: m.doc_date ?? "" });
  const author = h("input", { type: "text", value: m.author_role ?? "", autocomplete: "off" });
  const save = Button("Save details", {
    onclick: action(async () => {
      const changed = [];
      if (type.value !== (m.doc_type ?? "")) changed.push("doc_type");
      if (date.value !== (m.doc_date ?? "")) changed.push("doc_date");
      if (author.value !== (m.author_role ?? "")) changed.push("author_role");
      if (!changed.length) {
        announce("Nothing changed.");
        return;
      }
      await api("PUT", `/api/docs/${doc.id}/meta`, {
        doc_type: type.value,
        doc_date: date.value,
        author_role: author.value,
        changed,
      });
      announce("Details saved.");
      showToast("Details saved. Names you typed are replaced before Claude sees them.");
      await rerender(`#${hid}`);
    }),
  });

  const tagInput = h("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Add a tag",
    "aria-label": `Add a tag to ${doc.id}`,
  });
  const addTag = action(async () => {
    const tag = tagInput.value.trim();
    if (!tag) return;
    await api("POST", `/api/docs/${doc.id}/tags`, { tag });
    announce(`Tagged ${doc.id} “${tag}”.`);
    await rerender(`#${hid}`);
  });

  return h(
    "section",
    { class: "doc-section", "aria-labelledby": hid },
    h("h2", { id: hid, class: "doc-section-title", tabindex: "-1" }, "Details"),
    m.meta_by === "claude"
      ? h(
        "p",
        { class: "muted small" },
        "Claude filled these in. Once you change them, Claude can’t change them again.",
      )
      : null,
    doc.detailsHeld
      ? h(
        "p",
        { class: "muted small" },
        "Claude can’t see these while the document is withheld. casefile keeps them, and Claude gets them back if you share it again.",
      )
      : null,
    h(
      "div",
      { class: "doc-details" },
      Field({ label: "Type", control: type }),
      Field({ label: "Date", control: date }),
      Field({
        label: "Author",
        control: author,
        hint: "Names you type here are replaced before Claude sees them.",
      }),
    ),
    Field({
      label: "Who wrote it",
      control: wrote,
      hint:
        "Only you can set this; Claude can’t. If you wrote it, casefile flags Claude’s work whose only source is your own statement.",
    }),
    h("div", { class: "hstack" }, save),
    doc.origin === "mine"
      ? h(
        "div",
        { class: "vstack gap-sm" },
        h(
          "div",
          { class: "doc-details" },
          Field({ label: "Is this an affidavit you swore or affirmed?", control: oath }),
          Field({ label: "On", control: oathDate }),
        ),
        h(
          "p",
          { class: "muted small" },
          "Only you can set this; Claude can’t. When “Who wrote it” is you, exports cite it as “my affidavit sworn [date], para 4” instead of its title and line.",
        ),
        h("div", { class: "hstack" }, saveAffidavit),
      )
      : null,
    h(
      "div",
      { class: "vstack gap-sm" },
      h("h3", { class: "doc-subtitle" }, "Tags"),
      doc.tags?.length
        ? h(
          "ul",
          { class: "doc-tags" },
          doc.tags.map((t) =>
            h(
              "li",
              {},
              Tag(t),
              h("button", {
                type: "button",
                class: "btn-link doc-tag-rm",
                "aria-label": `Remove tag ${t} from ${doc.id}`,
                onclick: action(async () => {
                  await api("DELETE", `/api/docs/${doc.id}/tags/${encodeURIComponent(t)}`);
                  announce(`Removed tag “${t}”.`);
                  await rerender(`#${hid}`);
                }),
              }, "Remove"),
            )
          ),
        )
        : h("p", { class: "muted small" }, "No tags."),
      h(
        "form",
        {
          class: "hstack",
          onsubmit: (e) => {
            e.preventDefault();
            addTag(e);
          },
        },
        tagInput,
        h("button", { type: "submit", class: "btn" }, "Add tag"),
      ),
    ),
  );
}

// ── cited in ─────────────────────────────────────────────────────────────────

function CitedSection(doc, cited) {
  const hid = `cited-h-${doc.id}`;
  return h(
    "section",
    { class: "doc-section", "aria-labelledby": hid },
    h("h2", { id: hid, class: "doc-section-title", tabindex: "-1" }, "Cited in"),
    cited.length
      ? h("ul", { class: "doc-cited-list" }, cited.map((c) => h("li", {}, CitedRow(c))))
      : h("p", { class: "muted" }, `Nothing in your case cites ${doc.id} yet.`),
  );
}

// ── what Claude did ──────────────────────────────────────────────────────────

function ActivitySection(doc, rows) {
  const hid = `did-h-${doc.id}`;
  return h(
    "section",
    { class: "doc-section", "aria-labelledby": hid },
    h("h2", { id: hid, class: "doc-section-title" }, "What Claude did through casefile"),
    rows.length
      ? h(
        "ul",
        { class: "doc-activity" },
        rows.map((r) =>
          h(
            "li",
            {},
            h("span", { class: "muted small nowrap" }, when(r.ts)),
            h("span", {}, ActorLabel("claude"), " ", describeClaude(r, doc.id)),
          )
        ),
      )
      : h("p", { class: "muted" }, `Claude hasn’t read or used ${doc.id} through casefile.`),
    h(
      "p",
      { class: "small" },
      "This lists only commands Claude ran through casefile. If Claude opens files or runs commands another way, casefile doesn’t record them.",
    ),
    h("a", { href: "#/log" }, "Open the full log"),
  );
}

// ── review again ─────────────────────────────────────────────────────────────

function reviewAgain(doc, slot, ctx) {
  const shared = doc.state === "shared";
  const bar = ConfirmBar({
    title: `Review ${doc.id} again?`,
    summary: shared
      ? `casefile will withdraw ${doc.id} from Claude while you review it. Claude can’t read or search it until you share it again.`
      : `${doc.id} is withheld from Claude, so nothing changes for Claude while you review it.`,
    detail:
      "Your earlier decisions are filled in, so only anything new needs you. Claude’s earlier work from it stays in your case.",
    confirmLabel: shared ? `Withdraw and review ${doc.id}` : `Review ${doc.id}`,
    danger: shared,
    onConfirm: action(async () => {
      await api("POST", `/api/docs/${doc.id}/reopen`);
      announce(`${doc.id} is open for review.`);
      ctx.refreshCounts?.();
      ctx.navigate(`#/review/${doc.id}`);
    }),
    onCancel: () => slot.replaceChildren(),
  });
  slot.replaceChildren(bar);
  bar.focusPrimary();
}

// ── link selected lines to an issue ──────────────────────────────────────────

/** The line range the user selected in the text, or null. */
function selectedLines(table) {
  const sel = globalThis.getSelection?.();
  if (!table || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const rowOf = (n) => {
    const el = n instanceof Element ? n : n?.parentElement;
    const tr = el?.closest?.("tr[id^='line-']");
    return tr && table.contains(tr) ? Number(tr.id.slice(5)) : null;
  };
  const a = rowOf(sel.anchorNode);
  const b = rowOf(sel.focusNode);
  if (a === null && b === null) return null;
  const x = a ?? b;
  const y = b ?? a;
  return { start: Math.min(x, y), end: Math.max(x, y) };
}

async function linkLines(doc, range) {
  const issues = await api("GET", "/api/issues");
  const max = doc.lines.length;
  if (!issues.length) {
    await openDialog({
      title: "Link lines to an issue",
      body: h(
        "p",
        {},
        "There are no issues yet. Add one in Issues first, then link these lines to it.",
      ),
      actions: [{ label: "Close", value: null }],
    });
    return;
  }
  const issue = h(
    "select",
    {},
    issues.map((i) => h("option", { value: String(i.id) }, i.title?.text ?? `Issue ${i.id}`)),
  );
  const from = h("input", {
    type: "number",
    min: "1",
    max: String(max),
    value: String(range?.start ?? 1),
  });
  const to = h("input", {
    type: "number",
    min: "1",
    max: String(max),
    value: String(range?.end ?? range?.start ?? 1),
  });
  const stanceName = `stance-${doc.id}`;
  const stance = h(
    "fieldset",
    { class: "vstack gap-sm" },
    h("legend", {}, "How does it bear on the issue?"),
    Object.entries(STANCE).map(([v, label], i) =>
      h(
        "label",
        { class: "hstack" },
        h("input", { type: "radio", name: stanceName, value: v, checked: i === 0 }),
        label,
      )
    ),
  );
  const note = h("textarea", { rows: "3" });
  const ok = await openDialog({
    title: `Link ${doc.id} lines to an issue`,
    wide: true,
    body: [
      h(
        "p",
        {},
        range
          ? `You selected ${refLines({ line_start: range.start, line_end: range.end })}.`
          : "Choose the lines. Tip: select the text first and the lines are filled in for you.",
      ),
      Field({ label: "Issue", control: issue }),
      h(
        "div",
        { class: "hstack doc-range" },
        Field({ label: "From line", control: from }),
        Field({ label: "To line", control: to }),
      ),
      stance,
      Field({
        label: "Note (optional)",
        control: note,
        hint: "Names you type are replaced before Claude sees them.",
      }),
    ],
    actions: [
      { label: "Cancel", value: null },
      { label: "Link lines", value: true, variant: "primary" },
    ],
  });
  if (ok !== true) return;
  const a = Number(from.value);
  const b = Number(to.value);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > max) {
    showToast(`Choose lines between 1 and ${max}, with “To” not before “From”.`, {
      tone: "danger",
    });
    return;
  }
  const chosen = stance.querySelector("input:checked")?.value ?? "supports";
  const source = `${doc.id}:${a}${b !== a ? `-${b}` : ""}`;
  await api("POST", `/api/issues/${issue.value}/evidence`, {
    source,
    stance: chosen,
    note: note.value,
  });
  const title = issue.selectedOptions[0]?.textContent ?? "the issue";
  const msg = `Linked ${refLines({ line_start: a, line_end: b })} to “${title}” as ${
    STANCE[chosen].toLowerCase()
  }.`;
  announce(msg);
  showToast(h("span", {}, msg, " ", h("a", { href: `#/issues/${issue.value}` }, "Open issue")));
  return true;
}
