// Component gallery: every component rendered with the CANON fixture, no API calls.
// Open /dev/gallery.html while the app is running; the console should show no CSP violations.
import { h } from "../dom.js";
import { formatDay, STATES } from "../model.js";
import { AppHeader } from "../shell/header.js";
import { openPalette } from "../shell/palette.js";
import {
  ActorLabel,
  announce,
  Badge,
  Button,
  Callout,
  CheckList,
  ConfirmBar,
  DataTable,
  EmptyState,
  EntityDot,
  EntityMark,
  Field,
  FilterChips,
  Icon,
  ICON_NAMES,
  Key,
  LinesTable,
  linkEntities,
  liveRegion,
  openDialog,
  Segmented,
  Segments,
  ShortcutHint,
  showToast,
  SourcePanel,
  Tag,
  Toggle,
  TokenChip,
  UnknownToken,
} from "../components/index.js";
import {
  CHRONO_14_MARCH,
  CHRONO_29_MARCH_CHECKS,
  D001,
  D002,
  documentRows,
  ENTITIES,
  fakeSearch,
} from "./canon.js";

const root = document.getElementById("gallery");

function section(id, title, note, ...body) {
  return h(
    "section",
    { class: "gal-section", "aria-labelledby": `${id}-h`, id },
    h("h2", { id: `${id}-h`, class: "gal-title" }, title),
    note ? h("p", { class: "muted gal-note" }, note) : null,
    h("div", { class: "gal-body" }, body),
  );
}

const keyEntries = (roles, doc) =>
  roles.map((role) => ({
    role,
    ...ENTITIES[role],
    count: doc.lines.flatMap((l) => l.segs).filter((s) => s.role === role).length,
  }));

// ── AppHeader ────────────────────────────────────────────────────────────────
const header = AppHeader({
  label: "Parenting matter 2025",
  current: "docs",
  toCheck: 14,
  idleMinutes: 30,
  onSearch: (q) =>
    openPalette({
      initial: q,
      search: fakeSearch,
      navigate: (href) => showToast(`Would open ${href}`),
    }),
  onLock: () => showToast("Lock pressed (the gallery doesn’t lock anything)."),
});

// ── Badges ───────────────────────────────────────────────────────────────────
const badgeRows = Object.entries(STATES).map(([domain, states]) =>
  h(
    "div",
    { class: "hstack gal-row" },
    h("span", { class: "gal-label mono" }, domain),
    Object.keys(states).map((s) => Badge(domain, s)),
  )
);

// ── Entities ─────────────────────────────────────────────────────────────────
const docRoot = h("div", { class: "gal-doc" });
let docMode = "real";
const renderDoc = () =>
  docRoot.replaceChildren(
    LinesTable({
      caption: `D001 ${
        docMode === "side"
          ? "side by side"
          : docMode === "token"
          ? "as Claude sees it"
          : "as you see it"
      }, line by line`,
      lines: D001.lines,
      mode: docMode,
    }),
  );
renderDoc();
const linked = h(
  "div",
  { class: "gal-linked" },
  Key({ entries: keyEntries(["mother", "father", "child_1", "child_2", "place_1"], D001) }),
  h(
    "div",
    { class: "toolbar" },
    Segmented({
      label: "View",
      options: [
        { id: "real", label: "You see" },
        { id: "token", label: "Claude sees" },
        { id: "side", label: "Side by side" },
      ],
      value: docMode,
      onChange: (v) => {
        docMode = v;
        renderDoc();
      },
    }),
  ),
  docRoot,
);
linkEntities(linked);

const marks = h(
  "div",
  { class: "vstack" },
  h(
    "p",
    {},
    "Marks: ",
    EntityMark({ t: "Anna Thornbury", role: "mother", kind: "person", colour: 0 }),
    " · ",
    EntityMark({
      t: "Margaret Thornbury",
      role: "maternal_grandmother",
      kind: "person",
      colour: null,
    }),
    " · ",
    EntityMark({ t: "Kiama Downs Public School", role: "school", kind: "school" }),
    " · ",
    EntityMark({ t: "0412 345 678", role: "phone_1", kind: "phone" }),
  ),
  h(
    "p",
    {},
    "Chips: ",
    ["mother", "father", "child_1", "child_2"].map((
      r,
    ) => [TokenChip({ role: r, kind: "person", colour: ENTITIES[r].colour }), " "]),
    TokenChip({ role: "mother", form: "first", kind: "person", colour: 0 }),
    " ",
    TokenChip({ role: "school", kind: "school" }),
    " ",
    TokenChip({ role: "medicare_1", kind: "identifier" }),
    " ",
    UnknownToken("{{child_3}}"),
  ),
  h(
    "p",
    { class: "hstack" },
    "Dots: ",
    [0, 1, 2, 3, 4, 5].map((c) => EntityDot({ kind: "person", colour: c })),
    EntityDot({ kind: "person", colour: null }),
    EntityDot({ kind: "school" }),
    EntityDot({ kind: "phone" }),
  ),
);

