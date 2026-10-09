import { checkClaim, type CitedLines, splitSentences } from "./claimcheck.ts";
import { StaleItemError } from "./ledger.ts";
import type { EntityKind } from "./kinds.ts";
import {
  type DraftKind,
  InvalidInputError,
  type ParagraphLink,
  type ParagraphRow,
  type SourceRef,
} from "./publicdb.ts";
import type { CaseSession } from "./session.ts";
import type { CheckRow, ParaState } from "./states.ts";

/**
 * The drafting workspace, app side (ADR 0009). Claude writes paragraphs through the CLI; the user
 * edits, adopts and exports them here. Everything the user types contains real names, so it is
 * tokenised before it is stored. Export re-identifies, and for affidavits is blocked until every
 * paragraph Claude drafted is deliberately adopted.
 *
 * Authorship is history, not a measure of the text: a paragraph Claude drafted is "Drafted by
 * Claude" for good. The user rewriting it records a signed `rewrite` attestation (state
 * `claude_rewritten`), which still needs adopting; only paragraphs the user wrote in the app are
 * "Your words" (ADR 0009, October 2026 amendment).
 *
 * App only: the Claude-facing CLI must not import this module (it needs a CaseSession).
 */

// ── states ─────────────────────────────────────────────────────────────────

/** The marker Claude leaves where only the user can say something (ADR 0009). */
export const PLACEHOLDER_RE = /\[\s*in\s+your\s+own\s+words/i;

/** Whether a paragraph still holds an `[In your own words: …]` placeholder. */
export function hasPlaceholder(body: string): boolean {
  return PLACEHOLDER_RE.test(body);
}

/** What a `rewrite` attestation covers (the same content as `authorship`). */
function rewriteContent(p: Pick<ParagraphRow, "id" | "draft_id" | "body">) {
  return { id: p.id, draft_id: p.draft_id, body: p.body };
}

/** Whether the ledger records the user's rewrite of this (Claude-drafted) paragraph's text. */
export async function hasUserRewrite(session: CaseSession, p: ParagraphRow): Promise<boolean> {
  return await session.ledger.isAttested("rewrite", p.id, rewriteContent(p));
}

/** Whether the paragraph is the user's own: written in the app, attested for its current text. */
async function isUsersOwn(session: CaseSession, p: ParagraphRow): Promise<boolean> {
  return p.author === "user" && await session.hasUserAuthorship(p);
}

/**
 * A paragraph's state (`states.ts`):
 * - `user`: the user wrote it in the app, and the ledger's authorship record matches its text.
 *   (The `author` column alone is writable by Claude.)
 * - `claude_adopted`: the ledger's current adoption matches and its signature checks out.
 * - `claude_rewritten`: the user rewrote Claude's paragraph and the ledger's `rewrite` record
 *   matches its text; it still needs adopting. A change by Claude invalidates it.
 * - `claude_needs_you`: anything else.
 */
export async function paragraphState(session: CaseSession, para: ParagraphRow): Promise<ParaState> {
  if (await isUsersOwn(session, para)) return "user";
  if (await session.isParagraphAdopted(para)) return "claude_adopted";
  if (await hasUserRewrite(session, para)) return "claude_rewritten";
  return "claude_needs_you";
}

// ── user edits ─────────────────────────────────────────────────────────────

export interface UserEditResult {
  paragraph: ParagraphRow;
  state: ParaState;
}

/**
 * The user edits a paragraph in the app. `text` contains real names and is tokenised before it is
 * stored. A paragraph the user wrote stays theirs (authorship re-attested for the new text). A
 * paragraph Claude drafted stays Claude's however much is changed: the edit is recorded as the
 * user's rewrite (`rewrite` attestation) and the paragraph still needs adopting. A paragraph
 * merely marked `author = 'user'` in the store counts as Claude's. Any change clears an adoption.
 */
export async function userEditParagraph(
  session: CaseSession,
  paraId: number,
  text: string,
): Promise<UserEditResult> {
  const cur = session.store.getParagraph(paraId);
  const usersOwn = await isUsersOwn(session, cur);
  // Editing Claude's text: a known value Claude wrote as plain text must not be tokenised, or the
  // stored result would tell Claude which of its guesses were real names (ProbeError).
  const body = await session.tokeniseUserText(
    text,
    usersOwn ? {} : { replacing: [cur.body, cur.claude_body], target: `para:${paraId}` },
  );
  if (!body.trim()) throw new InvalidInputError("Paragraph is empty");
  if (body === cur.body) {
    return { paragraph: cur, state: await paragraphState(session, cur) };
  }
  const author: "user" | "claude" = usersOwn ? "user" : "claude";
  const store = session.store;
  // Withdraw what the edit invalidates before changing the text, so a failure part-way leaves
  // the paragraph unattested rather than wrongly attested.
  await session.ledger.revokeMany(
    usersOwn
      ? [["paragraph", paraId]]
      : [["paragraph", paraId], ["authorship", paraId], ["rewrite", paraId]],
  );
  store.updateParagraph(paraId, body, author, { keepClaudeBody: true });
  // Attest the text the app wrote, not a re-read of public.db: Claude could replace the body
  // between the write and a read, and would then get its own text attested as the user's.
  const written = { id: paraId, draft_id: cur.draft_id, body };
  if (usersOwn) await session.attestUserAuthorship(written);
  else await session.ledger.attest("rewrite", paraId, rewriteContent(written));
  const after = store.getParagraph(paraId);
  const state = await paragraphState(session, after);
  session.log("user", "paragraph_edited", {
    draft: cur.draft_id,
    paragraph: paraId,
    author_before: usersOwn ? "user" : "claude",
    author_after: author,
    state,
  });
  return { paragraph: after, state };
}

/** The user writes a new paragraph (real names allowed; tokenised before storing). */
export async function userAddParagraph(
  session: CaseSession,
  draftId: number,
  text: string,
  after?: number,
): Promise<number> {
  const body = await session.tokeniseUserText(text);
  const id = session.store.addParagraph(draftId, body, "user", after);
  // Attest what the app wrote, not a re-read (see userEditParagraph).
  await session.attestUserAuthorship({ id, draft_id: draftId, body });
  session.log("user", "paragraph_added", { draft: draftId, paragraph: id });
  return id;
}

/** The user starts a draft. The title may contain real names; it is tokenised before storing. */
export async function userCreateDraft(
  session: CaseSession,
  kind: DraftKind,
  title: string,
): Promise<number> {
  const id = session.store.createDraft(
    { kind, title: await session.tokeniseUserText(title) },
    "user",
  );
  await session.attestDraftKind(id, kind);
  session.log("user", "draft_created", { draft: id, kind });
  return id;
}

/** The user deletes a draft: its paragraphs' attestations and its heading go with it. */
export async function userDeleteDraft(session: CaseSession, draftId: number): Promise<void> {
  await session.deleteDraft(draftId);
  await session.writeVaultJson(headingFile(draftId), null);
}

// ── adoption ───────────────────────────────────────────────────────────────

/**
 * What the user attests when adopting one of Claude's paragraphs. The app shows: "This paragraph
 * is true, it is from my own knowledge, and it is how I would say it." Both fields must be
 * literally `true`.
 */
export interface AdoptionAttestation {
  ownKnowledge: true;
  ownWords: true;
}

/** The user's answer to "Did you see this yourself or read it?" for one fact. */
export type FactAnswer = "saw" | "read" | "unsure";
export const FACT_ANSWERS: FactAnswer[] = ["saw", "read", "unsure"];

/** One fact of the paragraph (a sentence, as the user was shown it) and the user's answer. */
export interface AdoptionFact {
  text: string;
  answer: FactAnswer;
}

/** An answer as the UI sends it: by position; `text`, if sent, must be the fact as shown. */
export interface FactAnswerIn {
  text?: string;
  answer: FactAnswer;
}

/** Vault file of the fact answers given with each adoption: `{ "<para id>": FactRecord }`. */
export const ADOPTION_FACTS_FILE = "adoption-facts";

export interface FactRecord {
  at: string;
  draft: number;
  facts: AdoptionFact[];
}

const MAX_FACTS = 100;
const MAX_FACT_CHARS = 2000;

/** Validate fact answers sent by the UI. */
export function parseFacts(v: unknown): FactAnswerIn[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_FACTS) {
    throw new InvalidInputError(`facts must be a list of at most ${MAX_FACTS}`);
  }
  return v.map((f): FactAnswerIn => {
    const text: unknown = (f as Record<string, unknown> | null)?.text;
    const answer: unknown = (f as Record<string, unknown> | null)?.answer;
    if (text !== undefined && (typeof text !== "string" || text.length > MAX_FACT_CHARS)) {
      throw new InvalidInputError("A fact's text must be text");
    }
    if (!FACT_ANSWERS.includes(answer as FactAnswer)) {
      throw new InvalidInputError(`Each fact's answer is one of ${FACT_ANSWERS.join(", ")}`);
    }
    return { ...(text === undefined ? {} : { text }), answer: answer as FactAnswer };
  });
}

