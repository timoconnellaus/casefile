// Badge (spec §3, §5): a state from the vocabulary, always glyph + text, never colour alone.
// ActorLabel (spec §2): who did it, as a word, never a colour. Tag: a plain neutral label.
import { h } from "../dom.js";
import { actorFor, badgeFor } from "../model.js";
import { Icon } from "./icons.js";

/**
 * A status badge. Throws for a state outside the vocabulary.
 * @param {"doc"|"work"|"para"} domain
 * @param {string} state e.g. "to_check", "exposed", "claude_adopted"
 * @param {{small?: boolean}} [opts]
 */
export function Badge(domain, state, opts = {}) {
  const b = badgeFor(domain, state);
  return h(
    "span",
    { class: `${b.className}${opts.small ? " badge--sm" : ""}`, "data-state": b.state },
    Icon(b.glyph),
    h("span", { class: "badge-text" }, b.label),
  );
}

/** A neutral label that is not a state ("New", "kept", "Mine"). */
export function Tag(text, opts = {}) {
  return h("span", { class: `tag${opts.mono ? " mono" : ""}` }, text);
}

/**
 * Who did it: "Claude" (with a pen glyph), "You" or "casefile checked".
 * @param {"claude"|"user"|"you"|"app"|"casefile"} by
 * @param {{note?: boolean}} [opts] note: label a note ("Claude’s note")
 */
export function ActorLabel(by, opts = {}) {
  const a = actorFor(by);
  const text = opts.note
    ? (a.actor === "claude" ? "Claude’s note" : a.actor === "user" ? "Your note" : a.label)
    : a.label;
  return h(
    "span",
    { class: `actor actor--${a.actor}` },
    a.glyph ? Icon(a.glyph) : null,
    h("span", {}, text),
  );
}

const FLAG_TONES = new Set(["neutral", "attention", "danger"]);

/**
 * A badge for something that is not a state from the vocabulary (§3): a count ("3 to check"), a
 * review decision ("Needs you"), a log flag ("Not written by casefile"), a paste sentence's check.
 * Same look as Badge: glyph + words, never colour alone.
 * @param {"neutral"|"attention"|"danger"} tone
 * @param {string|null} glyph an icon name, or null for none
 * @param {string|Node} text
 * @param {{small?: boolean, className?: string}} [opts]
 */
export function FlagBadge(tone, glyph, text, opts = {}) {
  if (!FLAG_TONES.has(tone)) throw new Error(`Unknown badge tone: ${tone}`);
  return h(
    "span",
    {
      class: [
        "badge",
        tone !== "neutral" && `badge--${tone}`,
        opts.small && "badge--sm",
        opts.className,
      ],
    },
    glyph ? Icon(glyph) : null,
    h("span", { class: "badge-text" }, text),
  );
}
