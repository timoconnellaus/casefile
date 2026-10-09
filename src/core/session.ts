import { createHmac } from "node:crypto";
import { type CasePaths, casePaths, isCaseDir, writeCaseScaffold } from "./case.ts";
import { CaseLock } from "./caselock.ts";
import { detect, type NewEntityProposal, type ProposedSpan } from "./detect/pipeline.ts";
import type { Detector } from "./detect/types.ts";
import type { ReasoningEffort } from "./detect/llm.ts";
import { recheckTypedText, type TypedTextRecheck } from "./typedtext.ts";
import {
  type Entity,
  type EntityKind,
  EntityRegistry,
  normaliseVariant,
  swapRoleTokens,
} from "./entities.ts";
import {
  type Actor,
  type ChronologyRow,
  type DraftKind,
  type DraftRow,
  type EvidenceRow,
  InvalidInputError,
  type IssueRow,
  legacySensitivity,
  type LogCheck,
  type LogProblem,
  type Origin,
  originFromStored,
  type ParagraphRow,
  parseOrigin,
  PublicStore,
  type Sensitivity,
  storedOrigin,
  StoreReplacedError,
  type WithheldReason,
} from "./publicdb.ts";
import { extractPdfText, type PdfFileInfo } from "./pdf.ts";
import { Signer } from "./signing.ts";
import { applyTokens, findLeaks, knownMatches, type Leak, tokeniseKnown } from "./tokenise.ts";
import {
  type Form,
  formatToken,
  type Malformed,
  parseTokens,
  type RenderResult,
  renderSegments,
  renderTokens,
  type TokenRef,
} from "./tokens.ts";
import { Vault, VaultCorruptError, VaultReplacedError } from "./vault.ts";
import { followDocAuthors } from "./checking.ts";
import { followDraftHeadings } from "./drafting.ts";
import { originHints, shareableOnCommercial, withheldReason } from "./origin.ts";
import {
  type ExposureTrigger,
  markReshared,
  renameInExposures,
  withdrawExposed,
} from "./exposure.ts";
import type { DocState, OriginHint } from "./states.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AttestationKind,
  ATTESTED_SUMMARIES_FILE,
  type AttestedSummary,
  Ledger,
  LEDGER_FILE,
  type SecurityEvent,
  StaleItemError,
  type UserItemType,
} from "./ledger.ts";

// The ledger's types used to live here; callers still import them from this module.
export {
  type AttestationKind,
  type AttestedSummary,
  Ledger,
  type SecurityEvent,
  StaleItemError,
  type UserItemType,
};

/**
 * The app-side view of an unlocked case. Owns the vault and the public store, and is the only
 * thing that moves information from one to the other (publishing). The Claude-facing CLI never
 * constructs one of these.
 */

export type ClaudeSetup = "consumer" | "commercial";

export interface LlmSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** User has explicitly accepted sending un-redacted text to a non-local endpoint. */
  allowRemote?: boolean;
  /** User has confirmed that an uninspectable local server runs the model on this computer. */
  trustLocalServer?: boolean;
  /** `reasoning_effort` sent to the server (default "none"; "default" sends none). */
  reasoningEffort?: ReasoningEffort;
}

/** The three conditions a commercial Claude plan must meet (PD-AI 5.5), as the user confirmed. */
export interface PlanConditions {
  closedEnvironment: boolean;
  noTraining: boolean;
  thisCaseOnly: boolean;
}

export interface CaseSettings {
  label: string;
  claudeSetup: ClaudeSetup;
  llm: LlmSettings | null;
  nerEnabled: boolean;
  nextDocNumber: number;
  /** The next import batch number (`B1`, `B2`…); absent in cases made before batches. */
  nextBatchNumber?: number;
  /** A NER model other than the default, with its commit and file hashes (ADR 12). */
  nerModel?: { id: string; revision: string; files: Record<string, string> };
  /** The AI-use log is hash-chained (ADR 8); set the first time the app chains it. */
  logChained?: boolean;
  /**
   * Problems with the AI-use log casefile found and recorded (ADR 8, amended), oldest first. Kept
   * by the session itself (`saveSettings` always writes its own copy), so no settings change can
   * drop one; the log check reports them from then on.
   */
  logProblems?: LogProblem[];
  /** Before `logProblems`: a lost head (read as a `head_missing`/`head_damaged` problem). */
  logHeadLost?: { at: string; reason: "missing" | "damaged"; kept?: string | null };
  /** Lock after this many minutes idle (default 30). */
  idleLockMinutes?: 15 | 30 | 60;
  /** Keyboard shortcuts in lists (on unless false). */
  shortcuts?: boolean;
  /** The user's role in the case (e.g. "mother"), for "your own statement" checks. */
  userRole?: string;
  /** PD-AI 5.4 confirmations: when the user last confirmed each (ISO dates). */
  confirmations?: { helpImproveOff?: string; chatHistory?: string };
  /** The Claude plan the user recorded, with its conditions, and when. */
  plan?: { setup: ClaudeSetup; conditions?: PlanConditions; at: string };
  /** Whether a recovery key has been set up for this case. */
  recoveryKey?: boolean;
  /**
   * casefile's extra checks (ADR 14): which backend, and Jev's key and when it was turned on. The
   * key is only ever read by the server to call Jev; no API response, log row or public.db row
   * holds it. Absent: the default (on this computer, Jev off).
   */
  judge?: JudgeSettings;
}

/** Where casefile's extra checks run; "off" leaves only the built-in checks (ADR 14). */
export interface JudgeSettings {
  backend: "off" | "local" | "llm" | "jev";
  /** The user's TypeSafe API key. Vault only. */
  jevKey?: string;
  /** When the user last turned Jev on (ISO), while it is on. */
  jevOnSince?: string;
}

export type DocStatus = "pending" | "published";

export interface StoredDoc {
  id: string;
  title: string;
  original: string;
  status: DocStatus;
  /**
   * Where the document came from (ADR 7); null: not asked yet. Documents saved before v4 have a
   * `sensitivity` instead, which is mapped to an origin when read (`normaliseStoredDoc`).
   */
  origin: Origin | null;
  source?: string;
  importedAt: string;
  publishedAt?: string;
  proposals: ProposedSpan[];
  newEntities: NewEntityProposal[];
  detectorErrors: { detector: string; message: string }[];
  /** Final replacements used at publish time (offsets into `original`). */
  replacements: { start: number; end: number; role: string; form: Form }[];
  ignore: string[];
  /** Why the user left each value in `ignore` as written (ADR 6): value → reason. */
  ignoreReasons?: Record<string, string>;
  tokenised?: string;
  tokenisedTitle?: string;
  /**
   * On a commercial plan, the user shared this one document explicitly (ADR 7). Cleared when the
   * origin changes or the plan goes back to consumer, so switching plan never shares by itself.
   */
  released?: boolean;
  /** When Claude could last start reading it (it became shared). */
  sharedAt?: string;
  /**
   * Set when a shared document was found to show a known value and was withdrawn (an exposure);
   * cleared when it is re-checked and shared again. The roles are vault-only.
   */
  exposure?: { foundAt: string; roles: string[] } | null;
  /** A suggested origin from a stamp in the text, found at import. */
  originHint?: OriginHint | null;
  /** The import it came in with (`B1`, `B2`…), for the review queue. Vault only. */
  batch?: string;
  /**
   * The document's details (type, date, author, source, tags) as they were in public.db when it
   * was withheld while shared: a change of origin, a switch to a consumer plan or an exposure
   * (ADR 7, `holdDetails`). Withholding clears them from public.db, because they may describe the
   * text; they are kept here so that sharing it again restores them.
   */
  heldDetails?: HeldDetails | null;
  /**
   * Set when a change to who's who (a nickname added…) found known values in this document while
   * it waited for review: when, which values (real values: app only, never logged), and which
   * shared documents were withdrawn by the same change. Cleared when it is published.
   */
  newMatch?: { foundAt: string; values: ExposureTrigger[]; exposed: string[] } | null;
  /**
   * The file it was imported from, when that file is kept in the vault (`originalName`, ADR 23).
   * `original` is the text read from it.
   */
  file?: PdfFileInfo;
}

/** What `importText` takes (and `importPdf`, with the PDF's bytes instead of `text`). */
export interface ImportInput {
  title: string;
  text: string;
  source?: string;
  /**
   * Where it came from. Defaults to null, "not asked yet", which is withheld from Claude until
   * the user answers (ADR 7).
   */
  origin?: Origin | null;
  /** The import batch it belongs to (from `newBatch`), for the review queue. */
  batch?: string;
}

/** Details of a document kept in the vault while it is withheld (`StoredDoc.heldDetails`). */
export interface HeldDetails {
  doc_type: string | null;
  doc_date: string | null;
  author_role: string | null;
  source: string | null;
  meta_by: Actor;
  tags: { tag: string; by: Actor }[];
}

/** The outcome of checking a publish request without publishing it (`previewPublish`). */
export interface PublishPreview {
  /** The title as Claude would see it (tokenised), or null when it could not be built. */
  title: string | null;
  /** Problems in the title that would stop it being shared. */
  titleLeaks: (Leak & { field: "title" })[];
  /** Every problem the leak check found (title and text). */
  leaks: (Leak & { field: "body" | "title" })[];
  /**
   * Why publishing would be refused, or null if it would go through: the leak check, a
   * safety-sensitive value left as written, or another bad request (a missing reason…).
   */
  refused:
    | null
    | { kind: "leak"; message: string }
    | { kind: "safety"; message: string; roles: string[] }
    | { kind: "invalid"; message: string };
  /** Whether Claude would see the text once it is published (its origin and plan allowing). */
  willShare: boolean;
}

export type DocSummary = Omit<
  StoredDoc,
  "original" | "proposals" | "newEntities" | "tokenised" | "replacements"
>;

export interface NewEntityInput {
  /** Reference used by replacements in the same request. */
  ref: string;
  kind: EntityKind;
  full: string;
  role?: string;
  first?: string;
  surname?: string;
  title?: string;
}

export interface PublishRequest {
  newEntities: NewEntityInput[];
  /** `ref` is an existing role or a NewEntityInput.ref. */
  replacements: { start: number; end: number; ref: string; form: Form }[];
  ignore?: string[];
  /**
   * Why each value newly added to `ignore` is left as written. Required: "Leave as written" needs
   * a reason (ADR 6).
   */
  ignoreReasons?: Record<string, string>;
  title?: string;
  /** On a commercial plan: share this other-side or subpoena document with Claude (ADR 7). */
  release?: boolean;
}

/** A document for lists: its summary, state and why it is withheld. */
export interface DocInfo extends DocSummary {
  state: DocState;
  withheldReason: WithheldReason | null;
  /** Shared-able by origin, but it shows a known value: re-check it before sharing. */
  needsRecheck: boolean;
  /**
   * Findings that need the user's decision ("Needs you" on the review screen: values casefile
   * can't tell apart, counted once per value). 0 once it is reviewed.
   */
  undecided: number;
}

export class LeakError extends Error {
  constructor(readonly leaks: (Leak & { field: "body" | "title" })[]) {
    super(`Publishing blocked: ${leaks.length} possible identifying value(s) remain`);
    this.name = "LeakError";
  }
}

/**
 * User text that edits text Claude wrote still contains a known value that Claude's text had as
 * plain text. Tokenising it would tell Claude which of its guesses was a real name (a probe), so
 * the edit is refused instead.
 */
export class ProbeError extends InvalidInputError {
  constructor(readonly roles: string[]) {
    super(
      "This text still contains a real name (or other identifying value) in a place where Claude " +
        "wrote it. Claude may be testing guesses at names: saving it would tell Claude which guess " +
        "was right. Remove or replace it before saving; to refer to the person, type a token such as " +
        `${roles.map((r) => `{{${r}}}`).join(", ")}.`,
    );
    this.name = "ProbeError";
  }
}

/** Options for `CaseSession.tokeniseUserText`. */
export interface UserTextOptions {
  /**
   * The stored text (written or last changed by Claude) that this user text replaces, e.g. a
   * paragraph body before the user's edit. Known values it holds as plain text must not reappear.
   */
  replacing?: (string | null | undefined)[];
  /** What is being edited, for the AI-use log (never a value), e.g. "para:12". */
  target?: string;
}