// Plain by default (Chronology, Issues, Draft) with the Highlight-people toggle.
const plainText = h(
  "p",
  { class: "ent-plain gal-claim" },
  h("span", { class: "mono muted" }, `${formatDay(CHRONO_14_MARCH.date)} · `),
  Segments(CHRONO_14_MARCH.segs),
);
const plain = h(
  "div",
  { class: "vstack" },
  Toggle({
    label: "Highlight people",
    pressed: false,
    onChange: (on) => plainText.classList.toggle("ent-plain", !on),
  }),
  plainText,
);
linkEntities(plain);

// ── Source + checks ──────────────────────────────────────────────────────────
const sources = h(
  "div",
  { class: "gal-grid" },
  h(
    "div",
    { class: "vstack gap-lg" },
    h("h3", {}, "Does the source say this?"),
    SourcePanel({ doc: "D002", title: D002.title, own: true, start: 9, lines: D002.lines }),
    SourcePanel({
      doc: "D001",
      title: D001.title,
      start: 1,
      end: 2,
      lines: D001.lines,
      open: false,
      onShow: () => announce("D001 lines 1–2 shown"),
    }),
  ),
  h(
    "div",
    { class: "vstack gap-lg" },
    CheckList({ rows: CHRONO_14_MARCH.checks }),
    CheckList({ rows: CHRONO_29_MARCH_CHECKS, heading: "29 March 2025 (Can’t check)" }),
  ),
);

// ── Feedback ─────────────────────────────────────────────────────────────────
const confirm = ConfirmBar({
  summary: [
    "Claude will see this document with 25 names and numbers replaced. Title Claude sees: ",
    h("span", { class: "mono" }, "Affidavit of "),
    TokenChip({ role: "mother", kind: "person", colour: 0 }),
    ". You can withdraw it later.",
  ],
  detail: "2 left as written: “Services Australia” (public organisation) and “ABN” (a label).",
  confirmLabel: "Share",
  onConfirm: () =>
    showToast("Shared with Claude, with names replaced.", {
      glyph: "check",
      undo: () => showToast("Withdrawn from Claude."),
    }),
  onCancel: () => showToast("Cancelled."),
});
const confirmTitled = ConfirmBar({
  title: "Change D001 to “From the other side”?",
  summary:
    "casefile will withdraw D001 from Claude straight away. Claude won’t be able to read or search it through casefile.",
  detail: [
    h(
      "p",
      {},
      "Claude’s earlier work from D001 stays in your case: 4 chronology entries, 2 evidence links, 1 Claude’s note.",
    ),
    h(
      "p",
      {},
      "The log shows Claude read lines 1–7 on 2 October 2025. Withdrawing stops further reading; it can’t undo what was already read.",
    ),
  ],
  confirmLabel: "Withdraw D001 from Claude",
  danger: true,
  onConfirm: () =>
    showToast("D001 withdrawn from Claude. Claude’s earlier work stays.", {
      undo: () => showToast("Put back."),
    }),
  onCancel: () => showToast("Cancelled."),
});

const callouts = h(
  "div",
  { class: "vstack" },
  Callout({
    tone: "attention",
    title: "Only source is your own affidavit — the Court may want independent evidence",
    children: "D002 is your own statement. Look for a message or record that shows the same thing.",
  }),
  Callout({
    tone: "danger",
    title: "Claude may have mixed up the children",
    children: [
      "Claude’s entry names ",
      TokenChip({ role: "child_1", kind: "person", colour: 2 }),
      " (Mia). The cited line names ",
      TokenChip({ role: "child_2", kind: "person", colour: 3 }),
      " (Lachlan).",
    ],
  }),
  Callout({
    tone: "neutral",
    title: [ActorLabel("claude", { note: true })],
    children: "D006 mentions a new nickname for the mother.",
  }),
  EmptyState({
    message: "Nothing to check. Claude’s work is all checked against the source.",
    action: Button("Open the chronology"),
  }),
  EmptyState({
    tone: "danger",
    message: "casefile couldn’t read this document. Try again, or import it again.",
    action: Button("Try again"),
  }),
);

