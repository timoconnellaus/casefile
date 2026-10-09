/**
 * PDF import (ADR 23): the text a PDF already has, read by `pdf_worker.ts` in a Web Worker with no
 * permissions, and turned into the plain text casefile imports. No OCR: a PDF without text on any
 * page is refused, and pages without text are reported.
 */
import type { PdfErrorCode, WorkerPage, WorkerReply, WorkerRequest } from "./pdf_worker.ts";

export type { PdfErrorCode };

/** The largest PDF accepted. Its base64 JSON body must fit the API's 20 MB limit. */
export const MAX_PDF_BYTES = 14 * 1024 * 1024;
export const MAX_PDF_PAGES = 1000;
export const PDF_TIMEOUT_MS = 60_000;

/** What the vault's document records about the file it came from (`StoredDoc.file`). */
export interface PdfFileInfo {
  type: "pdf";
  size: number;
  pages: number;
  /** 1-based numbers of pages with no text (probably scanned): nothing on them was imported. */
  emptyPages: number[];
  formFields: number;
}

export interface PdfText {
  text: string;
  info: PdfFileInfo;
}

const MESSAGES: Record<PdfErrorCode, string> = {
  not_pdf: "This file can’t be read as a PDF. It may be damaged, or not really a PDF.",
  encrypted:
    "This PDF is protected with a password. Open it, save a copy without the password, then add that copy.",
  too_large: `This PDF is larger than ${
    MAX_PDF_BYTES / 1024 / 1024
  } MB. Split it into smaller PDFs, or copy its text and use Paste text.`,
  too_many_pages:
    `This PDF has more than ${MAX_PDF_PAGES} pages. Split it into smaller PDFs and add those.`,
  no_text:
    "This PDF has no text casefile can read; it is probably a scan or photo. casefile can’t read scans yet. If you can select the text in a PDF viewer, copy it and use Paste text.",
  timeout:
    "Reading this PDF took too long, so casefile stopped. Copy its text and use Paste text instead.",
  unavailable:
    "casefile couldn’t start its PDF reader, so the PDF was not read. Copy its text and use Paste text instead.",
};

export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(MESSAGES[code]);
    this.name = "PdfError";
  }
}

/** Whether `bytes` start like a PDF (`%PDF-` within the first 1 KB, as readers allow). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

/** One line as text: ligatures expanded, control characters and trailing space removed. */
function cleanLine(line: string): string {
  return line
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c])
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F­]/g, "")
    .replace(/\t/g, " ")
    .trimEnd();
}

/** The worker's pages as one text: pages and paragraphs separated by one empty line. */
export function pagesToText(pages: WorkerPage[]): { text: string; emptyPages: number[] } {
  const out: string[] = [];
  const emptyPages: number[] = [];
  const blank = () => {
    if (out.length && out.at(-1) !== "") out.push("");
  };
  pages.forEach((p, i) => {
    const lines = p.lines.map(cleanLine);
    const fields = p.fields.map((
      [label, value],
    ) => [cleanLine(label), ...value.replace(/\r\n?/g, "\n").split("\n").map(cleanLine)]).filter((
      [, ...v],
    ) => v.some((l) => l.trim()));
    if (!lines.some((l) => l.trim()) && !fields.length) {
      emptyPages.push(i + 1);
      return;
    }
    blank();
    for (const l of lines) l.trim() ? out.push(l) : blank();
    if (fields.length) {
      blank();
      for (const [label, first, ...rest] of fields) out.push(`${label}: ${first}`, ...rest);
    }
  });
  while (out.at(-1) === "") out.pop();
  return { text: out.join("\n"), emptyPages };
}

/** Run the worker on `bytes`; it is terminated when it answers or after `timeoutMs`. */
function runWorker(req: WorkerRequest, timeoutMs: number): Promise<WorkerReply> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./pdf_worker.ts", import.meta.url), {
      type: "module",
      // No file, network, environment or program access (needs --unstable-worker-options).
      deno: { permissions: "none" },
    } as WorkerOptions);
  } catch {
    return Promise.resolve({ ok: false, code: "unavailable" });
  }
  return new Promise<WorkerReply>((resolve) => {
    const done = (r: WorkerReply) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, code: "timeout" }), timeoutMs);
    worker.onmessage = (e: MessageEvent<WorkerReply>) => done(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      done({ ok: false, code: "not_pdf" });
    };
    worker.onmessageerror = () => done({ ok: false, code: "not_pdf" });
    worker.postMessage(req);
  });
}

/** The text of a PDF, or a `PdfError`. */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: { timeoutMs?: number; maxPages?: number } = {},
): Promise<PdfText> {
  if (bytes.length > MAX_PDF_BYTES) throw new PdfError("too_large");
  if (!looksLikePdf(bytes)) throw new PdfError("not_pdf");
  const reply = await runWorker(
    // A copy, so pdf.js (which may detach its input) never touches the caller's bytes.
    { bytes: bytes.slice(), maxPages: opts.maxPages ?? MAX_PDF_PAGES },
    opts.timeoutMs ?? PDF_TIMEOUT_MS,
  );
  if (!reply.ok) throw new PdfError(reply.code);
  const { text, emptyPages } = pagesToText(reply.pages);
  if (!text.trim()) throw new PdfError("no_text");
  return {
    text,
    info: {
      type: "pdf",
      size: bytes.length,
      pages: reply.pages.length,
      emptyPages,
      formFields: reply.pages.reduce((n, p) => n + p.fields.length, 0),
    },
  };
}
