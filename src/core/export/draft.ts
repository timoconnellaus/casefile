import {
  type DraftHeading,
  draftOverview,
  EMPTY_HEADING,
  ExportBlockedError,
  ExportNeedsConfirmError,
  getDraftHeading,
} from "../drafting.ts";
import { type DraftKind, InvalidInputError } from "../publicdb.ts";
import type { CaseSession } from "../session.ts";
import type { ParaState } from "../states.ts";
import { convertCitationsWith, getAnnexureMarks } from "./annexures.ts";
import type { ExportBlock } from "./blocks.ts";
import { DOCX_TYPE, docxDocument, docxToText } from "./docx.ts";
import { rtfDocument, rtfToText } from "./rtf.ts";
import { protectedAddressesIn, SafetyConfirmError, unescapeMarkdown } from "./safety.ts";

/**
 * Exporting a draft for the user to save (ADR 0009, ADR 0021, ADR 0026): Markdown, plain text,
 * RTF that opens in Word, or a Word document (.docx). Nothing is written to disk: the app delivers the content as a download, never
 * into the case folder (ADR 0003). The filename carries no names.
 *
 * The gates are the drafting gates (`draftOverview`): an affidavit is blocked while a paragraph
 * Claude drafted is not validly adopted or holds a placeholder, any draft while a label cannot be
 * re-identified, and other kinds' flags need `confirm`. On top of those, an export that includes
 * a protected address needs `confirmSafety` (`SafetyConfirmError` otherwise).
 *
 * Affidavits get the heading from the vault, numbered paragraphs, a jurat and
 * "[check against the Court's current form]" markers. Citations become "annexure AT-1" for a
 * document the user marked, otherwise "Title, line N".
 */

export type DraftExportFormat = "markdown" | "text" | "rtf" | "docx";
export const DRAFT_EXPORT_FORMATS: DraftExportFormat[] = ["markdown", "text", "rtf", "docx"];

export interface ExportFile {
  filename: string;
  content: string;
  contentType: string;
}

