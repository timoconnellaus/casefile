// RecoveryKeyPanel (ADR 4, amended): a recovery key shown once, with Print, Copy and
// "I've stored it". Used after "Create case" (Unlock) and when Settings makes a new key.
import { h } from "../dom.js";
import { announce } from "./feedback.js";

/**
 * A recovery key, shown once (ADR 4 amended): print, copy, and "I've stored it".
 * Used after "Create case" and in Settings when a new key is made.
 * @param {{key: string, onDone: () => unknown, doneLabel?: string,
 *   headingLevel?: "h1"|"h2"|"h3", replaced?: boolean}} opts
 */
export function RecoveryKeyPanel(opts) {
  const id = `rk-${Math.random().toString(36).slice(2, 8)}`;
  const tag = opts.headingLevel ?? "h2";
  const copied = h("span", { class: "muted", role: "status" });
  const stored = h("input", { type: "checkbox", id: `${id}-ok` });
  const keyEl = h("p", { class: "rk-key mono", id: `${id}-key` }, opts.key);
  const done = h("button", {
    type: "button",
    class: "btn btn-primary btn-lg",
    "aria-disabled": "true",
    onclick: async () => {
      if (!stored.checked) {
        announce("Tick “I’ve stored it” first.");
        stored.focus();
        return;
      }
      keyEl.textContent = ""; // off the page once stored
      await opts.onDone();
    },
  }, opts.doneLabel ?? "Continue");
  stored.addEventListener("change", () => {
    done.setAttribute("aria-disabled", String(!stored.checked));
  });
  const sheet = h(
    "section",
    { class: "rk-sheet", "aria-labelledby": `${id}-h` },
    h(tag, { id: `${id}-h`, class: "rk-title" }, "Your recovery key"),
    h(
      "p",
      {},
      opts.replaced ? "This replaces your earlier recovery key, which no longer works. " : "",
      "If you forget your passphrase, this key is the only other way to open this case. casefile shows it ",
      h("strong", {}, "only this once"),
      ".",
    ),
    h("div", { class: "rk-box" }, keyEl),
    h(
      "p",
      { class: "rk-print-only" },
      "casefile recovery key. Keep this page somewhere safe and private, away from the computer.",
    ),
    h(
      "div",
      { class: "hstack rk-actions" },
      h("button", {
        type: "button",
        class: "btn btn-lg",
        onclick: () => {
          document.body.classList.add("is-printing-key");
          sheet.classList.add("is-printing");
          const after = () => {
            document.body.classList.remove("is-printing-key");
            sheet.classList.remove("is-printing");
            window.removeEventListener("afterprint", after);
          };
          window.addEventListener("afterprint", after);
          window.print();
        },
      }, "Print"),
      h("button", {
        type: "button",
        class: "btn btn-lg",
        "aria-label": "Copy the recovery key",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(opts.key);
            copied.textContent =
              "Copied. Paste it somewhere private, then copy something else so it isn’t left on the clipboard.";
          } catch {
            copied.textContent = "casefile couldn’t copy it. Select the key and copy it yourself.";
          }
        },
      }, "Copy"),
      copied,
    ),
    h(
      "p",
      {},
      "Print it or write it down, and keep it away from this computer — not in the case folder, and not in an email or a note on this computer.",
    ),
    h(
      "label",
      { class: "rk-check", for: `${id}-ok` },
      stored,
      h("span", {}, h("strong", {}, "I’ve stored it"), " somewhere safe, away from this computer"),
    ),
    h("div", {}, done),
  );
  return sheet;
}
