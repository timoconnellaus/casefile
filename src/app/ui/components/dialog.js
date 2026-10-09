// Dialog: a native modal <dialog> with a heading, body and actions. Resolves with the value of
// the button chosen, or null when dismissed (Escape, Cancel).
import { h } from "../dom.js";

/**
 * @param {{
 *   title: string,
 *   body?: string|Node|Array<string|Node>,
 *   actions?: {label: string, value: unknown, variant?: "primary"|"secondary"|"danger"}[],
 *   wide?: boolean,
 * }} opts
 * @returns {Promise<unknown>}
 */
export function openDialog(opts) {
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const actions = opts.actions ??
    [{ label: "Cancel", value: null }, { label: "OK", value: true, variant: "primary" }];
  return new Promise((resolve) => {
    let result = null;
    // Focus goes back to whatever opened the dialog (WCAG 2.4.3), or the screen's h1 if it is gone.
    const opener = document.activeElement;
    const dlg = h(
      "dialog",
      { class: `dialog${opts.wide ? " dialog--wide" : ""}`, "aria-labelledby": `${id}-h` },
      h("h2", { id: `${id}-h`, class: "dialog-title" }, opts.title),
      opts.body != null ? h("div", { class: "dialog-body" }, opts.body) : null,
      h(
        "div",
        { class: "hstack end dialog-actions" },
        actions.map((a) =>
          h("button", {
            type: "button",
            class: a.variant === "primary"
              ? "btn btn-primary btn-lg"
              : a.variant === "danger"
              ? "btn btn-primary btn-primary--danger btn-lg"
              : "btn btn-lg",
            // Focus the safe choice: the primary action, or Cancel when the action is destructive.
            "data-autofocus": a.variant === "primary" ||
                (a.value == null || a.value === false) &&
                  actions.some((x) => x.variant === "danger")
              ? ""
              : null,
            onclick: () => {
              result = a.value;
              dlg.close();
            },
          }, a.label)
        ),
      ),
    );
    dlg.addEventListener("close", () => {
      dlg.remove();
      restoreFocus(opener);
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("[data-autofocus]")?.focus();
  });
}

/**
 * Put focus back on `el` when it is still on the page, otherwise on the screen's h1 (or <main>).
 * For dialogs, toasts and panels that close while they hold focus.
 * @param {Element|null|undefined} el
 */
export function restoreFocus(el) {
  if (el instanceof HTMLElement && el !== document.body && el.isConnected) {
    el.focus();
    if (document.activeElement === el) return;
    // A button that opened a dialog is often disabled until its handler finishes, just after the
    // dialog closes: try again once that has run.
    if (/** @type {HTMLButtonElement} */ (el).disabled) {
      setTimeout(() => {
        if (el.isConnected && !(/** @type {HTMLButtonElement} */ (el).disabled)) el.focus();
        if (document.activeElement !== el) focusScreen();
      }, 0);
      return;
    }
  }
  focusScreen();
}

/** Focus the screen's h1 (or <main>). */
function focusScreen() {
  const main = document.getElementById("main") ?? document.querySelector("main");
  const h1 = main?.querySelector("h1");
  if (h1 && !h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
  /** @type {HTMLElement|null|undefined} */ (h1 ?? main)?.focus();
}

/** Yes/no confirmation. Resolves true only when the confirm button is chosen. */
export async function confirmDialog(title, message, okLabel = "OK", danger = false) {
  const v = await openDialog({
    title,
    body: h("p", {}, message),
    actions: [
      { label: "Cancel", value: false },
      { label: okLabel, value: true, variant: danger ? "danger" : "primary" },
    ],
  });
  return v === true;
}
