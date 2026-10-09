/**
 * Word documents (.docx) for exports (ADR 0026). The `docx` package writes them, in
 * `docx_worker.ts`, a Web Worker with `permissions: "none"` (like PDF import, ADR 23): the
 * library and the zip code bundled in it never run with the app's access to the vault, the case
 * folder or the network. The worker gets the export's blocks (plain text, already re-identified
 * and checked) and returns bytes.
 *
 * `docxToText` reads a .docx back (its own small zip reader; no dependency), so the export's
 * safety check sees the text the way Word will show it (ADR 0021).
 */
import type { ExportBlock } from "./blocks.ts";
import type { DocxReply, DocxRequest } from "./docx_worker.ts";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_TIMEOUT_MS = 60_000;

export class DocxError extends Error {
  constructor() {
    super("casefile could not make the Word document. Try the .rtf export instead.");
    this.name = "DocxError";
  }
}

function runWorker(req: DocxRequest, timeoutMs: number): Promise<DocxReply> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./docx_worker.ts", import.meta.url), {
      type: "module",
      // No file, network, environment or program access (needs --unstable-worker-options).
      deno: { permissions: "none" },
    } as WorkerOptions);
  } catch {
    return Promise.resolve({ ok: false });
  }
  return new Promise<DocxReply>((resolve) => {
    const done = (r: DocxReply) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false }), timeoutMs);
    worker.onmessage = (e: MessageEvent<DocxReply>) => done(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      done({ ok: false });
    };
    worker.onmessageerror = () => done({ ok: false });
    worker.postMessage(req);
  });
}

/**
 * A complete .docx (A4, 2.5 cm margins, Times New Roman 12 pt), the same layout as
 * `rtfDocument`. `landscape` turns the page for wide tables.
 */
export async function docxDocument(
  blocks: ExportBlock[],
  opts: { landscape?: boolean; timeoutMs?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const reply = await runWorker(
    { blocks, landscape: !!opts.landscape },
    opts.timeoutMs ?? DOCX_TIMEOUT_MS,
  );
  if (!reply.ok || !(reply.bytes instanceof Uint8Array) || !looksLikeZip(reply.bytes)) {
    throw new DocxError();
  }
  return reply.bytes;
}

function looksLikeZip(b: Uint8Array): boolean {
  return b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * Text that XML can hold: control characters other than line feed and tab are dropped, as are
 * U+FFFE and U+FFFF, and a lone surrogate becomes U+FFFD (Word refuses a file with any of them).
 * The library escapes `&`, `<` and `>`.
 */
export function xmlSafe(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) !== 0x0a) out += "\n";
    } else if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f) continue;
    else if (c === 0xfffe || c === 0xffff) continue;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else out += "\uFFFD";
    } else if (c >= 0xdc00 && c <= 0xdfff) out += "\uFFFD";
    else out += text[i];
  }
  return out;
}

// ── reading a .docx back ────────────────────────────────────────────────────

/** The files in a zip archive, by name (stored or deflated entries only). */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error("bad zip entry");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) {
      const stream = new Blob([data.slice()]).stream().pipeThrough(
        new DecompressionStream("deflate-raw"),
      );
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    } else throw new Error(`zip method ${method}`);
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (all, e: string) => {
    if (e[0] !== "#") return ENTITIES[e] ?? all;
    const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

/**
 * The text Word shows for the body of a .docx: each paragraph on its own line, `<w:tab/>` as a
 * tab and `<w:br/>` as a line break, escapes undone. Used to check the export as its reader sees
 * it (the safety warning) and by the tests.
 */
export async function docxToText(bytes: Uint8Array): Promise<string> {
  const xml = (await unzip(bytes)).get("word/document.xml");
  if (!xml) throw new Error("no word/document.xml");
  const doc = new TextDecoder().decode(xml);
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:br\s[^>]*\/>|<\/w:p>/g;
  for (const m of doc.matchAll(re)) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[0] === "<w:tab/>") out += "\t";
    else if (m[0] === "</w:p>") out += "\n";
    else out += "\n";
  }
  return out;
}
