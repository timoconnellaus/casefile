import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { EntityKind } from "./kinds.ts";

/**
 * The public store (ADR 0003): everything Claude is allowed to see, and nothing else.
 * Text in here is tokenised. Both the app and the Claude-facing CLI use this module.
 */

export type Actor = "user" | "claude" | "app";

/**
 * Where a document came from, as the user said (ADR 7). `null` (in the vault) means the user has
 * not been asked yet; it is treated as `not_sure`, so the document is withheld.
 */
export type Origin = "mine" | "other_side" | "court_or_subpoena" | "under_order" | "not_sure";
export const ORIGINS: Origin[] = [
  "mine",
  "other_side",
  "court_or_subpoena",
  "under_order",
  "not_sure",
];

/**
 * The value set used before schema v4. No longer accepted as input; kept only to read vault
 * documents saved by older builds and to migrate public.db to schema v4.
 * @deprecated Use `Origin`.
 */
export type Sensitivity = "none" | "discovery" | "subpoena" | "suppression" | "restricted";
/** @deprecated Use `ORIGINS`. */
export const SENSITIVITIES: Sensitivity[] = [
  "none",
  "discovery",
  "subpoena",
  "suppression",
  "restricted",
];

/** Each legacy sensitivity value and the origin it became in schema v4. */
export const LEGACY_SENSITIVITY_MAP: Record<Sensitivity, Origin> = {
  none: "mine",
  discovery: "other_side",
  subpoena: "court_or_subpoena",
  suppression: "under_order",
  restricted: "not_sure",
};

/** Accept an origin; throws InvalidInputError for anything else (legacy values included). */
export function parseOrigin(v: unknown): Origin {
  if (typeof v === "string" && (ORIGINS as string[]).includes(v)) return v as Origin;
  throw new InvalidInputError(
    `Bad origin ${JSON.stringify(v)}; one of ${ORIGINS.join(", ")}`,
  );
}

/**
 * The origin for a value read from a vault document saved before schema v4: a legacy sensitivity
 * value is mapped, an origin passes through. Only for reading stored documents, never for input.
 */
export function originFromStored(v: unknown): Origin {
  if (typeof v === "string" && Object.hasOwn(LEGACY_SENSITIVITY_MAP, v)) {
    return LEGACY_SENSITIVITY_MAP[v as Sensitivity];
  }
  return parseOrigin(v);
}

/**
 * The legacy sensitivity word for an origin, used only in the title public.db shows for a document
 * withheld by origin (`[withheld: discovery material]`), which CLI output and older notes quote.
 * Not asked yet (`null`) shows as `restricted`, like `not_sure`.
 */
export function legacySensitivity(o: Origin | null): Sensitivity {
  const found = (Object.entries(LEGACY_SENSITIVITY_MAP) as [Sensitivity, Origin][])
    .find(([, origin]) => origin === o);
  return found ? found[0] : "restricted";
}

/**
 * The origin stored in public.db's `documents.sensitivity` column (NOT NULL): a document whose
 * origin was not asked is stored as `not_sure`.
 */
export function storedOrigin(o: Origin | null): Origin {
  return o ?? "not_sure";
}

/** Why a published document's text is withheld from Claude (`documents.withheld_reason`). */
export type WithheldReason = "origin" | "not_asked" | "exposed";

/** Why a document of each origin is withheld, in plain English, to follow "because". */
const WITHHELD_BECAUSE_ORIGIN: Record<Origin, string> = {
  mine: "of where it came from",
  other_side: "it came from the other side",
  court_or_subpoena: "it came from a subpoena or the court",
  under_order: "it is under a court order",
  not_sure: "the user is not sure where it came from",
};

/**
 * Why a withheld document's text is kept from Claude, in plain English to follow "because"
 * (never the raw value). Rows from before schema v4 have no reason; they were withheld for their
 * origin.
 */
export function withheldBecause(
  doc: { sensitivity: Origin; withheld_reason: WithheldReason | null },
): string {
  if (doc.withheld_reason === "exposed") {
    return "it was found to show a name or number that should have been replaced, so it was withdrawn while the user re-checks it";
  }
  if (doc.withheld_reason === "not_asked") {
    return "the user has not said yet where it came from";
  }
  return WITHHELD_BECAUSE_ORIGIN[doc.sensitivity] ?? WITHHELD_BECAUSE_ORIGIN.not_sure;
}
export type DraftKind = "affidavit" | "outline" | "submission" | "letter" | "other";
export const DRAFT_KINDS: DraftKind[] = ["affidavit", "outline", "submission", "letter", "other"];
export type Stance = "supports" | "undermines" | "context";
export const STANCES: Stance[] = ["supports", "undermines", "context"];

export interface DocumentRow {
  id: string;
  title: string;
  doc_type: string | null;
  doc_date: string | null;
  author_role: string | null;
  source: string | null;
  /** The document's origin (the column kept its pre-v4 name). */
  sensitivity: Origin;
  withheld: number;
  withheld_reason: WithheldReason | null;
  body: string | null;
  line_count: number;
  published_at: string;
  meta_by: Actor;
}

export interface SourceRef {
  doc_id: string;
  line_start: number;
  line_end: number;
}

export interface ChronologyRow {
  id: number;
  event_date: string;
  description: string;
  created_by: Actor;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  verified_sig: string | null;
  removed_at: string | null;
  removed_by: Actor | null;
  sources: SourceRef[];
}

export interface IssueRow {
  id: number;
  title: string;
  description: string;
  created_by: Actor;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  verified_sig: string | null;
  removed_at: string | null;
  removed_by: Actor | null;
}

export interface EvidenceRow extends SourceRef {
  id: number;
  issue_id: number;
  note: string;
  stance: Stance;
  created_by: Actor;
  created_at: string;
  verified_at: string | null;
  verified_sig: string | null;
  removed_at: string | null;
  removed_by: Actor | null;
}

export interface NoteRow {
  id: number;
  target_type: string;
  target_id: string;
  body: string;
  created_by: Actor;
  created_at: string;
  /** When the user marked the note as dealt with. */
  done_at: string | null;
  done_by: Actor | null;
}

export interface DraftRow {
  id: number;
  kind: DraftKind;
  title: string;
  created_by: Actor;
  created_at: string;
  updated_at: string;
}

export interface ParagraphRow {
  id: number;
  draft_id: number;
  position: number;
  body: string;
  author: "user" | "claude";
  claude_body: string | null;
  created_at: string;
  updated_at: string;
  adopted_at: string | null;
  adopted_sig: string | null;
}

export interface LogRow {
  id: number;
  ts: string;
  actor: Actor;
  action: string;
  detail: string;
  /** Hash-chain MAC (app side only; null for CLI rows not yet countersigned). */
  chain: string | null;
  /** "signed" (written by the app), "countersigned" (CLI row the app saw), "legacy". */
  chain_kind: string | null;
}

/** The result of checking the AI-use log's hash chain (`PublicStore.verifyLogChain`). */
/**
 * A problem with the AI-use log that casefile recorded in the vault when it found it (ADR 8,
 * amended): the vault's record of the last entry was missing or unreadable (`head_missing`,
 * `head_damaged`), the log no longer led on from it (`tail_changed`, entries after `headId` were
 * deleted or altered), or the vault's settings were missing (`settings_missing`).
 */
export interface LogProblem {
  at: string;
  kind: "head_missing" | "head_damaged" | "tail_changed" | "settings_missing";
  headId?: number;
  kept?: string | null;
}

export interface LogCheck {
  intact: boolean;
  /** Entries covered by the chain. */
  checked: number;
  /** CLI entries the app has not countersigned yet (they are added on the app's next write). */
  pending: number;
  /** The first entry found altered, inserted, or after a deletion. */
  brokenAt?: number;
  problem?: string;
  /** Entries claiming to be the app's or the user's that the app did not write. */
  forged: number[];
  /**
   * The vault's record of the last entry was missing or unreadable when the case was opened
   * (`CaseSettings.logProblems`): entries deleted from the end before `at` cannot be ruled out.
   */
  headLost?: { at: string; reason: "missing" | "damaged" };
  /** Problems casefile found and recorded in the vault earlier; they are never cleared. */
  recorded?: LogProblem[];
}

/** Items that can be removed (restorably) rather than deleted. */
export type RemovableType = "chronology" | "evidence" | "issue";
const REMOVABLE_TABLES: Record<RemovableType, string> = {
  chronology: "chronology",
  evidence: "evidence",
  issue: "issues",
};

/** The table for a removable type; refuses anything else (the name goes into SQL). */
function removableTable(type: string): string {
  if (!Object.hasOwn(REMOVABLE_TABLES, type)) {
    throw new InvalidInputError(`Bad item type ${JSON.stringify(type)}`);
  }
  return REMOVABLE_TABLES[type as RemovableType];
}