/** A binary download (.docx). */
export interface BinaryExportFile {
  filename: string;
  content: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export const CHECK_FORM = "[check against the Court's current form]";
export const COURT = "FEDERAL CIRCUIT AND FAMILY COURT OF AUSTRALIA";

const CONTENT_TYPES: Record<DraftExportFormat, string> = {
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
  rtf: "application/rtf",
  docx: DOCX_TYPE,
};
const EXT: Record<DraftExportFormat, string> = {
  markdown: "md",
  text: "txt",
  rtf: "rtf",
  docx: "docx",
};

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface AffidavitParts {
  fileNumber: string;
  applicant: string;
  respondent: string;
  opening: string;
  jurat: string[];
}

function affidavitParts(session: CaseSession, h: DraftHeading): AffidavitParts {
  const name = (role: string | null, fallback: string) =>
    role ? (session.registry.resolve(role, "full") ?? fallback) : fallback;
  const oathWords = h.oath === "affirmed"
    ? "affirm and say"
    : h.oath === "sworn"
    ? "make oath and say"
    : "[make oath / affirm] and say";
  const how = h.oath === "affirmed"
    ? "Affirmed"
    : h.oath === "sworn"
    ? "Sworn"
    : "Sworn / affirmed";
  return {
    fileNumber: `File number: ${h.fileNumber ?? "[file number]"}`,
    applicant: `Applicant: ${name(h.applicant, "[applicant]")}`,
    respondent: `Respondent: ${name(h.respondent, "[respondent]")}`,
    opening: `I, ${name(h.deponent, "[full name]")}, of ${h.address ?? "[address]"}, ${
      h.occupation ?? "[occupation]"
    }, ${oathWords}:`,
    jurat: [
      `${how} by the deponent at [place] on [date] ${CHECK_FORM}`,
      "Signature of deponent: ____________________",
      "Before me: ____________________ [name and qualification of witness]",
    ],
  };
}

function textLayout(
  kind: DraftKind,
  title: string,
  paras: string[],
  format: "markdown" | "text",
  a: AffidavitParts | null,
): string {
  const numbered = kind === "affidavit";
  const blocks = paras.map((text, i) => {
    const t = text.trim();
    if (!numbered) return t;
    const prefix = `${i + 1}. `;
    // Continuation lines line up under the paragraph text (and stay inside a Markdown list item).
    const indent = format === "markdown" ? " ".repeat(prefix.length) : "";
    return prefix + t.split("\n").join(`\n${indent}`);
  });
  const lines = (ls: string[]) => ls.join(format === "markdown" ? "  \n" : "\n");
  const parts = [format === "markdown" ? `# ${title.trim()}` : title.trim()];
  if (a) {
    parts.push(
      lines([`${COURT} ${CHECK_FORM}`, a.fileNumber, a.applicant, a.respondent, a.opening]),
    );
  }
  parts.push(...blocks);
  if (a) parts.push(lines(a.jurat));
  return `${parts.join("\n\n")}\n`;
}

/** The Word layout (RTF and .docx share it). */
function wordBlocks(title: string, paras: string[], a: AffidavitParts | null): ExportBlock[] {
  const blocks: ExportBlock[] = [];
  if (a) {
    blocks.push(
      { type: "para", text: COURT, bold: true, align: "centre", after: 0 },
      { type: "para", text: CHECK_FORM, italic: true, align: "centre", size: 10 },
      { type: "para", text: a.fileNumber, after: 0 },
      { type: "para", text: a.applicant, after: 0 },
      { type: "para", text: a.respondent },
      { type: "para", text: title.trim(), bold: true, align: "centre" },
      { type: "para", text: a.opening },
    );
    paras.forEach((t, i) => blocks.push({ type: "numbered", n: i + 1, text: t.trim() }));
    blocks.push({ type: "para", text: "" });
    for (const j of a.jurat) blocks.push({ type: "para", text: j, after: 18 });
  } else {
    blocks.push({ type: "para", text: title.trim(), bold: true, size: 14 });
    for (const t of paras) blocks.push({ type: "para", text: t.trim() });
  }
  return blocks;
}

interface DraftExportOptions {
  now?: Date;
  confirm?: boolean;
  confirmSafety?: boolean;
}

/** Export one draft. See the module comment for the gates. */
export async function exportDraftFile(
  session: CaseSession,
  draftId: number,
  format: "docx",
  opts?: DraftExportOptions,
): Promise<BinaryExportFile>;
export async function exportDraftFile(
  session: CaseSession,
  draftId: number,
  format: "markdown" | "text" | "rtf",
  opts?: DraftExportOptions,
): Promise<ExportFile>;
export async function exportDraftFile(
  session: CaseSession,
  draftId: number,
  format: DraftExportFormat,
  opts?: DraftExportOptions,
): Promise<ExportFile | BinaryExportFile>;
export async function exportDraftFile(
  session: CaseSession,
  draftId: number,
  format: DraftExportFormat,
  opts: DraftExportOptions = {},
): Promise<ExportFile | BinaryExportFile> {
  if (!DRAFT_EXPORT_FORMATS.includes(format)) {
    throw new InvalidInputError(`Bad export format; one of ${DRAFT_EXPORT_FORMATS.join(", ")}`);
  }
  const ov = await draftOverview(session, draftId);
  const { check } = ov;
  const stateCount = (s: ParaState) => ov.info.filter((p) => p.state === s).length;

  if (check.blockers.length || check.badTokens.length) {
    const needsReview = [
      ...new Set(
        check.blockers.filter((b) => b.reason !== "placeholder").map((b) => b.paragraph),
      ),
    ];
    const placeholders = check.blockers.filter((b) => b.reason === "placeholder")
      .map((b) => b.paragraph);
    session.log("user", "export_blocked", {
      draft: draftId,
      kind: check.kind,
      format,
      ...(check.kindChanged ? { stored_kind_changed: true } : {}),
      needs_review: needsReview,
      placeholders,
      bad_tokens: check.badTokens.length,
    });
    throw new ExportBlockedError(draftId, needsReview, check.badTokens, placeholders);
  }
  if (check.flags.length && !opts.confirm) throw new ExportNeedsConfirmError(draftId, check.flags);

  const marks = await getAnnexureMarks(session, draftId);
  const title = session.reidentify(session.store.getDraft(draftId).title).text;
  const bodies = await Promise.all(
    ov.info.map((p) => convertCitationsWith(session, session.reidentify(p.para.body).text, marks)),
  );
  const affidavit = check.kind === "affidavit";
  const heading = affidavit ? (await getDraftHeading(session, draftId)) ?? EMPTY_HEADING : null;
  const parts = heading ? affidavitParts(session, heading) : null;

  const word = format === "rtf" || format === "docx" ? wordBlocks(title, bodies, parts) : null;
  const content = format === "docx"
    ? await docxDocument(word!)
    : format === "rtf"
    ? rtfDocument(word!)
    : textLayout(check.kind, title, bodies, format as "markdown" | "text", parts);
  // The check reads the file as its reader will (RTF decoded, the .docx unzipped, Markdown
  // unescaped) and the strings it was built from.
  const shown = typeof content !== "string"
    ? await docxToText(content)
    : format === "rtf"
    ? rtfToText(content)
    : format === "markdown"
    ? unescapeMarkdown(content)
    : content;
  const hits = protectedAddressesIn(session, [
    shown,
    ...(typeof content === "string" ? [content] : []),
    title,
    ...bodies,
    ...(parts ? [parts.opening, parts.applicant, parts.respondent, parts.fileNumber] : []),
  ], heading);
  if (hits.length && !opts.confirmSafety) {
    session.log("user", "export_safety_warned", {
      draft: draftId,
      format,
      addresses: hits.length,
    });
    throw new SafetyConfirmError(hits);
  }

  const filename = `${check.kind}-${draftId}-${localDate(opts.now ?? new Date())}.${EXT[format]}`;
  const cited = bodies.join("\n").match(/\bannexure [A-Za-z0-9]/g)?.length ?? 0;
  session.log("user", "exported", {
    draft: draftId,
    kind: check.kind,
    format,
    paragraphs: ov.info.length,
    by_user: stateCount("user"),
    claude_adopted: stateCount("claude_adopted"),
    claude_rewritten: stateCount("claude_rewritten"),
    claude_unreviewed: stateCount("claude_needs_you"),
    ...(check.flags.length ? { flags_confirmed: check.flags.length } : {}),
    ...(Object.keys(marks).length ? { annexure_citations: cited } : {}),
    ...(hits.length ? { safety_confirmed: hits.length } : {}),
  });
  const contentType = CONTENT_TYPES[format];
  return typeof content === "string"
    ? { filename, content, contentType }
    : { filename, content, contentType };
}
