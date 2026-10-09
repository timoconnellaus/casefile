// Feedback: live region (announce), Toast with Undo, ConfirmBar, Callout and EmptyState.
import { h } from "../dom.js";
import { Icon } from "./icons.js";
import { restoreFocus } from "./dialog.js";

// ── live region ──────────────────────────────────────────────────────────────

let live = null;

/** The page's polite live region (role="status"), created on first use. */
export function liveRegion() {
  if (live?.isConnected) return live;
  live = document.getElementById("cf-live") ??
    h("div", { id: "cf-live", class: "sr", role: "status", "aria-live": "polite" });
  if (!live.isConnected) document.body.append(live);
  return live;
}

let pending = 0;

/**
 * Tell screen-reader users the result of an action. Calls within the same moment collapse into
 * the last one, so a view that both announces and shows a toast is read once.
 */
export function announce(message) {
  const el = liveRegion();
  el.textContent = "";
  clearTimeout(pending);
  // A new text node after a tick makes repeated identical messages announce again.
  pending = setTimeout(() => {
    pending = 0;
    el.textContent = message;
  }, 30);
}

/** Empty the live region on a route change, unless an announcement is on its way. */
export function clearLive() {
  if (pending) return;
  const el = document.getElementById("cf-live");
  if (el) el.textContent = "";
}

// ── toast ────────────────────────────────────────────────────────────────────

let toastTimer;

/** The text of a message for the live region. */
const plainText = (m) =>
  (typeof m === "string" ? m : m?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Show a toast (bottom left). With `undo`, an Undo button runs it and the toast stays longer.
 * The message is announced through the live region (a status node that arrives with its text
 * already in it is often not read). The timer pauses while the toast has focus or the pointer
 * (WCAG 2.2.1), and F6 moves focus to it. When it closes while holding focus, focus goes back to
 * `returnFocus` (default: what had focus when it was shown), or the screen's h1.
 * @param {string|Node} message
 * @param {{tone?: "neutral"|"danger", undo?: () => unknown, timeout?: number, glyph?: string,
 *   returnFocus?: HTMLElement|null, announce?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function showToast(message, opts = {}) {
  document.querySelector(".cf-toast")?.remove();
  clearTimeout(toastTimer);
  const tone = opts.tone ?? "neutral";
  const before = document.activeElement;
  const back = opts.returnFocus ??
    (before instanceof HTMLElement && !before.closest(".cf-toast") ? before : null);
  const ms = opts.timeout ?? (opts.undo ? 10000 : tone === "danger" ? 8000 : 4000);
  let paused = false;
  let hover = false;
  const close = () => {
    clearTimeout(toastTimer);
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (hadFocus) restoreFocus(back);
  };
  const arm = () => {
    clearTimeout(toastTimer);
    if (ms > 0 && !paused && !hover) toastTimer = setTimeout(close, ms);
  };
  const el = h(
    "div",
    {
      class: `cf-toast cf-toast--${tone}`,
      role: tone === "danger" ? "alert" : null,
      onfocusin: () => {
        paused = true;
        arm();
      },
      onfocusout: (e) => {
        if (el.contains(e.relatedTarget)) return;
        paused = false;
        arm();
      },
      onmouseenter: () => {
        hover = true;
        arm();
      },
      onmouseleave: () => {
        hover = false;
        arm();
      },
      onkeydown: (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      },
    },
    opts.glyph || tone === "danger" ? Icon(opts.glyph ?? "triangle") : null,
    h("span", { class: "cf-toast-msg" }, message),
    opts.undo
      ? h("button", {
        type: "button",
        class: "btn",
        onclick: async () => {
          close();
          await opts.undo();
        },
      }, "Undo")
      : null,
    h("button", {
      type: "button",
      class: "btn btn-quiet cf-toast-close",
      "aria-label": "Dismiss",
      onclick: close,
    }, Icon("close")),
  );
  document.body.append(el);
  if (tone !== "danger" && opts.announce !== false) {
    const text = plainText(message);
    if (text) announce(opts.undo ? `${text} Press F6 to reach Undo.` : text);
  }
  arm();
  return el;
}

// F6 moves focus to the toast's first button (and back again), so Undo is reachable by keyboard.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F6" || e.altKey || e.metaKey || e.ctrlKey) return;
    const toast = document.querySelector(".cf-toast");
    if (!toast) return;
    e.preventDefault();
    if (toast.contains(document.activeElement)) {
      restoreFocus(toastReturn);
    } else {
      toastReturn = document.activeElement;
      /** @type {HTMLElement|null} */ (toast.querySelector("button"))?.focus();
    }
  });
}
/** @type {Element|null} */
let toastReturn = null;