/**
 * The answers matched to the paragraph's facts as casefile splits them (`paragraphFacts`), so what
 * is recorded is exactly what the user was shown: one answer per fact, in order. A fact text sent
 * with an answer must be that fact's text (re-identified); otherwise the paragraph changed since
 * it was shown (StaleItemError).
 */
async function matchFacts(
  session: CaseSession,
  para: ParagraphRow,
  answers: FactAnswerIn[],
): Promise<AdoptionFact[]> {
  if (!answers.length) return [];
  const shown = (await paragraphFacts(session, para)).map((f) => session.reidentify(f.text).text);
  if (answers.length !== shown.length) {
    throw new InvalidInputError(
      `Answer each fact of the paragraph: it has ${shown.length}, ${answers.length} answered`,
    );
  }
  return answers.map((a, i) => {
    if (a.text !== undefined && a.text !== shown[i]) throw new StaleItemError();
    return { text: shown[i], answer: a.answer };
  });
}

/** Adopting a paragraph that still has an `[In your own words: …]` placeholder. */
export class PlaceholderError extends InvalidInputError {
  constructor(readonly paragraph: number) {
    super(
      `Paragraph ${paragraph} still has an "[In your own words: …]" placeholder. ` +
        "Write that part yourself before adopting it.",
    );
    this.name = "PlaceholderError";
  }
}

