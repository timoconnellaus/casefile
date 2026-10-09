/**
 * PDF import through the API (ADR 23): the text goes through review and the leak check like any
 * import, the PDF is kept encrypted in the vault and only a signed-in caller can read it back, and
 * nothing of it reaches public.db. SYNTHETIC PDFs only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { MAX_PDF_BYTES } from "../src/core/pdf.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE, IDS, PEOPLE } from "./fixtures/synthetic.ts";
import { dumpPublic } from "./fixtures/case.ts";
import { buildPdf, textPdf } from "./fixtures/pdf.ts";
import {
  assertNoSecrets,
  assertSecurityHeaders,
  publishRequestFrom,
  withCase,
} from "./helpers/app.ts";

const vaultFiles = async (caseDir: string) => {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(caseDir, "vault"))) out.push(e.name);
  return out.sort();
};

Deno.test("a PDF is imported, reviewed and shared like text; its original stays in the vault", async () => {
  const t = await withCase();
  const pdf = textPdf(AFFIDAVIT);
  const imp = await t.user.post("/api/docs/import-pdf", {
    title: AFFIDAVIT_TITLE,
    pdf: encodeBase64(pdf),
    origin: "mine",
  });
  assertEquals(imp.status, 200, imp.text);
  const id: string = imp.json.id;
  assertEquals(imp.json.pages, 1);
  assertEquals(imp.json.emptyPages, []);
  assert(imp.json.detections > 0, "names in the PDF's text are found");
  assert(typeof imp.json.batch === "string");

  // Review shows the text read from the PDF, and what file it came from.
  const review = await t.user.get(`/api/docs/${id}/review`);
  assertEquals(review.json.original, AFFIDAVIT.trimEnd());
  assertEquals(review.json.file.type, "pdf");
  assertEquals(review.json.file.size, pdf.length);

  // The original comes back byte for byte, as a PDF named by id, with the usual headers.
  const orig = await t.user.get(`/api/docs/${id}/original`);
  assertEquals(orig.status, 200);
  assertEquals(orig.headers.get("content-type"), "application/pdf");
  assertEquals(orig.headers.get("content-disposition"), `inline; filename="${id}.pdf"`);
  assertSecurityHeaders(orig, "original");
  assertEquals(Uint8Array.from(orig.text, (c) => c.charCodeAt(0)), pdf);

  // Not to a caller without the session cookie.
  assertEquals((await t.other.get(`/api/docs/${id}/original`)).status, 401);

  // It is kept encrypted, under its own name (documents are listed by `doc-`).
  const files = await vaultFiles(t.caseDir);
  assert(files.includes(`original-${id.toLowerCase()}.enc`), files.join());
  const raw = await Deno.readFile(join(t.caseDir, "vault", `original-${id.toLowerCase()}.enc`));
  assert(!new TextDecoder("latin1").decode(raw).includes("%PDF"), "the vault file is encrypted");

  // Shared after review: Claude sees names replaced, and nothing of the PDF.
  const pub = await t.user.post(`/api/docs/${id}/publish`, publishRequestFrom(review.json));
  assertEquals(pub.status, 200, pub.text);
  const db = dumpPublic(t.state.session!.store);
  assertNoSecrets(db, "public.db");
  assert(!db.includes("%PDF"), "no PDF bytes in public.db");
  const logged = t.state.session!.store.logForDoc(id).find((r) => r.action === "document_imported");
  assertEquals(JSON.parse(logged!.detail).format, "pdf", "the import log row says it was a PDF");
  assertEquals((await t.user.get(`/api/docs/${id}`)).json.file.pages, 1);
  const list = await t.user.get("/api/docs");
  assertEquals(list.json.find((d: { id: string }) => d.id === id).format, "pdf");

  // Deleting the document deletes the original too.
  assertEquals((await t.user.req("DELETE", `/api/docs/${id}`)).status, 200);
  assert(!(await vaultFiles(t.caseDir)).some((f) => f.startsWith("original-")));
  t.state.session!.close();
});

Deno.test("a text import has no original; asking for one is a 404", async () => {
  const t = await withCase();
  const imp = await t.user.post("/api/docs/import", { title: "Note", text: AFFIDAVIT });
  assertEquals((await t.user.get(`/api/docs/${imp.json.id}/original`)).status, 404);
  assertEquals((await t.user.get(`/api/docs/${imp.json.id}/review`)).json.file, null);
  t.state.session!.close();
});

Deno.test("PDF pages without text and filled-in form fields", async () => {
  const t = await withCase();
  const pdf = buildPdf([
    {
      lines: ["Application for Consent Orders"],
      fields: [{ name: "Applicant", value: PEOPLE.mother }],
    },
    {},
  ]);
  const imp = await t.user.post("/api/docs/import-pdf", { title: "Form", pdf: encodeBase64(pdf) });
  assertEquals(imp.status, 200, imp.text);
  assertEquals(imp.json.emptyPages, [2]);
  const review = await t.user.get(`/api/docs/${imp.json.id}/review`);
  assert(review.json.original.includes(`Applicant: ${PEOPLE.mother}`));
  assert(
    review.json.proposals.some((p: { text: string }) => p.text.includes("Thornbury")),
    "a name in a form field is found like any other",
  );
  assertEquals(review.json.file.formFields, 1);
  t.state.session!.close();
});

Deno.test("PDFs that can't be read are refused with a code, and nothing is added", async () => {
  const t = await withCase();
  const before = (await t.user.get("/api/docs")).json.length;
  const cases: [unknown, number, string | null][] = [
    [encodeBase64(buildPdf([{}])), 422, "no_text"],
    [encodeBase64(new TextEncoder().encode(IDS.address)), 422, "not_pdf"],
    ["A".repeat(Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4), 422, "too_large"],
    ["not base64!", 400, null],
    [undefined, 400, null],
  ];
  for (const [pdf, status, code] of cases) {
    const r = await t.user.post("/api/docs/import-pdf", { title: "Scan", pdf });
    assertEquals(r.status, status, r.text);
    assertEquals(r.json.code ?? null, code);
  }
  assertEquals((await t.user.get("/api/docs")).json.length, before);
  assert(!(await vaultFiles(t.caseDir)).some((f) => f.startsWith("original-")));
  t.state.session!.close();
});
