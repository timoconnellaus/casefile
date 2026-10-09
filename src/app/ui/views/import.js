// Import (W2-2; the import section of wb/Documents.dc.html): drop files or a folder, choose files,
// or paste text. PDFs are sent as base64 to `/api/docs/import-pdf`, which reads their text and
// keeps the file in the vault (ADR 23). Each file is checked for names on this computer, one at a time, with progress.
// The files of one import share a batch (the first response's `batch`), so "Review" opens the
// review queue for just these documents (`#/review/D015?queue=B3`).
// Rendered inside the Documents list (no route of its own; its styles are in documents.css).
import { clear, h } from "../dom.js";
import { api } from "../lib.js";
import { announce, Button, Field, openDialog } from "../components/index.js";

const TEXT_EXT = /\.(txt|text|md|markdown)$/i;
const PDF_EXT = /\.pdf$/i;
const LATER = [
  { re: /\.(eml|msg|mbox)$/i, what: "Email" },
  { re: /\.(png|jpe?g|heic|gif|webp|tiff?)$/i, what: "Photo" },
  { re: /\.(docx?|rtf|odt|pages)$/i, what: "Word" },
];

/** Whether a file can be imported now (and whether it is a PDF), or what kind of "not yet" file it is. */
export function classifyFile(file) {
  if (PDF_EXT.test(file.name) || file.type === "application/pdf") return { ok: true, pdf: true };
  if (TEXT_EXT.test(file.name) || file.type === "text/plain" || file.type === "text/markdown") {
    return { ok: true };
  }
  return { ok: false, what: LATER.find((l) => l.re.test(file.name))?.what ?? "Other" };
}

/** A file name without its folder or extension, as a starting title. */
export function titleFromName(name) {
  const base = name.split("/").pop() ?? name;
  return base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

/** Every file in a dropped folder (recursively), skipping hidden files. */
async function filesFromEntry(entry) {
  if (!entry || entry.name.startsWith(".")) return [];
  if (entry.isFile) {
    return [await new Promise((res, rej) => entry.file(res, rej))];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...await filesFromEntry(e));
  }
  return out;
}

async function filesFromDrop(dt) {
  const items = [...(dt.items ?? [])];
  if (items.length && typeof items[0].webkitGetAsEntry === "function") {
    const entries = items.map((i) => i.webkitGetAsEntry()).filter(Boolean);
    const out = [];
    for (const e of entries) out.push(...await filesFromEntry(e));
    return out;
  }
  return [...(dt.files ?? [])];
}

/** A file's bytes as base64. */
function base64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error ?? new Error("Couldn’t read the file"));
    r.readAsDataURL(file);
  });
}

/** "page 3", "pages 3 and 4", "pages 2, 5 and 7" */
function pageList(pages) {
  return `${pages.length === 1 ? "page" : "pages"} ${list(pages.map(String))}`;
}

