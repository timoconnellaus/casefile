/**
 * PDF import's text extraction (ADR 23): the text layer, read in a worker with no permissions.
 * SYNTHETIC PDFs only (tests/fixtures/pdf.ts, ADR 11).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  extractPdfText,
  looksLikePdf,
  MAX_PDF_BYTES,
  pagesToText,
  PdfError,
} from "../src/core/pdf.ts";
import { AFFIDAVIT, IDS, PEOPLE } from "./fixtures/synthetic.ts";
import { buildPdf, textPdf } from "./fixtures/pdf.ts";

Deno.test("a PDF's text comes back line for line, with paragraph gaps kept", async () => {
  const r = await extractPdfText(textPdf(AFFIDAVIT));
  assertEquals(r.text, AFFIDAVIT.trimEnd());
  assertEquals(r.info, { type: "pdf", size: r.info.size, pages: 1, emptyPages: [], formFields: 0 });
  assert(r.info.size > 0);
});

Deno.test("pages are separated by one empty line; pages without text are listed", async () => {
  const pdf = buildPdf([
    { lines: [`Letter to ${PEOPLE.father}`] },
    {}, // a scanned page: no text layer
    { lines: ["Page three", "", "", "after a gap"] },
  ]);
  const r = await extractPdfText(pdf);
  assertEquals(r.text, `Letter to ${PEOPLE.father}\n\nPage three\n\nafter a gap`);
  assertEquals(r.info.pages, 3);
  assertEquals(r.info.emptyPages, [2]);
});

Deno.test("filled-in form fields are added after their page's text as Label: value", async () => {
  const pdf = buildPdf([{
    lines: ["Application for Consent Orders"],
    fields: [
      { name: "applicant_name", label: "Applicant’s full name", value: PEOPLE.mother },
      { name: "address", value: IDS.address },
      { name: "blank", value: "" },
    ],
  }]);
  const r = await extractPdfText(pdf);
  assertEquals(
    r.text,
    `Application for Consent Orders\n\nApplicant’s full name: ${PEOPLE.mother}\naddress: ${IDS.address}`,
  );
  assertEquals(r.info.formFields, 2);
});

Deno.test("a PDF with no text on any page is refused as a probable scan", async () => {
  const err = await assertRejects(() => extractPdfText(buildPdf([{}, {}])), PdfError);
  assertEquals(err.code, "no_text");
  assert(err.message.includes("scan"));
});

Deno.test("files that are not PDFs, or are damaged, are refused with a code, not pdf.js's words", async () => {
  const notPdf = await assertRejects(
    () => extractPdfText(new TextEncoder().encode(AFFIDAVIT)),
    PdfError,
  );
  assertEquals(notPdf.code, "not_pdf");
  const broken = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> garbage");
  assertEquals((await assertRejects(() => extractPdfText(broken), PdfError)).code, "not_pdf");
  assert(looksLikePdf(textPdf("x")));
  assert(!looksLikePdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
});

Deno.test("size and page limits are checked", async () => {
  const big = new Uint8Array(MAX_PDF_BYTES + 1);
  big.set(new TextEncoder().encode("%PDF-1.4\n"));
  assertEquals((await assertRejects(() => extractPdfText(big), PdfError)).code, "too_large");
  const pages = buildPdf([{ lines: ["a"] }, { lines: ["b"] }, { lines: ["c"] }]);
  const err = await assertRejects(() => extractPdfText(pages, { maxPages: 2 }), PdfError);
  assertEquals(err.code, "too_many_pages");
});

Deno.test("a PDF that takes too long is stopped", async () => {
  const err = await assertRejects(
    () => extractPdfText(textPdf(AFFIDAVIT), { timeoutMs: 1 }),
    PdfError,
  );
  assertEquals(err.code, "timeout");
});

Deno.test("the worker has no file, network, environment or program access", async () => {
  // pdf.ts makes its worker with permissions "none"; a worker made the same way is refused each.
  const src = await Deno.readTextFile(new URL("../src/core/pdf.ts", import.meta.url));
  assert(src.includes(`deno: { permissions: "none" }`));
  const probe = `
    const tries = {
      read: () => Deno.readTextFile(${JSON.stringify(new URL(import.meta.url).pathname)}),
      env: () => Deno.env.get("HOME"),
      net: () => fetch("http://127.0.0.1:65530/"),
      run: () => new Deno.Command("true").output(),
      write: () => Deno.writeTextFile("/tmp/casefile-pdf-worker-probe", "x"),
    };
    const out = {};
    for (const [k, f] of Object.entries(tries)) {
      try { await f(); out[k] = "allowed"; } catch (e) { out[k] = e.name; }
    }
    self.postMessage(out);`;
  const w = new Worker(`data:application/javascript,${encodeURIComponent(probe)}`, {
    type: "module",
    deno: { permissions: "none" },
  } as WorkerOptions);
  const out = await new Promise((res) => (w.onmessage = (e) => res(e.data)));
  w.terminate();
  assertEquals(out, {
    read: "NotCapable",
    env: "NotCapable",
    net: "NotCapable",
    run: "NotCapable",
    write: "NotCapable",
  });
});

Deno.test("text clean-up: ligatures, control characters, tabs and trailing spaces", () => {
  const { text, emptyPages } = pagesToText([
    { lines: ["ﬁled by \u0007Mia\t Okafor   ", "   ", "", "end"], fields: [] },
    { lines: [" ", ""], fields: [["Name", "  "]] },
  ]);
  assertEquals(text, "filed by Mia  Okafor\n\nend");
  assertEquals(emptyPages, [2]);
});