/** Publishing would leave a safety-sensitive person's name or details as written (ADR 6). */
export class SafetyError extends InvalidInputError {
  constructor(readonly roles: string[], readonly values: string[]) {
    super(
      `${
        values.map((v) => `"${v}"`).join(", ")
      } belongs to someone marked safety-sensitive, so it ` +
        `cannot be left as written. Replace it with the person's label instead.`,
    );
    this.name = "SafetyError";
  }
}

/** A commercial plan was recorded without all three conditions confirmed (ADR 7). */
export class PlanConditionsError extends InvalidInputError {
  constructor() {
    super(
      "A commercial Claude plan can only be recorded when you confirm all three conditions: " +
        "a closed environment, no training on your material, and use for this case only.",
    );
    this.name = "PlanConditionsError";
  }
}

/** Whether all three commercial-plan conditions are confirmed. */
export function conditionsMet(c: Partial<PlanConditions> | null | undefined): c is PlanConditions {
  return !!c && c.closedEnvironment === true && c.noTraining === true &&
    c.thisCaseOnly === true;
}

/**
 * A suggested role such as "medicare_1": if it is taken, the next free number ("medicare_2")
 * rather than "medicare_1_2".
 */
function numberedRole(registry: EntityRegistry, hint: string | undefined): string | undefined {
  if (!hint || !registry.get(hint)) return hint;
  const m = /^(.*?)_(\d+)$/.exec(hint);
  if (!m) return hint;
  for (let n = Number(m[2]) + 1;; n++) {
    if (!registry.get(`${m[1]}_${n}`)) return `${m[1]}_${n}`;
  }
}

/**
 * How many findings need the user: values casefile proposed but could not decide (ambiguous),
 * each value counted once, as the review screen groups them ("Needs you").
 */
export function undecidedCount(proposals: ProposedSpan[]): number {
  return new Set(
    proposals.filter((p) => p.proposal.type === "ambiguous").map((p) => normaliseVariant(p.text)),
  ).size;
}

/** Batch ids (`B1`, `B2`…): one per import of one or more documents. */
export const BATCH_RE = /^B[1-9]\d{0,8}$/;

export class UnresolvedError extends Error {
  constructor(readonly spans: ProposedSpan[]) {
    super(`${spans.length} detection(s) need a decision before publishing`);
    this.name = "UnresolvedError";
  }
}

const DEFAULT_SETTINGS = (label: string): CaseSettings => ({
  label,
  claudeSetup: "consumer",
  llm: null,
  nerEnabled: false,
  nextDocNumber: 1,
});

/** Vault file holding the AI-use log's last chained entry `{ id, chain }` (ADR 8). */
const LOG_HEAD_FILE = "log-head";

/**
 * Vault file recording every check of user text that replaces Claude-written text (ADR 3): a JSON
 * array of fixed-shape records `{ ts, probe: 0 | 1, target }`, newest last, capped at
 * EDIT_CHECKS_MAX. A record is written for *every* such save, refused or not, probe or not, and
 * always has the same length for the same target, so the vault file's size and modification time
 * (which Claude can see) do not reveal whether a guess was right.
 */
const EDIT_CHECKS_FILE = "edit-checks";
const EDIT_CHECKS_MAX = 1000;

interface EditCheck {
  ts: string;
  probe: 0 | 1;
  target: string;
}

/** Vault file of security events other than probes (JSON array of `SecurityEvent`, newest last). */
const SECURITY_EVENTS_FILE = "security-events";
const SECURITY_EVENTS_MAX = 1000;

/**
 * Whether material of this origin is restricted (PD-AI 5.5, ADR 7): anything but the user's own.
 * Not asked yet (`null`) counts as restricted.
 */
export function isRestricted(o: Origin | null): boolean {
  return o !== "mine";
}

/** A vault document as this build reads it: a pre-v4 `sensitivity` becomes an `origin`. */
export function normaliseStoredDoc<T extends { origin?: Origin | null }>(d: T): T {
  const legacy = (d as { sensitivity?: Sensitivity }).sensitivity;
  if (!("origin" in d) || d.origin === undefined) {
    d.origin = legacy === undefined ? null : originFromStored(legacy);
  }
  delete (d as { sensitivity?: Sensitivity }).sensitivity;
  return d;
}

/** A re-identified segment (`renderSegments`), with the entity's kind and colour slot. */
export type RichSeg =
  | { t: string }
  | { t: string; role: string; form: Form; kind: EntityKind; colour: number | null }
  | { t: string; unknown: true; raw: string }
  | { t: string; malformed: true; raw: string };

export interface RichText {
  text: string;
  segs: RichSeg[];
  unknown: TokenRef[];
  malformed: Malformed[];
}

/** Vault files that only their own code may write (not through `writeVaultJson`). */
const RESERVED_VAULT_FILES = new Set([
  "settings",
  "entities",
  LEDGER_FILE,
  ATTESTED_SUMMARIES_FILE,
  "edit-checks",
  "security-events",
  "log-head",
]);

/** Which session's entity lock the current async context holds (`withEntityLock`). */
const entityLockScope = new AsyncLocalStorage<CaseSession>();

/** The log problems a stored settings object records (older builds kept one `logHeadLost`). */
function loadLogProblems(stored: CaseSettings | undefined): LogProblem[] {
  const out: LogProblem[] = Array.isArray(stored?.logProblems) ? [...stored.logProblems] : [];
  const old = stored?.logHeadLost;
  if (old && !out.some((p) => p.at === old.at)) {
    out.unshift({
      at: old.at,
      kind: old.reason === "damaged" ? "head_damaged" : "head_missing",
      kept: old.kept ?? null,
    });
  }
  return out;
}

/** What a recorded log problem means, in plain words (shown by the log check). */
export function logProblemText(p: LogProblem): string {
  const on = `on ${p.at.slice(0, 10)}`;
  switch (p.kind) {
    case "head_damaged":
      return `the record of the log's last entry was damaged and could not be read when the case ` +
        `was opened ${on}, so entries deleted from the end of the log before then cannot be ruled out`;
    case "head_missing":
      return `the record of the log's last entry was missing from the vault when the case was ` +
        `opened ${on}, so entries deleted from the end of the log before then cannot be ruled out`;
    case "settings_missing":
      return `the case's settings were missing from the vault when it was opened ${on}, so ` +
        "changes to the log before then cannot be ruled out";
    case "tail_changed":
      return `entries after entry ${p.headId} were deleted or altered (found ${on})`;
  }
}

/** Whether `e` says the case folder was replaced under an open session (ADR 4, amended). */
export function isCaseReplacedError(e: unknown): boolean {
  return e instanceof StoreReplacedError || e instanceof VaultReplacedError;
}

async function rootId(dir: string): Promise<string | null> {
  const st = await Deno.stat(dir);
  return st.ino === null || st.dev === null ? null : `${st.dev}:${st.ino}`;
}

function rootIdSync(dir: string): string | null {
  const st = Deno.statSync(dir);
  return st.ino === null || st.dev === null ? null : `${st.dev}:${st.ino}`;
}

export class CaseSession {
  detectors: Detector[] = [];
  /** The attestation ledger (ADR 0008). */
  readonly ledger: Ledger;

  private constructor(
    readonly paths: CasePaths,
    readonly vault: Vault,
    readonly store: PublicStore,
    readonly signer: Signer,
    public settings: CaseSettings,
    public registry: EntityRegistry,
    ledger: Record<string, string> = {},
    summaries: Record<string, AttestedSummary> = {},
  ) {
    this.ledger = new Ledger(
      {
        vault,
        store,
        signer,
        citedLines: (docId, from, to) => this.citedLines(docId, from, to),
        recordSecurityEvents: (events) => this.#recordSecurityEvents(events),
        settings: () => this.settings,
      },
      ledger,
      summaries,
    );
  }

  static async create(
    root: string,
    passphrase: string,
    label: string,
    opts: { kdfIterations?: number } = {},
  ) {
    const paths = casePaths(root);
    await CaseLock.refuseIfHeld(paths.root);
    if (isCaseDir(paths.root)) throw new Error(`There is already a case at ${paths.root}`);
    await writeCaseScaffold(paths);
    // Before the vault exists, so nothing can open the half-made case (ADR 4, amended).
    const lock = await CaseLock.acquire(paths.root);
    let store: PublicStore | undefined;
    let s: CaseSession;
    try {
      const vault = await Vault.create(paths.vaultDir, passphrase, opts.kdfIterations);
      store = PublicStore.open(paths.publicDb, { create: true });
      store.setInfo("claude_setup", "consumer");
      s = new CaseSession(
        paths,
        vault,
        store,
        new Signer(await vault.macKey()),
        DEFAULT_SETTINGS(label),
        new EntityRegistry(),
      );
    } catch (e) {
      store?.close();
      lock.release();
      throw e;
    }
    s.#adoptLock(lock, await rootId(paths.root));
    await s.saveSettings();
    await s.saveRegistry();
    await s.#enableLogChain();
    s.store.log("app", "case_created", {});
    await s.settled();
    return s;
  }

  static async open(root: string, passphrase: string) {
    const paths = casePaths(root);
    if (!isCaseDir(paths.root)) {
      throw new InvalidInputError(`That folder is not a casefile case: ${paths.root}`);
    }
    // One opener at a time: opening repairs public.db against the vault, which another process
    // building or using the case at the same time would undo (ADR 4, amended).
    const id = await rootId(paths.root);
    const lock = await CaseLock.acquire(paths.root);
    let store: PublicStore | undefined;
    let s: CaseSession;
    let stored: CaseSettings | undefined;
    try {
      const vault = await Vault.open(paths.vaultDir, passphrase);
      store = PublicStore.open(paths.publicDb);
      stored = await vault.readJson<CaseSettings>("settings");
      const settings = { ...DEFAULT_SETTINGS(""), ...stored };
      const registry = new EntityRegistry((await vault.readJson<Entity[]>("entities")) ?? []);
      const ledger = (await vault.readJson<Record<string, string>>(LEDGER_FILE)) ?? {};
      const summaries =
        (await vault.readJson<Record<string, AttestedSummary>>(ATTESTED_SUMMARIES_FILE)) ?? {};
      await writeCaseScaffold(paths); // refresh generated guidance to this build's version
      s = new CaseSession(
        paths,
        vault,
        store,
        new Signer(await vault.macKey()),
        settings,
        registry,
        ledger,
        summaries,
      );
    } catch (e) {
      store?.close();
      lock.release();
      throw e;
    }
    s.#adoptLock(lock, id);
    try {
      s.#logProblems = loadLogProblems(stored);
      // Without its settings the vault can't say whether the log was already chained; a case made
      // by any build that chains always has them, so their loss is itself a problem.
      if (!stored) await s.#recordLogProblem({ kind: "settings_missing" });
      // Countersigns CLI entries written since the app last ran, then chains this one.
      await s.#enableLogChain({ settingsMissing: !stored });
      s.store.log("app", "case_opened", {});
      // A change to who's who that was saved but not followed through (the app stopped between
      // the two) is caught here: shared documents that show a known value are withdrawn and
      // recorded.
      await withdrawExposed(s, { pending: false });
      await s.reconcilePublic();
      await s.ledger.prune();
      await s.recordDraftKinds();
      await s.settled();
    } catch (e) {
      await s.closeSettled().catch(() => {});
      throw e;
    }
    return s;
  }

  /**
   * Close the public store now. Vault writes still queued carry on; use `closeSettled` (as locking
   * does) to wait for them first.
   */
  close() {
    try {
      this.store.close();
    } finally {
      this.#lock?.release();
      this.#lock = undefined;
    }
  }

  #lock?: CaseLock;
  /** The case folder's identity when opened (device and inode), for `folderReplaced`. */
  #rootId: string | null = null;

