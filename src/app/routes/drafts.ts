import {
  adoptParagraph,
  citableLines,
  draftOverview,
  ExportBlockedError,
  type ExportIssue,
  ExportNeedsConfirmError,
  getDraftHeading,
  paragraphFacts,
  PlaceholderError,
  setDraftHeading,
  setParagraphSources,
  unadoptParagraph,
  userAddParagraph,
  userCreateDraft,
  userDeleteDraft,
  userEditParagraph,
} from "../../core/drafting.ts";
import {
  DRAFT_KINDS,
  type DraftKind,
  formatSourceRef,
  type ParagraphLink,
  parseSourceRef,
  type SourceRef,
} from "../../core/publicdb.ts";
import type { WorkState } from "../../core/states.ts";
import {
  type ErrorMapper,
  HttpError,
  num,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Drafts and their paragraphs: authorship, adoption, sources, heading and export (ADR 9). */
export function draftsRoutes(ctx: RouteContext): Route[] {
  const { s, show, plain, notes, guardedSave } = ctx;

  /**
   * A paragraph's sources as the user sees them: quoted from the vault with ±2 lines of context
   * (`lines`, each marked cited or not), and the document's state. The shape is the shared
   * `SourceOut` plus the fields the draft screen had first (`ref`, `doc`, `lineStart`, …).
   */
  const sourcesView = async (refs: SourceRef[]) => {
    const out = await ctx.sources(refs);
    return await Promise.all(out.map(async (o, i) => ({
      ...o,
      ref: formatSourceRef(refs[i]),
      doc: o.doc_id,
      lineStart: o.line_start,
      lineEnd: o.line_end,
      citable: (await citableLines(s(), refs[i])) !== null,
    })));
  };

  /** Export blockers and flags with their messages re-identified (fact messages hold tokens). */
  const issuesView = (list: ExportIssue[]) =>
    list.map((b) => {
      const m = show(b.message);
      return { ...b, message: m.text ?? "", segs: m.segs };
    });

  /**
   * What a paragraph relies on, with whether the user checked it (from the ledger, not public.db).
   * Only "checked", "to_check" or (gone) "cant_check" here. `date` is the chronology entry's date
   * (null for evidence); `label` is the entry's description, or "issue — reference" for evidence.
   */
  const reliesView = async (links: ParagraphLink[]) =>
    await Promise.all(links.map(async (l) => {
      try {
        if (l.target_type === "chronology") {
          const e = s().store.getChronology(l.target_id);
          const state: WorkState = await s().isChronologyVerified(e) ? "checked" : "to_check";
          return {
            type: l.target_type,
            id: l.target_id,
            state,
            date: e.event_date as string | null,
            label: (plain(e.description) ?? "").slice(0, 120),
          };
        }
        const e = s().store.getEvidence(l.target_id);
        const state: WorkState = await s().isEvidenceVerified(e) ? "checked" : "to_check";
        let issue = "";
        try {
          issue = plain(s().store.getIssue(e.issue_id).title) ?? "";
        } catch { /* issue gone */ }
        return {
          type: l.target_type,
          id: l.target_id,
          state,
          date: null as string | null,
          label: `${issue} — ${formatSourceRef(e)}`.slice(0, 120),
        };
      } catch {
        const state: WorkState = "cant_check";
        return {
          type: l.target_type,
          id: l.target_id,
          state,
          date: null as string | null,
          label: "No longer exists",
        };
      }
    }));

  return [
    // ── drafts (ADR 9) ──────────────────────────────────────────────────────
    route("GET", "/api/drafts", async () => {
      await s().recordDraftKinds();
      return await Promise.all(
        s().store.listDrafts().map(async (d) => {
          const ov = await draftOverview(s(), d.id);
          return {
            ...d,
            // The kind the vault recorded; a kind changed in public.db shows as affidavit.
            kind: ov.check.kind,
            kindChanged: ov.check.kindChanged,
            title: plain(d.title),
            paragraphs: ov.info.length,
            counts: ov.counts,
            factsToCheck: ov.factsToCheck,
            exportReady: ov.check.ready,
          };
        }),
      );
    }),
    route("POST", "/api/drafts", async ({ body }) => {
      const b = await body();
      const kind = str(b.kind, "kind") as DraftKind;
      if (!DRAFT_KINDS.includes(kind)) throw new HttpError(400, "Bad draft kind");
      return { id: await userCreateDraft(s(), kind, str(b.title, "title")) };
    }),
    route("GET", "/api/drafts/:id", async ({ params }) => {
      await s().recordDraftKinds();
      const d = s().store.getDraft(num(params.id, "id"));
      const ov = await draftOverview(s(), d.id);
      return {
        ...d,
        kind: ov.check.kind,
        kindChanged: ov.check.kindChanged,
        title: plain(d.title),
        heading: await getDraftHeading(s(), d.id),
        counts: ov.counts,
        factsToCheck: ov.factsToCheck,
        exportCheck: {
          ...ov.check,
          blockers: issuesView(ov.check.blockers),
          flags: issuesView(ov.check.flags),
        },
        paragraphs: await Promise.all(
          ov.info.map(async ({ para: p, state, placeholder, checks }, i) => ({
            id: p.id,
            n: i + 1,
            body: show(p.body),
            author: p.author,
            state,
            draftedByClaude: state !== "user",
            version: await s().itemVersion("paragraph", p),
            claude_body: p.claude_body === null ? null : plain(p.claude_body),
            adopted_at: p.adopted_at,
            hasPlaceholder: placeholder,
            sources: await sourcesView(s().store.listParagraphSources(p.id)),
            relies: await reliesView(s().store.listParagraphLinks(p.id)),
            checks: ctx.checks(checks),
            // Fact by fact, split and checked by core: the adoption records answers against
            // exactly these (send one answer per fact, in order).
            facts: (await paragraphFacts(s(), p)).map((f) => ({
              text: show(f.text),
              cites: f.cites.map(formatSourceRef),
              checks: ctx.checks(f.checks),
            })),
            notes: await notes("para", String(p.id)),
          })),
        ),
        notes: await notes("draft", String(d.id)),
      };
    }),
    route("PATCH", "/api/drafts/:id", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const cur = s().store.getDraft(id);
      const title = str(b.title, "title");
      const titleChanged = title !== plain(cur.title);
      await guardedSave(`draft:${id}`, titleChanged ? [[title, [cur.title]]] : []);
      if (titleChanged) s().store.renameDraft(id, await s().tokeniseUserText(title));
      return { ok: true };
    }),
    route("DELETE", "/api/drafts/:id", async ({ params }) => {
      await userDeleteDraft(s(), num(params.id, "id"));
      return { ok: true };
    }),
    route("PUT", "/api/drafts/:id/heading", async ({ params, body }) => {
      const heading = await setDraftHeading(s(), num(params.id, "id"), await body());
      return { heading };
    }),
    route("POST", "/api/drafts/:id/paragraphs", async ({ params, body }) => {
      const b = await body();
      const after = b.after ? Number(b.after) : undefined;
      return { id: await userAddParagraph(s(), num(params.id, "id"), str(b.text, "text"), after) };
    }),
    route("PUT", "/api/paragraphs/:id", async ({ params, body }) => {
      const b = await body();
      const r = await userEditParagraph(s(), num(params.id, "id"), str(b.text, "text"));
      return { ok: true, author: r.paragraph.author, state: r.state };
    }),
    route("PUT", "/api/paragraphs/:id/sources", async ({ params, body }) => {
      const b = await body();
      if (!Array.isArray(b.sources) || b.sources.length > 50) {
        throw new HttpError(400, "sources must be a list of references such as D001:3-5");
      }
      const sources = b.sources.map((x: unknown) => parseSourceRef(str(x, "source")));
      let links: ParagraphLink[] | undefined;
      if (b.relies !== undefined) {
        if (!Array.isArray(b.relies) || b.relies.length > 50) {
          throw new HttpError(400, "relies must be a list");
        }
        links = b.relies.map((l: { type?: unknown; id?: unknown }) => {
          if (l?.type !== "chronology" && l?.type !== "evidence") {
            throw new HttpError(400, "Each relies item has type chronology or evidence");
          }
          return { target_type: l.type, target_id: num(String(l.id), "id") };
        });
      }
      const id = num(params.id, "id");
      await setParagraphSources(s(), id, sources, links);
      return {
        sources: await sourcesView(s().store.listParagraphSources(id)),
        relies: await reliesView(s().store.listParagraphLinks(id)),
      };
    }),
    route("DELETE", "/api/paragraphs/:id", async ({ params }) => {
      await s().deleteParagraph(num(params.id, "id"));
      return Promise.resolve({ ok: true });
    }),
    route("POST", "/api/paragraphs/:id/adopt", async ({ params, body }) => {
      const b = await body();
      await adoptParagraph(s(), num(params.id, "id"), {
        ownKnowledge: b.ownKnowledge,
        ownWords: b.ownWords,
      }, { version: str(b.version, "version"), facts: b.facts });
      return { ok: true, state: "claude_adopted" };
    }),
    route("POST", "/api/paragraphs/:id/unadopt", async ({ params }) => {
      await unadoptParagraph(s(), num(params.id, "id"));
      return Promise.resolve({ ok: true });
    }),
    // GET /api/drafts/:id/export lives in routes/export.ts (W3-1).
  ];
}

export const draftsErrors: ErrorMapper[] = [
  (e) =>
    e instanceof ExportBlockedError
      ? {
        status: 409,
        body: {
          error: e.message,
          needsReview: e.needsReview,
          placeholders: e.placeholders,
          badTokens: e.badTokens,
        },
      }
      : undefined,
  (e) =>
    e instanceof ExportNeedsConfirmError
      ? { status: 409, body: { error: e.message, needsConfirm: true, flags: e.flags } }
      : undefined,
  (e) =>
    e instanceof PlaceholderError
      ? { status: 400, body: { error: e.message, placeholder: true } }
      : undefined,
];
