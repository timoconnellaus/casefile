// Chronology (W2-4; DESIGN-SPEC §3–§7, gap list I). Claude's and the user's entries by year, with
// filters, and a checking panel: casefile's own checks (CheckList), the cited lines (SourcePanel,
// closed until shown), the two-part check and "Mark as checked". Removed entries live in
// "Removed items" and can be restored. Names are plain unless "Highlight people" is on.
import { clear, cls, h, uniqueId } from "../dom.js";
import { action, api, ApiError, download } from "../lib.js";
import {
  colourClass,
  formatDay,
  formatRef,
  plural,
  roleLabel,
  tokenisedFrom,
  tokenText,
} from "../model.js";
import {
  ActorLabel,
  announce,
  Badge,
  Button,
  CheckList,
  ConfirmBar,
  CopyBlock,
  EmptyState,
  ExtraCheck,
  Icon,
  Key,
  linkEntities,
  listShortcuts,
  Segmented,
  Segments,
  ShortcutHint,
  showToast,
  SourcePanel,
  Toggle,
  withRoleChips,
} from "../components/index.js";

const STATUS = [
  { id: "all", label: "All" },
  { id: "to_check", label: "To check" },
  { id: "changed", label: "Changed since you checked" },
  { id: "cant_check", label: "Can’t check" },
  { id: "checked", label: "Checked against source" },
];

const HEADINGS = {
  to_check: "Check this entry",
  changed: "Check this entry again",
  cant_check: "This entry can’t be checked",
  checked: "Checked against source",
  user: "Your entry",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ID_KINDS = new Set([
  "address",
  "phone",
  "email",
  "identifier",
  "date_of_birth",
  "dob",
  "medicare",
  "tfn",
  "abn",
  "file_number",
]);

// ── small pure helpers ────────────────────────────────────────────────────────

/** "2025-03-14" → "14 March 2025"; "2023-06" → "June 2023"; "2017" → "2017". */
function dateLabel(d, short = false) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(d ?? ""));
  if (!m) return String(d ?? "");
  if (m[3]) return formatDay(d, short);
  if (m[2]) {
    const month = MONTHS[Number(m[2]) - 1] ?? m[2];
    return `${short ? month.slice(0, 3) : month} ${m[1]}`;
  }
  return m[1];
}

const yearOf = (e) => String(e.event_date ?? "").slice(0, 4) || "Undated";

/** "D002:9 · D001:1–2" */
const citesOf = (e) => e.sources.map(formatRef).join(" · ");

/** The state shown for an entry: the user's own entries have nothing of Claude's to check. */
const stateOf = (e) => (e.created_by === "user" ? "user" : e.state);

const needsCheck = (s) => s === "to_check" || s === "changed";

/** The roles an entry's description names (people, places and organisations, not numbers). */
function rolesIn(e) {
  return new Set(
    (e.description?.segs ?? []).filter((s) => s.role && !ID_KINDS.has(s.kind)).map((s) => s.role),
  );
}

/** A "mixed up" check row: {claimed, source} name segments, or null. */
function swapIn(checks) {
  for (const c of checks) {
    if (c.kind !== "entity" || c.ok === true || !/mixed up/i.test(c.message)) continue;
    const roles = [];
    for (const s of c.segs ?? []) {
      if (s.role && !roles.some((r) => r.role === s.role)) roles.push(s);
    }
    if (roles.length >= 2) return { claimed: roles[0], source: roles[1] };
  }
  return null;
}

/** The copyable request to Claude: labels only, never real names. */
function askClaudeText(e) {
  const problems = e.checks
    .filter((c) => (c.kind === "entity" || c.kind === "citation") && c.ok !== true)
    .map((c) => tokenisedFrom({ segs: c.segs?.length ? c.segs : [{ t: c.message }] }));
  const unknown = e.description?.unknown ?? [];
  return [
    `Please correct chronology entry ${e.id} (${dateLabel(e.event_date)}), which cites ${
      citesOf(e) || "no source"
    }:`,
    ...problems.map((p) => `- ${p}`),
    ...unknown.map((u) => `- ${u} is not a label casefile knows.`),
    `Use: casefile chrono edit ${e.id}`,
  ].join("\n");
}

/** Sources as the edit field shows them: "D002:9, D001:1-2". */
const sourcesField = (e) =>
  e.sources.map((s) =>
    `${s.doc_id}:${s.line_start}${s.line_end !== s.line_start ? `-${s.line_end}` : ""}`
  ).join(", ");

const splitSources = (v) => String(v ?? "").split(/[\s,;]+/).filter(Boolean);

