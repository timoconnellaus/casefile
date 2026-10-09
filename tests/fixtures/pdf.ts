/**
 * Builds small SYNTHETIC PDFs for tests (ADR 11): Helvetica text lines, empty pages (as a scan
 * would look to a text reader) and filled-in text form fields. Written by hand so tests need no
 * PDF writer and every byte is known.
 */

export interface PdfPageSpec {
  /** Lines of text, top to bottom. An empty string leaves a paragraph gap. */
  lines?: string[];
  /** Filled-in text fields on the page. */
  fields?: { name: string; label?: string; value: string }[];
}

const WIN_ANSI: Record<string, number> = { "—": 0x97, "–": 0x96, "’": 0x92, "‘": 0x91 };

/** A PDF literal string in WinAnsi, escaped. */
function lit(s: string): string {
  let out = "(";
  for (const ch of s) {
    const c = WIN_ANSI[ch] ?? ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else out += "\\" + (c & 0xff).toString(8).padStart(3, "0");
  }
  return out + ")";
}

/** A PDF text string (outside content streams): UTF-16BE with a byte-order mark, in hex. */
function textString(s: string): string {
  let hex = "<FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return hex + ">";
}

/** A PDF with one page per spec. */
export function buildPdf(pages: PdfPageSpec[]): Uint8Array {
  const objs: string[] = [];
  /** Adds an object; returns its number. */
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add("");
  const pagesObj = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const kids: number[] = [];
  const fieldRefs: number[] = [];
  for (const p of pages) {
    const ops = (p.lines ?? []).map((l, i) =>
      l === "" ? "" : `BT /F1 11 Tf 72 ${740 - i * 14} Td ${lit(l)} Tj ET`
    ).filter(Boolean).join("\n");
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    const page = add("");
    const annots = (p.fields ?? []).map((f, i) =>
      add(
        `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${textString(f.name)}${
          f.label ? ` /TU ${textString(f.label)}` : ""
        } /V ${textString(f.value)} /Rect [72 ${200 - i * 30} 400 ${
          220 - i * 30
        }] /P ${page} 0 R >>`,
      )
    );
    fieldRefs.push(...annots);
    objs[page - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R` +
      (annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : "") + " >>";
    kids.push(page);
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R` +
    (fieldRefs.length
      ? ` /AcroForm << /Fields [${fieldRefs.map((r) => `${r} 0 R`).join(" ")}] >>`
      : "") +
    " >>";
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${
    kids.map((k) => `${k} 0 R`).join(" ")
  }] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character above is one byte (literal strings are escaped to ASCII).
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/** Text lines of a synthetic document as a one-page-per-chunk PDF. */
export function textPdf(text: string, linesPerPage = 45): Uint8Array {
  const lines = text.replace(/\n$/, "").split("\n");
  const pages: PdfPageSpec[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push({ lines: lines.slice(i, i + linesPerPage) });
  }
  return buildPdf(pages);
}