/**
 * The user adopts one Claude paragraph as their own (ADR 0009), whether they rewrote it or not.
 * Deliberately one paragraph at a time: there is no bulk adopt. Refused while the paragraph has
 * an `[In your own words` placeholder. The adoption is signed and recorded in the vault's
 * attestation ledger (ADR 0008), so it stops counting if the text changes, if `adopted_at` is set
 * by anything other than the unlocked app, or if an old adoption is written back after being
 * withdrawn. The per-fact answers are kept in the vault and only counted in the log; they are not
 * part of what is signed.
 */
export async function adoptParagraph(
  session: CaseSession,
  paraId: number,
  attestation: AdoptionAttestation,
  opts: { version?: string; facts?: unknown } = {},
): Promise<ParagraphRow> {
  const started = session.requestEpoch();
  if (attestation?.ownKnowledge !== true || attestation?.ownWords !== true) {
    throw new InvalidInputError(
      "Adopting a paragraph needs both attestations: it is from your own knowledge, " +
        "and it is in your own words",
    );
  }
  const answers = parseFacts(opts.facts);
  const cur = session.store.getParagraph(paraId);
  // The user adopts the text they were shown: refuse if Claude changed it since.
  await session.checkParagraphVersion(cur, opts.version);
  const facts = await matchFacts(session, cur, answers);
  if (await paragraphState(session, cur) === "user") {
    throw new InvalidInputError(`Paragraph ${paraId} is already yours; it needs no adoption`);
  }
  if (hasPlaceholder(cur.body)) throw new PlaceholderError(paraId);
  // Sign the row exactly as it will be stored.
  const row: ParagraphRow = { ...cur, adopted_at: new Date().toISOString() };
  const sig = await session.signParagraphAdoption(row, started);
  session.store.setParagraphAdoption(paraId, row.adopted_at, sig);
  if (facts.length) {
    const all = await session.readVaultJson<Record<string, FactRecord>>(ADOPTION_FACTS_FILE, {});
    all[String(paraId)] = { at: row.adopted_at!, draft: cur.draft_id, facts };
    await session.writeVaultJson(ADOPTION_FACTS_FILE, all);
  }
  const count = (a: FactAnswer) => facts.filter((f) => f.answer === a).length;
  session.log("user", "paragraph_adopted", {
    draft: cur.draft_id,
    paragraph: paraId,
    attestation: { ownKnowledge: true, ownWords: true },
    // Counts only: the facts' text stays in the vault.
    ...(facts.length
      ? { facts: { saw: count("saw"), read: count("read"), unsure: count("unsure") } }
      : {}),
  });
  return session.store.getParagraph(paraId);
}

