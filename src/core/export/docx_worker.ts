/**
 * Writes a Word document (.docx) from export blocks (ADR 0026). Runs only as a Web Worker made by
 * `docx.ts` with `permissions: "none"`: the `docx` package (and the zip code bundled in it) cannot
 * read files, use the network, read the environment or run programs, whatever it does. It answers
 * with the file's bytes, or `{ok: false}`; the library's own messages are never passed on (they
 * could quote the text).
 */
/// <reference lib="deno.worker" />
import {
  AlignmentType,
  Document,
  Packer,
  PageOrientation,
  Paragraph,
  Tab,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
} from "docx";
import type { ExportBlock } from "./blocks.ts";
import { xmlSafe } from "./docx.ts";

export interface DocxRequest {
  blocks: ExportBlock[];
  landscape: boolean;
}

export type DocxReply = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false };

/** A4 in twips, 2.5 cm margins, Times New Roman 12 pt: the same page as the RTF export. */
const A4 = { width: 11906, height: 16838 };
const MARGIN = 1418;
const HANG = 567;

const ALIGN = {
  left: AlignmentType.LEFT,
  centre: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
} as const;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  /** Half-points. */
  size?: number;
}

/** Runs for plain text: a line feed is a line break, a tab a tab. */
function runs(text: string, style: RunStyle): TextRun[] {
  return xmlSafe(text).split("\n").map((line, i) =>
    new TextRun({
      ...style,
      break: i > 0 ? 1 : undefined,
      children: line.split("\t").flatMap((part, j) => j > 0 ? [new Tab(), part] : [part]),
    })
  );
}

function block(b: ExportBlock): Paragraph | Table {
  if (b.type === "para") {
    return new Paragraph({
      alignment: ALIGN[b.align ?? "left"],
      spacing: { after: Math.round((b.after ?? 12) * 20) },
      children: runs(b.text, {
        bold: b.bold,
        italics: b.italic,
        size: Math.round((b.size ?? 12) * 2),
      }),
    });
  }
  if (b.type === "numbered") {
    // The number is text, not Word's list numbering, so it is the number the export says (and
    // the one a later "para 4" citation means), whatever Word does with lists.
    return new Paragraph({
      indent: { left: HANG, hanging: HANG },
      tabStops: [{ type: TabStopType.LEFT, position: HANG }],
      spacing: { after: 240 },
      children: [
        new TextRun({ text: `${Math.trunc(b.n)}.`, size: 24 }),
        new TextRun({
          size: 24,
          children: [new Tab()],
        }),
        ...runs(b.text, { size: 24 }),
      ],
    });
  }
  const widths = b.widths.map((w) => Math.max(200, Math.trunc(w)));
  const row = (values: string[], header: boolean) =>
    new TableRow({
      tableHeader: header,
      children: widths.map((w, i) =>
        new TableCell({
          width: { size: w, type: WidthType.DXA },
          children: [
            new Paragraph({ children: runs(values[i] ?? "", { bold: header, size: 20 }) }),
          ],
        })
      ),
    });
  return new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, w) => a + w, 0), type: WidthType.DXA },
    rows: [row(b.header, true), ...b.rows.map((r) => row(r, false))],
  });
}

async function write(req: DocxRequest): Promise<Uint8Array<ArrayBuffer>> {
  const children = req.blocks.map(block);
  // A table must not be the last thing in a Word document.
  if (children.at(-1) instanceof Table) children.push(new Paragraph({}));
  const doc = new Document({
    // Document properties carry no names: Word shows them under File > Info.
    creator: "casefile",
    lastModifiedBy: "casefile",
    styles: {
      default: { document: { run: { font: "Times New Roman", size: 24 } } },
    },
    sections: [{
      properties: {
        page: {
          size: {
            ...A4,
            orientation: req.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      children,
    }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

self.onmessage = async (e: MessageEvent<DocxRequest>) => {
  let reply: DocxReply;
  try {
    reply = { ok: true, bytes: await write(e.data) };
  } catch {
    reply = { ok: false };
  }
  self.postMessage(reply);
};
