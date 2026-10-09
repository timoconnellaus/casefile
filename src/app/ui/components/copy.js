// CopyBlock: text the user copies somewhere else (a request for Claude, a command), with a
// Copy button that announces the result and falls back to selecting the text.
import { h } from "../dom.js";
import { Button } from "./button.js";
import { showToast } from "./feedback.js";

/**
 * Copy `text` to the clipboard; if that isn't allowed, select `node` so ⌘C works.
 * @returns {Promise<boolean>} whether it was copied
 */
export async function copyText(text, node) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (node) {
      const r = document.createRange();
      r.selectNodeContents(node);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    return false;
  }
}

/**
 * @param {{text: string, label: string, buttonLabel?: string, copied?: string,
 *   onCopied?: () => unknown}} opts `label` names the block for screen readers ("Request for
 *   Claude"); `copied` is the toast after a successful copy.
 */
export function CopyBlock(opts) {
  const code = h(
    "pre",
    { class: "copy-block-text mono", tabindex: "0", "aria-label": opts.label },
    opts.text,
  );
  return h(
    "div",
    { class: "copy-block vstack gap-sm" },
    code,
    h(
      "div",
      { class: "hstack" },
      Button(opts.buttonLabel ?? "Copy", {
        "aria-label": `Copy the ${opts.label.toLowerCase()}`,
        onclick: async () => {
          if (await copyText(opts.text, code)) {
            showToast(opts.copied ?? "Copied.");
            await opts.onCopied?.();
          } else {
            showToast("Couldn’t copy automatically. The text is selected: press ⌘C to copy it.");
          }
        },
      }),
    ),
  );
}