/** Withdraw an adoption. Restoring the old signature in public.db does not bring it back. */
export async function unadoptParagraph(session: CaseSession, paraId: number) {
  const cur = session.store.getParagraph(paraId);
  await session.revoke(
    "paragraph",
    paraId,
    () => session.store.setParagraphAdoption(paraId, null, null),
  );
  session.log("user", "paragraph_unadopted", { draft: cur.draft_id, paragraph: paraId });
}

// ── sources, links and checks ──────────────────────────────────────────────

/**
 * The tokenised lines a citation points at, from the vault (public.db's lines are writable by
 * Claude), or null when the document is gone, unpublished, withheld, or too short.
 */
export async function citableLines(
  session: CaseSession,
  ref: SourceRef,
): Promise<{ line: number; text: string }[] | null> {
  try {
    if (session.isWithheld(await session.getDoc(ref.doc_id))) return null;
  } catch {
    return null;
  }
  const lines = await session.citedLines(ref.doc_id, ref.line_start, ref.line_end);
  if (!lines || lines.length !== ref.line_end - ref.line_start + 1) return null;
  return lines;
}

/** Each entity's kind, by role, for `checkClaim`. */
export function entityKinds(session: CaseSession): Map<string, EntityKind> {
  return new Map(session.registry.list().map((e) => [e.role, e.kind]));
}

/**
 * casefile's own checks of a paragraph against its sources (`claimcheck.checkClaim`). Sources
 * that cannot be quoted are left out; the caller shows them as such.
 */
export async function paragraphChecks(
  session: CaseSession,
  para: ParagraphRow,
  kinds: Map<string, EntityKind> = entityKinds(session),
): Promise<CheckRow[]> {
  const cited: CitedLines[] = [];
  for (const ref of session.store.listParagraphSources(para.id)) {
    const lines = await citableLines(session, ref);
    if (lines) cited.push({ ref, lines });
  }
  return checkClaim(para.body, cited, kinds);
}

/** One fact of a paragraph: a sentence (tokenised), what it is checked against, and the rows. */
export interface ParaFact {
  /** The sentence, tokenised, with its inline citations taken out (`splitSentences`). */
  text: string;
  /** Its own inline citations, or else the paragraph's sources. */
  cites: SourceRef[];
  checks: CheckRow[];
}

/**
 * A paragraph fact by fact ("Fact by fact" when adopting): each sentence checked against the
 * lines it cites inline, or else the paragraph's sources (those that can be quoted). This is the
 * one sentence split: the draft view shows these facts, and `adoptParagraph` records the answers
 * against the same split, so what is shown is what is recorded.
 */
export async function paragraphFacts(
  session: CaseSession,
  para: ParagraphRow,
  kinds: Map<string, EntityKind> = entityKinds(session),
): Promise<ParaFact[]> {
  const own = session.store.listParagraphSources(para.id);
  const quotable = new Map<string, CitedLines | null>();
  const citedFor = async (refs: SourceRef[]) => {
    const out: CitedLines[] = [];
    for (const ref of refs) {
      const key = `${ref.doc_id}:${ref.line_start}-${ref.line_end}`;
      if (!quotable.has(key)) {
        const lines = await citableLines(session, ref);
        quotable.set(key, lines ? { ref, lines } : null);
      }
      const c = quotable.get(key);
      if (c) out.push(c);
    }
    return out;
  };
  const out: ParaFact[] = [];
  for (const sen of splitSentences(para.body)) {
    const cites = sen.cites.length ? sen.cites : own;
    out.push({ text: sen.text, cites, checks: checkClaim(sen.text, await citedFor(cites), kinds) });
  }
  return out;
}

