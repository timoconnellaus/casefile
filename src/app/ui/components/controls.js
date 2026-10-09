// Small controls: FilterChips, Segmented (view switch), Toggle (switch button), Field,
// and list keyboard shortcuts (only while the list has focus, only when the setting is on).
import { h } from "../dom.js";
import { Icon } from "./icons.js";
import { announce, showToast } from "./feedback.js";

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/**
 * Filter chips: a group of pressed/unpressed pill buttons with counts.
 * @param {{label: string, options: {id: string, label: string, count?: number}[],
 *   value: string, onChange: (id: string) => void}} opts
 */
export function FilterChips(opts) {
  const group = h("div", { class: "chips", role: "group", "aria-label": opts.label });
  const render = (value) => {
    group.replaceChildren(
      ...opts.options.map((o) =>
        h(
          "button",
          {
            type: "button",
            class: "chip",
            "aria-pressed": o.id === value,
            onclick: () => {
              render(o.id);
              opts.onChange(o.id);
            },
          },
          o.label,
          o.count != null ? h("span", { class: "chip-count num" }, String(o.count)) : null,
        )
      ),
    );
  };
  render(opts.value);
  group.setValue = render;
  return group;
}

/**
 * A segmented switch ("You see / Claude sees / Side by side").
 * @param {{label: string, options: {id: string, label: string, count?: number}[],
 *   value: string, onChange: (id: string) => void}} opts
 */
export function Segmented(opts) {
  const group = h("div", { class: "seg", role: "group", "aria-label": opts.label });
  const render = (value) => {
    group.replaceChildren(
      ...opts.options.map((o) =>
        h(
          "button",
          {
            type: "button",
            "aria-pressed": o.id === value,
            onclick: () => {
              render(o.id);
              opts.onChange(o.id);
            },
          },
          o.label,
          o.count != null ? h("span", { class: "num seg-count" }, String(o.count)) : null,
        )
      ),
    );
  };
  render(opts.value);
  group.setValue = render;
  return group;
}

/**
 * An on/off switch drawn as a button with aria-pressed ("Highlight people").
 * @param {{label: string, pressed?: boolean, onChange: (on: boolean) => void}} opts
 */
export function Toggle(opts) {
  const btn = h(
    "button",
    {
      type: "button",
      class: "toggle",
      "aria-pressed": Boolean(opts.pressed),
      onclick: () => {
        const on = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(on));
        opts.onChange(on);
      },
    },
    h("span", { class: "toggle-switch", "aria-hidden": "true" }),
    opts.label,
  );
  return btn;
}

/**
 * A labelled field: label above the control, optional hint below (tied by aria-describedby).
 * @param {{label: string, control: HTMLElement, hint?: string}} opts
 */
export function Field(opts) {
  const id = opts.control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  opts.control.id = id;
  const hint = opts.hint ? h("span", { id: `${id}-hint`, class: "field-hint" }, opts.hint) : null;
  if (hint) opts.control.setAttribute("aria-describedby", `${id}-hint`);
  return h("div", { class: "field" }, h("label", { for: id }, opts.label), opts.control, hint);
}

// ── keyboard shortcuts ───────────────────────────────────────────────────────

/**
 * Attach single-key shortcuts to a list. They work only while focus is inside `list`, never in
 * text fields, and only when `enabled` (Settings → Keyboard shortcuts). Returns a detach function.
 * @param {HTMLElement} list
 * @param {Record<string, (e: KeyboardEvent) => void>} keymap e.g. {j: next, k: prev, x: check}
 * @param {{enabled: boolean}} opts
 */
export function listShortcuts(list, keymap, opts) {
  if (!opts.enabled) return () => {};
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    ) {
      return;
    }
    const fn = keymap[e.key];
    if (fn) {
      e.preventDefault();
      fn(e);
    }
  };
  list.addEventListener("keydown", onKey);
  return () => list.removeEventListener("keydown", onKey);
}

/** A shortcut hint (<kbd>), or nothing when shortcuts are off. */
export function ShortcutHint(key, enabled) {
  return enabled ? h("kbd", { class: "kbd", "aria-hidden": "true" }, key) : null;
}

// ── promoted from wave-2 screens ─────────────────────────────────────────────

/**
 * A checkbox row with a bold label and a hint (the mockups' "tick"). The hint is inside the label
 * so it is read with the checkbox.
 * @param {{label: string|Node, hint?: string|Node, checked?: boolean, disabled?: boolean,
 *   id?: string, onChange: (on: boolean) => void, [data: string]: unknown}} opts
 */
export function Tick(opts) {
  const { label, hint, checked, disabled, id, onChange, ...data } = opts;
  return h(
    "label",
    { class: "tick" },
    h("input", {
      type: "checkbox",
      id: id ?? null,
      checked: Boolean(checked),
      disabled: Boolean(disabled),
      ...Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith("data-"))),
      onchange: (e) => onChange(e.target.checked),
    }),
    h(
      "span",
      {},
      h("strong", {}, label),
      hint ? h("span", { class: "tick-hint" }, hint) : null,
    ),
  );
}

const ROW_GLYPH = { ok: "check", attention: "dot", danger: "triangle" };
const ROW_WORD = { ok: "Yes:", attention: "Needs attention:", danger: "Problem:" };

/**
 * One row in a status box: glyph · title and sub text · meta (text or a control). The glyph's
 * meaning is also given in words for screen readers.
 * @param {{level?: "ok"|"attention"|"danger"|null, title: string|Node, sub?: string|Node|null,
 *   meta?: string|Node|Node[]|null, lead?: Node|null, tag?: string, className?: string}} opts
 */