/** What a draft paragraph relies on, besides its sources. */
export type ParagraphLinkType = "chronology" | "evidence";
export interface ParagraphLink {
  target_type: ParagraphLinkType;
  target_id: number;
}

/** A public entity: role, kind and the user's (tokenised) relationship description. */
export interface PublicEntity {
  role: string;
  kind: EntityKind;
  description: string | null;
}

/** Items that cite a document (ids), and notes about it. */
export interface Citations {
  chronology: number[];
  evidence: number[];
  paragraphs: number[];
  notes: number[];
}

export interface SearchHit {
  doc_id: string;
  line: number;
  snippet: string;
}

/**
 * What Claude read through casefile, as the CLI logs it (ADR 16). Read commands put these in the
 * log row's detail:
 *  - `cli:docs_show`: `{doc, lines}` (lines actually returned; "" when none were)
 *  - `cli:search`: `{query, total, hits: LoggedHit[]}` (at most `MAX_LOGGED_HITS`)
 *  - `cli:chrono_list`, `cli:issue_show`, `cli:draft_show`, `cli:para_list`, `cli:para_show`:
 *    `{..., cited: LoggedLines[]}` (the lines the items shown cite)
 */
export interface LoggedLines {
  doc: string;
  /** "3" or "3-7". */
  lines: string;
}
export interface LoggedHit {
  doc: string;
  line: number;
}
export const MAX_LOGGED_HITS = 200;

/** One read of a document's lines through casefile, from the log (`PublicStore.claudeReads`). */
export interface ClaudeRead {
  /** Log row id. */
  id: number;
  ts: string;
  action: string;
  /** "3", "3-7", or "" (a docs show that returned no lines). */
  lines: string;
}

/** A line range as logged: "3" or "3-7". */
export function formatLines(from: number, to: number): string {
  return from === to ? String(from) : `${from}-${to}`;
}

export const SCHEMA_VERSION = 4;

/**
 * Evidence links. Since v3 there is no ON DELETE CASCADE from issues: deleting an issue must not
 * silently take the user's (or verified) evidence with it. `deleteIssue` removes an issue's
 * evidence explicitly; with foreign keys on, deleting an issue that still has evidence fails.
 */
const evidenceTable = (name: string) =>
  `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '', stance TEXT NOT NULL DEFAULT 'supports',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  verified_at TEXT, verified_sig TEXT
);`;
const EVIDENCE_TABLE = evidenceTable("evidence");

const SCHEMA = `
CREATE TABLE case_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entities (role TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  doc_type TEXT, doc_date TEXT, author_role TEXT, source TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'none',
  withheld INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  line_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL,
  meta_by TEXT NOT NULL DEFAULT 'app'
);
CREATE TABLE lines (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, line_no INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (doc_id, line_no));
CREATE VIRTUAL TABLE lines_fts USING fts5(text, content='lines', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN INSERT INTO lines_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER lines_ad AFTER DELETE ON lines BEGIN INSERT INTO lines_fts(lines_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TABLE tags (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, tag TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY (doc_id, tag));
CREATE TABLE chronology (
  id INTEGER PRIMARY KEY,
  event_date TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  verified_at TEXT, verified_sig TEXT
);
CREATE TABLE chronology_sources (
  entry_id INTEGER NOT NULL REFERENCES chronology(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL
);
CREATE TABLE issues (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  verified_at TEXT, verified_sig TEXT
);
${EVIDENCE_TABLE}
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, body TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE paragraphs (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  claude_body TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  adopted_at TEXT, adopted_sig TEXT
);
CREATE TABLE ai_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', chain TEXT, chain_kind TEXT);
`;

/**
 * Schema v4 (the v2 rebuild), applied on top of v3 both when migrating and when creating a new
 * store, so new and migrated stores are the same:
 *  - documents: `withheld_reason` (`origin | not_asked | exposed`); `sensitivity` holds an Origin
 *  - entities: the user's (tokenised) relationship `description`
 *  - notes: `done_at`, `done_by` (Claude's note marked as dealt with)
 *  - chronology, evidence, issues: `removed_at`, `removed_by` (Removed items, restorable)
 *  - paragraph_sources: document lines a draft paragraph is based on
 *  - paragraph_links: chronology entries and evidence links a paragraph relies on
 */
const V4_CHANGES = [
  "ALTER TABLE documents ADD COLUMN withheld_reason TEXT",
  // Every document withheld before v4 was withheld because of where it came from.
  "UPDATE documents SET withheld_reason = 'origin' WHERE withheld = 1",
  `UPDATE documents SET sensitivity = CASE sensitivity ${
    Object.entries(LEGACY_SENSITIVITY_MAP).map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
      .join(" ")
  } ELSE sensitivity END`,
  "ALTER TABLE entities ADD COLUMN description TEXT",
  "ALTER TABLE notes ADD COLUMN done_at TEXT",
  "ALTER TABLE notes ADD COLUMN done_by TEXT",
  ...["chronology", "evidence", "issues"].flatMap((t) => [
    `ALTER TABLE ${t} ADD COLUMN removed_at TEXT`,
    `ALTER TABLE ${t} ADD COLUMN removed_by TEXT`,
  ]),
  `CREATE TABLE paragraph_sources (
  paragraph_id INTEGER NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL
)`,
  `CREATE TABLE paragraph_links (
  paragraph_id INTEGER NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('chronology', 'evidence')),
  target_id INTEGER NOT NULL,
  PRIMARY KEY (paragraph_id, target_type, target_id)
)`,
];

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Not found: ${what}`);
    this.name = "NotFoundError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

const now = () => new Date().toISOString();
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** Parse a citation like "D003:12-15" or "D003:12". */
export function parseSourceRef(s: string): SourceRef {
  const m = /^([A-Z]\d{3,}):(\d+)(?:-(\d+))?$/.exec(s.trim());
  if (!m) {
    throw new InvalidInputError(
      `Bad source reference ${JSON.stringify(s)}; expected e.g. D003:12-15`,
    );
  }
  const line_start = Number(m[2]);
  const line_end = m[3] ? Number(m[3]) : line_start;
  if (line_start < 1 || line_end < line_start) {
    throw new InvalidInputError(`Bad line range in ${s}`);
  }
  return { doc_id: m[1], line_start, line_end };
}

export function formatSourceRef(r: SourceRef): string {
  return r.line_start === r.line_end
    ? `${r.doc_id}:${r.line_start}`
    : `${r.doc_id}:${r.line_start}-${r.line_end}`;
}

/** A draft paragraph that uses an item (`PublicStore.usedIn`). */
export interface UsedIn {
  draft_id: number;
  paragraph_id: number;
  /** Tokenised draft title. */
  draftTitle: string;
  /** The paragraph's number in its draft (1-based, as the draft shows it: ¶N). */
  n: number;
}

/** Whether two citations share a line of the same document. */
export function sourcesOverlap(a: SourceRef, b: SourceRef): boolean {
  return a.doc_id === b.doc_id && a.line_start <= b.line_end && b.line_start <= a.line_end;
}

/**
 * The public.db file at this path is no longer the one this store opened: the case folder was
 * deleted and made again (e.g. `seed --force`, or a new case made over it) or moved while it was
 * open. The store stops reading and writing: its connection still points at the old, deleted
 * file, so writes would vanish and reads would show the old case (ADR 4, amended).
 */
export class StoreReplacedError extends Error {
  constructor(path: string) {
    super(`The case's public.db was replaced or moved while it was open: ${path}`);
    this.name = "StoreReplacedError";
  }
}

