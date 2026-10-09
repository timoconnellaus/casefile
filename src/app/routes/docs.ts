// Route handlers are uniformly async, whether or not a given one awaits.
// deno-lint-ignore-file require-await
import { decodeBase64 } from "@std/encoding/base64";
import { parseOrigin } from "../../core/publicdb.ts";
import { suggestForReview } from "../../core/people.ts";
import { extractPdfText, MAX_PDF_BYTES, PdfError } from "../../core/pdf.ts";
import { getEarlierAffidavit, setEarlierAffidavit } from "../../core/export/affidavits.ts";
import {
  type CaseSession,
  LeakError,
  type PublishRequest,
  SafetyError,
  type StoredDoc,
  undecidedCount,
  UnresolvedError,
} from "../../core/session.ts";
import { normaliseVariant } from "../../core/entities.ts";
import type { EntityKind } from "../../core/kinds.ts";
import { exposureTriggers, listExposures } from "../../core/exposure.ts";
import {
  chronologyState,
  DOC_AUTHORS_FILE,
  docAuthor,
  evidenceState,
  setDocAuthor,
} from "../../core/checking.ts";
import { paragraphState } from "../../core/drafting.ts";
import { formatSourceRef, type SourceRef } from "../../core/publicdb.ts";
import type { Leak } from "../../core/tokenise.ts";
import { parseTokens } from "../../core/tokens.ts";
import {
  type ErrorMapper,
  HttpError,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Documents: import, review, sharing (origin, withdraw, re-check), details, tags. */
export function docsRoutes(
  { s, show, plain, notes, guardedSave, state }: RouteContext,
): Route[] {
  return [
    // ── documents ───────────────────────────────────────────────────────────
    route("GET", "/api/docs", async ({ url }) => {
      const batch = url.searchParams.get("batch");
      if (batch !== null && !s().isBatch(batch)) throw new HttpError(400, "No such import batch");
      const docs = (await s().listDocInfo()).filter((d) => batch === null || d.batch === batch);
      const cited = s().store.citationCounts();
      const authors = await s().readVaultJson<Record<string, { role?: unknown }>>(
        DOC_AUTHORS_FILE,
        {},
      );
      return docs.map((d) => {
        const pub = d.status === "published" && s().store.hasDocument(d.id)
          ? s().store.getDocument(d.id)
          : null;
        // Details kept in the vault while a change of origin withholds it (app only).
        const held = d.state === "shared" ? null : d.heldDetails ?? null;
        return {
          id: d.id,
          title: d.title,
          status: d.status,
          state: d.state,
          origin: d.origin,
          originHint: d.originHint ?? null,
          withheldReason: d.withheldReason,
          needsRecheck: d.needsRecheck,
          importedAt: d.importedAt,
          publishedAt: d.publishedAt ?? null,
          sharedAt: d.state === "shared" ? d.sharedAt ?? d.publishedAt ?? null : null,
          withheld: pub ? pub.withheld === 1 : false,
          doc_type: pub?.doc_type ?? held?.doc_type ?? null,
          doc_date: pub?.doc_date ?? held?.doc_date ?? null,
          tags: [
            ...new Set([
              ...(pub ? s().store.tagsFor(d.id) : []),
              ...(held?.tags ?? []).map((t) => t.tag),
            ]),
          ].sort(),
          // The type, date and tags shown are kept for when it is shared again; Claude has none.
          detailsHeld: held !== null,
          cited: cited[d.id] ?? 0,
          detectorErrors: d.detectorErrors,
          batch: d.batch ?? null,
          // "pdf" when imported from a PDF kept in the vault (ADR 23).
          format: d.file?.type ?? null,
          // Findings waiting for the user's decision on the review screen ("Needs you").
          undecided: d.undecided,
          // App only: real values found by a change to who's who while it waited for review.
          newMatch: d.status !== "published" && d.newMatch ? d.newMatch : null,
          // Who wrote it, as the user recorded it (vault; checking.ts `docAuthor`).
          author: Object.hasOwn(authors, d.id) && typeof authors[d.id].role === "string"
            ? authors[d.id].role
            : null,
        };
      });
    }),
    // One file per request. The first of an import starts a batch; send its `batch` with the
    // rest, so the review screen can walk through them (`GET /api/docs?batch=`).
    route("POST", "/api/docs/import", async ({ body }) => {
      const b = await body();
      const given = str(b.origin, "origin", false);
      const title = str(b.title, "title", false) || "Untitled";
      const text = str(b.text, "text");
      const origin = given ? parseOrigin(given) : null;
      if (b.batch !== undefined && b.batch !== null && !s().isBatch(b.batch)) {
        throw new HttpError(400, "No such import batch");
      }
      if (!text.trim()) throw new HttpError(400, "Document is empty");
      const batch: string = typeof b.batch === "string" ? b.batch : await s().newBatch();
      const doc = await s().importText({
        title,
        text,
        source: str(b.source, "source", false) || undefined,
        // Not given: not asked yet, so withheld until the user says where it came from (ADR 7).
        origin,
        batch,
      });
      return {
        id: doc.id,
        batch,
        detections: doc.proposals.length,
        undecided: undecidedCount(doc.proposals),
        detectorErrors: doc.detectorErrors,
        origin: doc.origin,
        originHint: doc.originHint ?? null,
      };
    }),
    // A PDF (ADR 23): `pdf` is the file in base64. Its text is imported like `/api/docs/import`'s,
    // and the file is kept in the vault.
    route("POST", "/api/docs/import-pdf", async ({ body }) => {
      const b = await body();
      const given = str(b.origin, "origin", false);
      const title = str(b.title, "title", false) || "Untitled";
      const pdf = str(b.pdf, "pdf");
      const origin = given ? parseOrigin(given) : null;
      if (b.batch !== undefined && b.batch !== null && !s().isBatch(b.batch)) {
        throw new HttpError(400, "No such import batch");
      }
      // Base64 is 4 characters per 3 bytes; refuse an oversized file before decoding it.
      if (pdf.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) throw new PdfError("too_large");
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(pdf);
      } catch {
        throw new HttpError(400, "pdf must be base64");
      }
      // Read first, so a PDF that can't be read starts no batch.
      const { text, info } = await extractPdfText(bytes);
      const batch: string = typeof b.batch === "string" ? b.batch : await s().newBatch();
      const doc = await s().importText({
        title,
        text,
        source: str(b.source, "source", false) || undefined,
        origin,
        batch,
      }, { bytes, info });
      return {
        id: doc.id,
        batch,
        detections: doc.proposals.length,
        undecided: undecidedCount(doc.proposals),
        detectorErrors: doc.detectorErrors,
        origin: doc.origin,
        originHint: doc.originHint ?? null,
        pages: doc.file?.pages ?? null,
        emptyPages: doc.file?.emptyPages ?? [],
      };
    }),
    // The file a document was imported from (ADR 23), to compare with the text read from it.
    // Named by id, never by title.
    route("GET", "/api/docs/:id/original", async ({ params }) => {
      const orig = await s().readOriginal(params.id);
      if (!orig) throw new HttpError(404, "This document was not imported from a file");
      return new Response(orig.bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${params.id.replace(/[^A-Za-z0-9]/g, "")}.pdf"`,
        },
      });
    }),
    route("GET", "/api/docs/:id/review", async ({ params }) => {
      const doc = await s().getDoc(params.id);
      return {
        id: doc.id,
        title: doc.title,
        status: doc.status,
        state: s().docState(doc),
        origin: doc.origin,
        originHint: doc.originHint ?? null,
        original: doc.original,
        proposals: doc.proposals,
        newEntities: doc.newEntities,
        detectorErrors: doc.detectorErrors,
        nameDetection: s().nameDetection,
        file: doc.file ?? null,
        ignore: doc.ignore,
        ignoreReasons: doc.ignoreReasons ?? {},
        replacements: doc.replacements,
        entities: s().registry.list(),
        safetyRoles: s().registry.safetyRoles(),
        batch: doc.batch ?? null,
        ...reviewData(s(), doc),
        ...titleView(await s().currentTitlePreview(doc)),
      };
    }),
    // What publishing with these decisions would do, without publishing: the title Claude would
    // see and the leak check's result. Same body as publish. Nothing is saved or logged.
    route("POST", "/api/docs/:id/preview", async ({ params, body }) => {
      const req = publishRequest(await body());
      const p = await s().previewPublish(params.id, req);
      return {
        ...titleView(p),
        leaks: p.leaks,
        refused: p.refused,
        willShare: p.willShare,
      };
    }),
    /**
     * Suggestions for the findings of a document under review (ADR 25 amendment): "same as",
     * labels and "leave as written", from rules and the language model under Finding names reading
     * the whole document. Nothing is saved; the review screen pre-fills what the user accepts.
     */
    route("POST", "/api/docs/:id/tidy", async ({ params, body }) => {
      const b = await body();
      return await suggestForReview(s(), params.id, {
        useLlm: b.useLlm !== false,
        fetch: state.opts.tidyFetch,
      });
    }),
    route("POST", "/api/docs/:id/redetect", async ({ params }) => {
      const doc = await s().redetect(params.id);
      return { detections: doc.proposals.length, detectorErrors: doc.detectorErrors };
    }),
    route("POST", "/api/docs/:id/publish", async ({ params, body }) => {
      const doc = await s().publish(params.id, publishRequest(await body()));
      const withheld = s().store.getDocument(doc.id).withheld === 1;
      return { ok: true, id: doc.id, withheld, state: s().docState(doc) };
    }),
    // On a commercial plan: share one other-side or subpoena document (ADR 7).
    route("POST", "/api/docs/:id/share", async ({ params }) => {
      const doc = await s().release(params.id);
      return { ok: true, state: s().docState(doc) };
    }),
    // Undo share: the document leaves public.db and needs review again.
    route("POST", "/api/docs/:id/withdraw", async ({ params }) => {
      const doc = await s().withdraw(params.id);
      return { ok: true, state: s().docState(doc) };
    }),
    // Review again: withdrawn, with earlier decisions as accepted proposals.
    route("POST", "/api/docs/:id/reopen", async ({ params }) => {
      const doc = await s().reopen(params.id);
      return { ok: true, state: s().docState(doc), proposals: doc.proposals.length };
    }),
    route("POST", "/api/docs/recheck", async ({ body }) => {
      const b = await body();
      if (!Array.isArray(b.docs) || !b.docs.every((d: unknown) => typeof d === "string")) {
        throw new HttpError(400, "docs must be a list of document ids");
      }
      const results = [];
      for (const id of b.docs as string[]) results.push(await s().recheck(id));
      return { results };
    }),
    route("PUT", "/api/docs/:id/origin", async ({ params, body }) => {
      const b = await body();
      const origin = b.origin === null ? null : parseOrigin(str(b.origin, "origin"));
      return await s().setOrigin(params.id, origin);
    }),
    route("GET", "/api/docs/:id/origin-impact", async ({ params, url }) => {
      const q = url.searchParams.get("origin");
      const origin = q === null || q === "" || q === "null" ? null : parseOrigin(q);
      return await s().originImpact(params.id, origin);
    }),
    route("GET", "/api/exposures", async () => {
      const out = [];
      for (const e of await listExposures(s())) {
        let title: string | null = null;
        let state: string | null = null;
        try {
          const doc = await s().getDoc(e.doc);
          title = doc.title;
          state = s().docState(doc);
        } catch {
          // deleted since
        }
        // Which value caused it, for the app only (never logged, never in public.db).
        const triggers = await exposureTriggers(s(), e);
        out.push({ ...e, title, state, triggers, trigger: triggers[0] ?? null });
      }
      return out;
    }),
    // Who wrote it (a person in who's who), kept in the vault so Claude cannot forge it: "only
    // source is your own statement" relies on it.
    route("PUT", "/api/docs/:id/author", async ({ params, body }) => {
      const b = await body();
      const role = b.role === null || b.role === "" ? null : str(b.role, "role");
      await setDocAuthor(s(), params.id, role);
      return { ok: true, author: await docAuthor(s(), params.id) };
    }),
    // An affidavit the user swore or affirmed earlier, and when (ADR 0027): vault only. On export
    // a citation of it becomes "my affidavit sworn 2 April 2025, para 4".
    route("PUT", "/api/docs/:id/affidavit", async ({ params, body }) => {
      const b = await body();
      const input = b.affidavit === null ? null : { oath: b.oath, date: b.date };
      return { ok: true, affidavit: await setEarlierAffidavit(s(), params.id, input) };
    }),
    route("DELETE", "/api/docs/:id", async ({ params }) => {
      await s().deleteDoc(params.id);
      return { ok: true };
    }),
    route("GET", "/api/docs/:id", async ({ params }) => {
      const doc = await s().getDoc(params.id);
      const activity = s().store.logForDoc(doc.id).map((r) => {
        let detail: unknown = null;
        try {
          detail = JSON.parse(r.detail);
        } catch {
          // a malformed row is shown without detail
        }
        return { id: r.id, ts: r.ts, actor: r.actor, action: r.action, detail };
      });
      const citedIn = await citedInItems(s(), plain, doc.id);
      const common = {
        id: doc.id,
        title: doc.title,
        status: doc.status,
        state: s().docState(doc),
        origin: doc.origin,
        originHint: doc.originHint ?? null,
        // Who wrote it, as the user recorded it (vault). Not public.db's author_role.
        author: await docAuthor(s(), doc.id),
        // Sworn or affirmed earlier, as the user recorded it (vault, ADR 0027).
        affidavit: await getEarlierAffidavit(s(), doc.id),
        file: doc.file ?? null,
        citedIn,
        activity,
      };
      if (doc.status !== "published") return common;
      const pub = s().store.getDocument(doc.id);
      const view = s().publishedView(doc);
      const held = view.withheld ? doc.heldDetails ?? null : null;
      const lines = (doc.tokenised ?? "").split("\n").map((t, i) => {
        const r = show(t);
        return { line: i + 1, text: r.text, segs: r.segs };
      });
      return {
        ...common,
        withheldReason: view.withheldReason,
        sharedAt: view.withheld ? null : doc.sharedAt ?? doc.publishedAt ?? null,
        withheld: pub.withheld === 1,
        claudeTitle: pub.title,
        publishedAt: doc.publishedAt ?? null,
        meta: {
          doc_type: plain(pub.doc_type ?? held?.doc_type),
          doc_date: plain(pub.doc_date ?? held?.doc_date),
          author_role: plain(pub.author_role ?? held?.author_role),
          meta_by: pub.meta_by,
        },
        // The details above are kept in the vault while it is withheld; Claude has none of them.
        detailsHeld: held !== null,
        tags: [
          ...new Set([...s().store.tagsFor(doc.id), ...(held?.tags ?? []).map((t) => t.tag)]),
        ].sort(),
        notes: await notes("doc", doc.id),
        lines,
      };
    }),
    route("GET", "/api/docs/:id/claude-view", async ({ params }) => {
      // What Claude is meant to see, built from the vault (public.db is repaired to match on open).
      const doc = await s().getDoc(params.id);
      if (doc.status !== "published") throw new HttpError(404, "Not published");
      const view = s().publishedView(doc);
      const lines = view.body === null
        ? []
        : view.body.split("\n").map((text, i) => ({ line: i + 1, text }));
      return { title: view.title, withheld: view.withheld, lines };
    }),
    // Only fields the user actually changed are saved. Re-tokenising a field the user merely saw
    // (e.g. Claude's guess "Sarah" in author_role) would tell Claude whether it was a real name.
    // The client may send `changed: [field…]`; either way a value equal to what was shown is left
    // untouched, and a changed value that keeps a name Claude wrote is refused (ProbeError).
    route("PUT", "/api/docs/:id/meta", async ({ params, body }) => {
      const b = await body();
      const pub = s().store.getDocument(params.id);
      const changed = Array.isArray(b.changed)
        ? b.changed.filter((k: unknown) => typeof k === "string")
        : null;
      const updates: [string, string][] = [];
      for (const k of ["doc_type", "doc_date", "author_role"] as const) {
        if (b[k] === undefined || (changed && !changed.includes(k))) continue;
        const next = b[k] === null ? "" : String(b[k]);
        if (next !== (plain(pub[k]) ?? "")) updates.push([k, next]);
      }
      await guardedSave(
        `doc:${params.id}`,
        updates.map(([k, next]) => [next, [pub[k as "doc_type"]]]),
      );
      const meta: Record<string, string | null> = {};
      for (const [k, next] of updates) {
        meta[k] = next.trim() ? await s().tokeniseUserText(next) : null;
      }
      if (Object.keys(meta).length) s().store.setDocumentMeta(params.id, meta, "user");
      return { ok: true, updated: Object.keys(meta) };
    }),
    route("POST", "/api/docs/:id/tags", async ({ params, body }) => {
      const b = await body();
      s().store.addTag(params.id, await s().tokeniseUserText(str(b.tag, "tag")), "user");
      return { ok: true };
    }),
    route("DELETE", "/api/docs/:id/tags/:tag", async ({ params }) => {
      s().store.removeTag(params.id, decodeURIComponent(params.tag));
      return Promise.resolve({ ok: true });
    }),
    route("GET", "/api/audit", async () => await s().auditPublished()),
  ];
}

