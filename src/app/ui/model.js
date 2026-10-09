// Pure UI model: state → label/glyph/tone, actor labels, entity colour classes, citation
// formatting and the segment → DOM plan. No DOM access here, so tests/ui_model_test.ts can run
// it under Deno. Copy comes from DESIGN-SPEC §3 and §6; change it here, not in views.

// ── status vocabulary (spec §3) ───────────────────────────────────────────────

/** Tones: the only two status hues are attention and danger; everything else is neutral. */
export const TONES = /** @type {const} */ (["neutral", "attention", "danger"]);

/** Glyph names understood by components/icons.js. */
export const GLYPHS = /** @type {const} */ ([
  "check",
  "dot",
  "triangle",
  "info",
  "pen",
  "lock",
]);

/** Text fallback for each glyph (used for screen-reader-free contexts and the tests). */
export const GLYPH_TEXT = {
  check: "✓",
  dot: "●",
  triangle: "▲",
  info: "i",
  pen: "✎",
  lock: "🔒",
};

/**
 * Every state that may appear in a Badge, per domain. A badge for anything not listed here is a
 * bug: badgeFor() throws.
 */
export const STATES = {
  doc: {
    needs_review: { label: "Needs review", tone: "attention", glyph: "dot" },
    shared: { label: "Shared with Claude", tone: "neutral", glyph: "check" },
    withheld: { label: "Withheld from Claude", tone: "neutral", glyph: "lock" },
    exposed: { label: "Exposed — re-check", tone: "danger", glyph: "triangle" },
  },
  work: {
    to_check: { label: "To check", tone: "attention", glyph: "dot" },
    checked: { label: "Checked against source", tone: "neutral", glyph: "check" },
    changed: { label: "Changed since you checked", tone: "attention", glyph: "dot" },
    cant_check: { label: "Can’t check", tone: "danger", glyph: "triangle" },
  },
  para: {
    user: { label: "Your words", tone: "neutral", glyph: "check" },
    claude_needs_you: { label: "Drafted by Claude — needs you", tone: "attention", glyph: "dot" },
    claude_rewritten: {
      label: "Drafted by Claude — rewritten by you, adopt to confirm",
      tone: "attention",
      glyph: "dot",
    },
    claude_adopted: { label: "Drafted by Claude — adopted", tone: "neutral", glyph: "pen" },
  },
};

/**
 * The Badge plan for a state: { label, tone, glyph, className }.
 * @param {"doc"|"work"|"para"} domain
 * @param {string} state
 */
export function badgeFor(domain, state) {
  const table = STATES[domain];
  if (!table) throw new Error(`Unknown badge domain: ${domain}`);
  const def = Object.hasOwn(table, state) ? table[state] : null;
  if (!def) throw new Error(`Not a ${domain} state: ${state}`);
  return { state, ...def, className: toneClass(def.tone) };
}

/** Badge class for a tone. */
export function toneClass(tone) {
  if (!TONES.includes(tone)) throw new Error(`Unknown tone: ${tone}`);
  return `badge badge--${tone}`;
}

// ── who did it (spec §2) ──────────────────────────────────────────────────────

export const ACTORS = {
  claude: { label: "Claude", glyph: "pen" },
  user: { label: "You", glyph: null },
  app: { label: "casefile checked", glyph: "check" },
};

/** Normalise the API's actor spellings ("claude", "user", "you", "app", "casefile"). */
export function actorFor(by) {
  const key = by === "you" ? "user" : by === "casefile" ? "app" : by;
  const a = ACTORS[key];
  if (!a) throw new Error(`Unknown actor: ${by}`);
  return { actor: key, ...a };
}

// ── entity colour (spec §4) ───────────────────────────────────────────────────

/** The six colour slots, in palette order. Index = slot number = `.ent-c<n>`. */
export const ENTITY_SLOTS = ["#FFAABB", "#77AADD", "#44BB99", "#BBCC33", "#99DDFF", "#EEDD88"];
export const ENTITY_INK = "#D5DAE0";
export const ENTITY_ID = "#C3CAD1";

/** Default slots until the API sends `colour` (W1-E): parties and children only. */
export const DEFAULT_SLOTS = { mother: 0, father: 1, child_1: 2, child_2: 3 };

