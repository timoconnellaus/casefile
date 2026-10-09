// The file a document was imported from (ADR 23), for the review and document screens: what it
// was, a link to open it (from the vault, through the signed-in API), and the pages casefile
// couldn't read.
import { h } from "../dom.js";
import { Callout } from "./feedback.js";

/** "page 3", "pages 3 and 4", "pages 2, 5 and 7" */
function pages(ns) {
  const s = ns.map(String);
  return `${s.length === 1 ? "page" : "pages"} ${
    s.length <= 1 ? s.join("") : `${s.slice(0, -1).join(", ")} and ${s.at(-1)}`
  }`;
}

/**
 * "From a PDF, 4 pages · Open the original", plus a callout when some pages had no text.
 * Null for a document imported as text.
 * @param {string} docId
 * @param {{type: "pdf", pages: number, emptyPages: number[], formFields: number} | null} file
 */
export function OriginalFile(docId, file) {
  if (!file) return null;
  const facts = [`${file.pages} ${file.pages === 1 ? "page" : "pages"}`];
  if (file.formFields) {
    facts.push(
      file.formFields === 1
        ? "1 filled-in form field, added after the text of its page"
        : `${file.formFields} filled-in form fields, added after the text of their pages`,
    );
  }
  return h(
    "div",
    { class: "orig-file" },
    h(
      "p",
      { class: "muted small" },
      `Read from a PDF (${facts.join("; ")}). `,
      h(
        "a",
        {
          href: `/api/docs/${encodeURIComponent(docId)}/original`,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "Open the original PDF",
      ),
      " to check the text against it. The PDF is kept encrypted with the case; Claude never sees it.",
    ),
    file.emptyPages.length
      ? Callout({
        tone: "attention",
        title: `casefile couldn’t read ${pages(file.emptyPages)}`,
        children:
          "They have no text, probably because they are scans, so nothing on them is in this document. If they matter, copy their text from the original and add it with Paste text.",
      })
      : null,
  );
}