/** A check row the user still has to look at ("N facts to check"). */
export function needsLooking(c: CheckRow): boolean {
  return c.level !== "ok";
}

/**
 * The user sets the document lines a paragraph is based on and, optionally, the chronology
 * entries and evidence links it relies on. Withheld or missing documents are refused. Sources are
 * not part of what an adoption signs, so this does not change the paragraph's state.
 */
export async function setParagraphSources(
  session: CaseSession,
  paraId: number,
  sources: SourceRef[],
  links?: ParagraphLink[],
): Promise<void> {
  const p = session.store.getParagraph(paraId);
  for (const ref of sources) {
    if (!await citableLines(session, ref)) {
      throw new InvalidInputError(
        `${ref.doc_id}:${ref.line_start}${
          ref.line_end === ref.line_start ? "" : `-${ref.line_end}`
        } cannot be cited: the document is missing, withheld from Claude, or shorter`,
      );
    }
  }
  session.store.setParagraphSources(paraId, sources);
  if (links) session.store.setParagraphLinks(paraId, links);
  session.log("user", "paragraph_sources_set", {
    draft: p.draft_id,
    paragraph: paraId,
    sources: sources.length,
    ...(links ? { relies: links.length } : {}),
  });
}

// ── affidavit heading (vault only) ─────────────────────────────────────────

/**
 * The heading of an affidavit: court file number, who is who in the proceedings, the deponent's
 * occupation and address, and whether it is sworn or affirmed. These identify people, so the
 * heading is kept in the vault only, never in public.db. Roles name entities in the registry.
 */
export interface DraftHeading {
  fileNumber: string | null;
  deponent: string | null;
  applicant: string | null;
  respondent: string | null;
  occupation: string | null;
  address: string | null;
  oath: "sworn" | "affirmed" | null;
}

const HEADING_TEXT = ["fileNumber", "occupation", "address"] as const;
const HEADING_ROLES = ["deponent", "applicant", "respondent"] as const;
const MAX_HEADING_CHARS = 300;

interface StoredHeading extends DraftHeading {
  /** The draft's `created_at` when the heading was saved: a reused draft id does not inherit it. */
  draftCreatedAt: string;
}

export function headingFile(draftId: number): string {
  return `draft-heading-${draftId}`;
}

export const EMPTY_HEADING: DraftHeading = {
  fileNumber: null,
  deponent: null,
  applicant: null,
  respondent: null,
  occupation: null,
  address: null,
  oath: null,
};

/** The heading saved for draft `draftId`, or null. */
export async function getDraftHeading(
  session: CaseSession,
  draftId: number,
): Promise<DraftHeading | null> {
  const d = session.store.getDraft(draftId);
  const h = await session.readVaultJson<StoredHeading | null>(headingFile(draftId), null);
  if (!h || h.draftCreatedAt !== d.created_at) return null;
  const { draftCreatedAt: _, ...heading } = h;
  return { ...EMPTY_HEADING, ...heading };
}

/**
 * Keep every saved heading's people in step with who's who (as `relatedTo` is): a renamed role
 * follows (`renamed`), a role no longer in who's who is cleared. Called by the session whenever
 * who's who is saved, so the export names the deponent and the safety warning still knows them.
 */
export async function followDraftHeadings(
  session: CaseSession,
  renamed?: { from: string; to: string },
): Promise<void> {
  for (const name of await session.vault.list("draft-heading-")) {
    const h = await session.readVaultJson<StoredHeading | null>(name, null);
    if (!h) continue;
    let changed = false;
    for (const k of HEADING_ROLES) {
      const r = h[k];
      if (r === null || r === undefined) continue;
      if (renamed && r === renamed.from) h[k] = renamed.to;
      else if (typeof r !== "string" || !session.registry.get(r)) h[k] = null;
      else continue;
      changed = true;
    }
    if (changed) await session.writeVaultJson(name, h);
  }
}

