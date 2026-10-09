/**
 * The layout every Word export is built from (ADR 0021, ADR 0026): a list of blocks that
 * `rtf.ts` writes as RTF and `docx.ts` as a Word document. Text is plain (not RTF or XML); each
 * writer escapes it.
 */
export type ExportBlock =
  | {
    type: "para";
    text: string;
    bold?: boolean;
    italic?: boolean;
    align?: "left" | "centre" | "right";
    /** Font size in points (default 12). */
    size?: number;
    /** Space after, in points (default 12). */
    after?: number;
  }
  | { type: "numbered"; n: number; text: string }
  | {
    type: "table";
    /** Column widths in twips (1/1440 inch); the total should fit the page (about 9000). */
    widths: number[];
    header: string[];
    rows: string[][];
  };
