// People (W2-3): who's who grouped People · Places & organisations · Numbers & dates, and one
// entry's detail: the label Claude sees (rename everywhere), the relationship description Claude
// reads, the safety-sensitive flag, a colour slot, the ways the name is written, other names
// (nicknames, with their impact and Undo), where the entry appears, merging it into another entry
// and no longer replacing it (ADR 25). "Tidy up" lists suggested merges, labels and removals from
// casefile's rules and the language model set up under Finding names; each is accepted or not.
//
// APIs (src/app/routes/entities.ts): GET /api/people, GET|PATCH /api/entities/:role,
// GET /api/entities/:role/usage, GET /api/entities/:role/alias-impact?alias=,
// POST /api/entities/:role/merge, POST /api/entities/:role/remove, POST /api/people/tidy.
import { cls, h, uniqueId } from "../dom.js";
import { api, ApiError, errorText } from "../lib.js";
import {
  announce,
  Badge,
  Button,
  Callout,
  ConfirmBar,
  EmptyState,
  EntityDot,
  Segments,
  ShieldIcon,
  showToast,
  TokenChip,
} from "../components/index.js";
import {
  andList,
  capitalise,
  colourClass,
  formatDay,
  plural,
  tokenisedFrom,
  tokenText,
} from "../model.js";

const PAGE = 8;
const CAP = 5; // rows shown per "Where they appear" group before "Show all"

const GROUPS = [
  { id: "people", label: "People", all: "people" },
  { id: "places", label: "Places & organisations", all: "places and organisations" },
  { id: "numbers", label: "Numbers & dates", all: "numbers and dates" },
];

const SLOT_NAMES = ["Pink", "Blue", "Green", "Pear", "Sky", "Sand"];

const ID_LABELS = {
  phone: "Phone",
  email: "Email",
  address: "Address",
  dob: "Date of birth",
  medicare: "Medicare number",
  tfn: "Tax file number",
  abn: "ABN",
  acn: "ACN",
  file_number: "Court file number",
  licence: "Licence number",
  passport: "Passport number",
  crn: "Centrelink reference number",
  id: "Identifier",
};

const FORMS = [
  { key: "full", label: "Full name" },
  { key: "first", label: "First name" },
  { key: "surname", label: "Surname" },
  { key: "title", label: "Title + surname" },
];

/** Safety-sensitive values the user has chosen to show, for this visit to the app. */
const revealed = new Set();

/** The search and each group's page, kept while moving between entries. */
const listState = { q: "", offsets: { people: 0, places: 0, numbers: 0 } };

// ── small helpers (people-only) ─────────────────────────────────────────────────

const isPerson = (e) => e.kind === "person";
/**
 * Safety-sensitive numbers and addresses stay hidden on screen until the user shows them: their
 * own flag, or that of the person they belong to (`safetyVia`, ADR 15 amendment 3).
 */
const isSafe = (e) => e.safety || Boolean(e.safetyVia);
const isHidden = (e) => isSafe(e) && e.group === "numbers" && !revealed.has(e.role);

/** The kind line for an entry: "person", "school", "Phone", "Medicare number". */
function kindLabel(e) {
  if (e.group === "numbers") return ID_LABELS[e.idType ?? "id"] ?? "Identifier";
  return e.kind;
}

// ── the view ────────────────────────────────────────────────────────────────