export const docsErrors: ErrorMapper[] = [
  (e) =>
    e instanceof PdfError
      ? { status: 422, body: { error: e.message, code: e.code } }
      : e instanceof SafetyError
      ? { status: 409, body: { error: e.message, safety: e.roles } }
      : e instanceof LeakError
      ? { status: 409, body: { error: e.message, leaks: e.leaks } }
      : e instanceof UnresolvedError
      ? { status: 409, body: { error: e.message, unresolved: e.spans.map((s) => s.id) } }
      : undefined,
];

// ── review data ────────────────────────────────────────────────────────────

type FindingGroup = "needs" | "people" | "places" | "ids" | "kept";

interface Finding {
  id: string;
  group: FindingGroup;
  /** Decided automatically (an existing or new entity); false: the user must decide. */
  auto: boolean;
  role?: string;
  form?: string;
  kind: EntityKind;
  colour: number | null;
  text: string;
  /** Lines (1-based) it appears on. */
  lines: number[];
  /** The proposal spans it covers (ids). */
  spans: string[];
  /** For "kept": why the user left it as written. */
  reason?: string;
}

type ReviewSeg =
  | { t: string }
  | {
    t: string;
    span: string;
    finding: string;
    group: FindingGroup;
    kind: EntityKind;
    role: string | null;
    form: string | null;
    colour: number | null;
  };

