# 26. Word (.docx) export with the `docx` package, written in a worker with no permissions

Date: 2026-10-09
Status: Accepted

## Context

ADR 21 made exports open in Word through a dependency-free RTF writer and deferred `.docx`
because there was "no approved dependency; zip and docx generation is unreviewed surface". RTF
works, but Word on some setups opens it in a compatibility mode, Pages and Google Docs handle it
less well than `.docx`, and court staff and lawyers expect a Word document. The user decided to
add `.docx` with the `docx` npm package, pinned exactly, and not to add PDF: the user opens the
`.docx` in Word and uses Save as PDF.

An export holds real names (it is re-identified in the app, ADR 5) and is made in the process
that holds the vault's data key, so the library needs the same care as the PDF parser (ADR 23).

## Review of `docx` (2026-10-09)

- **Package and version.** [`docx`](https://www.npmjs.com/package/docx) by Dolan Miu
  (github.com/dolanmiu/docx), the most used JavaScript `.docx` writer. Pinned to **9.7.2**
  (published 23 September 2026). The latest, 9.9.0, was 2 days old at review; 9.8.x changed only
  a dev type dependency and was under 2 weeks old. A version that has been public for a while
  gives a malicious release time to be noticed and pulled. The registry entry carries npm
  signatures and a provenance attestation.
- **Maintenance.** Releases every few weeks through 2026 (9.6.0 in February to 9.9.0 in October),
  one maintainer with many contributors, TypeScript with type definitions shipped.
- **Licence.** MIT. Its tree: `jszip` (MIT or GPL-3.0-or-later; casefile uses it under MIT),
  `pako` (MIT and Zlib), `sax` (BlueOak-1.0.0), `inherits` and `minimalistic-assert` (ISC), the
  rest MIT. All permissive and compatible with casefile's licence.
- **Dependencies.** Declared: `jszip`, `xml`, `xml-js`, `nanoid`, `hash.js` and `@types/node`
  (types only). With their own dependencies that is 22 packages counting `docx`, all in `deno.lock` with
  integrity hashes. The ES module Deno loads (`dist/index.mjs`, about 1 MB) is a **self-contained
  bundle**: it has no `import` statements, so at run time none of the declared packages is
  loaded; they are downloaded and pinned but unused.
- **Install scripts.** None in `docx` or anywhere in its tree (no `preinstall`, `install`,
  `postinstall` or `prepare`; `deno.lock` marks none of them with `scripts`). Deno does not run
  lifecycle scripts without `--allow-scripts` in any case. A test walks the tree in `deno.lock`
  and fails if one appears.
- **Network and other access.** The bundle has no `fetch`, `XMLHttpRequest`, `WebSocket`, no
  `node:http`/`https`/`net`/`tls`/`child_process`, and reads no environment variables. It has a
  handful of `Function(...)` calls, all in bundled ES polyfills (`function-bind`,
  `get-intrinsic`, `is-generator-function`, `setimmediate`) building fixed source strings, never
  text from the document. It probes `__proto__`, which Deno disables; output was checked anyway.
- **Output.** For casefile's input (paragraphs and tables of plain text) it writes the standard
  parts: `document.xml`, styles, numbering, settings, `core.xml` and `app.xml`. It escapes `&`,
  `<` and `>` in text. It does **not** remove characters XML cannot hold (control characters, a
  lone surrogate), which would make Word refuse the file, so casefile does that first.

## Decision

**Add `npm:docx@9.7.2`** (exact, in `deno.json`, resolved in `deno.lock`). A test checks the pin.
Changing the version needs the same review, recorded as an amendment here.

**Run it with no permissions.** `src/core/export/docx_worker.ts` is the only module that imports
`docx`. `docx.ts` starts it as a Web Worker with `permissions: "none"` (as PDF import does,
ADR 23), sends it the export's blocks (plain text, already re-identified, citations converted
and gates passed) and gets back the file's bytes or a bare failure; the library's own messages
are never passed on. Even a compromised release could not read the vault or the case folder,
reach the network or run a program; it could only write a bad file, which the user opens in
Word. The worker is terminated after 60 s. The desktop build includes the worker
(`scripts/build_desktop.ts`).

**One layout for both Word formats.** The blocks RTF already used (`ExportBlock` in
`export/blocks.ts`: paragraphs, numbered paragraphs, tables) are written by `rtf.ts` or the
worker. The `.docx` has the same page (A4, 2.5 cm margins, Times New Roman 12 pt, landscape for
the chronology). Paragraph numbers are text with a hanging indent, not Word's list numbering, so
the number in the file is always the number casefile exported. Text is made safe for XML first
(`xmlSafe`: control characters other than line feed and tab dropped, U+FFFE/U+FFFF dropped, a
lone surrogate becomes U+FFFD); line feeds become line breaks and tabs become tabs. Document
properties name casefile as creator and last editor, never a person, and no title is set.

**Formats.** `GET /api/drafts/:id/export?format=docx` (Markdown stays the default; `rtf`, `text`
and `markdown` are unchanged) and `GET /api/chronology/export?format=docx` (`rtf` stays the
default). The gates, the safety confirmation, the download headers and the counts-only log rows
(`format: "docx"`) are those of ADR 21. The app's export buttons put "Export for Word (.docx)"
first and keep "Export as .rtf"; the help text says to open the `.docx` in Word and Save as PDF.
There is no PDF export.

**The safety check reads the `.docx` as Word will.** `docxToText` unzips the file with casefile's
own small reader (stored and deflated entries, `DecompressionStream`; no dependency) and takes the
text of `word/document.xml` (paragraphs as lines, `<w:tab/>` and `<w:br/>`, entities undone). The
protected-detail check (ADR 21) runs on that text and on the strings the file was built from, so
nothing the library does to the text can hide a protected address. Tests read every export back
this way, and convert one with LibreOffice when it is installed.

## Consequences

- One more dependency tree (22 packages, about 18 MB unpacked for `docx` itself, mostly its
  several bundle formats) in the lock file and the desktop app.
- `ExportFile` stays text; a `.docx` is a `BinaryExportFile` (`Uint8Array`). The UI saves it from
  the response's bytes.
- The RTF writer stays as a fallback and for anyone without Word; ADR 21's "`.docx` remains
  deferred" no longer holds. PDF export stays out on purpose.
- A docx failure (worker unavailable, time limit) answers 500 with "Try the .rtf export instead";
  nothing is logged as exported.