// ── the view ─────────────────────────────────────────────────────────────────

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {any} ctx */
export default async function view(main, _params, ctx) {
  const shortcuts = ctx?.shortcuts !== false;
  const hashQuery = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const want = hashQuery.get("entry");
  // #/chronology?issue=N (from an issue's "Used in"): start filtered to that issue.
  const wantIssue = hashQuery.get("issue");

  const st = {
    entries: [],
    removed: [],
    people: new Map(),
    mode: "list", // "list" | "removed"
    status: "all",
    person: "all",
    doc: "all",
    issue: wantIssue && /^\d+$/.test(wantIssue) ? wantIssue : "all",
    actor: "all",
    q: "",
    hl: false,
    sel: want && /^\d+$/.test(want) ? Number(want) : null,
    adding: false,
    exportOpen: false,
    editing: false,
    /** `${id}:${version}` → {seen: Set<sourceKey>, quote, fair} */
    checks: new Map(),
  };

  // ── data ──
  const byDate = (a, b) => String(a.event_date).localeCompare(String(b.event_date)) || a.id - b.id;
  async function load() {
    const [live, removed, people] = await Promise.all([
      api("GET", "/api/chronology"),
      api("GET", "/api/chronology?removed=1"),
      api("GET", "/api/people").catch(() => null),
    ]);
    st.entries = [...live].sort(byDate);
    st.removed = [...removed].sort(byDate);
    if (people?.entities) st.people = new Map(people.entities.map((p) => [p.role, p]));
    if (st.sel !== null && !st.entries.some((e) => e.id === st.sel)) st.sel = null;
  }

  const nameOf = (role, fallback) => {
    const p = st.people.get(role);
    return p?.forms?.full ?? p?.forms?.first ?? fallback ?? roleLabel(role);
  };

  const uiFor = (e) => {
    const k = `${e.id}:${e.version}`;
    if (!st.checks.has(k)) st.checks.set(k, { seen: new Set(), quote: false, fair: false });
    return st.checks.get(k);
  };

  // ── filtering ──
  const query = () => st.q.trim().toLowerCase();
  const anyFilter = () =>
    st.person !== "all" || st.doc !== "all" || st.issue !== "all" || st.actor !== "all" ||
    Boolean(query());
  const passOthers = (e) =>
    (st.person === "all" || rolesIn(e).has(st.person)) &&
    (st.doc === "all" || e.sources.some((s) => s.doc_id === st.doc)) &&
    (st.issue === "all" || e.issues.some((i) => String(i.id) === st.issue)) &&
    (st.actor === "all" || e.created_by === st.actor) &&
    (!query() ||
      `${e.description?.text ?? ""} ${citesOf(e)} ${dateLabel(e.event_date)} ${e.event_date}`
        .toLowerCase().includes(query()));
  const passStatus = (e) => st.status === "all" || stateOf(e) === st.status;
  const shown = () => st.entries.filter((e) => passStatus(e) && passOthers(e));

  // ── persistent frame ──
  const root = h("div", { class: "chrono ent-plain" });
  const headCount = h("span", { class: "muted" });
  const removedBtn = Button("", {
    "aria-pressed": false,
    onclick: () => {
      st.mode = st.mode === "list" ? "removed" : "list";
      st.editing = false;
      renderAll();
      (st.mode === "removed" ? removedHeading : listHeading).focus();
    },
  });
  const exportBtn = Button("Export chronology…", {
    "aria-expanded": false,
    onclick: () => {
      st.exportOpen = !st.exportOpen;
      renderSlots();
    },
  });
  const addBtn = Button("+ Add entry", {
    "aria-expanded": false,
    onclick: () => {
      st.adding = !st.adding;
      renderSlots();
      if (st.adding) slotAdd.querySelector("input")?.focus();
    },
  });
  const hlToggle = Toggle({
    label: "Highlight people",
    pressed: false,
    onChange: (on) => {
      st.hl = on;
      root.classList.toggle("ent-plain", !on);
      linker.clear();
      renderKey();
      renderList();
      renderPanel();
      announce(on ? "People are highlighted. The key is above the list." : "Names are plain text.");
    },
  });

  const statusSeg = h("div", { class: "toolbar chrono-status" });
  const filters = h("div", {
    class: "chrono-filters",
    role: "search",
    "aria-label": "Filter the chronology",
  });
  const slotKey = h("div", {});
  const slotAdd = h("div", {});
  const slotExport = h("div", {});
  const listHeading = h(
    "h2",
    { id: uniqueId("chrono-list-h"), class: "sr", tabindex: "-1" },
    "Entries",
  );
  const removedHeading = h(
    "h2",
    { id: uniqueId("chrono-removed-h"), class: "chrono-removed-title", tabindex: "-1" },
    "Removed items",
  );
  const resultText = h("p", { class: "muted chrono-result", role: "status" });
  const listBody = h("div", { class: "chrono-groups" });
  const hint = shortcuts
    ? h(
      "p",
      { class: "muted small chrono-hint" },
      "Shortcuts when the list has focus: ",
      ShortcutHint("J", true),
      " / ",
      ShortcutHint("K", true),
      " move · ",
      ShortcutHint("Enter", true),
      " open. Turn them off in Settings.",
    )
    : null;
  const listSection = h(
    "section",
    { class: "chrono-list", "aria-labelledby": listHeading.id },
    listHeading,
    resultText,
    listBody,
    hint,
  );
  const panelHeadingId = uniqueId("chrono-panel-h");
  const panel = h("aside", { class: "chrono-panel", "aria-labelledby": panelHeadingId });
  const columns = h("div", { class: "chrono-cols" }, listSection, panel);

  root.append(
    h(
      "div",
      { class: "toolbar chrono-head" },
      h("h1", {}, "Chronology"),
      headCount,
      h("span", { class: "spacer" }),
      hlToggle,
      addBtn,
      exportBtn,
      removedBtn,
    ),
    statusSeg,
    filters,
    slotKey,
    slotAdd,
    slotExport,
    columns,
  );
  main.replaceChildren(root);
  const linker = linkEntities(root);

  listShortcuts(listBody, { j: () => moveFocus(1), k: () => moveFocus(-1) }, {
    enabled: shortcuts,
  });

  function moveFocus(d) {
    const rows = [...listBody.querySelectorAll("button.chrono-row")];
    const i = rows.indexOf(/** @type {any} */ (document.activeElement));
    rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))]?.focus();
  }

  function clearFilters() {
    Object.assign(st, { person: "all", doc: "all", issue: "all", actor: "all", q: "" });
    st.status = "all";
    renderStatus();
    renderFilters();
    renderList();
    announce("Filters cleared.");
    filters.querySelector("select")?.focus();
  }

  // ── head, status and filters ──
  function renderHead() {
    const years = [...new Set(st.entries.map(yearOf))].filter((y) => /^\d{4}$/.test(y));
    headCount.textContent = `${plural(st.entries.length, "entry", "entries")}${
      years.length ? ` · ${years[0]}${years.length > 1 ? ` to ${years.at(-1)}` : ""}` : ""
    }`;
    removedBtn.replaceChildren(
      st.mode === "removed" ? "Back to the chronology" : `Removed items (${st.removed.length})`,
    );
    removedBtn.setAttribute("aria-pressed", String(st.mode === "removed"));
    statusSeg.hidden = st.mode !== "list";
    filters.hidden = st.mode !== "list";
  }

  function renderStatus() {
    const count = (id) =>
      id === "all" ? st.entries.length : st.entries.filter((e) => stateOf(e) === id).length;
    statusSeg.replaceChildren(
      Segmented({
        label: "Filter by status",
        value: st.status,
        options: STATUS.map((s) => ({ ...s, count: count(s.id) })),
        onChange: (id) => {
          st.status = id;
          renderList();
          renderFilters();
        },
      }),
    );
  }

  function select(label, value, options, onChange) {
    const id = uniqueId("chrono-f");
    return h(
      "div",
      { class: "field chrono-fld" },
      h("label", { for: id }, label),
      h(
        "select",
        { id, onchange: (ev) => onChange(ev.target.value) },
        options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)),
      ),
    );
  }

  function renderFilters() {
    // Options come from the entries themselves.
    const roles = new Map();
    const docs = new Map();
    const issues = new Map();
    for (const e of st.entries) {
      for (const s of e.description?.segs ?? []) {
        if (s.role && !ID_KINDS.has(s.kind) && !roles.has(s.role)) roles.set(s.role, s);
      }
      for (const s of e.sources) if (!docs.has(s.doc_id)) docs.set(s.doc_id, s.docTitle);
      for (const i of e.issues) issues.set(String(i.id), i.title ?? `Issue ${i.id}`);
    }
    const people = [...roles.values()].sort((a, b) =>
      Number(a.colour == null) - Number(b.colour == null) ||
      (a.colour ?? 0) - (b.colour ?? 0) || a.role.localeCompare(b.role)
    );
    const clearBtn = h("button", {
      type: "button",
      class: "btn-link",
      hidden: !anyFilter() && st.status === "all",
      onclick: clearFilters,
    }, "Clear filters");
    const set = (k) => (v) => {
      st[k] = v;
      renderList();
      clearBtn.hidden = !anyFilter() && st.status === "all";
    };
    const searchId = uniqueId("chrono-q");
    const searchInput = h("input", {
      id: searchId,
      type: "search",
      value: st.q,
      placeholder: "e.g. swimming",
      oninput: (ev) => set("q")(ev.target.value),
    });
    const years = [...new Set(shown().map(yearOf))];
    clear(
      filters,
      select("Person", st.person, [
        ["all", "Anyone"],
        ...people.map((s) => [s.role, `${nameOf(s.role, s.t)} (${roleLabel(s.role)})`]),
      ], set("person")),
      select("Document", st.doc, [
        ["all", "Any document"],
        ...[...docs.entries()].sort().map(([id, t]) => [id, t ? `${id} · ${t}` : id]),
      ], set("doc")),
      select("Issue", st.issue, [["all", "Any issue"], ...issues.entries()], set("issue")),
      select("Written by", st.actor, [
        ["all", "Claude or you"],
        ["claude", "Claude"],
        ["user", "You"],
      ], set("actor")),
      h(
        "div",
        { class: "field chrono-fld" },
        h("label", { for: searchId }, "Search entries"),
        searchInput,
      ),
      years.length > 1
        ? h(
          "nav",
          { class: "chrono-years", "aria-label": "Jump to year" },
          h("span", { class: "muted" }, "Jump to"),
          years.map((y) =>
            h("button", {
              type: "button",
              class: "btn-link",
              "aria-label": `Jump to ${y}`,
              onclick: () => {
                const target = listBody.querySelector(`[data-year="${y}"]`);
                target?.scrollIntoView({ block: "start" });
                target?.focus();
              },
            }, y)
          ),
        )
        : null,
      clearBtn,
    );
  }

  function renderKey() {
    if (!st.hl) return slotKey.replaceChildren();
    const seen = new Map();
    for (const e of st.entries) {
      for (const s of e.description?.segs ?? []) {
        if (s.role && s.colour != null && !seen.has(s.role)) seen.set(s.role, s);
      }
    }
    const entries = [...seen.values()].sort((a, b) => a.colour - b.colour).map((s) => ({
      role: s.role,
      name: `${nameOf(s.role, s.t)} · ${roleLabel(s.role)}`,
      kind: s.kind,
      colour: s.colour,
    }));
    slotKey.replaceChildren(
      h(
        "div",
        { class: "chrono-key" },
        Key({
          entries,
          help:
            "Parents and children have their own colour; everyone else is plain ink with their role shown. Point at or tab to a name to see everywhere it appears; click to keep it highlighted.",
        }),
      ),
    );
  }

  // ── add entry and export (under the filters) ──
  function renderSlots() {
    addBtn.setAttribute("aria-expanded", String(st.adding));
    exportBtn.setAttribute("aria-expanded", String(st.exportOpen));
    slotAdd.replaceChildren(st.adding ? AddForm() : "");
    slotExport.replaceChildren(st.exportOpen ? ExportDialog() : "");
  }

  // ── export for Word (W3-1) ──
  // Checked entries only, or every entry with the unchecked ones marked. A protected address in
  // the entries asks for confirmation first (ADR 0021).
  function ExportDialog() {
    const hid = uniqueId("chrono-export-h");
    const which = st.exportWhich ?? "checked";
    const close = () => {
      st.exportOpen = false;
      st.exportSafety = false;
      renderSlots();
      exportBtn.focus();
    };
    const run = async (confirmSafety) => {
      const res = await fetch(
        `/api/chronology/export?which=${st.exportWhich ?? "checked"}${
          confirmSafety ? "&confirmSafety=1" : ""
        }`,
        { credentials: "same-origin" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.safetyConfirm) {
          // An address, or other details (a phone, an email, a number) of that person.
          st.exportSafety = (body.addresses ?? []).every((a) => !a.kind || a.kind === "address")
            ? "address"
            : "details";
          renderSlots();
          slotExport.querySelector(".confirmbar")?.focusPrimary?.();
          return;
        }
        throw new ApiError(res.status, body);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
        "chronology.rtf";
      download(name, await res.text(), "application/rtf");
      st.exportSafety = false;
      renderSlots();
      const msg = `Exported ${name}. Check your downloads folder.`;
      announce(msg);
      showToast(msg, { glyph: "check" });
    };
    const option = (value, label, hintText) =>
      h(
        "label",
        { class: "chrono-export-opt" },
        h("input", {
          type: "radio",
          name: "chrono-export-which",
          value,
          checked: which === value,
          onchange: () => {
            st.exportWhich = value;
            st.exportSafety = false;
          },
        }),
        h(
          "span",
          { class: "vstack" },
          h("span", {}, label),
          h("span", { class: "muted small" }, hintText),
        ),
      );
    return h(
      "section",
      { class: "chrono-box", "aria-labelledby": hid },
      h("h2", { id: hid, class: "chrono-box-title" }, "Export the chronology as a Word table"),
      h(
        "fieldset",
        { class: "vstack gap-sm" },
        h("legend", {}, "Which entries?"),
        option(
          "checked",
          "Only the entries you have checked",
          "Each one checked against the lines it cites.",
        ),
        option(
          "all",
          "Every entry, with unchecked ones marked",
          "Entries you haven’t checked say NOT CHECKED in their own column.",
        ),
      ),
      h(
        "p",
        { class: "muted" },
        "References like D002:9 are written out as the document’s title and line. The file saves to your downloads, never into the case folder Claude works in. To make a PDF, open it in Word and Save as PDF.",
      ),
      st.exportSafety
        ? ConfirmBar({
          title: st.exportSafety === "details"
            ? "This export includes protected details"
            : "This export includes a protected address",
          summary: `${
            st.exportSafety === "details" ? "Contact details or an address" : "An address"
          } of someone marked safety-sensitive ${
            st.exportSafety === "details" ? "appear" : "appears"
          } in these entries. Check before you give this file to anyone — the other side, a lawyer or the Court.`,
          confirmLabel: st.exportSafety === "details"
            ? "Export with these details"
            : "Export with the address",
          danger: true,
          onConfirm: action(() => run(true)),
          onCancel: () => {
            st.exportSafety = false;
            renderSlots();
            slotExport.querySelector("[data-export]")?.focus();
          },
        })
        : null,
      h(
        "div",
        { class: "hstack" },
        Button("Export for Word (.rtf)", {
          variant: "primary",
          size: "lg",
          "data-export": "rtf",
          onclick: action(() => run(false)),
        }),
        Button("Close", { size: "lg", onclick: close }),
      ),
    );
  }

  function field(label, control, hintText) {
    const hintId = `${control.id}-hint`;
    if (hintText) control.setAttribute("aria-describedby", hintId);
    return h(
      "div",
      { class: "field grow" },
      h("label", { for: control.id }, label),
      control,
      hintText ? h("span", { id: hintId, class: "field-hint" }, hintText) : null,
    );
  }

  const DATE_PATTERN = "\\d{4}(-\\d{2}(-\\d{2})?)?";

  function AddForm() {
    const hid = uniqueId("chrono-add-h");
    const date = h("input", {
      id: uniqueId("chrono-add-date"),
      required: true,
      placeholder: "2025-03-14",
      pattern: DATE_PATTERN,
    });
    const text = h("textarea", { id: uniqueId("chrono-add-text"), required: true });
    const srcs = h("input", { id: uniqueId("chrono-add-src"), placeholder: "D002:9, D001:1-2" });
    return h(
      "form",
      {
        class: "chrono-box",
        "aria-labelledby": hid,
        onsubmit: action(async (ev) => {
          ev.preventDefault();
          const r = await api("POST", "/api/chronology", {
            event_date: date.value.trim(),
            description: text.value,
            sources: splitSources(srcs.value),
          });
          st.adding = false;
          st.sel = r.id;
          await refresh();
          showToast(`Added your entry: ${dateLabel(date.value.trim())}.`);
        }),
      },
      h("h2", { id: hid, class: "chrono-box-title" }, "Add an entry yourself"),
      h(
        "div",
        { class: "chrono-form-row" },
        field("Date", date, "YYYY, YYYY-MM or YYYY-MM-DD"),
        field("Cited lines", srcs, "Document and lines, e.g. D002:9 or D001:1-2"),
      ),
      field(
        "What happened",
        text,
        "You can use real names. casefile replaces them before Claude sees the entry.",
      ),
      h(
        "div",
        { class: "hstack" },
        Button("Add entry", { variant: "primary", type: "submit" }),
        Button("Cancel", {
          size: "lg",
          onclick: () => {
            st.adding = false;
            renderSlots();
            addBtn.focus();
          },
        }),
      ),
    );
  }

  // ── the list ──
  function renderList() {
    if (st.mode === "removed") return renderRemoved();
    if (hint) hint.hidden = false;
    const list = shown();
    const name = STATUS.find((s) => s.id === st.status)?.label;
    resultText.textContent = `Showing ${list.length} of ${
      plural(st.entries.length, "entry", "entries")
    }${st.status === "all" ? "" : ` · ${name}`}${anyFilter() ? " · other filters on" : ""}`;
    if (!st.entries.length) {
      listBody.replaceChildren(EmptyState({
        message:
          "No entries yet. Ask Claude to build a chronology from the shared documents, or add an entry yourself.",
        action: Button("+ Add entry", {
          onclick: () => {
            st.adding = true;
            renderSlots();
            slotAdd.querySelector("input")?.focus();
          },
        }),
      }));
      return;
    }
    if (!list.length) {
      listBody.replaceChildren(EmptyState({
        message: "No entries match these filters.",
        action: Button("Clear filters", { onclick: clearFilters }),
      }));
      return;
    }
    const years = [...new Set(list.map(yearOf))];
    listBody.replaceChildren(
      ...years.map((y) => {
        const hid = uniqueId(`chrono-y${y}`);
        return h(
          "section",
          { "aria-labelledby": hid },
          h("h3", { id: hid, class: "chrono-year", tabindex: "-1", "data-year": y }, y),
          h("ul", { class: "chrono-rows" }, list.filter((e) => yearOf(e) === y).map(Row)),
        );
      }),
    );
  }

  function Row(e) {
    const s = stateOf(e);
    const sel = e.id === st.sel;
    const what = Segments(e.description?.segs ?? [], { interactive: false, roleChips: st.hl });
    const openNote = e.notes.some((n) => !n.done && n.created_by === "claude");
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: cls("chrono-row", sel && "is-selected-row"),
          "aria-current": sel ? "true" : null,
          "data-id": e.id,
          "aria-label": `Open chronology entry ${dateLabel(e.event_date)}, ${
            s === "user" ? "your entry" : STATUS.find((x) => x.id === s)?.label
          }`,
          onclick: () => pick(e.id),
        },
        h("span", { class: "chrono-when mono" }, dateLabel(e.event_date, true)),
        h(
          "span",
          { class: "chrono-what" },
          h("span", {}, what),
          h(
            "span",
            { class: "chrono-meta" },
            h("span", { class: "mono" }, citesOf(e) || "No source cited"),
            ActorLabel(e.created_by),
            openNote ? h("span", {}, "· Claude’s note") : null,
          ),
        ),
        h("span", { class: "chrono-badge" }, s === "user" ? null : Badge("work", s)),
      ),
    );
  }

  function markSelected(id) {
    for (const b of listBody.querySelectorAll("button.chrono-row")) {
      const on = Number(b.dataset.id) === id;
      b.classList.toggle("is-selected-row", on);
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  function pick(id) {
    st.sel = id;
    st.editing = false;
    try {
      // Keep the address in step without a hashchange (which would re-render the screen).
      history.replaceState(null, "", `#/chronology?entry=${id}`);
    } catch { /* not important */ }
    markSelected(id);
    renderPanel();
    // On narrow screens the panel sits below the list: bring it into view.
    if (panel.getBoundingClientRect().top > innerHeight) panel.scrollIntoView({ block: "start" });
  }

  // ── removed items ──
  function renderRemoved() {
    if (hint) hint.hidden = true;
    resultText.textContent = st.removed.length
      ? `${
        plural(st.removed.length, "removed entry", "removed entries")
      }. Restore one to put it back in the chronology.`
      : "";
    if (!st.removed.length) {
      listBody.replaceChildren(
        removedHeading,
        EmptyState({
          message: "Nothing has been removed. Entries you remove wait here until you restore them.",
        }),
      );
      return;
    }
    listBody.replaceChildren(
      removedHeading,
      h(
        "ul",
        { class: "chrono-rows" },
        st.removed.map((e) => {
          const what = Segments(e.description?.segs ?? [], {
            interactive: false,
            roleChips: st.hl,
          });
          return h(
            "li",
            { class: "chrono-removed-row" },
            h("span", { class: "chrono-when mono" }, dateLabel(e.event_date, true)),
            h(
              "span",
              { class: "chrono-what" },
              h("span", {}, what),
              h(
                "span",
                { class: "chrono-meta" },
                h("span", { class: "mono" }, citesOf(e) || "No source cited"),
                ActorLabel(e.created_by),
                e.removed_at ? h("span", {}, `Removed ${formatDay(e.removed_at)}`) : null,
              ),
              e.usedIn.length ? UsedInWarning(e.usedIn, true) : null,
            ),
            Button("Restore", {
              "aria-label": `Restore chronology entry ${dateLabel(e.event_date)}`,
              onclick: action(async () => await restore(e)),
            }),
          );
        }),
      ),
    );
  }

  async function restore(e) {
    await api("POST", `/api/chronology/${e.id}/restore`);
    st.sel = e.id;
    st.mode = "list";
    await refresh();
    showToast(`Restored: ${dateLabel(e.event_date)}.`);
    listBody.querySelector("button.chrono-row[aria-current]")?.focus();
    ctx?.refreshCounts?.();
  }

  /** "¶3, ¶5" on screen, "paragraphs 3 and 5" for screen readers. */
  function paraRefs(ns) {
    const u = [...new Set(ns.filter(Number.isInteger))].sort((a, b) => a - b);
    if (!u.length) return plural(ns.length, "paragraph");
    const spoken = u.length === 1
      ? `paragraph ${u[0]}`
      : `paragraphs ${u.slice(0, -1).join(", ")} and ${u.at(-1)}`;
    return [
      h("span", { "aria-hidden": "true" }, u.map((n) => `¶${n}`).join(", ")),
      h("span", { class: "sr" }, spoken),
    ];
  }

  function UsedInWarning(list, removed) {
    const n = plural(list.length, "draft paragraph", "draft paragraphs");
    const verb = list.length === 1 ? "relies" : "rely";
    return h(
      "div",
      { class: "callout callout--attention chrono-usedin" },
      h(
        "strong",
        { class: "callout-title" },
        Icon("dot"),
        removed ? `${n} still ${verb} on this entry` : `${n} ${verb} on this entry`,
      ),
      h(
        "ul",
        { class: "chrono-usedin-list" },
        [...Map.groupBy(list, (u) => u.draft_id).values()].map((us) =>
          h(
            "li",
            {},
            h(
              "a",
              { href: `#/draft/${us[0].draft_id}` },
              us[0].draftTitle ?? `Draft ${us[0].draft_id}`,
            ),
            " · ",
            paraRefs(us.map((u) => u.n)),
          )
        ),
      ),
      removed
        ? h(
          "span",
          {},
          "Those paragraphs show a warning until you restore the entry or change them.",
        )
        : null,
    );
  }

  // ── the checking panel ──
  function renderPanel() {
    panel.hidden = st.mode === "removed";
    columns.classList.toggle("chrono-cols--single", st.mode === "removed");
    if (st.mode === "removed") return;
    const e = st.entries.find((x) => x.id === st.sel) ??
      shown().find((x) => needsCheck(stateOf(x))) ?? shown()[0] ?? st.entries[0];
    if (!e) {
      panel.replaceChildren(
        h("h2", { id: panelHeadingId, class: "chrono-panel-title" }, "Nothing to check"),
        h("p", { class: "muted" }, "Entries Claude or you add appear here to check."),
      );
      return;
    }
    if (st.sel !== e.id) {
      st.sel = e.id;
      markSelected(e.id);
    }
    clear(panel, ...(st.editing ? EditPanel(e) : CheckPanel(e)));
  }

  function CheckPanel(e) {
    const s = stateOf(e);
    const ui = uiFor(e);
    const label = dateLabel(e.event_date);
    const claim = Segments(e.description?.segs ?? [], { interactive: st.hl, roleChips: st.hl });

    const srcKey = (src, i) => `${i}:${src.doc_id}:${src.line_start}`;
    const startOpen = !needsCheck(s);
    const quotable = e.sources.map((src, i) => ({ src, k: srcKey(src, i) })).filter((x) =>
      x.src.quote.length
    );
    const unseenDocs = () => [
      ...new Set(quotable.filter((x) => !ui.seen.has(x.k)).map((x) => x.src.doc_id)),
    ];

    // Mark as checked: disabled until every cited source is shown and both boxes are ticked.
    const helperId = uniqueId("chrono-mark-help");
    const helper = h("p", { id: helperId, class: "chrono-helper" });
    const mark = Button("Mark as checked", {
      variant: "primary",
      "aria-describedby": helperId,
      "aria-label": `Mark chronology entry ${label} as checked`,
      onclick: action(async () => await verify(e)),
    });
    const update = () => {
      const left = [];
      const docs = unseenDocs();
      if (docs.length) left.push(`show the cited lines in ${docs.join(" and ")}`);
      if (!ui.quote || !ui.fair) left.push("tick both checks");
      let text;
      if (s === "cant_check") {
        text = "Can’t be marked as checked until the entry matches its source.";
      } else if (needsCheck(s)) {
        text = left.length
          ? `To mark as checked: ${left.join(", then ")}.`
          : "Ready. This records that you compared the entry with the source.";
      } else if (s === "checked") {
        text = "Already checked. Editing the entry sends it back to “To check”.";
      } else text = "You wrote this entry, so there is nothing of Claude’s to check.";
      helper.textContent = text;
      mark.disabled = !(needsCheck(s) && !left.length && quotable.length > 0);
    };

    const sources = e.sources.length
      ? e.sources.map((src, i) => {
        if (!src.quote.length) {
          return h(
            "div",
            { class: "callout callout--danger" },
            h(
              "strong",
              { class: "callout-title" },
              Icon("triangle"),
              `casefile can’t show ${formatRef(src)}`,
            ),
            h(
              "span",
              {},
              src.docTitle
                ? "Those lines aren’t in the document. Ask Claude to cite lines that exist."
                : `There is no document ${src.doc_id} in this case. Ask Claude to cite one that exists.`,
            ),
          );
        }
        const k = srcKey(src, i);
        const panelEl = SourcePanel({
          doc: src.doc_id,
          title: src.docTitle ?? src.doc_id,
          own: e.ownStatementOnly,
          start: src.line_start,
          end: src.line_end,
          lines: [...src.context.before, ...src.quote, ...src.context.after],
          open: startOpen || ui.seen.has(k),
          onShow: () => {
            ui.seen.add(k);
            if (st.hl) withRoleChips(panelEl);
            update();
          },
        });
        if (st.hl) withRoleChips(panelEl);
        return src.withheld
          ? h(
            "div",
            { class: "vstack gap-sm" },
            panelEl,
            h("p", { class: "muted small" }, `${src.doc_id} is withheld from Claude now.`),
          )
          : panelEl;
      })
      : [h("p", { class: "muted" }, "This entry cites no source.")];

    const tick = (key, title, hintText) =>
      h(
        "label",
        { class: "chrono-tick" },
        h("input", {
          type: "checkbox",
          checked: ui[key],
          onchange: (ev) => {
            ui[key] = ev.target.checked;
            update();
          },
        }),
        h("span", {}, h("strong", {}, title), h("span", { class: "chrono-tick-hint" }, hintText)),
      );

    const out = [
      h(
        "div",
        { class: "vstack gap-sm" },
        h(
          "div",
          { class: "hstack" },
          s === "user" ? null : Badge("work", s),
          h(
            "span",
            { class: "actor" },
            e.created_by === "claude" ? Icon("pen") : null,
            e.created_by === "claude" ? "Written by Claude" : "Written by you",
          ),
        ),
        h("h2", { id: panelHeadingId, class: "chrono-panel-title" }, HEADINGS[s]),
        h("div", { class: "mono muted small" }, `${label} · ${citesOf(e) || "no source"}`),
        h("p", { class: "chrono-claim" }, claim),
        s === "checked" && e.verified_at
          ? h(
            "p",
            { class: "muted" },
            `You checked this on ${
              formatDay(e.verified_at)
            }: the quote is accurate, and it is a fair reading.`,
          )
          : null,
      ),
      CheckList({ rows: e.checks }),
      e.created_by === "claude" && s !== "checked"
        ? ExtraCheck({ type: "chronology", id: e.id, label: `the entry for ${label}` })
        : null,
    ];

    if (e.ownStatementOnly && s !== "checked") {
      out.push(h(
        "div",
        { class: "callout callout--attention" },
        h(
          "strong",
          { class: "callout-title" },
          Icon("dot"),
          "Only source is your own statement — the Court may want independent evidence",
        ),
        h(
          "span",
          {},
          "Every line this entry cites is in something you wrote. If another document records it (a message, a letter, a certificate), ask Claude to cite that too.",
        ),
      ));
    }

    if (s === "cant_check") out.push(CantCheck(e, label));

    if (s === "changed" && e.lapsed) {
      const edited = e.lapsed.reason === "edited";
      out.push(h(
        "div",
        { class: "callout callout--attention" },
        h(
          "strong",
          { class: "callout-title" },
          Icon("dot"),
          edited
            ? "The entry changed after you checked it"
            : "The source changed after you checked",
        ),
        h(
          "span",
          {},
          `You checked this on ${formatDay(e.lapsed.checkedAt)}. ${
            edited
              ? "Since then the entry itself has changed."
              : "Since then a cited line has changed, for example when the document was shared with Claude again."
          } Read the lines again and check again.`,
        ),
      ));
    }

    out.push(h(
      "section",
      { class: "vstack", "aria-labelledby": `${panelHeadingId}-src` },
      h("h3", { id: `${panelHeadingId}-src` }, "Does the source say this?"),
      ...sources,
    ));

    if (needsCheck(s)) {
      out.push(h(
        "fieldset",
        { class: "vstack gap-sm" },
        h("legend", { class: "chrono-legend" }, "Your check"),
        tick(
          "quote",
          "The quote is accurate",
          "The names, dates and details match the cited lines.",
        ),
        tick(
          "fair",
          "It’s a fair reading of the source",
          "Claude’s wording doesn’t add to, or overstate, what the lines say.",
        ),
      ));
    }

    const removeSlot = h("div", {});
    const removeBtn = Button("Remove…", {
      size: "lg",
      "aria-label": `Remove chronology entry ${label}`,
      "aria-expanded": false,
      onclick: () => {
        if (removeSlot.firstChild) return closeRemove();
        removeBtn.setAttribute("aria-expanded", "true");
        const bar = ConfirmBar({
          title: "Remove this entry?",
          summary:
            "It moves to Removed items, where you can restore it. Claude won’t see it in the chronology.",
          detail: e.usedIn.length
            ? [UsedInWarning(e.usedIn, false), h("p", {}, "Those paragraphs will show a warning.")]
            : null,
          confirmLabel: "Remove entry",
          onConfirm: action(async () => await remove(e)),
          onCancel: closeRemove,
        });
        removeSlot.replaceChildren(bar);
        bar.focusPrimary();
      },
    });
    const closeRemove = () => {
      removeSlot.replaceChildren();
      removeBtn.setAttribute("aria-expanded", "false");
      removeBtn.focus();
    };
    out.push(h(
      "div",
      { class: "vstack gap-sm" },
      h(
        "div",
        { class: "hstack" },
        needsCheck(s) || s === "cant_check" ? mark : null,
        Button("Edit entry", {
          size: "lg",
          "aria-label": `Edit chronology entry ${label}`,
          onclick: () => {
            st.editing = true;
            renderPanel();
            panel.querySelector("input")?.focus();
          },
        }),
        removeBtn,
      ),
      helper,
      removeSlot,
    ));

    if (e.usedIn.length) out.push(UsedInWarning(e.usedIn, false));

    if (e.notes.length) {
      out.push(h(
        "section",
        { class: "vstack gap-sm", "aria-label": "Notes on this entry" },
        e.notes.map(Note),
      ));
    }

    out.push(h(
      "p",
      { class: "chrono-guidance" },
      "Marking an entry as checked records that you compared it with the cited lines, as the Court’s rules on AI (PD-AI 5.5) ask. It means the document says this — not that it is true. If the cited lines change, the entry shows “Changed since you checked”.",
    ));

    update();
    return out;
  }

  /** Why an entry can't be checked, how to fix it, and the request to Claude. */
  function CantCheck(e, label) {
    const swap = swapIn(e.checks);
    const unknown = e.description?.unknown ?? [];
    let title;
    let body;
    if (swap) {
      const children = /^child_/.test(swap.claimed.role) && /^child_/.test(swap.source.role);
      title = `Claude may have mixed up ${children ? "the children" : "two people"}`;
      const chip = (seg) =>
        h("span", { class: `token ${colourClass(seg)}` }, tokenText(seg.role, seg.form));
      body = h(
        "p",
        {},
        "Claude’s entry names ",
        chip(swap.claimed),
        ` (${swap.claimed.t}). The cited line names `,
        chip(swap.source),
        ` (${swap.source.t}). This entry can’t be marked as checked until the names match the source.`,
      );
    } else if (!e.sources.length) {
      title = "This entry cites no source";
      body = h("p", {}, "casefile can only check an entry against the lines it cites.");
    } else if (unknown.length) {
      title = "This entry uses a label casefile doesn’t know";
      body = h(
        "p",
        {},
        `${unknown.join(", ")} isn’t anyone in Who’s who, so casefile can’t check it.`,
      );
    } else {
      title = "This entry names something the cited lines don’t";
      body = h(
        "p",
        {},
        "casefile can’t find everyone and everything the entry names in the lines it cites (see the checks above). It can’t be marked as checked until it matches its source.",
      );
    }
    return h(
      "div",
      { class: "callout callout--danger chrono-cant" },
      h("strong", { class: "callout-title" }, Icon("triangle"), title),
      body,
      h(
        "p",
        {},
        "Fix it yourself with ",
        h("strong", {}, "Edit entry"),
        ", or ask Claude to correct it. This request uses the labels Claude sees, not real names:",
      ),
      CopyBlock({
        text: askClaudeText(e),
        label: `Request to Claude about the ${label} entry`,
        buttonLabel: "Copy request",
        copied: "Copied. Paste it to Claude.",
      }),
    );
  }

  function Note(n) {
    const by = n.created_by === "user" ? "user" : "claude";
    return h(
      "div",
      { class: cls("callout", "chrono-note", n.done && "is-done") },
      h(
        "div",
        { class: "hstack between" },
        ActorLabel(by, { note: true }),
        n.done && n.done_at
          ? h(
            "span",
            { class: "muted small" },
            `You marked this as dealt with on ${formatDay(n.done_at)}`,
          )
          : null,
      ),
      h("p", {}, Segments(n.body?.segs ?? [{ t: n.body?.text ?? "" }], { interactive: st.hl })),
      by === "claude"
        ? h(
          "div",
          { class: "hstack" },
          Button(n.done ? "Not dealt with yet" : "Mark as dealt with", {
            onclick: action(async () => {
              await api("POST", `/api/notes/${n.id}/done`, { done: !n.done });
              await refresh();
              announce(
                n.done ? "Claude’s note is open again." : "Marked Claude’s note as dealt with.",
              );
              ctx?.refreshCounts?.();
            }),
          }),
        )
        : null,
    );
  }

  function EditPanel(e) {
    const label = dateLabel(e.event_date);
    const date = h("input", {
      id: uniqueId("chrono-edit-date"),
      value: e.event_date,
      required: true,
      pattern: DATE_PATTERN,
    });
    const text = h(
      "textarea",
      { id: uniqueId("chrono-edit-text"), required: true },
      e.description?.text ?? "",
    );
    const srcs = h("input", { id: uniqueId("chrono-edit-src"), value: sourcesField(e) });
    const cancel = () => {
      st.editing = false;
      renderPanel();
      panel.querySelector(".chrono-edit-btn")?.focus();
    };
    return [
      h("h2", { id: panelHeadingId, class: "chrono-panel-title" }, `Edit the ${label} entry`),
      h(
        "form",
        {
          class: "vstack",
          onsubmit: action(async (ev) => {
            ev.preventDefault();
            // Send only what changed: any change sends the entry back to "To check".
            const body = {};
            if (date.value.trim() !== e.event_date) body.event_date = date.value.trim();
            if (text.value !== (e.description?.text ?? "")) body.description = text.value;
            const newSrc = splitSources(srcs.value);
            if (newSrc.join(",") !== splitSources(sourcesField(e)).join(",")) {
              body.sources = newSrc;
            }
            if (!Object.keys(body).length) return cancel();
            await api("PATCH", `/api/chronology/${e.id}`, body);
            st.editing = false;
            await refresh();
            showToast(`Saved the ${dateLabel(body.event_date ?? e.event_date)} entry.`);
            ctx?.refreshCounts?.();
          }),
        },
        field("Date", date, "YYYY, YYYY-MM or YYYY-MM-DD"),
        field(
          "What happened",
          text,
          "You can use real names. casefile replaces them before Claude sees the entry.",
        ),
        field("Cited lines", srcs, "Document and lines, e.g. D002:9, D001:1-2"),
        e.created_by === "claude"
          ? h(
            "p",
            { class: "chrono-helper" },
            "Saving a change sends the entry back to “To check”, so you check the new wording against the source.",
          )
          : null,
        h(
          "div",
          { class: "hstack" },
          Button("Save changes", { variant: "primary", type: "submit" }),
          Button("Cancel", { size: "lg", onclick: cancel }),
        ),
      ),
    ];
  }

  // ── actions ──
  async function verify(e) {
    const ui = uiFor(e);
    try {
      await api("POST", `/api/chronology/${e.id}/verify`, {
        version: e.version,
        quoteAccurate: ui.quote,
        fairReading: ui.fair,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await refresh();
        showToast(
          err.body?.code === "stale"
            ? "The entry changed while you were checking it. Read it again before you mark it."
            : "casefile can’t check this entry against its source, so it wasn’t marked as checked.",
          { tone: "danger" },
        );
        return;
      }
      throw err;
    }
    const label = dateLabel(e.event_date);
    const next = shown().find((x) => x.id !== e.id && needsCheck(stateOf(x)));
    st.sel = next ? next.id : e.id;
    await refresh();
    showToast(`Marked as checked: ${label}.`, {
      undo: async () => {
        await api("POST", `/api/chronology/${e.id}/unverify`);
        st.sel = e.id;
        await refresh();
        showToast("Undone. The entry is back in To check.");
        ctx?.refreshCounts?.();
      },
    });
    ctx?.refreshCounts?.();
    listBody.querySelector("button.chrono-row[aria-current]")?.focus();
  }

  async function remove(e) {
    const r = await api("POST", `/api/chronology/${e.id}/remove`);
    const label = dateLabel(e.event_date);
    st.sel = null;
    await refresh();
    const n = r?.usedIn?.length ?? 0;
    showToast(
      `Removed: ${label}.${
        n
          ? ` ${plural(n, "draft paragraph", "draft paragraphs")} that ${
            n === 1 ? "relies" : "rely"
          } on it will show a warning.`
          : ""
      }`,
      { undo: async () => await restore(e) },
    );
    ctx?.refreshCounts?.();
    listBody.querySelector("button.chrono-row[aria-current]")?.focus();
  }

  // ── render ──
  async function refresh() {
    await load();
    renderAll();
  }

  function renderAll() {
    renderHead();
    renderStatus();
    renderFilters();
    renderKey();
    renderSlots();
    renderList();
    renderPanel();
  }

  await load();
  renderAll();
  if (st.sel !== null && want) {
    listBody.querySelector(`button.chrono-row[data-id="${st.sel}"]`)?.scrollIntoView({
      block: "center",
    });
  }
}