function groupOf(kind: EntityKind): FindingGroup {
  if (kind === "person") return "people";
  if (kind === "place" || kind === "organisation" || kind === "school") return "places";
  return "ids";
}

/**
 * Findings (proposals grouped by value and decision, plus values left as written) and each
 * original line as segments, for the review screen. App only: this is the original text.
 */
function reviewData(s: CaseSession, doc: StoredDoc) {
  const lineStarts = [0];
  for (let i = 0; i < doc.original.length; i++) {
    if (doc.original[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const findings = new Map<string, Finding>();
  const spanFinding = new Map<string, Finding>();
  for (const sp of doc.proposals) {
    const p = sp.proposal;
    const folded = normaliseVariant(sp.text);
    let key: string;
    let f: Omit<Finding, "id" | "lines" | "spans">;
    if (p.type === "existing") {
      const e = s.registry.get(p.role);
      const kind = e?.kind ?? sp.kind;
      key = `e:${p.role}.${p.form}:${folded}`;
      f = {
        group: groupOf(kind),
        auto: true,
        role: p.role,
        form: p.form,
        kind,
        colour: e?.colour ?? null,
        text: sp.text,
      };
    } else if (p.type === "new") {
      key = `n:${p.key}.${p.form}:${folded}`;
      f = {
        group: groupOf(p.kind),
        auto: true,
        form: p.form,
        kind: p.kind,
        colour: null,
        text: sp.text,
      };
    } else {
      key = `a:${folded}`;
      f = { group: "needs", auto: false, kind: sp.kind, colour: null, text: sp.text };
    }
    let found = findings.get(key);
    if (!found) {
      found = { id: `f${findings.size + 1}`, ...f, lines: [], spans: [] };
      findings.set(key, found);
    }
    const line = lineOf(sp.start);
    if (!found.lines.includes(line)) found.lines.push(line);
    found.spans.push(sp.id);
    spanFinding.set(sp.id, found);
  }
  // Values left as written, with the user's reason.
  const lower = doc.original.toLowerCase();
  for (const v of doc.ignore) {
    const needle = v.toLowerCase();
    const lines: number[] = [];
    for (let i = needle ? lower.indexOf(needle) : -1; i !== -1; i = lower.indexOf(needle, i + 1)) {
      const l = lineOf(i);
      if (!lines.includes(l)) lines.push(l);
    }
    findings.set(`k:${normaliseVariant(v)}`, {
      id: `f${findings.size + 1}`,
      group: "kept",
      auto: false,
      kind: "other",
      colour: null,
      text: v,
      lines,
      spans: [],
      reason: doc.ignoreReasons?.[v],
    });
  }
  // Segments per line.
  const spans = [...doc.proposals].sort((a, b) => a.start - b.start);
  const lines = lineStarts.map((start, i) => {
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : doc.original.length;
    const segs: ReviewSeg[] = [];
    let at = start;
    for (const sp of spans) {
      if (sp.end <= start || sp.start >= end) continue;
      const from = Math.max(sp.start, at);
      const stop = Math.min(sp.end, end);
      if (stop <= from) continue;
      if (from > at) segs.push({ t: doc.original.slice(at, from) });
      const f = spanFinding.get(sp.id)!;
      segs.push({
        t: doc.original.slice(from, stop),
        span: sp.id,
        finding: f.id,
        group: f.group,
        kind: f.kind,
        role: f.role ?? null,
        form: f.form ?? null,
        colour: f.colour,
      });
      at = stop;
    }
    if (at < end) segs.push({ t: doc.original.slice(at, end) });
    return { line: i + 1, segs };
  });
  return { findings: [...findings.values()], lines };
}

// ── publish requests and the title preview ─────────────────────────────────

/** A publish (or preview) request body, checked. */
// deno-lint-ignore no-explicit-any
function publishRequest(b: any): PublishRequest {
  if (!b || !Array.isArray(b.newEntities) || !Array.isArray(b.replacements)) {
    throw new HttpError(400, "Bad publish request");
  }
  if (b.ignore !== undefined && !Array.isArray(b.ignore)) {
    throw new HttpError(400, "ignore must be a list");
  }
  let reasons: Record<string, string> | undefined;
  if (b.ignoreReasons !== undefined) {
    if (!b.ignoreReasons || typeof b.ignoreReasons !== "object") {
      throw new HttpError(400, "ignoreReasons must map each value to a reason");
    }
    reasons = {};
    for (const [k, v] of Object.entries(b.ignoreReasons)) {
      if (typeof v === "string") reasons[k] = v;
    }
  }
  // A value newly left as written needs a reason (core refuses it without one, ADR 6).
  return {
    newEntities: b.newEntities,
    replacements: b.replacements,
    ignore: b.ignore,
    ignoreReasons: reasons,
    title: typeof b.title === "string" ? b.title : undefined,
    release: b.release === true,
    aliases: Array.isArray(b.aliases)
      ? b.aliases.filter((a: unknown) =>
        !!a && typeof (a as { ref?: unknown }).ref === "string" &&
        typeof (a as { value?: unknown }).value === "string"
      )
      : undefined,
  };
}

/** A segment of the title Claude sees: plain text, or a label (`{{role.form}}`). */
type TitleSeg = { t: string } | { t: string; role: string; form: string };

/**
 * The title as Claude sees it (`claudeTitle`, tokenised), as segments the review screen can colour
 * (`claudeTitleSegs`), and what in it would stop the document being shared (`titleLeaks`).
 */
function titleView(p: { title: string | null; titleLeaks: (Leak & { field: "title" })[] }) {
  const segs: TitleSeg[] = [];
  if (p.title !== null) {
    let at = 0;
    for (const t of parseTokens(p.title).tokens) {
      if (t.start > at) segs.push({ t: p.title.slice(at, t.start) });
      segs.push({ t: t.raw, role: t.role, form: t.form });
      at = t.end;
    }
    if (at < p.title.length) segs.push({ t: p.title.slice(at) });
  }
  return { claudeTitle: p.title, claudeTitleSegs: segs, titleLeaks: p.titleLeaks };
}

// ── "Cited in" ─────────────────────────────────────────────────────────────

/** The line range of a reference, without the document ("3-5", "3"). */
function linesOf(r: SourceRef): string {
  return r.line_start === r.line_end ? String(r.line_start) : `${r.line_start}-${r.line_end}`;
}

/**
 * What cites document `docId`, ready to show: each chronology entry, evidence link, draft
 * paragraph and note with a title (re-identified, for the user), its state, the lines of this
 * document it cites, and whether it was removed. App only.
 */
async function citedInItems(
  s: CaseSession,
  plain: (t: string | null | undefined) => string | null,
  docId: string,
) {
  const c = s.store.citationsOf(docId, { includeRemoved: true });
  const out: Record<string, unknown>[] = [];
  for (const id of c.chronology) {
    let e;
    try {
      e = s.store.getChronology(id);
    } catch {
      continue;
    }
    out.push({
      type: "chronology",
      id,
      label: "Chronology",
      title: plain(e.description) ?? "",
      date: e.event_date,
      state: (await chronologyState(s, e)).state,
      removed: e.removed_at !== null,
      lines: e.sources.filter((r) => r.doc_id === docId).map(linesOf),
      others: e.sources.filter((r) => r.doc_id !== docId).map(formatSourceRef),
    });
  }
  for (const id of c.evidence) {
    let e;
    try {
      e = s.store.getEvidence(id);
    } catch {
      continue;
    }
    let issueTitle: string | null = null;
    try {
      issueTitle = plain(s.store.getIssue(e.issue_id).title);
    } catch {
      // the issue is gone
    }
    out.push({
      type: "evidence",
      id,
      label: "Evidence",
      title: issueTitle ?? "An issue",
      issue_id: e.issue_id,
      stance: e.stance,
      state: (await evidenceState(s, e)).state,
      removed: e.removed_at !== null,
      lines: [linesOf(e)],
      others: [],
    });
  }
  for (const id of c.paragraphs) {
    let p;
    try {
      p = s.store.getParagraph(id);
    } catch {
      continue;
    }
    const draft = s.store.getDraft(p.draft_id);
    const n = s.store.listParagraphs(p.draft_id).findIndex((x) => x.id === id) + 1;
    const sources = s.store.listParagraphSources(id);
    out.push({
      type: "paragraph",
      id,
      label: "Draft paragraph",
      title: `${plain(draft.title) ?? ""} ¶${n}`,
      draft_id: p.draft_id,
      n,
      state: await paragraphState(s, p),
      removed: false,
      lines: sources.filter((r) => r.doc_id === docId).map(linesOf),
      others: sources.filter((r) => r.doc_id !== docId).map(formatSourceRef),
    });
  }
  for (const id of c.notes) {
    let n;
    try {
      n = s.store.getNote(id);
    } catch {
      continue;
    }
    const mine = await s.isUserItem("note", n);
    out.push({
      type: "note",
      id,
      label: mine ? "Your note" : "Claude’s note",
      title: plain(n.body) ?? "",
      by: mine ? "user" : "claude",
      state: null,
      removed: false,
      lines: [],
      others: [],
    });
  }
  return out;
}