// ── ConfirmBar ───────────────────────────────────────────────────────────────

/**
 * A bar for consequential actions: says in plain words what will happen, then a primary button
 * and Cancel. Show an Undo toast after the action.
 * @param {{
 *   title?: string,
 *   summary: string|Node|Array<string|Node>,
 *   detail?: string|Node|Array<string|Node>,
 *   confirmLabel: string,
 *   cancelLabel?: string,
 *   onConfirm: () => unknown,
 *   onCancel?: () => unknown,
 *   sticky?: boolean,
 *   danger?: boolean,
 * }} opts
 */
export function ConfirmBar(opts) {
  const id = `cb-${Math.random().toString(36).slice(2, 8)}`;
  const confirm = h("button", {
    type: "button",
    class: `btn btn-primary btn-lg${opts.danger ? " btn-primary--danger" : ""}`,
    onclick: async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        await opts.onConfirm();
      } finally {
        b.disabled = false;
      }
    },
  }, opts.confirmLabel);
  const bar = h(
    "section",
    {
      class: `confirmbar${opts.sticky ? " confirmbar--sticky" : ""}`,
      role: "group",
      "aria-labelledby": opts.title ? `${id}-h` : null,
      "aria-label": opts.title ? null : "Confirm",
      "aria-describedby": `${id}-b`,
      onkeydown: (e) => {
        if (e.key === "Escape" && opts.onCancel) opts.onCancel();
      },
    },
    h(
      "div",
      { class: "confirmbar-text" },
      opts.title ? h("h2", { id: `${id}-h`, class: "confirmbar-title" }, opts.title) : null,
      h(
        "div",
        { id: `${id}-b`, class: "vstack gap-sm" },
        h("p", { class: "confirmbar-summary" }, opts.summary),
        opts.detail ? h("div", { class: "confirmbar-detail" }, opts.detail) : null,
      ),
    ),
    h(
      "div",
      { class: "hstack confirmbar-actions" },
      confirm,
      h("button", {
        type: "button",
        class: "btn btn-lg",
        onclick: () => opts.onCancel?.(),
      }, opts.cancelLabel ?? "Cancel"),
    ),
  );
  /** Move focus to the primary button (call after inserting the bar). */
  bar.focusPrimary = () => confirm.focus();
  return bar;
}

// ── Callout and EmptyState ───────────────────────────────────────────────────

/**
 * A boxed message. tone "attention" and "danger" carry the status hues; "neutral" is a plain box.
 * @param {{tone?: "neutral"|"attention"|"danger"|"info", title?: string|Node,
 *   children?: Array<string|Node>|string|Node}} opts
 */
export function Callout(opts) {
  const tone = opts.tone ?? "neutral";
  const glyph = tone === "attention"
    ? "dot"
    : tone === "danger"
    ? "triangle"
    : tone === "info"
    ? "info"
    : null;
  return h(
    "div",
    { class: `callout callout--${tone}`, role: tone === "danger" ? "alert" : null },
    opts.title
      ? h("strong", { class: "callout-title" }, glyph ? Icon(glyph) : null, opts.title)
      : null,
    opts.children != null ? h("div", { class: "callout-body" }, opts.children) : null,
  );
}

/**
 * Empty and error states: the same panel, a plain sentence and one action (spec §5).
 * @param {{message: string|Node, title?: string, action?: Node|null, tone?: "neutral"|"danger"}} opts
 */
export function EmptyState(opts) {
  return h(
    "div",
    {
      class: `empty${opts.tone === "danger" ? " empty--danger" : ""}`,
      role: opts.tone === "danger" ? "alert" : null,
    },
    h(
      "div",
      { class: "vstack gap-sm grow" },
      opts.title ? h("h2", { class: "empty-title" }, opts.title) : null,
      h("p", {}, opts.message),
    ),
    opts.action ?? null,
  );
}
