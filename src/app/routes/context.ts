import type { SourceRef } from "../../core/publicdb.ts";
import { type CaseSession, ProbeError, type RichSeg } from "../../core/session.ts";
import type { CheckRow } from "../../core/states.ts";
import type { AppState } from "../state.ts";

/**
 * Shared plumbing for the JSON API's route modules (`routes/*.ts`): the route type and helpers,
 * request-value checks, and the `RouteContext` every module's routes are built with.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type Params = Record<string, string>;
// deno-lint-ignore no-explicit-any
export type Body = any;
export type Handler = (
  ctx: { req: Request; params: Params; url: URL; body: () => Promise<Body> },
) => Promise<unknown>;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Routes that work without an unlocked session. */
  open?: boolean;
}

/**
 * Maps a domain error to an HTTP response, or returns undefined if it does not handle it. Each
 * route module exports its own list; `api.ts` checks them all, then the general ones.
 */
export type ErrorMapper = (
  e: unknown,
) => { status: number; body: Record<string, unknown> } | undefined;

export function route(method: string, path: string, handler: Handler, open = false): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:([a-z_]+)/g, (_m, k) => {
      keys.push(k);
      return "([^/]+)";
    }) + "$",
  );
  return { method, pattern, keys, handler, open };
}

export function str(v: unknown, name: string, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `Missing ${name}`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${name} must be text`);
  return v;
}

export function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Bad ${name}`);
  return n;
}

/**
 * Re-identified text for display: `text` with real names, and the same text as segments the UI
 * can colour (`segs`). Unknown and malformed tokens are left in place and listed.
 */
export interface Rich {
  text: string | null;
  segs: RichSeg[];
  unknown: string[];
  malformed: string[];
}

/** A quoted line, re-identified (from the vault, never public.db). */
export interface QuotedLine {
  line: number;
  text: string | null;
  segs: RichSeg[];
}

/** A quoted line with whether it is one of the cited lines (true) or context around them. */
export interface WindowLine extends QuotedLine {
  cited: boolean;
}

/**
 * A check row for display. casefile's checks keep the claim's tokens ("{{child_2.first}} is not in
 * D001:1–2"); this is the one place they are re-identified for the user: `text` and `message`
 * with real names, `segs` the message as segments the UI can colour.
 */
export type CheckOut = CheckRow & { text: string; message: string; segs: RichSeg[] };

/** A cited source as the API shows it: quote and ±2 lines of context, all from the vault. */
export interface SourceOut extends SourceRef {
  docTitle: string | null;
  withheld: boolean;
  /** The cited lines. */
  quote: QuotedLine[];
  /** Up to two lines either side of the cited ones. */
  context: { before: QuotedLine[]; after: QuotedLine[] };
  /** Context and cited lines in order, each marked cited or not (empty when not quotable). */
  lines: WindowLine[];
}

/** Lines of context shown either side of a citation. */
export const CONTEXT_LINES = 2;

export interface RouteContext {
  state: AppState;
  /** The unlocked session; throws 423 when the case is locked. */
  s(): CaseSession;
  /** Re-identify for display. */
  show(text: string | null | undefined): Rich;
  /** Re-identified text only. */
  plain(text: string | null | undefined): string | null;
  /** Quote cited lines for the user, from the vault. */
  quote(docId: string, from: number, to: number): Promise<QuotedLine[]>;
  /** Notes for display; "You" only for notes the app recorded as the user's (ADR 8). */
  notes(type?: string, target?: string): Promise<unknown[]>;
  /** The probe guard for a save that may replace Claude-written text (ADR 3). */
  guardedSave(target: string, fields: [string, (string | null | undefined)[]][]): Promise<void>;
  /** Check rows for display, re-identified (the one path every check message takes). */
  checks(rows: CheckRow[]): CheckOut[];
  /** Cited sources for display, with ±2 lines of context (from the vault). */
  sources(refs: SourceRef[]): Promise<SourceOut[]>;
}

export function makeContext(state: AppState): RouteContext {
  const s = (): CaseSession => {
    if (!state.session) throw new HttpError(423, "The case is locked");
    return state.session;
  };
  /** Re-identify for display. Unknown and malformed tokens are left in place and listed. */
  const show = (text: string | null | undefined): Rich => {
    if (text === null || text === undefined) {
      return { text: null, segs: [], unknown: [], malformed: [] };
    }
    const r = s().reidentifyRich(text);
    return {
      text: r.text,
      segs: r.segs,
      unknown: r.unknown.map((u) => u.raw),
      malformed: r.malformed.map((m) => m.raw),
    };
  };
  const plain = (text: string | null | undefined) => show(text).text;
  /** Notes for display; "You" only for notes the app recorded as the user's (ADR 8). */
  const notes = async (type?: string, target?: string) =>
    await Promise.all(
      s().store.listNotes(type, target).map(async (n) => ({
        ...n,
        body: show(n.body),
        created_by: await s().isUserItem("note", n) ? "user" : "claude",
      })),
    );
  /**
   * The probe guard for a save that may replace Claude-written text (ADR 3): check every changed
   * field, record exactly one edit check for the request (even when nothing changed, so a no-op, an
   * ordinary refusal and a probe look the same from public.db and the vault's file sizes), then
   * refuse if any field still names something Claude's text named.
   */
  const guardedSave = async (
    target: string,
    fields: [string, (string | null | undefined)[]][],
  ) => {
    const hit = [...new Set(fields.flatMap(([text, prev]) => s().probeRoles(text, prev)))].sort();
    await s().recordEditCheck(target, hit.length > 0);
    if (hit.length) throw new ProbeError(hit);
  };
  /**
   * Quote cited lines for the user. From the vault's tokenised text, never public.db's `lines`,
   * which Claude can rewrite (security review): a verification must be made against the source.
   */
  const quote = async (docId: string, from: number, to: number) =>
    ((await s().citedLines(docId, from, to)) ?? []).map((l) => {
      const r = show(l.text);
      return { line: l.line, text: r.text, segs: r.segs };
    });
  const checks = (rows: CheckRow[]): CheckOut[] =>
    rows.map((r) => {
      const m = show(r.message);
      return { ...r, text: plain(r.text) ?? "", message: m.text ?? "", segs: m.segs };
    });
  /** Cited sources for display (from the vault; public.db's lines are Claude-writable). */
  const sources = async (refs: SourceRef[]): Promise<SourceOut[]> =>
    await Promise.all(refs.map(async (r) => {
      let docTitle: string | null = null;
      let withheld = false;
      try {
        const d = await s().getDoc(r.doc_id);
        docTitle = d.title;
        withheld = s().isWithheld(d);
      } catch {
        // Not a document the vault has: no title, and nothing is quoted below.
      }
      const q = await quote(r.doc_id, r.line_start, r.line_end);
      const before = q.length && r.line_start > 1
        ? await quote(r.doc_id, Math.max(1, r.line_start - CONTEXT_LINES), r.line_start - 1)
        : [];
      const after = q.length
        ? await quote(r.doc_id, r.line_end + 1, r.line_end + CONTEXT_LINES)
        : [];
      return {
        doc_id: r.doc_id,
        line_start: r.line_start,
        line_end: r.line_end,
        docTitle,
        withheld,
        quote: q,
        context: { before, after },
        lines: [
          ...before.map((l) => ({ ...l, cited: false })),
          ...q.map((l) => ({ ...l, cited: true })),
          ...after.map((l) => ({ ...l, cited: false })),
        ],
      };
    }));
  return { state, s, show, plain, quote, notes, guardedSave, checks, sources };
}
