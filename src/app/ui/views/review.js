// Review before sharing (Workbench, W2-1). The user decides every finding in one imported
// document, says where the document came from, and then shares it with Claude (names replaced)
// or finishes the review with it kept from Claude. Gap list section E; DESIGN-SPEC §3–§7.
//
// Data: GET /api/docs/:id/review (findings, proposals, originHint, safetyRoles, ignoreReasons,
// claudeTitleSegs/titleLeaks), POST /api/docs/:id/preview (the title Claude would see with the
// decisions so far, checked by casefile without sharing), POST /api/docs/:id/publish,
// PUT /api/docs/:id/origin, POST /api/docs/:id/withdraw (Undo, decisions kept),
// POST /api/docs/:id/reopen (Review again), GET /api/docs[?batch=] (the queue), GET /api/plan.
//
// The queue strip lists every document that needs review. The import screen narrows it to the
// documents it just imported with `#/review/D015?queue=B3` (an import batch); a list of ids
// (`?queue=D015,D016`) works too.
import { cls, h, pointOffset } from "../dom.js";
import { api, ApiError } from "../lib.js";
import {
  announce,
  Badge,
  Callout,
  ConfirmBar,
  describeId,
  EntityDot,
  FilterChips,
  FlagBadge,
  focusMemo,
  Icon,
  Key,
  linkEntities,
  listShortcuts,
  MarkTag,
  NAME_FINDER_OFF,
  OriginalFile,
  Segmented,
  showToast,
} from "../components/index.js";
import {
  andList,
  capitalise,
  colourClass,
  describeMark,
  entityShape,
  plural,
  roleLabel,
  shapeClass,
  tokenText,
} from "../model.js";

// ── fixed copy ───────────────────────────────────────────────────────────────

const ORIGIN_OPTIONS = [
  { id: "mine", label: "It’s mine (I wrote or received it)" },
  { id: "other_side", label: "From the other side" },
  { id: "court_or_subpoena", label: "From a subpoena or the court" },
  { id: "under_order", label: "Under an order or undertaking" },
  { id: "not_sure", label: "Not sure" },
];
const SHAREABLE_ON_COMMERCIAL = new Set(["other_side", "court_or_subpoena"]);

const VIEWS = [
  {
    id: "original",
    label: "Original",
    note: "What you see. Point at or click a name to find every place it appears.",
  },
  {
    id: "claude",
    label: "As Claude sees it",
    note: "Names and numbers shown as the labels Claude will read.",
  },
  { id: "side", label: "Side by side", note: "Your text and Claude’s, line by line." },
];

const GROUPS = [
  { id: "needs", title: "Needs you" },
  { id: "people", title: "People" },
  { id: "places", title: "Places & organisations" },
  { id: "ids", title: "Numbers, dates & addresses" },
  { id: "kept", title: "Left as written" },
];

const FILTERS = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "unseen", label: "Not looked at yet" },
  { id: "you", label: "You decided" },
];

const REASONS = [
  { id: "not_real", label: "Not a real person" },
  { id: "public", label: "Public figure or organisation" },
  { id: "already_public", label: "Already public in this case" },
  { id: "other", label: "Other" },
];

const NEW_KINDS = [
  { kind: "person", label: "A new person" },
  { kind: "organisation", label: "A new organisation" },
  { kind: "school", label: "A new school" },
  { kind: "place", label: "A new place" },
  { kind: "address", label: "A new address" },
  { kind: "phone", label: "A new phone number" },
  { kind: "email", label: "A new email address" },
  { kind: "identifier", label: "A new number (file, Medicare, tax…)" },
  { kind: "date_of_birth", label: "A new date of birth" },
  { kind: "other", label: "Something else" },
];

/** Role prefixes for a new entity's label, as the server allocates them (core KIND_PREFIX). */
const KIND_PREFIX = {
  person: "person",
  place: "place",
  organisation: "org",
  school: "school",
  address: "address",
  phone: "phone",
  email: "email",
  identifier: "id",
  date_of_birth: "dob",
  other: "other",
};

const SOURCE_TEXT = {
  known: "matched someone in Who’s who",
  rule: "found by casefile’s number and date rules",
  ner: "found by casefile’s name finder",
  llm: "found by the language model on this computer",
  manual: "marked by you",
};

const FORM_WORDS = {
  full: "full name",
  first: "first name",
  surname: "surname",
  title: "name with title",
};

const VIEW_KEY = "casefile.review.view";
const PREVIEW_REF = "__preview__";

// ── small helpers ────────────────────────────────────────────────────────────

/** Kind → findings group (mirrors the API's grouping). */
function groupOfKind(kind) {
  if (kind === "person") return "people";
  if (kind === "place" || kind === "organisation" || kind === "school" || kind === "other") {
    return "places";
  }
  return "ids";
}

/** "line 3", "lines 3 and 5", "lines 3, 5 and 9". */
function linesText(lines, capital = false) {
  const ls = [...lines].sort((a, b) => a - b);
  const word = ls.length === 1 ? "line" : "lines";
  const s = `${word} ${andList(ls.map(String))}`;
  return capital ? capitalise(s) : s;
}

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a per-viewer convenience only
  }
}

/** Findings the user has looked at in this document (kept for this browser session). */
function seenStore(docId) {
  const key = `casefile.review.seen.${docId}`;
  let set;
  try {
    set = new Set(JSON.parse(sessionStorage.getItem(key) ?? "[]"));
  } catch {
    set = new Set();
  }
  return {
    has: (id) => set.has(id),
    add(id) {
      if (set.has(id)) return;
      set.add(id);
      try {
        sessionStorage.setItem(key, JSON.stringify([...set]));
      } catch {
        // per-session convenience only
      }
    },
  };
}

/**
 * The `?queue=` part of the hash, if the import screen sent one: an import batch (`B3`) or a list
 * of document ids (`D015,D016`).
 */
function queueFromHash() {
  const q = location.hash.split("?")[1];
  if (!q) return null;
  const raw = new URLSearchParams(q).get("queue");
  if (!raw) return null;
  if (/^B\d+$/.test(raw)) return { raw, batch: raw, ids: null };
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => /^[A-Z]\d+$/.test(s));
  return ids.length ? { raw: ids.join(","), batch: null, ids } : null;
}

/** A finding's review decision, as a badge (not a state from the vocabulary: FlagBadge). */
const DECISION = {
  needs: ["attention", "dot", "Needs you"],
  auto: ["neutral", null, "Decided automatically"],
  decided: ["neutral", "check", "You decided"],
};
const decisionBadge = (kind) => {
  const [tone, glyph, text] = DECISION[kind] ?? DECISION.decided;
  return FlagBadge(tone, glyph, text, { small: true });
};

// ── the view ─────────────────────────────────────────────────────────────────

/** @param {HTMLElement} main @param {{id: string}} params @param {object} ctx */
export default async function view(main, params, ctx) {
  const id = params.id;
  const queue = queueFromHash();
  const [data, docs, plan] = await Promise.all([
    api("GET", `/api/docs/${encodeURIComponent(id)}/review`),
    api("GET", queue?.batch ? `/api/docs?batch=${queue.batch}` : "/api/docs").catch(() => []),
    api("GET", "/api/plan").catch(() => null),
  ]);
  new Review(main, data, docs, plan, ctx, queue).mount();
}

class Review {
  constructor(main, data, docs, plan, ctx, queue) {
    this.main = main;
    this.ctx = ctx;
    this.docs = docs;
    this.plan = plan;
    this.queueParam = queue?.raw ?? null;
    this.queueIds = queue ? (queue.ids ?? docs.map((d) => d.id)) : null;
    this.seen = seenStore(data.id);
    this.view = readPref(VIEW_KEY, "original");
    if (!VIEWS.some((v) => v.id === this.view)) this.view = "original";
    this.filter = "all";
    /** finding id → {type: "replace", ref} | {type: "keep", reason} */
    this.decisions = new Map();
    /** finding id → in-progress choice in the decisions panel */
    this.editing = new Map();
    this.manualSpans = [];
    this.manualFindings = [];
    this.userNew = new Map();
    this.manualN = 0;
    this.userNewN = 0;
    this.selected = null;
    this.confirmOpen = false;
    this.release = false;
    this.problem = null; // the last refusal from casefile (names still showing, etc.)
    this.previewNew = null;
    this.load(data);
  }

  /** Take a review payload; keep the user's decisions when the spans are unchanged. */
  load(data) {
    const prevSpans = new Set((this.data?.proposals ?? []).map((p) => p.id));
    const sameSpans = this.data &&
      data.proposals.length === prevSpans.size &&
      data.proposals.every((p) => prevSpans.has(p.id));
    this.data = data;
    this.entities = new Map(data.entities.map((e) => [e.role, e]));
    this.safety = new Set(data.safetyRoles ?? []);
    if (!sameSpans) {
      this.decisions.clear();
      this.editing.clear();
      this.manualSpans = [];
      this.manualFindings = [];
      this.userNew = new Map();
    }
    // Provisional labels for new entities (the server allocates the same way; it may renumber).
    this.taken = new Set(data.entities.map((e) => e.role));
    for (const n of this.userNew.values()) this.taken.add(n.role);
    this.detNew = new Map(
      data.newEntities.map((n) => [n.key, {
        ref: n.key,
        kind: n.kind,
        full: n.full,
        role: this.provisional(n.kind, n.roleHint),
        first: n.first,
        surname: n.surname,
      }]),
    );
    this.spanById = new Map(data.proposals.map((p) => [p.id, p]));
    for (const m of this.manualSpans) this.spanById.set(m.id, m);
    this.buildFindings();
    // The title as Claude will see it, from casefile (refreshed by a preview as decisions change).
    this.titleView = { segs: data.claudeTitleSegs ?? [], leaks: data.titleLeaks ?? [] };
    this.previewKey = undefined;
  }