/** Validate and save a draft's heading (vault only). The log records only that it changed. */
export async function setDraftHeading(
  session: CaseSession,
  draftId: number,
  input: unknown,
): Promise<DraftHeading> {
  const d = session.store.getDraft(draftId);
  if (!input || typeof input !== "object") throw new InvalidInputError("Bad heading");
  const v = input as Record<string, unknown>;
  const h: DraftHeading = { ...EMPTY_HEADING };
  for (const k of HEADING_TEXT) {
    const x = v[k];
    if (x === undefined || x === null || x === "") continue;
    if (typeof x !== "string" || x.length > MAX_HEADING_CHARS) {
      throw new InvalidInputError(`${k} must be text of at most ${MAX_HEADING_CHARS} characters`);
    }
    h[k] = x.trim() || null;
  }
  for (const k of HEADING_ROLES) {
    const x = v[k];
    if (x === undefined || x === null || x === "") continue;
    if (typeof x !== "string" || !session.registry.get(x)) {
      throw new InvalidInputError(`${k} must be someone in Who's who`);
    }
    h[k] = x;
  }
  if (v.oath !== undefined && v.oath !== null && v.oath !== "") {
    if (v.oath !== "sworn" && v.oath !== "affirmed") {
      throw new InvalidInputError("oath is sworn or affirmed");
    }
    h.oath = v.oath;
  }
  const stored: StoredHeading = { ...h, draftCreatedAt: d.created_at };
  await session.writeVaultJson(headingFile(draftId), stored);
  session.log("user", "draft_heading_set", { draft: draftId });
  return h;
}

// ── export ─────────────────────────────────────────────────────────────────

export interface BadToken {
  /** Paragraph id, or null for the draft title. */
  paragraph: number | null;
  token: string;
  problem: "unknown" | "malformed";
}

/** Something about one paragraph that blocks an affidavit's export or is flagged for others. */
export interface ExportIssue {
  paragraph: number;
  /** 1-based position in the draft. */
  n: number;
  reason: "needs_you" | "rewritten" | "placeholder" | "fact";
  message: string;
}

export interface ExportCheck {
  /** The kind the vault recorded (ADR 9). */
  kind: DraftKind;
  kindChanged: boolean;
  /** Nothing blocks the export (flags may still need confirming). */
  ready: boolean;
  /** Affidavits: what must be done first. */
  blockers: ExportIssue[];
  /** Other kinds: what the user confirms at export (`confirm`). */
  flags: ExportIssue[];
  badTokens: BadToken[];
}

export class ExportBlockedError extends Error {
  constructor(
    readonly draftId: number,
    /** Paragraphs Claude drafted that are not validly adopted (affidavits). */
    readonly needsReview: number[],
    /** Tokens that cannot be re-identified, in any draft kind. */
    readonly badTokens: BadToken[],
    /** Paragraphs that still hold an `[In your own words` placeholder (affidavits). */
    readonly placeholders: number[] = [],
  ) {
    const parts: string[] = [];
    if (needsReview.length) {
      parts.push(
        `paragraph(s) ${needsReview.join(", ")} were drafted by Claude and must be adopted`,
      );
    }
    if (placeholders.length) {
      parts.push(`paragraph(s) ${placeholders.join(", ")} still have a placeholder to fill in`);
    }
    if (badTokens.length) {
      parts.push(
        `unrecognised name token(s): ${
          badTokens.map((b) =>
            `${b.token} (${b.paragraph === null ? "title" : `paragraph ${b.paragraph}`})`
          ).join(", ")
        }`,
      );
    }
    super(`Export blocked: ${parts.join("; ")}`);
    this.name = "ExportBlockedError";
  }
}