  #adoptLock(lock: CaseLock, id: string | null) {
    this.#lock = lock;
    this.#rootId = id;
  }

  /**
   * True if the case folder (or its public.db) at this path is no longer the one this session
   * opened: it was deleted and made again, or moved. The session must then be closed: its
   * public.db connection and vault refuse all further use (StoreReplacedError,
   * VaultReplacedError), so nothing it does can reach the case now at that path.
   */
  folderReplaced(): boolean {
    if (this.store.replaced()) return true;
    if (this.#rootId === null) return false;
    try {
      return rootIdSync(this.paths.root) !== this.#rootId;
    } catch {
      return true;
    }
  }

  /** Wait for every queued vault write, then close (what locking the case does). */
  async closeSettled(): Promise<void> {
    try {
      await this.settled();
    } finally {
      this.close();
    }
  }

  /**
   * Wait until every queued vault write (log head, edit checks, attestation ledger) has finished.
   * Some of these complete after the call that queued them returns.
   */
  async settled(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const pending = [
        this.#headWrite,
        this.#editChecksWrite,
        this.ledger.pending,
        this.#securityWrite,
        this.#vaultJsonWrite,
      ];
      await Promise.all(pending.map((p) => p.catch(() => {})));
      if (
        pending[0] === this.#headWrite && pending[1] === this.#editChecksWrite &&
        pending[2] === this.ledger.pending && pending[3] === this.#securityWrite &&
        pending[4] === this.#vaultJsonWrite
      ) return;
    }
  }

  // ── AI-use log hash chain (ADR 8) ────────────────────────────────────────
  //
  // Every row the app writes is chained: MAC(previous chain ‖ row) with a key derived from the
  // vault. CLI rows (no key) are countersigned into the chain on the app's next write. The last
  // chained entry is recorded in the vault (LOG_HEAD_FILE), so deleting entries from the end is
  // detected too.

  #logMac?: (data: string) => string;
  #headWrite: Promise<void> = Promise.resolve();
  #pendingHead?: { id: number; chain: string };

  async #enableLogChain(opts: { settingsMissing?: boolean } = {}) {
    const key = await this.vault.logChainKey();
    this.#logMac = (data) => createHmac("sha256", key).update(data).digest("hex");
    const head = await this.#readLogHead(opts);
    // Rows from before chaining existed are countersigned once as "legacy". After that (the
    // settings record it), a missing head never makes later rows legacy; nor do missing settings.
    const legacy = !head && !this.settings.logChained && !opts.settingsMissing;
    this.store.enableLogChain(this.#logMac, {
      legacy,
      expected: head,
      onChained: (id, chain) => this.#queueHead(id, chain),
      // Runs before anything is sealed over the changed tail; the record is queued ahead of the
      // new head, so the vault never holds a head that hides it without the record.
      onTailChanged: (exp) => {
        this.#addLogProblem({ kind: "tail_changed", headId: exp.id });
        this.#headWrite = this.#headWrite.then(() => this.saveSettings()).catch(() => {});
      },
    });
    if (!this.settings.logChained) {
      this.settings.logChained = true;
      await this.saveSettings();
    }
    this.#logFoundProblems();
    await this.#headWrite;
  }

  /**
   * The recorded head, or undefined. A head that is missing (once the log is chained) or cannot be
   * read does not stop the case opening: the loss is recorded (`logProblems`), so the log check
   * keeps reporting it even after a new head is written (ADR 8, amended). A damaged file is set
   * aside, not deleted.
   */
  async #readLogHead(
    opts: { settingsMissing?: boolean },
  ): Promise<{ id: number; chain: string } | undefined> {
    let head: { id: number; chain: string } | undefined;
    let damaged = false;
    try {
      head = await this.vault.readJson<{ id: number; chain: string }>(LOG_HEAD_FILE);
      if (
        head !== undefined &&
        (typeof head !== "object" || head === null || !Number.isSafeInteger(head.id) ||
          typeof head.chain !== "string")
      ) damaged = true;
    } catch (e) {
      if (!(e instanceof VaultCorruptError || e instanceof SyntaxError)) throw e;
      damaged = true;
    }
    if (damaged) {
      const kept = await this.vault.setAside(LOG_HEAD_FILE);
      await this.#recordLogProblem({ kind: "head_damaged", kept });
      return undefined;
    }
    if (!head && (this.settings.logChained || opts.settingsMissing)) {
      await this.#recordLogProblem({ kind: "head_missing" });
    }
    return head;
  }

  /** Problems recorded for this case's log; only ever added to (see `CaseSettings.logProblems`). */
  #logProblems: LogProblem[] = [];
  /** Head problems found while opening, logged once the chain is on. */
  #loggedNow: LogProblem[] = [];

  #addLogProblem(p: Omit<LogProblem, "at">): LogProblem {
    const problem: LogProblem = { at: new Date().toISOString(), ...p };
    this.#logProblems.push(problem);
    this.#loggedNow.push(problem);
    return problem;
  }

  async #recordLogProblem(p: Omit<LogProblem, "at">) {
    this.#addLogProblem(p);
    await this.saveSettings();
  }

  /** Log the problems found since the last entry (once the chain is on). */
  #logFoundProblems() {
    if (!this.#logMac) return;
    for (const p of this.#loggedNow.splice(0)) {
      if (p.kind === "head_missing" || p.kind === "head_damaged") {
        this.store.log("app", "log_head_lost", {
          reason: p.kind === "head_damaged" ? "damaged" : "missing",
          kept: p.kept ?? null,
        });
      } else {
        this.store.log("app", "log_problem_found", {
          kind: p.kind,
          ...(p.headId !== undefined ? { after: p.headId } : {}),
        });
      }
    }
  }

  #queueHead(id: number, chain: string) {
    this.#pendingHead = { id, chain };
    this.#headWrite = this.#headWrite.then(async () => {
      const head = this.#pendingHead;
      if (!head) return;
      this.#pendingHead = undefined;
      await this.vault.writeJson(LOG_HEAD_FILE, head);
    }).catch(() => {});
  }

  /** Check the AI-use log's hash chain: "intact", or where it was altered (ADR 8). */
  async verifyLog(): Promise<LogCheck> {
    await this.#headWrite;
    const head = await this.vault.readJson<{ id: number; chain: string }>(LOG_HEAD_FILE);
    const check = this.store.verifyLogChain(this.#logMac!, head);
    // Fail closed: an empty log is not an intact one (opening a case always writes an entry).
    if (check.checked === 0) {
      return { ...check, intact: false, problem: check.problem ?? "the log is empty" };
    }
    if (!head && this.settings.logChained) {
      return {
        ...check,
        intact: false,
        problem: check.problem ?? "the record of the log's last entry is missing from the vault",
      };
    }
    if (this.#logProblems.length) {
      const first = this.#logProblems[0];
      const lost = this.#logProblems.find((p) =>
        p.kind === "head_missing" || p.kind === "head_damaged"
      );
      return {
        ...check,
        intact: false,
        recorded: this.#logProblems.map((p) => ({ ...p })),
        ...(lost
          ? {
            headLost: { at: lost.at, reason: lost.kind === "head_damaged" ? "damaged" : "missing" },
          }
          : {}),
        problem: check.problem ?? logProblemText(first),
      };
    }
    return check;
  }

  /**
   * Whether any configured detector looks for names (NER or LLM). Without one, only identifiers
   * (rules) and names already in the case are checked automatically; the UI must say so.
   */
  get nameDetection(): boolean {
    return this.detectors.some((d) => d.findsNames === true);
  }

  async saveSettings() {
    // The log's recorded problems come from the session, never from `settings`, so nothing that
    // changes or replaces the settings object can drop one.
    const { logHeadLost: _old, ...rest } = this.settings;
    this.settings = { ...rest, logProblems: this.#logProblems.map((p) => ({ ...p })) };
    await this.vault.writeJson("settings", this.settings);
  }

  /**
   * Save who's who. Every change to it re-checks every shared document (ADR 7, exposures): any
   * that now shows a known value as written (e.g. a nickname just added) is withdrawn at once.
   * `skipExposureCheck`: a document being published right now (its publish checks it). Then the
   * rest of the text in public.db (notes, chronology, issues, paragraphs…) is re-checked the same
   * way (ADR 27): the user's own text has the value replaced by its token; the rest is listed.
   */
  async saveRegistry(
    opts: { skipExposureCheck?: string } = {},
  ): Promise<TypedTextRecheck | null> {
    await this.vault.writeJson("entities", this.registry.toJSON());
    this.store.setEntities(
      this.registry.list().map((e) => ({
        role: e.role,
        kind: e.kind,
        // A description that shows a value learnt since it was written is not published.
        description: e.description && !findLeaks(e.description, this.registry).length
          ? e.description
          : null,
      })),
    );
    await this.#followRoles();
    await withdrawExposed(this, { skip: opts.skipExposureCheck });
    return await recheckTypedText(this);
  }

  /**
   * Every record in the vault that names a role follows who's who (as `relatedTo` links do):
   * renamed with it (`renamed`), dropped when the role is gone. The one place for this, run on
   * every save of who's who: the documents' authors, the affidavit headings' people and the
   * user's own role. (Exposure records are history: they follow a rename, in `#renameEntity`,
   * but keep a removed role.)
   */
  async #followRoles(renamed?: { from: string; to: string }) {
    await followDocAuthors(this, renamed);
    await followDraftHeadings(this, renamed);
    const mine = this.settings.userRole;
    if (mine && renamed?.from === mine) await this.updateSettings({ userRole: renamed.to });
    else if (mine && !this.registry.get(mine)) await this.updateSettings({ userRole: undefined });
  }

  // ── other vault files ────────────────────────────────────────────────────

  #vaultJsonWrite: Promise<void> = Promise.resolve();

  /**
   * Read a JSON vault file kept by a feature module (e.g. "exposures", "lapsed-checks"), after any
   * queued write to it. `fallback` when the file does not exist.
   */
  async readVaultJson<T>(name: string, fallback: T): Promise<T> {
    await this.#vaultJsonWrite;
    return (await this.vault.readJson<T>(name)) ?? fallback;
  }

  /**
   * Write a JSON vault file kept by a feature module. Writes are queued, so they reach the vault in
   * order. The files the session and ledger keep (settings, entities, documents, ledger, log
   * head…) cannot be written this way.
   */
  async writeVaultJson(name: string, value: unknown): Promise<void> {
    if (RESERVED_VAULT_FILES.has(name) || name.startsWith("doc-")) {
      throw new Error(`Vault file ${name} cannot be written with writeVaultJson`);
    }
    const write = this.#vaultJsonWrite.then(() => this.vault.writeJson(name, value));
    this.#vaultJsonWrite = write.catch(() => {});
    await write;
  }

  async updateSettings(
    patch: Partial<
      Omit<
        CaseSettings,
        | "nextDocNumber"
        | "nextBatchNumber"
        | "claudeSetup"
        | "logChained"
        | "logHeadLost"
        | "logProblems"
      >
    >,
  ) {
    this.settings = { ...this.settings, ...patch };
    await this.saveSettings();
  }

  // ── documents ────────────────────────────────────────────────────────────

  /** The vault file name of document `id`. */
  docName(id: string) {
    return `doc-${id.toLowerCase()}`;
  }

  /**
   * The vault file name of the file document `id` was imported from (ADR 23). Not `doc-…`,
   * because documents are listed by that prefix.
   */
  originalName(id: string) {
    return `original-${id.toLowerCase()}`;
  }

  /** The file document `id` was imported from, or null if it was imported as text. */
  async readOriginal(id: string): Promise<{ bytes: Uint8Array; file: PdfFileInfo } | null> {
    const doc = await this.getDoc(id);
    if (!doc.file) return null;
    const bytes = await this.vault.read(this.originalName(doc.id));
    return bytes ? { bytes, file: doc.file } : null;
  }

  /**
   * Decrypted documents, by id. Only the app writes the vault, but a read can overlap a write:
   * each write bumps the document's generation, and a read only fills the cache if no write
   * happened while it was reading (otherwise it would put the old version back).
   */
  #docs = new Map<string, StoredDoc>();
  #docGen = new Map<string, number>();

  /** Forget the cached copy of document `id` (call around every vault write of it). */
  bumpDoc(id: string) {
    this.#docs.delete(id);
    this.#docGen.set(id, (this.#docGen.get(id) ?? 0) + 1);
  }

  /** Drop every cached document (they are read from the vault again when needed). */
  forgetCachedDocs() {
    for (const id of [...this.#docs.keys()]) this.bumpDoc(id);
  }

  async getDoc(id: string): Promise<StoredDoc> {
    const cached = this.#docs.get(id);
    if (cached) return structuredClone(cached);
    const gen = this.#docGen.get(id) ?? 0;
    let d: StoredDoc | undefined;
    try {
      d = await this.vault.readJson<StoredDoc>(this.docName(id));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Invalid vault file name")) d = undefined;
      else throw e;
    }
    if (!d) throw new InvalidInputError(`No such document: ${id}`);
    normaliseStoredDoc(d);
    if ((this.#docGen.get(id) ?? 0) === gen) this.#docs.set(id, structuredClone(d));
    return d;
  }

  /** Write document `d` to the vault (nothing reaches public.db; see `republish`). */
  async saveDoc(d: StoredDoc) {
    this.bumpDoc(d.id);
    await this.vault.writeJson(this.docName(d.id), d);
    // Another save may have started meanwhile; leave the cache empty rather than guess.
    this.bumpDoc(d.id);
  }

  /**
   * Tokenised lines a citation points at, from the vault (security review: public.db's `lines`
   * are writable by Claude, so quotes shown to the user must not come from there). Null when the
   * document does not exist or is not published. Withheld documents still quote: the user may
   * see everything.
   */
  async citedLines(
    docId: string,
    from: number,
    to: number,
  ): Promise<{ line: number; text: string }[] | null> {
    let doc: StoredDoc;
    try {
      doc = await this.getDoc(docId);
    } catch {
      return null;
    }
    if (doc.status !== "published" || doc.tokenised === undefined) return null;
    return doc.tokenised.split("\n").slice(from - 1, to).map((text, i) => ({
      line: from + i,
      text,
    }));
  }

  /**
   * The Claude plan in force: commercial only when the user recorded it with all three conditions
   * (ADR 7). A case marked commercial before conditions were recorded counts as consumer.
   */
  get effectiveSetup(): ClaudeSetup {
    const plan = this.settings.plan;
    return this.settings.claudeSetup === "commercial" && plan?.setup === "commercial" &&
        conditionsMet(plan.conditions)
      ? "commercial"
      : "consumer";
  }

  /**
   * Why a published document is withheld before its text is looked at: it was exposed, or its
   * origin (with the plan and the user's explicit share) keeps it from Claude. Null: it may be
   * shared, subject to the leak check in `publishedView`.
   */
  originView(doc: StoredDoc): WithheldReason | null {
    if (doc.exposure) return "exposed";
    return withheldReason(doc.origin, this.effectiveSetup, doc.released === true);
  }

  /**
   * The values a document leaves as written that are still honoured: never a value of someone
   * marked safety-sensitive, even if it was left as written before they were marked, or before it
   * was known to be theirs (ADR 6). Every check (leak check, exposures, detection on review) uses
   * this, never `doc.ignore` directly.
   */
  honouredIgnore(ignore: Iterable<string>, registry: EntityRegistry = this.registry): string[] {
    const safety = new Set(
      registry.variants({ leak: true })
        .filter((x) => registry.isSafetySensitive(x.entity.role))
        .map((x) => normaliseVariant(x.text)),
    );
    return [...ignore].filter((v) => !safety.has(normaliseVariant(v)));
  }

  /** Known values or identifiers left as written in a published document's text or title. */
  docLeaks(doc: StoredDoc): Leak[] {
    if (doc.tokenised === undefined) return [];
    const ignore = this.honouredIgnore(doc.ignore ?? []);
    return [
      ...findLeaks(doc.tokenised, this.registry, ignore),
      ...findLeaks(doc.tokenisedTitle ?? "", this.registry, ignore),
    ];
  }

  /**
   * What public.db should hold for a published document (ADR 3, ADR 7). Text is only ever shared
   * when it passes the leak check against who's who *as it is now*: a document whose stored text
   * shows a value learnt since (e.g. a new nickname) is withheld as `exposed` until re-checked,
   * whatever path asks for it to be shared (fail closed).
   */
  publishedView(
    doc: StoredDoc,
  ): {
    title: string;
    body: string | null;
    withheld: boolean;
    withheldReason: WithheldReason | null;
  } {
    let reason = this.originView(doc);
    if (reason === null && this.docLeaks(doc).length) reason = "exposed";
    const withheld = reason !== null;
    return {
      withheld,
      withheldReason: reason,
      // A withheld document's title is replaced too: titles can describe contents.
      title: reason === "origin"
        ? `[withheld: ${legacySensitivity(doc.origin)} material]`
        : reason === "not_asked"
        ? "[withheld: not asked where it came from]"
        : reason === "exposed"
        ? "[withheld: being re-checked]"
        : doc.tokenisedTitle!,
      body: withheld ? null : doc.tokenised!,
    };
  }

  /** Whether Claude can read this document's text now (vault view, not public.db). */
  isShared(doc: StoredDoc): boolean {
    return doc.status === "published" && !this.publishedView(doc).withheld;
  }

  /** The document's state in the shared vocabulary (DESIGN-SPEC §3). */
  docState(doc: StoredDoc): DocState {
    if (doc.status !== "published") return "needs_review";
    if (doc.exposure) return "exposed";
    const view = this.publishedView(doc);
    if (!view.withheld) return "shared";
    // Shareable by origin but showing a known value: it needs re-checking, not withholding.
    return this.originView(doc) === null ? "needs_review" : "withheld";
  }

  /** A document for lists: summary, state and withheld reason. */
  docInfo(doc: StoredDoc): DocInfo {
    const {
      original: _o,
      proposals: _p,
      newEntities: _n,
      tokenised: _t,
      replacements: _r,
      ...rest
    } = doc;
    const published = doc.status === "published";
    const view = published ? this.publishedView(doc) : null;
    return {
      ...rest,
      originHint: doc.originHint === undefined ? originHints(doc.original) : doc.originHint,
      state: this.docState(doc),
      withheldReason: view?.withheldReason ?? null,
      needsRecheck: published && !doc.exposure && this.originView(doc) === null &&
        view!.withheld,
      undecided: published ? 0 : undecidedCount(doc.proposals),
    };
  }

  /** Every document with its state (decrypts each one). */
  async listDocInfo(): Promise<DocInfo[]> {
    const out: DocInfo[] = [];
    for (const d of await this.listDocs()) out.push(this.docInfo(await this.getDoc(d.id)));
    return out;
  }

  /**
   * Make public.db's documents and lines match what the vault says was published (security
   * review: Claude can rewrite them, e.g. so a quote misrepresents the source). Republishes every
   * mismatching document, removes documents the vault did not publish, rebuilds the search index
   * if it is inconsistent, and logs `public_store_repaired` with the ids. Run on open.
   */
  async reconcilePublic(): Promise<string[]> {
    const repaired: string[] = [];
    const published = new Set<string>();
    for (const d of await this.listDocs()) {
      if (d.status !== "published") continue;
      const doc = await this.getDoc(d.id);
      published.add(doc.id);
      const want = this.publishedView(doc);
      const wantLines = want.body === null ? [] : want.body.split("\n");
      const row = this.store.hasDocument(doc.id) ? this.store.getDocument(doc.id) : null;
      const lines = row ? this.store.rawLines(doc.id) : [];
      const ok = row !== null && row.title === want.title && row.body === want.body &&
        (row.withheld === 1) === want.withheld && row.sensitivity === storedOrigin(doc.origin) &&
        (row.withheld_reason ?? null) === want.withheldReason &&
        row.line_count === wantLines.length && lines.length === wantLines.length &&
        lines.every((l, i) => l.line_no === i + 1 && l.text === wantLines[i]);
      if (!ok) {
        this.republish(doc);
        repaired.push(doc.id);
      }
    }
    for (const row of this.store.listDocuments()) {
      if (!published.has(row.id)) {
        this.store.unpublishDocument(row.id);
        repaired.push(row.id);
      }
    }
    const indexOk = this.store.searchIndexOk();
    if (!indexOk) this.store.rebuildSearchIndex();
    if (repaired.length || !indexOk) {
      this.store.log("app", "public_store_repaired", {
        docs: repaired,
        ...(indexOk ? {} : { search_index: true }),
      });
    }
    return repaired;
  }

  async listDocs(): Promise<DocSummary[]> {
    const out: DocSummary[] = [];
    for (const name of await this.vault.list("doc-")) {
      const d = normaliseStoredDoc((await this.vault.readJson<StoredDoc>(name))!);
      const {
        original: _o,
        proposals: _p,
        newEntities: _n,
        tokenised: _t,
        replacements: _r,
        ...rest
      } = d;
      out.push(rest);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Start an import batch: the documents imported together, reviewed one after another (the
   * review queue). Returns its id (`B1`, `B2`…). Vault only.
   */
  async newBatch(): Promise<string> {
    const n = this.settings.nextBatchNumber ?? 1;
    this.settings.nextBatchNumber = n + 1;
    await this.saveSettings();
    return `B${n}`;
  }

  /** Whether `id` is an import batch this case has started. */
  isBatch(id: unknown): id is string {
    return typeof id === "string" && BATCH_RE.test(id) &&
      Number(id.slice(1)) < (this.settings.nextBatchNumber ?? 1);
  }

  /** Store an original and run detection on it. Nothing reaches the public store yet. */
  /**
   * Import a PDF (ADR 23): its text layer is read in a worker with no permissions and imported
   * like any text; the PDF itself is kept, encrypted, as `originalName(id)`. Throws `PdfError`.
   */
  async importPdf(
    input: Omit<ImportInput, "text"> & { bytes: Uint8Array },
  ): Promise<StoredDoc> {
    const { bytes, ...rest } = input;
    const { text, info } = await extractPdfText(bytes);
    return await this.importText({ ...rest, text }, { bytes, info });
  }

  async importText(
    input: ImportInput,
    /** The file the text was read from, kept in the vault (`importPdf`). */
    original?: { bytes: Uint8Array; info: PdfFileInfo },
  ): Promise<StoredDoc> {
    const text = input.text.replace(/\r\n?/g, "\n");
    if (!text.trim()) throw new InvalidInputError("Document is empty");
    if (input.batch !== undefined && !this.isBatch(input.batch)) {
      throw new InvalidInputError(`No such import batch: ${JSON.stringify(input.batch)}`);
    }
    const origin: Origin | null = input.origin === undefined || input.origin === null
      ? null
      : parseOrigin(input.origin);
    const id = `D${String(this.settings.nextDocNumber).padStart(3, "0")}`;
    this.settings.nextDocNumber++;
    await this.saveSettings();
    const result = await detect(text, { registry: this.registry, detectors: this.detectors });
    const doc: StoredDoc = {
      id,
      title: input.title.trim() || id,
      original: text,
      status: "pending",
      origin,
      source: input.source,
      importedAt: new Date().toISOString(),
      proposals: result.spans,
      newEntities: result.newEntities,
      detectorErrors: result.errors,
      replacements: [],
      ignore: [],
      originHint: originHints(text),
      ...(input.batch !== undefined ? { batch: input.batch } : {}),
      ...(original ? { file: original.info } : {}),
    };
    // The original first, so a saved document always has its file; removed if the save fails.
    if (original) await this.vault.write(this.originalName(id), original.bytes);
    try {
      await this.saveDoc(doc);
    } catch (e) {
      if (original) await this.vault.delete(this.originalName(id)).catch(() => {});
      throw e;
    }
    this.store.log("app", "document_imported", {
      doc: id,
      detections: result.spans.length,
      detectors: ["rules", "known", ...this.detectors.map((d) => d.name)],
      detector_errors: result.errors.map((e) => e.detector),
      ...(original ? { format: original.info.type, pages: original.info.pages } : {}),
    });
    return doc;
  }

  /** Re-run detection on a pending document (e.g. after adding entities or enabling a detector). */
  async redetect(id: string): Promise<StoredDoc> {
    const doc = await this.getDoc(id);
    const result = await detect(doc.original, {
      registry: this.registry,
      detectors: this.detectors,
      ignore: this.honouredIgnore(doc.ignore ?? []),
    });
    doc.proposals = result.spans;
    doc.newEntities = result.newEntities;
    doc.detectorErrors = result.errors;
    await this.saveDoc(doc);
    return doc;
  }

  /**
   * The publish request you get by accepting every proposal: existing roles as matched, one new
   * entity per proposed new value (named from the detector's role hint). Ambiguous spans are left
   * out and reported, so the user must decide them.
   */
  defaultPublishRequest(doc: StoredDoc): { request: PublishRequest; unresolved: ProposedSpan[] } {
    const replacements: PublishRequest["replacements"] = [];
    const unresolved: ProposedSpan[] = [];
    const used = new Set<string>();
    for (const s of doc.proposals) {
      const p = s.proposal;
      if (p.type === "existing") {
        replacements.push({ start: s.start, end: s.end, ref: p.role, form: p.form });
      } else if (p.type === "new") {
        used.add(p.key);
        replacements.push({ start: s.start, end: s.end, ref: p.key, form: p.form });
      } else unresolved.push(s);
    }
    const newEntities: NewEntityInput[] = doc.newEntities
      .filter((n) => used.has(n.key))
      .map((n) => ({
        ref: n.key,
        kind: n.kind,
        full: n.full,
        role: n.roleHint,
        first: n.first,
        surname: n.surname,
      }));
    return { request: { newEntities, replacements }, unresolved };
  }

  /** Accept every unambiguous proposal and publish. Throws UnresolvedError if any remain. */
  async publishWithDefaults(id: string, extra: Partial<PublishRequest> = {}): Promise<StoredDoc> {
    const doc = await this.getDoc(id);
    const { request, unresolved } = this.defaultPublishRequest(doc);
    if (unresolved.length) throw new UnresolvedError(unresolved);
    return await this.publish(id, {
      newEntities: [...request.newEntities, ...(extra.newEntities ?? [])],
      replacements: [...request.replacements, ...(extra.replacements ?? [])],
      ignore: extra.ignore,
      ignoreReasons: extra.ignoreReasons,
      title: extra.title,
      release: extra.release,
    });
  }

  /**
   * Tokenise and publish a reviewed document. Creates any new entities, then refuses to publish if
   * the result still contains a known value or an identifier-like string (the leak check).
   */
  publish(id: string, req: PublishRequest): Promise<StoredDoc> {
    return this.withEntityLock(() => this.#publish(id, req));
  }

  /**
   * Everything publishing works out before it changes anything: the new who's who (a copy), the
   * replacements, the tokenised text and title, and the leak check's findings. Throws for a bad
   * request (InvalidInputError) or a safety-sensitive value left as written (SafetyError).
   */
  async #preparePublish(doc: StoredDoc, req: PublishRequest) {
    if (req.release && !this.#canRelease(doc)) {
      throw new InvalidInputError(
        "Only a document from the other side or from a subpoena or the court can be shared " +
          "one at a time, and only once a commercial Claude plan is recorded.",
      );
    }
    // "Leave as written" needs a reason for every value newly left (ADR 6).
    const already = new Set((doc.ignore ?? []).map(normaliseVariant));
    const reasons: Record<string, string> = { ...(doc.ignoreReasons ?? {}) };
    for (const v of req.ignore ?? []) {
      const why = req.ignoreReasons?.[v]?.trim();
      if (why) reasons[v] = why;
      else if (!already.has(normaliseVariant(v))) {
        throw new InvalidInputError(`Say why "${v}" can be left as written.`);
      }
    }
    // Work on a copy of the registry so a failed publish leaves no half-created entities.
    const registry = new EntityRegistry(this.registry.toJSON());
    const refToRole = new Map<string, string>();
    for (const ne of req.newEntities) {
      if (!ne.full.trim()) throw new InvalidInputError(`New entity ${ne.ref} has no value`);
      const existing = registry.match(ne.full);
      if (existing && existing.entity.kind === ne.kind) {
        refToRole.set(ne.ref, existing.entity.role);
        continue;
      }
      // A suggested role must not reveal a value (e.g. an LLM suggesting "anna"); fall back
      // to a neutral kind_N name if it does.
      let role = registry.allocateRole(ne.kind, numberedRole(registry, ne.role));
      if (
        registry.revealingWords(
          role,
          [ne.full, ne.first ?? "", ne.surname ?? "", ne.title ?? ""],
          ne.kind,
        ).length
      ) {
        role = registry.allocateRole(ne.kind);
      }
      registry.add({
        kind: ne.kind,
        full: ne.full,
        role,
        first: ne.first,
        surname: ne.surname,
        title: ne.title,
      });
      refToRole.set(ne.ref, role);
    }
    const replacements = req.replacements.map((r) => {
      const role = refToRole.get(r.ref) ?? (registry.get(r.ref) ? r.ref : undefined);
      if (!role) throw new InvalidInputError(`Replacement refers to unknown entity ${r.ref}`);
      if (r.start < 0 || r.end > doc.original.length || r.end <= r.start) {
        throw new InvalidInputError(`Replacement ${r.start}-${r.end} is outside the document`);
      }
      const text = doc.original.slice(r.start, r.end);
      if (r.form === "title") registry.learnTitle(role, text);
      // A span tokenised as a person's first/surname/title must agree with the stored form,
      // or re-identification would print the wrong string. Learn it if the form is not yet known.
      const e = registry.get(role)!;
      if (r.form !== "full") {
        const known = e.forms[r.form];
        if (!known) e.forms[r.form] = text.trim();
        else if (normaliseVariant(known) !== normaliseVariant(text)) {
          throw new InvalidInputError(
            `"${text}" was marked as {{${role}.${r.form}}}, but that form is "${known}". ` +
              `Mark it as the full form, or add it as an alias of ${role}.`,
          );
        }
      }
      return { start: r.start, end: r.end, role, form: r.form };
    });
    // A safety-sensitive person's name or details are never left as written (ADR 6, ADR 0015).
    // Asking to is refused; an earlier "leave as written" of such a value (made before the person
    // was marked, or before the value was known to be theirs) is dropped, so the leak check below
    // catches the value unless it is replaced.
    const ignore = this.honouredIgnore(
      [...new Set([...(doc.ignore ?? []), ...(req.ignore ?? [])])],
      registry,
    );
    const safetyHits = (req.ignore ?? []).flatMap((v) => {
      const f = normaliseVariant(v);
      return registry.variants({ leak: true })
        .filter((x) => registry.isSafetySensitive(x.entity.role) && normaliseVariant(x.text) === f)
        .map((x) => ({ role: x.entity.role, value: v }));
    });
    if (safetyHits.length) {
      throw new SafetyError(
        [...new Set(safetyHits.map((h) => h.role))].sort(),
        [...new Set(safetyHits.map((h) => h.value))],
      );
    }
    const tokenised = applyTokens(doc.original, replacements);
    const titleSource = (req.title ?? doc.title).trim() || doc.id;
    const tokenisedTitle = tokeniseKnown(titleSource, registry).text;
    // The title is never reviewed span by span, so run the full detectors over it: anything they
    // find outside a token (e.g. a name that appears only in the title) blocks publishing.
    const titleDetections = await detect(tokenisedTitle, {
      registry,
      detectors: this.detectors,
      ignore,
    });
    const plan = {
      registry,
      replacements,
      ignore,
      reasons,
      tokenised,
      tokenisedTitle,
      titleSource,
    };
    // Fail closed: a detector that did not run has not checked the title.
    if (titleDetections.errors.length) {
      return {
        ...plan,
        leaks: titleDetections.errors.map((e) => ({
          start: 0,
          end: 0,
          text: "",
          reason: `the ${e.detector} detector failed, so the title could not be checked`,
          field: "title" as const,
        })) as (Leak & { field: "body" | "title" })[],
      };
    }
    const titleTokens = parseTokens(tokenisedTitle).tokens;
    const titleFindings = titleDetections.spans
      .filter((s) => !titleTokens.some((t) => s.start < t.end && t.start < s.end))
      .map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        reason: `detected ${s.kind}`,
        field: "title" as const,
      }));
    const leaks = [
      ...titleFindings,
      ...findLeaks(tokenised, registry, ignore).map((l) => ({ ...l, field: "body" as const })),
      ...findLeaks(tokenisedTitle, registry, ignore).map((l) => ({
        ...l,
        field: "title" as const,
      })),
    ];
    const uniqueLeaks: (Leak & { field: "body" | "title" })[] = leaks.filter((l, i) =>
      leaks.findIndex((m) => m.field === l.field && m.start === l.start && m.end === l.end) === i
    );
    return { ...plan, leaks: uniqueLeaks };
  }

  /**
   * Check a publish request without publishing anything (the review screen's "Title Claude sees"
   * and problems, as the user decides): the title as Claude would see it, the leak check's
   * findings, and why publishing would be refused. Nothing is saved, logged or created; new
   * entities exist only in a copy of who's who.
   */
  async previewPublish(id: string, req: PublishRequest): Promise<PublishPreview> {
    const doc = await this.getDoc(id);
    try {
      const plan = await this.#preparePublish(doc, req);
      const after: StoredDoc = {
        ...doc,
        tokenised: plan.tokenised,
        tokenisedTitle: plan.tokenisedTitle,
        status: "published",
        exposure: null,
        released: doc.released === true || req.release === true,
      };
      return {
        title: plan.tokenisedTitle,
        titleLeaks: plan.leaks.filter((l): l is Leak & { field: "title" } => l.field === "title"),
        leaks: plan.leaks,
        refused: plan.leaks.length
          ? { kind: "leak", message: new LeakError(plan.leaks).message }
          : null,
        willShare: !plan.leaks.length && this.originView(after) === null,
      };
    } catch (e) {
      if (e instanceof SafetyError) {
        return {
          title: null,
          titleLeaks: [],
          leaks: [],
          refused: { kind: "safety", message: e.message, roles: e.roles },
          willShare: false,
        };
      }
      if (e instanceof InvalidInputError) {
        return {
          title: null,
          titleLeaks: [],
          leaks: [],
          refused: { kind: "invalid", message: e.message },
          willShare: false,
        };
      }
      throw e;
    }
  }

  /**
   * The title as Claude would see it with the document's decisions as they stand: for a reviewed
   * document, the title it was shared with; for one waiting for review, every proposal casefile decided
   * (values that need the user are left out, as on the review screen when it opens).
   */
  async currentTitlePreview(
    doc: StoredDoc,
  ): Promise<{ title: string | null; titleLeaks: (Leak & { field: "title" })[] }> {
    if (doc.status === "published" && doc.tokenisedTitle !== undefined) {
      // What was shared: the stored title, checked against who's who as it is now.
      const ignore = this.honouredIgnore(doc.ignore ?? []);
      return {
        title: doc.tokenisedTitle,
        titleLeaks: findLeaks(doc.tokenisedTitle, this.registry, ignore).map((l) => ({
          ...l,
          field: "title" as const,
        })),
      };
    }
    const p = await this.previewPublish(doc.id, this.defaultPublishRequest(doc).request);
    return { title: p.title, titleLeaks: p.titleLeaks };
  }

  async #publish(id: string, req: PublishRequest): Promise<StoredDoc> {
    const doc = await this.getDoc(id);
    const wasShared = this.isShared(doc);
    const wasExposed = Boolean(doc.exposure);
    const {
      registry,
      replacements,
      ignore,
      reasons,
      tokenised,
      tokenisedTitle,
      titleSource,
      leaks,
    } = await this.#preparePublish(doc, req);
    if (leaks.length) throw new LeakError(leaks);

    this.registry = registry;
    doc.title = titleSource;
    doc.replacements = replacements;
    doc.ignore = ignore;
    doc.ignoreReasons = Object.fromEntries(
      Object.entries(reasons).filter(([v]) =>
        ignore.some((i) => normaliseVariant(i) === normaliseVariant(v))
      ),
    );
    doc.tokenised = tokenised;
    doc.tokenisedTitle = tokenisedTitle;
    doc.status = "published";
    doc.publishedAt = new Date().toISOString();
    // A re-check that passed the leak check ends the exposure; a new match has been decided.
    doc.exposure = null;
    doc.newMatch = null;
    if (req.release) doc.released = true;
    const shared = this.isShared(doc);
    if (shared && !wasShared) doc.sharedAt = doc.publishedAt;
    const restore = shared && doc.heldDetails ? doc.heldDetails : null;
    if (restore) doc.heldDetails = null;
    // Re-check every other shared document against the new who's who (exposures), then this one.
    await this.saveRegistry({ skipExposureCheck: id });
    await this.saveDoc(doc);
    this.republish(doc);
    if (restore) this.#restoreDetails(id, restore);
    if (wasExposed && shared) await markReshared(this, id);
    this.store.log("app", "document_published", {
      doc: id,
      replacements: replacements.length,
      withheld: !shared,
      ...(req.release ? { released: true } : {}),
    });
    return doc;
  }

  /** Whether the user may share this one document explicitly (commercial plan, ADR 7). */
  #canRelease(doc: StoredDoc): boolean {
    return this.effectiveSetup === "commercial" && shareableOnCommercial(doc.origin);
  }

  /** Whether public.db holds this document without its text (vault view). */
  isWithheld(doc: StoredDoc): boolean {
    return this.publishedView(doc).withheld;
  }

  /** Write what public.db should hold for published document `doc` (`publishedView`). */
  republish(doc: StoredDoc) {
    const view = this.publishedView(doc);
    this.store.publishDocument({
      id: doc.id,
      title: view.title,
      body: view.body,
      sensitivity: storedOrigin(doc.origin),
      withheld_reason: view.withheldReason,
      // The original file name stays in the vault: names like "Anna Thornbury affidavit.txt"
      // would otherwise reach Claude untokenised.
    });
  }

  /**
   * The user says where a document came from (ADR 7). Any explicit share (`released`) is dropped:
   * it was given for the old origin. Returns the new state and whether Claude lost the text.
   */
  async setOrigin(
    id: string,
    origin: Origin | null,
  ): Promise<{ state: DocState; withdrawn: boolean }> {
    if (origin !== null) parseOrigin(origin);
    const doc = await this.getDoc(id);
    const wasShared = this.isShared(doc);
    doc.origin = origin;
    doc.released = false;
    const shared = this.isShared(doc);
    if (shared && !wasShared) doc.sharedAt = new Date().toISOString();
    // Withholding clears the details from public.db (ADR 7); keep them in the vault first, so
    // that setting the origin back (Undo) brings them back.
    if (wasShared && !shared) this.holdDetails(doc);
    const restore = shared && doc.heldDetails ? doc.heldDetails : null;
    if (restore) doc.heldDetails = null;
    await this.saveDoc(doc);
    if (doc.status === "published") this.republish(doc);
    if (restore) this.#restoreDetails(id, restore);
    this.store.log("user", "origin_changed", { doc: id, origin });
    return { state: this.docState(doc), withdrawn: wasShared && !shared };
  }

  /**
   * Keep a document's details (type, date, author, source, tags) in the vault before it is
   * withheld, because withholding clears them from public.db (ADR 7). Call it while public.db
   * still shows them, then save `doc`. Re-sharing restores them (`publish`, `release`, `setOrigin`,
   * `setClaudeSetup`). Every path that withholds a shared document uses it: a change of origin,
   * a switch to a consumer plan, an exposure.
   */
  holdDetails(doc: StoredDoc) {
    if (this.store.hasDocument(doc.id)) doc.heldDetails = this.#detailsOf(doc.id);
  }

  /** A document's details and tags as public.db has them now. */
  #detailsOf(id: string): HeldDetails {
    const row = this.store.getDocument(id);
    return {
      doc_type: row.doc_type,
      doc_date: row.doc_date,
      author_role: row.author_role,
      source: row.source,
      meta_by: row.meta_by,
      tags: this.store.tagsFor(id).map((tag) => ({
        tag,
        by: this.store.tagCreatedBy(id, tag) ?? "user",
      })),
    };
  }

  /**
   * Put kept details back in public.db once the document is shared again. Details set since (by
   * the user or Claude) win; kept tags are added to any there now.
   */
  #restoreDetails(id: string, held: HeldDetails) {
    const row = this.store.getDocument(id);
    const meta: Record<string, string> = {};
    for (const k of ["doc_type", "doc_date", "author_role", "source"] as const) {
      if (row[k] === null && held[k] !== null) meta[k] = held[k]!;
    }
    try {
      if (Object.keys(meta).length) this.store.setDocumentMeta(id, meta, held.meta_by);
    } catch {
      // A value public.db no longer accepts is dropped rather than block the change of origin.
    }
    for (const t of held.tags) {
      try {
        this.store.addTag(id, t.tag, t.by);
      } catch {
        // as above
      }
    }
  }

  /**
   * What changing a document's origin would do (for the ConfirmBar): whether Claude would lose the
   * text now, what cites it, and what Claude read of it through casefile.
   */
  async originImpact(id: string, origin: Origin | null) {
    const doc = await this.getDoc(id);
    const after = { ...structuredClone(doc), origin, released: false };
    const withdraw = this.isShared(doc) && !this.isShared(after);
    const cited = this.store.citationsOf(id, { includeRemoved: true });
    return {
      withdraw,
      citedBy: cited,
      claudeReads: this.store.claudeReadsOf(id),
    };
  }

  /**
   * On a commercial plan, share one other-side or subpoena document explicitly (ADR 7). Refused if
   * its text shows a known value (re-check it first).
   */
  async release(id: string): Promise<StoredDoc> {
    const doc = await this.getDoc(id);
    if (doc.status !== "published") throw new InvalidInputError("Review this document first.");
    if (!this.#canRelease(doc)) {
      throw new InvalidInputError(
        "Only a document from the other side or from a subpoena or the court can be shared " +
          "one at a time, and only once a commercial Claude plan is recorded.",
      );
    }
    if (doc.exposure) throw new InvalidInputError("Re-check this document before sharing it.");
    const leaks = this.docLeaks(doc);
    if (leaks.length) {
      throw new LeakError(leaks.map((l) => ({ ...l, field: "body" as const })));
    }
    const wasShared = this.isShared(doc);
    doc.released = true;
    if (!wasShared) doc.sharedAt = new Date().toISOString();
    const restore = doc.heldDetails ?? null;
    doc.heldDetails = null;
    await this.saveDoc(doc);
    this.republish(doc);
    if (restore) this.#restoreDetails(id, restore);
    this.store.log("user", "document_shared", { doc: id });
    return doc;
  }

  /**
   * Take a shared document back from Claude (Undo share): it leaves public.db entirely and needs
   * review again. Like `reopen`, the user's decisions are kept: each replacement comes back as an
   * accepted proposal, values left as written stay left (with their reasons), and anything found
   * since is added for review.
   */
  async withdraw(id: string): Promise<StoredDoc> {
    const doc = await this.getDoc(id);
    if (doc.status !== "published") throw new InvalidInputError("This document is not shared.");
    await this.#reopen(doc);
    this.store.log("user", "document_withdrawn", { doc: id, reason: "user" });
    return doc;
  }

  /**
   * Review a shared document again: it is withdrawn from Claude, and its earlier decisions come
   * back as accepted proposals, with anything detected since added for review.
   */
  async reopen(id: string): Promise<StoredDoc> {
    const doc = await this.getDoc(id);
    if (doc.status !== "published") throw new InvalidInputError("This document is not shared.");
    await this.#reopen(doc);
    this.store.log("user", "document_reopened", { doc: id });
    return doc;
  }

  async #reopen(doc: StoredDoc) {
    const earlier: ProposedSpan[] = doc.replacements.map((r, i) => ({
      id: `r${i + 1}`,
      start: r.start,
      end: r.end,
      text: doc.original.slice(r.start, r.end),
      kind: this.registry.get(r.role)?.kind ?? "other",
      source: "manual",
      confidence: 1,
      label: "earlier decision",
      proposal: { type: "existing", role: r.role, form: r.form },
    }));
    const result = await detect(doc.original, {
      registry: this.registry,
      detectors: this.detectors,
      ignore: this.honouredIgnore(doc.ignore ?? []),
    });
    const fresh = result.spans.filter((s) =>
      !earlier.some((e) => s.start < e.end && e.start < s.end)
    );
    doc.proposals = [...earlier, ...fresh].sort((a, b) => a.start - b.start);
    doc.newEntities = result.newEntities;
    doc.detectorErrors = result.errors;
    doc.status = "pending";
    doc.released = false;
    await this.saveDoc(doc);
    this.store.unpublishDocument(doc.id);
  }

  /**
   * Re-check a document after who's who changed (e.g. an exposed one): its earlier decisions plus
   * every known value now found. If nothing needs the user, it is shared again (subject to its
   * origin and the leak check); otherwise it goes back to review.
   */
  async recheck(id: string): Promise<{ id: string; state: DocState; unresolved: number }> {
    const doc = await this.getDoc(id);
    if (doc.status !== "published") {
      const d = await this.redetect(id);
      return { id, state: "needs_review", unresolved: d.proposals.length };
    }
    const result = await detect(doc.original, {
      registry: this.registry,
      detectors: this.detectors,
      ignore: this.honouredIgnore(doc.ignore ?? []),
    });
    const fresh = result.spans.filter((s) =>
      !doc.replacements.some((r) => s.start < r.end && r.start < s.end)
    );
    const needsUser = result.errors.length > 0 ||
      fresh.some((s) => s.proposal.type !== "existing");
    if (!needsUser) {
      try {
        const done = await this.publish(id, {
          newEntities: [],
          replacements: [
            ...doc.replacements.map((r) => ({
              start: r.start,
              end: r.end,
              ref: r.role,
              form: r.form,
            })),
            ...fresh.map((s) => {
              const p = s.proposal as { role: string; form: Form };
              return { start: s.start, end: s.end, ref: p.role, form: p.form };
            }),
          ],
        });
        this.store.log("user", "document_rechecked", { doc: id });
        return { id, state: this.docState(done), unresolved: 0 };
      } catch (e) {
        if (!(e instanceof LeakError) && !(e instanceof InvalidInputError)) throw e;
      }
    }
    await this.#reopen(await this.getDoc(id));
    this.store.log("user", "document_rechecked", { doc: id, review: true });
    const after = await this.getDoc(id);
    return {
      id,
      state: "needs_review",
      unresolved: after.proposals.filter((p) => p.proposal.type !== "existing").length,
    };
  }

  /**
   * Record the Claude plan the user has (ADR 7). A commercial plan needs all three conditions
   * confirmed; it is attested in the ledger (`plan`) and logged. Switching to commercial shares
   * nothing by itself: other-side and subpoena documents are then shared one at a time. Switching
   * back to consumer withdraws them and forgets those shares. Returns the documents withdrawn.
   */
  async setClaudeSetup(
    setup: ClaudeSetup,
    conditions?: Partial<PlanConditions> | null,
  ): Promise<{ withdrawn: string[]; at: string }> {
    if (setup !== "consumer" && setup !== "commercial") {
      throw new InvalidInputError(`Bad Claude setup ${JSON.stringify(setup)}`);
    }
    if (setup === "commercial" && !conditionsMet(conditions)) throw new PlanConditionsError();
    const before = new Map<string, boolean>();
    for (const d of await this.listDocs()) {
      if (d.status === "published") before.set(d.id, this.isShared(await this.getDoc(d.id)));
    }
    const at = new Date().toISOString();
    this.settings.claudeSetup = setup;
    this.settings.plan = {
      setup,
      ...(setup === "commercial"
        ? {
          conditions: {
            closedEnvironment: true,
            noTraining: true,
            thisCaseOnly: true,
          },
        }
        : {}),
      at,
    };
    await this.saveSettings();
    await this.ledger.attest("plan", "current", {
      setup,
      conditions: this.settings.plan.conditions ?? null,
    });
    this.store.setInfo("claude_setup", setup);
    const withdrawn: string[] = [];
    for (const d of await this.listDocs()) {
      const doc = await this.getDoc(d.id);
      if (setup === "consumer" && doc.released) {
        doc.released = false;
        await this.saveDoc(doc);
      }
      if (doc.status !== "published") continue;
      const shared = this.isShared(doc);
      const wasShared = before.get(doc.id) === true;
      // Withdrawn by the switch: keep its details (ADR 7) before public.db loses them.
      if (wasShared && !shared) this.holdDetails(doc);
      const restore = shared && !wasShared && doc.heldDetails ? doc.heldDetails : null;
      if (restore) doc.heldDetails = null;
      if (wasShared !== shared || (setup === "consumer" && isRestricted(doc.origin))) {
        this.republish(doc);
      }
      if (restore) this.#restoreDetails(doc.id, restore);
      if (wasShared !== shared) await this.saveDoc(doc);
      if (wasShared && !shared) withdrawn.push(doc.id);
    }
    this.store.log("user", "claude_setup_changed", {
      setup,
      ...(setup === "commercial" ? { conditions: this.settings.plan.conditions } : {}),
      withdrawn,
    });
    return { withdrawn, at };
  }

  async deleteDoc(id: string) {
    await this.getDoc(id);
    this.store.unpublishDocument(id);
    this.bumpDoc(id);
    await this.vault.delete(this.docName(id));
    await this.vault.delete(this.originalName(id));
    this.bumpDoc(id);
    this.store.log("user", "document_deleted", { doc: id });
  }

  /** Re-check every published document against the current registry and rules. */
  async auditPublished(): Promise<{ doc: string; leaks: Leak[] }[]> {
    const out: { doc: string; leaks: Leak[] }[] = [];
    for (const d of await this.listDocs()) {
      if (d.status !== "published") continue;
      const doc = await this.getDoc(d.id);
      const leaks = [
        ...findLeaks(doc.tokenised!, this.registry, this.honouredIgnore(doc.ignore ?? [])),
        ...findLeaks(doc.tokenisedTitle!, this.registry, this.honouredIgnore(doc.ignore ?? [])),
      ];
      if (leaks.length) out.push({ doc: d.id, leaks });
    }
    return out;
  }

  // ── entities ─────────────────────────────────────────────────────────────

  renameEntity(oldRole: string, newRole: string): Promise<void> {
    return this.withEntityLock(() => this.#renameEntity(oldRole, newRole));
  }

  async #renameEntity(oldRole: string, newRole: string) {
    const revealing = this.registry.revealingWords(newRole);
    if (revealing.length) {
      throw new InvalidInputError(
        `The role name "${newRole}" contains "${
          revealing.join(", ")
        }", which is part of a real value. ` +
          `Role names are visible to Claude; use a relationship like "mother" or "maternal_grandmother".`,
      );
    }
    this.registry.rename(oldRole, newRole);
    const re = new RegExp(`\\{\\{${oldRole}(\\.(?:first|surname|title))?\\}\\}`, "g");
    const swap = (t: string | null) =>
      t === null ? null : t.replace(re, (_m, f) => `{{${newRole}${f ?? ""}}}`);
    for (const d of await this.listDocs()) {
      const doc = await this.getDoc(d.id);
      let changed = false;
      if (doc.heldDetails) {
        const h = doc.heldDetails;
        const before = JSON.stringify(h);
        doc.heldDetails = {
          ...h,
          doc_type: swap(h.doc_type),
          doc_date: swap(h.doc_date),
          author_role: swap(h.author_role),
          source: swap(h.source),
        };
        if (JSON.stringify(doc.heldDetails) !== before) changed = true;
      }
      if (doc.exposure?.roles.includes(oldRole)) {
        doc.exposure.roles = doc.exposure.roles.map((r) => r === oldRole ? newRole : r);
        changed = true;
      }
      for (const v of doc.newMatch?.values ?? []) {
        if (v.role === oldRole) {
          v.role = newRole;
          changed = true;
        }
      }
      for (const r of doc.replacements) {
        if (r.role === oldRole) {
          r.role = newRole;
          changed = true;
        }
      }
      for (const p of doc.proposals) {
        if (p.proposal.type === "existing" && p.proposal.role === oldRole) {
          p.proposal.role = newRole;
          changed = true;
        } else if (p.proposal.type === "ambiguous") {
          for (const o of p.proposal.options) {
            if (!o.isNew && o.ref === oldRole) {
              o.ref = newRole;
              changed = true;
            }
          }
        }
      }
      if (doc.status === "published") {
        doc.tokenised = applyTokens(doc.original, doc.replacements);
        doc.tokenisedTitle = tokeniseKnown(doc.title, this.registry).text;
      }
      if (changed) await this.saveDoc(doc);
    }
    this.store.renameRoleInText(oldRole, newRole);
    await this.#followRoles({ from: oldRole, to: newRole });
    await renameInExposures(this, oldRole, newRole);
    await this.saveRegistry();
    for (const d of await this.listDocs()) {
      if (d.status === "published") this.republish(await this.getDoc(d.id));
    }
    this.store.log("user", "entity_renamed", { from: oldRole, to: newRole });
  }

  /**
   * Rewrite every vault document's references to `role` (ADR 25). `replacement` says what each
   * replacement of `role` becomes: another role and form (merge) or null (left as written, with
   * `reason`). `swapText` rewrites tokenised text (held details). Published documents are
   * re-tokenised from their replacements.
   */
  async #rewriteRoleInDocs(
    role: string,
    replacement: (form: Form) => { role: string; form: Form } | null,
    swapText: (t: string) => string,
    reason?: string,
  ) {
    for (const d of await this.listDocs()) {
      const doc = await this.getDoc(d.id);
      const before = JSON.stringify(doc);
      const leave = (text: string) => {
        const v = text.trim();
        if (!v) return;
        if (!(doc.ignore ?? []).some((i) => normaliseVariant(i) === normaliseVariant(v))) {
          doc.ignore = [...(doc.ignore ?? []), v];
        }
        doc.ignoreReasons = { ...(doc.ignoreReasons ?? {}), [v]: reason ?? "" };
      };
      if (doc.heldDetails) {
        const h = doc.heldDetails;
        const sw = (t: string | null) => t === null ? null : swapText(t);
        doc.heldDetails = {
          ...h,
          doc_type: sw(h.doc_type),
          doc_date: sw(h.doc_date),
          author_role: sw(h.author_role),
          source: sw(h.source),
        };
      }
      if (doc.newMatch) {
        doc.newMatch.values = doc.newMatch.values.flatMap((v) => {
          if (v.role !== role) return [v];
          const to = replacement("full");
          return to ? [{ ...v, role: to.role }] : [];
        });
      }
      doc.replacements = doc.replacements.flatMap((r) => {
        if (r.role !== role) return [r];
        const to = replacement(r.form);
        if (!to) {
          leave(doc.original.slice(r.start, r.end));
          return [];
        }
        return [{ ...r, ...to }];
      });
      doc.proposals = doc.proposals.flatMap((s): ProposedSpan[] => {
        const p = s.proposal;
        if (p.type === "existing") {
          if (p.role !== role) return [s];
          const to = replacement(p.form);
          if (!to) {
            leave(s.text);
            return [];
          }
          return [{ ...s, proposal: { type: "existing", role: to.role, form: to.form } }];
        }
        if (p.type !== "ambiguous") return [s];
        const options = p.options.flatMap((o) => {
          if (o.isNew || o.ref !== role) return [o];
          const to = replacement(o.form);
          return to ? [{ ref: to.role, form: to.form, isNew: false }] : [];
        }).filter((o, i, all) => all.findIndex((x) => x.ref === o.ref && x.form === o.form) === i);
        if (options.length > 1) return [{ ...s, proposal: { type: "ambiguous", options } }];
        if (options.length === 0) {
          leave(s.text);
          return [];
        }
        const o = options[0];
        if (!o.isNew) {
          return [{ ...s, proposal: { type: "existing", role: o.ref, form: o.form } }];
        }
        const ne = doc.newEntities.find((n) => n.key === o.ref);
        if (!ne) return [{ ...s, proposal: { type: "ambiguous", options } }];
        return [{
          ...s,
          proposal: {
            type: "new",
            key: ne.key,
            kind: ne.kind,
            full: ne.full,
            roleHint: ne.roleHint,
            form: o.form,
          },
        }];
      });
      if (doc.status === "published") {
        doc.tokenised = applyTokens(doc.original, doc.replacements);
        doc.tokenisedTitle = tokeniseKnown(doc.title, this.registry).text;
      }
      if (JSON.stringify(doc) !== before) await this.saveDoc(doc);
    }
  }

  /**
   * Merge entity `from` into `into` (ADR 25): one person (or place, school…) written two ways.
   * Every token of `from` becomes `into`'s, in the vault and in public.db (documents, Claude's
   * notes, chronology, issues, drafts), `from`'s values become `into`'s forms or other names, and
   * `from` leaves who's who. Items whose text changes need checking again, as after a rename.
   */
  mergeEntity(from: string, into: string): Promise<void> {
    return this.withEntityLock(() => this.#mergeEntity(from, into));
  }

  async #mergeEntity(from: string, into: string) {
    if (!this.registry.get(from) || !this.registry.get(into)) {
      throw new InvalidInputError("Both entries must be in who’s who.");
    }
    if (from === into) throw new InvalidInputError("Choose a different entry to merge into.");
    // Check on a copy: no role name may give away a value it now carries.
    const copy = new EntityRegistry(this.registry.toJSON());
    const was = new Map(copy.list().map((e) => [e.role, copy.revealingWords(e.role)]));
    copy.merge(from, into);
    for (const e of copy.list()) {
      const now = copy.revealingWords(e.role).filter((w) => !(was.get(e.role) ?? []).includes(w));
      if (now.length) {
        throw new InvalidInputError(
          `Merging would make the label ${formatToken(e.role)} give away “${
            now.join(", ")
          }”. Role names are visible to Claude: rename ${formatToken(e.role)} first.`,
        );
      }
    }
    const map = this.registry.merge(from, into);
    const swap = (t: string) => swapRoleTokens(t, from, (f) => formatToken(into, map[f]));
    await this.#rewriteRoleInDocs(from, (f) => ({ role: into, form: map[f] }), swap);
    this.store.replaceRoleTokens(from, (f) => formatToken(into, map[f as Form]));
    await this.#followRoles({ from, to: into });
    await renameInExposures(this, from, into);
    await this.saveRegistry();
    for (const d of await this.listDocs()) {
      if (d.status === "published") this.republish(await this.getDoc(d.id));
    }
    this.store.log("user", "entity_merged", { from, into });
  }

  /**
   * Stop replacing an entity (ADR 25): the user says it identifies no one (a time of day, a
   * heading). Its values are left as written, with `reason`, in every document that had them,
   * tokens of it in Claude's work become its value, and it leaves who's who. Refused for a
   * safety-sensitive entry, and for a value that is also another entry's (merge instead).
   */
  removeEntity(role: string, reason: string): Promise<void> {
    return this.withEntityLock(() => this.#removeEntity(role, reason));
  }

  async #removeEntity(role: string, reason: string) {
    const e = this.registry.get(role);
    if (!e) throw new InvalidInputError("That entry isn’t in who’s who.");
    const why = reason.replace(/\s+/g, " ").trim();
    if (!why) throw new InvalidInputError("Say why it can be left as written.");
    if (this.registry.isSafetySensitive(role)) {
      throw new InvalidInputError(
        "This entry is safety-sensitive, so casefile always replaces it. Turn that off first if it is wrong.",
      );
    }
    const values = [e.forms.full, e.forms.first, e.forms.surname, e.forms.title, ...e.aliases]
      .filter((v): v is string => !!v);
    const own = new Set(values.map(normaliseVariant));
    for (const v of this.registry.variants({ leak: true })) {
      if (v.entity.role !== role && own.has(normaliseVariant(v.text))) {
        throw new InvalidInputError(
          `“${v.text}” is also how ${
            formatToken(v.entity.role)
          } is written, so it can’t be left as written. Merge this entry into ${
            formatToken(v.entity.role)
          } instead.`,
        );
      }
    }
    const value = (f: Form) => e.forms[f] ?? e.forms.full;
    const swap = (t: string) => swapRoleTokens(t, role, value);
    this.registry.remove(role);
    // Other entries' descriptions that named it now say it as written.
    for (const other of this.registry.list()) {
      if (other.description) other.description = swap(other.description);
    }
    await this.#rewriteRoleInDocs(role, () => null, swap, why);
    this.store.replaceRoleTokens(role, (f) => value(f as Form));
    await this.saveRegistry();
    for (const d of await this.listDocs()) {
      if (d.status === "published") this.republish(await this.getDoc(d.id));
    }
    // The reason and the value stay in the vault: the log gets the role only.
    this.store.log("user", "entity_removed", { role });
  }

  /**
   * Change an entity. Runs under the entity lock; the registry changes before the first await
   * (people.ts `changeEntity` relies on that), and saving it runs the exposure check.
   */
  updateEntity(
    role: string,
    patch: Parameters<EntityRegistry["update"]>[1],
  ): Promise<TypedTextRecheck | null> {
    return this.withEntityLock(async () => {
      this.registry.update(role, patch);
      return await this.saveRegistry();
    });
  }

  // ── the entity lock ──────────────────────────────────────────────────────

  #entityQueue: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` when every change to who's who already queued for this session has finished, and
   * before any queued later. Everything that changes the registry runs under it — publish (which
   * works on a copy and swaps it in), entity changes and renames — so no change is lost to a swap
   * and every exposure check sees the registry it follows. Re-entrant: a call made from inside the
   * lock (e.g. `changeEntity` calling `updateEntity`) runs at once, synchronously up to its first
   * await.
   */
  withEntityLock<T>(fn: () => Promise<T>): Promise<T> {
    if (entityLockScope.getStore() === this) return fn();
    const run = this.#entityQueue.then(() => entityLockScope.run(this, fn));
    this.#entityQueue = run.catch(() => {});
    return run;
  }

  // ── re-identification ────────────────────────────────────────────────────

  reidentify(text: string): RenderResult {
    return renderTokens(text, (role, form) => this.registry.resolve(role, form));
  }

  /**
   * Re-identify into segments for display: `text` is what `reidentify` gives, and each resolved
   * token's segment carries its entity's kind and colour slot.
   */
  reidentifyRich(text: string): RichText {
    const r = renderSegments(text, (role, form) => this.registry.resolve(role, form));
    const segs: RichSeg[] = r.segs.map((seg) => {
      if (!("role" in seg)) return seg;
      const e = this.registry.get(seg.role)!;
      return { ...seg, kind: e.kind, colour: e.colour ?? null };
    });
    return {
      text: segs.map((x) => x.t).join(""),
      segs,
      unknown: r.unknown,
      malformed: r.malformed,
    };
  }

  /**
   * Text the user types in the app is tokenised before it is stored where Claude can read it.
   * Known values become tokens; anything the detectors find outside a token (e.g. a new name not
   * yet in the registry) is refused, as for document titles in `publish`.
   */
  async tokeniseUserText(text: string, opts: UserTextOptions = {}): Promise<string> {
    if (opts.replacing) {
      const hit = this.probeRoles(text, opts.replacing);
      await this.recordEditCheck(opts.target ?? "text", hit.length > 0);
      if (hit.length) throw new ProbeError(hit);
    }
    const { text: out, ambiguous } = tokeniseKnown(text, this.registry);
    if (ambiguous.length) {
      throw new InvalidInputError(
        `Ambiguous name(s): ${
          ambiguous.map((a) => `"${a.text}" could be ${a.roles.join(" or ")}`).join("; ")
        }. ` +
          `Use the token instead, e.g. {{${ambiguous[0].roles[0]}}}.`,
      );
    }
    const leaks = findLeaks(out, this.registry);
    if (leaks.length) {
      throw new InvalidInputError(
        `Possible identifying value(s): ${leaks.map((l) => l.text).join(", ")}`,
      );
    }
    const tokens = parseTokens(out).tokens;
    const result = await detect(out, { registry: this.registry, detectors: this.detectors });
    // Fail closed: text a detector could not check is not stored where Claude can read it.
    if (result.errors.length) {
      throw new InvalidInputError(
        `Could not check this text for names: the ${
          result.errors.map((e) => e.detector).join(", ")
        } detector failed. Try again, or turn that detector off in Settings.`,
      );
    }
    const found = result.spans
      .filter((sp) => !tokens.some((t) => sp.start < t.end && t.start < sp.end));
    if (found.length) {
      const values = [...new Set(found.map((sp) => `"${sp.text}"`))];
      throw new InvalidInputError(
        `Possible identifying value(s): ${values.join(", ")}. Add them as people or places ` +
          `first, or use a token such as {{mother}}.`,
      );
    }
    return out;
  }

  /**
   * Probing (security review): Claude writes guesses ("Sarah Anna Jessica") into text the user
   * later edits. Tokenising the user's edit would turn the right guesses into tokens and so reveal
   * them. Returns the roles that `text` still names and that Claude's `replacing` text named as
   * plain text; any at all means the edit must be refused. No side effects.
   */
  probeRoles(text: string, replacing: (string | null | undefined)[]): string[] {
    const before = new Set<string>();
    for (const t of replacing) if (t) this.plainKnownRoles(t).forEach((r) => before.add(r));
    return [...this.plainKnownRoles(text)].filter((r) => before.has(r)).sort();
  }

  /**
   * Record one check of user text replacing Claude's text, refused or not (EDIT_CHECKS_FILE).
   * Callers record exactly once per save request, including saves that change nothing, so what
   * Claude can observe (the vault file's size and mtime; public.db unchanged on any refusal) is the
   * same whether or not a guess was right.
   */
  async recordEditCheck(target: string, probe: boolean): Promise<void> {
    const write = this.#editChecksWrite.then(async () => {
      const all = (await this.vault.readJson<EditCheck[]>(EDIT_CHECKS_FILE)) ?? [];
      all.push({ ts: new Date().toISOString(), probe: probe ? 1 : 0, target });
      await this.vault.writeJson(EDIT_CHECKS_FILE, all.slice(-EDIT_CHECKS_MAX));
    });
    this.#editChecksWrite = write.catch(() => {});
    await write;
  }

  /**
   * Security events for the user (from the vault; never in public.db): possible probes, and items
   * the user had verified, adopted or written that were deleted outside the app. Oldest first.
   */
  async securityLog(): Promise<SecurityEvent[]> {
    await this.#editChecksWrite;
    await this.#securityWrite;
    const all = (await this.vault.readJson<EditCheck[]>(EDIT_CHECKS_FILE)) ?? [];
    const probes: SecurityEvent[] = all.filter((c) => c.probe === 1).map((c) => ({
      ts: c.ts,
      event: "possible_probe" as const,
      target: c.target,
    }));
    const other = (await this.vault.readJson<SecurityEvent[]>(SECURITY_EVENTS_FILE)) ?? [];
    return [...probes, ...other].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  #securityWrite: Promise<void> = Promise.resolve();

  /** Append security events to the vault (queued, so concurrent appends keep each other's). */
  async #recordSecurityEvents(events: SecurityEvent[]): Promise<void> {
    if (!events.length) return;
    const write = this.#securityWrite.then(async () => {
      const all = (await this.vault.readJson<SecurityEvent[]>(SECURITY_EVENTS_FILE)) ?? [];
      all.push(...events);
      await this.vault.writeJson(SECURITY_EVENTS_FILE, all.slice(-SECURITY_EVENTS_MAX));
    });
    this.#securityWrite = write.catch(() => {});
    await write;
  }

  /**
   * Roles whose known values appear in `text` as plain text, outside any token. Uses the very
   * matcher `tokeniseKnown` uses (`knownMatches`), so the probe guard sees exactly what tokenising
   * would replace.
   */
  plainKnownRoles(text: string): Set<string> {
    const tokens = parseTokens(text).tokens;
    const roles = new Set<string>();
    for (const m of knownMatches(text, this.registry)) {
      if (tokens.some((t) => m.start < t.end && t.start < m.end)) continue;
      m.candidates.forEach((c) => roles.add(c.role));
    }
    return roles;
  }

  // ── verification and attestation (ADR 0008), delegated to the ledger ──────
  //
  // The ledger (`ledger.ts`) holds the code; these keep the session's interface unchanged.

  attest(
    kind: AttestationKind,
    id: number | string,
    content: unknown,
    write?: (sig: string) => void,
    started?: number,
  ): Promise<string> {
    return this.ledger.attest(kind, id, content, write, started);
  }

  requestEpoch(): number {
    return this.ledger.requestEpoch();
  }

  revoke(kind: AttestationKind, id: number | string, write?: () => void): Promise<void> {
    return this.ledger.revoke(kind, id, write);
  }

  isAttested(
    kind: AttestationKind,
    id: number | string,
    content: unknown,
    sig?: string | null,
  ): Promise<boolean> {
    return this.ledger.isAttested(kind, id, content, sig);
  }

  itemVersion(
    kind: "chronology" | "evidence" | "issue" | "paragraph",
    row: ChronologyRow | EvidenceRow | IssueRow | ParagraphRow,
  ): Promise<string> {
    return this.ledger.itemVersion(kind, row);
  }

  verifyChronology(id: number, version?: string): Promise<void> {
    return this.ledger.verifyChronology(id, version);
  }

  isChronologyVerified(e: ChronologyRow): Promise<boolean> {
    return this.ledger.isChronologyVerified(e);
  }

  verifyEvidence(id: number, version?: string): Promise<void> {
    return this.ledger.verifyEvidence(id, version);
  }

  isEvidenceVerified(e: EvidenceRow): Promise<boolean> {
    return this.ledger.isEvidenceVerified(e);
  }

  verifyIssue(id: number, version?: string): Promise<void> {
    return this.ledger.verifyIssue(id, version);
  }

  isIssueVerified(i: IssueRow): Promise<boolean> {
    return this.ledger.isIssueVerified(i);
  }

  unverify(what: "chronology" | "evidence" | "issue", id: number): Promise<void> {
    return this.ledger.unverify(what, id);
  }

  checkParagraphVersion(p: ParagraphRow, version?: string): Promise<void> {
    return this.ledger.checkParagraphVersion(p, version);
  }

  signParagraphAdoption(p: ParagraphRow, started?: number): Promise<string> {
    return this.ledger.signParagraphAdoption(p, started);
  }

  isParagraphAdopted(p: ParagraphRow): Promise<boolean> {
    return this.ledger.isParagraphAdopted(p);
  }

  attestUserAuthorship(p: Pick<ParagraphRow, "id" | "draft_id" | "body">): Promise<void> {
    return this.ledger.attestUserAuthorship(p);
  }

  hasUserAuthorship(p: ParagraphRow): Promise<boolean> {
    return this.ledger.hasUserAuthorship(p);
  }

  recordUserItem(type: UserItemType, id: number, written: object): Promise<void> {
    return this.ledger.recordUserItem(type, id, written);
  }

  isUserItem(type: UserItemType, row: { id: number; created_by: Actor }): Promise<boolean> {
    return this.ledger.isUserItem(type, row);
  }

  attestDraftKind(id: number, kind: DraftKind): Promise<void> {
    return this.ledger.attestDraftKind(id, kind);
  }

  recordDraftKinds(): Promise<void> {
    return this.ledger.recordDraftKinds();
  }

  draftKind(d: DraftRow): Promise<{ kind: DraftKind; recorded: boolean; changed: boolean }> {
    return this.ledger.draftKind(d);
  }

  // ── items the user created (ADR 0008) ────────────────────────────────────
  /** The user deletes a note in the app. */
  async deleteNote(id: number) {
    this.store.getNote(id);
    await this.ledger.revokeMany([["user_item", `note/${id}`]]);
    this.store.deleteNote(id);
  }

  // ── deleting through the app ─────────────────────────────────────────────
  //
  // These drop the record's ledger entries as well, so an id SQLite reuses later cannot inherit
  // them. Entries for records deleted outside the app are reported to the user as security events
  // (`attested_item_deleted`, with what the item was) and then pruned when the case is next opened.

  async deleteChronology(id: number) {
    this.store.getChronology(id);
    await this.ledger.revokeMany([["chronology", id], ["user_item", `chronology/${id}`]]);
    this.store.deleteChronology(id);
    this.store.log("user", "chronology_deleted", { id });
  }

  async deleteEvidence(id: number) {
    this.store.getEvidence(id);
    await this.ledger.revokeMany([["evidence", id], ["user_item", `evidence/${id}`]]);
    this.store.deleteEvidence(id);
    this.store.log("user", "evidence_deleted", { id });
  }

  /**
   * The user deletes an issue in the app. Its evidence links are deleted with it, explicitly (the
   * store has no cascade since schema v3); the API asks the user to confirm first.
   */
  async deleteIssue(id: number) {
    this.store.getIssue(id);
    await this.ledger.revokeMany([
      ["issue", id],
      ["user_item", `issue/${id}`],
      ...this.store.listEvidence(id, { includeRemoved: true }).flatMap((
        e,
      ): [AttestationKind, number | string][] => [
        ["evidence", e.id],
        ["user_item", `evidence/${e.id}`],
      ]),
    ]);
    this.store.deleteIssue(id); // deletes its evidence links explicitly
    this.store.log("user", "issue_deleted", { id });
  }

  async deleteParagraph(id: number) {
    const p = this.store.getParagraph(id);
    await this.ledger.revokeMany([["paragraph", id], ["authorship", id], ["rewrite", id]]);
    this.store.deleteParagraph(id);
    this.store.log("user", "paragraph_deleted", { draft: p.draft_id, paragraph: id });
  }

  async deleteDraft(id: number) {
    this.store.getDraft(id);
    await this.ledger.revokeMany([
      ["draft", id],
      ...this.store.listParagraphs(id).flatMap((p): [AttestationKind, number][] => [
        ["paragraph", p.id],
        ["authorship", p.id],
        ["rewrite", p.id],
      ]),
    ]);
    this.store.deleteDraft(id); // paragraphs go with it (ON DELETE CASCADE)
    this.store.log("user", "draft_deleted", { draft: id });
  }

  #editChecksWrite: Promise<void> = Promise.resolve();

  log(actor: Actor, action: string, detail: Record<string, unknown> = {}) {
    this.store.log(actor, action, detail);
    this.#logFoundProblems();
  }
}
