/**
 * Area seed for the Documents list and Document view (W2-2). SYNTHETIC data only (ADR 11).
 *
 * Claude gives the shared documents a type and a date through the CLI (as it would after reading
 * them); the user does the same for the documents withheld from Claude, and tags a few. This gives
 * the list's Type filter, Tags, Date sort and "undated first" rule something to show.
 */
import type { SeedContext } from "../seed.ts";
import { fillerDate } from "./_canon.ts";

/** CANON documents: type, date and tags. */
const META: Record<string, { type: string; date: string; tags?: string[] }> = {
  D001: { type: "messages", date: "2025-03-15", tags: ["changeovers"] },
  D002: { type: "affidavit", date: "2025-04-02", tags: ["changeovers", "school"] },
  D003: { type: "email", date: "2025-02-11", tags: ["school"] },
  D004: { type: "school records", date: "2024-12-13", tags: ["school"] },
  D005: { type: "medical records", date: "2025-01-20", tags: ["medical"] },
  D006: { type: "letter", date: "2025-02-11", tags: ["changeovers"] },
  D007: { type: "subpoena", date: "2025-01-08" },
  D008: { type: "affidavit", date: "2025-05-20" },
  D009: { type: "report", date: "2025-06-30" },
  D010: { type: "notes", date: "2024-11-30", tags: ["changeovers"] },
  D011: { type: "medical certificate", date: "2025-03-29", tags: ["medical"] },
  D012: { type: "messages", date: "2025-04-30" },
  D013: { type: "emails", date: "2025-05-02" },
  D014: { type: "messages", date: "2025-03-31" },
};

export default async function documents(ctx: SeedContext) {
  const s = ctx.session;
  let claude = 0;
  let user = 0;
  for (const d of await s.listDocInfo()) {
    if (d.status !== "published") continue; // not reviewed yet: no type or date
    const n = Number(d.id.slice(1));
    const meta = META[d.id] ?? {
      type: n % 4 ? "messages" : "email",
      date: ((f) => `${f.year}-${f.month}-${f.day}`)(fillerDate(n)),
      tags: n % 9 === 0 ? ["changeovers"] : n % 13 === 0 ? ["swimming"] : [],
    };
    if (d.state === "shared") {
      // Claude read it and set its details through the CLI.
      if (META[d.id]) {
        await ctx.cli("docs", "meta", d.id, "--type", meta.type, "--date", meta.date);
      } else {
        s.store.setDocumentMeta(d.id, { doc_type: meta.type, doc_date: meta.date }, "claude");
      }
      claude++;
    } else {
      // Withheld or exposed: Claude can't read it, so the user set its details.
      s.store.setDocumentMeta(d.id, { doc_type: meta.type, doc_date: meta.date }, "user");
      user++;
    }
    for (const t of meta.tags ?? []) s.store.addTag(d.id, t, "user");
  }
  ctx.log(`document details: ${claude} set by Claude, ${user} by you`);
}
