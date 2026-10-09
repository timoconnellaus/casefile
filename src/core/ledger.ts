import {
  type Actor,
  type ChronologyRow,
  type DraftKind,
  type DraftRow,
  type EvidenceRow,
  formatSourceRef,
  InvalidInputError,
  type IssueRow,
  type NoteRow,
  NotFoundError,
  type ParagraphRow,
  type PublicStore,
  type RemovableType,
  type SourceRef,
} from "./publicdb.ts";
import type { CaseSettings } from "./session.ts";
import { canonicalJson, type Signer } from "./signing.ts";
import {
  cantCheck,
  CantCheckError,
  checkClaim,
  chronologyClaim,
  type CitedLines,
  missingCitation,
} from "./claimcheck.ts";
import { parseTokens } from "./tokens.ts";
import type { Vault } from "./vault.ts";

/**
 * The attestation ledger (ADR 0008): which of the user's verifications, adoptions, authorship
 * records, user-created items and draft kinds are current. Lives in the vault; public.db only
 * holds copies of the signatures. App only: the Claude-facing CLI must not import this module.
 */

/**
 * What an attestation in the ledger is about (ADR 0008). `paragraph` is the adoption of a Claude
 * paragraph; `authorship` records that the user wrote a paragraph's current text (ADR 0009);
 * `rewrite` records the user's rewrite of a Claude paragraph (same content as `authorship`);
 * `plan` records the Claude plan the user confirmed, with its conditions; `removal` records that
 * the user removed a chronology entry, evidence link or issue (id `"<type>/<n>"`); `note_done`
 * that the user marked a note as dealt with.
 */
export type AttestationKind =
  | "chronology"
  | "evidence"
  | "issue"
  | "paragraph"
  | "authorship"
  | "rewrite"
  | "plan"
  | "draft"
  | "user_item"
  | "removal"
  | "note_done";

/** Vault file holding the attestation ledger: a JSON map `"<kind>:<id>" -> signature`. */
export const LEDGER_FILE = "attestations";

/**
 * Vault file holding, for each current ledger entry, a short summary of what was attested (a JSON
 * map `"<kind>:<id>" -> AttestedSummary`). If the record later disappears from public.db, the
 * user can be told what it was and restore it by hand.
 */
export const ATTESTED_SUMMARIES_FILE = "attested-summaries";

/** What an attested item was, as last attested (tokenised text, from the vault). */
export interface AttestedSummary {
  /** e.g. "2025-03-14", "D002:14-16", "draft 3"; empty when there is none. */
  label: string;
  /** The first 80 characters of the item's main text. */
  text: string;
  /** When the user attested it. */
  attestedAt: string;
  /**
   * Chronology and evidence only: SHA-256 of the attested content without the cited lines and
   * the time (`own`), and of the cited-line hashes (`cited`), to tell why a check lapsed.
   */
  own?: string;
  cited?: string;
}

/**
 * Vault file of checks that lapsed (ADR 8 amendment, "Changed since you checked"): a JSON map
 * `"<kind>:<id>" -> LapsedCheck`, written when the app finds a verification no longer matches its
 * item. Kinds `chronology`, `evidence`, `issue` and `paragraph`.
 */
export const LAPSED_FILE = "lapsed-checks";

/** A check the user made that no longer holds. */
export interface LapsedCheck {
  /** When the user checked it. */
  checkedAt: string;
  /** The cited lines changed (e.g. a re-publish), or the item itself was edited. */
  reason: "source_changed" | "edited";
}

/** Kinds whose lapsed checks are remembered. */
const LAPSE_KINDS: AttestationKind[] = ["chronology", "evidence", "issue", "paragraph"];

/** Who-did-what marks the user makes on items, which public.db also shows (Claude-writable). */
export type MarkProblem =
  /** public.db says removed (or done) but the user did not do it in the app. */
  | "not_by_you"
  /** The user removed it (or marked it done) but public.db says otherwise. */
  | "undone_outside_app"
  /** The item changed after the user removed it (or marked it done). */
  | "changed";

/** A security event shown to the user (never written to public.db). */
export interface SecurityEvent {
  ts: string;
  event: "possible_probe" | "attested_item_deleted" | "removal_mismatch" | "done_mismatch";
  /** For a probe, what was edited; for a deletion, the ledger key ("<kind>:<id>"). */
  target: string;
  /** attested_item_deleted: the ledger kind and id of the record that disappeared. */
  kind?: AttestationKind;
  id?: string;
  /** attested_item_deleted: what the item was when last attested, if the vault recorded it. */
  lastAttested?: AttestedSummary;
  /** removal_mismatch / done_mismatch: what disagreed (the item is `target`, "<type>:<id>"). */
  problem?: MarkProblem;
}

/** Ledger kinds whose record disappearing outside the app is reported (not `draft` or `plan`). */
const REPORT_IF_DELETED: AttestationKind[] = [
  "chronology",
  "evidence",
  "issue",
  "paragraph",
  "authorship",
  "rewrite",
  "user_item",
];

/** Items whose authorship the app records (ADR 8). */
export type UserItemType = "chronology" | "issue" | "evidence" | "note";

/** The item changed (e.g. Claude edited it) after the user was shown it. */
export class StaleItemError extends InvalidInputError {
  constructor() {
    super("This item changed since you opened it. Read it again before verifying or adopting.");
    this.name = "StaleItemError";
  }
}

