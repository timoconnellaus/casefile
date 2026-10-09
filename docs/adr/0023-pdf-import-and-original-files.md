# 23. PDF import: text layer only, parsed in a worker with no permissions, original kept in the vault

Date: 2026-10-09
Status: Accepted

## Context

Family-law documents usually arrive as PDFs: court forms, orders, letters from the other side's
lawyer, emailed reports. Until now import took only `.txt` and `.md`, and the user had to open
each PDF, copy its text and use Paste text (PLAN, deferred list). That loses the line breaks,
silently drops filled-in form fields, and leaves the original outside the case.

Two things kept PDF deferred: it needs an extractor dependency, and keeping the original means
binary files in the vault, which is a format change. A PDF is also untrusted input in a complex
format, parsed in the process that holds the vault's data key.

## Decision

**Text layer only.** casefile reads the text a PDF already has. It does not OCR. A PDF with no
text on any page (a scan) is refused with a message that says so and points to Paste text; a PDF
where only some pages have no text is imported, and the pages without text are recorded and shown
on the review and document screens ("casefile could not read pages 3 and 4"). Nothing on those
pages reaches Claude, so this is a completeness warning, not a leak.

**Extractor.** `npm:unpdf` (Mozilla's pdf.js, serverless build, no dependencies), pinned to a 1.x
version. `src/core/pdf.ts` runs it in a **Web Worker with `permissions: "none"`** (Deno's
`worker-options` unstable feature), so a parser bug reached by a crafted PDF cannot read the vault, the
case folder or the network, or run programs. The worker is terminated after a time limit (60 s).
The bundled pdf.js (5.x) has no `new Function` path at all (the font-data eval of CVE-2024-4367
is gone; PostScript functions are interpreted or compiled to WebAssembly). It runs with font
loading off and logging off (`verbosity: 0`), so nothing from a document reaches the console
(ADR 13). The worker returns error **codes** only, never pdf.js messages.

Limits: at most 14 MB (the base64 JSON body must fit the API's 20 MB limit) and 1,000 pages.
Password-protected PDFs are refused ("remove the password, then add it again").

**Text.** Lines follow pdf.js's end-of-line marks, a blank line is kept where the gap between
lines is clearly larger than the text (a paragraph break), pages are separated by a blank line,
trailing spaces and control characters are removed, and the `ﬁ`-style ligatures are expanded so
names match. Filled-in **form fields** (text and choice fields) are not part of a page's text, so
they are added after that page's text as `Label: value` lines (the field's tooltip, else its
name). Everything then goes through `importText`'s detection like any other text; the extracted
text is the document's `original`, and line numbers (ADR 5, 10) count lines of that text. PDF
metadata (author, title, producer), comments and attachments are not read.

**Original file in the vault.** The PDF's bytes are kept as their own vault file,
`original-<id>` (e.g. `original-d004`), encrypted like every vault file (ADR 4). It is not named
`doc-…`, because documents are listed by that prefix. The stored document records
`file: { type: "pdf", size, pages, emptyPages, formFields }`. The original is written before the
document; if the document cannot be saved the original is removed. Deleting a document deletes its
original. The original is **never** written to public.db and the CLI cannot reach it (ADR 3); the
`document_imported` log row adds only `format: "pdf"` and the page count.

The vault's file listing shows which documents came from a PDF and roughly how big each is. That is
the same kind of fact the `doc-` files already show (ADR 4: names and sizes are visible), and it
says nothing about the content.

**Viewing it.** `GET /api/docs/:id/original` returns the PDF (`application/pdf`, inline, named
`<id>.pdf`, never the title) to a signed-in caller only, with the usual security headers, so the
user can compare the extraction with the original. The review and document screens link to it.

**API.** `POST /api/docs/import-pdf` takes `{title, pdf (base64), batch?, origin?, source?}` and
answers like `/api/docs/import`, plus `pages` and `emptyPages`. An unreadable, encrypted, empty or
too-large PDF is a 422 with a `code`.

## Consequences

- The worker option is enabled in `deno.json` (`"unstable": ["worker-options"]`), not by a flag on
  each task, so every way of running the app picks it up: `deno task app`'s supervisor (whose child
  arguments are fixed in the running process, so a release restart could not add a flag), `dev`,
  `test` and `desktop`. Without it the worker cannot be made and PDF import fails closed with a 422,
  never by parsing in the main process. `deno task desktop` also needs
  `--include src/core/pdf_worker.ts`.
- The bundle grows by about 2 MB.
- OCR, `.docx` input and attaching originals to an exported affidavit remain deferred. The stored
  original is the groundwork for annexures.
- Text extraction can get reading order wrong in multi-column layouts and tables; the review screen
  shows the extracted text and links to the original so the user can see the difference.