// ── Controls ─────────────────────────────────────────────────────────────────
const controls = h(
  "div",
  { class: "vstack gap-lg" },
  h(
    "div",
    { class: "hstack" },
    Button("Mark as checked", { variant: "primary" }),
    Button("Mark as checked", { variant: "primary", disabled: true }),
    Button("Edit entry", { size: "lg" }),
    Button("Remove…"),
    Button("Search", { icon: "search" }),
    Button("Show everyone", { variant: "link" }),
    Button("Withdraw", { variant: "danger" }),
  ),
  FilterChips({
    label: "Show findings",
    options: [
      { id: "all", label: "All", count: 31 },
      { id: "needs", label: "Needs you", count: 1 },
      { id: "unseen", label: "Not looked at yet", count: 24 },
      { id: "decided", label: "You decided", count: 6 },
    ],
    value: "all",
    onChange: (id) => announce(`Showing ${id}`),
  }),
  h(
    "div",
    { class: "hstack" },
    Segmented({
      label: "Status",
      options: [
        { id: "all", label: "All", count: 17 },
        { id: "to_check", label: "To check", count: 4 },
        { id: "cant", label: "Can’t check", count: 1 },
        { id: "ok", label: "Checked against source", count: 12 },
      ],
      value: "to_check",
      onChange: () => {},
    }),
    Toggle({ label: "Keyboard shortcuts", pressed: true, onChange: () => {} }),
  ),
  h(
    "div",
    { class: "hstack gal-fields" },
    Field({
      label: "Person",
      control: h("select", {}, h("option", {}, "Anyone"), h("option", {}, "Anna Thornbury")),
    }),
    Field({
      label: "Search entries",
      control: h("input", { type: "search", placeholder: "Words or a date" }),
    }),
    Field({ label: "Reason", control: h("input", {}), hint: "Say why it can stay as written." }),
  ),
  h(
    "div",
    { class: "hstack" },
    h("span", {}, "Shortcut hints (on): "),
    ShortcutHint("j", true),
    ShortcutHint("k", true),
    ShortcutHint("x", true),
    h("span", { class: "muted" }, "(off shows nothing:"),
    ShortcutHint("j", false),
    h("span", { class: "muted" }, ")"),
  ),
  h(
    "div",
    { class: "hstack" },
    Button("Open a dialog", {
      onclick: async () => {
        const v = await openDialog({
          title: "Remove this entry?",
          body: [
            h("p", {}, "It moves to Removed items. You can put it back."),
            h("p", { class: "muted" }, "1 draft paragraph relies on it."),
          ],
          actions: [
            { label: "Cancel", value: null },
            { label: "Remove", value: "remove", variant: "primary" },
          ],
        });
        showToast(v ? "Removed." : "Kept.", v ? { undo: () => showToast("Put back.") } : {});
      },
    }),
    Button("Show a toast", { onclick: () => showToast("Saved.") }),
    Button("Toast with Undo", {
      onclick: () => showToast("Moved to Removed items.", { undo: () => showToast("Put back.") }),
    }),
    Button("Danger toast", {
      onclick: () =>
        showToast("casefile couldn’t save that. Nothing was changed.", { tone: "danger" }),
    }),
    Button("⌘K palette", {
      onclick: () =>
        openPalette({ search: fakeSearch, navigate: (href) => showToast(`Would open ${href}`) }),
    }),
  ),
  h(
    "div",
    { class: "hstack" },
    ICON_NAMES.map((n) =>
      h("span", { class: "gal-icon" }, Icon(n), h("span", { class: "tiny muted" }, n))
    ),
  ),
  h(
    "div",
    { class: "hstack" },
    ActorLabel("claude"),
    ActorLabel("user"),
    ActorLabel("app"),
    ActorLabel("claude", { note: true }),
    Tag("New"),
    Tag("kept"),
  ),
);

// ── Table ────────────────────────────────────────────────────────────────────
const table = DataTable({
  caption: "Documents. Documents without a date are listed first.",
  rows: documentRows(),
  selectable: true,
  rowLabel: (r) => `${r.id} ${r.title}`,
  sort: { key: "date", dir: "desc" },
  columns: [
    { key: "id", label: "ID", sortable: true, className: "mono" },
    {
      key: "title",
      label: "Title",
      sortable: true,
      rowHeader: true,
      render: (r) => h("a", { href: `#/doc/${r.id}` }, r.title),
    },
    {
      key: "date",
      label: "Date",
      sortable: true,
      render: (r) => (r.date ? formatDay(r.date, true) : h("span", { class: "muted" }, "No date")),
    },
    { key: "type", label: "Type" },
    { key: "origin", label: "Where it came from" },
    {
      key: "state",
      label: "Status",
      sortable: true,
      render: (r) => Badge("doc", r.state, { small: true }),
    },
    { key: "cited", label: "Cited", numeric: true },
  ],
  onSelect: (keys) => announce(`${keys.size} selected`),
});

root.append(
  header,
  h(
    "main",
    { class: "gal-main", id: "main" },
    h("h1", {}, "casefile components"),
    h(
      "p",
      { class: "muted" },
      "Every component from components/, rendered with the invented CANON case (synthetic data only). No API calls. The console should show no CSP violations.",
    ),
    section("badges", "Badge", "Spec §3 vocabulary only — anything else throws.", badgeRows),
    section(
      "entities",
      "EntityMark, TokenChip, EntityDot, Key, LinesTable",
      "Hover (150 ms) or tab to a name to link every occurrence; click or Enter to pin.",
      marks,
      linked,
    ),
    section("plain", "Plain by default + Highlight people", null, plain),
    section("source", "SourcePanel and CheckList", null, sources),
    section("confirm", "ConfirmBar and Toast with Undo", null, confirm, confirmTitled),
    section("callouts", "Callout and EmptyState", null, callouts),
    section(
      "controls",
      "Buttons, FilterChips, Segmented, Toggle, Field, Dialog, icons, actors",
      null,
      controls,
    ),
    section("table", "DataTable (312 documents, sortable, paged)", null, table),
  ),
);
liveRegion();