export function StatusRow(
  { level = null, title, sub = null, meta = null, lead = null, tag = "li", className = null },
) {
  return h(
    tag,
    { class: ["status-row", level && `status-row--${level}`, className] },
    h(
      "span",
      { class: "status-row-lead" },
      lead ?? (level ? Icon(ROW_GLYPH[level]) : null),
      level && !lead ? h("span", { class: "sr" }, ROW_WORD[level]) : null,
    ),
    h(
      "span",
      { class: "status-row-text" },
      h("span", { class: "status-row-title" }, title),
      sub ? h("span", { class: "status-row-sub muted" }, sub) : null,
    ),
    meta != null ? h("span", { class: "status-row-meta muted" }, meta) : h("span"),
  );
}

/**
 * An on/off switch drawn as a checkbox (role="switch") in a status row, with title, sub text and
 * "On"/"Off". `onChange` may be async; if it throws, the switch goes back and a toast says why.
 * @param {{id: string, checked: boolean, title: string|Node, sub?: string|Node,
 *   onChange: (on: boolean) => unknown, disabled?: boolean}} opts
 */
export function SwitchRow({ id, checked, title, sub, onChange, disabled = false }) {
  const box = h("input", {
    type: "checkbox",
    role: "switch",
    id,
    checked,
    disabled,
    "aria-describedby": sub ? `${id}-d` : null,
  });
  const state = h(
    "span",
    { class: "status-row-meta muted", "aria-hidden": "true" },
    checked ? "On" : "Off",
  );
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      await onChange(box.checked);
      state.textContent = box.checked ? "On" : "Off";
    } catch (e) {
      box.checked = !box.checked;
      showToast(e?.message ?? String(e), { tone: "danger" });
    } finally {
      box.disabled = disabled;
    }
  });
  return h(
    "div",
    { class: "status-row" },
    h("span", { class: "status-row-lead" }, box),
    h(
      "label",
      { class: "status-row-text", for: id },
      h("span", { class: "status-row-title" }, title),
      sub ? h("span", { class: "status-row-sub muted", id: `${id}-d` }, sub) : null,
    ),
    state,
  );
}

/**
 * A risky option that needs a typed phrase to turn on (DESIGN-SPEC O). The button stays
 * aria-disabled until the phrase matches (case-insensitive).
 * @param {{id: string, label: string|Node, phrase: string, onConfirm: () => unknown,
 *   disabled?: boolean, buttonLabel?: string}} opts
 */
export function TypedConfirm(
  { id, label, phrase, onConfirm, disabled = false, buttonLabel = "Turn on" },
) {
  const matches = () => input.value.trim().toLowerCase() === phrase.toLowerCase();
  const input = h("input", {
    id,
    class: "typed-confirm-input",
    autocomplete: "off",
    spellcheck: "false",
    disabled,
    "aria-describedby": `${id}-d`,
  });
  const btn = h("button", {
    type: "button",
    class: "btn btn-lg",
    "aria-disabled": "true",
    onclick: async (ev) => {
      if (!matches()) {
        announce(`Type ${phrase} to turn this on.`);
        input.focus();
        return;
      }
      ev.currentTarget.setAttribute("aria-disabled", "true");
      try {
        await onConfirm();
      } catch (e) {
        showToast(e?.message ?? String(e), { tone: "danger" });
        sync();
      }
    },
  }, buttonLabel);
  const sync = () => btn.setAttribute("aria-disabled", String(disabled || !matches()));
  input.addEventListener("input", sync);
  return h(
    "div",
    { class: "typed-confirm" },
    h("label", { for: id }, label, " Type ", h("strong", {}, phrase), "."),
    h("div", { class: "hstack nowrap typed-confirm-row" }, input, btn),
    h("span", { id: `${id}-d`, class: "sr" }, `Type ${phrase} to turn this on.`),
  );
}

/**
 * A passphrase input with a Show/Hide button. `also` lists further inputs the button shows
 * (a new passphrase and its "Type it again" field are shown together).
 * @param {{id: string, name?: string, autocomplete?: string, describedBy?: string,
 *   also?: HTMLInputElement[], what?: string}} opts
 * @returns {HTMLElement & {input: HTMLInputElement, toggle: HTMLButtonElement,
 *   setWhat: (w: string) => void}}
 */
export function PassField(opts) {
  const input = h("input", {
    id: opts.id ?? nextId("pf"),
    class: "pf-input",
    type: "password",
    name: opts.name ?? null,
    autocomplete: opts.autocomplete ?? "current-password",
    spellcheck: "false",
    "aria-describedby": opts.describedBy ?? null,
  });
  const others = opts.also ?? [];
  let what = opts.what ?? (others.length ? "passphrases" : "passphrase");
  const btn = h("button", {
    type: "button",
    class: "btn btn-lg pf-show",
    "aria-controls": [input.id, ...others.map((o) => o.id)].join(" "),
    "aria-pressed": false,
    "aria-label": `Show ${what}`,
  }, "Show");
  const label = () => {
    const shown = input.type === "text";
    btn.setAttribute("aria-pressed", String(shown));
    btn.setAttribute("aria-label", `${shown ? "Hide" : "Show"} ${what}`);
    btn.textContent = shown ? "Hide" : "Show";
  };
  btn.addEventListener("click", () => {
    const show = input.type === "password";
    for (const el of [input, ...others]) el.type = show ? "text" : "password";
    label();
  });
  const row = h("div", { class: "pf" }, input, btn);
  return Object.assign(row, {
    input,
    toggle: btn,
    /** Rename what the button shows ("recovery key"). */
    setWhat: (w) => {
      what = w;
      label();
    },
  });
}
