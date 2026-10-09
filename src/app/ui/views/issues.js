// Issues and evidence (W2-5, mockup wb/Issues.dc.html, gap list J). The questions the Court will
// decide, the evidence linked to each (grouped by stance), the issue description check, Claude's
// notes, adding evidence by document and line range, and Removed items.
import { api, h, listPeople } from "../lib.js";
import {
  ActorLabel,
  announce,
  Badge,
  Callout,
  CheckList,
  ConfirmBar,
  EmptyState,
  Field,
  FlagBadge,
  Icon,
  Key,
  linkEntities,
  listShortcuts,
  openDialog,
  Segmented,
  Segments,
  ShortcutHint,
  showToast,
  SourcePanel,
  Tick,
  Toggle,
} from "../components/index.js";
import { formatRef, lineRange, parseRef, plural, refHref } from "../model.js";

// ── vocabulary ────────────────────────────────────────────────────────────────

/** API stance → the words on screen (DESIGN-SPEC §6), in the order the groups are shown. */
const STANCES = [
  { id: "supports", label: "Helps your account" },
  { id: "undermines", label: "Points the other way" },
  { id: "context", label: "Background" },
];
const STANCE_LABEL = Object.fromEntries(STANCES.map((s) => [s.id, s.label]));
/** Unexpected stance values fall into Background, so every link is shown somewhere. */
const stanceOf = (e) => (STANCE_LABEL[e.stance] ? e.stance : "context");

const NEEDS = new Set(["to_check", "changed"]);

const SHOW_OPTIONS = [
  { id: "all", label: "All issues" },
  { id: "tocheck", label: "With something to check" },
  { id: "used", label: "Used in a draft" },
];
const SORT_OPTIONS = [
  { id: "tocheck", label: "Most to check first" },
  { id: "az", label: "A to Z" },
  { id: "evidence", label: "Most evidence first" },
];

// ── local helpers ─────────────────────────────────────────────────────────────

/** Text from the API ({text, segs}) as segments; names are focusable only while highlighted. */
function rich(r, hl) {
  if (!r) return "";
  if (r.segs?.length) return Segments(r.segs, { interactive: hl });
  return r.text ?? "";
}

/** Plain text of an API rich value. */
const txt = (r) => (typeof r === "string" ? r : r?.text ?? "");

/** "n help your account · n point the other way · n background" for the issue list. */
function stanceCounts(ev) {
  const n = (k) => ev.filter((e) => stanceOf(e) === k).length;
  const a = n("supports");
  const b = n("undermines");
  return `${a} ${a === 1 ? "helps" : "help"} your account · ${b} ${
    b === 1 ? "points" : "point"
  } the other way · ${n("context")} background`;
}

/** What still needs the user on an issue: {attn, cant, total}. Only Claude's work is checked. */
function pendingOf(issue) {
  let attn = 0;
  let cant = 0;
  const count = (state) => {
    if (NEEDS.has(state)) attn++;
    else if (state === "cant_check") cant++;
  };
  if (issue.created_by === "claude") count(issue.descState);
  for (const e of issue.evidence) if (e.created_by === "claude") count(e.state);
  return { attn, cant, total: attn + cant };
}

/** Draft paragraphs using something, grouped by draft: [{id, title, paras, ns}]. */
function draftsUsing(usedIn) {
  const by = new Map();
  for (const u of usedIn ?? []) {
    const d = by.get(u.draft_id) ??
      { id: u.draft_id, title: u.draftTitle ?? "Draft", paras: 0, ns: [] };
    d.paras++;
    if (Number.isInteger(u.n)) d.ns.push(u.n);
    by.set(u.draft_id, d);
  }
  return [...by.values()].map((d) => ({ ...d, ns: [...new Set(d.ns)].sort((a, b) => a - b) }));
}

/** "paragraphs 3 and 5" (spoken and in plain strings). */
function paraWords(d) {
  if (!d.ns.length) return plural(d.paras, "paragraph");
  return d.ns.length === 1
    ? `paragraph ${d.ns[0]}`
    : `paragraphs ${d.ns.slice(0, -1).join(", ")} and ${d.ns.at(-1)}`;
}

/** "¶3, ¶5" on screen, "paragraphs 3 and 5" for screen readers. */
function ParaRefs(d) {
  if (!d.ns.length) return plural(d.paras, "paragraph");
  return [
    h("span", { "aria-hidden": "true" }, d.ns.map((n) => `¶${n}`).join(", ")),
    h("span", { class: "sr" }, paraWords(d)),
  ];
}

const draftList = (drafts) => drafts.map((d) => `${d.title} (${paraWords(d)})`).join(", ");

/** An evidence link's source lines: two lines before, the cited lines, two after. */
function sourceLines(src) {
  return [...(src.context?.before ?? []), ...(src.quote ?? []), ...(src.context?.after ?? [])];
}

// ── the view ──────────────────────────────────────────────────────────────────