  provisional(kind, hint) {
    if (hint && !this.taken.has(hint)) {
      this.taken.add(hint);
      return hint;
    }
    const r = this.peekProvisional(kind);
    this.taken.add(r);
    return r;
  }

  /** The label a new entity of this kind would get, without reserving it. */
  peekProvisional(kind) {
    const prefix = KIND_PREFIX[kind] ?? "other";
    for (let n = 1;; n++) if (!this.taken.has(`${prefix}_${n}`)) return `${prefix}_${n}`;
  }

  /** The title Claude will be given: the document's, or one the user changed here. */
  get titleText() {
    return this.titleDraft ?? this.data.title;
  }

  get readOnly() {
    return this.data.status === "published";
  }

  get origin() {
    return this.data.origin ?? null;
  }

  get commercial() {
    return this.plan?.setup === "commercial";
  }

  /** Whether this review ends with the document shared with Claude (not kept from Claude). */
  get willShare() {
    if (this.origin === "mine") return true;
    return this.commercial && SHAREABLE_ON_COMMERCIAL.has(this.origin) && this.release === true;
  }

  // ── findings model ─────────────────────────────────────────────────────────

  buildFindings() {
    const out = [];
    for (const f of this.data.findings) {
      if (f.group === "kept") {
        out.push({ ...f, origType: "earlier", spans: [] });
        continue;
      }
      const first = this.spanById.get(f.spans[0]);
      const p = first?.proposal;
      out.push({
        ...f,
        origType: p?.type ?? "manual",
        source: first?.source ?? "known",
        options: p?.type === "ambiguous" ? p.options : null,
      });
    }
    out.push(...this.manualFindings);
    this.findings = out;
    this.findingOfSpan = new Map();
    for (const f of out) for (const s of f.spans) this.findingOfSpan.set(s, f);
  }

  /** The decision in force for a finding: the user's, or the automatic one, or null. */
  decisionOf(f) {
    if (f.origType === "earlier") return { type: "keep", reason: f.reason ?? "" };
    const d = this.decisions.get(f.id);
    if (d) return d;
    const p = this.spanById.get(f.spans[0])?.proposal;
    if (p?.type === "existing") return { type: "replace", ref: p.role };
    if (p?.type === "new") return { type: "replace", ref: p.key };
    return null;
  }

  /** "needs" | "auto" | "you" */
  statusOf(f) {
    if (f.origType === "earlier") return "you";
    if (this.decisions.has(f.id)) return "you";
    return this.decisionOf(f) ? "auto" : "needs";
  }

  groupOf(f) {
    const d = this.decisionOf(f);
    if (!d) return "needs";
    if (d.type === "keep") return "kept";
    return groupOfKind(this.refInfo(d.ref).kind);
  }

  isUnseen(f) {
    if (this.readOnly) return false;
    return this.statusOf(f) === "auto" && !this.seen.has(f.id);
  }

  /** {role, kind, colour, name} for an existing role or a new entity's ref. */
  refInfo(ref) {
    const e = this.entities.get(ref);
    if (e) return { role: e.role, kind: e.kind, colour: e.colour ?? null, name: e.forms.full };
    const n = ref === PREVIEW_REF ? this.previewNew : this.detNew.get(ref) ?? this.userNew.get(ref);
    if (n) return { role: n.role, kind: n.kind, colour: null, name: n.full };
    return { role: ref, kind: "other", colour: null, name: ref };
  }

  /** The form a span takes when replaced by `ref`. */
  spanForm(span, ref) {
    const p = span.proposal;
    if (p?.type === "existing" && p.role === ref) return p.form;
    if (p?.type === "new" && p.key === ref) return p.form;
    if (p?.type === "ambiguous") {
      const o = p.options.find((x) => x.ref === ref);
      if (o) return o.form;
    }
    const e = this.entities.get(ref);
    if (e) {
      const t = span.text.trim().toLowerCase();
      for (const form of ["full", "first", "surname", "title"]) {
        if (e.forms[form] && e.forms[form].toLowerCase() === t) return form;
      }
    }
    return "full";
  }

  /** Roles a finding could belong to (for the safety rule and the "Leave as written" warning). */
  candidateRoles(f) {
    const roles = new Set();
    const d = this.decisionOf(f);
    if (d?.type === "replace" && this.entities.has(d.ref)) roles.add(d.ref);
    for (const o of f.options ?? []) if (this.entities.has(o.ref)) roles.add(o.ref);
    const p = this.spanById.get(f.spans[0])?.proposal;
    if (p?.type === "existing") roles.add(p.role);
    // A value that is one of a known person's forms or nicknames, however it was found.
    const t = f.text.trim().toLowerCase();
    for (const e of this.entities.values()) {
      const values = [...Object.values(e.forms), ...(e.aliases ?? [])];
      if (values.some((v) => v && v.toLowerCase() === t)) roles.add(e.role);
    }
    return [...roles];
  }

  safetyRolesOf(f) {
    return this.candidateRoles(f).filter((r) => this.safety.has(r));
  }

  counts() {
    const c = { all: 0, needs: 0, unseen: 0, you: 0 };
    for (const f of this.findings) {
      c.all++;
      const st = this.statusOf(f);
      if (st === "needs") c.needs++;
      if (st === "you") c.you++;
      if (this.isUnseen(f)) c.unseen++;
    }
    return c;
  }

  keep(f) {
    if (this.filter === "all") return true;
    if (this.filter === "unseen") return this.isUnseen(f);
    return this.statusOf(f) === this.filter;
  }

  /** The request built from every decision. */
  request() {
    const replacements = [];
    const ignore = [];
    const ignoreReasons = {};
    const used = new Set();
    for (const f of this.findings) {
      if (f.origType === "earlier") continue;
      const d = this.decisionOf(f);
      if (!d) continue;
      if (d.type === "keep") {
        ignore.push(f.text);
        ignoreReasons[f.text] = d.reason;
        continue;
      }
      used.add(d.ref);
      for (const sid of f.spans) {
        const s = this.spanById.get(sid);
        replacements.push({
          start: s.start,
          end: s.end,
          ref: d.ref,
          form: this.spanForm(s, d.ref),
        });
      }
    }
    const newEntities = [...this.detNew.values(), ...this.userNew.values()]
      .filter((n) => used.has(n.ref))
      .map((n) => ({
        ref: n.ref,
        kind: n.kind,
        full: n.full,
        role: n.role,
        first: n.first,
        surname: n.surname,
      }));
    const body = { newEntities, replacements, ignore, ignoreReasons };
    if (this.titleDraft !== undefined) body.title = this.titleDraft;
    if (this.willShare && this.origin !== "mine") body.release = true;
    return body;
  }

  // ── mounting and refreshing ────────────────────────────────────────────────

