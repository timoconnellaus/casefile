import { chronologyState, userRemoved } from "../checking.ts";
import { InvalidInputError } from "../publicdb.ts";
import type { CaseSession } from "../session.ts";
import type { WorkState } from "../states.ts";
import { formatDate } from "../summary.ts";
import { convertCitationsWith, describeSource } from "./annexures.ts";
import { type BinaryExportFile, type ExportFile, localDate } from "./draft.ts";
import type { ExportBlock } from "./blocks.ts";
import { DOCX_TYPE, docxDocument, docxToText } from "./docx.ts";
import { rtfDocument, rtfToText } from "./rtf.ts";
import { protectedAddressesIn, SafetyConfirmError } from "./safety.ts";

/**
 * The chronology as a Word table (RTF, ADR 0021, or .docx, ADR 0026). Either only the entries the user checked
 * against their sources, or every entry with the ones not checked marked. Whether an entry is
 * checked comes from the attestation ledger (`chronologyState`), never public.db's
 * `verified_at`; entries the user removed (the ledger's record) are left out, and Claude-removed
 * rows are not trusted to be gone. Citations become plain descriptions ("Text messages, March
 * 2025, line 3"). Logged with counts only.
 */

export type ChronologyScope = "checked" | "all";
export type ChronologyFormat = "rtf" | "docx";
export const CHRONOLOGY_FORMATS: ChronologyFormat[] = ["rtf", "docx"];

const MARK: Record<WorkState, string> = {
  checked: "Checked",
  to_check: "NOT CHECKED",
  changed: "NOT CHECKED (changed since you checked)",
  cant_check: "NOT CHECKED (can't check against its source)",
};

export async function exportChronology(
  session: CaseSession,
  scope: ChronologyScope,
  opts: { now?: Date; confirmSafety?: boolean; format?: ChronologyFormat } = {},
): Promise<ExportFile | BinaryExportFile> {
  if (scope !== "checked" && scope !== "all") {
    throw new InvalidInputError("Export which entries: checked or all");
  }
  const format = opts.format ?? "rtf";
  if (!CHRONOLOGY_FORMATS.includes(format)) {
    throw new InvalidInputError(`Bad export format; one of ${CHRONOLOGY_FORMATS.join(", ")}`);
  }
  const removed = await userRemoved(session);
  const rows: { date: string; what: string; source: string; added: string; state: WorkState }[] =
    [];
  let total = 0;
  const entries = session.store.listChronology({ includeRemoved: true })
    .filter((r) => !removed.chronology.has(r.id))
    .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id);
  for (const r of entries) {
    total++;
    const state = (await chronologyState(session, r)).state;
    if (scope === "checked" && state !== "checked") continue;
    const what = await convertCitationsWith(session, session.reidentify(r.description).text, {});
    const sources = await Promise.all(r.sources.map((s) => describeSource(session, s)));
    rows.push({
      date: formatDate(r.event_date),
      what,
      source: sources.join("; "),
      added: await session.isUserItem("chronology", r) ? "You" : "Claude",
      state,
    });
  }

  const now = opts.now ?? new Date();
  const unchecked = rows.filter((r) => r.state !== "checked").length;
  const blocks: ExportBlock[] = [
    { type: "para", text: "Chronology", bold: true, size: 14, after: 6 },
    {
      type: "para",
      text: scope === "checked"
        ? `Only the entries checked against their sources. Prepared ${formatDate(localDate(now))}.`
        : `Every entry. Entries marked NOT CHECKED have not been checked against their sources. ` +
          `Prepared ${formatDate(localDate(now))}.`,
      size: 10,
    },
  ];
  if (rows.length) {
    blocks.push({
      type: "table",
      widths: scope === "all" ? [1900, 5800, 3300, 900, 2100] : [1900, 7400, 3600, 1100],
      header: scope === "all"
        ? ["Date", "What happened", "Source", "Added by", "Checked"]
        : ["Date", "What happened", "Source", "Added by"],
      rows: rows.map((r) =>
        scope === "all"
          ? [r.date, r.what, r.source, r.added, MARK[r.state]]
          : [r.date, r.what, r.source, r.added]
      ),
    });
  } else {
    blocks.push({
      type: "para",
      text: scope === "checked" ? "No entry has been checked yet." : "The chronology is empty.",
    });
  }
  const content = format === "docx"
    ? await docxDocument(blocks, { landscape: true })
    : rtfDocument(blocks, { landscape: true });
  const hits = protectedAddressesIn(session, [
    typeof content === "string" ? rtfToText(content) : await docxToText(content),
    ...rows.flatMap((r) => [r.what, r.source]),
  ]);
  if (hits.length && !opts.confirmSafety) {
    session.log("user", "export_safety_warned", {
      what: "chronology",
      format,
      addresses: hits.length,
    });
    throw new SafetyConfirmError(hits);
  }
  session.log("user", "chronology_exported", {
    format,
    scope,
    entries: rows.length,
    unchecked,
    left_out: total - rows.length,
    ...(hits.length ? { safety_confirmed: hits.length } : {}),
  });
  const filename = `chronology-${scope}-${localDate(now)}.${format}`;
  return typeof content === "string"
    ? { filename, content, contentType: "application/rtf" }
    : { filename, content, contentType: DOCX_TYPE };
}
