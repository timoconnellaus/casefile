/**
 * A small, dependency-free RTF writer for exports that open in Word (ADR 0021). It knows only the
 * few shapes casefile needs: paragraphs (plain, bold, centred, numbered with a hanging indent) and
 * simple tables.
 *
 * Every piece of text goes through `rtfText`, which escapes the three RTF special characters
 * (`\`, `{`, `}`), turns line breaks and tabs into control words, drops other control characters,
 * and writes everything outside printable ASCII as `\uN?` (UTF-16 code units, so characters
 * outside the Basic Multilingual Plane become surrogate pairs). Text can therefore never open a
 * group or start a control word: braces and backslashes in a paragraph Claude wrote come out as
 * literal characters. Control words are only ever written by this module.
 */
import type { ExportBlock } from "./blocks.ts";

/** One block of an RTF document (the shape every Word export is built from, `blocks.ts`). */
export type RtfBlock = ExportBlock;

/** Escape plain text for an RTF body. Output is 7-bit ASCII. */
export function rtfText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5c) out += "\\\\";
    else if (c === 0x7b) out += "\\{";
    else if (c === 0x7d) out += "\\}";
    else if (c === 0x0a) out += "\\line ";
    else if (c === 0x0d) {
      // \r\n is one break; a lone \r is one too.
      if (text.charCodeAt(i + 1) !== 0x0a) out += "\\line ";
    } else if (c === 0x09) out += "\\tab ";
    else if (c < 0x20 || c === 0x7f) continue;
    else if (c < 0x80) out += text[i];
    // \uN takes a signed 16-bit value; "?" is the fallback for readers without Unicode (\uc1).
    else out += `\\u${c > 0x7fff ? c - 0x10000 : c}?`;
  }
  return out;
}

const ALIGN = { left: "\\ql", centre: "\\qc", right: "\\qr" } as const;

function para(b: Extract<RtfBlock, { type: "para" }>): string {
  const size = Math.round((b.size ?? 12) * 2);
  const after = Math.round((b.after ?? 12) * 20);
  const fmt = `${b.bold ? "\\b" : ""}${b.italic ? "\\i" : ""}`;
  return `\\pard\\plain\\f0\\fs${size}\\sa${after}${ALIGN[b.align ?? "left"]}` +
    `${fmt ? `${fmt} ` : " "}${rtfText(b.text)}\\par\n`;
}

function numbered(b: Extract<RtfBlock, { type: "numbered" }>): string {
  // Hanging indent: the number sits at the margin, the text (and its wrapped lines) at 1 cm.
  return `\\pard\\plain\\f0\\fs24\\sa240\\fi-567\\li567\\tx567 ` +
    `${Math.trunc(b.n)}.\\tab ${rtfText(b.text)}\\par\n`;
}

function table(b: Extract<RtfBlock, { type: "table" }>): string {
  const cols = b.widths.length;
  let edge = 0;
  const cells = b.widths.map((w) => {
    edge += Math.max(200, Math.trunc(w));
    return `\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10` +
      `\\clbrdrr\\brdrs\\brdrw10\\cellx${edge}`;
  }).join("");
  const row = (values: string[], header: boolean) => {
    const vs = Array.from({ length: cols }, (_, i) => values[i] ?? "");
    return `\\trowd\\trgaph108\\trleft0${header ? "\\trhdr" : ""}${cells}\n` +
      vs.map((v) => `\\pard\\plain\\intbl\\f0\\fs20${header ? "\\b" : ""} ${rtfText(v)}\\cell`)
        .join("") +
      "\\row\n";
  };
  return row(b.header, true) + b.rows.map((r) => row(r, false)).join("") + "\\pard\n";
}

/**
 * A complete RTF document (A4, 2.5 cm margins, Times New Roman 12 pt). `landscape` turns the page
 * for wide tables.
 */
export function rtfDocument(blocks: RtfBlock[], opts: { landscape?: boolean } = {}): string {
  const [w, h] = opts.landscape ? [16838, 11906] : [11906, 16838];
  const head = "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\n" +
    "{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}\n" +
    `\\paperw${w}\\paperh${h}\\margl1418\\margr1418\\margt1418\\margb1418` +
    `${opts.landscape ? "\\landscape" : ""}\\widowctrl\n`;
  const body = blocks.map((b) =>
    b.type === "para" ? para(b) : b.type === "numbered" ? numbered(b) : table(b)
  ).join("");
  return `${head}${body}}\n`;
}

/**
 * The text an RTF reader shows for a document this module wrote: escapes undone, `\par` and
 * `\row` as line breaks, `\line` as a line break, `\tab` and `\cell` as a tab, the font table
 * skipped. Used to check the export as the reader will see it (the safety warning).
 */
export function rtfToText(rtf: string): string {
  let out = "";
  let depth = 0;
  let skipFrom = -1;
  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === "{" || c === "}") {
      depth += c === "{" ? 1 : -1;
      if (skipFrom >= 0 && depth < skipFrom) skipFrom = -1;
      i++;
      continue;
    }
    if (c === "\\") {
      const n = rtf[i + 1];
      if (n === "\\" || n === "{" || n === "}") {
        if (skipFrom < 0) out += n;
        i += 2;
        continue;
      }
      const m = /^([a-z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
      if (!m) {
        i += 2;
        continue;
      }
      i += 1 + m[0].length;
      const w = m[1];
      if (w === "fonttbl") skipFrom = depth;
      if (skipFrom >= 0) continue;
      if (w === "par" || w === "row" || w === "line") out += "\n";
      else if (w === "tab" || w === "cell") out += "\t";
      else if (w === "u") {
        const v = Number(m[2]);
        out += String.fromCharCode(v < 0 ? v + 0x10000 : v);
        if (rtf[i] === "?") i++;
      }
      continue;
    }
    if (c !== "\n" && c !== "\r" && skipFrom < 0 && depth > 0) out += c;
    i++;
  }
  return out;
}