/** @param {HTMLElement} main @param {Record<string, string>} params @param {object} _ctx */
export default async function view(main, params, _ctx) {
  const all = await api("GET", "/api/people");
  if (!all.entities.length) {
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", {}, "Who’s who")),
      h(
        "div",
        { class: "page-body" },
        EmptyState({
          message:
            "No people, places or numbers yet. casefile adds them when you review a document.",
          action: h("a", { class: "btn", href: "#/docs" }, "Go to Documents"),
        }),
      ),
    );
    return;
  }
  const byRole = new Map(all.entities.map((e) => [e.role, e]));
  let role = params.role && byRole.has(params.role) ? params.role : null;
  if (!role) {
    role = (all.entities.find((e) => e.group === "people") ?? all.entities[0]).role;
    history.replaceState(null, "", `#/people/${encodeURIComponent(role)}`);
  }

  const listHost = h("div", { class: "people-groups" });
  const status = h("div", { class: "people-result", role: "status" });
  const detail = h("div", { class: "people-detail" });
  const search = h("input", {
    type: "search",
    id: "people-q",
    class: "people-search-input",
    value: listState.q,
    placeholder: "Search people, places, numbers",
    autocomplete: "off",
  });
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      listState.q = search.value.trim();
      for (const g of GROUPS) listState.offsets[g.id] = 0;
      renderList();
    }, 200);
  });

  const total = all.groups.people + all.groups.places + all.groups.numbers;
  const aside = h(
    "aside",
    { class: "people-list", "aria-labelledby": "people-list-h" },
    h(
      "div",
      { class: "people-list-head" },
      h(
        "h2",
        { id: "people-list-h", class: "people-list-title" },
        "Who’s who ",
        h("span", { class: "people-list-total" }, `· ${total}`),
      ),
      h(
        "label",
        { class: "people-search", for: "people-q" },
        h("span", { class: "sr" }, "Search people, places and numbers"),
        search,
      ),
      status,
    ),
    listHost,
  );
  // Details whose label reads as someone's but aren't linked to anyone (security review): the
  // user confirms each link; casefile never makes it. "Not now" hides one for this visit only.
  const suggestHost = h("div", { class: "people-suggest" });
  const DISMISS_KEY = "casefile.people.linkSuggestionsDismissed";
  const dismissed = () => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  };
  const dismiss = (r) => {
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed(), r]));
    } catch {
      // no storage: it shows again next time
    }
  };
  function renderSuggestions(list) {
    const skip = dismissed();
    const items = (list ?? []).filter((x) => !skip.has(x.role) && byRole.has(x.person));
    if (!items.length) return suggestHost.replaceChildren();
    suggestHost.replaceChildren(Callout({
      tone: items.some((x) => x.safety) ? "attention" : "info",
      title: items.length === 1
        ? "Is this detail someone’s?"
        : `Are these ${items.length} details someone’s?`,
      children: [
        h(
          "p",
          {},
          "Their labels read as someone’s, but they aren’t linked to anyone. Link each one so casefile treats it as that person’s: a safety-sensitive person’s details are then protected everywhere, not only on export.",
        ),
        h(
          "ul",
          { class: "people-suggest-list" },
          items.map((x) => {
            const who = byRole.get(x.person)?.forms.full ?? x.person;
            const ent = byRole.get(x.role);
            return h(
              "li",
              { class: "hstack people-suggest-row" },
              TokenChip({ role: x.role, kind: ent?.kind ?? "other", colour: null }),
              h(
                "span",
                { class: "grow" },
                `${ent ? capitalise(kindLabel(ent)) : "Detail"} that looks like ${who}’s`,
                x.safety ? " (safety-sensitive)" : "",
              ),
              Button(`Link to ${who}`, {
                "aria-label": `Link ${x.role} to ${who}`,
                onclick: async (ev) => {
                  const b = ev.currentTarget;
                  try {
                    await patch({ relatedTo: x.person }, x.role);
                  } catch (e) {
                    // e.g. its label would give part of the value away once it is protected:
                    // the message says to rename it first.
                    showToast(e?.message ?? String(e), { tone: "danger", returnFocus: b });
                    return;
                  }
                  announce(`Linked to ${who}.`);
                  const fresh = await api("GET", "/api/people");
                  renderSuggestions(fresh.linkSuggestions);
                  await refresh();
                  suggestHost.querySelector("button")?.focus() ??
                    document.querySelector("main h1")?.focus();
                },
              }),
              Button("Not now", {
                variant: "quiet",
                "aria-label": `Not now: ${x.role}`,
                onclick: () => {
                  dismiss(x.role);
                  renderSuggestions(list);
                  announce("Hidden for now. Export still warns about it.");
                  suggestHost.querySelector("button")?.focus() ??
                    document.querySelector("main h1")?.focus();
                },
              }),
            );
          }),
        ),
      ],
    }));
  }
  renderSuggestions(all.linkSuggestions);

  // ── tidy up (ADR 25) ──────────────────────────────────────────────────────

  const tidyHost = h("div", { class: "people-tidy", id: "people-tidy" });
  /** A name to show for an entry: its label when it is a hidden safety-sensitive detail. */
  const nameOf = (r) => {
    const e = byRole.get(r);
    if (!e) return tokenText(r);
    return isHidden(e) ? `Hidden ${kindLabel(e).toLowerCase()}` : e.forms.full;
  };
  const chip = (r) =>
    TokenChip({ role: r, kind: byRole.get(r)?.kind ?? "other", colour: byRole.get(r)?.colour });

  async function runTidy(ev) {
    const b = ev?.currentTarget;
    if (b) b.disabled = true;
    tidyHost.replaceChildren(
      h("p", { class: "muted", role: "status" }, "Looking through who’s who…"),
    );
    try {
      const r = await api("POST", "/api/people/tidy", {});
      // Names for the suggestions come from who's who as it is now.
      await refresh();
      renderTidy(r.suggestions, r.llm);
    } catch (x) {
      tidyHost.replaceChildren(
        Callout({ tone: "danger", title: "Couldn’t tidy up", children: errorText(x) }),
      );
    } finally {
      if (b) b.disabled = false;
    }
  }

  function tidyLine(x) {
    if (x.type === "merge") {
      return [
        chip(x.from),
        ` ${nameOf(x.from)} is the same as `,
        chip(x.into),
        ` ${nameOf(x.into)}`,
      ];
    }
    if (x.type === "rename") {
      return ["Call ", chip(x.role), ` ${nameOf(x.role)} `, h("code", {}, `{{${x.to}}}`)];
    }
    return ["Stop replacing ", chip(x.role), ` ${nameOf(x.role)}: leave it as written`];
  }

  async function acceptTidy(x) {
    if (x.type === "merge") {
      await api("POST", `/api/entities/${encodeURIComponent(x.from)}/merge`, { into: x.into });
      return `Merged ${tokenText(x.from)} into ${tokenText(x.into)}.`;
    }
    if (x.type === "rename") {
      const r = await patch({ role: x.to }, x.role);
      return `Renamed ${tokenText(x.role)} to ${tokenText(r.role)} everywhere.`;
    }
    await api("POST", `/api/entities/${encodeURIComponent(x.role)}/remove`, { reason: x.why });
    return `casefile no longer replaces ${tokenText(x.role)}.`;
  }

  function renderTidy(list, llm) {
    let items = [...list];
    const draw = () => {
      const note = llm?.error
        ? h("p", { class: "muted" }, `Only casefile’s own rules were used. ${llm.error}`)
        : llm?.ran
        ? h(
          "p",
          { class: "muted" },
          "From casefile’s rules and the language model on this computer. Check each one: they are suggestions.",
        )
        : null;
      if (!items.length) {
        tidyHost.replaceChildren(Callout({
          tone: "info",
          title: "Nothing to tidy",
          children: [
            h(
              "p",
              {},
              "casefile found no duplicates, unclear labels or entries that identify no one.",
            ),
            note,
          ],
        }));
        return;
      }
      tidyHost.replaceChildren(Callout({
        tone: "info",
        title: `${plural(items.length, "suggestion")} to tidy who’s who`,
        children: [
          h(
            "p",
            {},
            "Merging and renaming update every document and Claude’s notes. Items you checked that change will need checking again.",
          ),
          note,
          h(
            "ul",
            { class: "people-suggest-list" },
            items.map((x, i) =>
              h(
                "li",
                { class: "people-tidy-row" },
                h(
                  "div",
                  { class: "hstack people-suggest-row" },
                  h("span", { class: "grow" }, ...tidyLine(x)),
                ),
                x.why ? h("p", { class: "muted people-tidy-why" }, x.why) : null,
                h(
                  "div",
                  { class: "hstack" },
                  Button(
                    x.type === "merge"
                      ? "Merge"
                      : x.type === "rename"
                      ? "Rename"
                      : "Stop replacing",
                    {
                      id: `tidy-${i}`,
                      onclick: async (ev) => {
                        const b = ev.currentTarget;
                        b.disabled = true;
                        try {
                          const msg = await acceptTidy(x);
                          announce(msg);
                          showToast(msg);
                        } catch (e) {
                          b.disabled = false;
                          showToast(errorText(e), { tone: "danger", returnFocus: b });
                          return;
                        }
                        // Later suggestions may name an entry that has just gone or been renamed.
                        const gone = x.type === "merge" ? x.from : x.role;
                        items = items.filter((y) =>
                          y !== x && ![y.from, y.into, y.role].includes(gone)
                        );
                        if (role === gone) {
                          role = x.type === "merge" ? x.into : x.type === "rename" ? x.to : null;
                          history.replaceState(
                            null,
                            "",
                            role ? `#/people/${encodeURIComponent(role)}` : "#/people",
                          );
                        }
                        await refresh();
                        if (!role || !byRole.has(role)) {
                          role = all.entities[0]?.role ?? null;
                          if (role) await renderDetail();
                        }
                        draw();
                        tidyHost.querySelector("button")?.focus();
                      },
                    },
                  ),
                  Button("Not now", {
                    variant: "quiet",
                    onclick: () => {
                      items = items.filter((y) => y !== x);
                      draw();
                      tidyHost.querySelector("button")?.focus();
                    },
                  }),
                ),
              )
            ),
          ),
        ],
      }));
    };
    draw();
  }

  main.replaceChildren(
    suggestHost,
    h(
      "div",
      { class: "hstack people-tidy-bar" },
      Button("Tidy up who’s who", { id: "people-tidy-run", onclick: runTidy }),
      h(
        "span",
        { class: "muted" },
        "Find duplicates, unclear labels and entries that identify no one.",
      ),
    ),
    tidyHost,
    h("div", { class: "people" }, aside, detail),
  );

  // ── the list ──────────────────────────────────────────────────────────────

  async function renderList() {
    const q = listState.q;
    const pages = await Promise.all(GROUPS.map((g) => {
      const sp = new URLSearchParams({
        group: g.id,
        offset: String(listState.offsets[g.id]),
        limit: String(PAGE),
      });
      if (q) sp.set("q", q);
      return api("GET", `/api/people?${sp}`);
    }));
    const c = pages[0].groups;
    const n = c.people + c.places + c.numbers;
    status.textContent = q
      ? `${plural(n, "match", "matches")} for “${q}”`
      : `${plural(c.people, "person", "people")} · ${
        plural(c.places, "place or organisation", "places and organisations")
      } · ${plural(c.numbers, "number or date", "numbers and dates")}`;
    listHost.replaceChildren(...GROUPS.map((g, i) => groupSection(g, pages[i])));
  }

  function groupSection(g, page) {
    const hid = `people-g-${g.id}`;
    const from = page.offset;
    const shown = page.entities.length;
    const turn = (offset) => {
      listState.offsets[g.id] = offset;
      renderList().then(() => document.getElementById(`${hid}-s`)?.querySelector("a")?.focus());
    };
    const pager = page.total > PAGE
      ? h(
        "div",
        { class: "people-pager" },
        h(
          "span",
          { class: "num muted" },
          shown ? `${from + 1}–${from + shown} of ${page.total}` : `0 of ${page.total}`,
        ),
        h("span", { class: "spacer" }),
        Button("Previous", {
          disabled: from === 0,
          "aria-label": `Previous ${g.all}`,
          onclick: () => turn(Math.max(0, from - PAGE)),
        }),
        Button("Next", {
          disabled: from + PAGE >= page.total,
          "aria-label": `Next ${g.all}`,
          onclick: () => turn(from + PAGE),
        }),
      )
      : null;
    return h(
      "section",
      { class: "people-group", "aria-labelledby": hid, id: `${hid}-s` },
      h("h3", { id: hid, class: "eyebrow people-group-title" }, `${g.label} · ${page.total}`),
      shown
        ? h("ul", { class: "people-rows" }, page.entities.map((e) => h("li", {}, entryRow(e))))
        : h("p", { class: "muted people-none" }, listState.q ? "No matches" : "None yet"),
      pager,
    );
  }

  function entryRow(e) {
    const hidden = isHidden(e);
    const sub = e.group === "numbers"
      ? `${kindLabel(e)}${isSafe(e) ? " · safety-sensitive" : ""}`
      : isSafe(e)
      ? "Safety-sensitive"
      : null;
    return h(
      "a",
      {
        href: `#/people/${encodeURIComponent(e.role)}`,
        class: "people-row",
        "aria-current": e.role === role ? "page" : null,
      },
      EntityDot(e),
      h(
        "span",
        { class: "people-row-name" },
        h(
          "span",
          {
            class: cls(
              "people-row-label",
              e.group === "numbers" && !hidden && "mono",
              hidden && "muted",
            ),
          },
          hidden ? `Hidden ${kindLabel(e).toLowerCase()}` : e.forms.full,
        ),
        sub ? h("span", { class: "people-row-sub" }, sub) : null,
      ),
      TokenChip({ role: e.role, kind: e.kind, colour: e.colour }),
      h("span", { class: "num muted people-row-docs" }, plural(e.docs, "doc")),
    );
  }

  // ── the detail ────────────────────────────────────────────────────────────

  /** Re-read everything (an entry's role, counts and document states can all change). */
  async function refresh(focusId) {
    const fresh = await api("GET", "/api/people");
    all.entities = fresh.entities;
    all.palette = fresh.palette;
    byRole.clear();
    for (const e of fresh.entities) byRole.set(e.role, e);
    await Promise.all([renderList(), renderDetail()]);
    if (focusId) document.getElementById(focusId)?.focus();
  }

  async function renderDetail() {
    if (!byRole.has(role)) return;
    const [e, usage] = await Promise.all([
      api("GET", `/api/entities/${encodeURIComponent(role)}`),
      api("GET", `/api/entities/${encodeURIComponent(role)}/usage`),
    ]);
    byRole.set(e.role, e);
    detail.replaceChildren(...detailParts(e, usage));
  }

  /** PATCH this entry, and tell the user about any description casefile had to withdraw. */
  async function patch(body, of = role) {
    const r = await api("PATCH", `/api/entities/${encodeURIComponent(of)}`, body);
    if (r.descriptionsCleared?.length) {
      const names = r.descriptionsCleared.map((x) => byRole.get(x)?.forms.full ?? tokenText(x));
      showToast(
        `casefile removed the description of ${
          andList(names, 6)
        } because it now contains a name. Claude may already have read it; write a new one without names.`,
        { tone: "danger", timeout: 0 },
      );
    }
    // Text already in Claude's copy that showed a value just added (ADR 27): the user's own text
    // now has it replaced; the rest (Claude's work, or text casefile can't tell is yours) is listed.
    const tt = r.typedText;
    if (tt && (tt.replaced.length || tt.left.length)) {
      const parts = [];
      if (tt.replaced.length) {
        parts.push(`Replaced in ${andList(tt.replaced.map((x) => x.label), 4)}, which you wrote.`);
      }
      if (tt.left.length) {
        parts.push(
          `Still written as is in ${andList(tt.left.map((x) => x.label), 4)}: Claude wrote ${
            tt.left.length === 1 ? "it" : "them"
          }, or casefile can’t tell you did, so casefile hasn’t changed ${
            tt.left.length === 1 ? "it" : "them"
          }. Claude can read ${tt.left.length === 1 ? "it" : "them"}; edit or remove ${
            tt.left.length === 1 ? "it" : "them"
          } if you need to.`,
        );
      }
      showToast(parts.join(" "), { tone: tt.left.length ? "danger" : undefined, timeout: 0 });
    }
    return r;
  }

  function detailParts(e, usage) {
    const hidden = isHidden(e);
    return [
      h(
        "div",
        { class: "people-head" },
        h("span", { class: cls("people-swatch", colourClass(e)), "aria-hidden": "true" }),
        h("h1", {}, hidden ? `Hidden ${kindLabel(e).toLowerCase()}` : e.forms.full),
        h(
          "span",
          { class: "muted" },
          `${kindLabel(e)} · in ${plural(e.docs, "document")} · ${plural(e.mentions, "mention")}`,
        ),
        isSafe(e)
          ? h(
            "span",
            { class: "tag people-safety-tag" },
            ShieldIcon(),
            e.safety ? "Safety-sensitive" : `Safety-sensitive: ${ownerName(e.safetyVia)}’s`,
          )
          : null,
        isSafe(e) && e.group === "numbers"
          ? Button(hidden ? `Show ${kindLabel(e).toLowerCase()}` : "Hide again", {
            id: "people-reveal",
            onclick: () => {
              hidden ? revealed.add(e.role) : revealed.delete(e.role);
              refresh("people-reveal");
            },
          })
          : null,
      ),
      labelSection(e),
      descriptionSection(e),
      safetySection(e),
      isPerson(e) ? linkedSection(e) : ownerSection(e),
      isPerson(e) ? colourSection(e) : null,
      formsSection(e, hidden),
      aliasSection(e, hidden),
      whereSection(e, usage),
      mergeSection(e),
      removeSection(e),
    ].filter(Boolean);
  }

  // The same person or place as another entry: merge into it (ADR 25).
  function mergeSection(e) {
    const others = all.entities.filter((o) => o.role !== e.role)
      .sort((a, b) =>
        Number(b.kind === e.kind) - Number(a.kind === e.kind) || a.role.localeCompare(b.role)
      );
    if (!others.length) return null;
    const panel = h("div", {});
    const select = h(
      "select",
      { id: "people-merge", "aria-describedby": "merge-help" },
      h("option", { value: "" }, "Choose an entry…"),
      others.map((o) => h("option", { value: o.role }, `{{${o.role}}} ${nameOf(o.role)}`)),
    );
    const start = () => {
      const into = select.value;
      if (!into) return select.focus();
      const bar = ConfirmBar({
        title: `Merge into ${tokenText(into)}?`,
        summary: `${tokenText(e.role)} becomes ${
          tokenText(into)
        } in every document, note, chronology entry and draft, and its spellings become other names for ${
          nameOf(into)
        }. Checked items whose text changes will need checking again.`,
        confirmLabel: "Merge",
        onCancel: () => {
          panel.replaceChildren();
          select.focus();
        },
        onConfirm: async () => {
          try {
            await api("POST", `/api/entities/${encodeURIComponent(e.role)}/merge`, { into });
          } catch (x) {
            panel.replaceChildren(h("p", { class: "people-error", role: "alert" }, errorText(x)));
            return;
          }
          const msg = `Merged ${tokenText(e.role)} into ${tokenText(into)}.`;
          announce(msg);
          showToast(msg);
          location.hash = `#/people/${encodeURIComponent(into)}`;
        },
      });
      panel.replaceChildren(bar);
      bar.focusPrimary();
    };
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "merge-h" },
      h("h2", { id: "merge-h" }, "The same as another entry?"),
      h(
        "div",
        { class: "hstack people-alias-row" },
        h("label", { for: "people-merge", class: "sr" }, "Entry to merge into"),
        select,
        Button("Merge…", { onclick: start }),
      ),
      h(
        "p",
        { id: "merge-help" },
        "Use this when one person or place was found twice, for example written “SURNAME, First” in a form.",
      ),
      panel,
    );
  }

  // Identifies no one (a time, a heading): stop replacing it (ADR 25).
  function removeSection(e) {
    if (isSafe(e)) return null;
    const panel = h("div", {});
    const reasons = [
      "It is a time, date or amount",
      "Public figure or organisation",
      "Already public in this case",
      "Other",
    ];
    const select = h(
      "select",
      { id: "people-remove-why" },
      reasons.map((r) => h("option", { value: r }, r)),
    );
    const other = h("input", {
      id: "people-remove-other",
      placeholder: "Why it identifies no one",
      autocomplete: "off",
      hidden: true,
    });
    select.addEventListener("change", () => {
      other.hidden = select.value !== "Other";
    });
    const start = () => {
      const reason = select.value === "Other" ? other.value.trim() : select.value;
      if (!reason) return other.focus();
      const bar = ConfirmBar({
        title: `Stop replacing ${tokenText(e.role)}?`,
        summary: `Claude will see “${
          isHidden(e) ? kindLabel(e).toLowerCase() : e.forms.full
        }” as written wherever it appears, including in its own notes. It leaves who’s who.`,
        confirmLabel: "Stop replacing it",
        danger: true,
        onCancel: () => {
          panel.replaceChildren();
          select.focus();
        },
        onConfirm: async () => {
          try {
            await api("POST", `/api/entities/${encodeURIComponent(e.role)}/remove`, { reason });
          } catch (x) {
            panel.replaceChildren(h("p", { class: "people-error", role: "alert" }, errorText(x)));
            return;
          }
          const msg = `casefile no longer replaces ${tokenText(e.role)}.`;
          announce(msg);
          showToast(msg);
          location.hash = "#/people";
        },
      });
      panel.replaceChildren(bar);
      bar.focusPrimary();
    };
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "remove-h" },
      h("h2", { id: "remove-h" }, "Identifies no one?"),
      h(
        "div",
        { class: "hstack people-alias-row" },
        h("label", { for: "people-remove-why", class: "sr" }, "Why it can be left as written"),
        select,
        h("label", { for: "people-remove-other", class: "sr" }, "Reason"),
        other,
        Button("Stop replacing…", { onclick: start }),
      ),
      h(
        "p",
        {},
        "For something found by mistake, like a time of day. The reason is kept with each document.",
      ),
      panel,
    );
  }

  // How Claude refers to them: the role, renamed everywhere.
  function labelSection(e) {
    const err = h("p", { class: "people-error", id: "role-err", role: "alert" });
    const input = h("input", {
      id: "people-role",
      class: "people-role-input",
      value: e.role,
      spellcheck: "false",
      autocomplete: "off",
      "aria-describedby": "role-help role-err",
    });
    const rename = async () => {
      const to = input.value.trim();
      err.textContent = "";
      if (!to || to === e.role) {
        err.textContent = "Type a new label first.";
        input.focus();
        return;
      }
      try {
        const r = await patch({ role: to });
        const from = e.role;
        const msg = `Renamed ${tokenText(from)} to ${tokenText(r.role)} everywhere.`;
        announce(msg);
        showToast(msg, {
          undo: async () => {
            try {
              await patch({ role: from }, r.role);
              announce(`Renamed back to ${tokenText(from)}`);
              location.hash = `#/people/${encodeURIComponent(from)}`;
            } catch (x) {
              showToast(errorText(x), { tone: "danger" });
            }
          },
        });
        location.hash = `#/people/${encodeURIComponent(r.role)}`;
      } catch (x) {
        err.textContent = errorText(x);
        input.focus();
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        rename();
      }
    });
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "label-h" },
      h("h2", { id: "label-h" }, `How Claude refers to ${isPerson(e) ? "them" : "it"}`),
      h(
        "div",
        { class: "hstack people-role-row" },
        h("label", { for: "people-role", class: "sr" }, "Label Claude sees"),
        h(
          "div",
          { class: cls("people-role-box", colourClass(e)) },
          h("span", { "aria-hidden": "true" }, "{{"),
          input,
          h("span", { "aria-hidden": "true" }, "}}"),
        ),
        Button("Rename everywhere", { size: "lg", onclick: rename }),
      ),
      h(
        "p",
        { id: "role-help" },
        "A relationship, never a name. Renaming updates every document, note and draft.",
      ),
      err,
    );
  }

  // Who they are to the case: the description Claude reads.
  function descriptionSection(e) {
    const current = tokenisedFrom(e.description);
    const input = h("input", {
      id: "people-rel",
      class: "people-rel-input",
      value: current,
      maxlength: "300",
      autocomplete: "off",
      "aria-describedby": "rel-warn rel-help rel-check",
    });
    const check = h("div", { id: "rel-check", class: "people-rel-check" });
    check.append(
      current
        ? h(
          "span",
          { class: "hstack people-checked" },
          h("span", { "aria-hidden": "true" }, "✓"),
          h("span", {}, "casefile checked: no names, places or numbers in this description."),
        )
        : h("span", { class: "muted" }, "No description yet. Claude sees only the label."),
    );
    const save = async () => {
      const v = input.value.replace(/\s+/g, " ").trim();
      if (v === current) {
        announce("No change to save");
        return;
      }
      try {
        await patch({ description: v || null });
        const msg = v
          ? "Description checked and saved. Claude reads it with the label."
          : "Description removed.";
        announce(msg);
        showToast(msg);
        await refresh("people-rel");
      } catch (x) {
        check.replaceChildren(
          Callout({ tone: "danger", title: "Not saved", children: errorText(x) }),
        );
        input.focus();
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        save();
      }
    });
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "rel-h" },
      h("h2", { id: "rel-h" }, isPerson(e) ? "Who they are to the case" : "What it is to the case"),
      h("label", { for: "people-rel" }, "Relationship, shown to Claude with the label"),
      h(
        "p",
        { id: "rel-warn", class: "hstack people-claude-reads" },
        h("span", { class: "tag" }, "Claude reads this"),
        h(
          "span",
          {},
          "So it can’t contain a name, nickname, place, school or number. casefile checks it before saving.",
        ),
      ),
      h(
        "div",
        { class: "hstack people-rel-row" },
        input,
        Button("Save description", { size: "lg", onclick: save }),
      ),
      h(
        "p",
        { id: "rel-help", class: "people-help" },
        `Describe how ${isPerson(e) ? "they fit" : "it fits"} in, so Claude knows who `,
        TokenChip({ role: e.role, kind: e.kind, colour: e.colour }),
        " is. For example: “the mother; the applicant”, “the children’s maternal grandmother”. To mention someone else, type their label, like ",
        h("code", {}, "{{child_1}}"),
        ".",
      ),
      check,
    );
  }

  // Safety-sensitive flag and what it does.
  function safetySection(e) {
    const box = h("input", {
      type: "checkbox",
      id: "people-safety",
      checked: e.safety,
      "aria-describedby": "safe-help",
    });
    box.addEventListener("change", async () => {
      const on = box.checked;
      box.disabled = true;
      try {
        await patch({ safety: on });
        announce(on ? "Marked safety-sensitive" : "No longer safety-sensitive");
        await refresh("people-safety");
      } catch (x) {
        box.checked = !on;
        box.disabled = false;
        showToast(errorText(x), { tone: "danger" });
      }
    });
    const whose = isPerson(e) ? "their" : "its";
    const items = [
      `always replace ${whose} details, with no “Leave as written” option when you review a document`,
      `warn you before an export or a copy that shows ${whose} details`,
      e.group === "numbers"
        ? `hide this ${kindLabel(e).toLowerCase()} on screen until you choose to show it`
        : isPerson(e)
        ? "hide their addresses and numbers (listed under “Their addresses and numbers”) on screen until you choose to show them"
        : "hide any address or number that belongs to it on screen until you choose to show it",
    ];
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "safe-h" },
      h("h2", { id: "safe-h", class: "sr" }, "Safety"),
      h(
        "label",
        { class: "people-check", for: "people-safety" },
        box,
        h("span", { class: "strong" }, "Safety-sensitive (e.g. protected address)"),
      ),
      h(
        "div",
        { id: "safe-help", class: "people-check-help" },
        h(
          "p",
          {},
          isPerson(e)
            ? "Tick this if someone could be put at risk by knowing where they live or work, or where the children go to school. casefile will then:"
            : "Tick this if knowing it could put someone at risk. casefile will then:",
        ),
        h("ul", {}, items.map((t) => h("li", {}, t))),
        h(
          "p",
          { class: "muted" },
          `This doesn’t change what Claude sees: ${whose} details are already replaced.`,
        ),
      ),
    );
  }

  /** A person's name for a label, or the label itself. */
  function ownerName(r) {
    const o = r ? byRole.get(r) : null;
    return o ? o.forms.full : tokenText(r ?? "");
  }

  // A person's details: the addresses and numbers that belong to them (relatedTo).
  function linkedSection(e) {
    const rows = (e.linked ?? []).map((x) => byRole.get(x.role) ?? x);
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "linked-h" },
      h("h2", { id: "linked-h" }, "Their addresses and numbers"),
      rows.length
        ? h(
          "ul",
          { class: "people-rows" },
          rows.map((x) => h("li", {}, entryRow(x))),
        )
        : h(
          "p",
          { class: "people-help" },
          "None linked yet. Open an address or number and choose whose it is, so casefile can hide it when they are safety-sensitive.",
        ),
    );
  }

  // Whose an address, number or place is (relatedTo). Vault only: Claude never sees the link.
  function ownerSection(e) {
    const people = all.entities.filter(isPerson);
    const sel = h(
      "select",
      { id: "people-owner", "aria-describedby": "owner-help" },
      h("option", { value: "" }, "No one in particular"),
      people.map((p) =>
        h(
          "option",
          { value: p.role, selected: e.relatedTo === p.role },
          `${p.forms.full} (${tokenText(p.role)})`,
        )
      ),
    );
    sel.addEventListener("change", async () => {
      const to = sel.value || null;
      sel.disabled = true;
      try {
        await patch({ relatedTo: to });
        announce(to ? `Linked to ${ownerName(to)}` : "No longer linked to anyone");
        await refresh("people-owner");
      } catch (x) {
        sel.value = e.relatedTo ?? "";
        sel.disabled = false;
        showToast(errorText(x), { tone: "danger" });
      }
    });
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "owner-h" },
      h("h2", { id: "owner-h" }, "Whose it is"),
      h("label", { for: "people-owner" }, "Belongs to"),
      h("div", { class: "hstack" }, sel),
      h(
        "p",
        { id: "owner-help", class: "people-help" },
        "If the person it belongs to is safety-sensitive, casefile treats this as safety-sensitive too. Only you see this link; Claude doesn’t.",
      ),
    );
  }

  // Colour slots: six, taken ones disabled, plus plain ink.
  function colourSection(e) {
    const name = uniqueId("people-colour");
    const owners = new Map(all.palette.map((s) => [s.index, s.owner]));
    const mineNow = e.colour ?? null;
    const pick = async (value, id) => {
      try {
        await patch({ colour: value });
        announce(value === null ? "Shown in plain ink" : `Colour set to ${SLOT_NAMES[value]}`);
      } catch (x) {
        const msg = x instanceof ApiError && x.status === 409
          ? `${SLOT_NAMES[x.body.colour] ?? "That colour"} is already used for ${
            byRole.get(x.body.owner)?.forms.full ?? x.body.owner
          }. Give them plain ink first.`
          : errorText(x);
        showToast(msg, { tone: "danger" });
      }
      await refresh(id);
    };
    const option = (value, label, sub, swatch, disabled) => {
      const id = `people-colour-${value === null ? "ink" : value}`;
      return h(
        "label",
        { class: cls("people-slot", disabled && "is-taken"), for: id },
        h("input", {
          type: "radio",
          name,
          id,
          value: value === null ? "ink" : String(value),
          checked: mineNow === value,
          disabled,
          onchange: () => pick(value, id),
        }),
        h("span", { class: swatch, "aria-hidden": "true" }),
        h(
          "span",
          { class: "people-slot-text" },
          h("span", { class: "people-slot-name" }, label),
          h("span", { class: "people-slot-owner" }, sub),
        ),
      );
    };
    const slots = all.palette.map((s) => {
      const owner = owners.get(s.index);
      const mine = owner === e.role;
      const taken = Boolean(owner) && !mine;
      return option(
        s.index,
        SLOT_NAMES[s.index] ?? `Colour ${s.index + 1}`,
        mine ? "This person" : taken ? `Taken: ${byRole.get(owner)?.forms.full ?? owner}` : "Free",
        `people-slot-swatch ent-c${s.index}`,
        taken,
      );
    });
    slots.push(option(
      null,
      "Plain ink",
      mineNow === null ? "This person" : "No colour",
      "people-slot-swatch people-slot-swatch--ink ent-ink",
      false,
    ));
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "colour-h" },
      h("h2", { id: "colour-h" }, "Give a colour"),
      h(
        "p",
        { id: "colour-help", class: "people-help" },
        "There are six colours, chosen so people stay easy to tell apart, including for colour-blind readers. Parents and children have them first; the rest are spare. Everyone else is shown in plain ink with their label. A colour someone else has can’t be chosen until you give them plain ink.",
      ),
      h(
        "fieldset",
        { class: "people-slots", "aria-describedby": "colour-help" },
        h("legend", { class: "sr" }, "Colour"),
        slots,
      ),
    );
  }

  // Ways the name is written: each form with the chip Claude sees.
  function formsSection(e, hidden) {
    const rows = isPerson(e)
      ? FORMS
      : [{ key: "full", label: e.group === "numbers" ? "Value" : "Name" }];
    const heading = isPerson(e)
      ? "Ways their name is written"
      : e.group === "numbers"
      ? "How it is written"
      : "How its name is written";
    const err = h("p", { class: "people-error", role: "alert" });
    const section = h(
      "section",
      { class: "people-sec", "aria-labelledby": "forms-h" },
      h("h2", { id: "forms-h" }, heading),
    );
    if (hidden) {
      section.append(Callout({
        title: "Hidden because it’s safety-sensitive",
        children: [
          h("p", {}, "Show it to see or change it."),
          Button(`Show ${kindLabel(e).toLowerCase()}`, {
            onclick: () => {
              revealed.add(e.role);
              refresh("people-f-full");
            },
          }),
        ],
      }));
      return section;
    }
    const inputs = {};
    const value = (k) => inputs[k].value.replace(/\s+/g, " ").trim();
    const save = Button("Save names", {
      variant: "primary",
      id: "people-save-forms",
      disabled: true,
      onclick: async () => {
        const body = {};
        for (const f of rows) {
          if (value(f.key) !== (e.forms[f.key] ?? "")) body[f.key] = value(f.key);
        }
        if (!Object.keys(body).length) return;
        if (body.full === "") {
          err.textContent = `The ${rows[0].label.toLowerCase()} can’t be empty.`;
          return;
        }
        err.textContent = "";
        try {
          await patch(body);
          const msg = "Saved. casefile checks every shared document again with these names.";
          announce(msg);
          showToast(msg);
          await refresh("people-f-full");
        } catch (x) {
          err.textContent = errorText(x);
        }
      },
    });
    const dirty = () => {
      save.disabled = !rows.some((f) => value(f.key) !== (e.forms[f.key] ?? ""));
    };
    const body = rows.map((f) => {
      const id = `people-f-${f.key}`;
      inputs[f.key] = h("input", {
        id,
        value: e.forms[f.key] ?? "",
        autocomplete: "off",
        class: cls("people-form-input", e.group === "numbers" && "mono"),
        oninput: dirty,
      });
      return h(
        "tr",
        {},
        h("th", { scope: "row" }, h("label", { for: id }, f.label)),
        h("td", {}, inputs[f.key]),
        h("td", {}, TokenChip({ role: e.role, kind: e.kind, colour: e.colour, form: f.key })),
      );
    });
    section.append(
      h(
        "div",
        { class: "people-forms-wrap" },
        h(
          "table",
          { class: "people-forms" },
          h("caption", { class: "sr" }, `${heading}, and what Claude sees for each`),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col", class: "people-forms-form" }, "Form"),
              h("th", { scope: "col" }, "Real value"),
              h("th", { scope: "col", class: "people-forms-tok" }, "Claude sees"),
            ),
          ),
          h("tbody", {}, body),
        ),
      ),
      h("div", { class: "hstack" }, save),
      err,
    );
    return section;
  }

  // Other names (nicknames): add or remove, with what it touches, and Undo.
  function aliasSection(e, hidden) {
    const panel = h("div", { class: "people-alias-panel" });
    const err = h("p", { class: "people-error", id: "alias-err", role: "alert" });
    const input = h("input", {
      id: "people-alias",
      class: "people-alias-input",
      placeholder: "Add a nickname or old surname",
      autocomplete: "off",
      "aria-describedby": "alias-help alias-err",
    });
    const before = [...e.aliases];
    const impact = (alias) =>
      api(
        "GET",
        `/api/entities/${encodeURIComponent(e.role)}/alias-impact?alias=${
          encodeURIComponent(alias)
        }`,
      );
    const closePanel = (focusId) => {
      panel.replaceChildren();
      if (focusId) document.getElementById(focusId)?.focus();
    };
    const undoTo = (list, said) => async () => {
      try {
        await patch({ aliases: list }, e.role);
        announce(said);
        await refresh("people-alias");
      } catch (x) {
        showToast(errorText(x), { tone: "danger" });
      }
    };
    const confirm = (bar) => {
      panel.replaceChildren(bar);
      bar.focusPrimary();
    };

    const startAdd = async () => {
      err.textContent = "";
      const a = input.value.replace(/\s+/g, " ").trim();
      if (!a) {
        err.textContent = "Type the other name first.";
        input.focus();
        return;
      }
      let imp;
      try {
        imp = await impact(a);
      } catch (x) {
        err.textContent = errorText(x);
        input.focus();
        return;
      }
      if (imp.known) {
        err.textContent = `“${imp.alias}” is already listed.`;
        input.focus();
        return;
      }
      const ex = imp.wouldExpose;
      const detail = [];
      if (ex.length) {
        detail.push(Callout({
          tone: "danger",
          title: `Claude can read “${imp.alias}” now`,
          children: `It is written as is in ${plural(ex.length, "shared document")} (${
            andList(ex, 6)
          }). Adding it withdraws ${
            ex.length === 1 ? "that document" : "those documents"
          } from Claude and marks ${
            ex.length === 1 ? "it" : "them"
          } Exposed — re-check, so you can review ${
            ex.length === 1 ? "it" : "them"
          } and share again.`,
        }));
      }
      const covered = imp.shared.filter((d) => !ex.includes(d.id)).map((d) => d.id);
      if (covered.length) {
        detail.push(h("p", {}, `Already replaced where it appears in ${andList(covered, 6)}.`));
      }
      if (imp.pending.length) {
        detail.push(h(
          "p",
          {},
          `In ${plural(imp.pending.length, "document")} still to review (${
            andList(imp.pending.map((d) => d.id), 6)
          }): casefile will suggest replacing it there.`,
        ));
      }
      if (imp.withheld.length) {
        detail.push(h(
          "p",
          {},
          `Also in ${plural(imp.withheld.length, "withheld document")} (${
            andList(imp.withheld.map((d) => d.id), 6)
          }), which Claude can’t read.`,
        ));
      }
      if (imp.clash.length) {
        detail.push(Callout({
          tone: "attention",
          title: "Also matches someone else",
          children: `“${imp.alias}” already matches ${
            andList(imp.clash.map((r) => byRole.get(r)?.forms.full ?? tokenText(r)), 6)
          }. Check it’s the right person before adding it.`,
        }));
      }
      confirm(ConfirmBar({
        title: `Add “${imp.alias}” as another name?`,
        summary: imp.total
          ? `casefile will replace “${imp.alias}” with ${tokenText(e.role)} in ${
            plural(imp.total, "document")
          }, and in any new document that uses it.`
          : `“${imp.alias}” isn’t in any document yet. casefile will replace it with ${
            tokenText(e.role)
          } in any new document that uses it.`,
        detail: detail.length ? detail : null,
        confirmLabel: `Add “${imp.alias}”`,
        onCancel: () => closePanel("people-alias"),
        onConfirm: async () => {
          try {
            await patch({ aliases: [...before, imp.alias] });
            const msg = ex.length
              ? `“${imp.alias}” added. ${andList(ex, 6)} withdrawn from Claude: re-check ${
                ex.length === 1 ? "it" : "them"
              } before sharing again.`
              : `“${imp.alias}” added.`;
            announce(msg);
            // Undo removes the nickname only: what it withdrew stays withdrawn until re-checked.
            const undone = ex.length
              ? `“${imp.alias}” removed again. ${andList(ex, 6)} ${
                ex.length === 1 ? "stays" : "stay"
              } withdrawn until you re-check ${ex.length === 1 ? "it" : "them"}.`
              : `“${imp.alias}” removed again`;
            showToast(msg, { undo: undoTo(before, undone) });
            await refresh("people-alias");
          } catch (x) {
            closePanel();
            err.textContent = errorText(x);
          }
        },
      }));
    };

    const startRemove = async (alias) => {
      err.textContent = "";
      let imp = null;
      try {
        imp = await impact(alias);
      } catch {
        imp = null; // e.g. a one-letter nickname can't be looked up; say less
      }
      const ids = imp ? [...imp.shared, ...imp.pending, ...imp.withheld].map((d) => d.id) : [];
      confirm(ConfirmBar({
        title: `Remove “${alias}”?`,
        summary: ids.length
          ? `casefile will stop replacing “${alias}”. It appears in ${
            plural(ids.length, "document")
          } (${
            andList(ids, 6)
          }), so Claude may see “${alias}” again in those once they’re shared, and in any new document that uses it.`
          : `casefile will stop replacing “${alias}”. It isn’t in any document now, but Claude would see it in any new document that uses it.`,
        confirmLabel: `Remove “${alias}”`,
        cancelLabel: "Keep it",
        onCancel: () => closePanel("people-alias"),
        onConfirm: async () => {
          try {
            await patch({ aliases: before.filter((a) => a !== alias) });
            const msg = `“${alias}” removed. casefile no longer replaces it.`;
            announce(msg);
            showToast(msg, { undo: undoTo(before, `“${alias}” is back`) });
            await refresh("people-alias");
          } catch (x) {
            closePanel();
            err.textContent = errorText(x);
          }
        },
      }));
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        startAdd();
      }
    });

    const chips = e.aliases.map((a, i) =>
      h(
        "li",
        { class: "people-alias" },
        hidden
          ? h("span", { class: "muted" }, "Hidden")
          : h("span", { class: cls("ent", colourClass(e), "ent-solid") }, a),
        h("button", {
          type: "button",
          class: "btn btn-quiet people-alias-x",
          "aria-label": hidden ? `Remove other name ${i + 1}` : `Remove ${a}`,
          onclick: () => startRemove(a),
        }, "×"),
      )
    );
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "alias-h" },
      h("h2", { id: "alias-h" }, `Other names for ${isPerson(e) ? "them" : "it"}`),
      h(
        "div",
        { class: "hstack people-alias-row" },
        chips.length
          ? h("ul", { class: "people-aliases", "aria-label": "Other names" }, chips)
          : h("span", { class: "muted" }, "None yet."),
        h("label", { for: "people-alias", class: "sr" }, "Add another name"),
        input,
        Button("Add", { onclick: startAdd }),
      ),
      h(
        "p",
        { id: "alias-help" },
        "Nicknames aren’t found automatically. Add them here and casefile checks every document again. If Claude can already read one in a shared document, adding it withdraws that document from Claude.",
      ),
      err,
      panel,
    );
  }

  /** Segments with any hidden safety-sensitive value shown as its label instead. */
  function masked(segs) {
    return (segs ?? []).map((s) => {
      const x = s.role ? byRole.get(s.role) : null;
      return x && isHidden(x) ? { t: tokenText(s.role, s.form) } : s;
    });
  }

  // Where they appear: documents (with their state), chronology, issues and drafts.
  function whereSection(e, usage) {
    const group = (title, count, rows, allLabel) => {
      const list = h("ul", { class: "people-where-list" });
      const fill = (n) => list.replaceChildren(...rows.slice(0, n).map((r) => h("li", {}, r)));
      fill(CAP);
      const more = rows.length > CAP
        ? Button(allLabel, {
          variant: "link",
          onclick: (ev) => {
            fill(rows.length);
            ev.currentTarget.remove();
            list.querySelector(`li:nth-child(${CAP + 1}) a`)?.focus();
          },
        })
        : null;
      return h(
        "div",
        { class: "people-where-group" },
        h("h3", {}, title, " ", h("span", { class: "people-where-n" }, `· ${count}`)),
        rows.length ? list : h("p", { class: "muted" }, "None."),
        more,
      );
    };

    const docs = usage.documents.map((d) =>
      h(
        "a",
        {
          class: "people-where-row people-where-row--doc",
          href: `#/doc/${d.id}:${d.lines[0] ?? 1}`,
        },
        h("span", { class: "num muted" }, d.id),
        h(
          "span",
          { class: "people-where-title" },
          h("span", {}, d.title),
          d.state !== "shared" ? Badge("doc", d.state, { small: true }) : null,
        ),
        h("span", { class: "num muted small" }, plural(d.mentions, "time")),
      )
    );
    const chron = usage.chronology.map((c) =>
      h(
        "a",
        { class: "people-where-row people-where-row--date", href: "#/chronology" },
        h("span", { class: "muted" }, formatDay(c.event_date, true)),
        h(
          "span",
          { class: "ent-plain" },
          Segments(masked(c.description?.segs), { interactive: false }),
        ),
      )
    );
    const issues = usage.issues.map((i) =>
      h(
        "a",
        { class: "people-where-row", href: `#/issues/${i.id}` },
        h("span", { class: "ent-plain" }, Segments(masked(i.title?.segs), { interactive: false })),
      )
    );
    const drafts = new Map();
    for (const para of usage.paragraphs) {
      const d = drafts.get(para.draft_id) ?? { title: para.draftTitle, ns: [] };
      d.ns.push(para.n);
      drafts.set(para.draft_id, d);
    }
    const draftRows = [...drafts.entries()].map(([id, d]) =>
      h(
        "a",
        { class: "people-where-row people-where-row--draft", href: `#/draft/${id}` },
        h("span", {}, d.title),
        h(
          "span",
          { class: "muted small" },
          `${d.ns.length === 1 ? "paragraph" : "paragraphs"} ${
            d.ns.sort((a, b) => a - b).join(", ")
          }`,
        ),
      )
    );
    const t = usage.totals;
    return h(
      "section",
      { class: "people-sec", "aria-labelledby": "where-h" },
      h("h2", { id: "where-h" }, `Where ${isPerson(e) ? "they appear" : "it appears"}`),
      group("Documents", t.documents, docs, `Show all ${t.documents} documents`),
      group(
        "Chronology",
        plural(t.chronology, "entry", "entries"),
        chron,
        `Show all ${t.chronology} chronology entries`,
      ),
      group("Issues", t.issues, issues, `Show all ${t.issues} issues`),
      group("Drafts", drafts.size, draftRows, `Show all ${drafts.size} drafts`),
    );
  }

  await Promise.all([renderList(), renderDetail()]);
}
