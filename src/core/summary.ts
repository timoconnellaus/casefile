import type { CaseSession, ClaudeSetup, DocInfo, PlanConditions } from "./session.ts";
import { createHmac } from "node:crypto";
import { paragraphState } from "./drafting.ts";
import { listExposures } from "./exposure.ts";
import { chronologyState, evidenceState, issueDescState, userRemoved } from "./checking.ts";
import {
  type Actor,
  type ChronologyRow,
  type DraftKind,
  type DraftRow,
  type EvidenceRow,
  formatSourceRef,
  type IssueRow,
  type LogProblem,
  type LogRow,
  type Origin,
  ORIGINS,
  type ParagraphRow,
} from "./publicdb.ts";
import type { DocState, Exposure, ParaState, WorkState } from "./states.ts";

/**
 * The To-check queue and the "If the Court asks" summary (PD-AI 4.11; ADR 0018), plus the AI-use
 * log as the user reads it (plain-language labels and categories).
 *
 * Everything here is built only from records Claude cannot forge: the attestation ledger (the
 * user's signed checks and adoptions), the vault (documents, exposures, settings and the user's
 * plan and confirmations) and the hash-chained log rows the app itself wrote (`chain_kind =
 * 'signed'`). Claude-writable public.db columns (`verified_at`, `adopted_at`, `author`,
 * `created_by`, `removed_at`, `done_at`) never raise a count or hide an item.
 *
 * The wording of the Court summary is fixed here, not in the UI, so no screen can overstate what
 * casefile knows.
 *
 * Each input comes from one small "source" function below, so it can be rewired as wave 1 lands:
 * `documentInfo` and `exposureList` (B: `listDocInfo`, exposures), `chronoState`, `evState`,
 * `issueState` and `removedIds` (C: `checking.ts`, the ledger's lapsed checks and removals),
 * `paraState` (D) and `planAndConfirmations` (B and G).
 */

// ── shared vocabulary ─────────────────────────────────────────────────────────

