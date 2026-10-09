/**
 * Reads a PDF's text layer (ADR 23). Runs only as a Web Worker made by `pdf.ts` with
 * `permissions: "none"`: a crafted PDF that reaches a pdf.js bug here cannot read files, use the
 * network or run programs. It answers with page lines and form fields, or an error code; pdf.js's
 * own messages are never passed on (they could quote the document).
 */
/// <reference lib="deno.worker" />
import { getDocumentProxy } from "unpdf";

export type PdfErrorCode =
  | "not_pdf"
  | "encrypted"
  | "too_large"
  | "too_many_pages"
  | "no_text"
  | "timeout"
  | "unavailable";

export interface WorkerPage {
  lines: string[];
  /** Filled-in text and choice fields on this page: [label, value]. */
  fields: [string, string][];
}

export type WorkerReply = { ok: true; pages: WorkerPage[] } | { ok: false; code: PdfErrorCode };

export interface WorkerRequest {
  bytes: Uint8Array;
  maxPages: number;
}

interface TextItem {
  str: string;
  hasEOL: boolean;
  transform: number[];
  height: number;
}

interface Widget {
  subtype?: string;
  fieldType?: string;
  fieldName?: string;
  alternativeText?: string;
  fieldValue?: unknown;
}

/** A page's text items as lines, with an empty line where the gap is a paragraph break. */
function pageLines(items: TextItem[]): string[] {
  const lines: string[] = [];
  let cur = "";
  let lineY: number | null = null;
  let lineH = 0;
  let prevY: number | null = null;
  let prevH = 0;
  const end = () => {
    if (lineY !== null && prevY !== null) {
      const h = Math.max(lineH, prevH, 1);
      if (prevY - lineY > h * 1.9 && lines.length && lines.at(-1) !== "") lines.push("");
    }
    lines.push(cur);
    if (lineY !== null) {
      prevY = lineY;
      prevH = lineH;
    }
    cur = "";
    lineY = null;
    lineH = 0;
  };
  for (const it of items) {
    if (typeof it.str !== "string") continue; // marked-content boundaries
    if (it.str !== "" && lineY === null) {
      lineY = it.transform?.[5] ?? null;
      lineH = Math.abs(it.height || it.transform?.[3] || 0);
    }
    cur += it.str;
    if (it.hasEOL) end();
  }
  if (cur !== "") end();
  return lines;
}

function fieldValue(w: Widget): string | null {
  if (w.subtype !== "Widget" || (w.fieldType !== "Tx" && w.fieldType !== "Ch")) return null;
  const v = Array.isArray(w.fieldValue) ? w.fieldValue.join(", ") : w.fieldValue;
  return typeof v === "string" && v.trim() ? v : null;
}

async function read({ bytes, maxPages }: WorkerRequest): Promise<WorkerReply> {
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(bytes, {
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { ok: false, code: name === "PasswordException" ? "encrypted" : "not_pdf" };
  }
  if (doc.numPages > maxPages) return { ok: false, code: "too_many_pages" };
  const pages: WorkerPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const fields: [string, string][] = [];
    for (const w of await page.getAnnotations() as Widget[]) {
      const value = fieldValue(w);
      if (value === null) continue;
      fields.push([(w.alternativeText || w.fieldName || "Field").trim(), value]);
    }
    pages.push({ lines: pageLines(content.items as TextItem[]), fields });
    page.cleanup();
  }
  return { ok: true, pages };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  let reply: WorkerReply;
  try {
    reply = await read(e.data);
  } catch {
    reply = { ok: false, code: "not_pdf" };
  }
  self.postMessage(reply);
};