const PERSON_KINDS = new Set(["person"]);
const IDENT_KINDS = new Set([
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

/** "person" | "place" | "id" — which underline shape and key group an entity kind uses. */
export function entityShape(kind) {
  if (PERSON_KINDS.has(kind)) return "person";
  if (IDENT_KINDS.has(kind)) return "id";
  return "place"; // place, organisation, school, other
}

/** Shape class: solid for people, dashed for places and organisations, dotted for numbers. */
export function shapeClass(kind) {
  const s = entityShape(kind);
  return s === "person" ? "ent-solid" : s === "id" ? "ent-dotted" : "ent-dashed";
}

/**
 * The colour class for an entity: `ent-c0…ent-c5` for a coloured slot, `ent-id` for numbers,
 * dates and addresses, otherwise `ent-ink` (neutral).
 * @param {{role?: string, kind?: string, colour?: number|null}} e
 */
export function colourClass(e) {
  if (entityShape(e.kind ?? "person") === "id") return "ent-id";
  let slot = e.colour;
  if (slot === undefined) slot = DEFAULT_SLOTS[e.role ?? ""];
  if (Number.isInteger(slot) && slot >= 0 && slot < ENTITY_SLOTS.length) return `ent-c${slot}`;
  return "ent-ink";
}

/** `{{role}}` or `{{role.form}}`; the full form has no suffix. */
export function tokenText(role, form) {
  return `{{${role}${form && form !== "full" ? `.${form}` : ""}}}`;
}

/**
 * Text from the API ({text, segs}, re-identified for the user) back as what Claude reads: each
 * known name as its label, unknown or malformed labels as written. For a field whose value is
 * saved back as tokenised text (a description, a request to Claude).
 * @param {{segs?: object[]}|null|undefined} rich
 */
export function tokenisedFrom(rich) {
  if (!rich) return "";
  return (rich.segs ?? []).map((s) => (s.role ? tokenText(s.role, s.form) : s.raw ?? s.t))
    .join("");
}

/** A role as words: "maternal_grandmother" → "maternal grandmother"; "child_1" → "child 1". */
export function roleLabel(role) {
  return String(role).replace(/_(\d+)$/, " $1").replace(/_/g, " ");
}

/** Hidden description for a mark: "Anna Thornbury — Claude sees {{mother.first}}". */
export function describeMark(name, role, form) {
  return `${name} — Claude sees ${tokenText(role, form)}`;
}

// ── segments → DOM plan ───────────────────────────────────────────────────────

/**
 * Turn API segments into a render plan. A segment is one of:
 *   {t}                                  plain text
 *   {t, role, form?, kind?, colour?, name?}  a real value (t) Claude sees as a token
 *   {t, unknown: true, raw}              a token casefile does not know
 *   {t, malformed: true, raw}            broken token syntax
 * Plain strings are accepted as plain text.
 *
 * mode "real" shows the real text as an EntityMark; mode "token" shows the token as a TokenChip.
 * Returns parts: {type: "text"|"mark"|"chip"|"unknown", text, role?, className?, describe?}.
 * @param {Array<object|string>} segs
 * @param {{mode?: "real"|"token"}} [opts]
 */
export function planSegments(segs, opts = {}) {
  const mode = opts.mode ?? "real";
  const out = [];
  for (const s of segs ?? []) {
    const seg = typeof s === "string" ? { t: s } : s;
    if (seg.unknown || seg.malformed) {
      out.push({
        type: "unknown",
        text: seg.raw ?? seg.t,
        className: "token token--unknown",
        describe: seg.malformed
          ? "Broken label — casefile can’t read it. Check this."
          : "Not a label casefile knows. Check this.",
      });
      continue;
    }
    if (!seg.role) {
      out.push({ type: "text", text: seg.t ?? "" });
      continue;
    }
    const kind = seg.kind ?? "person";
    const colour = colourClass({ role: seg.role, kind, colour: seg.colour });
    const tok = tokenText(seg.role, seg.form);
    const describe = describeMark(seg.name ?? seg.t, seg.role, seg.form);
    if (mode === "token") {
      out.push({ type: "chip", text: tok, role: seg.role, className: `token ${colour}`, describe });
    } else {
      out.push({
        type: "mark",
        text: seg.t,
        role: seg.role,
        className: `ent ${colour} ${shapeClass(kind)}`,
        describe,
      });
    }
  }
  return out;
}

/**
 * Segments from flat text containing tokens (legacy API: shown text with leftover {{...}} for
 * unknown tokens, or tokenised text). Known tokens are only recognised when `known` lists them.
 * @param {string} text
 * @param {Record<string, {name?: string, kind?: string, colour?: number|null}>} [known]
 */
export function segmentsFromText(text, known = {}) {
  const segs = [];
  const re = /\{\{([^{}\n]{0,60})\}\}|\{\{|\}\}/g;
  let last = 0;
  for (const m of String(text ?? "").matchAll(re)) {
    if (m.index > last) segs.push({ t: text.slice(last, m.index) });
    const inner = m[1];
    const [role, form] = (inner ?? "").split(".");
    const k = inner !== undefined ? known[role] : undefined;
    if (k) segs.push({ t: m[0], role, form, kind: k.kind, colour: k.colour, name: k.name });
    else if (inner !== undefined && /^[a-z][a-z0-9_]*(\.[a-z]+)?$/.test(inner)) {
      segs.push({ t: m[0], unknown: true, raw: m[0] });
    } else segs.push({ t: m[0], malformed: true, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? "").length) segs.push({ t: text.slice(last) });
  return segs;
}

// ── citations ─────────────────────────────────────────────────────────────────

/** "line 3" or "lines 1–2". */
export function lineRange(start, end = start) {
  return end && end !== start ? `lines ${start}–${end}` : `line ${start}`;
}

/** "D001:3" or "D001:1–2" (en dash). Accepts {doc_id|doc, line_start|start, line_end|end}. */
export function formatRef(ref) {
  const doc = ref.doc_id ?? ref.doc;
  const a = ref.line_start ?? ref.start;
  const b = ref.line_end ?? ref.end ?? a;
  return `${doc}:${a}${b !== a ? `–${b}` : ""}`;
}

/** Parse "D001:1-2", "D001:1–2" or "D001:3". Returns null when it isn't a reference. */
export function parseRef(s) {
  const m = /^\s*([A-Z]\d+):(\d+)(?:\s*[-–]\s*(\d+))?\s*$/.exec(String(s ?? ""));
  if (!m) return null;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (end < start) return null;
  return { doc: m[1], start, end };
}

/** Several references: "D002:9 and D001:1–2"; three or more use commas. */
export function formatRefs(refs) {
  return andList(refs.map(formatRef));
}

/** The hash link for a cited line: #/doc/D001:3 */
export function refHref(ref) {
  return `#/doc/${ref.doc_id ?? ref.doc}:${ref.line_start ?? ref.start}`;
}

/**
 * Lines to show in a SourcePanel: the cited range plus `context` lines either side, clipped to
 * the document. `lines` is the document's lines ({line, text|segs}) or a plain string array.
 * Each result gets `cited: boolean`.
 */
export function sourceWindow(lines, start, end = start, context = 2) {
  const all = lines.map((l, i) => typeof l === "string" ? { line: i + 1, text: l } : l);
  const from = Math.max(1, start - context);
  const to = end + context;
  return all
    .filter((l) => l.line >= from && l.line <= to)
    .map((l) => ({ ...l, cited: l.line >= start && l.line <= end }));
}

// ── checks (CheckList rows) ───────────────────────────────────────────────────

export const CHECK_LEVELS = {
  ok: { glyph: "check", sr: "Matches:", className: "check--ok" },
  attention: { glyph: "dot", sr: "Look at this:", className: "check--attention" },
  danger: { glyph: "triangle", sr: "Doesn’t match:", className: "check--danger" },
};

/** Plan for a CheckRow {level, message}. */
export function checkRow(row) {
  const level = CHECK_LEVELS[row.level] ? row.level : row.ok === false ? "danger" : "ok";
  return { ...CHECK_LEVELS[level], level, message: row.message ?? row.text ?? "" };
}

// ── API normalisers (degrade while wave-1 endpoints are missing) ──────────────

/** The To-check count from /api/to-check, whatever shape it has; null if none. */
export function toCheckCount(body) {
  if (body == null) return null;
  if (typeof body === "number") return body;
  for (const k of ["total", "count"]) if (typeof body[k] === "number") return body[k];
  if (Array.isArray(body.items)) return body.items.length;
  if (Array.isArray(body.groups)) {
    return body.groups.reduce((n, g) => n + (g.count ?? g.items?.length ?? 0), 0);
  }
  if (Array.isArray(body)) return body.length;
  return null;
}

/**
 * Search results as palette groups: [{kind, label, total, items: [{href, title, text}]}].
 * Accepts /api/search/all ({totals, lines, people, chronology, issues}) or a {groups} body.
 */
export function searchGroups(body) {
  if (Array.isArray(body?.groups)) {
    return body.groups.filter((g) => (g.items ?? []).length).map((g) => ({
      kind: g.kind,
      label: g.label ?? g.kind,
      total: g.total ?? g.items.length,
      items: g.items,
    }));
  }
  if (!body || typeof body !== "object") return [];
  // /api/search/all: {q, total, totals: {lines, people, chronology, issues}, lines, people,
  // chronology, issues}. Lines, chronology descriptions and issue titles arrive as shown text
  // ({text, segs}); people as {role, name, kind}.
  const rich = (v) =>
    typeof v === "string" ? { text: v } : { text: v?.text ?? "", segs: v?.segs ?? undefined };
  const totals = body.totals ?? {};
  const groups = [
    {
      kind: "lines",
      label: "Document lines",
      items: (body.lines ?? []).map((x) => ({
        href: refHref({ doc: x.doc_id, start: x.line }),
        title: `${x.doc_id}:${x.line}`,
        ...rich(x.text),
      })),
    },
    {
      kind: "people",
      label: "People",
      items: (body.people ?? []).map((p) => ({
        href: `#/people/${encodeURIComponent(p.role)}`,
        title: p.name ?? roleLabel(p.role),
        text: roleLabel(p.role),
      })),
    },
    {
      kind: "chronology",
      label: "Chronology",
      items: (body.chronology ?? []).map((c) => ({
        href: `#/chronology?entry=${c.id}`,
        title: formatDay(c.event_date),
        ...rich(c.description),
      })),
    },
    {
      kind: "issues",
      label: "Issues",
      items: (body.issues ?? []).map((i) => ({
        href: `#/issues/${i.id}`,
        title: "Issue",
        ...rich(i.title),
      })),
    },
  ];
  return groups
    .map((g) => ({ ...g, total: Math.max(totals[g.kind] ?? 0, g.items.length) }))
    .filter((g) => g.items.length);
}

// ── small formatters ──────────────────────────────────────────────────────────

/**
 * "a", "a and b", "a, b and c". With `max`, at most that many are named and the rest are counted:
 * "a, b and 3 more".
 * @param {string[]} items @param {number} [max]
 */
export function andList(items, max = Infinity) {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 2) return shown.join(" and ");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The text with its first letter in capitals: "phone" → "Phone". */
export function capitalise(text) {
  const s = String(text);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "1 entry", "4 entries". `plural` defaults to word + "s". */
export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

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

/** "2025-03-14" → "14 March 2025"; `short` gives "14 Mar 2025". Unparseable input is returned. */
export function formatDay(iso, short = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return iso ?? "";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${Number(m[3])} ${short ? month.slice(0, 3) : month} ${m[1]}`;
}

/**
 * Whether a document date falls in a from/to range (both `YYYY-MM-DD`, either may be empty). A
 * partial date ("2025-03", "2025") covers its whole month or year and matches if any of it is in
 * the range. With a range set, a document with no date (or an unreadable one) does not match.
 * @param {string|null|undefined} date @param {string} from @param {string} to
 */
export function inDateRange(date, from, to) {
  if (!from && !to) return true;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(String(date ?? ""));
  if (!m) return false;
  const start = `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
  const end = `${m[1]}-${m[2] ?? "12"}-${m[3] ?? "31"}`;
  return (!from || end >= from) && (!to || start <= to);
}

/** A backup older than this many days is shown in amber (ADR 29). */
export const BACKUP_OVERDUE_DAYS = 14;

/**
 * "Last backup: N days ago" for Getting started and Settings (ADR 29), counted in calendar days
 * on this computer. `overdue` (shown in amber) when there is no backup or the last one is more
 * than 14 days old. No pop-up: these words are the whole reminder.
 * @param {string|null|undefined} lastAt @param {number|Date} [now]
 * @returns {{text: string, overdue: boolean, days: number|null}}
 */
export function backupNote(lastAt, now = Date.now()) {
  const at = lastAt ? new Date(lastAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { text: "No backup yet", overdue: true, days: null };
  }
  const day = (d) => {
    const x = new Date(d);
    return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  };
  const days = Math.max(0, Math.round((day(now) - day(at)) / 86_400_000));
  const text = days === 0
    ? "Last backup: today"
    : `Last backup: ${days} ${days === 1 ? "day" : "days"} ago`;
  return { text, overdue: days > BACKUP_OVERDUE_DAYS, days };
}

/** Idle-lock note for the header: "Locks after 30 min idle" / "Locks after 1 hour idle". */
export function idleNote(minutes) {
  const m = Number(minutes) || 30;
  return m === 60 ? "Locks after 1 hour idle" : `Locks after ${m} min idle`;
}

/**
 * Which copy of casefile is running (ADR 22, 23), from `/api/status` `build`: for Settings.
 * @param {{version: string|null, dev: boolean}|null|undefined} build
 */
export function buildNote(build) {
  if (!build) return null;
  if (build.dev) return "Development copy of casefile. It opens only the example case in .dev/.";
  if (!build.version) return "This copy of casefile is not a released desktop build.";
  return `casefile ${build.version}.`;
}

/** The update bar (ADR 24). */
export function updateReadyNote(version) {
  return `casefile ${version} is ready. Restart to update.`;
}

export function updateReadyLockedNote(version) {
  return `casefile ${version} is ready. Quit casefile and open it again to update.`;
}

/**
 * The result of the last update check, for Settings (ADR 24), from `/api/status` `update`.
 * @param {{enabled: boolean, ready: string|null, checking?: boolean, lastCheck?: string|null,
 *   lastError?: string|null}|null|undefined} update
 * @param {(iso: string) => string} [when] how to show the time of the last check
 */
export function updateCheckNote(update, when = (iso) => iso) {
  if (!update?.enabled) return null;
  if (update.checking) return "Checking for updates…";
  if (update.ready) return updateReadyNote(update.ready);
  if (!update.lastCheck) return "casefile hasn't checked for updates yet.";
  if (update.lastError) return `Last check (${when(update.lastCheck)}) failed: ${update.lastError}`;
  return `casefile is up to date (checked ${when(update.lastCheck)}).`;
}

export function updateRolledBackNote() {
  return "The last casefile update didn't start, so casefile went back to the version before it.";
}

/** The window title, marked on a development copy so it can't be taken for the real one. */
export function windowTitle(title, build) {
  const t = title ? `${title} — casefile` : "casefile";
  return build?.dev ? `[dev] ${t}` : t;
}

// ── contrast (spec §7) ────────────────────────────────────────────────────────

/** Text/ground pairs from tokens.css that must reach 4.5:1 (UI borders: 3:1). */
export const CONTRAST_PAIRS = {
  text: [
    ["#E3E6E9", "#121518"],
    ["#A7AFB7", "#121518"],
    ["#A7AFB7", "#15191C"],
    ["#A7AFB7", "#171B1F"],
    ["#A7AFB7", "#222830"],
    ["#E3E6E9", "#222830"],
    ["#B7DBF2", "#121518"],
    ["#B7DBF2", "#15191C"],
    ["#121518", "#E3E6E9"],
    ["#E8A33D", "#2A2418"],
    ["#F4867A", "#3A1A17"],
    ["#E8A33D", "#121518"],
    ["#F4867A", "#121518"],
    ["#D5DAE0", "#121518"],
    ["#C3CAD1", "#121518"],
    ...ENTITY_SLOTS.map((c) => [c, "#121518"]),
  ],
  // Control borders on every ground they sit on. The spec's #5A626A is 2.96:1 on the page
  // ground, so tokens.css uses #626A72 (ADR 0020).
  ui: [
    ["#626A72", "#121518"],
    ["#626A72", "#15191C"],
    ["#626A72", "#171B1F"],
    ["#626A72", "#1A1E22"],
    ["#FFD27A", "#121518"],
    ["#FFD27A", "#222830"],
    ["#E3E6E9", "#121518"],
  ],
};

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two #RRGGBB colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