/** Labels for origins, as the user sees them (DESIGN-SPEC §3/§6). */
export const ORIGIN_LABELS: Record<Origin, string> = {
  mine: "Mine",
  other_side: "From the other side",
  court_or_subpoena: "From a subpoena or the court",
  under_order: "Under a court order",
  not_sure: "Not sure",
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

/** "3 September 2025" (local date). Accepts an ISO timestamp or a `YYYY[-MM[-DD]]` date. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso);
  if (m) {
    if (!m[2]) return m[1];
    if (!m[3]) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "28 September – 5 October 2025" (or one date when both fall on the same day). */
export function formatRange(from: string, to: string): string {
  const a = formatDate(from);
  const b = formatDate(to);
  if (a === b) return a;
  const [ad, am, ay] = a.split(" ");
  const [, bm, by] = b.split(" ");
  if (ay === by) return am === bm ? `${ad} – ${b}` : `${ad} ${am} – ${b}`;
  return `${a} – ${b}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── sources (rewire points) ──────────────────────────────────────────────────

/**
 * SOURCE (B): every document with its state and withheld reason, from the vault
 * (`CaseSession.listDocInfo`, the single source of truth for document states: origin, commercial
 * release, "not asked", exposure and re-checks).
 */
async function documentInfo(session: CaseSession): Promise<DocInfo[]> {
  return await session.listDocInfo();
}

/** SOURCE (B): exposures, from the vault file `exposures`. */
async function exposureList(session: CaseSession): Promise<Exposure[]> {
  return await listExposures(session);
}

/**
 * SOURCE (C): items the user removed, from the ledger (`Ledger.removedByUser`), never public.db's
 * Claude-writable `removed_at`.
 */
async function removedIds(session: CaseSession) {
  return await userRemoved(session);
}

/**
 * SOURCE (C): a chronology entry's state (checked only with a current signed check; can't check,
 * changed since you checked from `Ledger.lapsedCheck`, or to check).
 */
async function chronoState(session: CaseSession, row: ChronologyRow): Promise<WorkState> {
  return (await chronologyState(session, row)).state;
}

/** SOURCE (C): an evidence link's state. */
async function evState(session: CaseSession, row: EvidenceRow): Promise<WorkState> {
  return (await evidenceState(session, row)).state;
}

/** SOURCE (C): an issue description's state ("describes the question fairly"). */
async function issueState(session: CaseSession, row: IssueRow): Promise<WorkState> {
  return (await issueDescState(session, row)).state;
}

/**
 * SOURCE (D): a paragraph's state. Today `paragraphState` has no "rewritten" state; D adds it.
 */
async function paraState(session: CaseSession, p: ParagraphRow): Promise<ParaState> {
  return await paragraphState(session, p);
}

/** The Claude plan and PD-AI 5.4 confirmations as the user recorded them (vault settings). */
export interface PlanRecord {
  setup: ClaudeSetup;
  /** When the user recorded the plan (null: before plans were dated). */
  at: string | null;
  conditions: PlanConditions | null;
  confirmations: { helpImproveOff: string | null; chatHistory: string | null };
}

/**
 * SOURCE (B, G): the plan and confirmations, from the vault's settings (Claude cannot write the
 * vault). REWIRE after B/G if the plan moves to its own record or confirmations gain fields.
 */
export function planAndConfirmations(session: CaseSession): PlanRecord {
  const s = session.settings;
  return {
    setup: s.plan?.setup ?? s.claudeSetup,
    at: s.plan?.at ?? null,
    conditions: s.plan?.conditions ?? null,
    confirmations: {
      helpImproveOff: s.confirmations?.helpImproveOff ?? null,
      chatHistory: s.confirmations?.chatHistory ?? null,
    },
  };
}

function parseDetail(detail: string): Record<string, unknown> {
  try {
    const d = JSON.parse(detail);
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

/**
 * How far a log row can be trusted, checked row by row against the vault-held chain key (ADR 8),
 * never from a column value: written and sealed by casefile (`signed`); written by Claude's tool
 * and sealed later (`countersigned`); not sealed yet (`pending`); sealed from before sealing
 * existed (`legacy`); or anything else (`forged`): a seal that does not verify, or a row claiming
 * to be yours or casefile's that casefile did not seal.
 */
export type LogRecord = "signed" | "countersigned" | "pending" | "legacy" | "forged";

/** A log row with its parsed detail and how far it can be trusted. */
export interface SealedRow extends Omit<LogRow, "detail"> {
  detail: Record<string, unknown>;
  record: LogRecord;
}

/**
 * The same input `PublicStore` MACs when it chains a row (ADR 8). Kept in step with
 * `PublicStore.#chainInput`; fold into the store in wave 3.
 */
function chainInput(prev: string, r: LogRow): string {
  return `${prev}\n${JSON.stringify([r.id, r.ts, r.actor, r.action, r.detail, r.chain_kind])}`;
}

/**
 * SOURCE: the whole log, oldest first, each row checked against the chain key from the vault.
 * `chain_kind`, `actor` and `chain` are all Claude-writable columns, so a row is trusted only if
 * its own seal is the MAC of the previous sealed row's seal and its content (which is how the app
 * seals it). A row Claude inserts or alters fails that check and is `forged`; rows after it still
 * verify on their own, so one bad row does not hide the rest.
 */
export async function sealedLog(session: CaseSession): Promise<SealedRow[]> {
  const key = await session.vault.logChainKey();
  const mac = (data: string) => createHmac("sha256", key).update(data).digest("hex");
  const rows = session.store.db.prepare("SELECT * FROM ai_log ORDER BY id")
    .all() as unknown as LogRow[];
  let prev = "";
  return rows.map((r) => {
    let record: LogRecord;
    if (r.chain === null) {
      // Only the CLI writes unsealed rows; one claiming to be yours or casefile's is not genuine.
      record = r.actor === "claude" ? "pending" : "forged";
    } else {
      const ok = timingSafeEqualHex(mac(chainInput(prev, r)), r.chain);
      prev = r.chain;
      record = !ok
        ? "forged"
        : r.chain_kind === "signed"
        ? "signed"
        : r.chain_kind === "countersigned"
        ? (r.actor === "claude" ? "countersigned" : "forged")
        : r.chain_kind === "legacy"
        ? "legacy"
        : "forged";
    }
    return { ...r, detail: parseDetail(r.detail), record };
  });
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Rows the app itself wrote and sealed, whose seal verifies. Nothing else is counted. */
function signedRows(log: SealedRow[], actions: string[]): SealedRow[] {
  return log.filter((r) => r.record === "signed" && actions.includes(r.action));
}

/** Claude's own rows (the CLI's), sealed by the app since or not yet sealed. */
function claudeRows(log: SealedRow[]): { n: number; first: string | null; last: string | null } {
  const rows = log.filter((r) =>
    r.actor === "claude" && (r.record === "countersigned" || r.record === "pending")
  );
  return { n: rows.length, first: rows[0]?.ts ?? null, last: rows.at(-1)?.ts ?? null };
}

// ── inventory: every item and its state, once ────────────────────────────────

interface Inventory {
  docs: DocInfo[];
  exposures: Exposure[];
  chronology: { row: ChronologyRow; state: WorkState; yours: boolean }[];
  evidence: { row: EvidenceRow; issue: IssueRow; state: WorkState; yours: boolean }[];
  issues: { row: IssueRow; state: WorkState; yours: boolean }[];
  drafts: { row: DraftRow; kind: DraftKind; title: string }[];
  paragraphs: {
    row: ParagraphRow;
    draft: DraftRow;
    kind: DraftKind;
    n: number;
    state: ParaState;
  }[];
}

async function inventory(session: CaseSession): Promise<Inventory> {
  const store = session.store;
  const exposures = await exposureList(session);
  const docs = await documentInfo(session);
  const removed = await removedIds(session);
  const inv: Inventory = {
    docs,
    exposures,
    chronology: [],
    evidence: [],
    issues: [],
    drafts: [],
    paragraphs: [],
  };
  // Every row is read: `removed_at` is Claude-writable; only the ledger's removals count.
  for (const row of store.listChronology({ includeRemoved: true })) {
    if (removed.chronology.has(row.id)) continue;
    inv.chronology.push({
      row,
      state: await chronoState(session, row),
      yours: await session.isUserItem("chronology", row),
    });
  }
  for (const issue of store.listIssues({ includeRemoved: true })) {
    if (removed.issues.has(issue.id)) continue;
    inv.issues.push({
      row: issue,
      state: await issueState(session, issue),
      yours: await session.isUserItem("issue", issue),
    });
    for (const row of store.listEvidence(issue.id, { includeRemoved: true })) {
      if (removed.evidence.has(row.id)) continue;
      inv.evidence.push({
        row,
        issue,
        state: await evState(session, row),
        yours: await session.isUserItem("evidence", row),
      });
    }
  }
  for (const d of store.listDrafts()) {
    // The kind recorded in the ledger, not public.db's (Claude could relabel an affidavit).
    const kind = (await session.draftKind(d)).kind;
    inv.drafts.push({ row: d, kind, title: session.reidentify(d.title).text });
    let n = 0;
    for (const p of store.listParagraphs(d.id)) {
      inv.paragraphs.push({ row: p, draft: d, kind, n: ++n, state: await paraState(session, p) });
    }
  }
  return inv;
}

// ── To check ─────────────────────────────────────────────────────────────────

/** Group names in display order (CANON "To check" queue). */
export const TO_CHECK_GROUPS = [
  "Exposed documents",
  "Documents to review",
  "Chronology entries",
  "Evidence links",
  "Affidavit paragraphs",
  "Draft paragraphs",
  "Issue descriptions",
] as const;
export type ToCheckGroup = typeof TO_CHECK_GROUPS[number];

/** One thing waiting for the user, most serious first, then oldest. */
export interface ToCheckItem {
  kind: "document" | "chronology" | "evidence" | "paragraph" | "issue";
  id: string;
  /** The group, e.g. "Exposed documents", "Chronology entries". */
  what: ToCheckGroup;
  /** What it is, for the user (real names). */
  detail: string;
  /**
   * Where it points: the first cited source (`doc`, `line`, `line_end` when a range) and how many
   * further sources it cites (`more`), plus the screen to open.
   */
  where: { doc?: string; line?: number; line_end?: number; more?: number; href: string };
  actor: "claude" | "user" | "app";
  state: DocState | WorkState | ParaState;
  /** "danger" (exposed, can't check) or "attention" (everything else in the queue). */
  level: "danger" | "attention";
  /** When it started waiting (for "oldest first"). */
  since: string;
  /** The next step, in plain words. */
  next: string;
}

export interface ToCheck {
  total: number;
  /** Non-empty groups, in display order. */
  groups: { what: ToCheckGroup; count: number }[];
  items: ToCheckItem[];
}

const NEXT: Record<string, string> = {
  exposed: "Re-check the document, then share it again or keep it withheld.",
  needs_review: "Review the names and numbers, then share it with Claude or keep it withheld.",
  to_check: "Check it against the document.",
  changed: "Check it again: it or the lines it cites changed after you checked it.",
  cant_check: "casefile can't check this. Ask Claude to correct it, or remove it.",
  claude_needs_you: "Rewrite it in your own words, or use these words as your own.",
  claude_rewritten: "You rewrote Claude's draft. Use these words as your own to confirm.",
  issue: "Check that the description states the question fairly.",
};

function severity(i: ToCheckItem): number {
  if (i.level === "danger") return 0;
  return i.state === "changed" ? 1 : 2;
}

function itemsFrom(session: CaseSession, inv: Inventory): ToCheckItem[] {
  const items: ToCheckItem[] = [];
  const show = (t: string) => session.reidentify(t).text;
  const open = new Map(inv.exposures.filter((e) => !e.resharedAt).map((e) => [e.doc, e]));
  for (const d of inv.docs) {
    if (d.state === "exposed") {
      const e = open.get(d.id);
      const found = e?.foundAt ?? d.exposure?.foundAt ?? d.importedAt;
      items.push({
        kind: "document",
        id: d.id,
        what: "Exposed documents",
        detail: `${d.id} ${d.title}: withdrawn from Claude on ${
          formatDate(e?.withdrawnAt ?? found)
        }`,
        where: { doc: d.id, href: `#/doc/${d.id}` },
        actor: "app",
        state: "exposed",
        level: "danger",
        since: found,
        next: NEXT.exposed,
      });
    } else if (d.state === "needs_review") {
      items.push({
        kind: "document",
        id: d.id,
        what: "Documents to review",
        detail: `${d.id} ${d.title}`,
        where: { doc: d.id, href: `#/review/${d.id}` },
        actor: "user",
        state: "needs_review",
        level: "attention",
        since: d.importedAt,
        next: NEXT.needs_review,
      });
    }
  }
  const level = (s: string): "danger" | "attention" => s === "cant_check" ? "danger" : "attention";
  for (const c of inv.chronology) {
    if (c.yours || c.state === "checked") continue;
    const src = c.row.sources[0];
    items.push({
      kind: "chronology",
      id: String(c.row.id),
      what: "Chronology entries",
      detail: `${formatDate(c.row.event_date)}: ${show(c.row.description)}`,
      where: {
        ...(src
          ? {
            doc: src.doc_id,
            line: src.line_start,
            ...(src.line_end && src.line_end !== src.line_start ? { line_end: src.line_end } : {}),
            ...(c.row.sources.length > 1 ? { more: c.row.sources.length - 1 } : {}),
          }
          : {}),
        href: `#/chronology?entry=${c.row.id}`,
      },
      actor: "claude",
      state: c.state,
      level: level(c.state),
      since: c.row.updated_at || c.row.created_at,
      next: NEXT[c.state],
    });
  }
  for (const e of inv.evidence) {
    if (e.yours || e.state === "checked") continue;
    items.push({
      kind: "evidence",
      id: String(e.row.id),
      what: "Evidence links",
      detail: `${formatSourceRef(e.row)} for "${show(e.issue.title)}"`,
      where: {
        doc: e.row.doc_id,
        line: e.row.line_start,
        ...(e.row.line_end && e.row.line_end !== e.row.line_start
          ? { line_end: e.row.line_end }
          : {}),
        href: `#/issues/${e.issue.id}?evidence=${e.row.id}`,
      },
      actor: "claude",
      state: e.state,
      level: level(e.state),
      since: e.row.created_at,
      next: NEXT[e.state],
    });
  }
  for (const p of inv.paragraphs) {
    if (p.state !== "claude_needs_you" && p.state !== "claude_rewritten") continue;
    items.push({
      kind: "paragraph",
      id: String(p.row.id),
      what: p.kind === "affidavit" ? "Affidavit paragraphs" : "Draft paragraphs",
      detail: `${show(p.draft.title)}, paragraph ${p.n}`,
      where: { href: `#/draft/${p.draft.id}?paragraph=${p.row.id}` },
      actor: "claude",
      state: p.state,
      level: "attention",
      since: p.row.updated_at || p.row.created_at,
      next: NEXT[p.state],
    });
  }
  for (const i of inv.issues) {
    if (i.yours || i.state === "checked") continue;
    items.push({
      kind: "issue",
      id: String(i.row.id),
      what: "Issue descriptions",
      detail: `Claude's description of "${show(i.row.title)}"`,
      where: { href: `#/issues/${i.row.id}` },
      actor: "claude",
      state: i.state,
      level: level(i.state),
      since: i.row.updated_at || i.row.created_at,
      next: i.state === "to_check" ? NEXT.issue : NEXT[i.state],
    });
  }
  const order = (w: ToCheckGroup) => TO_CHECK_GROUPS.indexOf(w);
  return items.sort((a, b) =>
    severity(a) - severity(b) || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) ||
    order(a.what) - order(b.what) || a.id.localeCompare(b.id, "en", { numeric: true })
  );
}

function groupsOf(items: ToCheckItem[]): ToCheck["groups"] {
  return TO_CHECK_GROUPS.map((what) => ({
    what,
    count: items.filter((i) => i.what === what).length,
  })).filter((g) => g.count > 0);
}

/** The To-check queue: everything waiting for the user, most serious first, then oldest. */
export async function toCheck(session: CaseSession): Promise<ToCheck> {
  const items = itemsFrom(session, await inventory(session));
  return { total: items.length, groups: groupsOf(items), items };
}

// ── Court summary (PD-AI 4.11) ───────────────────────────────────────────────

/** Counts of Claude's work by state (the user's own items are counted apart). */
export interface WorkCounts {
  /** Items Claude wrote. */
  claude: number;
  checked: number;
  toCheck: number;
  changed: number;
  cantCheck: number;
  /** Items you wrote yourself (not Claude's work). */
  yours: number;
}

export interface ParaCounts {
  yours: number;
  /** Paragraphs Claude drafted (permanent history). */
  claude: number;
  adopted: number;
  rewritten: number;
  needsYou: number;
}

/** The figures the summary's sentences are made from. */
export interface CourtFigures {
  claude: {
    /** Entries Claude's tool (the CLI) wrote to the log. */
    logEntries: number;
    firstUse: string | null;
    lastUse: string | null;
    plan: PlanRecord;
  };
  nameFinder: { onNow: boolean; documents: number };
  languageModel: { documents: number; from: string | null; to: string | null };
  /**
   * casefile's extra checks (ADR 14), from sealed log rows: questions answered per backend, and
   * when Jev was turned on and off.
   */
  extraChecks: {
    local: number;
    llm: number;
    jev: number;
    jevOn: string[];
    jevOff: string[];
  };
  chronology: WorkCounts;
  evidence: WorkCounts;
  issues: WorkCounts;
  paragraphs: ParaCounts;
  drafts: ({ id: number; title: string; kind: DraftKind } & ParaCounts)[];
  paste: { views: number; copies: number; passagesAdded: number };
  keptFromClaude: { total: number; byOrigin: Record<Origin, number> };
  exposures: {
    doc: string;
    title: string;
    sharedAt: string;
    withdrawnAt: string;
    resharedAt: string | null;
    claudeReads: { ts: string; lines: string }[];
  }[];
  log: {
    intact: boolean;
    since: string | null;
    problem: string | null;
    pending: number;
    /** The vault's record of the last entry was lost (ADR 8, amended); reported from then on. */
    headLost: { at: string; reason: "missing" | "damaged" } | null;
    /**
     * Problems casefile recorded earlier (never cleared), oldest first: `n` (1 = oldest, the
     * number to acknowledge it by), what it was in plain words, and when the user acknowledged it
     * (ADR 28).
     */
    recorded: RecordedLogProblem[];
    /** What checking the chain found now, apart from recorded problems. */
    chainProblem: string | null;
  };
  open: { total: number; groups: ToCheck["groups"] };
}

export type CourtSectionId =
  | "ai_used"
  | "tools"
  | "checking"
  | "principles"
  | "open"
  | "record"
  | "limits";

/** The summary for the Court: fixed wording from core, so the UI cannot overstate. */
export interface CourtSummary {
  generatedAt: string;
  title: string;
  intro: string;
  sections: { id: CourtSectionId; title: string; lines: string[] }[];
  figures: CourtFigures;
  /** The whole summary as plain text, for copying. */
  text: string;
}

function workCounts(items: { state: WorkState; yours: boolean }[]): WorkCounts {
  const claude = items.filter((i) => !i.yours);
  const n = (s: WorkState) => claude.filter((i) => i.state === s).length;
  return {
    claude: claude.length,
    checked: n("checked"),
    toCheck: n("to_check"),
    changed: n("changed"),
    cantCheck: n("cant_check"),
    yours: items.length - claude.length,
  };
}

function paraCounts(states: ParaState[]): ParaCounts {
  const n = (s: ParaState) => states.filter((x) => x === s).length;
  return {
    yours: n("user"),
    claude: states.length - n("user"),
    adopted: n("claude_adopted"),
    rewritten: n("claude_rewritten"),
    needsYou: n("claude_needs_you"),
  };
}

/** Actions whose signed rows count as paste uses (the wave-0 name and D's). */
const PASTE_VIEW_ACTIONS = ["reidentified_text", "paste_viewed"];

async function figures(session: CaseSession, inv: Inventory): Promise<CourtFigures> {
  const log = await sealedLog(session);
  const imports = signedRows(log, ["document_imported"]);
  const used = (name: string) =>
    imports.filter((r) => Array.isArray(r.detail.detectors) && r.detail.detectors.includes(name));
  const llm = used("llm");
  const judged = (b: string) =>
    signedRows(log, ["judge_ran"]).filter((r) => r.detail.backend === b)
      .reduce((n, r) => n + (typeof r.detail.judgements === "number" ? r.detail.judgements : 0), 0);
  const paste = signedRows(log, [...PASTE_VIEW_ACTIONS, "paste_copied", "paste_added"]);
  const byOrigin = Object.fromEntries(ORIGINS.map((o) => [o, 0])) as Record<Origin, number>;
  const kept = inv.docs.filter((d) => d.state === "withheld");
  for (const d of kept) byOrigin[d.origin ?? "not_sure"]++;
  const titles = new Map(inv.docs.map((d) => [d.id, d.title]));
  const check = await session.verifyLog();
  const first = { ts: log.find((r) => r.record === "signed")?.ts ?? null };
  const claude = claudeRows(log);
  const items = itemsFrom(session, inv);
  return {
    claude: {
      logEntries: claude.n,
      firstUse: claude.first,
      lastUse: claude.last,
      plan: planAndConfirmations(session),
    },
    nameFinder: { onNow: session.settings.nerEnabled, documents: used("ner").length },
    languageModel: {
      documents: llm.length,
      from: llm[0]?.ts ?? null,
      to: llm.at(-1)?.ts ?? null,
    },
    extraChecks: {
      local: judged("local"),
      llm: judged("llm"),
      jev: judged("jev"),
      jevOn: signedRows(log, ["jev_turned_on"]).map((r) => r.ts),
      jevOff: signedRows(log, ["jev_turned_off"]).map((r) => r.ts),
    },
    chronology: workCounts(inv.chronology),
    evidence: workCounts(inv.evidence),
    issues: workCounts(inv.issues),
    paragraphs: paraCounts(inv.paragraphs.map((p) => p.state)),
    drafts: inv.drafts.map((d) => ({
      id: d.row.id,
      title: d.title,
      kind: d.kind,
      ...paraCounts(inv.paragraphs.filter((p) => p.draft.id === d.row.id).map((p) => p.state)),
    })),
    paste: {
      views: paste.filter((r) => PASTE_VIEW_ACTIONS.includes(r.action)).length,
      copies: paste.filter((r) => r.action === "paste_copied").length,
      // D logs one `paste_added` per addition, with the number of paragraphs it made.
      passagesAdded: paste.filter((r) => r.action === "paste_added")
        .reduce(
          (n, r) => n + (typeof r.detail.paragraphs === "number" ? r.detail.paragraphs : 1),
          0,
        ),
    },
    keptFromClaude: { total: kept.length, byOrigin },
    exposures: inv.exposures.map((e) => ({
      doc: e.doc,
      title: titles.get(e.doc) ?? e.doc,
      sharedAt: e.sharedAt,
      withdrawnAt: e.withdrawnAt,
      resharedAt: e.resharedAt,
      claudeReads: e.claudeReads,
    })),
    log: {
      intact: check.intact,
      since: first.ts,
      problem: check.problem ?? null,
      pending: check.pending,
      headLost: check.headLost ?? null,
      recorded: (check.recorded ?? []).map((p, i) => ({
        n: i + 1,
        kind: p.kind,
        at: p.at,
        what: logProblemWords(p),
        acknowledgedAt: p.acknowledged?.at ?? null,
      })),
      chainProblem: check.chainProblem ?? null,
    },
    open: { total: items.length, groups: groupsOf(items) },
  };
}

function planLine(p: PlanRecord): string {
  const when = p.at ? ` on ${formatDate(p.at)}` : "";
  return p.setup === "commercial"
    ? `Plan: a commercial plan with no-training terms, as recorded by you${when}.`
    : `Plan: a consumer plan (Claude Pro or Max), as recorded by you${when}.`;
}

function workLine(noun: string, c: WorkCounts, how: string): string | null {
  if (c.claude === 0) return null;
  const rest = [
    c.toCheck ? `${c.toCheck} still to check` : "",
    c.changed ? `${c.changed} changed since you checked` : "",
    c.cantCheck ? `${c.cantCheck} casefile can't check` : "",
  ].filter(Boolean);
  return `${noun}: you checked ${c.checked} of the ${c.claude} Claude wrote ${how}` +
    (rest.length ? ` (${rest.join(", ")})` : "") + ".";
}

function paraLine(title: string, c: ParaCounts): string {
  const claude = c.claude === 0 ? "Claude drafted none" : `Claude drafted ${c.claude}: ${
    [
      `${c.adopted} adopted by you`,
      c.rewritten ? `${c.rewritten} rewritten by you, awaiting adoption` : "",
      `${c.needsYou} still need${c.needsYou === 1 ? "s" : ""} you`,
    ].filter(Boolean).join(", ")
  }`;
  return `${title}: ${plural(c.yours, "paragraph")} in your own words; ${claude}.`;
}

/** Origins of documents kept from Claude, in the order the summary lists them. */
const KEPT_ORDER: Origin[] = ["court_or_subpoena", "other_side", "under_order", "not_sure"];
const ORIGIN_SHORT: Record<Origin, string> = {
  court_or_subpoena: "from a subpoena or the court",
  other_side: "from the other side",
  under_order: "under a court order",
  not_sure: "origin not sure",
  mine: "yours",
};

/** Jev, a second AI tool when it was ever turned on (ADR 14, PD-AI 4.11). */
function jevLine(x: CourtFigures["extraChecks"]): string {
  if (!x.jevOn.length && !x.jev) return "Jev by TypeSafe AI (extra checks): never turned on.";
  const periods = x.jevOn.map((on) => {
    const off = x.jevOff.find((t) => t >= on);
    return off
      ? `from ${formatDate(on)} to ${formatDate(off)}`
      : `from ${formatDate(on)}, and is still on`;
  });
  return `Jev by TypeSafe AI, a second AI tool, used for extra checks: turned on by you ${
    periods.join("; ") || "(when is not recorded)"
  }. It answered ${plural(x.jev, "question")} about text with names replaced from documents ` +
    "shared with Claude; it was never sent original documents or documents kept from Claude. " +
    "TypeSafe hosts it in the United States.";
}

function sections(f: CourtFigures): CourtSummary["sections"] {
  const c = f.claude;
  const aiUsed = c.logEntries
    ? [
      "Yes. Claude (an AI made by Anthropic) was used through casefile. casefile recorded its " +
      `first use on ${formatDate(c.firstUse!)} and its latest on ${formatDate(c.lastUse!)} (${
        plural(c.logEntries, "log entry", "log entries")
      }).`,
    ]
    : ["casefile has no record of Claude using this case."];

  const tools = [
    `Claude, used through casefile's command-line tool in Claude Code. ${planLine(c.plan)}`,
    f.nameFinder.documents
      ? `casefile's name finder, which runs on this computer: used on ${
        plural(f.nameFinder.documents, "document")
      } when they were added.`
      : "casefile's name finder (on this computer): not used.",
    f.languageModel.documents
      ? `A language model set up in casefile to find names: used on ${
        plural(f.languageModel.documents, "document")
      } (${formatRange(f.languageModel.from!, f.languageModel.to!)}).`
      : "No language model was used by casefile to find names.",
    jevLine(f.extraChecks),
    ...(f.extraChecks.local
      ? [
        `casefile's extra checks on this computer (a small model that runs on this computer): ${
          plural(f.extraChecks.local, "question")
        } answered.`,
      ]
      : []),
    ...(f.extraChecks.llm
      ? [
        `The language model set up in casefile also answered ${
          plural(f.extraChecks.llm, "extra-check question")
        }, about text with names replaced.`,
      ]
      : []),
    "casefile's own checks compare names, dates and numbers with the cited lines; they do not " +
    "use AI. Answers from extra checks only point things out for you to look at: they never mark " +
    "anything as checked, adopted or shared.",
  ];

  const checking = [
    workLine("Chronology", f.chronology, "against the cited lines"),
    workLine("Evidence links", f.evidence, "against the cited lines"),
    workLine("Issue descriptions", f.issues, "for fairness"),
    ...f.drafts.map((d) => paraLine(d.title, d)),
    f.paste.views
      ? `Paste: you viewed Claude's text with real names ${
        plural(f.paste.views, "time")
      } in casefile` +
        (f.paste.passagesAdded
          ? `; ${
            plural(f.paste.passagesAdded, "passage was", "passages were")
          } added to a draft as Claude's paragraphs (counted above).`
          : ".")
      : "",
    "Each check counted here was signed by casefile when you made it. Anything changed after " +
    "you checked it is not counted as checked.",
  ].filter((l): l is string => !!l);

  const k = f.keptFromClaude;
  const keptParts = KEPT_ORDER.filter((o) => k.byOrigin[o] > 0)
    .map((o) => `${k.byOrigin[o]} ${ORIGIN_SHORT[o]}`);
  const conf = c.plan.confirmations;
  const cond = c.plan.conditions;
  const principles = [
    "Documents shared with Claude through casefile had the names and numbers casefile knew of " +
    "replaced with labels before Claude could read them.",
    k.total
      ? `${plural(k.total, "document")} kept from Claude (${keptParts.join(", ")}): ` +
        "casefile gave Claude none of their text."
      : "No documents were kept from Claude.",
    ...f.exposures.map((e) => {
      const reads = e.claudeReads.length
        ? `Claude read it through casefile ${plural(e.claudeReads.length, "time")} in that time (${
          e.claudeReads.map((r) => `lines ${r.lines.replace("-", "–")} on ${formatDate(r.ts)}`)
            .join("; ")
        }).`
        : "casefile has no record of Claude reading it in that time.";
      return `Exposure: ${e.doc} (${e.title}) showed Claude a name or number casefile knows ` +
        `from ${formatDate(e.sharedAt)} until casefile withdrew it on ${
          formatDate(e.withdrawnAt)
        }. ${reads}` +
        (e.resharedAt ? ` Shared again on ${formatDate(e.resharedAt)} after re-checking.` : "");
    }),
    conf.helpImproveOff || conf.chatHistory
      ? "PD-AI 5.4, as recorded by you: " + [
        conf.helpImproveOff
          ? `"Help improve Claude" turned off (confirmed ${formatDate(conf.helpImproveOff)})`
          : "",
        conf.chatHistory ? `chat history settings (confirmed ${formatDate(conf.chatHistory)})` : "",
      ].filter(Boolean).join("; ") + "."
      : "No PD-AI 5.4 confirmations are recorded.",
    ...(c.plan.setup === "commercial"
      ? [
        cond?.closedEnvironment && cond.noTraining && cond.thisCaseOnly
          ? `PD-AI 5.5, as recorded by you${
            c.plan.at ? ` on ${formatDate(c.plan.at)}` : ""
          }: the plan keeps material in a closed environment, does not use it for training, ` +
            "and it is used only for this case."
          : "PD-AI 5.5: the plan's conditions are not recorded.",
      ]
      : []),
  ];

  const open = f.open.total
    ? [
      `Still to check: ${plural(f.open.total, "item")} (${
        f.open.groups.map((g) => `${g.what.toLowerCase()} ${g.count}`).join(", ")
      }).`,
    ]
    : ["Nothing is waiting to be checked."];

  const since = f.log.since ? ` (since ${formatDate(f.log.since)})` : "";
  const rec = f.log.recorded;
  // Each recorded problem is listed once there is more than one or one was acknowledged; an
  // acknowledgement never removes a problem from the summary (ADR 28).
  const listed = rec.length > 1 || rec.some((p) => p.acknowledgedAt);
  const allAcknowledged = rec.length > 0 && rec.every((p) => p.acknowledgedAt) &&
    !f.log.chainProblem;
  const record = [
    f.log.intact
      ? `Log checked: no changes found${since}.`
      : allAcknowledged
      ? `Log checked: casefile found ${
        rec.length === 1 ? "a problem" : `${rec.length} problems`
      } earlier, listed below. Figures above that come from the log may be affected.`
      : `Log checked: casefile found a problem (${f.log.problem}). Figures above that come ` +
        "from the log may be affected.",
    ...(listed
      ? rec.map((p) =>
        `Problem found on ${formatDate(p.at)}: ${p.what}${
          p.acknowledgedAt ? `; acknowledged by you on ${formatDate(p.acknowledgedAt)}` : ""
        }.`
      )
      : []),
    ...(f.log.pending
      ? [
        `${
          plural(f.log.pending, "recent entry by Claude is", "recent entries by Claude are")
        } not sealed into the log yet; casefile seals them the next time it writes to the log.`,
      ]
      : []),
  ];

  const limits = [
    "This summary covers only what happened through casefile. casefile cannot see what Claude " +
    "did outside it (for example, files Claude read directly) or any other AI tool you used.",
    "The plan and confirmations are as recorded by you; casefile cannot check them with Anthropic.",
    "Your checks show that you compared Claude's work with the cited lines. casefile does not " +
    "decide whether Claude's work is right.",
  ];

  return [
    { id: "ai_used", title: "Whether AI was used", lines: aiUsed },
    { id: "tools", title: "What tools were used", lines: tools },
    { id: "checking", title: "How Claude's work was checked", lines: checking },
    {
      id: "principles",
      title: "How the Court's rules on AI (PD-AI) were followed",
      lines: principles,
    },
    { id: "open", title: "Still open", lines: open },
    { id: "record", title: "The record", lines: record },
    { id: "limits", title: "What this summary cannot show", lines: limits },
  ];
}

/** One recorded log problem as the summary and the Log screen list it (ADR 28). */
export interface RecordedLogProblem {
  n: number;
  kind: LogProblem["kind"];
  at: string;
  what: string;
  acknowledgedAt: string | null;
}

/** What a recorded log problem was, in plain words, without its date. */
export function logProblemWords(p: LogProblem): string {
  switch (p.kind) {
    case "head_damaged":
      return "the record of the log's last entry was damaged, so entries removed from the end " +
        "of the log before then cannot be ruled out";
    case "head_missing":
      return "the record of the log's last entry was missing, so entries removed from the end " +
        "of the log before then cannot be ruled out";
    case "settings_missing":
      return "the case's settings were missing, so changes to the log before then cannot be " +
        "ruled out";
    case "tail_changed":
      return `entries after entry ${p.headId} were deleted or altered`;
  }
}

export const COURT_SUMMARY_TITLE = "If the Court asks: use of AI (PD-AI 4.11)";
const INTRO = "This summary is built only from what casefile recorded: checks you signed in " +
  "casefile, the encrypted case files, your settings and casefile's sealed log. It answers the " +
  "questions in PD-AI paragraph 4.11.";

/**
 * The "If the Court asks" summary (PD-AI 4.11). Counts come only from the ledger's signed checks,
 * the vault and the app's own signed log rows (ADR 0018).
 */
export async function courtSummary(session: CaseSession): Promise<CourtSummary> {
  const f = await figures(session, await inventory(session));
  const secs = sections(f);
  const text = [
    COURT_SUMMARY_TITLE,
    "",
    INTRO,
    ...secs.flatMap((s) => ["", s.title, ...s.lines.map((l) => `- ${l}`)]),
    "",
  ].join("\n");
  return {
    generatedAt: new Date().toISOString(),
    title: COURT_SUMMARY_TITLE,
    intro: INTRO,
    sections: secs,
    figures: f,
    text,
  };
}

// ── the AI-use log, as the user reads it ─────────────────────────────────────

export type LogCategory =
  | "documents"
  | "claude"
  | "checking"
  | "drafts"
  | "paste"
  | "people"
  | "settings"
  | "case";

/** The "What" filter, in display order. */
export const LOG_CATEGORIES: { id: LogCategory; label: string }[] = [
  { id: "claude", label: "Claude's use" },
  { id: "documents", label: "Documents" },
  { id: "checking", label: "Checking" },
  { id: "drafts", label: "Drafts" },
  { id: "paste", label: "Paste" },
  { id: "people", label: "People" },
  { id: "settings", label: "Settings and plan" },
  { id: "case", label: "Case" },
];

export interface LogEntry {
  id: number;
  ts: string;
  actor: Actor;
  /** "Claude", "You", "casefile", or "Unknown" for a row casefile did not seal. */
  who: string;
  action: string;
  label: string;
  /** A short plain-language detail ("Cites D001:3", "2 names replaced"), or null. */
  note: string | null;
  category: LogCategory;
  /** The document the entry is about, if any. */
  doc: string | null;
  detail: Record<string, unknown>;
  record: LogRecord;
}

type Detail = Record<string, unknown>;
const txt = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const docRef = (
  d: Detail,
) => (typeof d.doc === "string" && DOC_ID.test(d.doc) ? d.doc : "a document");
const DOC_ID = /^D\d+$/;
/** A citation Claude wrote ("D001:3", "D001:1-2"), shown only if it has that shape. */
const CITE = /^D\d+:\d+(?:[-–]\d+)?$/;
/** A note target Claude wrote ("case", "chrono:3", "doc:D001"), shown only if it has that shape. */
const TARGET = /^(?:case|[a-z]+:[A-Za-z0-9]+)$/;
const WHAT: Record<string, string> = {
  chronology: "a chronology entry",
  evidence: "an evidence link",
  issue: "an issue description",
};
const WHAT_ID: Record<string, string> = {
  chronology: "chronology entry",
  evidence: "evidence link",
  issue: "issue",
  paragraph: "paragraph",
  note: "note",
};
const count = (v: unknown, one: string, many?: string) =>
  typeof v === "number"
    ? plural(v, one, many)
    : Array.isArray(v)
    ? plural(v.length, one, many)
    : "";
/** Only the strings in `v` that look like document ids or citations; never free text. */
const refs = (v: unknown, re: RegExp): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
    .filter((x): x is string => typeof x === "string" && re.test(x))
    .map((x) => x.replace("-", "–"));
const list = (items: string[], max = 6): string => {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 2
    ? shown.join(" and ")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};
const itemRef = (d: Detail) => {
  const w = WHAT_ID[txt(d.what)] ?? "item";
  return d.id !== undefined ? `${w} ${txt(d.id)}` : `an ${w}`;
};
/** "Cites D001:1–2 and D002:9" from a Claude-written source list (shape-checked). */
const cites = (v: unknown) => {
  const r = refs(v, CITE);
  return r.length ? `Cites ${list(r)}` : null;
};
/** The PD-AI 5.4 checklist items, as the user confirmed them. */
const CONFIRM_ITEMS: Record<string, string> = {
  help_improve_off: "“Help improve Claude” is off",
  chat_history: "chat history and memory are set the way you want",
};
const confirmItems = (v: unknown) =>
  list(refs(v, /^[a-z_]+$/).map((k) => CONFIRM_ITEMS[k] ?? k.replace(/_/g, " ")));
const join = (...parts: (string | null | false | undefined)[]) => {
  const out = parts.filter(Boolean) as string[];
  return out.length ? out.join(" · ") : null;
};

type Label = [LogCategory, (d: Detail) => string, ((d: Detail) => string | null)?];

/** Where an extra check ran, in plain words (a logged value, so only known ones are shown). */
function judgeWhere(b: unknown): string {
  return b === "local"
    ? "on this computer"
    : b === "llm"
    ? "a language model set up in casefile"
    : b === "jev"
    ? "Jev by TypeSafe AI"
    : "extra checks";
}

/**
 * Plain-language label, category and (optional) detail note for each action the app or the CLI
 * logs. Labels and notes name document ids, counts and citations only, never content: some detail
 * values are written by Claude, so free text is never echoed and ids are shape-checked first.
 * `tests/log_labels_test.ts` checks every action the source logs has an entry here.
 */
const LABELS: Record<string, Label> = {
  // ── case ──
  case_created: ["case", () => "casefile created this case"],
  case_opened: ["case", () => "The case was opened"],
  case_locked: ["case", () => "You locked the case"],
  public_store_repaired: [
    "case",
    (d) => `casefile repaired Claude's copy of ${count(d.docs, "document") || "some documents"}`,
    (d) => (d.search_index ? "The search index was rebuilt too" : null),
  ],
  log_head_lost: [
    "case",
    () => "casefile couldn't read the record of the log's last entry",
    (d) =>
      d.reason === "damaged"
        ? "It kept the damaged file. The log check will keep warning that entries removed from " +
          "the end of the log before this can't be ruled out"
        : "The record was missing. The log check will keep warning that entries removed from the " +
          "end of the log before this can't be ruled out",
  ],
  log_problem_found: [
    "case",
    (d) =>
      d.kind === "settings_missing"
        ? "casefile found the case's settings missing from the vault"
        : "casefile found entries at the end of the log deleted or changed",
    (d) =>
      d.kind === "tail_changed" && typeof d.after === "number" && Number.isSafeInteger(d.after)
        ? `Entries after entry ${d.after} no longer match. The log check will keep warning`
        : "The log check will keep warning",
  ],
  log_problem_acknowledged: [
    "case",
    () => "You acknowledged a problem casefile found in the log",
    (d) =>
      join(
        typeof d.found === "string" ? `Found on ${formatDate(d.found)}` : null,
        d.kind === "tail_changed" && typeof d.after === "number" && Number.isSafeInteger(d.after)
          ? `entries after entry ${d.after}`
          : null,
        "It is still listed and reported",
      ),
  ],
  log_exported: ["case", () => "You downloaded the full log"],
  court_summary_copied: ["case", () => "You copied the “If the Court asks” summary"],
  start_step_marked: [
    "case",
    (d) =>
      d.done === false
        ? "You unmarked a Getting started step"
        : "You marked a Getting started step as done",
    (d) => (d.step === "open_claude" ? "Opened Claude Code in the case folder" : null),
  ],
  // ── documents ──
  document_imported: [
    "documents",
    (d) => `You added ${docRef(d)} to the case`,
    (d) =>
      join(
        typeof d.detections === "number"
          ? `${plural(d.detections, "possible name or number", "possible names and numbers")} found`
          : null,
        Array.isArray(d.detector_errors) && d.detector_errors.length
          ? "A name finder didn’t run; look for names yourself when you review"
          : null,
      ),
  ],
  document_published: [
    "documents",
    (d) =>
      d.withheld
        ? `${docRef(d)} was reviewed and kept from Claude`
        : `You shared ${docRef(d)} with Claude (names replaced)`,
    (d) =>
      join(
        typeof d.replacements === "number" ? `${plural(d.replacements, "name")} replaced` : null,
        d.released ? "Released under your Claude plan" : null,
      ),
  ],
  document_shared: ["documents", (d) => `You shared ${docRef(d)} with Claude (names replaced)`],
  document_withdrawn: [
    "documents",
    (d) =>
      d.reason === "exposed"
        ? `casefile withdrew ${docRef(d)} from Claude: it showed a name or number casefile knows`
        : `You withdrew ${docRef(d)} from Claude`,
    (d) => (d.reason === "exposed" ? "Check it again before you share it" : null),
  ],
  document_reopened: ["documents", (d) => `You reopened ${docRef(d)} to review it again`],
  document_rechecked: [
    "documents",
    (d) => `You checked ${docRef(d)} again for names`,
    (d) =>
      d.review ? "It needs another review before Claude can see it" : "Nothing new found; shared",
  ],
  documents_redetected: [
    "documents",
    (d) =>
      `casefile looked again for names in ${
        count(d.count ?? d.docs, "document") || "some documents"
      }`,
    (d) => {
      const r = refs(d.docs, DOC_ID);
      return r.length ? `New matches in ${list(r)}` : null;
    },
  ],
  exposure_check_failed: [
    "documents",
    (d) =>
      `casefile couldn’t check ${
        count(d.count ?? d.docs, "document") || "some documents"
      } for a new name or number`,
    (d) => {
      const r = refs(d.docs, DOC_ID);
      return r.length ? `Review ${list(r)} again` : null;
    },
  ],
  document_deleted: ["documents", (d) => `You deleted ${docRef(d)} from the case`],
  doc_author_set: [
    "documents",
    (d) => `You said who wrote ${docRef(d)}`,
  ],
  earlier_affidavit_set: [
    "documents",
    (d) =>
      d.set === false
        ? `You said ${docRef(d)} is not one of your affidavits`
        : `You said when you swore or affirmed ${docRef(d)}`,
  ],
  origin_changed: [
    "documents",
    (d) =>
      `You said where ${docRef(d)} came from: ${
        ORIGIN_LABELS[d.origin as Origin] ?? "not asked yet"
      }`,
  ],
  // ── settings and plan ──
  claude_setup_changed: [
    "settings",
    (d) =>
      `You recorded your Claude plan: ${
        d.setup === "commercial" ? "commercial, no-training terms" : "consumer (Pro or Max)"
      }`,
    (d) => {
      const r = refs(d.withdrawn, DOC_ID);
      return r.length
        ? `${list(r)} ${r.length === 1 ? "was" : "were"} withdrawn from Claude`
        : typeof d.withdrawn === "number" && d.withdrawn
        ? `${plural(d.withdrawn, "document")} withdrawn from Claude`
        : null;
    },
  ],
  name_finder_chosen: [
    "settings",
    (d) =>
      d.on
        ? "You turned on the name finder"
        : d.asked_on
        ? "You chose the name finder, but it couldn’t be set up; it stayed off"
        : "You chose to leave the name finder off",
  ],
  typed_text_rechecked: [
    "people",
    (d) =>
      `casefile replaced a name it now knows in ${
        typeof d.count === "number" ? plural(d.count, "item") : "items"
      } you wrote`,
  ],
  settings_changed: [
    "settings",
    () => "You changed the case settings",
    (d) =>
      join(
        typeof d.ner === "boolean" ? `Name finder ${d.ner ? "on" : "off"}` : null,
        d.llm_host === null ? "No language model" : d.llm_host ? "Language model set" : null,
        d.reasoning_effort === "none"
          ? "Language model thinking off"
          : d.reasoning_effort === "default"
          ? "Language model thinking left to the server"
          : typeof d.reasoning_effort === "string"
          ? `Language model thinking ${d.reasoning_effort}`
          : null,
        typeof d.idle_lock_minutes === "number"
          ? `Locks after ${d.idle_lock_minutes} min idle`
          : null,
        typeof d.shortcuts === "boolean"
          ? `Keyboard shortcuts ${d.shortcuts ? "on" : "off"}`
          : null,
        "user_role" in d ? "Who you are in the case" : null,
      ),
  ],
  passphrase_changed: ["settings", () => "You changed the passphrase"],
  passphrase_reset_with_recovery_key: [
    "settings",
    () => "You opened the case with the recovery key and set a new passphrase",
  ],
  recovery_key_created: ["settings", () => "You made a recovery key"],
  recovery_key_replaced: [
    "settings",
    () => "You made a new recovery key",
    () => "The earlier one no longer works",
  ],
  recovery_key_removed: ["settings", () => "You removed the recovery key"],
  pd_ai_confirmed: [
    "settings",
    () => "You confirmed your Claude settings (the Court’s rules on AI, PD-AI 5.4)",
    (d) => confirmItems(d.items) || null,
  ],
  pd_ai_confirmation_withdrawn: [
    "settings",
    () => "You withdrew a confirmation of your Claude settings (PD-AI 5.4)",
    (d) => confirmItems(d.items) || null,
  ],
  claude_settings_restored: [
    "settings",
    () => "You put back the Claude Code settings casefile made",
    (d) =>
      join(
        count(d.rewritten, "file") ? `${count(d.rewritten, "file")} rewritten` : null,
        d.moved_aside ? "Your own settings file was moved aside" : null,
      ),
  ],
  terminal_opened: ["settings", () => "You opened Terminal in the case folder"],
  // ── extra checks (ADR 14): counts only, never the text, questions or answers ──
  judge_backend_changed: [
    "settings",
    (d) =>
      d.backend === "off"
        ? "You turned off casefile's extra checks"
        : `You chose where casefile's extra checks run: ${judgeWhere(d.backend)}`,
  ],
  jev_turned_on: [
    "settings",
    () => "You turned on Jev by TypeSafe AI for extra checks",
    () => "It sees only text with names replaced, from documents shared with Claude",
  ],
  jev_turned_off: ["settings", () => "You turned off Jev by TypeSafe AI"],
  jev_key_saved: ["settings", () => "You saved a key for Jev by TypeSafe AI"],
  jev_key_removed: ["settings", () => "You removed the key for Jev by TypeSafe AI"],
  judge_tested: [
    "settings",
    (d) => `You tested casefile's extra check (${judgeWhere(d.backend)})`,
    (d) => (d.ok === true ? "It worked" : "It didn't work"),
  ],
  judge_ran: [
    "checking",
    (d) => `casefile's extra check (${judgeWhere(d.backend)}) looked at an item for you`,
    (d) =>
      join(
        count(d.judgements, "question") ? `${count(d.judgements, "question")} answered` : null,
        typeof d.flags === "number"
          ? d.flags ? `${plural(d.flags, "thing")} to look at` : "Nothing to look at"
          : null,
        d.failed === true ? "It couldn't finish" : null,
      ),
  ],
  // ── people ──
  entity_updated: ["people", (d) => `You changed the details of {{${txt(d.role)}}}`],
  entity_renamed: [
    "people",
    (d) => `You renamed the label {{${txt(d.from)}}} to {{${txt(d.to)}}}`,
  ],
  entity_merged: [
    "people",
    (d) => `You merged {{${txt(d.from)}}} into {{${txt(d.into)}}}`,
  ],
  entity_removed: [
    "people",
    (d) => `You stopped replacing {{${txt(d.role)}}}: it is left as written`,
  ],
  entity_suggestions: [
    "people",
    (d) =>
      `casefile's language model suggested ${
        count(d.suggestions, "tidy-up") || "no tidy-ups"
      } for who's who`,
  ],
  // ── checking ──
  attested_items_deleted_outside_app: [
    "checking",
    (d) =>
      `casefile found ${
        count(d.count, "checked item") || "checked items"
      } deleted outside casefile`,
  ],
  marks_repaired: [
    "checking",
    (d) => `casefile restored ${count(d.count, "check mark") || "check marks"} in Claude's copy`,
  ],
  verified: [
    "checking",
    (d) => `You checked ${WHAT[txt(d.what)] ?? "an item"} against its source`,
    (d) => (d.id !== undefined ? itemRef(d) : null),
  ],
  unverified: [
    "checking",
    (d) => `You withdrew your check of ${WHAT[txt(d.what)] ?? "an item"}`,
    (d) => (d.id !== undefined ? itemRef(d) : null),
  ],
  item_removed: ["checking", (d) => `You removed ${itemRef(d)}`, () => "You can restore it"],
  item_restored: ["checking", (d) => `You restored ${itemRef(d)}`],
  note_done: ["checking", (d) => `You marked Claude's note ${txt(d.id)} as done`],
  note_undone: ["checking", (d) => `You marked Claude's note ${txt(d.id)} as not done`],
  issue_edited: [
    "checking",
    (d) => `You edited issue ${txt(d.issue)}`,
    (d) => join(d.title ? "New title" : null, d.description ? "New description" : null),
  ],
  evidence_edited: [
    "checking",
    (d) => `You edited evidence link ${txt(d.evidence)}`,
    (d) => join(d.note ? "New note" : null, d.stance ? "New stance" : null),
  ],
  chronology_deleted: ["checking", (d) => `You deleted chronology entry ${txt(d.id)}`],
  evidence_deleted: ["checking", (d) => `You deleted evidence link ${txt(d.id)}`],
  issue_deleted: ["checking", (d) => `You deleted issue ${txt(d.id)}`],
  // ── drafts ──
  paragraph_adopted: [
    "drafts",
    (d) => `You used Claude's paragraph as your own words (draft ${txt(d.draft)})`,
  ],
  paragraph_unadopted: ["drafts", (d) => `You withdrew your adoption (draft ${txt(d.draft)})`],
  paragraph_edited: ["drafts", (d) => `You edited a paragraph (draft ${txt(d.draft)})`],
  paragraph_added: ["drafts", (d) => `You wrote a paragraph (draft ${txt(d.draft)})`],
  paragraph_deleted: ["drafts", (d) => `You deleted a paragraph (draft ${txt(d.draft)})`],
  paragraph_sources_set: [
    "drafts",
    (d) => `You set where a paragraph comes from (draft ${txt(d.draft)})`,
    (d) =>
      join(
        typeof d.sources === "number" ? plural(d.sources, "source") : null,
        typeof d.relies === "number" && d.relies ? `relies on ${plural(d.relies, "item")}` : null,
      ),
  ],
  draft_created: ["drafts", (d) => `You started draft ${txt(d.draft)}`],
  draft_heading_set: ["drafts", (d) => `You changed the heading of draft ${txt(d.draft)}`],
  draft_deleted: ["drafts", (d) => `You deleted draft ${txt(d.draft)}`],
  exported: [
    "drafts",
    (d) =>
      `You exported draft ${txt(d.draft)}${
        d.format === "rtf" ? " for Word" : d.format === "text" ? " as text" : ""
      }`,
  ],
  export_safety_warned: [
    "drafts",
    (d) =>
      `casefile asked you to confirm exporting ${
        d.what === "chronology" ? "the chronology" : `draft ${txt(d.draft)}`
      }: it includes a protected address`,
  ],
  chronology_exported: [
    "checking",
    (d) =>
      `You exported the chronology for Word (${count(d.entries, "entry", "entries")}${
        d.scope === "all" ? `, ${txt(d.unchecked)} marked not checked` : ", checked only"
      })`,
  ],
  provenance_exported: [
    "drafts",
    (d) => `You downloaded the provenance report for draft ${txt(d.draft)}`,
  ],
  annexure_marks_set: [
    "drafts",
    (d) => `You set ${count(d.marks, "annexure mark")} (draft ${txt(d.draft)})`,
  ],
  export_blocked: [
    "drafts",
    (d) => `Export of draft ${txt(d.draft)} stopped: paragraphs still need you`,
    (d) =>
      join(
        typeof d.needs_review === "number" && d.needs_review
          ? `${plural(d.needs_review, "paragraph")} to check`
          : null,
        typeof d.placeholders === "number" && d.placeholders
          ? `${plural(d.placeholders, "gap")} to fill in`
          : null,
        typeof d.bad_tokens === "number" && d.bad_tokens
          ? `${plural(d.bad_tokens, "unknown label")}`
          : null,
      ),
  ],
  // ── paste ──
  reidentified_text: ["paste", () => "You viewed Claude's text with real names"],
  paste_viewed: [
    "paste",
    () => "You viewed Claude's text with real names",
    (d) =>
      join(
        typeof d.sentences === "number" ? plural(d.sentences, "sentence") : null,
        typeof d.unknown === "number" && d.unknown ? plural(d.unknown, "unknown label") : null,
      ),
  ],
  paste_copied: [
    "paste",
    () => "You copied Claude's text",
    (d) => (typeof d.chars === "number" ? plural(d.chars, "character") : null),
  ],
  paste_added: [
    "paste",
    (d) => `You added Claude's text to draft ${txt(d.draft)} as Claude's paragraphs`,
    (d) => (typeof d.paragraphs === "number" ? plural(d.paragraphs, "paragraph") : null),
  ],
  // ── Claude, through the casefile CLI ──
  "cli:info": ["claude", () => "Claude read the case overview"],
  "cli:entities": ["claude", () => "Claude read the list of labels (no real names)"],
  "cli:log": ["claude", () => "Claude read the log"],
  "cli:docs_list": ["claude", () => "Claude listed the documents"],
  "cli:docs_show": [
    "claude",
    (d) =>
      `Claude read ${docRef(d)}${
        d.lines && d.lines !== "all" ? ` (lines ${txt(d.lines).replace("-", "–")})` : " (all lines)"
      }`,
  ],
  "cli:docs_meta": ["claude", (d) => `Claude set the type or date of ${docRef(d)}`],
  "cli:search": [
    "claude",
    (d) => {
      const n = count(d.hits, "result");
      return `Claude searched the documents${n ? ` (${n})` : ""}`;
    },
    (d) => {
      const docs = [
        ...new Set(
          (Array.isArray(d.hits) ? d.hits : [])
            .map((x) => (x && typeof x === "object" ? (x as Detail).doc : undefined))
            .filter((x): x is string => typeof x === "string" && DOC_ID.test(x)),
        ),
      ];
      return docs.length ? `Results in ${list(docs)}` : null;
    },
  ],
  "cli:tags": ["claude", () => "Claude listed the tags"],
  "cli:tag_add": ["claude", (d) => `Claude tagged ${docRef(d)}`],
  "cli:tag_rm": ["claude", (d) => `Claude removed a tag from ${docRef(d)}`],
  "cli:evidence_add": [
    "claude",
    (d) => `Claude linked evidence to issue ${txt(d.issue)}`,
    (d) => cites(d.source),
  ],
  "cli:evidence_rm": ["claude", (d) => `Claude removed evidence link ${txt(d.id)}`],
  "cli:note_add": [
    "claude",
    () => "Claude added a note",
    (d) => {
      const on = typeof d.on === "string" && TARGET.test(d.on) ? d.on : null;
      return on && on !== "case" ? `On ${on.replace(":", " ")}` : null;
    },
  ],
  "cli:note_list": ["claude", () => "Claude read the notes"],
  "cli:chrono_list": ["claude", () => "Claude read the chronology"],
  "cli:chrono_add": [
    "claude",
    (d) => `Claude added chronology entry ${txt(d.id)}`,
    (d) => cites(d.sources),
  ],
  "cli:chrono_edit": [
    "claude",
    (d) => `Claude changed chronology entry ${txt(d.id)}`,
    (d) => join(d.date ? "New date" : null, cites(d.sources)),
  ],
  "cli:chrono_rm": ["claude", (d) => `Claude removed chronology entry ${txt(d.id)}`],
  "cli:issue_list": ["claude", () => "Claude read the issues"],
  "cli:issue_show": ["claude", (d) => `Claude read issue ${txt(d.id)}`],
  "cli:issue_add": ["claude", (d) => `Claude added issue ${txt(d.id)}`],
  "cli:issue_edit": ["claude", (d) => `Claude changed issue ${txt(d.id)}`],
  "cli:issue_rm": ["claude", (d) => `Claude removed issue ${txt(d.id)}`],
  "cli:draft_list": ["claude", () => "Claude listed the drafts"],
  "cli:draft_new": ["claude", (d) => `Claude started draft ${txt(d.id)}`],
  "cli:draft_show": ["claude", (d) => `Claude read draft ${txt(d.id)}`],
  "cli:para_add": [
    "claude",
    (d) => `Claude drafted a paragraph (draft ${txt(d.draft)})`,
    (d) => cites(d.sources),
  ],
  "cli:para_edit": ["claude", (d) => `Claude changed paragraph ${txt(d.id)}`],
  "cli:para_list": ["claude", (d) => `Claude listed the paragraphs (draft ${txt(d.draft)})`],
  "cli:para_show": ["claude", (d) => `Claude read paragraph ${txt(d.id)}`],
  "cli:para_rm": ["claude", (d) => `Claude removed paragraph ${txt(d.id)}`],
};

/** Every action with a plain-language label (for tests). */
export const LABELLED_ACTIONS: ReadonlySet<string> = new Set(Object.keys(LABELS));

const WHO: Record<string, string> = { claude: "Claude", user: "You", app: "casefile" };

/** One log row as the user reads it. Labels name document ids only, never content. */
export function describeLogRow(r: SealedRow): LogEntry {
  const detail = r.detail;
  const known = Object.hasOwn(LABELS, r.action) ? LABELS[r.action] : undefined;
  // A row casefile cannot vouch for is never shown as yours or casefile's.
  const who = r.record === "forged" ? "Unknown" : WHO[r.actor] ?? "Unknown";
  return {
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    who,
    action: r.action,
    label: known ? known[1](detail) : `${who}: ${r.action.replace(/^cli:/, "").replace(/_/g, " ")}`,
    note: known?.[2]?.(detail) ?? null,
    category: known?.[0] ?? (r.action.startsWith("cli:") ? "claude" : "case"),
    doc: typeof detail.doc === "string" && /^D\d+$/.test(detail.doc) ? detail.doc : null,
    detail,
    record: r.record,
  };
}

export interface LogFilter {
  what?: LogCategory;
  doc?: string;
  actor?: Actor;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive. */
  to?: string;
  offset?: number;
  limit?: number;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Log entries, newest first, filtered and paged; `total` counts every match. */
export async function logEntries(
  session: CaseSession,
  f: LogFilter = {},
): Promise<{ total: number; rows: LogEntry[] }> {
  const to = f.to ? nextDay(f.to) : undefined;
  const all = (await sealedLog(session))
    .filter((r) =>
      (!f.actor || r.actor === f.actor) && (!f.doc || r.detail.doc === f.doc) &&
      (!f.from || r.ts >= f.from) && (!to || r.ts < to)
    )
    .reverse()
    .map(describeLogRow)
    .filter((e) => !f.what || e.category === f.what);
  const offset = f.offset ?? 0;
  return { total: all.length, rows: all.slice(offset, offset + (f.limit ?? 100)) };
}

function csvCell(v: string): string {
  // A cell starting with = + - @ (or a tab or CR) is a formula in spreadsheet apps, and Claude
  // writes some of these values, so neutralise it.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The whole log as CSV, oldest first: labels plus the raw detail (labels, never real names). */
export async function logCsv(session: CaseSession): Promise<string> {
  const rows = (await sealedLog(session)).map(describeLogRow);
  const head = [
    "entry",
    "time",
    "who",
    "what",
    "category",
    "document",
    "record",
    "action",
    "detail",
  ];
  return [
    head.join(","),
    ...rows.map((e) =>
      [
        String(e.id),
        e.ts,
        e.who,
        e.label,
        e.category,
        e.doc ?? "",
        e.record,
        e.action,
        JSON.stringify(e.detail),
      ].map(csvCell).join(",")
    ),
  ].join("\r\n") + "\r\n";
}