/** Device and inode of the file at `path`, or null if there is none. */
function fileIdSync(path: string): string | null {
  try {
    const st = Deno.statSync(path);
    return st.ino === null || st.dev === null ? path : `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

export class PublicStore {
  readonly db: DatabaseSync;
  /** The database file's identity when opened (null for `:memory:`). */
  readonly #fileId: string | null;
  #replaced = false;

  private constructor(db: DatabaseSync, readonly path: string) {
    this.db = db;
    this.#fileId = path === ":memory:" ? null : fileIdSync(path);
    if (this.#fileId === null) return;
    // Every statement is prepared or executed through these two, so checking here covers every
    // read, write and checkpoint. An open file's inode can't be reused, so a matching device and
    // inode mean it is still the file this connection has open.
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    const guarded = db as unknown as {
      exec: typeof db.exec;
      prepare: typeof db.prepare;
    };
    guarded.exec = (sql: string) => {
      this.#check();
      return exec(sql);
    };
    guarded.prepare = ((sql: string, ...rest: unknown[]) => {
      this.#check();
      return (prepare as (s: string, ...r: unknown[]) => ReturnType<typeof db.prepare>)(
        sql,
        ...rest,
      );
    }) as typeof db.prepare;
  }

  #check() {
    if (this.#replaced) throw new StoreReplacedError(this.path);
    if (fileIdSync(this.path) !== this.#fileId) {
      this.#replaced = true;
      throw new StoreReplacedError(this.path);
    }
  }

  /** True once the file at this store's path is not the one it opened (then it refuses all use). */
  replaced(): boolean {
    if (this.#fileId === null) return false;
    try {
      this.#check();
      return false;
    } catch {
      return true;
    }
  }

  static open(path: string, opts: { create?: boolean } = {}): PublicStore {
    if (!opts.create && path !== ":memory:") {
      try {
        Deno.statSync(path);
      } catch {
        throw new NotFoundError(`public store at ${path}`);
      }
    }
    const db = new DatabaseSync(path);
    // secure_delete overwrites freed pages, so withdrawn text does not linger in the file.
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;",
    );
    const store = new PublicStore(db, path);
    store.#migrate();
    return store;
  }

  /**
   * Close the connection. Safe after the file was replaced: SQLite checks, before the checkpoint
   * and WAL clean-up it does when the last connection closes, that the path still names the file
   * it has open (SQLITE_FCNTL_HAS_MOVED), and skips both if not, so it never deletes or rewrites
   * the `-wal`/`-shm` of the database now at that path (tests/caselock_test.ts).
   */
  close() {
    this.db.close();
  }

  #migrate() {
    const version = () =>
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const v = version();
    if (v > SCHEMA_VERSION) {
      throw new Error(
        `public.db schema v${v} is newer than this build supports (v${SCHEMA_VERSION})`,
      );
    }
    if (v === 0) {
      this.db.exec("BEGIN");
      this.db.exec(SCHEMA);
      for (const sql of V4_CHANGES) this.db.exec(sql);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
      return;
    }
    if (v < 2) {
      // v2: the AI-use log's hash chain (ADR 8).
      this.db.exec("BEGIN");
      this.db.exec("ALTER TABLE ai_log ADD COLUMN chain TEXT");
      this.db.exec("ALTER TABLE ai_log ADD COLUMN chain_kind TEXT");
      this.db.exec("PRAGMA user_version = 2");
      this.db.exec("COMMIT");
    }
    if (v < 3) this.#migrateV3();
    if (v < 4) this.#migrateV4();
  }

  /** v4: see V4_CHANGES. One transaction, taken with the write lock like v3. */
  #migrateV4() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have migrated while we waited for the lock.
      const v = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (v < 4) {
        for (const sql of V4_CHANGES) this.db.exec(sql);
        this.db.exec("PRAGMA user_version = 4");
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * v3: rebuild `evidence` without ON DELETE CASCADE (ADR 8, design review), using SQLite's
   * table-rebuild procedure (https://www.sqlite.org/lang_altertable.html#otheralter): foreign keys
   * off, then in one transaction create the new table, copy every row (ids included), drop the
   * old table and rename the new one. `evidence` has no indexes, triggers or views to recreate.
   */
  #migrateV3() {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Another process may have migrated while we waited for the lock.
        const v = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        if (v < 3) {
          this.db.exec(evidenceTable("evidence_v3"));
          this.db.exec(
            `INSERT INTO evidence_v3(id, issue_id, doc_id, line_start, line_end, note, stance, created_by, created_at, verified_at, verified_sig)
             SELECT id, issue_id, doc_id, line_start, line_end, note, stance, created_by, created_at, verified_at, verified_sig FROM evidence`,
          );
          this.db.exec("DROP TABLE evidence");
          this.db.exec("ALTER TABLE evidence_v3 RENAME TO evidence");
          this.db.exec("PRAGMA user_version = 3");
        }
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  #depth = 0;

  /** Run `fn` in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return fn();
      } finally {
        this.#depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      this.#flushChained();
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      // The rows it chained are gone, so the vault must not record them as the log's head.
      this.#chainedHead = undefined;
      throw e;
    } finally {
      this.#depth = 0;
    }
  }

  /** The last entry chained in the open transaction, reported once it commits. */
  #chainedHead?: { id: number; chain: string };

  #flushChained() {
    const head = this.#chainedHead;
    this.#chainedHead = undefined;
    if (!head) return;
    this.#expected = head;
    this.#chainer?.onChained?.(head.id, head.chain);
  }

  #all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  #get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  #run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // ── case info ────────────────────────────────────────────────────────────

  getInfo(key: string): string | undefined {
    return this.#get<{ value: string }>("SELECT value FROM case_info WHERE key = ?", key)?.value;
  }

  setInfo(key: string, value: string) {
    this.#run(
      "INSERT INTO case_info(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  // ── entities (roles and kinds only — never values) ───────────────────────

  /** Replace every entity. `description` is tokenised text (the user's, checked by the app). */
  setEntities(entities: { role: string; kind: EntityKind; description?: string | null }[]) {
    this.tx(() => {
      this.#run("DELETE FROM entities");
      for (const e of entities) {
        this.#run(
          "INSERT INTO entities(role, kind, description) VALUES (?, ?, ?)",
          e.role,
          e.kind,
          e.description ?? null,
        );
      }
    });
  }

  listEntities(): PublicEntity[] {
    return this.#all("SELECT role, kind, description FROM entities ORDER BY kind, role");
  }

  knownRoles(): Set<string> {
    return new Set(this.listEntities().map((e) => e.role));
  }

  /** Rewrite a role name everywhere tokenised text is stored (after the user renames an entity). */
  renameRoleInText(oldRole: string, newRole: string) {
    this.replaceRoleTokens(
      oldRole,
      (form) => form === "full" ? `{{${newRole}}}` : `{{${newRole}.${form}}}`,
    );
  }

  /**
   * Replace every token of `role` everywhere tokenised text is stored with what `to` gives for its
   * form (`full`, `first`, `surname`, `title`): another role's token when entries are merged, or
   * the value itself when the user removes an entry (ADR 25).
   */
  replaceRoleTokens(role: string, to: (form: string) => string) {
    const re = new RegExp(`\\{\\{${role}(\\.(?:first|surname|title))?\\}\\}`, "g");
    const swap = (s: string) => s.replace(re, (_m, f) => to(f ? f.slice(1) : "full"));
    const like = `%{{${role}%`;
    this.tx(() => {
      for (
        const d of this.#all<{ id: string; title: string; body: string | null }>(
          "SELECT id, title, body FROM documents WHERE body LIKE ? OR title LIKE ?",
          like,
          like,
        )
      ) {
        this.#run(
          "UPDATE documents SET title = ?, body = ? WHERE id = ?",
          swap(d.title),
          d.body === null ? null : swap(d.body),
          d.id,
        );
      }
      for (
        const l of this.#all<{ rowid: number; text: string }>(
          "SELECT rowid, text FROM lines WHERE text LIKE ?",
          like,
        )
      ) {
        // FTS is external-content: delete then re-insert the row so the index stays in step.
        const row = this.#get<{ doc_id: string; line_no: number }>(
          "SELECT doc_id, line_no FROM lines WHERE rowid = ?",
          l.rowid,
        )!;
        this.#run("DELETE FROM lines WHERE rowid = ?", l.rowid);
        this.#run(
          "INSERT INTO lines(doc_id, line_no, text) VALUES (?, ?, ?)",
          row.doc_id,
          row.line_no,
          swap(l.text),
        );
      }
      const tables: [string, string[]][] = [
        ["chronology", ["description"]],
        ["issues", ["title", "description"]],
        ["evidence", ["note"]],
        ["notes", ["body"]],
        ["drafts", ["title"]],
        ["paragraphs", ["body", "claude_body"]],
      ];
      for (const [table, cols] of tables) {
        for (const col of cols) {
          for (
            const r of this.#all<{ id: number; v: string }>(
              `SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE ?`,
              like,
            )
          ) {
            this.#run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, swap(r.v), r.id);
          }
        }
      }
    });
  }

  // ── documents ────────────────────────────────────────────────────────────

  /** Insert or replace a published document. `body: null` publishes it as withheld (ADR 0007). */
  publishDocument(doc: {
    id: string;
    title: string;
    body: string | null;
    /** The document's origin (stored in the `sensitivity` column). */
    sensitivity: Origin;
    /** Why the text is withheld; ignored (stored as null) when `body` is not null. */
    withheld_reason?: WithheldReason | null;
    doc_type?: string | null;
    doc_date?: string | null;
    author_role?: string | null;
    source?: string | null;
  }) {
    const withdrew = this.tx(() => {
      let existing = this.#get<DocumentRow>("SELECT * FROM documents WHERE id = ?", doc.id);
      // Being withheld (ADR 7): details and tags may describe the text (a type, an author,
      // "violence"), so they go with it. This happens on every withheld publish, not only when the
      // row was visible before: public.db's `withheld` flag is Claude-writable, so it cannot be
      // trusted to say whether details were set while the text was visible.
      if (existing && doc.body === null) {
        this.#run("DELETE FROM tags WHERE doc_id = ?", doc.id);
        existing = {
          ...existing,
          doc_type: null,
          doc_date: null,
          author_role: null,
          source: null,
          meta_by: "app",
        };
        this.#run(
          "UPDATE documents SET doc_type = NULL, doc_date = NULL, author_role = NULL, source = NULL, meta_by = 'app' WHERE id = ?",
          doc.id,
        );
      }
      this.#run("DELETE FROM lines WHERE doc_id = ?", doc.id);
      const lines = doc.body === null ? [] : doc.body.split("\n");
      this.#run(
        `INSERT INTO documents(id, title, doc_type, doc_date, author_role, source, sensitivity, withheld, withheld_reason, body, line_count, published_at, meta_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, sensitivity = excluded.sensitivity, withheld = excluded.withheld,
           withheld_reason = excluded.withheld_reason,
           body = excluded.body, line_count = excluded.line_count, published_at = excluded.published_at,
           doc_type = excluded.doc_type, doc_date = excluded.doc_date, author_role = excluded.author_role, source = excluded.source`,
        doc.id,
        doc.title,
        doc.doc_type ?? existing?.doc_type ?? null,
        doc.doc_date ?? existing?.doc_date ?? null,
        doc.author_role ?? existing?.author_role ?? null,
        doc.source ?? existing?.source ?? null,
        doc.sensitivity,
        doc.body === null ? 1 : 0,
        doc.body === null ? (doc.withheld_reason ?? null) : null,
        doc.body,
        lines.length,
        now(),
        existing?.meta_by ?? "app",
      );
      const ins = this.db.prepare("INSERT INTO lines(doc_id, line_no, text) VALUES (?, ?, ?)");
      lines.forEach((text, i) => ins.run(doc.id, i + 1, text));
      return existing?.body != null && existing.body !== doc.body;
    });
    if (withdrew) this.#purge();
  }

  unpublishDocument(id: string) {
    this.tx(() => {
      this.#run("DELETE FROM lines WHERE doc_id = ?", id);
      this.#run("DELETE FROM documents WHERE id = ?", id);
    });
    this.#purge();
  }

  /**
   * After text is withdrawn, make sure no copy of it lingers: merge the FTS index (old segments
   * still hold its terms), and checkpoint the WAL (it holds old page images). secure_delete has
   * already zeroed freed pages in the main file.
   */
  #purge() {
    this.db.exec("INSERT INTO lines_fts(lines_fts) VALUES('optimize')");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  listDocuments(filter: { tag?: string; type?: string } = {}): Omit<DocumentRow, "body">[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.tag) {
      where.push("id IN (SELECT doc_id FROM tags WHERE tag = ?)");
      params.push(filter.tag.trim().toLowerCase());
    }
    if (filter.type) {
      where.push("doc_type = ?");
      params.push(filter.type);
    }
    return this.#all(
      `SELECT id, title, doc_type, doc_date, author_role, source, sensitivity, withheld, withheld_reason, line_count, published_at, meta_by
       FROM documents ${
        where.length ? "WHERE " + where.join(" AND ") : ""
      } ORDER BY COALESCE(doc_date, '9999'), id`,
      ...params,
    );
  }

  getDocument(id: string): DocumentRow {
    const d = this.#get<DocumentRow>("SELECT * FROM documents WHERE id = ?", id);
    if (!d) throw new NotFoundError(`document ${id}`);
    return d;
  }

  hasDocument(id: string): boolean {
    return this.#get("SELECT 1 FROM documents WHERE id = ?", id) !== undefined;
  }

  getLines(
    id: string,
    from = 1,
    to = Number.MAX_SAFE_INTEGER,
  ): { line_no: number; text: string }[] {
    const doc = this.getDocument(id);
    if (doc.withheld) return [];
    return this.#all(
      "SELECT line_no, text FROM lines WHERE doc_id = ? AND line_no BETWEEN ? AND ? ORDER BY line_no",
      id,
      from,
      to,
    );
  }

  /** Every stored line of a document, withheld or not (for checking public.db against the vault). */
  rawLines(id: string): { line_no: number; text: string }[] {
    return this.#all(
      "SELECT line_no, text FROM lines WHERE doc_id = ? ORDER BY line_no",
      id,
    );
  }

  /** Whether the full-text index matches the `lines` table (FTS5 integrity-check). */
  searchIndexOk(): boolean {
    try {
      this.db.exec("INSERT INTO lines_fts(lines_fts, rank) VALUES('integrity-check', 1)");
      return true;
    } catch {
      return false;
    }
  }

  rebuildSearchIndex() {
    this.db.exec("INSERT INTO lines_fts(lines_fts) VALUES('rebuild')");
    this.#purge();
  }

  setDocumentMeta(
    id: string,
    meta: {
      title?: string;
      doc_type?: string | null;
      doc_date?: string | null;
      author_role?: string | null;
      source?: string | null;
    },
    by: Actor,
  ) {
    this.getDocument(id);
    if (meta.doc_date && !DATE_RE.test(meta.doc_date)) {
      throw new InvalidInputError(
        `Bad date ${JSON.stringify(meta.doc_date)}; use YYYY, YYYY-MM or YYYY-MM-DD`,
      );
    }
    if (meta.title !== undefined && !meta.title.trim()) {
      throw new InvalidInputError("Title is empty");
    }
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const k of ["title", "doc_type", "doc_date", "author_role", "source"] as const) {
      if (meta[k] !== undefined) {
        sets.push(`${k} = ?`);
        params.push(meta[k] ?? null);
      }
    }
    if (!sets.length) return;
    sets.push("meta_by = ?");
    params.push(by);
    this.#run(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  }

  /** Throws if the reference does not point at real, visible lines. */
  checkSourceRef(r: SourceRef) {
    const d = this.#get<DocumentRow>(
      "SELECT id, sensitivity, withheld, withheld_reason, line_count FROM documents WHERE id = ?",
      r.doc_id,
    );
    if (!d) throw new InvalidInputError(`No such document: ${r.doc_id}`);
    if (d.withheld) {
      throw new InvalidInputError(
        `Document ${r.doc_id} is withheld from Claude because ${
          withheldBecause(d)
        }, so it cannot be cited`,
      );
    }
    if (r.line_end > d.line_count) {
      throw new InvalidInputError(
        `${formatSourceRef(r)} is out of range; ${r.doc_id} has ${d.line_count} lines`,
      );
    }
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    // Treat the query as plain words (each quoted), so FTS syntax in input can't error.
    const fts = q.split(/\s+/).map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
    return this.#all<SearchHit>(
      `SELECT l.doc_id AS doc_id, l.line_no AS line, snippet(lines_fts, 0, '[', ']', '…', 16) AS snippet
       FROM lines_fts JOIN lines l ON l.rowid = lines_fts.rowid
       JOIN documents d ON d.id = l.doc_id AND d.withheld = 0
       WHERE lines_fts MATCH ? ORDER BY rank LIMIT ?`,
      fts,
      limit,
    );
  }

  // ── tags & notes ─────────────────────────────────────────────────────────

  addTag(docId: string, tag: string, by: Actor) {
    this.getDocument(docId);
    const t = tag.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9 _-]{0,40}$/.test(t)) {
      throw new InvalidInputError(`Bad tag ${JSON.stringify(tag)}`);
    }
    this.#run("INSERT OR IGNORE INTO tags(doc_id, tag, created_by) VALUES (?, ?, ?)", docId, t, by);
  }

  removeTag(docId: string, tag: string) {
    this.#run("DELETE FROM tags WHERE doc_id = ? AND tag = ?", docId, tag.trim().toLowerCase());
  }

  tagCreatedBy(docId: string, tag: string): Actor | undefined {
    return this.#get<{ created_by: Actor }>(
      "SELECT created_by FROM tags WHERE doc_id = ? AND tag = ?",
      docId,
      tag.trim().toLowerCase(),
    )?.created_by;
  }

  tagsFor(docId: string): string[] {
    return this.#all<{ tag: string }>("SELECT tag FROM tags WHERE doc_id = ? ORDER BY tag", docId)
      .map((r) => r.tag);
  }

  allTags(): { tag: string; count: number }[] {
    return this.#all("SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY tag");
  }

  addNote(target_type: string, target_id: string, body: string, by: Actor): number {
    if (!body.trim()) throw new InvalidInputError("Note is empty");
    return Number(
      this.#run(
        "INSERT INTO notes(target_type, target_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        target_type,
        target_id,
        body,
        by,
        now(),
      ).lastInsertRowid,
    );
  }

  listNotes(target_type?: string, target_id?: string): NoteRow[] {
    if (target_type && target_id) {
      return this.#all(
        "SELECT * FROM notes WHERE target_type = ? AND target_id = ? ORDER BY id",
        target_type,
        target_id,
      );
    }
    return this.#all("SELECT * FROM notes ORDER BY id");
  }

  getNote(id: number): NoteRow {
    const row = this.#get<NoteRow>("SELECT * FROM notes WHERE id = ?", id);
    if (!row) throw new NotFoundError(`note ${id}`);
    return row;
  }

  deleteNote(id: number) {
    this.#run("DELETE FROM notes WHERE id = ?", id);
  }

  /** Mark a note as dealt with (`done = false` clears it). */
  markNoteDone(id: number, by: Actor, done = true) {
    this.getNote(id);
    this.#run(
      "UPDATE notes SET done_at = ?, done_by = ? WHERE id = ?",
      done ? now() : null,
      done ? by : null,
      id,
    );
  }

  // ── chronology ───────────────────────────────────────────────────────────

  addChronology(
    e: { event_date: string; description: string; sources: SourceRef[] },
    by: Actor,
  ): number {
    if (!e.description.trim()) throw new InvalidInputError("Description is empty");
    if (!DATE_RE.test(e.event_date)) {
      throw new InvalidInputError(
        `Bad date ${JSON.stringify(e.event_date)}; use YYYY, YYYY-MM or YYYY-MM-DD`,
      );
    }
    if (by === "claude" && e.sources.length === 0) {
      throw new InvalidInputError(
        "Chronology entries written by Claude must cite at least one source (e.g. D003:12-15)",
      );
    }
    for (const s of e.sources) this.checkSourceRef(s);
    return this.tx(() => {
      const t = now();
      const id = Number(
        this.#run(
          "INSERT INTO chronology(event_date, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          e.event_date,
          e.description,
          by,
          t,
          t,
        ).lastInsertRowid,
      );
      this.#insertSources(id, e.sources);
      return id;
    });
  }

  #insertSources(id: number, sources: SourceRef[]) {
    for (const s of sources) {
      this.#run(
        "INSERT INTO chronology_sources(entry_id, doc_id, line_start, line_end) VALUES (?, ?, ?, ?)",
        id,
        s.doc_id,
        s.line_start,
        s.line_end,
      );
    }
  }

  updateChronology(
    id: number,
    patch: { event_date?: string; description?: string; sources?: SourceRef[] },
  ) {
    const cur = this.getChronology(id);
    const event_date = patch.event_date ?? cur.event_date;
    if (!DATE_RE.test(event_date)) throw new InvalidInputError(`Bad date ${event_date}`);
    if (patch.description !== undefined && !patch.description.trim()) {
      throw new InvalidInputError("Description is empty");
    }
    for (const s of patch.sources ?? []) this.checkSourceRef(s);
    this.tx(() => {
      // Any change invalidates a previous verification.
      this.#run(
        "UPDATE chronology SET event_date = ?, description = ?, updated_at = ?, verified_at = NULL, verified_sig = NULL WHERE id = ?",
        event_date,
        patch.description ?? cur.description,
        now(),
        id,
      );
      if (patch.sources) {
        this.#run("DELETE FROM chronology_sources WHERE entry_id = ?", id);
        this.#insertSources(id, patch.sources);
      }
    });
  }

  deleteChronology(id: number) {
    this.getChronology(id);
    this.tx(() => {
      this.#run(
        "DELETE FROM paragraph_links WHERE target_type = 'chronology' AND target_id = ?",
        id,
      );
      this.#run("DELETE FROM chronology WHERE id = ?", id);
    });
  }

  getChronology(id: number): ChronologyRow {
    const row = this.#get<Omit<ChronologyRow, "sources">>(
      "SELECT * FROM chronology WHERE id = ?",
      id,
    );
    if (!row) throw new NotFoundError(`chronology entry ${id}`);
    return { ...row, sources: this.#sources(id) };
  }

  #sources(entryId: number): SourceRef[] {
    return this.#all(
      "SELECT doc_id, line_start, line_end FROM chronology_sources WHERE entry_id = ? ORDER BY doc_id, line_start, line_end",
      entryId,
    );
  }

  /** Chronology entries in date order; removed entries only with `includeRemoved`. */
  listChronology(
    filter: { from?: string; to?: string; includeRemoved?: boolean } = {},
  ): ChronologyRow[] {
    const rows = this.#all<Omit<ChronologyRow, "sources">>(
      `SELECT * FROM chronology WHERE event_date >= ? AND event_date <= ? ${
        filter.includeRemoved ? "" : "AND removed_at IS NULL"
      } ORDER BY event_date, id`,
      filter.from ?? "0000",
      filter.to ?? "9999-99-99",
    );
    return rows.map((r) => ({ ...r, sources: this.#sources(r.id) }));
  }

  setChronologyVerification(id: number, verified_at: string | null, sig: string | null) {
    this.#run(
      "UPDATE chronology SET verified_at = ?, verified_sig = ? WHERE id = ?",
      verified_at,
      sig,
      id,
    );
  }

  // ── issues & evidence ────────────────────────────────────────────────────

  addIssue(i: { title: string; description?: string }, by: Actor): number {
    if (!i.title.trim()) throw new InvalidInputError("Issue title is empty");
    const t = now();
    return Number(
      this.#run(
        "INSERT INTO issues(title, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        i.title,
        i.description ?? "",
        by,
        t,
        t,
      ).lastInsertRowid,
    );
  }

  updateIssue(id: number, patch: { title?: string; description?: string }) {
    const cur = this.getIssue(id);
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new InvalidInputError("Issue title is empty");
    }
    this.#run(
      "UPDATE issues SET title = ?, description = ?, updated_at = ?, verified_at = NULL, verified_sig = NULL WHERE id = ?",
      patch.title ?? cur.title,
      patch.description ?? cur.description,
      now(),
      id,
    );
  }

  /**
   * Delete an issue and, explicitly, its evidence links (there is no cascade since schema v3).
   * Callers decide whether that is allowed: the CLI refuses when the issue has evidence that is
   * the user's or verified; the app revokes the links' attestations first.
   */
  deleteIssue(id: number) {
    this.getIssue(id);
    this.tx(() => {
      this.#run(
        "DELETE FROM paragraph_links WHERE target_type = 'evidence' AND target_id IN (SELECT id FROM evidence WHERE issue_id = ?)",
        id,
      );
      this.#run("DELETE FROM evidence WHERE issue_id = ?", id);
      this.#run("DELETE FROM issues WHERE id = ?", id);
    });
  }

  getIssue(id: number): IssueRow {
    const row = this.#get<IssueRow>("SELECT * FROM issues WHERE id = ?", id);
    if (!row) throw new NotFoundError(`issue ${id}`);
    return row;
  }

  /** Issues; removed issues only with `includeRemoved`. */
  listIssues(opts: { includeRemoved?: boolean } = {}): IssueRow[] {
    return this.#all(
      `SELECT * FROM issues ${opts.includeRemoved ? "" : "WHERE removed_at IS NULL"} ORDER BY id`,
    );
  }

  setIssueVerification(id: number, verified_at: string | null, sig: string | null) {
    this.#run(
      "UPDATE issues SET verified_at = ?, verified_sig = ? WHERE id = ?",
      verified_at,
      sig,
      id,
    );
  }

  addEvidence(
    issueId: number,
    e: SourceRef & { note?: string; stance?: Stance },
    by: Actor,
  ): number {
    this.getIssue(issueId);
    this.checkSourceRef(e);
    const stance = e.stance ?? "supports";
    if (!STANCES.includes(stance)) {
      throw new InvalidInputError(`Bad stance ${stance}; one of ${STANCES.join(", ")}`);
    }
    return Number(
      this.#run(
        "INSERT INTO evidence(issue_id, doc_id, line_start, line_end, note, stance, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        issueId,
        e.doc_id,
        e.line_start,
        e.line_end,
        e.note ?? "",
        stance,
        by,
        now(),
      ).lastInsertRowid,
    );
  }

  getEvidence(id: number): EvidenceRow {
    const row = this.#get<EvidenceRow>("SELECT * FROM evidence WHERE id = ?", id);
    if (!row) throw new NotFoundError(`evidence ${id}`);
    return row;
  }

  /** An issue's evidence links; removed links only with `includeRemoved`. */
  listEvidence(issueId: number, opts: { includeRemoved?: boolean } = {}): EvidenceRow[] {
    return this.#all(
      `SELECT * FROM evidence WHERE issue_id = ? ${
        opts.includeRemoved ? "" : "AND removed_at IS NULL"
      } ORDER BY doc_id, line_start`,
      issueId,
    );
  }

  deleteEvidence(id: number) {
    this.getEvidence(id);
    this.tx(() => {
      this.#run(
        "DELETE FROM paragraph_links WHERE target_type = 'evidence' AND target_id = ?",
        id,
      );
      this.#run("DELETE FROM evidence WHERE id = ?", id);
    });
  }

  setEvidenceVerification(id: number, verified_at: string | null, sig: string | null) {
    this.#run(
      "UPDATE evidence SET verified_at = ?, verified_sig = ? WHERE id = ?",
      verified_at,
      sig,
      id,
    );
  }

  /**
   * Change an evidence link's note or stance. Clears the verification columns, as every update
   * does; the app withdraws the ledger's check.
   */
  updateEvidence(id: number, patch: { note?: string; stance?: Stance }): void {
    const cur = this.getEvidence(id);
    const stance = patch.stance ?? cur.stance;
    if (!STANCES.includes(stance)) {
      throw new InvalidInputError(`Bad stance ${stance}; one of ${STANCES.join(", ")}`);
    }
    this.#run(
      "UPDATE evidence SET note = ?, stance = ?, verified_at = NULL, verified_sig = NULL WHERE id = ?",
      patch.note ?? cur.note ?? "",
      stance,
      id,
    );
  }

  /**
   * Issues a chronology entry bears on: those with evidence whose lines overlap `refs`. Issues
   * and evidence in `removed` (the user removed them, per the ledger) are left out.
   */
  issuesForSources(
    refs: SourceRef[],
    removed: { issues: Set<number>; evidence: Set<number> },
  ): IssueRow[] {
    if (!refs.length) return [];
    const out: IssueRow[] = [];
    for (const i of this.listIssues({ includeRemoved: true })) {
      if (removed.issues.has(i.id)) continue;
      const ev = this.listEvidence(i.id, { includeRemoved: true }).filter((e) =>
        !removed.evidence.has(e.id)
      );
      if (ev.some((e) => refs.some((r) => sourcesOverlap(e, r)))) out.push(i);
    }
    return out;
  }

  /**
   * Chronology entries (not in `removed`) whose sources overlap lines of an issue's evidence
   * links: the reverse of `issuesForSources`.
   */
  chronologyForEvidence(
    evidence: SourceRef[],
    removed: { chronology: Set<number> },
  ): ChronologyRow[] {
    if (!evidence.length) return [];
    return this.listChronology({ includeRemoved: true }).filter((c) =>
      !removed.chronology.has(c.id) &&
      c.sources.some((r) => evidence.some((e) => sourcesOverlap(e, r)))
    );
  }

  // ── drafts ───────────────────────────────────────────────────────────────

  createDraft(d: { kind: DraftKind; title: string }, by: Actor): number {
    if (!DRAFT_KINDS.includes(d.kind)) {
      throw new InvalidInputError(`Bad draft kind ${d.kind}; one of ${DRAFT_KINDS.join(", ")}`);
    }
    if (!d.title.trim()) throw new InvalidInputError("Draft title is empty");
    const t = now();
    return Number(
      this.#run(
        "INSERT INTO drafts(kind, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        d.kind,
        d.title,
        by,
        t,
        t,
      ).lastInsertRowid,
    );
  }

  getDraft(id: number): DraftRow {
    const row = this.#get<DraftRow>("SELECT * FROM drafts WHERE id = ?", id);
    if (!row) throw new NotFoundError(`draft ${id}`);
    return row;
  }

  listDrafts(): DraftRow[] {
    return this.#all("SELECT * FROM drafts ORDER BY id");
  }

  renameDraft(id: number, title: string) {
    this.getDraft(id);
    if (!title.trim()) throw new InvalidInputError("Draft title is empty");
    this.#run("UPDATE drafts SET title = ?, updated_at = ? WHERE id = ?", title, now(), id);
  }

  deleteDraft(id: number) {
    this.getDraft(id);
    this.#run("DELETE FROM drafts WHERE id = ?", id);
  }

  listParagraphs(draftId: number): ParagraphRow[] {
    return this.#all("SELECT * FROM paragraphs WHERE draft_id = ? ORDER BY position, id", draftId);
  }

  getParagraph(id: number): ParagraphRow {
    const row = this.#get<ParagraphRow>("SELECT * FROM paragraphs WHERE id = ?", id);
    if (!row) throw new NotFoundError(`paragraph ${id}`);
    return row;
  }

  /** Append a paragraph, or insert it after paragraph `after`. */
  addParagraph(draftId: number, body: string, author: "user" | "claude", after?: number): number {
    this.getDraft(draftId);
    if (!body.trim()) throw new InvalidInputError("Paragraph is empty");
    const paras = this.listParagraphs(draftId);
    let position: number;
    if (after === undefined) position = (paras.at(-1)?.position ?? 0) + 1;
    else {
      const idx = paras.findIndex((p) => p.id === after);
      if (idx === -1) throw new InvalidInputError(`Paragraph ${after} is not in draft ${draftId}`);
      const next = paras[idx + 1];
      position = next ? (paras[idx].position + next.position) / 2 : paras[idx].position + 1;
    }
    const t = now();
    return this.tx(() => {
      const id = Number(
        this.#run(
          "INSERT INTO paragraphs(draft_id, position, body, author, claude_body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          draftId,
          position,
          body,
          author,
          author === "claude" ? body : null,
          t,
          t,
        ).lastInsertRowid,
      );
      this.#run("UPDATE drafts SET updated_at = ? WHERE id = ?", t, draftId);
      return id;
    });
  }

  /**
   * Edit a paragraph. Any edit clears a previous adoption. When Claude edits, `claude_body`
   * records Claude's text; when the user edits, the caller decides authorship (ADR 0009) and
   * passes `keepClaudeBody` so a light user edit that leaves the paragraph Claude's does not
   * overwrite Claude's text.
   */
  updateParagraph(
    id: number,
    body: string,
    author: "user" | "claude",
    opts: { keepClaudeBody?: boolean } = {},
  ) {
    const cur = this.getParagraph(id);
    if (!body.trim()) throw new InvalidInputError("Paragraph is empty");
    const t = now();
    this.tx(() => {
      this.#run(
        "UPDATE paragraphs SET body = ?, author = ?, claude_body = ?, updated_at = ?, adopted_at = NULL, adopted_sig = NULL WHERE id = ?",
        body,
        author,
        author === "claude" && !opts.keepClaudeBody ? body : cur.claude_body,
        t,
        id,
      );
      this.#run("UPDATE drafts SET updated_at = ? WHERE id = ?", t, cur.draft_id);
    });
  }

  deleteParagraph(id: number) {
    this.getParagraph(id);
    this.#run("DELETE FROM paragraphs WHERE id = ?", id);
  }

  setParagraphAdoption(id: number, adopted_at: string | null, sig: string | null) {
    this.#run(
      "UPDATE paragraphs SET adopted_at = ?, adopted_sig = ? WHERE id = ?",
      adopted_at,
      sig,
      id,
    );
  }

  /** Replace the document lines paragraph `id` is based on (each must be citable). */
  setParagraphSources(id: number, sources: SourceRef[]) {
    this.getParagraph(id);
    for (const s of sources) this.checkSourceRef(s);
    this.tx(() => {
      this.#run("DELETE FROM paragraph_sources WHERE paragraph_id = ?", id);
      for (const s of sources) {
        this.#run(
          "INSERT INTO paragraph_sources(paragraph_id, doc_id, line_start, line_end) VALUES (?, ?, ?, ?)",
          id,
          s.doc_id,
          s.line_start,
          s.line_end,
        );
      }
    });
  }

  listParagraphSources(id: number): SourceRef[] {
    return this.#all(
      "SELECT doc_id, line_start, line_end FROM paragraph_sources WHERE paragraph_id = ? ORDER BY doc_id, line_start, line_end",
      id,
    );
  }

  /** Replace the chronology entries and evidence links paragraph `id` relies on (each must exist). */
  setParagraphLinks(id: number, links: ParagraphLink[]) {
    this.getParagraph(id);
    for (const l of links) {
      if (l.target_type === "chronology") this.getChronology(l.target_id);
      else if (l.target_type === "evidence") this.getEvidence(l.target_id);
      else throw new InvalidInputError(`Bad link type ${JSON.stringify(l.target_type)}`);
    }
    this.tx(() => {
      this.#run("DELETE FROM paragraph_links WHERE paragraph_id = ?", id);
      for (const l of links) {
        this.#run(
          "INSERT OR IGNORE INTO paragraph_links(paragraph_id, target_type, target_id) VALUES (?, ?, ?)",
          id,
          l.target_type,
          l.target_id,
        );
      }
    });
  }

  /** Paragraphs that rely on a chronology entry or evidence link (ids, ascending). */
  paragraphsRelyingOn(type: ParagraphLinkType, targetId: number): number[] {
    return this.#all<{ id: number }>(
      "SELECT DISTINCT paragraph_id AS id FROM paragraph_links WHERE target_type = ? AND target_id = ? ORDER BY id",
      type,
      targetId,
    ).map((r) => r.id);
  }

  listParagraphLinks(id: number): ParagraphLink[] {
    return this.#all(
      "SELECT target_type, target_id FROM paragraph_links WHERE paragraph_id = ? ORDER BY target_type, target_id",
      id,
    );
  }

  // ── removed items ────────────────────────────────────────────────────────
  //
  // `removed_at` / `removed_by` are in public.db, so Claude can write them. List methods leave
  // removed rows out by default (for display), but nothing that gates an action, and nothing the
  // user must see, may rely on them: pass `includeRemoved: true` there. The app must record the
  // user's removals in the vault before trusting the column (wave 1, package C).

  /** Every id of a removable type, removed or not, in order. */
  removableIds(type: RemovableType): number[] {
    return this.#all<{ id: number }>(`SELECT id FROM ${removableTable(type)} ORDER BY id`)
      .map((r) => r.id);
  }

  /** Remove an item restorably: it leaves the lists but keeps its row (and attestations). */
  softRemove(type: RemovableType, id: number, by: Actor) {
    this.#getRemovable(type, id);
    this.#run(
      `UPDATE ${removableTable(type)} SET removed_at = ?, removed_by = ? WHERE id = ?`,
      now(),
      by,
      id,
    );
  }

  restore(type: RemovableType, id: number) {
    this.#getRemovable(type, id);
    this.#run(
      `UPDATE ${removableTable(type)} SET removed_at = NULL, removed_by = NULL WHERE id = ?`,
      id,
    );
  }

  #getRemovable(type: RemovableType, id: number) {
    removableTable(type);
    if (type === "chronology") return this.getChronology(id);
    if (type === "evidence") return this.getEvidence(id);
    if (type === "issue") return this.getIssue(id);
    throw new InvalidInputError(`Bad item type ${JSON.stringify(type)}`);
  }

  /** Removed items of one type, most recently removed first. */
  listRemoved(type: "chronology"): ChronologyRow[];
  listRemoved(type: "evidence"): EvidenceRow[];
  listRemoved(type: "issue"): IssueRow[];
  listRemoved(type: RemovableType): (ChronologyRow | EvidenceRow | IssueRow)[] {
    const rows = this.#all<{ id: number }>(
      `SELECT * FROM ${
        removableTable(type)
      } WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, id`,
    );
    if (type === "chronology") {
      return rows.map((r) => ({ ...r, sources: this.#sources(r.id) }) as ChronologyRow);
    }
    return rows as unknown as (EvidenceRow | IssueRow)[];
  }

  // ── citations ────────────────────────────────────────────────────────────

  /**
   * What cites document `docId`: chronology entries, evidence links and draft paragraphs (ids),
   * and notes about it. Removed items only with `includeRemoved`.
   */
  citationsOf(docId: string, opts: { includeRemoved?: boolean } = {}): Citations {
    const live = opts.includeRemoved ? "" : "AND removed_at IS NULL";
    const ids = (sql: string) => this.#all<{ id: number }>(sql, docId).map((r) => r.id);
    return {
      chronology: ids(
        `SELECT id FROM chronology WHERE id IN (SELECT entry_id FROM chronology_sources WHERE doc_id = ?) ${live} ORDER BY id`,
      ),
      evidence: ids(`SELECT id FROM evidence WHERE doc_id = ? ${live} ORDER BY id`),
      paragraphs: ids(
        "SELECT DISTINCT paragraph_id AS id FROM paragraph_sources WHERE doc_id = ? ORDER BY id",
      ),
      notes: ids("SELECT id FROM notes WHERE target_type = 'doc' AND target_id = ? ORDER BY id"),
    };
  }

  /**
   * What Claude read of document `docId` through casefile between `from` and `to` (ISO times,
   * inclusive), from the AI-use log (`claudeReads`: docs show ranges, search hits and quoted
   * citations), leaving out a docs show that returned no lines. Reads by other means (a shell)
   * are not in the log and cannot be listed.
   */
  claudeReadsOf(docId: string, from?: string, to?: string): { ts: string; lines: string }[] {
    return this.claudeReads(docId, { from, to }).filter((r) => r.lines !== "").map((r) => ({
      ts: r.ts,
      lines: r.lines,
    }));
  }

  /**
   * Draft paragraphs that use an item: those that link to it (`paragraph_links`) or cite lines
   * that overlap its sources (`paragraph_sources`). Ordered by draft and position.
   */
  usedIn(
    target: { type: ParagraphLinkType; id: number } | null,
    refs: SourceRef[],
  ): UsedIn[] {
    const rows = this.#all<UsedIn & { position: number }>(
      `SELECT p.id AS paragraph_id, p.draft_id, d.title AS draftTitle, p.position,
              (SELECT COUNT(*) FROM paragraphs q WHERE q.draft_id = p.draft_id
                  AND (q.position < p.position OR (q.position = p.position AND q.id <= p.id))) AS n
         FROM paragraphs p JOIN drafts d ON d.id = p.draft_id
        WHERE (? IS NOT NULL AND p.id IN (
                 SELECT paragraph_id FROM paragraph_links WHERE target_type = ? AND target_id = ?))
           OR p.id IN (SELECT paragraph_id FROM paragraph_sources s WHERE ${
        refs.length
          ? refs.map(() => "(s.doc_id = ? AND s.line_start <= ? AND ? <= s.line_end)").join(" OR ")
          : "0"
      })
        ORDER BY p.draft_id, p.position, p.id`,
      target?.type ?? null,
      target?.type ?? null,
      target?.id ?? null,
      ...refs.flatMap((r) => [r.doc_id, r.line_end, r.line_start]),
    );
    return rows.map((r) => ({
      draft_id: r.draft_id,
      paragraph_id: r.paragraph_id,
      draftTitle: r.draftTitle,
      n: Number(r.n),
    }));
  }

  /**
   * For each document, how many items cite it: chronology entries, evidence links and draft
   * paragraphs, each counted once (removed items are not counted). Uncited documents are absent.
   */
  citationCounts(): Record<string, number> {
    const rows = this.#all<{ doc_id: string; n: number }>(
      `SELECT doc_id, COUNT(*) AS n FROM (
         SELECT DISTINCT cs.doc_id, 'c' AS t, cs.entry_id AS id FROM chronology_sources cs
           JOIN chronology c ON c.id = cs.entry_id WHERE c.removed_at IS NULL
         UNION ALL
         SELECT doc_id, 'e', id FROM evidence WHERE removed_at IS NULL
         UNION ALL
         SELECT DISTINCT doc_id, 'p', paragraph_id FROM paragraph_sources
       ) GROUP BY doc_id ORDER BY doc_id`,
    );
    return Object.fromEntries(rows.map((r) => [r.doc_id, r.n]));
  }

  // ── AI-use log ───────────────────────────────────────────────────────────

  // The AI-use log is hash-chained by the app (ADR 8). Each chained row carries
  // MAC(previous chain ‖ row), keyed from the vault, so the CLI (no key) can append rows but
  // nothing can alter or delete a chained row without breaking the chain. The app countersigns
  // CLI rows into the chain on its next write.

  #chainer?: {
    mac: (data: string) => string;
    onChained?: (id: number, chain: string) => void;
    onTailChanged?: (expected: { id: number; chain: string }) => void;
  };
  /**
   * The last chained entry this app knows of (the vault's head, then each entry it seals). Before
   * sealing anything the log must still lead on from it, or the change is reported first: sealing
   * over a cut or altered tail would otherwise make it look untouched.
   */
  #expected?: { id: number; chain: string };

  static #chainInput(prev: string, r: Omit<LogRow, "chain">): string {
    return `${prev}\n${JSON.stringify([r.id, r.ts, r.actor, r.action, r.detail, r.chain_kind])}`;
  }

  /**
   * Turn on the hash chain (app only). Unchained rows after the last chained one are
   * countersigned now, as `legacyKind` (first use, rows from before chaining) or "countersigned".
   */
  enableLogChain(
    mac: (data: string) => string,
    opts: {
      legacy?: boolean;
      onChained?: (id: number, chain: string) => void;
      /** The vault's record of the last chained entry, if it has one. */
      expected?: { id: number; chain: string };
      /** Called (inside the transaction, before anything is sealed) if the log no longer leads on from `expected`. */
      onTailChanged?: (expected: { id: number; chain: string }) => void;
    } = {},
  ) {
    this.#chainer = { mac, onChained: opts.onChained, onTailChanged: opts.onTailChanged };
    this.#expected = opts.expected;
    this.tx(() => this.#countersign(opts.legacy ? "legacy" : "countersigned"));
  }

  /**
   * Whether the log still leads on from `exp`: that entry is there with the same seal, and every
   * sealed entry after it chains from it (as another app session with the key may have written).
   */
  #leadsOnFrom(exp: { id: number; chain: string }): boolean {
    const mac = this.#chainer!.mac;
    const at = this.#get<LogRow>("SELECT * FROM ai_log WHERE id = ?", exp.id);
    if (!at || at.chain !== exp.chain) return false;
    let prev = exp.chain;
    let gap = false;
    for (const r of this.#all<LogRow>("SELECT * FROM ai_log WHERE id > ? ORDER BY id", exp.id)) {
      if (r.chain === null) {
        gap = true;
        continue;
      }
      if (gap || mac(PublicStore.#chainInput(prev, r)) !== r.chain) return false;
      prev = r.chain;
    }
    return true;
  }

  #countersign(kind: string) {
    const c = this.#chainer!;
    const exp = this.#expected;
    if (exp && !this.#leadsOnFrom(exp)) {
      c.onTailChanged?.(exp);
      // Reported once; from here on the log is followed from what is actually there.
      this.#expected = undefined;
    }
    const last = this.#get<{ id: number; chain: string }>(
      "SELECT id, chain FROM ai_log WHERE chain IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    let prev = last?.chain ?? "";
    let lastId = last?.id;
    for (
      const r of this.#all<LogRow>(
        "SELECT * FROM ai_log WHERE chain IS NULL AND id > ? ORDER BY id",
        last?.id ?? 0,
      )
    ) {
      const chain = c.mac(PublicStore.#chainInput(prev, { ...r, chain_kind: kind }));
      this.#run("UPDATE ai_log SET chain = ?, chain_kind = ? WHERE id = ?", chain, kind, r.id);
      prev = chain;
      lastId = r.id;
    }
    // Reported after the transaction commits (`tx`): a head recorded for rows that were then
    // rolled back would make the log look truncated.
    if (lastId !== undefined && prev) this.#chainedHead = { id: lastId, chain: prev };
  }

  log(actor: Actor, action: string, detail: Record<string, unknown> = {}) {
    const insert = () =>
      Number(
        this.#run(
          "INSERT INTO ai_log(ts, actor, action, detail) VALUES (?, ?, ?, ?)",
          now(),
          actor,
          action,
          JSON.stringify(detail),
        ).lastInsertRowid,
      );
    if (!this.#chainer) {
      insert();
      return;
    }
    this.tx(() => {
      this.#countersign("countersigned");
      insert();
      this.#countersign("signed");
    });
  }

  /**
   * Check the hash chain. `head` is the last chained entry the vault recorded, which catches
   * deleting entries from the end.
   */
  verifyLogChain(mac: (data: string) => string, head?: { id: number; chain: string }): LogCheck {
    const rows = this.#all<LogRow>("SELECT * FROM ai_log ORDER BY id");
    const out: LogCheck = { intact: true, checked: 0, pending: 0, forged: [] };
    const fail = (id: number, problem: string) => {
      if (out.intact) Object.assign(out, { intact: false, brokenAt: id, problem });
    };
    let prev = "";
    let unchained: number | undefined;
    for (const r of rows) {
      if (r.chain === null) {
        unchained ??= r.id;
        out.pending++;
        continue;
      }
      if (unchained !== undefined) {
        fail(unchained, `entry ${unchained} was added or altered after it was recorded`);
      }
      if (mac(PublicStore.#chainInput(prev, r)) !== r.chain) {
        fail(r.id, `entry ${r.id} was altered, or an entry before it was deleted`);
      }
      if (r.chain_kind === "countersigned" && r.actor !== "claude") out.forged.push(r.id);
      prev = r.chain;
      out.checked++;
    }
    if (head) {
      const row = rows.find((r) => r.id === head.id);
      if (!row || row.chain !== head.chain) {
        fail(head.id, `entries up to ${head.id} were deleted or altered`);
      }
    }
    if (out.forged.length) {
      fail(
        out.forged[0],
        `entry ${out.forged[0]} claims to be the app's but was not written by it`,
      );
    }
    return out;
  }

  /**
   * Log rows whose detail names document `docId`, oldest first: `detail.doc`, a search hit or
   * cited range in it (`detail.hits[].doc`, `detail.cited[].doc`; ADR 16), a source reference to
   * its lines (`detail.sources[]` of `cli:chrono_add` / `cli:chrono_edit`, `detail.source` of
   * `cli:evidence_add`, as `D001:3-5`), or a note on it (`detail.on` = `doc:D001`).
   */
  logForDoc(docId: string): LogRow[] {
    return this.#all(
      `SELECT * FROM ai_log
       WHERE CASE WHEN json_valid(detail) THEN (
         json_extract(detail, '$.doc') IS ?1
         OR (CASE WHEN json_type(detail, '$.hits') = 'array' THEN EXISTS (
               SELECT 1 FROM json_each(detail, '$.hits') h
               WHERE h.type = 'object' AND json_extract(h.value, '$.doc') IS ?1) ELSE 0 END)
         OR (CASE WHEN json_type(detail, '$.cited') = 'array' THEN EXISTS (
               SELECT 1 FROM json_each(detail, '$.cited') c
               WHERE c.type = 'object' AND json_extract(c.value, '$.doc') IS ?1) ELSE 0 END)
         OR (CASE WHEN json_type(detail, '$.sources') = 'array' THEN EXISTS (
               SELECT 1 FROM json_each(detail, '$.sources') s
               WHERE s.type = 'text' AND substr(s.value, 1, length(?1) + 1) = ?1 || ':')
             ELSE 0 END)
         OR (CASE WHEN json_type(detail, '$.source') = 'text'
             THEN substr(json_extract(detail, '$.source'), 1, length(?1) + 1) = ?1 || ':'
             ELSE 0 END)
         OR (CASE WHEN json_type(detail, '$.on') = 'text'
             THEN json_extract(detail, '$.on') = 'doc:' || ?1 ELSE 0 END)
       ) ELSE 0 END
       ORDER BY id`,
      docId,
    );
  }

  /**
   * What Claude read of document `docId` through the CLI (ADR 16), oldest first, optionally only
   * between `from` and `to` (ISO timestamps, inclusive): each `docs show` of it, each search hit
   * in it and each cited range of it shown by a list. One entry per range read. Reads by shell
   * commands are not in the log, so this is only what Claude read *through casefile*.
   */
  claudeReads(docId: string, window: { from?: string; to?: string } = {}): ClaudeRead[] {
    const out: ClaudeRead[] = [];
    for (const r of this.logForDoc(docId)) {
      if (r.actor !== "claude") continue;
      if (window.from && r.ts < window.from) continue;
      if (window.to && r.ts > window.to) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(r.detail);
      } catch {
        continue;
      }
      const add = (lines: string) => out.push({ id: r.id, ts: r.ts, action: r.action, lines });
      if (d.doc === docId) add(typeof d.lines === "string" ? d.lines : "");
      for (const key of ["hits", "cited"] as const) {
        const list = d[key];
        if (!Array.isArray(list)) continue;
        for (const x of list) {
          if (!x || typeof x !== "object" || (x as { doc?: unknown }).doc !== docId) continue;
          const { line, lines } = x as { line?: unknown; lines?: unknown };
          if (typeof lines === "string") add(lines);
          else if (typeof line === "number") add(String(line));
        }
      }
    }
    return out;
  }

  listLog(limit = 200, actor?: Actor): LogRow[] {
    if (actor) {
      return this.#all(
        "SELECT * FROM ai_log WHERE actor = ? ORDER BY id DESC LIMIT ?",
        actor,
        limit,
      );
    }
    return this.#all("SELECT * FROM ai_log ORDER BY id DESC LIMIT ?", limit);
  }

  /**
   * Counts. `excludeRemoved` leaves out removed items (for Claude's view only: `removed_at` is
   * Claude-writable, so counts the user relies on must include them).
   */
  stats(opts: { excludeRemoved?: boolean } = {}) {
    const count = (sql: string) => this.#get<{ n: number }>(sql)?.n ?? 0;
    const live = opts.excludeRemoved ? "removed_at IS NULL" : "1";
    return {
      documents: count("SELECT COUNT(*) AS n FROM documents"),
      withheld: count("SELECT COUNT(*) AS n FROM documents WHERE withheld = 1"),
      entities: count("SELECT COUNT(*) AS n FROM entities"),
      chronology: count(`SELECT COUNT(*) AS n FROM chronology WHERE ${live}`),
      chronology_unverified: count(
        `SELECT COUNT(*) AS n FROM chronology WHERE verified_at IS NULL AND ${live}`,
      ),
      issues: count(`SELECT COUNT(*) AS n FROM issues WHERE ${live}`),
      evidence: count(`SELECT COUNT(*) AS n FROM evidence WHERE ${live}`),
      drafts: count("SELECT COUNT(*) AS n FROM drafts"),
      notes: count("SELECT COUNT(*) AS n FROM notes"),
    };
  }
}