/** "D015 and D016", "D015, D016 and D017" */
function list(ids) {
  return ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/**
 * The import panel.
 * @param {{onImported: (ids: string[], batch: string | null) => unknown}} opts
 */
export function ImportPanel(opts) {
  const progress = h("progress", { class: "imp-bar", max: "1", value: "0", hidden: true });
  const progressText = h("span", { class: "imp-progress-text" });
  const progressNext = h("div", { class: "imp-next" });
  const status = h(
    "div",
    { class: "imp-status", role: "status", hidden: true },
    progressText,
    progress,
    progressNext,
  );
  let busy = false;

  const run = async (items) => {
    if (busy) return;
    busy = true;
    status.hidden = false;
    progressNext.replaceChildren();
    const done = [];
    const skipped = [];
    const failed = [];
    // PDFs with pages casefile couldn't read (no text: probably scanned).
    const partial = [];
    const ok = items.filter((it) => it.text !== undefined || classifyFile(it.file).ok);
    for (const it of items) {
      if (it.file && !classifyFile(it.file).ok) skipped.push(it.file.name);
    }
    progress.max = String(Math.max(1, ok.length));
    progress.hidden = ok.length === 0;
    let last = null;
    let batch = null;
    for (const [i, it] of ok.entries()) {
      const name = it.file?.name ?? it.title;
      progress.value = String(i);
      progressText.replaceChildren(
        `Checking ${i + 1} of ${ok.length}: `,
        h("span", { class: "mono" }, name),
      );
      try {
        const title = it.title ?? titleFromName(it.file.name);
        const r = it.file && classifyFile(it.file).pdf
          ? await api("POST", "/api/docs/import-pdf", {
            title,
            pdf: await base64(it.file),
            ...(batch ? { batch } : {}),
          })
          : await api("POST", "/api/docs/import", {
            title,
            text: it.text ?? await it.file.text(),
            ...(batch ? { batch } : {}),
          });
        if (r.emptyPages?.length) partial.push(`${r.id} (${pageList(r.emptyPages)})`);
        batch ??= r.batch ?? null;
        done.push(r.id);
        last = { name, id: r.id };
      } catch (e) {
        failed.push(`${name}: ${e.message ?? e}`);
      }
    }
    progress.value = progress.max;
    busy = false;

    const parts = [];
    if (last) {
      parts.push(
        `Checked ${done.length} of ${ok.length}: `,
        h("span", { class: "mono" }, last.name),
        ` is now ${last.id}`,
      );
    } else if (ok.length) parts.push(`None of the ${ok.length} could be added.`);
    else parts.push("Nothing to add.");
    progressText.replaceChildren(...parts);
    clear(
      progressNext,
      done.length
        ? h(
          "p",
          {},
          `${list(done)} ${done.length === 1 ? "needs" : "need"} review before Claude sees ${
            done.length === 1 ? "it" : "them"
          }. `,
          h(
            "a",
            { href: `#/review/${done[0]}${batch ? `?queue=${batch}` : ""}` },
            done.length > 1 ? `Review them, starting with ${done[0]}` : `Review ${done[0]}`,
          ),
        )
        : null,
      skipped.length
        ? h(
          "p",
          {},
          `Not added (only .txt, .md and PDF files can be added for now): ${skipped.join(", ")}. `,
          "For an email, open it, select all the text, copy it and use Paste text.",
        )
        : null,
      partial.length
        ? h(
          "p",
          {},
          `Some PDF pages had no text casefile could read, probably because they are scans, so nothing on them was added: ${
            partial.join("; ")
          }. If those pages matter, copy their text and use Paste text.`,
        )
        : null,
      failed.length ? h("p", { class: "danger-text" }, `Couldn’t add: ${failed.join("; ")}`) : null,
    );
    announce(
      done.length
        ? `Added ${done.length} ${done.length === 1 ? "document" : "documents"}: ${
          list(done)
        }. They need review before Claude sees them.`
        : "No documents were added.",
    );
    if (done.length) await opts.onImported(done, batch);
  };

  const fileInput = h("input", {
    type: "file",
    multiple: true,
    accept: ".txt,.md,.markdown,.text,.pdf,text/plain,text/markdown,application/pdf",
    class: "sr",
    tabindex: "-1",
    "aria-hidden": "true",
    onchange: (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      run(files.map((file) => ({ file })));
    },
  });

  const paste = async () => {
    const title = h("input", { type: "text", autocomplete: "off" });
    const text = h("textarea", { rows: "12", class: "imp-paste" });
    const ok = await openDialog({
      title: "Paste text",
      wide: true,
      body: [
        h(
          "p",
          {},
          "Paste the text of one document. casefile checks it for names on this computer; Claude sees nothing until you review it and share it.",
        ),
        Field({
          label: "Title",
          control: title,
          hint: "For example, “Email from school, May 2025”.",
        }),
        Field({ label: "Text", control: text }),
      ],
      actions: [
        { label: "Cancel", value: null },
        { label: "Add to the case", value: true, variant: "primary" },
      ],
    });
    if (ok !== true) return;
    if (!text.value.trim()) {
      progressText.replaceChildren("Nothing was pasted, so nothing was added.");
      status.hidden = false;
      return;
    }
    await run([{ title: title.value.trim() || "Pasted text", text: text.value }]);
  };

  const drop = h(
    "div",
    {
      class: "imp-drop",
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add("is-over");
      },
      ondragleave: () => drop.classList.remove("is-over"),
      ondrop: async (e) => {
        e.preventDefault();
        drop.classList.remove("is-over");
        const files = await filesFromDrop(e.dataTransfer);
        await run(files.map((file) => ({ file })));
      },
    },
    h(
      "div",
      { class: "vstack gap-sm grow" },
      h("p", { class: "imp-drop-title" }, "Drop PDF, .txt or .md files, or a folder, here"),
      h(
        "p",
        { class: "muted" },
        "Each one is checked for names and identifying details on this computer. Claude sees nothing until you review it and choose Share with Claude.",
      ),
    ),
    h(
      "div",
      { class: "hstack" },
      Button("Choose files", { onclick: () => fileInput.click() }),
      Button("Paste text", { onclick: paste }),
    ),
    fileInput,
  );

  return h(
    "section",
    { class: "imp", "aria-labelledby": "import-h" },
    h("h2", { id: "import-h", class: "sr" }, "Add documents"),
    drop,
    h(
      "p",
      { class: "muted small" },
      "You’ll be asked where each document came from when you review it.",
    ),
    h(
      "div",
      { class: "imp-later" },
      h("span", { class: "muted" }, "Not yet:"),
      h("span", { class: "tag" }, "Scanned PDFs · coming soon"),
      h("span", { class: "tag" }, "Email (.eml, .msg) · coming soon"),
      h("span", { class: "tag" }, "Photos & screenshots · coming soon"),
    ),
    h(
      "p",
      { class: "imp-guide" },
      "casefile keeps each PDF you add, encrypted, with the case. For an email, open it, select all the text, copy it and use ",
      h("strong", {}, "Paste text"),
      ", and keep the original somewhere safe outside the case folder; you’ll need it if it becomes an annexure.",
    ),
    status,
  );
}
