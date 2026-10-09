import {
  citedDocs,
  getAnnexureMarks,
  setAnnexureMarks,
  suggestedPrefix,
  suggestMarks,
} from "../../core/export/annexures.ts";
import { type ChronologyScope, exportChronology } from "../../core/export/chronology.ts";
import {
  DRAFT_EXPORT_FORMATS,
  type DraftExportFormat,
  exportDraftFile,
  type ExportFile,
} from "../../core/export/draft.ts";
import { ExportNeedsConfirmError } from "../../core/drafting.ts";
import { provenanceReport } from "../../core/export/provenance.ts";
import { SafetyConfirmError } from "../../core/export/safety.ts";
import {
  type ErrorMapper,
  HttpError,
  num,
  type Route,
  route,
  type RouteContext,
} from "./context.ts";

/**
 * Exports (ADR 0021): a draft as Markdown, text or RTF for Word; the chronology as an RTF table;
 * a draft's provenance report; and the draft's annexure marks, which live in the vault only.
 * Every export is a download (`Content-Disposition: attachment`, `Cache-Control: no-store`) and
 * is logged with counts only.
 *
 * Registered before the area modules so `/api/chronology/export` is never read as an entry id.
 */
export function exportRoutes(ctx: RouteContext): Route[] {
  const { s } = ctx;
  const flag = (url: URL, name: string) => url.searchParams.get(name) === "1";

  return [
    route("GET", "/api/drafts/:id/export", async ({ params, url }) => {
      const f = url.searchParams.get("format") ?? "markdown";
      if (!DRAFT_EXPORT_FORMATS.includes(f as DraftExportFormat)) {
        throw new HttpError(400, `Bad format; one of ${DRAFT_EXPORT_FORMATS.join(", ")}`);
      }
      try {
        return download(
          await exportDraftFile(s(), num(params.id, "id"), f as DraftExportFormat, {
            confirm: flag(url, "confirm"),
            confirmSafety: flag(url, "confirmSafety"),
          }),
        );
      } catch (e) {
        // The flags' messages hold tokens (fact checks name roles): re-identify them for the user.
        if (e instanceof ExportNeedsConfirmError) {
          throw new HttpError(409, e.message, {
            needsConfirm: true,
            flags: e.flags.map((b) => ({ ...b, message: ctx.plain(b.message) ?? "" })),
          });
        }
        throw e;
      }
    }),
    route("GET", "/api/drafts/:id/provenance", async ({ params, url }) =>
      download(
        await provenanceReport(s(), num(params.id, "id"), {
          confirmSafety: flag(url, "confirmSafety"),
        }),
      )),
    route("GET", "/api/drafts/:id/annexures", async ({ params }) => {
      const id = num(params.id, "id");
      const marks = await getAnnexureMarks(s(), id);
      const docs = await Promise.all(
        citedDocs(s(), id).map(async (doc) => {
          let title: string | null = null;
          try {
            title = (await s().getDoc(doc)).title;
          } catch { /* a citation of a document that does not exist */ }
          return { doc, title, mark: Object.hasOwn(marks, doc) ? marks[doc] : null };
        }),
      );
      return {
        marks,
        docs,
        prefix: await suggestedPrefix(s(), id),
        suggested: await suggestMarks(s(), id),
      };
    }),
    route("PUT", "/api/drafts/:id/annexures", async ({ params, body }) => {
      const b = await body();
      return { marks: await setAnnexureMarks(s(), num(params.id, "id"), b.marks) };
    }),
    route("GET", "/api/chronology/export", async ({ url }) => {
      const scope = url.searchParams.get("which") ?? "checked";
      if (scope !== "checked" && scope !== "all") {
        throw new HttpError(400, "which is checked or all");
      }
      return download(
        await exportChronology(s(), scope as ChronologyScope, {
          confirmSafety: flag(url, "confirmSafety"),
        }),
      );
    }),
  ];
}

function download(f: ExportFile): Response {
  return new Response(f.content, {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `attachment; filename="${f.filename}"`,
      "cache-control": "no-store",
    },
  });
}

export const exportErrors: ErrorMapper[] = [
  (e) =>
    e instanceof SafetyConfirmError
      ? {
        status: 409,
        body: {
          error: e.message,
          safetyConfirm: true,
          // Labels only (what Claude already sees); never the value. `addresses` keeps its old
          // name, but lists every protected detail (an address, phone, email, number…).
          addresses: e.hits.map((h) => ({
            label: h.label,
            person: h.person,
            kind: h.kind,
            via: h.via,
          })),
        },
      }
      : undefined,
];