/** A draft that is not an affidavit has flags the user has not confirmed. */
export class ExportNeedsConfirmError extends Error {
  constructor(readonly draftId: number, readonly flags: ExportIssue[]) {
    super(
      `Check before exporting: ${flags.length} thing(s) in this draft are Claude's and unchecked`,
    );
    this.name = "ExportNeedsConfirmError";
  }
}

export interface ParaInfo {
  para: ParagraphRow;
  state: ParaState;
  placeholder: boolean;
  checks: CheckRow[];
}

async function paragraphInfo(session: CaseSession, paras: ParagraphRow[]): Promise<ParaInfo[]> {
  const kinds = entityKinds(session);
  return await Promise.all(paras.map(async (para) => ({
    para,
    state: await paragraphState(session, para),
    placeholder: hasPlaceholder(para.body),
    checks: await paragraphChecks(session, para, kinds),
  })));
}

function issuesOf(info: ParaInfo[], affidavit: boolean): ExportIssue[] {
  const out: ExportIssue[] = [];
  info.forEach((p, i) => {
    const base = { paragraph: p.para.id, n: i + 1 };
    if (p.state === "claude_needs_you") {
      out.push({ ...base, reason: "needs_you", message: "Drafted by Claude — needs you" });
    } else if (p.state === "claude_rewritten") {
      out.push({
        ...base,
        reason: "rewritten",
        message: "Drafted by Claude — rewritten by you, adopt to confirm",
      });
    }
    if (p.placeholder) {
      out.push({
        ...base,
        reason: "placeholder",
        message: "Has an “[In your own words” placeholder to fill in",
      });
    }
    // Facts are flagged for other kinds; an affidavit's Claude paragraphs are adopted one by one.
    if (!affidavit && p.state !== "user" && p.state !== "claude_adopted") {
      for (const c of p.checks.filter(needsLooking)) {
        out.push({ ...base, reason: "fact", message: c.message });
      }
    }
  });
  return out;
}

/** Paragraph counts by state, for the drafts list. */
export interface DraftCounts {
  user: number;
  needsYou: number;
  rewritten: number;
  adopted: number;
}

export interface DraftOverview {
  counts: DraftCounts;
  /** Check rows needing a look in Claude's paragraphs that are not adopted. */
  factsToCheck: number;
  check: ExportCheck;
  info: ParaInfo[];
}

/** States, checks and the export check for one draft. */
export async function draftOverview(session: CaseSession, draftId: number): Promise<DraftOverview> {
  const stored = session.store.getDraft(draftId);
  // The kind comes from the vault's record, not public.db (Claude could change it there).
  const kind = await session.draftKind(stored);
  const paras = session.store.listParagraphs(draftId);
  const info = await paragraphInfo(session, paras);
  const badTokens: BadToken[] = [];
  const scan = (text: string, paragraph: number | null) => {
    const r = session.reidentify(text);
    for (const u of r.unknown) badTokens.push({ paragraph, token: u.raw, problem: "unknown" });
    for (const m of r.malformed) badTokens.push({ paragraph, token: m.raw, problem: "malformed" });
  };
  scan(stored.title, null);
  for (const p of paras) scan(p.body, p.id);
  const affidavit = kind.kind === "affidavit";
  const issues = issuesOf(info, affidavit);
  const count = (s: ParaState) => info.filter((p) => p.state === s).length;
  return {
    counts: {
      user: count("user"),
      needsYou: count("claude_needs_you"),
      rewritten: count("claude_rewritten"),
      adopted: count("claude_adopted"),
    },
    factsToCheck: info
      .filter((p) => p.state !== "user" && p.state !== "claude_adopted")
      .reduce((n, p) => n + p.checks.filter(needsLooking).length, 0),
    check: {
      kind: kind.kind,
      kindChanged: kind.changed,
      ready: badTokens.length === 0 && (!affidavit || issues.length === 0),
      blockers: affidavit ? issues : [],
      flags: affidavit ? [] : issues,
      badTokens,
    },
    info,
  };
}

/** What export would do for this draft (shown before exporting). */
export async function exportCheck(session: CaseSession, draftId: number): Promise<ExportCheck> {
  return (await draftOverview(session, draftId)).check;
}