  mount() {
    this.root = h("div", { class: "rv" });
    this.queueEl = h("nav", { class: "rv-queue", "aria-label": "Imported documents to review" });
    this.headEl = h("div", { class: "rv-head" });
    // The PDF it was read from, if any (ADR 23).
    this.fileEl = h("div", { class: "rv-file" });
    this.keyEl = h("div", { class: "rv-key", "data-region": "key" });
    this.findingsEl = h("aside", {
      class: "rv-findings",
      "aria-labelledby": "rv-find-h",
      "data-region": "findings",
    });
    this.textEl = h("section", {
      class: "rv-text",
      "aria-labelledby": "rv-doc-h",
      "data-region": "text",
    });
    this.sideEl = h("aside", {
      class: "rv-side",
      "aria-label": "Decisions for this document",
      "data-region": "side",
    });
    this.confirmHost = h("div", { class: "rv-confirm-host" });
    this.root.append(
      this.queueEl,
      this.headEl,
      this.fileEl,
      this.keyEl,
      h("div", { class: "rv-cols" }, this.findingsEl, this.textEl, this.sideEl),
      this.confirmHost,
    );
    this.main.replaceChildren(this.root);
    this.link = linkEntities(this.root);

    // Clicking (or Enter on) a mark in the text opens that finding.
    this.textEl.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target.closest("[data-finding]") : null;
      if (t) this.select(t.dataset.finding);
    });
    this.textEl.addEventListener("keydown", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || t.tagName === "BUTTON") return;
      if ((e.key === "Enter" || e.key === " ") && t.matches("[data-finding]")) {
        this.select(t.dataset.finding);
      } else if (
        (e.key === "m" || e.key === "M") && this.ctx.shortcuts !== false && !e.metaKey &&
        !e.ctrlKey && !e.altKey
      ) {
        e.preventDefault();
        this.markMissed();
      }
    });
    // Remember the last text selection in the document (a button click must not lose it).
    const onSelection = () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const r = sel.getRangeAt(0);
      if (this.textEl.contains(r.commonAncestorContainer)) this.lastRange = r.cloneRange();
    };
    document.addEventListener("selectionchange", onSelection);
    const stop = () => {
      document.removeEventListener("selectionchange", onSelection);
      globalThis.removeEventListener("hashchange", stop);
    };
    globalThis.addEventListener("hashchange", stop);

    // Start on the first finding that needs the user.
    const firstNeeds = this.findings.find((f) => this.statusOf(f) === "needs");
    if (firstNeeds && !this.readOnly) this.selected = firstNeeds.id;
    if (this.selected) this.seen.add(this.selected);
    this.renderQueue();
    this.refresh({ keepFocus: false });
  }

  /** Re-render everything that depends on decisions, keeping focus where it was. */
  refresh(opts = {}) {
    const restore = opts.keepFocus === false ? null : focusMemo(this.root);
    this.schedulePreview();
    this.renderHead();
    this.renderKey();
    this.renderFindings();
    this.renderText();
    this.renderSide();
    this.refreshLinking();
    restore?.();
  }

  refreshLinking() {
    const f = this.findingById(this.selected);
    if (!f) return this.link.clear();
    const d = this.decisionOf(f);
    this.link.pin(d?.type === "replace" ? this.refInfo(d.ref).role : `f:${f.id}`);
  }

  findingById(fid) {
    return fid ? this.findings.find((f) => f.id === fid) ?? null : null;
  }

  select(fid, opts = {}) {
    const f = this.findingById(fid);
    if (!f) return;
    this.selected = fid;
    this.seen.add(fid);
    this.refresh();
    if (opts.focusRow) this.root.querySelector(`[data-fk="row:${fid}"]`)?.focus();
  }

  queueHref(id) {
    return `#/review/${id}${this.queueParam ? `?queue=${this.queueParam}` : ""}`;
  }

  // ── queue strip ────────────────────────────────────────────────────────────

  renderQueue() {
    const cur = this.data.id;
    let list = this.docs.filter((d) => d.state === "needs_review" && d.status !== "published");
    if (this.queueIds) {
      const want = new Set(this.queueIds);
      list = this.docs.filter((d) => want.has(d.id));
    }
    if (!list.some((d) => d.id === cur)) {
      list.push({ id: cur, title: this.data.title, state: this.data.state });
    }
    list.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    // Every document still needing review, the one open included (CANON: 2 waiting; QA R1).
    const waiting =
      list.filter((d) => (d.id === cur ? this.data.state : d.state) === "needs_review").length;
    this.queue = list;
    this.queueEl.replaceChildren(
      h("span", { class: "rv-queue-label" }, `Review before sharing · ${waiting} waiting`),
      ...list.map((d) =>
        h(
          "a",
          {
            class: "rv-queue-item",
            href: this.queueHref(d.id),
            "aria-current": d.id === cur ? "page" : null,
          },
          h("span", { class: "mono muted" }, d.id),
          h("span", { class: "rv-queue-title" }, d.title),
          Badge("doc", d.id === cur ? this.data.state : d.state, { small: true }),
        )
      ),
      h("a", { class: "rv-queue-more", href: "#/docs" }, "Import more"),
    );
  }

  /** The next document in the queue that still needs review, if any. */
  nextInQueue() {
    const cur = this.data.id;
    const after = this.queue.filter((d) => d.id !== cur && d.state === "needs_review");
    return after.find((d) => d.id.localeCompare(cur, "en", { numeric: true }) > 0) ?? after[0] ??
      null;
  }

  markQueue(state) {
    const d = this.docs.find((x) => x.id === this.data.id);
    if (d) d.state = state;
    this.renderQueue();
  }

  // ── title row ──────────────────────────────────────────────────────────────

  /** Display info for a label in the title: a known person, or one decided in this review. */
  roleInfo(role) {
    const e = this.entities.get(role);
    if (e) return { role, kind: e.kind, colour: e.colour ?? null, name: e.forms.full };
    for (const n of [...this.detNew.values(), ...this.userNew.values()]) {
      if (n.role === role) return { role, kind: n.kind, colour: null, name: n.full };
    }
    return { role, kind: "other", colour: null, name: role };
  }

  /** What in the title would stop casefile sharing the document (from its last check). */
  get titleLeaks() {
    return this.readOnly ? [] : (this.titleView?.leaks ?? []);
  }

  /**
   * The title as Claude will see it, as casefile works it out from the decisions so far (the
   * review data, then `POST /api/docs/:id/preview` after each change): labels for names, and
   * anything casefile would refuse to share marked.
   */
  titleSegments() {
    const segs = this.titleView?.segs ?? [];
    if (!segs.length) return [h("span", { class: "mono" }, this.titleText)];
    const leaks = this.titleLeaks;
    const out = [];
    let at = 0;
    for (const seg of segs) {
      const start = at;
      const end = at + seg.t.length;
      at = end;
      if (seg.role) {
        const info = this.roleInfo(seg.role);
        const value = this.entities.get(seg.role)?.forms?.[seg.form] ?? info.name;
        out.push(
          h(
            "span",
            {
              class: `token ${colourClass(info)}`,
              "data-role": info.role,
              "aria-describedby": describeId(describeMark(value, info.role, seg.form)),
            },
            tokenText(info.role, seg.form),
          ),
        );
        continue;
      }
      let i = start;
      const inside = leaks.filter((l) => l.start < end && l.end > start)
        .sort((a, b) => a.start - b.start);
      for (const l of inside) {
        const a = Math.max(l.start, i);
        const b = Math.min(l.end, end);
        if (b <= a) continue;
        if (a > i) out.push(h("span", { class: "mono" }, seg.t.slice(i - start, a - start)));
        out.push(
          h("span", {
            class: "rv-needs mono",
            "aria-describedby": describeId(
              "casefile won’t share the document with this in the title. Change the title.",
            ),
          }, seg.t.slice(a - start, b - start)),
        );
        i = b;
      }
      if (i < end) out.push(h("span", { class: "mono" }, seg.t.slice(i - start)));
    }
    return out;
  }

  /**
   * Ask casefile what the title would be with the decisions as they are now (debounced; nothing
   * is shared or recorded). Only the title and its problems are redrawn when the answer comes.
   */
  schedulePreview() {
    if (this.readOnly) return;
    const req = this.request();
    const key = JSON.stringify(req);
    if (key === this.previewKey) return;
    this.previewKey = key;
    clearTimeout(this.previewTimer);
    const seq = (this.previewSeq = (this.previewSeq ?? 0) + 1);
    this.previewTimer = setTimeout(async () => {
      let r;
      try {
        r = await api("POST", `/api/docs/${this.data.id}/preview`, req);
      } catch {
        return; // keep the last answer; sharing checks again anyway
      }
      if (seq !== this.previewSeq || this.readOnly || !this.root.isConnected) return;
      const blockedBefore = this.titleLeaks.length > 0;
      this.titleView = { segs: r.claudeTitleSegs ?? [], leaks: r.titleLeaks ?? [] };
      for (const el of this.root.querySelectorAll(".rv-claude-title-text")) {
        el.replaceChildren(...this.titleSegments());
      }
      if (blockedBefore !== this.titleLeaks.length > 0) {
        const restore = focusMemo(this.root);
        this.renderSide();
        restore?.();
      }
    }, 200);
  }

  renderHead() {
    const seg = Segmented({
      label: "View",
      options: VIEWS.map((v) => ({ id: v.id, label: v.label })),
      value: this.view,
      onChange: (v) => {
        this.view = v;
        writePref(VIEW_KEY, v);
        this.renderText();
        this.refreshLinking();
        announce(`Showing ${VIEWS.find((x) => x.id === v).label}.`);
      },
    });
    seg.dataset.region = "views";
    this.headEl.replaceChildren(
      h("span", { class: "mono muted" }, this.data.id),
      h("h1", { class: "rv-title" }, this.data.title),
      Badge("doc", this.data.state),
      h(
        "span",
        { class: "rv-claude-title" },
        "Title Claude sees: ",
        h("span", { class: "rv-claude-title-text" }, this.titleSegments()),
      ),
      h("span", { class: "spacer" }),
      seg,
    );
    this.fileEl.replaceChildren(
      ...[OriginalFile(this.data.id, this.data.file ?? null)].filter(Boolean),
    );
  }

  // ── key ────────────────────────────────────────────────────────────────────

  renderKey() {
    const people = new Map();
    for (const f of this.findings) {
      const d = this.decisionOf(f);
      if (d?.type !== "replace") continue;
      const info = this.refInfo(d.ref);
      if (info.colour == null || info.kind !== "person") continue;
      const p = people.get(info.role) ?? { ...info, count: 0 };
      p.count += f.spans.length;
      people.set(info.role, p);
    }
    const entries = [...people.values()]
      .sort((a, b) => a.colour - b.colour)
      .map((p) => ({ role: p.role, name: p.name, kind: p.kind, colour: p.colour, count: p.count }));
    const key = Key({ entries });
    key.querySelector(".key-shapes")?.prepend(
      h(
        "span",
        { class: "rv-key-extra" },
        h("span", { class: "badge badge--attention badge--sm" }, Icon("dot"), "Needs you"),
        " casefile isn’t sure",
      ),
      h("span", { class: "rv-key-extra" }, "Left as written ", h("span", { class: "tag" }, "kept")),
    );
    this.keyEl.replaceChildren(key);
  }

  // ── findings list ──────────────────────────────────────────────────────────

  renderFindings() {
    const c = this.counts();
    let replaced = 0;
    let kept = 0;
    for (const f of this.findings) {
      const d = this.decisionOf(f);
      if (d?.type === "replace") replaced++;
      else if (d?.type === "keep") kept++;
    }
    const chips = FilterChips({
      label: "Show findings",
      options: FILTERS.map((x) => ({ id: x.id, label: x.label, count: c[x.id] })),
      value: this.filter,
      onChange: (v) => {
        this.filter = v;
        this.refresh();
        const label = FILTERS.find((x) => x.id === v).label.toLowerCase();
        announce(`Showing ${plural(this.counts()[v], "finding")}: ${label}.`);
      },
    });

    const list = h("div", { class: "rv-list", role: "group", "aria-label": "Findings list" });
    let shown = 0;
    for (const g of GROUPS) {
      const rows = this.findings.filter((f) => this.groupOf(f) === g.id && this.keep(f));
      if (!rows.length) continue;
      shown += rows.length;
      list.append(
        h(
          "h3",
          { class: cls("rv-group-title eyebrow", g.id === "needs" && "rv-group-title--needs") },
          `${g.title} · ${rows.length}`,
        ),
        h("ul", { class: "rv-rows" }, rows.map((f) => h("li", {}, this.row(f)))),
      );
    }
    if (!shown) {
      list.append(
        h(
          "p",
          { class: "rv-list-empty muted" },
          this.findings.length
            ? "Nothing here with this filter."
            : "casefile found no names or numbers in this document. Read it through, and mark anything it missed.",
        ),
      );
    }

    const shortcuts = this.ctx.shortcuts !== false;
    this.findingsEl.replaceChildren(
      h(
        "div",
        { class: "rv-findings-head" },
        h(
          "div",
          { class: "hstack between" },
          h("h2", { id: "rv-find-h" }, "Findings"),
          h("span", { class: "small muted" }, `${replaced} to replace · ${kept} left as written`),
        ),
        chips,
      ),
      // No detector looks for names (declined, or it couldn't be set up): say so (ADR 26).
      this.data.nameDetection === false && this.data.status !== "published"
        ? h("p", { class: "rv-list-empty small muted", role: "note" }, NAME_FINDER_OFF)
        : null,
      list,
      h(
        "div",
        { class: "rv-findings-foot" },
        shortcuts
          ? h(
            "p",
            { class: "small muted" },
            h("span", { class: "rv-strong" }, "Shortcuts on"),
            " while this list has focus: ",
            h("kbd", {}, "J"),
            " ",
            h("kbd", {}, "K"),
            " next and previous, ",
            h("kbd", {}, "↵"),
            " open. In the text, ",
            h("kbd", {}, "M"),
            " marks the selected words. ",
            h("a", { href: "#/settings" }, "Turn shortcuts off"),
          )
          : h(
            "p",
            { class: "small muted" },
            "Keyboard shortcuts are off. ",
            h("a", { href: "#/settings" }, "Turn them on in Settings"),
          ),
      ),
    );
    this.detachKeys?.();
    this.detachKeys = listShortcuts(list, {
      j: () => this.step(1),
      k: () => this.step(-1),
    }, { enabled: shortcuts });
  }

  step(dir) {
    const rows = [...this.findingsEl.querySelectorAll("button.rv-row")];
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.dataset.finding === this.selected);
    const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + dir))];
    this.select(next.dataset.finding, { focusRow: true });
  }

  row(f) {
    const st = this.statusOf(f);
    const d = this.decisionOf(f);
    const info = d?.type === "replace" ? this.refInfo(d.ref) : null;
    const span0 = this.spanById.get(f.spans[0]);
    const times = f.spans.length > 1 ? `×${f.spans.length}` : linesText(f.lines);
    let dot, chip;
    if (st === "needs") {
      dot = h("span", { class: "rv-dot rv-dot--needs", "aria-hidden": "true" });
      chip = h("span", { class: "rv-chip rv-chip--needs" }, "not decided");
    } else if (d.type === "keep") {
      dot = h("span", { class: "rv-dot rv-dot--kept", "aria-hidden": "true" });
      chip = h("span", { class: "rv-chip" }, "as written");
    } else {
      dot = EntityDot(info);
      chip = h(
        "span",
        { class: `token ${colourClass(info)}` },
        tokenText(info.role, span0 ? this.spanForm(span0, d.ref) : "full"),
      );
    }
    // One plain spoken name for the row: no glyphs, no label syntax (QA R2).
    const where = f.spans.length > 1 ? `${f.spans.length} times` : linesText(f.lines);
    const shown = st === "needs"
      ? "not decided"
      : d.type === "keep"
      ? "left as written"
      : `shown to Claude as ${roleLabel(info.role)}`;
    let said;
    if (st === "needs") said = "needs you";
    else if (st === "you") {
      said = (f.origType === "earlier" ? "you decided earlier" : "you decided") +
        (d.type === "keep" ? `, kept: ${(d.reason || "no reason recorded").toLowerCase()}` : "");
    } else {
      said = this.isUnseen(f)
        ? "decided automatically, not looked at yet"
        : "decided automatically";
    }
    let state;
    if (st === "needs") state = decisionBadge("needs");
    else if (st === "you") {
      const detail = d.type === "keep"
        ? `kept: ${(d.reason || "no reason recorded").toLowerCase()}`
        : "replaced";
      state = h(
        "span",
        { class: "rv-row-state" },
        h("span", { "aria-hidden": "true" }, "✓ "),
        f.origType === "earlier" ? `You decided earlier · ${detail}` : `You decided · ${detail}`,
      );
    } else {
      const unseen = this.isUnseen(f);
      state = h(
        "span",
        { class: "rv-row-state muted" },
        h("span", { "aria-hidden": "true" }, unseen ? "○ " : "◇ "),
        unseen ? "Decided automatically · not looked at yet" : "Decided automatically",
      );
    }
    return h(
      "button",
      {
        type: "button",
        class: cls("rv-row", info && entityShape(info.kind) === "id" && "rv-row--id"),
        "aria-current": f.id === this.selected ? "true" : null,
        "data-role": info ? info.role : `f:${f.id}`,
        "data-finding": f.id,
        "data-fk": `row:${f.id}`,
        "aria-label": `${f.text}, ${where}, ${shown}, ${said}`,
        onclick: () => this.select(f.id),
      },
      h(
        "span",
        { class: "rv-row-top" },
        dot,
        h("span", { class: "rv-row-name" }, f.text),
        h("span", { class: "rv-row-times" }, times),
        h("span", { class: "spacer" }),
        chip,
      ),
      state,
    );
  }

  // ── document text ──────────────────────────────────────────────────────────

  /** Every span (detected and marked by the user), in order. */
  allSpans() {
    return [...this.data.proposals, ...this.manualSpans].sort((a, b) => a.start - b.start);
  }

  /** The document as lines of {t, off, span?}. */
  lineSegments() {
    const text = this.data.original;
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    const spans = this.allSpans();
    return starts.map((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
      const segs = [];
      let at = start;
      for (const sp of spans) {
        if (sp.end <= start || sp.start >= end) continue;
        const from = Math.max(sp.start, at);
        const stop = Math.min(sp.end, end);
        if (stop <= from) continue;
        if (from > at) segs.push({ t: text.slice(at, from), off: at });
        segs.push({ t: text.slice(from, stop), off: from, span: sp });
        at = stop;
      }
      if (at < end) segs.push({ t: text.slice(at, end), off: at });
      return { line: i + 1, segs };
    });
  }

  decisionOfSpan(span) {
    const f = this.findingOfSpan.get(span.id);
    return f ? this.decisionOf(f) : null;
  }

  /**
   * One segment as DOM. mode "real" shows the words, "token" what Claude reads. `pending`
   * overrides the decision for one finding (the preview in the decisions panel).
   */
  segNode(seg, mode, opts = {}) {
    const real = mode === "real";
    const interactive = opts.interactive !== false;
    if (!seg.span) {
      return h("span", { "data-off": real && interactive ? String(seg.off) : null }, seg.t);
    }
    const f = this.findingOfSpan.get(seg.span.id);
    let d = f ? this.decisionOf(f) : null;
    if (opts.pending && f && opts.pending.fid === f.id) d = opts.pending.decision;
    const base = {
      "data-finding": interactive && f ? f.id : null,
      tabindex: interactive ? "0" : null,
      "data-off": real && interactive ? String(seg.off) : null,
    };
    const selected = interactive && f?.id === this.selected;
    if (!d) {
      return [
        h("span", {
          ...base,
          class: cls("rv-needs", selected && "is-selected"),
          "data-role": interactive && f ? `f:${f.id}` : null,
          "aria-describedby": describeId(
            "Needs you: casefile isn’t sure who this is. Until you decide, Claude would see these words as written.",
          ),
        }, seg.t),
        MarkTag("needs"),
      ];
    }
    if (d.type === "keep") {
      return [
        h("span", {
          ...base,
          class: cls("rv-kept", selected && "is-selected"),
          "data-role": interactive && f ? `f:${f.id}` : null,
          "aria-describedby": describeId(
            `Left as written${
              d.reason ? ` (${d.reason.toLowerCase()})` : ""
            } — Claude sees these words as they are`,
          ),
        }, seg.t),
        MarkTag("kept"),
      ];
    }
    const info = this.refInfo(d.ref);
    const form = this.spanForm(seg.span, d.ref);
    const attrs = {
      ...base,
      "data-role": info.role,
      "aria-describedby": describeId(describeMark(seg.t, info.role, form)),
    };
    if (real) {
      return h(
        "span",
        { ...attrs, class: `ent ${colourClass(info)} ${shapeClass(info.kind)}` },
        seg.t,
      );
    }
    return h("span", { ...attrs, class: `token ${colourClass(info)}` }, tokenText(info.role, form));
  }

  lineCell(l, mode) {
    return h(
      "td",
      { class: mode === "real" ? "rv-real" : "rv-claude lines-claude" },
      l.segs.map((s) => this.segNode(s, mode)),
    );
  }

  renderText() {
    const v = VIEWS.find((x) => x.id === this.view);
    const lines = this.lineSegments();
    const needsLine = (l) => l.segs.some((s) => s.span && !this.decisionOfSpan(s.span));
    const numCell = (l) =>
      h(
        "th",
        { scope: "row", class: "lines-n" },
        needsLine(l)
          ? [
            h("span", { "aria-hidden": "true" }, "● "),
            h("span", { class: "sr" }, "Needs you, line "),
          ]
          : null,
        String(l.line),
      );
    const side = this.view === "side";
    const mode = this.view === "claude" ? "token" : "real";
    const table = h(
      "table",
      { class: cls("lines-table rv-lines", side && "lines-table--side") },
      h(
        "caption",
        { class: "sr" },
        side ? "You see and Claude sees, line by line" : `${v.label}, line by line`,
      ),
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { scope: "col", class: "lines-n" }, "Line"),
          side
            ? [
              h("th", { scope: "col", class: "eyebrow" }, "You see"),
              h("th", { scope: "col", class: "eyebrow lines-split" }, "Claude sees"),
            ]
            : h(
              "th",
              { scope: "col", class: "eyebrow" },
              mode === "token" ? "Claude sees" : "You see",
            ),
        ),
      ),
      h(
        "tbody",
        {},
        lines.map((l) =>
          h(
            "tr",
            { class: needsLine(l) ? "rv-line--needs" : null },
            numCell(l),
            side ? [this.lineCell(l, "real"), this.lineCell(l, "token")] : this.lineCell(l, mode),
          )
        ),
      ),
    );
    const canMark = !this.readOnly && this.view !== "claude";
    this.textEl.replaceChildren(
      h(
        "div",
        { class: "rv-text-head" },
        h("h2", { id: "rv-doc-h" }, v.label),
        h("span", { class: "muted" }, v.note),
        h("span", { class: "spacer" }),
        this.readOnly ? null : h("button", {
          type: "button",
          class: "btn",
          "data-fk": "mark-missed",
          disabled: !canMark,
          "aria-describedby": "rv-mark-hint",
          onclick: () => this.markMissed(),
        }, "Mark something missed"),
        this.readOnly ? null : h(
          "span",
          { id: "rv-mark-hint", class: "muted" },
          canMark ? "select the words first" : "switch to Original or Side by side to select words",
        ),
      ),
      h("div", { class: "rv-lines-wrap" }, table),
    );
  }

  // ── mark something missed ─────────────────────────────────────────────────

  /** Original-text offset of a DOM point inside the real-text cells, or null. */
  pointOffset(node, offset) {
    return pointOffset([...this.textEl.querySelectorAll("td.rv-real [data-off]")], node, offset);
  }

  markMissed() {
    const sel = document.getSelection();
    let range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    if (!range || !this.textEl.contains(range.commonAncestorContainer)) range = this.lastRange;
    if (!range || !this.textEl.contains(range.commonAncestorContainer)) {
      this.say("Select the words in the document first, then choose Mark something missed.");
      return;
    }
    let start = this.pointOffset(range.startContainer, range.startOffset);
    let end = this.pointOffset(range.endContainer, range.endOffset);
    if (start === null || end === null) {
      this.say("Select words in the text you see, not in Claude’s column.");
      return;
    }
    if (end < start) [start, end] = [end, start];
    const text = this.data.original;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) {
      this.say("Select the words in the document first, then choose Mark something missed.");
      return;
    }
    const hit = this.allSpans().find((s) => start < s.end && s.start < end);
    if (hit) {
      const f = this.findingOfSpan.get(hit.id);
      if (f) this.select(f.id);
      this.say("That is already marked. Its decision is open on the right.");
      return;
    }
    const value = text.slice(start, end);
    if (value.includes("\n")) {
      this.say("Mark one line at a time.");
      return;
    }
    sel?.removeAllRanges();
    this.lastRange = null;
    this.addManual(value, start);
  }

  /** Mark every unmarked occurrence of `value` as one finding that needs the user. */
  addManual(value, preferStart = -1) {
    const text = this.data.original;
    const lower = text.toLowerCase();
    const needle = value.toLowerCase();
    const isWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
    const spans = this.allSpans();
    const made = [];
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      const whole = !isWord(text[i - 1]) && !isWord(text[end]);
      if (!whole && i !== preferStart) continue;
      if ([...spans, ...made].some((s) => i < s.end && s.start < end)) continue;
      made.push({
        id: `m${++this.manualN}`,
        start: i,
        end,
        text: text.slice(i, end),
        kind: "other",
        source: "manual",
        confidence: 1,
        proposal: null,
      });
    }
    if (!made.length) return null;
    const lines = [...new Set(made.map((s) => text.slice(0, s.start).split("\n").length))];
    const f = {
      id: `mf${this.manualN}`,
      group: "needs",
      auto: false,
      kind: "other",
      colour: null,
      text: value,
      lines,
      spans: made.map((s) => s.id),
      origType: "manual",
      source: "manual",
      options: null,
    };
    this.manualSpans.push(...made);
    for (const s of made) this.spanById.set(s.id, s);
    this.manualFindings.push(f);
    // Suggest someone already in Who's who when the words are one of their names.
    const t = value.toLowerCase();
    const known = [...this.entities.values()].find((e) =>
      [...Object.values(e.forms), ...(e.aliases ?? [])].some((v) => v && v.toLowerCase() === t)
    );
    if (known) this.editing.set(f.id, { choice: known.role });
    this.buildFindings();
    this.problem = null;
    this.selected = f.id;
    this.seen.add(f.id);
    this.closeConfirm();
    this.refresh({ keepFocus: false });
    this.sideEl.querySelector("[data-fk='dec-first']")?.focus();
    announce(
      `Marked “${value}” in ${plural(made.length, "place")}. Decide who or what it is.`,
    );
    return f;
  }

  removeManual(f) {
    const ids = new Set(f.spans);
    this.manualSpans = this.manualSpans.filter((s) => !ids.has(s.id));
    for (const s of ids) this.spanById.delete(s);
    this.manualFindings = this.manualFindings.filter((m) => m.id !== f.id);
    this.decisions.delete(f.id);
    this.editing.delete(f.id);
    this.buildFindings();
    this.selected = null;
    this.refresh({ keepFocus: false });
    this.textEl.querySelector("[data-fk='mark-missed']")?.focus();
    announce(`Removed the mark on “${f.text}”.`);
  }

  say(message) {
    showToast(message);
    announce(message);
  }

  // ── decisions sidebar ─────────────────────────────────────────────────────

  renderSide() {
    this.sideEl.replaceChildren(
      this.originSection(),
      this.decisionSection(),
      this.shareSection(),
    );
  }

  originSection() {
    const name = `rv-origin-${this.data.id}`;
    const hint = this.data.originHint;
    const o = this.origin;
    const radios = ORIGIN_OPTIONS.map((opt) =>
      h(
        "label",
        { class: "rv-radio" },
        h("input", {
          type: "radio",
          name,
          value: opt.id,
          checked: o === opt.id,
          disabled: this.readOnly,
          "data-fk": `origin:${opt.id}`,
          onchange: () => this.setOrigin(opt.id),
        }),
        h("span", {}, opt.label),
        h(
          "span",
          { class: "rv-radio-tags" },
          hint?.origin === opt.id ? h("span", { class: "tiny muted" }, "suggested") : null,
          opt.id !== "mine"
            ? h("span", { class: "rv-kept-from tiny muted" }, Icon("lock"), "kept from Claude")
            : null,
        ),
      )
    );
    let status;
    if (o === null) {
      status = h(
        "p",
        { class: "rv-origin-status" },
        "Until you answer, casefile treats it as Not sure and keeps it from Claude.",
      );
    } else if (o === "mine") {
      status = h(
        "p",
        { class: "rv-origin-status" },
        h("span", { "aria-hidden": "true" }, "✓"),
        "This document can be shared with Claude, with names replaced.",
      );
    } else if (this.willShare) {
      status = h(
        "p",
        { class: "rv-origin-status" },
        h("span", { "aria-hidden": "true" }, "✓"),
        "You chose to share this one with Claude, with names replaced.",
      );
    } else {
      status = h(
        "p",
        { class: "rv-origin-status" },
        Icon("lock"),
        "Withheld from Claude. You can still read and use it here.",
      );
    }
    const releasable = this.commercial && SHAREABLE_ON_COMMERCIAL.has(o) && !this.readOnly;
    const hintLabel = ORIGIN_OPTIONS.find((x) => x.id === hint?.origin)?.label ?? hint?.origin;
    return h(
      "section",
      { class: "rv-sec", "aria-labelledby": "rv-src-h", "data-region": "origin" },
      h("h2", { id: "rv-src-h" }, "Where did you get this document?"),
      hint && hint.origin !== o && !this.readOnly
        ? Callout({
          tone: "info",
          title: `Looks like it may be: ${hintLabel}`,
          children: `Line ${hint.line}. ${hint.reason}`,
        })
        : null,
      h("div", { role: "radiogroup", "aria-labelledby": "rv-src-h", class: "rv-radios" }, radios),
      h("p", {}, this.planText()),
      status,
      releasable
        ? h(
          "label",
          { class: "rv-check" },
          h("input", {
            type: "checkbox",
            checked: this.release === true,
            "data-fk": "release",
            onchange: (e) => {
              this.release = e.currentTarget.checked;
              this.refresh();
            },
          }),
          h(
            "span",
            {},
            "Share this one with Claude. Your plan, as you recorded it, allows material from the other side or a subpoena to be shared one document at a time.",
          ),
        )
        : null,
      this.readOnly
        ? h(
          "p",
          { class: "small muted" },
          "To change where it came from, open ",
          h("a", { href: `#/doc/${this.data.id}` }, "the document"),
          ".",
        )
        : null,
    );
  }

  planText() {
    const rules = "This follows the Court’s rules on AI (PD-AI 5.5).";
    if (this.commercial) {
      return `Your Claude plan, as you recorded it, is a commercial plan with its three conditions confirmed. Material from the other side or a subpoena can be shared one document at a time, if you choose. Anything under an order or undertaking, and anything you’re not sure about, stays away from Claude. ${rules}`;
    }
    const recorded = this.plan?.at
      ? "Your Claude plan, as you recorded it, is a consumer plan,"
      : "You haven’t recorded a commercial Claude plan, so casefile treats yours as a consumer plan,";
    return `${recorded} which doesn’t promise to keep your material out of training. So casefile keeps anything from the other side, a subpoena or the court, or under an order or undertaking — and anything you’re not sure about — away from Claude. ${rules}`;
  }

  async setOrigin(origin) {
    try {
      const r = await api("PUT", `/api/docs/${this.data.id}/origin`, { origin });
      this.data.origin = origin;
      this.data.state = r.state;
      if (!SHAREABLE_ON_COMMERCIAL.has(origin)) this.release = false;
      this.closeConfirm();
      this.refresh();
      this.markQueue(r.state);
      const label = ORIGIN_OPTIONS.find((x) => x.id === origin).label;
      announce(
        origin === "mine"
          ? `${label}. This document can be shared with Claude.`
          : `${label}. Withheld from Claude.`,
      );
    } catch (e) {
      this.refresh();
      showToast(e.message ?? String(e), { tone: "danger" });
    }
  }

  decisionSection() {
    if (this.readOnly) return this.sharedSection();
    const f = this.findingById(this.selected);
    if (!f) {
      return h(
        "section",
        { class: "rv-sec rv-decide", "aria-labelledby": "rv-fd-h", "data-region": "decide" },
        h("h2", { id: "rv-fd-h" }, "Decide a finding"),
        h(
          "p",
          { class: "muted" },
          this.findings.length
            ? "Choose a finding in the list, or a highlighted name in the text."
            : "Nothing was found. If you see a name or number casefile missed, select it in the text and choose Mark something missed.",
        ),
      );
    }
    const st = this.statusOf(f);
    const d = this.decisionOf(f);
    const ed = this.editing.get(f.id) ?? {};
    const span0 = this.spanById.get(f.spans[0]);
    const where = `${linesText(f.lines, true)} · ${
      f.origType === "earlier" ? "left as written earlier" : SOURCE_TEXT[f.source] ?? "found"
    }`;
    const open = !ed.leaving && (st === "needs" || ed.changing);
    const body = [];

    if (ed.leaving) body.push(this.leaveForm(f, ed));
    else if (open) body.push(this.chooser(f, ed));
    else if (d.type === "replace") {
      body.push(
        h(
          "p",
          {},
          `Replaced with the label for ${this.refInfo(d.ref).name}. `,
          h("button", {
            type: "button",
            class: "btn-link",
            "data-fk": "dec-first",
            onclick: () => this.startChange(f),
          }, "Change"),
        ),
      );
    } else {
      body.push(
        h(
          "p",
          {},
          `Left as written. Reason: ${d.reason || "none recorded"}. `,
          f.origType === "earlier" ? null : h("button", {
            type: "button",
            class: "btn-link",
            "data-fk": "dec-first",
            onclick: () => this.undoKeep(f),
          }, "Change"),
        ),
      );
    }

    // What Claude will see on this line.
    const pending = open ? this.pendingDecision(f, ed) : ed.leaving ? { type: "keep" } : null;
    if (span0) {
      body.push(
        h(
          "div",
          { class: "vstack gap-sm" },
          h(
            "span",
            {},
            open && pending
              ? "If you replace it, Claude will see:"
              : "Claude will see exactly this:",
          ),
          this.preview(f, pending),
        ),
      );
    }

    if (open) {
      const safetyRoles = this.safetyRolesOf(f);
      const noteId = "rv-safety-note";
      body.push(
        h(
          "div",
          { class: "hstack" },
          h("button", {
            type: "button",
            class: "btn btn-primary btn-lg",
            "data-fk": "dec-replace",
            disabled: !pending,
            onclick: () => this.applyReplace(f),
          }, "Replace"),
          h("button", {
            type: "button",
            class: "btn btn-lg",
            "data-fk": "dec-leave",
            disabled: safetyRoles.length > 0,
            "aria-describedby": safetyRoles.length ? noteId : null,
            onclick: () => this.startLeave(f),
          }, "Leave as written…"),
          f.origType === "manual"
            ? h("button", {
              type: "button",
              class: "btn btn-quiet",
              "data-fk": "dec-remove",
              onclick: () => this.removeManual(f),
            }, "Remove this mark")
            : null,
          ed.changing
            ? h("button", {
              type: "button",
              class: "btn btn-quiet",
              "data-fk": "dec-cancel",
              onclick: () => {
                this.editing.delete(f.id);
                this.refresh();
                this.sideEl.querySelector("[data-fk='dec-first']")?.focus();
              },
            }, "Cancel")
            : null,
        ),
        safetyRoles.length
          ? h(
            "p",
            { id: noteId, class: "rv-safety" },
            Icon("lock"),
            `${safetyRoles.map((r) => this.refInfo(r).name).join(" and ")} ${
              safetyRoles.length === 1 ? "is" : "are"
            } marked safety-sensitive, so this is always replaced. casefile won’t leave it as written.`,
          )
          : null,
      );
    }

    return h(
      "section",
      { class: "rv-sec rv-decide", "aria-labelledby": "rv-fd-h", "data-region": "decide" },
      h(
        "div",
        { class: "vstack gap-sm" },
        h("span", { class: "small muted" }, where),
        h(
          "div",
          { class: "hstack" },
          h("h2", { id: "rv-fd-h", class: "rv-fd-name" }, f.text),
          decisionBadge(st),
        ),
      ),
      body,
    );
  }

  /** The decision the chooser currently describes (before Replace), or null. */
  pendingDecision(f, ed) {
    const choice = ed.choice ?? this.defaultChoice(f);
    if (!choice) return null;
    if (choice.startsWith("new:")) {
      return { type: "replace", ref: PREVIEW_REF, newKind: choice.slice(4) };
    }
    return { type: "replace", ref: choice };
  }

  defaultChoice(f) {
    const d = this.decisionOf(f);
    if (d?.type === "replace") {
      if (this.userNew.has(d.ref)) return `new:${this.userNew.get(d.ref).kind}`;
      return d.ref;
    }
    if (f.options?.length) return f.options[0].ref;
    return null;
  }

  /** "Which person is this?" (several possible people) or "Who or what is this?" (anything). */
  chooser(f, ed) {
    const choice = ed.choice ?? this.defaultChoice(f);
    const pick = (v) => {
      this.editing.set(f.id, { ...ed, choice: v });
      this.refresh();
    };
    if (f.options?.length) {
      const name = `rv-who-${f.id}`;
      const opts = f.options.map((o, i) => {
        const info = this.refInfo(o.ref);
        return h(
          "label",
          { class: "rv-who" },
          h("input", {
            type: "radio",
            name,
            value: o.ref,
            checked: choice === o.ref,
            "data-fk": i === 0 ? "dec-first" : `who:${o.ref}`,
            onchange: () => pick(o.ref),
          }),
          h(
            "span",
            { class: "rv-who-name" },
            EntityDot(info),
            info.name,
            h("span", { class: `token ${colourClass(info)}` }, tokenText(info.role, o.form)),
          ),
          h("span", { class: "tiny muted" }, i === 0 ? "Best guess" : ""),
        );
      });
      opts.push(
        h(
          "label",
          { class: "rv-who" },
          h("input", {
            type: "radio",
            name,
            value: "new:person",
            checked: choice === "new:person",
            "data-fk": "who:new",
            onchange: () => pick("new:person"),
          }),
          h(
            "span",
            { class: "rv-who-name" },
            h("span", { class: "rv-dot rv-dot--new", "aria-hidden": "true" }),
            "Someone not on the list",
          ),
          h("span", { class: "tiny muted" }, "gets a new label"),
        ),
      );
      return h("fieldset", { class: "rv-whos" }, h("legend", {}, "Which person is this?"), opts);
    }
    // Anyone in Who's who, or something new.
    const groups = { people: [], places: [], ids: [] };
    for (const e of this.entities.values()) groups[groupOfKind(e.kind)].push(e);
    const id = `rv-pick-${f.id}`;
    const option = (e) =>
      h(
        "option",
        { value: e.role, selected: choice === e.role },
        `${e.forms.full} — ${tokenText(e.role)}`,
      );
    return h(
      "div",
      { class: "vstack gap-sm" },
      h("label", { for: id }, "Who or what is this?"),
      h(
        "select",
        {
          id,
          class: "rv-select",
          "data-fk": "dec-first",
          onchange: (e) => pick(e.currentTarget.value || null),
        },
        h("option", { value: "", selected: !choice }, "Choose who or what this is"),
        h("optgroup", { label: "People" }, groups.people.map(option)),
        h("optgroup", { label: "Places & organisations" }, groups.places.map(option)),
        h("optgroup", { label: "Numbers, dates & addresses" }, groups.ids.map(option)),
        h(
          "optgroup",
          { label: "Not on the list" },
          NEW_KINDS.map((k) =>
            h("option", { value: `new:${k.kind}`, selected: choice === `new:${k.kind}` }, k.label)
          ),
        ),
      ),
    );
  }

  /** The finding's first line, in Claude's labels, with `pending` applied to this finding. */
  preview(f, pending) {
    const span0 = this.spanById.get(f.spans[0]);
    const lineNo = this.data.original.slice(0, span0.start).split("\n").length;
    const l = this.lineSegments()[lineNo - 1];
    if (pending?.newKind) {
      this.previewNew = {
        kind: pending.newKind,
        full: f.text,
        role: this.peekProvisional(pending.newKind),
      };
    }
    const nodes = l.segs.map((s) =>
      this.segNode(s, "token", {
        interactive: false,
        pending: pending ? { fid: f.id, decision: pending } : null,
      })
    );
    this.previewNew = null;
    return h("p", { class: "rv-preview" }, nodes);
  }

  leaveForm(f, ed) {
    const id = `rv-why-${f.id}`;
    const otherId = `rv-why-other-${f.id}`;
    const reason = ed.reason ?? "";
    const other = ed.other ?? "";
    const isReady = (e) => Boolean(e.reason && (e.reason !== "other" || (e.other ?? "").trim()));
    const update = (patch) => this.editing.set(f.id, { ...this.editing.get(f.id), ...patch });
    const confirmBtn = h("button", {
      type: "button",
      class: "btn btn-primary btn-lg",
      "data-fk": "leave-ok",
      disabled: !isReady(ed),
      onclick: () => this.applyKeep(f),
    }, "Leave as written");
    return h(
      "div",
      { class: "rv-leave" },
      h(
        "label",
        { for: id },
        `Why leave “${f.text}” as written? `,
        h("span", { class: "muted" }, "(needed)"),
      ),
      h(
        "select",
        {
          id,
          required: true,
          "data-fk": "dec-first",
          onchange: (e) => {
            update({ reason: e.currentTarget.value });
            this.refresh();
          },
        },
        h("option", { value: "", selected: !reason }, "Choose a reason"),
        REASONS.map((r) => h("option", { value: r.id, selected: reason === r.id }, r.label)),
      ),
      reason === "other"
        ? h(
          "div",
          { class: "vstack gap-sm" },
          h("label", { for: otherId }, "Say why"),
          h("input", {
            id: otherId,
            type: "text",
            value: other,
            "data-fk": "leave-other",
            oninput: (e) => {
              update({ other: e.currentTarget.value });
              confirmBtn.disabled = !isReady(this.editing.get(f.id));
            },
          }),
        )
        : null,
      h("p", {}, this.leaveWarning(f)),
      h(
        "div",
        { class: "hstack" },
        confirmBtn,
        h("button", {
          type: "button",
          class: "btn btn-lg",
          "data-fk": "leave-cancel",
          onclick: () => {
            update({ leaving: false });
            this.refresh();
            this.sideEl.querySelector("[data-fk='dec-leave']")?.focus();
          },
        }, "Cancel"),
      ),
    );
  }

  leaveWarning(f) {
    const tail = "If you leave it, Claude will be able to read it in this document.";
    const roles = this.candidateRoles(f);
    if (!roles.length) return `Claude will see “${f.text}” exactly as written. ${tail}`;
    const t = f.text.trim().toLowerCase();
    if (roles.length === 1) {
      const e = this.entities.get(roles[0]);
      const form = Object.entries(e.forms).find(([, v]) => v && v.toLowerCase() === t)?.[0];
      if (e.kind === "person" && form) {
        return `“${f.text}” is ${e.forms.full}’s ${FORM_WORDS[form]}. ${tail}`;
      }
      return `“${f.text}” is in Who’s who as ${e.forms.full}. ${tail}`;
    }
    const names = roles.map((r) => this.refInfo(r).name);
    return `“${f.text}” could be ${names.join(" or ")}. ${tail}`;
  }

  startChange(f) {
    this.editing.set(f.id, { changing: true, choice: this.defaultChoice(f) });
    this.refresh();
    this.sideEl.querySelector("[data-fk='dec-first']")?.focus();
  }

  startLeave(f) {
    if (this.safetyRolesOf(f).length) return;
    this.editing.set(f.id, { ...(this.editing.get(f.id) ?? {}), leaving: true });
    this.refresh();
    this.sideEl.querySelector("[data-fk='dec-first']")?.focus();
  }

  undoKeep(f) {
    this.decisions.delete(f.id);
    this.editing.set(f.id, { changing: true, choice: this.defaultChoice(f) });
    this.closeConfirm();
    this.refresh();
    this.sideEl.querySelector("[data-fk='dec-first']")?.focus();
  }

  applyReplace(f) {
    const ed = this.editing.get(f.id) ?? {};
    const choice = ed.choice ?? this.defaultChoice(f);
    if (!choice) return;
    let ref = choice;
    if (choice.startsWith("new:")) {
      const kind = choice.slice(4);
      const prev = this.decisions.get(f.id);
      if (prev?.type === "replace" && this.userNew.get(prev.ref)?.kind === kind) ref = prev.ref;
      else {
        ref = `user:${++this.userNewN}`;
        this.userNew.set(ref, { ref, kind, full: f.text.trim(), role: this.provisional(kind) });
      }
    }
    this.decisions.set(f.id, { type: "replace", ref });
    this.editing.delete(f.id);
    this.problem = null;
    this.closeConfirm();
    const info = this.refInfo(ref);
    const span0 = this.spanById.get(f.spans[0]);
    announce(
      `Replaced. Claude will see ${
        tokenText(info.role, this.spanForm(span0, ref))
      } for “${f.text}”.`,
    );
    this.focusAfterDecision(f);
  }

  applyKeep(f) {
    const ed = this.editing.get(f.id) ?? {};
    const r = REASONS.find((x) => x.id === ed.reason);
    if (!r || this.safetyRolesOf(f).length) return;
    const other = (ed.other ?? "").trim();
    if (r.id === "other" && !other) return;
    const reason = r.id === "other" ? `Other: ${other}` : r.label;
    this.decisions.set(f.id, { type: "keep", reason });
    this.editing.delete(f.id);
    this.problem = null;
    this.closeConfirm();
    announce(`Left “${f.text}” as written. Claude will be able to read it.`);
    this.focusAfterDecision(f);
  }

  /** After a decision, move to the next finding that needs the user, or to Share. */
  focusAfterDecision(f) {
    const next = this.findings.find((x) => this.statusOf(x) === "needs");
    if (next) {
      this.selected = next.id;
      this.seen.add(next.id);
      this.refresh({ keepFocus: false });
      this.sideEl.querySelector("[data-fk='dec-first']")?.focus();
      return;
    }
    this.refresh({ keepFocus: false });
    const share = this.sideEl.querySelector("[data-fk='share']");
    if (share && !share.disabled) share.focus();
    else {
      (this.sideEl.querySelector("[data-fk='dec-first']") ??
        this.root.querySelector(`[data-fk="row:${f.id}"]`))?.focus();
    }
  }

  // ── after sharing: read-only ──────────────────────────────────────────────

  sharedSection() {
    const shared = this.data.state === "shared";
    return h(
      "section",
      { class: "rv-sec rv-decide", "aria-labelledby": "rv-fd-h", "data-region": "decide" },
      h("h2", { id: "rv-fd-h" }, shared ? "Shared with Claude" : "Review finished"),
      h(
        "p",
        {},
        shared
          ? "Claude can read this document with names replaced. To change what Claude sees, review it again: Claude loses it until you share it again."
          : "Claude can’t see this document. It stays here for you.",
      ),
      h(
        "div",
        { class: "hstack" },
        h("button", {
          type: "button",
          class: "btn btn-lg",
          "data-fk": "reopen",
          onclick: () => this.reopen(),
        }, "Review again"),
        h("a", { class: "btn btn-lg", href: `#/doc/${this.data.id}` }, "Open document"),
      ),
    );
  }

  async reopen() {
    try {
      await api("POST", `/api/docs/${this.data.id}/reopen`);
      const data = await api("GET", `/api/docs/${this.data.id}/review`);
      this.data = null;
      this.load(data);
      this.selected = this.findings.find((f) => this.statusOf(f) === "needs")?.id ?? null;
      this.refresh({ keepFocus: false });
      this.markQueue(data.state);
      this.ctx.refreshCounts?.();
      this.headEl.querySelector("h1")?.focus();
      announce("Reviewing again. Claude can’t see this document until you share it again.");
    } catch (e) {
      showToast(e.message ?? String(e), { tone: "danger" });
    }
  }

  // ── finish: share or keep ─────────────────────────────────────────────────

  shareSection() {
    const c = this.counts();
    const needs = this.findings.filter((f) => this.statusOf(f) === "needs");
    const noOrigin = this.origin === null;
    const next = this.readOnly ? this.nextInQueue() : null;
    let note;
    let label = this.willShare || noOrigin ? "Share with Claude" : "Finish review";
    let disabled = false;
    if (this.readOnly) {
      label = this.data.state === "shared" ? "Shared with Claude" : "Review finished";
      disabled = true;
      note = this.data.state === "shared"
        ? "Shared. You can withdraw it from Claude in Documents."
        : "Kept from Claude. You can still read and use it here.";
    } else if (needs.length || noOrigin || this.titleLeaks.length) {
      disabled = true;
      const parts = [];
      if (this.titleLeaks.length) {
        const words = [...new Set(this.titleLeaks.map((l) => l.text).filter(Boolean))];
        parts.push(
          words.length
            ? `The title would still show who someone is: ${
              words.map((t) => `“${t}”`).join(" and ")
            }. Change the title first.`
            : "casefile couldn’t check the title. Change the title, or try again.",
        );
      }
      if (needs.length) {
        const first = needs.slice(0, 3).map((f) => `${f.text}, ${linesText(f.lines)}`).join("; ");
        parts.push(
          `${plural(needs.length, "finding")} still ${
            needs.length === 1 ? "needs" : "need"
          } you: ${first}${needs.length > 3 ? "; …" : ""}.`,
        );
      }
      if (noOrigin) parts.push("Answer “Where did you get this document?” first.");
      note = parts.join(" ");
    } else if (!this.willShare) {
      note = "Claude won’t see this document. It stays here for you.";
    } else {
      note = "You’ll see exactly what Claude gets before anything is sent.";
    }
    return h(
      "section",
      { class: "rv-sec rv-share", "aria-labelledby": "rv-share-h", "data-region": "share" },
      h("h2", { id: "rv-share-h", class: "sr" }, "Finish this document"),
      !this.readOnly && c.unseen > 0
        ? h(
          "p",
          {},
          `${plural(c.unseen, "finding")} ${
            c.unseen === 1 ? "was" : "were"
          } decided automatically and you haven’t looked at ${
            c.unseen === 1 ? "it" : "them"
          } yet. `,
          h("button", {
            type: "button",
            class: "btn-link",
            "data-fk": "show-unseen",
            onclick: () => {
              this.filter = "unseen";
              this.refresh();
              this.findingsEl.querySelector("button.rv-row")?.focus();
              announce(`Showing ${plural(this.counts().unseen, "finding")}: not looked at yet.`);
            },
          }, "Show them"),
        )
        : null,
      this.problem,
      !this.readOnly && !this.problem && this.titleLeaks.length ? this.titleFixer() : null,
      h("p", { id: "rv-share-note", class: "rv-share-note" }, note),
      h("button", {
        type: "button",
        class: "btn btn-primary btn-lg rv-share-btn",
        "aria-describedby": "rv-share-note",
        "data-fk": "share",
        disabled,
        onclick: () => (this.willShare ? this.openConfirm() : this.finish()),
      }, label),
      next
        ? h(
          "a",
          { class: "btn btn-lg", href: this.queueHref(next.id) },
          `Next: ${next.id} ${next.title}`,
        )
        : null,
    );
  }

  keptSummary() {
    const kept = this.findings
      .map((f) => ({ f, d: this.decisionOf(f) }))
      .filter((x) => x.d?.type === "keep");
    if (!kept.length) return "Nothing is left as written.";
    const items = kept.map((x) => `“${x.f.text}” (${(x.d.reason || "no reason").toLowerCase()})`);
    return `${kept.length} left as written: ${andList(items)}.`;
  }

  openConfirm() {
    if (this.confirmOpen) return this.confirmBar?.focusPrimary();
    const req = this.request();
    const values = this.findings.filter((f) => this.decisionOf(f)?.type === "replace").length;
    const places = req.replacements.length;
    const bar = ConfirmBar({
      sticky: true,
      summary: [
        `Claude will see this document with ${
          plural(values, "name or number", "names and numbers")
        } replaced${
          places !== values ? ` (${places} places in the text)` : ""
        }. Title Claude sees: `,
        h("span", { class: "rv-claude-title-text" }, this.titleSegments()),
        ". You can withdraw it later.",
      ],
      detail: [
        this.keptSummary(),
        req.release
          ? " It came from the other side or a subpoena; your plan, as you recorded it, lets you share it on its own."
          : null,
      ],
      confirmLabel: "Share",
      onConfirm: () => this.share(),
      onCancel: () => {
        this.closeConfirm();
        this.sideEl.querySelector("[data-fk='share']")?.focus();
        announce("Not shared.");
      },
    });
    bar.setAttribute("aria-label", "Confirm sharing");
    this.confirmBar = bar;
    this.confirmOpen = true;
    this.confirmHost.replaceChildren(bar);
    bar.focusPrimary();
    announce("Check what Claude will see, then choose Share or Cancel.");
  }

  closeConfirm() {
    this.confirmOpen = false;
    this.confirmBar = null;
    this.confirmHost?.replaceChildren();
  }

  async share() {
    if (!(await this.send())) return;
    this.closeConfirm();
    const message = this.data.state === "shared"
      ? "Shared with Claude, with names replaced."
      : "Review finished. Claude can’t see this document.";
    showToast(message, { glyph: "check", undo: () => this.undo() });
    announce(message);
    this.sideEl.querySelector("[data-fk='reopen']")?.focus();
  }

  async finish() {
    if (!(await this.send())) return;
    const message = "Review finished. Claude can’t see this document.";
    showToast(message, { glyph: "check", undo: () => this.undo() });
    announce(message);
    this.sideEl.querySelector("[data-fk='reopen']")?.focus();
  }

  /** Send the decisions. Returns true when casefile accepted them. */
  async send() {
    try {
      const r = await api("POST", `/api/docs/${this.data.id}/publish`, this.request());
      this.data.status = "published";
      this.data.state = r.state;
      if (this.titleDraft !== undefined) {
        this.data.title = this.titleDraft;
        this.titleDraft = undefined;
      }
      this.problem = null;
      this.selected = null;
      this.refresh({ keepFocus: false });
      this.markQueue(r.state);
      this.ctx.refreshCounts?.();
      return true;
    } catch (e) {
      this.closeConfirm();
      this.problem = this.problemCallout(e);
      this.refresh({ keepFocus: false });
      this.sideEl.querySelector(".rv-problem")?.focus();
      return false;
    }
  }

  async undo() {
    try {
      await api("POST", `/api/docs/${this.data.id}/withdraw`);
      const data = await api("GET", `/api/docs/${this.data.id}/review`);
      this.load(data);
      this.markQueue(data.state);
      this.refresh({ keepFocus: false });
      this.ctx.refreshCounts?.();
      this.sideEl.querySelector("[data-fk='share']")?.focus();
      const msg = "Withdrawn. Claude can no longer see this document; your decisions are kept.";
      showToast(msg);
      announce(msg);
    } catch (e) {
      showToast(e.message ?? String(e), { tone: "danger" });
    }
  }

  /** A field to give the document a title Claude may see (after a refusal over the title). */
  titleFixer() {
    const id = `rv-title-${this.data.id}`;
    const input = h("input", { id, type: "text", value: this.titleText, class: "rv-title-input" });
    return h(
      "span",
      { class: "vstack gap-sm rv-title-fix" },
      h("label", { for: id }, "Title Claude will see (names are replaced where casefile can)"),
      input,
      h("button", {
        type: "button",
        class: "btn",
        onclick: () => {
          const v = input.value.trim();
          if (!v) return;
          this.titleDraft = v;
          this.problem = null;
          this.refresh({ keepFocus: false });
          this.sideEl.querySelector("[data-fk='share']")?.focus();
          announce(`Title changed to “${v}”. Share again when you’re ready.`);
        },
      }, "Use this title"),
    );
  }

  /** What went wrong, in plain words, with a way forward. */
  problemCallout(e) {
    const body = e instanceof ApiError ? e.body : {};
    const wrap = (callout) =>
      h("div", { class: "rv-problem", tabindex: "-1", role: "alert" }, callout);
    if (Array.isArray(body.leaks) && body.leaks.length) {
      const seen = new Set();
      const items = body.leaks.filter((l) => {
        const k = `${l.field}:${l.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return wrap(Callout({
        tone: "danger",
        title: "Not shared: these would still show who someone is",
        children: h(
          "ul",
          { class: "rv-problem-list" },
          items.map((l) =>
            h(
              "li",
              {},
              l.text ? h("span", { class: "mono" }, `“${l.text}”`) : null,
              ` ${l.field === "title" ? "in the title" : "in the text"}`,
              l.reason ? ` — ${l.reason}. ` : ". ",
              l.field === "body" && l.text
                ? h("button", {
                  type: "button",
                  class: "btn",
                  onclick: () => {
                    if (!this.addManual(l.text)) this.say(`“${l.text}” is already marked.`);
                  },
                }, `Mark “${l.text}”`)
                : l.field === "title"
                ? this.titleFixer()
                : null,
            )
          ),
        ),
      }));
    }
    if (Array.isArray(body.safety)) {
      return wrap(Callout({
        tone: "danger",
        title: "Not shared: a safety-sensitive name would be left as written",
        children: body.error ?? e.message,
      }));
    }
    return wrap(Callout({ tone: "danger", title: "Not shared", children: e.message ?? String(e) }));
  }
}