/** Sources in the order public.db returns them (ORDER BY doc_id, line_start, line_end). */
function sortSources(s: SourceRef[]): SourceRef[] {
  return [...s].sort((a, b) =>
    (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0) || a.line_start - b.line_start ||
    a.line_end - b.line_end
  );
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the ledger needs from the case session. */
export interface LedgerHost {
  vault: Vault;
  store: PublicStore;
  signer: Signer;
  /** Tokenised cited lines from the vault (`CaseSession.citedLines`). */
  citedLines(
    docId: string,
    from: number,
    to: number,
  ): Promise<{ line: number; text: string }[] | null>;
  /** Append security events to the vault (queued). */
  recordSecurityEvents(events: SecurityEvent[]): Promise<void>;
  /** The case settings as they are now (for `plan` attestations). */
  settings(): CaseSettings;
}

export class Ledger {
  readonly vault: Vault;
  readonly store: PublicStore;
  readonly signer: Signer;
  #host: LedgerHost;
  /** The attestation ledger (ADR 0008), mirrored from the vault. */
  #ledger: Map<string, string>;
  /** Summaries of what each ledger entry attested (ATTESTED_SUMMARIES_FILE). */
  #summaries: Map<string, AttestedSummary>;
  /** Ledger writes are queued so they reach the vault in order. */
  #ledgerLock: Promise<unknown> = Promise.resolve();
  #ledgerDirty = false;
  /** Revocation counter, and the epoch at which each key was last revoked. */
  #epoch = 0;
  #revokedAt = new Map<string, number>();
  /** Lapsed checks (LAPSED_FILE), loaded on first use; written under the ledger lock. */
  #lapsed: Map<string, LapsedCheck> | null = null;
  /** Removal / done marks the user is making right now (reconcileMarks leaves them alone). */
  #marking = new Set<string>();
  #reconcileLock: Promise<unknown> = Promise.resolve();

  constructor(
    host: LedgerHost,
    ledger: Record<string, string> = {},
    summaries: Record<string, AttestedSummary> = {},
  ) {
    this.#host = host;
    this.vault = host.vault;
    this.store = host.store;
    this.signer = host.signer;
    this.#ledger = new Map(Object.entries(ledger));
    this.#summaries = new Map(Object.entries(summaries));
  }

  /** Read the ledger and its summaries from the vault. */
  static async load(host: LedgerHost): Promise<Ledger> {
    const ledger = (await host.vault.readJson<Record<string, string>>(LEDGER_FILE)) ?? {};
    const summaries =
      (await host.vault.readJson<Record<string, AttestedSummary>>(ATTESTED_SUMMARIES_FILE)) ?? {};
    return new Ledger(host, ledger, summaries);
  }

  /** The queued ledger write, if any (for `CaseSession.settled`). */
  get pending(): Promise<unknown> {
    return this.#ledgerLock;
  }

  // ── verification (ADR 0008) ──────────────────────────────────────────────

  // Verifying a chronology entry or evidence link vouches for the cited lines too, so the signed
  // content includes a SHA-256 of the tokenised lines each citation points at, taken from the
  // vault (ADR 8). If those lines change, the verification no longer holds.

  async #citedHash(r: SourceRef): Promise<string | null> {
    const lines = await this.#quotable(r);
    return lines ? await sha256Hex(lines.map((l) => l.text).join("\n")) : null;
  }

  /** Every line a citation points at, from the vault; null if any of them cannot be quoted. */
  async #quotable(r: SourceRef): Promise<{ line: number; text: string }[] | null> {
    const lines = await this.#host.citedLines(r.doc_id, r.line_start, r.line_end);
    return lines && lines.length === r.line_end - r.line_start + 1 ? lines : null;
  }

  /**
   * casefile's own checks of a claim (ADR 8 amendment), enforced here so that every path that
   * verifies goes through them, not only the API. What blocks (a name not in the cited lines, an
   * unknown label, a missing or unquotable citation) does not depend on entity kinds, so the kinds
   * public.db lists are good enough here; the API also checks against the vault's registry.
   */
  async #refuseCantCheck(claim: string, refs: SourceRef[], needsSource: boolean) {
    const cited: CitedLines[] = await Promise.all(
      refs.map(async (ref) => ({ ref, lines: (await this.#quotable(ref)) ?? [] })),
    );
    const kinds = new Map(this.store.listEntities().map((e) => [e.role, e.kind]));
    const rows = checkClaim(claim, cited, kinds);
    if (needsSource && refs.length === 0) rows.unshift(missingCitation());
    if (cantCheck(rows)) throw new CantCheckError(rows);
  }

  async #chronoContent(e: ChronologyRow) {
    return {
      id: e.id,
      event_date: e.event_date,
      description: e.description,
      sources: e.sources,
      cited: await Promise.all(e.sources.map((r) => this.#citedHash(r))),
      verified_at: e.verified_at,
    };
  }

  async #evidenceContent(e: EvidenceRow) {
    return {
      id: e.id,
      issue_id: e.issue_id,
      doc_id: e.doc_id,
      line_start: e.line_start,
      line_end: e.line_end,
      cited: await this.#citedHash(e),
      note: e.note,
      stance: e.stance,
      verified_at: e.verified_at,
    };
  }

  #issueContent(i: IssueRow) {
    return { id: i.id, title: i.title, description: i.description, verified_at: i.verified_at };
  }

  #paragraphContent(p: ParagraphRow) {
    return {
      id: p.id,
      draft_id: p.draft_id,
      body: p.body,
      author: p.author,
      adopted_at: p.adopted_at,
    };
  }

  #authorshipContent(p: Pick<ParagraphRow, "id" | "draft_id" | "body">) {
    return { id: p.id, draft_id: p.draft_id, body: p.body };
  }

  /** The Claude plan the user confirmed, from the settings (vault). Throws if none is recorded. */
  #planContent() {
    const plan = this.#host.settings().plan;
    if (!plan) throw new Error("no plan recorded");
    return { setup: plan.setup, conditions: plan.conditions ?? null };
  }

  // ── attestation ledger (ADR 0008) ────────────────────────────────────────
  //
  // public.db is writable by Claude, so a signature stored there can be replayed: after the user
  // revokes a verification, the old (time, signature) pair can be written back and would still
  // check out. The ledger in the vault is the source of truth for which attestations are current.
  // An attestation counts only if the ledger holds a signature for it, that signature is the one
  // in public.db (where there is one), and it verifies over the record's current content.

  #key(kind: AttestationKind, id: number | string) {
    return `${kind}:${id}`;
  }

  /**
   * Run ledger writes one at a time. Each write snapshots the in-memory ledger *inside* the lock,
   * so two concurrent requests can never write stale copies over each other.
   */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#ledgerLock.then(fn, fn);
    this.#ledgerLock = run.catch(() => {});
    return run;
  }

  /**
   * Write the ledger (memory plus `adds`) to the vault, then apply `adds` to memory. Memory never
   * claims more than the vault holds. An add whose key was revoked after the attestation started
   * (`started` is the revocation epoch it began in) is dropped: the user's later action wins. With
   * `onlyIfAbsent`, an add never replaces an entry that appeared meanwhile.
   */
  async #commitLedger(
    adds: { key: string; sig: string; started: number; summary?: AttestedSummary }[] = [],
    opts: { onlyIfAbsent?: boolean } = {},
  ) {
    await this.#locked(async () => {
      const apply = adds.filter((a) =>
        (this.#revokedAt.get(a.key) ?? -1) <= a.started &&
        !(opts.onlyIfAbsent && this.#ledger.has(a.key))
      );
      const next = new Map(this.#ledger);
      for (const a of apply) next.set(a.key, a.sig);
      // Summaries follow the ledger: one for each current entry that has one.
      const summaries = new Map<string, AttestedSummary>();
      for (const key of next.keys()) {
        const sum = apply.find((a) => a.key === key)?.summary ?? this.#summaries.get(key);
        if (sum) summaries.set(key, sum);
      }
      try {
        await this.vault.writeJson(LEDGER_FILE, Object.fromEntries(next));
        // Written after the ledger: a summary is only a description, never what makes an item
        // attested, so it may lag the ledger after a failed write.
        await this.vault.writeJson(ATTESTED_SUMMARIES_FILE, Object.fromEntries(summaries));
        this.#summaries = summaries;
        this.#ledgerDirty = false;
      } catch (e) {
        this.#ledgerDirty = true;
        throw new Error(
          `Could not save the record of your verifications (${
            e instanceof Error ? e.name : "error"
          }). ` +
            `The last change is not saved; try again.`,
        );
      }
      for (const a of apply) this.#ledger.set(a.key, a.sig);
    });
  }

  /** Current attestation content for a ledger key, read from public.db (throws if it is gone). */
  async #ledgerContent(kind: AttestationKind, id: string): Promise<unknown> {
    const n = Number(id);
    switch (kind) {
      case "chronology":
        return await this.#chronoContent(this.store.getChronology(n));
      case "evidence":
        return await this.#evidenceContent(this.store.getEvidence(n));
      case "issue":
        return this.#issueContent(this.store.getIssue(n));
      case "paragraph":
        return this.#paragraphContent(this.store.getParagraph(n));
      case "authorship":
      case "rewrite":
        return this.#authorshipContent(this.store.getParagraph(n));
      case "plan":
        return this.#planContent();
      case "user_item":
        return this.#userItemContent(id);
      case "removal": {
        const [type, k] = id.split("/") as [RemovableType, string];
        return this.#removalContent(type, this.#getRemovable(type, Number(k)));
      }
      case "note_done":
        return this.#noteDoneContent(this.store.getNote(n));
      default:
        throw new Error("unknown kind");
    }
  }

  /**
   * On open, drop every entry that is no longer valid: the record is gone, or its content no longer
   * matches what was attested (it was edited while the app was closed). Once dropped, an entry can
   * never come back, so later restoring old content and an old signature does not re-verify it.
   * `draft` entries are the exception: a draft's recorded kind is the truth, so a mismatch means
   * the stored kind was tampered with and the entry is kept (ADR 9); it goes only with the draft.
   */
  async prune() {
    const invalid: string[] = [];
    const deleted: SecurityEvent[] = [];
    const ts = new Date().toISOString();
    const lapsed: { key: string; kind: AttestationKind; content: unknown }[] = [];
    const gone: string[] = [];
    for (const [key, sig] of this.#ledger) {
      const i = key.indexOf(":");
      const kind = key.slice(0, i) as AttestationKind;
      const id = key.slice(i + 1);
      let valid = false;
      try {
        if (kind === "draft") valid = Boolean(this.store.getDraft(Number(id)));
        else if (kind === "removal" || kind === "note_done") {
          // Kept while the record exists: `reconcileMarks` reports and drops a changed one.
          await this.#ledgerContent(kind, id);
          valid = true;
        } else {
          const content = await this.#ledgerContent(kind, id);
          valid = await this.signer.verify(kind, content, sig);
          if (!valid && LAPSE_KINDS.includes(kind)) lapsed.push({ key, kind, content });
        }
      } catch (e) {
        valid = false;
        if (e instanceof NotFoundError) gone.push(key);
        // The record is gone. The app drops ledger entries before it deletes anything, so this
        // was deleted outside the app (e.g. Claude with SQL). Tell the user; never prune silently.
        if (e instanceof NotFoundError && REPORT_IF_DELETED.includes(kind)) {
          const lastAttested = this.#summaries.get(key);
          deleted.push({
            ts,
            event: "attested_item_deleted",
            target: key,
            kind,
            id,
            ...(lastAttested ? { lastAttested } : {}),
          });
        }
      }
      if (!valid) invalid.push(key);
    }
    // Record first, prune after: if the record cannot be written, those entries stay (they
    // count as unverified anyway, the record being gone) and the deletion is found again next time.
    try {
      await this.#host.recordSecurityEvents(deleted);
    } catch {
      const keep = new Set(deleted.map((d) => d.target));
      invalid.splice(0, invalid.length, ...invalid.filter((k) => !keep.has(k)));
      deleted.length = 0;
    }
    if (deleted.length) {
      // No content in public.db: only that something attested was deleted, and how many.
      this.store.log("app", "attested_items_deleted_outside_app", { count: deleted.length });
    }
    // Remember checks that no longer hold ("Changed since you checked"); forget lapses of records
    // that are gone. Best effort: losing a lapse only shows the item as "To check".
    await this.#updateLapsed(
      await Promise.all(
        lapsed.map(async (l) => [l.key, await this.#lapse(l.key, l.content)] as const),
      ),
      gone,
    ).catch(() => {});
    if (invalid.length) await this.#revokeKeys(invalid);
  }

  // ── lapsed checks (ADR 8 amendment) ──────────────────────────────────────

  async #ownHashes(content: unknown): Promise<{ own: string; cited: string }> {
    const c = content as Record<string, unknown>;
    return {
      own: await sha256Hex(canonicalJson({ ...c, cited: undefined, verified_at: undefined })),
      cited: await sha256Hex(canonicalJson(c.cited ?? null)),
    };
  }

  /** Why the attestation at `key` no longer matches `content`, and when it was made. */
  async #lapse(key: string, content: unknown): Promise<LapsedCheck> {
    const sum = this.#summaries.get(key);
    let reason: LapsedCheck["reason"] = "edited";
    if (sum?.own && sum.cited) {
      const now = await this.#ownHashes(content);
      if (now.own === sum.own && now.cited !== sum.cited) reason = "source_changed";
    }
    return { checkedAt: sum?.attestedAt ?? "", reason };
  }

  async #loadLapsed(): Promise<Map<string, LapsedCheck>> {
    if (!this.#lapsed) {
      const raw = (await this.vault.readJson<Record<string, LapsedCheck>>(LAPSED_FILE)) ?? {};
      this.#lapsed ??= new Map(Object.entries(raw));
    }
    return this.#lapsed;
  }

  /** Add and remove lapsed checks, under the ledger lock (memory follows the vault). */
  async #updateLapsed(adds: readonly (readonly [string, LapsedCheck])[], removes: string[]) {
    if (!adds.length && !removes.length) return;
    await this.#locked(async () => {
      const cur = await this.#loadLapsed();
      const next = new Map(cur);
      for (const k of removes) next.delete(k);
      for (const [k, v] of adds) next.set(k, v);
      if (next.size === cur.size && [...next].every(([k, v]) => cur.get(k) === v)) return;
      await this.vault.writeJson(LAPSED_FILE, Object.fromEntries(next));
      this.#lapsed = next;
    });
  }

  /**
   * The user's check of (kind, id) that no longer holds, if any: the item is not attested now,
   * but was, and the app found it changed (its text or its cited lines). Only meaningful when the
   * item is not currently attested.
   */
  async lapsedCheck(
    kind: "chronology" | "evidence" | "issue" | "paragraph",
    id: number,
  ): Promise<LapsedCheck | null> {
    await this.#ledgerLock;
    return (await this.#loadLapsed()).get(this.#key(kind, id)) ?? null;
  }

  /** A short description of attested content, kept in the vault (ATTESTED_SUMMARIES_FILE). */
  #summarise(kind: AttestationKind, content: unknown): AttestedSummary | undefined {
    const c = content as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : String(v));
    const cut = (v: unknown) => s(v).slice(0, 80);
    const ref = () =>
      c.doc_id === undefined ? "" : formatSourceRef({
        doc_id: s(c.doc_id),
        line_start: Number(c.line_start),
        line_end: Number(c.line_end),
      });
    const attestedAt = s(c.verified_at ?? c.adopted_at) || new Date().toISOString();
    switch (kind) {
      case "chronology":
        return { label: s(c.event_date), text: cut(c.description), attestedAt };
      case "issue":
        return { label: "", text: cut(c.title), attestedAt };
      case "evidence":
        return { label: `issue ${s(c.issue_id)}, ${ref()}`, text: cut(c.note), attestedAt };
      case "paragraph":
      case "authorship":
      case "rewrite":
        return { label: `draft ${s(c.draft_id)}`, text: cut(c.body), attestedAt };
      case "plan":
        return { label: "plan", text: cut(c.setup), attestedAt };
      case "user_item":
      case "removal":
      case "note_done": {
        const type = s(c.type);
        const label = type === "chronology"
          ? `chronology, ${s(c.event_date)}`
          : type === "evidence"
          ? `evidence, issue ${s(c.issue_id)}, ${ref()}`
          : type === "note"
          ? `note on ${s(c.target_type)}:${s(c.target_id)}`
          : type;
        const text = type === "chronology"
          ? c.description
          : type === "issue"
          ? c.title
          : type === "evidence"
          ? c.note
          : c.body;
        return { label, text: cut(text), attestedAt };
      }
      default:
        return undefined;
    }
  }

  /**
   * Sign `content` and record the signature as the current attestation for (kind, id). `write`
   * stores the signature in public.db; the ledger is written only after it succeeds, so a failure
   * leaves the record unattested. Returns the signature.
   */
  async attest(
    kind: AttestationKind,
    id: number | string,
    content: unknown,
    write?: (sig: string) => void,
    /** `requestEpoch()` taken when the user's request arrived; a revoke requested later wins. */
    started: number = this.#epoch,
  ): Promise<string> {
    const key = this.#key(kind, id);
    const sig = await this.signer.sign(kind, content);
    // Revoked while signing: the revocation was requested later, so it wins. Nothing is written.
    if ((this.#revokedAt.get(key) ?? -1) > started) return sig;
    let summary = this.#summarise(kind, content);
    if (summary && (kind === "chronology" || kind === "evidence")) {
      summary = { ...summary, ...(await this.#ownHashes(content)) };
    }
    write?.(sig);
    await this.#commitLedger([{ key, sig, started, summary }]);
    // A new check replaces any lapsed one.
    if (LAPSE_KINDS.includes(kind)) await this.#updateLapsed([], [key]).catch(() => {});
    return sig;
  }

  /**
   * The revocation epoch now. Take it synchronously when a request to attest arrives and pass it
   * to `attest`, so a revocation requested after it (even one that finishes first) wins.
   */
  requestEpoch(): number {
    return this.#epoch;
  }

  /**
   * Withdraw the attestation for (kind, id). The ledger is updated first, so a failure after that
   * still leaves it revoked; `write` then clears the copy in public.db.
   */
  async revoke(kind: AttestationKind, id: number | string, write?: () => void): Promise<void> {
    await this.revokeMany([[kind, id]]);
    write?.();
  }

  /** The user withdraws attestations (unverify, delete, own edit): no lapsed check is kept. */
  async revokeMany(items: [AttestationKind, number | string][]) {
    const keys = items.map(([kind, id]) => this.#key(kind, id));
    await this.#revokeKeys(keys);
    await this.#updateLapsed([], keys.filter((k) => this.#lapsedKey(k))).catch(() => {});
  }

  #lapsedKey(key: string): boolean {
    return LAPSE_KINDS.includes(key.slice(0, key.indexOf(":")) as AttestationKind);
  }

  /**
   * Revoke keys: memory first, so even if the vault write fails the attestation is gone for this
   * session; the revocation epoch makes any attestation of the same key still in flight lose.
   * With `ifSig`, a key is revoked only while it still holds that signature (a stale check must
   * not remove a newer attestation made meanwhile).
   */
  async #revokeKeys(keys: string[], ifSig?: string) {
    let changed = this.#ledgerDirty;
    for (const key of keys) {
      if (ifSig !== undefined && this.#ledger.get(key) !== ifSig) continue;
      this.#revokedAt.set(key, ++this.#epoch);
      changed = this.#ledger.delete(key) || changed;
    }
    if (changed) await this.#commitLedger();
  }

  /**
   * Whether (kind, id) is currently attested for `content`: the ledger holds a signature, it
   * verifies over `content`, and, when `sig` is given (the copy stored in public.db), it is the
   * same signature. A signature that is valid but not the ledger's (a replay) does not count.
   */
  async isAttested(
    kind: AttestationKind,
    id: number | string,
    content: unknown,
    sig?: string | null,
  ): Promise<boolean> {
    const key = this.#key(kind, id);
    const current = this.#ledger.get(key);
    if (!current) return false;
    if (sig !== undefined && sig !== current) return false;
    if (await this.signer.verify(kind, content, current)) {
      // Re-read after the await: a revocation (or re-attestation) requested meanwhile wins.
      return this.#ledger.get(key) === current;
    }
    // The content changed since it was attested: the entry is stale. Drop it for good, so putting
    // the old content back later cannot revive it — unless it was re-attested meanwhile. The
    // user's check is remembered as lapsed ("Changed since you checked").
    if (this.#ledger.get(key) === current && LAPSE_KINDS.includes(kind)) {
      await this.#updateLapsed([[key, await this.#lapse(key, content)]], []).catch(() => {});
    }
    await this.#revokeKeys([key], current).catch(() => {});
    return false;
  }

  // ── verification (ADR 0008) ──────────────────────────────────────────────

  /**
   * A hash of what the user is shown and vouches for when verifying or adopting: the attested
   * content without the verification time. The API sends it with each item and the verify/adopt
   * request returns it.
   */
  async itemVersion(
    kind: "chronology" | "evidence" | "issue" | "paragraph",
    row: ChronologyRow | EvidenceRow | IssueRow | ParagraphRow,
  ): Promise<string> {
    const content: Record<string, unknown> = kind === "chronology"
      ? await this.#chronoContent(row as ChronologyRow)
      : kind === "evidence"
      ? await this.#evidenceContent(row as EvidenceRow)
      : kind === "issue"
      ? this.#issueContent(row as IssueRow)
      : this.#paragraphContent(row as ParagraphRow);
    return await sha256Hex(
      `${kind}\n${canonicalJson({ ...content, verified_at: undefined, adopted_at: undefined })}`,
    );
  }

  async #checkVersion(
    kind: "chronology" | "evidence" | "issue" | "paragraph",
    row: ChronologyRow | EvidenceRow | IssueRow | ParagraphRow,
    version: string | undefined,
  ) {
    if (version !== undefined && version !== await this.itemVersion(kind, row)) {
      throw new StaleItemError();
    }
  }

  /**
   * Verify item `id`. `version` is the version the user was shown (from `itemVersion`); if the
   * item changed since (Claude can write public.db at any time), the verification is refused, so
   * the user never vouches for text they did not see.
   */
  async verifyChronology(id: number, version?: string, flags?: Record<string, boolean>) {
    const started = this.#epoch;
    const row = this.store.getChronology(id);
    await this.#checkVersion("chronology", row, version);
    const e = { ...row, verified_at: new Date().toISOString() };
    const content = await this.#chronoContent(e);
    await this.#refuseCantCheck(chronologyClaim(row), row.sources, true);
    // Fail closed: a citation that cannot be quoted from the vault cannot be checked.
    if (content.cited.some((h) => h === null)) {
      throw new InvalidInputError(
        "A source this entry cites is not a published document, so it cannot be verified.",
      );
    }
    await this.attest(
      "chronology",
      id,
      content,
      (sig) => this.store.setChronologyVerification(id, e.verified_at, sig),
      started,
    );
    this.store.log("user", "verified", { what: "chronology", id, ...(flags ? { flags } : {}) });
  }

  async isChronologyVerified(e: ChronologyRow): Promise<boolean> {
    return e.verified_at !== null &&
      await this.isAttested("chronology", e.id, await this.#chronoContent(e), e.verified_sig);
  }

  /**
   * Verify item `id`. `version` is the version the user was shown (from `itemVersion`); if the
   * item changed since (Claude can write public.db at any time), the verification is refused, so
   * the user never vouches for text they did not see.
   */
  async verifyEvidence(id: number, version?: string, flags?: Record<string, boolean>) {
    const started = this.#epoch;
    const row = this.store.getEvidence(id);
    await this.#checkVersion("evidence", row, version);
    const e = { ...row, verified_at: new Date().toISOString() };
    const content = await this.#evidenceContent(e);
    await this.#refuseCantCheck(row.note ?? "", [row], true);
    if (content.cited === null) {
      throw new InvalidInputError(
        "The lines this evidence cites are not in a published document, so it cannot be verified.",
      );
    }
    await this.attest(
      "evidence",
      id,
      content,
      (sig) => this.store.setEvidenceVerification(id, e.verified_at, sig),
      started,
    );
    this.store.log("user", "verified", { what: "evidence", id, ...(flags ? { flags } : {}) });
  }

  async isEvidenceVerified(e: EvidenceRow): Promise<boolean> {
    return e.verified_at !== null &&
      await this.isAttested("evidence", e.id, await this.#evidenceContent(e), e.verified_sig);
  }

  /**
   * Verify item `id`. `version` is the version the user was shown (from `itemVersion`); if the
   * item changed since (Claude can write public.db at any time), the verification is refused, so
   * the user never vouches for text they did not see.
   */
  async verifyIssue(id: number, version?: string, flags?: Record<string, boolean>) {
    const started = this.#epoch;
    const row = this.store.getIssue(id);
    await this.#checkVersion("issue", row, version);
    // An issue cites nothing; an unknown label in it still can't be checked.
    const known = new Set(this.store.listEntities().map((e) => e.role));
    const unknown = parseTokens(`${row.title}\n${row.description ?? ""}`).tokens.filter((t) =>
      !known.has(t.role)
    );
    if (unknown.length) {
      throw new CantCheckError(unknown.map((t) => ({
        kind: "entity" as const,
        text: t.raw,
        ok: null,
        level: "danger" as const,
        message: `${t.raw} is a label casefile doesn't know, so it can't be checked.`,
      })));
    }
    const i = { ...row, verified_at: new Date().toISOString() };
    await this.attest(
      "issue",
      id,
      this.#issueContent(i),
      (sig) => this.store.setIssueVerification(id, i.verified_at, sig),
      started,
    );
    this.store.log("user", "verified", { what: "issue", id, ...(flags ? { flags } : {}) });
  }

  async isIssueVerified(i: IssueRow): Promise<boolean> {
    return i.verified_at !== null &&
      await this.isAttested("issue", i.id, this.#issueContent(i), i.verified_sig);
  }

  /** Withdraw a verification. Restoring the old signature in public.db does not bring it back. */
  async unverify(what: "chronology" | "evidence" | "issue", id: number) {
    await this.revoke(what, id, () => {
      if (what === "chronology") this.store.setChronologyVerification(id, null, null);
      else if (what === "evidence") this.store.setEvidenceVerification(id, null, null);
      else this.store.setIssueVerification(id, null, null);
    });
    this.store.log("user", "unverified", { what, id });
  }

  /**
   * Sign a paragraph adoption and record it in the ledger as the current one. The caller stores
   * the returned signature with `adopted_at` in public.db.
   */
  /** Refuse if paragraph `p` is not the version the user was shown. */
  async checkParagraphVersion(p: ParagraphRow, version?: string) {
    await this.#checkVersion("paragraph", p, version);
  }

  async signParagraphAdoption(p: ParagraphRow, started?: number): Promise<string> {
    return await this.attest("paragraph", p.id, this.#paragraphContent(p), undefined, started);
  }

  async isParagraphAdopted(p: ParagraphRow): Promise<boolean> {
    return p.adopted_at !== null &&
      await this.isAttested("paragraph", p.id, this.#paragraphContent(p), p.adopted_sig);
  }

  /** Record that the user wrote this paragraph's current text (ADR 0009). */
  async attestUserAuthorship(p: Pick<ParagraphRow, "id" | "draft_id" | "body">): Promise<void> {
    await this.attest("authorship", p.id, this.#authorshipContent(p));
  }

  /** Whether the app recorded the user as the author of this paragraph's current text. */
  async hasUserAuthorship(p: ParagraphRow): Promise<boolean> {
    return await this.isAttested("authorship", p.id, this.#authorshipContent(p));
  }

  // ── items the user created (ADR 0008) ────────────────────────────────────
  //
  // `created_by` is in public.db, so Claude could mark its own chronology entry, issue, evidence
  // link or note as the user's. The app records the user's items in the ledger (kind
  // `user_item`, id "<type>/<n>"), signed over the content the app wrote, built from the values
  // it wrote rather than read back (Claude could change the row in between). An item shows as the
  // user's only if `created_by = 'user'` and that record matches its current content; a reused
  // id or content Claude changed shows as Claude's.

  #userItemFields(type: UserItemType, row: Record<string, unknown>): unknown {
    switch (type) {
      case "chronology": {
        const r = row as unknown as ChronologyRow;
        return {
          event_date: r.event_date,
          description: r.description,
          sources: sortSources(r.sources).map((x) => [x.doc_id, x.line_start, x.line_end]),
        };
      }
      case "issue":
        return { title: row.title, description: row.description ?? "" };
      case "evidence":
        return {
          issue_id: row.issue_id,
          doc_id: row.doc_id,
          line_start: row.line_start,
          line_end: row.line_end,
          note: row.note ?? "",
          stance: row.stance,
        };
      case "note":
        return { target_type: row.target_type, target_id: row.target_id, body: row.body };
    }
  }

  #userItemContent(id: string): unknown {
    const [type, n] = id.split("/") as [UserItemType, string];
    const num = Number(n);
    const row: Record<string, unknown> = type === "chronology"
      ? { ...this.store.getChronology(num) }
      : type === "issue"
      ? { ...this.store.getIssue(num) }
      : type === "evidence"
      ? { ...this.store.getEvidence(num) }
      : { ...this.store.getNote(num) };
    return { type, id: num, ...(this.#userItemFields(type, row) as object) };
  }

  /** Record that the user created item `id` of `type` with these values (as written). */
  async recordUserItem(
    type: UserItemType,
    id: number,
    written: object,
  ): Promise<void> {
    await this.attest("user_item", `${type}/${id}`, {
      type,
      id,
      ...(this.#userItemFields(type, written as Record<string, unknown>) as object),
    });
  }

  /** Whether the app recorded this item, with its current content, as created by the user. */
  async isUserItem(
    type: UserItemType,
    row: { id: number; created_by: Actor },
  ): Promise<boolean> {
    return row.created_by === "user" &&
      await this.isAttested("user_item", `${type}/${row.id}`, {
        type,
        id: row.id,
        ...(this.#userItemFields(type, row as unknown as Record<string, unknown>) as object),
      });
  }

  // ── draft kinds (ADR 0009) ───────────────────────────────────────────────
  //
  // `drafts.kind` is in public.db, so Claude could turn an affidavit into an "outline" to get
  // unreviewed paragraphs past the export gate. The ledger records each draft's kind: when the user
  // creates it, or, for drafts Claude creates, the first time the app sees it. Afterwards the
  // recorded kind is what counts; a draft whose stored kind differs, or whose kind was never
  // recorded, is treated as an affidavit (the strictest kind).

  #draftContent(d: { id: number; kind: DraftKind }) {
    return { id: d.id, kind: d.kind };
  }

  /** Record the kind of a draft the user created in the app. */
  async attestDraftKind(id: number, kind: DraftKind): Promise<void> {
    await this.attest("draft", id, this.#draftContent({ id, kind }));
  }

  /**
   * Record the kind of every draft the app has not seen before (Claude's new drafts). An entry
   * recorded meanwhile (e.g. the user creating a draft concurrently) is never replaced.
   */
  async recordDraftKinds(): Promise<void> {
    const started = this.#epoch;
    const adds: { key: string; sig: string; started: number }[] = [];
    for (const d of this.store.listDrafts()) {
      const key = this.#key("draft", d.id);
      if (this.#ledger.has(key)) continue;
      adds.push({ key, sig: await this.signer.sign("draft", this.#draftContent(d)), started });
    }
    if (adds.length) await this.#commitLedger(adds, { onlyIfAbsent: true });
  }

  /**
   * The kind the app treats a draft as. `changed` is true when public.db's kind differs from the
   * one recorded in the vault (tampering); unrecorded drafts and changed ones count as affidavits.
   */
  async draftKind(d: DraftRow): Promise<{ kind: DraftKind; recorded: boolean; changed: boolean }> {
    const key = this.#key("draft", d.id);
    const sig = this.#ledger.get(key);
    if (!sig) return { kind: "affidavit", recorded: false, changed: false };
    const ok = await this.signer.verify("draft", this.#draftContent(d), sig);
    if (this.#ledger.get(key) !== sig) {
      return { kind: "affidavit", recorded: false, changed: false };
    }
    if (ok) {
      return { kind: d.kind, recorded: true, changed: false };
    }
    return { kind: "affidavit", recorded: true, changed: true };
  }

  // ── removed items and notes dealt with (ADR 8 amendment) ─────────────────
  //
  // `removed_at` / `removed_by` and `done_at` / `done_by` are in public.db, so Claude can write
  // them. The user's removals and "dealt with" marks are recorded in the ledger (kinds `removal`,
  // id "<type>/<n>", and `note_done`), signed over the item's content, and only those count for
  // what the user sees. public.db's columns are kept in step for the CLI (which hides removed
  // items from Claude); `reconcileMarks` reports and repairs any disagreement.

  #getRemovable(type: RemovableType, id: number): ChronologyRow | EvidenceRow | IssueRow {
    if (type === "chronology") return this.store.getChronology(id);
    if (type === "evidence") return this.store.getEvidence(id);
    if (type === "issue") return this.store.getIssue(id);
    throw new InvalidInputError(`Bad item type ${JSON.stringify(type)}`);
  }

  #removalContent(type: RemovableType, row: ChronologyRow | EvidenceRow | IssueRow) {
    return {
      type,
      id: row.id,
      ...(this.#userItemFields(type, row as unknown as Record<string, unknown>) as object),
    };
  }

  #noteDoneContent(n: NoteRow) {
    return {
      type: "note",
      id: n.id,
      ...(this.#userItemFields("note", n as unknown as Record<string, unknown>) as object),
    };
  }

  /** none: no mark; valid: the user's mark, for this content; changed: the content changed. */
  async #markStatus(
    kind: "removal" | "note_done",
    id: string,
    content: unknown,
  ): Promise<{ status: "none" | "valid" | "changed"; sig?: string; at?: string }> {
    const key = this.#key(kind, id);
    const sig = this.#ledger.get(key);
    if (!sig) return { status: "none" };
    const ok = await this.signer.verify(kind, content, sig);
    if (this.#ledger.get(key) !== sig) return { status: "none" };
    return {
      status: ok ? "valid" : "changed",
      sig,
      at: this.#summaries.get(key)?.attestedAt ?? "",
    };
  }

  /**
   * When the user removed this item, or null if they have not (whatever public.db says). An item
   * whose content changed after the user removed it counts as not removed (shown, not hidden).
   */
  async removedByUser(
    type: RemovableType,
    row: ChronologyRow | EvidenceRow | IssueRow,
  ): Promise<string | null> {
    const m = await this.#markStatus(
      "removal",
      `${type}/${row.id}`,
      this.#removalContent(type, row),
    );
    return m.status === "valid" ? m.at || "" : null;
  }

  /** When the user marked this note as dealt with, or null (whatever public.db says). */
  async noteDoneByUser(n: NoteRow): Promise<string | null> {
    const m = await this.#markStatus("note_done", String(n.id), this.#noteDoneContent(n));
    return m.status === "valid" ? m.at || "" : null;
  }

  async #whileMarking<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.#marking.add(key);
    try {
      return await fn();
    } finally {
      this.#marking.delete(key);
    }
  }

  /**
   * casefile itself rewrote one of the user's items (a value learnt later replaced by its token,
   * `typedtext.ts`): the user's marks on it (removed, dealt with) carry over to the new content,
   * so the rewrite neither brings back a removed item nor reopens a note. `before` is the row as
   * it was signed, `after` as it is now. The mark's date becomes the rewrite's.
   */
  async carryMarks(
    type: RemovableType | "note",
    before: ChronologyRow | EvidenceRow | IssueRow | NoteRow,
    after: ChronologyRow | EvidenceRow | IssueRow | NoteRow,
  ): Promise<void> {
    if (type === "note") {
      const was = await this.#markStatus(
        "note_done",
        String(before.id),
        this.#noteDoneContent(before as NoteRow),
      );
      if (was.status === "valid") {
        await this.attest("note_done", after.id, this.#noteDoneContent(after as NoteRow));
      }
      return;
    }
    const b = before as ChronologyRow | EvidenceRow | IssueRow;
    if (await this.removedByUser(type, b) !== null) {
      await this.attest(
        "removal",
        `${type}/${after.id}`,
        this.#removalContent(type, after as ChronologyRow | EvidenceRow | IssueRow),
      );
    }
  }

  /**
   * The user removes an item (restorably). The removal is recorded in the vault first, then
   * public.db's `removed_at` is set so the CLI hides it from Claude. Attestations are kept.
   */
  async removeItem(type: RemovableType, id: number): Promise<void> {
    const started = this.#epoch;
    const row = this.#getRemovable(type, id);
    if (await this.removedByUser(type, row) !== null) return;
    await this.#whileMarking(`${type}:${id}`, async () => {
      await this.attest(
        "removal",
        `${type}/${id}`,
        this.#removalContent(type, row),
        undefined,
        started,
      );
      this.store.softRemove(type, id, "user");
    });
    this.store.log("user", "item_removed", { what: type, id });
  }

  /** The user restores an item they removed. */
  async restoreItem(type: RemovableType, id: number): Promise<void> {
    const row = this.#getRemovable(type, id);
    if (await this.removedByUser(type, row) === null) {
      throw new InvalidInputError("That item is not in Removed items.");
    }
    await this.#whileMarking(`${type}:${id}`, async () => {
      await this.revoke("removal", `${type}/${id}`, () => this.store.restore(type, id));
    });
    this.store.log("user", "item_restored", { what: type, id });
  }

  /** The user marks a note as dealt with (`done = false` undoes it). */
  async markNoteDone(id: number, done: boolean): Promise<void> {
    const started = this.#epoch;
    const n = this.store.getNote(id);
    await this.#whileMarking(`note:${id}`, async () => {
      if (done) {
        await this.attest("note_done", id, this.#noteDoneContent(n), undefined, started);
        this.store.markNoteDone(id, "user", true);
      } else {
        await this.revoke("note_done", id, () => this.store.markNoteDone(id, "user", false));
      }
    });
    this.store.log("user", done ? "note_done" : "note_undone", { id });
  }

  /** Drop the user's marks on an item the user is deleting (so a reused id inherits nothing). */
  async forgetMarks(type: RemovableType | "note", id: number): Promise<void> {
    await this.revokeMany(
      type === "note" ? [["note_done", id]] : [["removal", `${type}/${id}`]],
    );
  }

  /**
   * Compare the user's removals and "dealt with" marks (vault) with public.db's columns, which
   * Claude can write. Each disagreement is reported to the user as a security event (vault only;
   * public.db gets a count) and public.db is put back in line with the vault:
   *  - removed/done in public.db but not by the user: shown to the user, column cleared;
   *  - removed/done by the user but cleared in public.db: still removed/done, column set again;
   *  - the item changed after the user marked it: the mark is dropped, the item is shown.
   * Returns how many were found. Marks the user is making right now are left alone.
   */
  reconcileMarks(): Promise<number> {
    const run = this.#reconcileLock.then(() => this.#reconcileMarks());
    this.#reconcileLock = run.catch(() => {});
    return run;
  }

  async #reconcileMarks(): Promise<number> {
    const ts = new Date().toISOString();
    const events: SecurityEvent[] = [];
    const repairs: (() => void)[] = [];
    const drops: [string, string][] = [];
    const types: RemovableType[] = ["chronology", "evidence", "issue"];
    for (const type of types) {
      for (const id of this.store.removableIds(type)) {
        if (this.#marking.has(`${type}:${id}`)) continue;
        let row: ChronologyRow | EvidenceRow | IssueRow;
        try {
          row = this.#getRemovable(type, id);
        } catch {
          continue;
        }
        const content = this.#removalContent(type, row);
        const m = await this.#markStatus("removal", `${type}/${id}`, content);
        const pub = row.removed_at !== null;
        const problem: MarkProblem | null = m.status === "changed"
          ? "changed"
          : m.status === "valid" && !pub
          ? "undone_outside_app"
          : m.status === "none" && pub
          ? "not_by_you"
          : null;
        if (!problem) continue;
        events.push({
          ts,
          event: "removal_mismatch",
          target: `${type}:${id}`,
          kind: "removal",
          id: `${type}/${id}`,
          problem,
          lastAttested: this.#summarise("removal", content),
        });
        if (problem === "changed") {
          drops.push([this.#key("removal", `${type}/${id}`), m.sig!]);
          if (pub) repairs.push(() => this.store.restore(type, id));
        } else if (problem === "undone_outside_app") {
          repairs.push(() => this.store.softRemove(type, id, "user"));
        } else repairs.push(() => this.store.restore(type, id));
      }
    }
    for (const id of this.store.listNotes().map((n) => n.id)) {
      if (this.#marking.has(`note:${id}`)) continue;
      let n: NoteRow;
      try {
        n = this.store.getNote(id);
      } catch {
        continue;
      }
      const content = this.#noteDoneContent(n);
      const m = await this.#markStatus("note_done", String(id), content);
      const pub = n.done_at !== null;
      const problem: MarkProblem | null = m.status === "changed"
        ? "changed"
        : m.status === "valid" && !pub
        ? "undone_outside_app"
        : m.status === "none" && pub
        ? "not_by_you"
        : null;
      if (!problem) continue;
      events.push({
        ts,
        event: "done_mismatch",
        target: `note:${id}`,
        kind: "note_done",
        id: String(id),
        problem,
        lastAttested: this.#summarise("note_done", content),
      });
      if (problem === "changed") {
        drops.push([this.#key("note_done", id), m.sig!]);
        if (pub) repairs.push(() => this.store.markNoteDone(id, "user", false));
      } else if (problem === "undone_outside_app") {
        repairs.push(() => this.store.markNoteDone(id, "user", true));
      } else repairs.push(() => this.store.markNoteDone(id, "user", false));
    }
    if (!events.length) return 0;
    // Tell the user first; if that cannot be written, change nothing (found again next time).
    await this.#host.recordSecurityEvents(events);
    for (const [key, sig] of drops) await this.#revokeKeys([key], sig);
    for (const r of repairs) {
      try {
        r();
      } catch {
        // The row went away meanwhile; nothing to repair.
      }
    }
    this.store.log("app", "marks_repaired", { count: events.length });
    return events.length;
  }
}