/** @param {HTMLElement} main @param {Record<string, string>} params @param {object} ctx */
export default async function view(main, params, ctx) {
  const st = {
    issues: [],
    removedIssues: [],
    removedEvidence: [],
    docs: null, // documents shared with Claude, for the picker
    docLines: new Map(), // doc id → lines, for the picker preview
    entities: null, // for the key, loaded when highlighting is first turned on
    sel: params.id ? Number(params.id) : null,
    mode: "issues", // or "removed"
    show: "all",
    sort: "tocheck",
    hl: false,
    open: null, // evidence id whose check is open
    seen: new Set(), // evidence ids whose cited lines have been shown
    quote: new Set(),
    fair: new Set(),
    descTick: new Set(),
    confirm: null, // {type: "unlink" | "issue", id}
    add: { mode: "pick", doc: "", from: 1, to: 1, typed: "", stance: "supports", note: "" },
    focusAfter: null,
  };
  const shortcuts = ctx?.shortcuts !== false;
  let linker = null;
  let detachKeys = () => {};

  const load = async () => {
    const [issues, removedIssues, removedEvidence] = await Promise.all([
      api("GET", "/api/issues"),
      api("GET", "/api/issues?removed=1"),
      api("GET", "/api/evidence?removed=1"),
    ]);
    Object.assign(st, { issues, removedIssues, removedEvidence });
    if (!st.issues.some((i) => i.id === st.sel)) st.sel = null;
  };

  const loadDocs = async () => {
    if (st.docs) return;
    const all = await api("GET", "/api/docs");
    // Only documents shared with Claude can be cited; withheld ones never are (CANON).
    st.docs = all.filter((d) => d.state === "shared");
    if (!st.add.doc && st.docs.length) st.add.doc = st.docs[0].id;
  };

  const loadLines = async (id) => {
    if (!id || st.docLines.has(id)) return;
    try {
      const d = await api("GET", `/api/docs/${encodeURIComponent(id)}`);
      st.docLines.set(id, d.lines ?? []);
    } catch {
      st.docLines.set(id, []);
    }
  };

  const reload = async () => {
    await load();
    render();
    ctx?.refreshCounts?.();
  };

  /** Run an API action; errors become a danger toast. */
  const run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      showToast(e?.message ?? String(e), { tone: "danger" });
      console.error(e);
      return undefined;
    }
  };

  const select = (id, focus = "issue-h") => {
    st.sel = id;
    st.mode = "issues";
    st.open = null;
    st.confirm = null;
    history.replaceState(null, "", `#/issues/${id}`);
    st.focusAfter = focus;
    render();
  };

  // ── list (left column) ─────────────────────────────────────────────────────

  const visibleIssues = () => {
    let list = st.issues.map((i) => ({ i, p: pendingOf(i) }));
    if (st.show === "tocheck") list = list.filter((x) => x.p.total > 0);
    if (st.show === "used") list = list.filter((x) => (x.i.usedIn ?? []).length > 0);
    const az = (x, y) => txt(x.i.title).localeCompare(txt(y.i.title), "en-AU");
    if (st.sort === "az") list.sort(az);
    if (st.sort === "tocheck") list.sort((x, y) => y.p.total - x.p.total || az(x, y));
    if (st.sort === "evidence") {
      list.sort((x, y) => y.i.evidence.length - x.i.evidence.length || az(x, y));
    }
    return list;
  };

  const moveSel = (d) => {
    const list = visibleIssues();
    if (!list.length) return;
    const at = list.findIndex((x) => x.i.id === st.sel);
    const next = list[Math.max(0, Math.min(list.length - 1, at + d))].i;
    select(next.id, `row-${next.id}`);
  };

  const issueList = () => {
    const list = visibleIssues();
    const total = st.issues.reduce((n, i) => n + pendingOf(i).total, 0);
    const ul = h(
      "ul",
      { class: "iss-list", "aria-label": "Issues" },
      list.map(({ i, p }) => {
        const current = st.mode === "issues" && i.id === st.sel;
        return h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: ["iss-row", current && "is-current"],
              "aria-current": current ? "true" : null,
              "aria-label": `Open issue ${txt(i.title)}${p.total ? `, ${p.total} to check` : ""}`,
              "data-fk": `row-${i.id}`,
              onclick: () => select(i.id),
            },
            h("span", { class: "iss-row-title" }, txt(i.title)),
            h("span", { class: "iss-row-counts" }, stanceCounts(i.evidence)),
            p.cant
              ? h(
                "span",
                {},
                FlagBadge("danger", "triangle", `${p.cant} can’t check`, { small: true }),
              )
              : p.attn
              ? h("span", {}, FlagBadge("attention", "dot", `${p.attn} to check`, { small: true }))
              : null,
          ),
        );
      }),
    );
    detachKeys();
    detachKeys = listShortcuts(ul, { j: () => moveSel(1), k: () => moveSel(-1) }, {
      enabled: shortcuts,
    });

    const removedCount = st.removedIssues.length + st.removedEvidence.length;
    const select_ = (key, options, fk) =>
      h(
        "select",
        {
          "data-fk": fk,
          onchange: (e) => {
            st[key] = e.target.value;
            render();
          },
        },
        options.map((o) => h("option", { value: o.id, selected: o.id === st[key] }, o.label)),
      );
    return h(
      "aside",
      { class: "col-side col-side--left iss-side", "aria-labelledby": "ilist-h" },
      h(
        "div",
        { class: "hstack between" },
        h("h2", { id: "ilist-h", class: "section-title" }, plural(st.issues.length, "issue")),
        h("button", { type: "button", class: "btn", "data-fk": "new-issue", onclick: newIssue }, [
          "+ New issue",
        ]),
      ),
      h(
        "div",
        { class: "hstack iss-filters" },
        Field({ label: "Show", control: select_("show", SHOW_OPTIONS, "f-show") }),
        Field({ label: "Sort", control: select_("sort", SORT_OPTIONS, "f-sort") }),
      ),
      h(
        "p",
        { role: "status", class: "muted small" },
        `Showing ${list.length} of ${plural(st.issues.length, "issue")} · ${
          plural(total, "item")
        } to check`,
      ),
      list.length ? ul : h("p", { class: "muted iss-list-empty" }, "No issues match."),
      shortcuts && list.length
        ? h(
          "p",
          { class: "muted small iss-keys" },
          ShortcutHint("j", true),
          " ",
          ShortcutHint("k", true),
          " next and previous issue, while the list has focus",
        )
        : null,
      h(
        "div",
        { class: "iss-side-foot" },
        h("button", {
          type: "button",
          class: "btn",
          "aria-pressed": st.mode === "removed",
          "data-fk": "removed",
          onclick: () => {
            st.mode = st.mode === "removed" ? "issues" : "removed";
            st.confirm = null;
            st.focusAfter = st.mode === "removed" ? "removed-h" : "issue-h";
            render();
          },
        }, `Removed items (${removedCount})`),
      ),
    );
  };

  // ── issue (main column) ────────────────────────────────────────────────────

  const descPanel = (issue) => {
    const byClaude = issue.created_by === "claude";
    const state = byClaude ? issue.descState : null;
    const needs = NEEDS.has(state);
    const ticked = st.descTick.has(issue.id);
    const name = txt(issue.title);
    const helperFor = (on) => on ? "Ready." : "Tick the box to mark the description as checked.";
    const helper = h(
      "span",
      { class: "iss-helper", id: `desc-help-${issue.id}` },
      helperFor(ticked),
    );
    const markBtn = h("button", {
      type: "button",
      class: "btn btn-primary btn-lg",
      disabled: !ticked,
      "aria-label": `Mark the description of issue ${name} as checked`,
      "aria-describedby": `desc-help-${issue.id}`,
      "data-fk": "desc-mark",
      onclick: () =>
        run(async () => {
          await api("POST", `/api/issues/${issue.id}/verify`, {
            version: issue.version,
            neutral: true,
          });
          st.descTick.delete(issue.id);
          st.focusAfter = "issue-h";
          await reload();
          announce(`Description checked: ${name}.`);
          showToast(`Description checked: ${name}.`, {
            undo: () =>
              run(async () => {
                await api("POST", `/api/issues/${issue.id}/unverify`);
                await reload();
                showToast("Undone. The description is back in To check.");
              }),
          });
        }),
    }, "Mark description as checked");

    return h(
      "div",
      { class: "iss-panel" },
      h(
        "div",
        { class: "hstack iss-panel-head" },
        h("h3", {}, "Description"),
        state ? Badge("work", state, { small: true }) : null,
        h(
          "span",
          { class: "actor" },
          byClaude ? Icon("pen") : null,
          byClaude ? "Written by Claude" : "Written by you",
        ),
      ),
      issue.description?.text
        ? h("p", { class: "iss-desc" }, rich(issue.description, st.hl))
        : h("p", { class: "muted" }, "No description."),
      state === "cant_check"
        ? Callout({
          tone: "danger",
          title: "casefile can’t check this description",
          children: [
            CheckList({ rows: issue.checks ?? [], heading: null, caveat: null }),
            h(
              "p",
              {},
              "It can’t be marked as checked until this is fixed. Ask Claude to correct it, or remove the issue.",
            ),
          ],
        })
        : null,
      state === "changed"
        ? Callout({
          tone: "attention",
          title: "Changed since you checked",
          children: h(
            "p",
            {},
            "The title or description was changed after you checked it. Read it again and check again.",
          ),
        })
        : null,
      needs
        ? h(
          "div",
          { class: "vstack" },
          Tick({
            label: "This describes the question fairly",
            hint: "Neutral wording that doesn’t assume the answer or take a side.",
            checked: ticked,
            "data-fk": "desc-tick",
            onChange: (on) => {
              on ? st.descTick.add(issue.id) : st.descTick.delete(issue.id);
              markBtn.disabled = !on;
              helper.textContent = helperFor(on);
            },
          }),
          h("div", { class: "hstack" }, markBtn, helper),
        )
        : null,
    );
  };

  const usedInRow = (issue) => {
    const drafts = draftsUsing(issue.usedIn);
    const chrono = issue.chronologyCount ?? 0;
    return h(
      "div",
      { class: "iss-usedin" },
      h("h3", {}, "Used in"),
      drafts.map((d) => h("a", { href: `#/draft/${d.id}` }, `${d.title} — `, ParaRefs(d))),
      chrono
        ? h(
          "a",
          { href: `#/chronology?issue=${issue.id}` },
          `Chronology — ${plural(chrono, "entry", "entries")}`,
        )
        : null,
      !drafts.length && !chrono
        ? h("span", { class: "muted" }, "Not used in any draft or chronology entry yet.")
        : null,
    );
  };

  const withheldNote = (issue) => {
    const docs = new Map();
    for (const e of issue.evidence) {
      for (const s of e.sources ?? []) if (s.withheld) docs.set(s.doc_id, s.docTitle);
    }
    if (!docs.size) return null;
    const one = docs.size === 1;
    const list = [...docs].map(([id, t]) => `${id}${t ? ` · ${t}` : ""}`).join(", ");
    return h(
      "p",
      { class: "iss-guidance" },
      `${one ? "One document" : `${docs.size} documents`} on this issue ${
        one ? "is" : "are"
      } withheld from Claude (${list}). Claude can’t see or cite ${one ? "it" : "them"}.`,
    );
  };

  const evidenceCard = (issue, e) => {
    const ref = formatRef(e);
    const name = txt(issue.title);
    const byClaude = e.created_by === "claude";
    const state = byClaude ? e.state : null;
    const needs = NEEDS.has(state);
    const expanded = st.open === e.id;
    const src = e.sources?.[0];
    const seen = st.seen.has(e.id) || !needs;
    const stance = STANCE_LABEL[stanceOf(e)];
    const bodyId = `ev-check-${e.id}`;
    const ready = () => st.seen.has(e.id) && st.quote.has(e.id) && st.fair.has(e.id);

    const helperText = () => {
      if (state === "cant_check") {
        return "Can’t be marked as checked until casefile can match it to the cited lines.";
      }
      if (state === "checked") return "Already checked against the source.";
      const left = [];
      if (!st.seen.has(e.id)) left.push("open the cited lines");
      if (!st.quote.has(e.id) || !st.fair.has(e.id)) left.push("tick both checks");
      return left.length
        ? `To mark as checked: ${left.join(", then ")}.`
        : "Ready. This records that you compared it with the source.";
    };
    const helper = h("p", { class: "iss-helper", id: `ev-help-${e.id}` }, helperText());
    const markBtn = needs
      ? h("button", {
        type: "button",
        class: "btn btn-primary btn-lg",
        disabled: !ready(),
        "aria-label": `Mark evidence ${ref} for ${name} as checked`,
        "aria-describedby": `ev-help-${e.id}`,
        "data-fk": `ev-mark-${e.id}`,
        onclick: () =>
          run(async () => {
            await api("POST", `/api/evidence/${e.id}/verify`, {
              version: e.version,
              quoteAccurate: true,
              fairReading: true,
            });
            st.open = null;
            st.quote.delete(e.id);
            st.fair.delete(e.id);
            st.focusAfter = `ev-open-${e.id}`;
            await reload();
            announce(`Marked as checked: evidence ${ref}.`);
            showToast(`Marked as checked: evidence ${ref}.`, {
              undo: () =>
                run(async () => {
                  await api("POST", `/api/evidence/${e.id}/unverify`);
                  st.open = e.id;
                  await reload();
                  showToast("Undone. The evidence is back in To check.");
                }),
            });
          }),
      }, "Mark as checked")
      : null;
    const refresh = () => {
      if (markBtn) markBtn.disabled = !ready();
      helper.textContent = helperText();
    };

    const openLabel = expanded
      ? "Close"
      : needs
      ? "Check this"
      : state === "cant_check"
      ? "See the problem"
      : "See the check";
    const confirming = st.confirm?.type === "unlink" && st.confirm.id === e.id;
    const drafts = draftsUsing(e.usedIn);

    return h(
      "article",
      {
        class: ["iss-card", expanded && "is-wide"],
        "aria-label": `Evidence ${ref}, ${stance}`,
        // Escape closes an open check and returns to its button (QA I1). A ConfirmBar inside
        // handles its own Escape first.
        onkeydown: (ev) => {
          if (ev.key !== "Escape" || !expanded || confirming || ev.defaultPrevented) return;
          if (ev.target.closest?.(".confirmbar")) return;
          ev.preventDefault();
          st.open = null;
          st.focusAfter = `ev-open-${e.id}`;
          render();
        },
      },
      h(
        "div",
        { class: "iss-card-top" },
        h(
          "span",
          {},
          h("a", { class: "mono", href: refHref(e) }, ref),
          src?.docTitle ? h("span", { class: "muted" }, ` · ${src.docTitle}`) : null,
        ),
        h(
          "span",
          { class: "hstack" },
          ActorLabel(byClaude ? "claude" : "user"),
          state ? Badge("work", state, { small: true }) : null,
        ),
      ),
      e.quote?.length
        ? h(
          "blockquote",
          { class: "iss-quote" },
          e.quote.map((l) => h("span", {}, rich(l, st.hl))),
        )
        : h("p", { class: "muted" }, "casefile can’t quote these lines."),
      e.note?.text
        ? h(
          "div",
          { class: "vstack gap-sm" },
          h(
            "div",
            { class: "iss-notelabel" },
            ActorLabel(byClaude ? "claude" : "user", { note: true }),
          ),
          h("p", { class: "iss-note" }, rich(e.note, st.hl)),
        )
        : null,
      e.ownStatementOnly
        ? h(
          "p",
          { class: "muted iss-own" },
          Icon("dot"),
          " Only source is your own statement — the Court may want independent evidence.",
        )
        : null,
      drafts.length
        ? h(
          "p",
          { class: "small muted" },
          "Used in ",
          drafts.map((d, n) => [
            n ? ", " : "",
            h("a", { href: `#/draft/${d.id}` }, `${d.title} (`, ParaRefs(d), ")"),
          ]),
        )
        : null,
      h(
        "div",
        { class: "hstack" },
        byClaude
          ? h("button", {
            type: "button",
            class: "btn",
            "aria-expanded": expanded,
            "aria-controls": expanded ? bodyId : null,
            "aria-label": `${
              expanded ? "Close the check for evidence" : "Check evidence"
            } ${ref} for ${name}`,
            "data-fk": `ev-open-${e.id}`,
            onclick: () => {
              st.open = expanded ? null : e.id;
              st.confirm = null;
              st.focusAfter = `ev-open-${e.id}`;
              render();
            },
          }, openLabel)
          : null,
        h("button", {
          type: "button",
          class: "btn",
          "aria-label": `Edit the note and stance of evidence ${ref}`,
          "data-fk": `ev-edit-${e.id}`,
          onclick: () => editEvidence(issue, e),
        }, "Edit…"),
        h("button", {
          type: "button",
          class: "btn",
          "aria-label": `Unlink evidence ${ref} from ${name}`,
          "data-fk": `ev-unlink-${e.id}`,
          onclick: () => {
            st.confirm = { type: "unlink", id: e.id };
            st.focusAfter = "confirm";
            render();
          },
        }, "Unlink…"),
      ),
      confirming
        ? ConfirmBar({
          title: `Unlink ${ref} from this issue?`,
          summary:
            "The link moves to Removed items, where you can restore it. The document is unchanged.",
          detail: drafts.length
            ? h(
              "p",
              { class: "attn-text" },
              Icon("dot"),
              ` It is used in ${
                draftList(drafts)
              }. Those paragraphs keep their text; check them afterwards.`,
            )
            : null,
          confirmLabel: "Unlink",
          onConfirm: () =>
            run(async () => {
              await api("POST", `/api/evidence/${e.id}/remove`);
              st.confirm = null;
              if (st.open === e.id) st.open = null;
              st.focusAfter = "issue-h";
              await reload();
              const msg = `Unlinked ${ref} from ${name}. The document is unchanged.`;
              announce(msg);
              showToast(msg, {
                undo: () =>
                  run(async () => {
                    await api("POST", `/api/evidence/${e.id}/restore`);
                    await reload();
                    showToast("Linked again.");
                  }),
              });
            }),
          onCancel: () => {
            st.confirm = null;
            st.focusAfter = `ev-unlink-${e.id}`;
            render();
          },
        })
        : null,
      expanded
        ? h(
          "div",
          { class: "iss-checkarea", id: bodyId },
          CheckList({
            rows: e.checks ?? [],
            headingLevel: "h4",
            caveat:
              "These checks only look for names, dates and numbers. Whether Claude’s note is a fair reading is for you to judge.",
          }),
          e.ownStatementOnly && needs
            ? Callout({
              tone: "attention",
              title: "This is your own statement",
              children: h(
                "p",
                {},
                "It shows what you said. On its own it doesn’t show that something happened — the Court may want independent evidence.",
              ),
            })
            : null,
          state === "cant_check"
            ? Callout({
              tone: "danger",
              title: "casefile can’t check this against the cited lines",
              children: h(
                "p",
                {},
                "The rows marked ▲ above don’t match the cited lines (for example, Claude’s note names a different child). It can’t be marked as checked until they match. Ask Claude to correct it, or unlink it.",
              ),
            })
            : null,
          state === "changed"
            ? Callout({
              tone: "attention",
              title: e.lapsed?.reason === "edited"
                ? "Changed after you checked"
                : "The source changed after you checked",
              children: h(
                "p",
                {},
                e.lapsed?.reason === "edited"
                  ? "Claude’s note, the stance or the cited lines were changed after you checked them. Read them again and check again."
                  : "A cited line is different now (for example after the document was shared with Claude again). Read the lines again and check again.",
              ),
            })
            : null,
          h(
            "div",
            { class: "vstack gap-sm" },
            h("h4", {}, "Does the source say this?"),
            src
              ? SourcePanel({
                doc: src.doc_id,
                title: src.docTitle ?? "",
                own: e.ownStatementOnly,
                start: src.line_start,
                end: src.line_end,
                lines: sourceLines(src),
                mode: "real",
                open: seen,
                onShow: () => {
                  st.seen.add(e.id);
                  refresh();
                },
              })
              : h("p", { class: "muted" }, "No cited lines."),
          ),
          needs
            ? h(
              "fieldset",
              { class: "vstack gap-sm iss-yourcheck" },
              h("legend", { class: "iss-legend" }, "Your check"),
              Tick({
                label: "The quote is accurate",
                hint: "The cited lines are the right ones, and the names and dates match.",
                checked: st.quote.has(e.id),
                "data-fk": `ev-q-${e.id}`,
                onChange: (on) => {
                  on ? st.quote.add(e.id) : st.quote.delete(e.id);
                  refresh();
                },
              }),
              Tick({
                label: "It’s a fair reading of the source",
                hint:
                  `Claude’s note and the stance (“${stance}”) don’t add to, or overstate, what the lines say.`,
                checked: st.fair.has(e.id),
                "data-fk": `ev-f-${e.id}`,
                onChange: (on) => {
                  on ? st.fair.add(e.id) : st.fair.delete(e.id);
                  refresh();
                },
              }),
            )
            : null,
          h("div", { class: "vstack gap-sm" }, markBtn ? h("div", {}, markBtn) : null, helper),
        )
        : null,
    );
  };

  const stanceGroups = (issue) =>
    STANCES.map((s) => {
      const items = issue.evidence.filter((e) => stanceOf(e) === s.id);
      const hid = `stance-${s.id}`;
      return h(
        "section",
        { class: "iss-stance", "aria-labelledby": hid },
        h(
          "h3",
          { id: hid },
          s.label,
          " ",
          h("span", { class: "muted mono" }, String(items.length)),
        ),
        items.length
          ? h("div", { class: "iss-cards" }, items.map((e) => evidenceCard(issue, e)))
          : h("p", { class: "muted" }, "Nothing linked yet."),
      );
    });

  const notesPanel = (issue) => {
    const claude = (issue.notes ?? []).filter((n) => n.created_by === "claude");
    const open = claude.filter((n) => !n.done);
    const done = claude.length - open.length;
    return [
      ...open.map((n, k) => {
        const hid = `note-h-${n.id}`;
        return h(
          "section",
          { class: "iss-panel", "aria-labelledby": hid },
          h(
            "div",
            { class: "hstack iss-panel-head" },
            h("h3", { id: hid }, "Claude’s note"),
            h("span", { class: "actor" }, Icon("pen"), "Claude · not evidence"),
          ),
          h("p", {}, rich(n.body, st.hl)),
          h(
            "div",
            {},
            h("button", {
              type: "button",
              class: "btn",
              "aria-label": open.length > 1
                ? `Mark Claude’s note ${k + 1} as dealt with`
                : "Mark Claude’s note as dealt with",
              "data-fk": `note-${n.id}`,
              onclick: () =>
                run(async () => {
                  await api("POST", `/api/notes/${n.id}/done`, { done: true });
                  st.focusAfter = "issue-h";
                  await reload();
                  announce("Claude’s note marked as dealt with.");
                  showToast("Claude’s note marked as dealt with.", {
                    undo: () =>
                      run(async () => {
                        await api("POST", `/api/notes/${n.id}/done`, { done: false });
                        await reload();
                        showToast("Claude’s note is back.");
                      }),
                  });
                }),
            }, "Mark as dealt with"),
          ),
        );
      }),
      done
        ? h(
          "p",
          { class: "muted small" },
          `${plural(done, "note")} from Claude on this issue ${
            done === 1 ? "is" : "are"
          } marked as dealt with.`,
        )
        : null,
    ];
  };

  // ── add evidence ───────────────────────────────────────────────────────────

  const addPanel = (issue) => {
    const a = st.add;
    const name = txt(issue.title);
    const lines = st.docLines.get(a.doc) ?? [];
    const max = lines.length || 1;
    const from = Math.min(Math.max(1, Number(a.from) || 1), max);
    const to = Math.min(Math.max(from, Number(a.to) || from), max);
    const pickRef = { doc: a.doc, start: from, end: to };
    const chosen = () => (a.mode === "pick" ? (a.doc ? pickRef : null) : parseRef(a.typed));
    const labelFor = (r) => (r ? `Link ${formatRef(r)} to this issue` : "Link to this issue");
    const err = h("p", { class: "danger-text", id: "add-err", role: "alert", hidden: true });

    const addBtn = h("button", {
      type: "button",
      class: "btn btn-lg",
      "aria-describedby": "add-err",
      "data-fk": "add-go",
      onclick: () =>
        run(async () => {
          const r = chosen();
          const fail = (m) => {
            err.textContent = m;
            err.hidden = false;
          };
          err.hidden = true;
          if (!r) return fail("Enter a reference like D011:4-5.");
          await loadDocs();
          if (!st.docs.some((d) => d.id === r.doc)) {
            return fail(`${r.doc} isn’t a document shared with Claude, so it can’t be linked.`);
          }
          await loadLines(r.doc);
          const n = st.docLines.get(r.doc)?.length ?? 0;
          if (r.end > n) return fail(`${r.doc} has ${plural(n, "line")}.`);
          const source = `${r.doc}:${r.start}${r.end !== r.start ? `-${r.end}` : ""}`;
          const out = await api("POST", `/api/issues/${issue.id}/evidence`, {
            source,
            stance: a.stance,
            ...(a.note.trim() ? { note: a.note.trim() } : {}),
          });
          const stance = STANCE_LABEL[a.stance];
          a.note = "";
          a.typed = "";
          st.focusAfter = "add-go";
          await reload();
          const msg = `Linked ${formatRef(r)} to ${name} as “${stance}”.`;
          announce(msg);
          showToast(msg, {
            undo: () =>
              run(async () => {
                // Not a hard delete: it goes to Removed items, where it can be restored.
                await api("POST", `/api/evidence/${out.id}/remove`);
                await reload();
                showToast("Removed the link you just added. It’s in Removed items.");
              }),
          });
        }),
    }, labelFor(chosen()));

    const numberField = (label, value, key, fk) =>
      Field({
        label,
        control: h("input", {
          type: "number",
          min: "1",
          max: String(max),
          value: String(value),
          class: "iss-num",
          "data-fk": fk,
          onchange: (e) => {
            a[key] = Number(e.target.value) || 1;
            if (key === "from" && Number(a.to) < a.from) a.to = a.from;
            st.focusAfter = fk;
            render();
          },
        }),
      });

    let chooser;
    if (a.mode === "type") {
      chooser = Field({
        label: "Reference, for example D011:4–5",
        control: h("input", {
          type: "text",
          class: "mono",
          value: a.typed,
          placeholder: "D011:4-5",
          "data-fk": "add-typed",
          oninput: (e) => {
            a.typed = e.target.value;
            addBtn.textContent = labelFor(parseRef(a.typed));
          },
        }),
      });
    } else if (st.docs === null) {
      chooser = h("p", { class: "muted" }, "Loading documents…");
    } else if (!st.docs.length) {
      chooser = h("p", { class: "muted" }, "No documents are shared with Claude yet.");
    } else {
      chooser = h(
        "div",
        { class: "vstack" },
        h(
          "div",
          { class: "hstack iss-pick" },
          Field({
            label: "Document",
            control: h(
              "select",
              {
                "data-fk": "add-doc",
                class: "iss-docpick",
                onchange: async (e) => {
                  a.doc = e.target.value;
                  a.from = 1;
                  a.to = 1;
                  await loadLines(a.doc);
                  st.focusAfter = "add-doc";
                  render();
                },
              },
              st.docs.map((d) =>
                h("option", { value: d.id, selected: d.id === a.doc }, `${d.id} · ${d.title}`)
              ),
            ),
          }),
          numberField("From line", from, "from", "add-from"),
          numberField("To line", to, "to", "add-to"),
        ),
        a.doc && lines.length
          ? h(
            "div",
            { class: "vstack gap-sm" },
            h(
              "p",
              { class: "small", role: "status" },
              "Lines you’re linking: ",
              h("span", { class: "mono" }, formatRef(pickRef)),
              ` (${lineRange(from, to)} of ${max})`,
            ),
            SourcePanel({
              doc: a.doc,
              title: st.docs.find((d) => d.id === a.doc)?.title ?? "",
              start: from,
              end: to,
              lines,
              mode: "real",
            }),
          )
          : h("p", { class: "muted" }, "Loading lines…"),
      );
    }

    return h(
      "section",
      { class: "iss-panel", "aria-labelledby": "add-h" },
      h("h3", { id: "add-h" }, "Add evidence yourself"),
      Segmented({
        label: "How to choose the lines",
        value: a.mode,
        options: [
          { id: "pick", label: "Link selected lines…" },
          { id: "type", label: "Type a reference" },
        ],
        onChange: (m) => {
          a.mode = m;
          st.focusAfter = m === "pick" ? "add-doc" : "add-typed";
          render();
        },
      }),
      chooser,
      h(
        "fieldset",
        { class: "iss-stance-pick" },
        h("legend", { class: "small muted" }, "What this evidence does"),
        h(
          "div",
          { class: "hstack" },
          STANCES.map((s) =>
            h(
              "label",
              { class: "iss-radio" },
              h("input", {
                type: "radio",
                name: "add-stance",
                value: s.id,
                checked: a.stance === s.id,
                onchange: () => (a.stance = s.id),
              }),
              h("span", {}, s.label),
            )
          ),
        ),
      ),
      Field({
        label: "Your note (optional)",
        control: h("textarea", {
          rows: "2",
          value: a.note,
          oninput: (e) => (a.note = e.target.value),
        }),
      }),
      h("div", {}, addBtn),
      err,
      h(
        "p",
        { class: "muted small" },
        "Evidence you add is yours, so it doesn’t need checking.",
      ),
    );
  };

  // ── remove an issue ────────────────────────────────────────────────────────

  const removeIssueBar = (issue) => {
    const name = txt(issue.title);
    const drafts = draftsUsing(issue.usedIn);
    return ConfirmBar({
      title: `Remove the issue “${name}”?`,
      summary: `The issue and its ${
        plural(issue.evidence.length, "evidence link")
      } move to Removed items, where you can restore them. No document changes.`,
      detail: drafts.length
        ? h(
          "p",
          { class: "attn-text" },
          Icon("dot"),
          ` Its evidence is used in ${draftList(drafts)}.`,
        )
        : null,
      confirmLabel: "Remove issue",
      onConfirm: () =>
        run(async () => {
          await api("POST", `/api/issues/${issue.id}/remove`);
          st.confirm = null;
          st.sel = null;
          st.focusAfter = "issue-h";
          await reload();
          const msg = `Removed the issue “${name}”.`;
          announce(msg);
          showToast(msg, {
            undo: () =>
              run(async () => {
                await api("POST", `/api/issues/${issue.id}/restore`);
                st.sel = issue.id;
                await reload();
                showToast("The issue is back.");
              }),
          });
        }),
      onCancel: () => {
        st.confirm = null;
        st.focusAfter = "issue-remove";
        render();
      },
    });
  };

  const issueMain = () => {
    if (!st.issues.length) {
      return h(
        "div",
        { class: "col-main iss-main" },
        h("h2", { id: "issue-h", class: "sr", tabindex: "-1" }, "No issues"),
        EmptyState({
          message:
            "No issues yet. Claude adds them as it reads the shared documents, or you can add one.",
          action: h("button", { type: "button", class: "btn", onclick: newIssue }, "+ New issue"),
        }),
      );
    }
    const issue = st.issues.find((i) => i.id === st.sel) ?? st.issues[0];
    st.sel = issue.id;
    return h(
      "div",
      { class: "col-main iss-main", role: "region", "aria-labelledby": "issue-h" },
      h(
        "section",
        { class: "vstack" },
        h(
          "div",
          { class: "hstack between" },
          h("h2", { id: "issue-h", class: "iss-title", tabindex: "-1" }, rich(issue.title, st.hl)),
          h(
            "span",
            { class: "hstack" },
            h("button", {
              type: "button",
              class: "btn",
              "aria-label": `Edit the title and description of issue ${txt(issue.title)}`,
              "data-fk": "issue-edit",
              onclick: () => editIssue(issue),
            }, "Edit…"),
            h("button", {
              type: "button",
              class: "btn",
              "aria-label": `Remove the issue ${txt(issue.title)}`,
              "data-fk": "issue-remove",
              onclick: () => {
                st.confirm = { type: "issue", id: issue.id };
                st.focusAfter = "confirm";
                render();
              },
            }, "Remove issue…"),
          ),
        ),
        st.confirm?.type === "issue" && st.confirm.id === issue.id ? removeIssueBar(issue) : null,
        descPanel(issue),
        withheldNote(issue),
        usedInRow(issue),
      ),
      h(
        "p",
        { class: "iss-guidance" },
        "“Helps your account” and “Points the other way” describe what each piece of evidence says, not who is right. Keep the evidence that points the other way: you may need to answer it, and the Court expects a fair account.",
      ),
      stanceGroups(issue),
      notesPanel(issue),
      addPanel(issue),
    );
  };

  // ── removed items ──────────────────────────────────────────────────────────

  const removedMain = () => {
    const restore = (path, msg) =>
      run(async () => {
        await api("POST", path);
        st.focusAfter = "removed-h";
        await reload();
        announce(msg);
        showToast(msg);
      });
    const row = (main_, sub, btn) =>
      h("li", {}, h("span", { class: "vstack gap-sm" }, main_, sub), btn);
    return h(
      "div",
      { class: "col-main iss-main", role: "region", "aria-labelledby": "removed-h" },
      h("h2", { id: "removed-h", class: "iss-title", tabindex: "-1" }, "Removed items"),
      h(
        "p",
        { class: "iss-guidance" },
        "Issues and evidence links you removed. They are no longer part of the case for Claude or your drafts. Restore puts them back as they were.",
      ),
      h(
        "section",
        { class: "vstack", "aria-labelledby": "rm-issues-h" },
        h("h3", { id: "rm-issues-h" }, "Issues"),
        st.removedIssues.length
          ? h(
            "ul",
            { class: "iss-removed" },
            st.removedIssues.map((i) =>
              row(
                h("strong", {}, txt(i.title)),
                h("span", { class: "muted small" }, plural(i.evidence.length, "evidence link")),
                h("button", {
                  type: "button",
                  class: "btn",
                  "aria-label": `Restore the issue ${txt(i.title)}`,
                  onclick: () =>
                    restore(`/api/issues/${i.id}/restore`, `Restored the issue “${txt(i.title)}”.`),
                }, "Restore"),
              )
            ),
          )
          : h("p", { class: "muted" }, "No removed issues."),
      ),
      h(
        "section",
        { class: "vstack", "aria-labelledby": "rm-ev-h" },
        h("h3", { id: "rm-ev-h" }, "Evidence links"),
        st.removedEvidence.length
          ? h(
            "ul",
            { class: "iss-removed" },
            st.removedEvidence.map((e) =>
              row(
                h(
                  "span",
                  {},
                  h("a", { class: "mono", href: refHref(e) }, formatRef(e)),
                  ` · ${STANCE_LABEL[stanceOf(e)]} · ${e.issueTitle ?? ""}`,
                ),
                e.note?.text ? h("span", { class: "muted small" }, e.note.text) : null,
                h("button", {
                  type: "button",
                  class: "btn",
                  "aria-label": `Restore evidence ${formatRef(e)} to ${
                    e.issueTitle ?? "its issue"
                  }`,
                  onclick: () =>
                    restore(`/api/evidence/${e.id}/restore`, `Linked ${formatRef(e)} again.`),
                }, "Restore"),
              )
            ),
          )
          : h("p", { class: "muted" }, "No removed evidence links."),
      ),
    );
  };

  // ── edit an issue or an evidence link ─────────────────────────────────────

  /** What a save does to a check, said before the user saves. */
  const editNote = (byClaude, state) =>
    byClaude && state === "checked"
      ? h(
        "p",
        { class: "attn-text" },
        Icon("dot"),
        " Saving a change sends it back to To check, so you check the new wording against the source.",
      )
      : null;

  async function editIssue(issue) {
    const title = h("input", { type: "text", value: txt(issue.title) });
    const desc = h("textarea", { rows: "4" });
    desc.value = txt(issue.description);
    const ok = await openDialog({
      title: "Edit issue",
      body: [
        h("p", {}, "Use neutral words that don’t assume the answer."),
        Field({ label: "Title", control: title }),
        Field({ label: "Description (optional)", control: desc }),
        editNote(issue.created_by === "claude", issue.descState),
      ],
      actions: [
        { label: "Cancel", value: false },
        { label: "Save changes", value: true, variant: "primary" },
      ],
    });
    if (!ok) {
      st.focusAfter = "issue-edit";
      render();
      return;
    }
    const t = title.value.trim();
    if (!t) {
      showToast("An issue needs a title.", { tone: "danger" });
      return;
    }
    await run(async () => {
      const r = await api("PATCH", `/api/issues/${issue.id}`, {
        title: t,
        description: desc.value.trim(),
      });
      st.focusAfter = "issue-edit";
      await reload();
      const msg = r?.changed ? `Saved the issue “${t}”.` : "Nothing changed.";
      announce(msg);
      showToast(msg);
    });
  }

  async function editEvidence(issue, e) {
    const ref = formatRef(e);
    const note = h("textarea", { rows: "3" });
    note.value = txt(e.note);
    let stance = stanceOf(e);
    const ok = await openDialog({
      title: `Edit evidence ${ref}`,
      body: [
        h(
          "fieldset",
          { class: "iss-stance-pick" },
          h("legend", { class: "small muted" }, "What this evidence does"),
          h(
            "div",
            { class: "hstack" },
            STANCES.map((s) =>
              h(
                "label",
                { class: "iss-radio" },
                h("input", {
                  type: "radio",
                  name: `edit-stance-${e.id}`,
                  value: s.id,
                  checked: stance === s.id,
                  onchange: () => (stance = s.id),
                }),
                h("span", {}, s.label),
              )
            ),
          ),
        ),
        Field({
          label: e.created_by === "claude" ? "Note (Claude’s, edited by you)" : "Your note",
          control: note,
        }),
        editNote(e.created_by === "claude", e.state),
      ],
      actions: [
        { label: "Cancel", value: false },
        { label: "Save changes", value: true, variant: "primary" },
      ],
    });
    st.focusAfter = `ev-edit-${e.id}`;
    if (!ok) {
      render();
      return;
    }
    await run(async () => {
      const r = await api("PATCH", `/api/evidence/${e.id}`, { note: note.value.trim(), stance });
      await reload();
      const msg = r?.changed ? `Saved evidence ${ref} on ${txt(issue.title)}.` : "Nothing changed.";
      announce(msg);
      showToast(msg);
    });
  }

  // ── new issue ──────────────────────────────────────────────────────────────

  async function newIssue() {
    const title = h("input", { type: "text" });
    const desc = h("textarea", { rows: "3" });
    const ok = await openDialog({
      title: "New issue",
      body: [
        h(
          "p",
          {},
          "A question the Court will decide. Use neutral words that don’t assume the answer.",
        ),
        Field({ label: "Title", control: title }),
        Field({ label: "Description (optional)", control: desc }),
      ],
      actions: [
        { label: "Cancel", value: false },
        { label: "Add issue", value: true, variant: "primary" },
      ],
    });
    if (!ok) return;
    const t = title.value.trim();
    if (!t) {
      showToast("An issue needs a title.", { tone: "danger" });
      return;
    }
    await run(async () => {
      const out = await api("POST", "/api/issues", { title: t, description: desc.value.trim() });
      st.sel = out.id;
      st.mode = "issues";
      st.focusAfter = "issue-h";
      history.replaceState(null, "", `#/issues/${out.id}`);
      await reload();
      announce(`Added the issue “${t}”.`);
    });
  }

  // ── render ─────────────────────────────────────────────────────────────────

  const restoreFocus = (key) => {
    if (!key) return;
    const el = key === "confirm"
      ? main.querySelector(".confirmbar .btn-primary")
      : main.querySelector(`[data-fk="${key}"]`) ?? main.querySelector(`#${key}`);
    if (el instanceof HTMLElement) el.focus();
  };

  const keyEntries = () =>
    (st.entities ?? [])
      .filter((e) => Number.isInteger(e.colour))
      .map((e) => ({
        role: e.role,
        name: e.forms?.full ?? e.role,
        kind: e.kind,
        colour: e.colour,
      }));

  function render() {
    const active = document.activeElement;
    const fk = st.focusAfter ??
      (active instanceof HTMLElement && main.contains(active) ? active.dataset.fk : null);
    st.focusAfter = null;
    linker?.destroy();
    linker = null;

    const toggle = Toggle({
      label: "Highlight people",
      pressed: st.hl,
      onChange: async (on) => {
        st.hl = on;
        if (on && !st.entities) st.entities = await listPeople().catch(() => []);
        st.focusAfter = "hl";
        render();
      },
    });
    toggle.dataset.fk = "hl";
    const parts = [
      h(
        "div",
        { class: "page-head" },
        h("h1", {}, "Issues"),
        h(
          "span",
          { class: "muted" },
          "The questions the Court will decide, and the evidence on each",
        ),
        h("span", { class: "spacer" }),
        toggle,
      ),
      st.hl
        ? Key({
          entries: keyEntries(),
          help:
            "Parents and children have their own colour; everyone else is plain ink. Point at or tab to a name to see everywhere it appears; click to keep it highlighted.",
        })
        : null,
      h(
        "div",
        { class: ["columns iss-columns", !st.hl && "ent-plain"] },
        issueList(),
        st.mode === "removed" ? removedMain() : issueMain(),
      ),
    ];
    main.replaceChildren(...parts.filter(Boolean));
    if (st.hl) linker = linkEntities(main);
    restoreFocus(fk);
  }

  await load();
  if (st.sel === null && params.id) history.replaceState(null, "", "#/issues");
  render();
  // The picker needs the document list; load it after the first paint.
  loadDocs()
    .then(() => loadLines(st.add.doc))
    .then(() => {
      if (main.isConnected && st.mode === "issues") render();
    })
    .catch(() => {});
}
