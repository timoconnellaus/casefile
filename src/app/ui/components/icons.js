// Small stroke/fill glyphs drawn as inline SVG (presentation attributes only, no style).
// Glyphs are decoration: they are aria-hidden and always sit next to text (spec §1).
import { svg } from "../dom.js";

const PATHS = {
  check: () => [svg("path", { d: "M2.5 6.5l2.3 2.3L9.5 3.5" })],
  dot: () => [svg("circle", { cx: 6, cy: 6, r: 3.5, fill: "currentColor", stroke: "none" })],
  triangle:
    () => [svg("path", { d: "M6 1.6L10.8 10.2H1.2z", fill: "currentColor", stroke: "none" })],
  info: () => [
    svg("circle", { cx: 6, cy: 6, r: 4.8 }),
    svg("path", { d: "M6 5.4v3.2" }),
    svg("circle", { cx: 6, cy: 3.6, r: 0.6, fill: "currentColor", stroke: "none" }),
  ],
  pen: () => [svg("path", { d: "M2 10l1-3 5-5 2 2-5 5-3 1z" })],
  lock: () => [
    svg("rect", { x: 2, y: 5.5, width: 8, height: 5.5, rx: 1 }),
    svg("path", { d: "M4 5.5V4a2 2 0 0 1 4 0v1.5" }),
  ],
  search:
    () => [svg("circle", { cx: 5.2, cy: 5.2, r: 3.4 }), svg("path", { d: "M7.8 7.8L10.5 10.5" })],
  close: () => [svg("path", { d: "M3 3l6 6M9 3l-6 6" })],
  chevron: () => [svg("path", { d: "M4.5 2.5L8 6l-3.5 3.5" })],
  sort: () => [svg("path", { d: "M3.5 4.5L6 2l2.5 2.5M3.5 7.5L6 10l2.5-2.5" })],
  up: () => [svg("path", { d: "M3 7.5L6 4.5l3 3" })],
  down: () => [svg("path", { d: "M3 4.5L6 7.5l3-3" })],
  // Safety-sensitive (People, Review): a shield.
  shield: () => [svg("path", { d: "M6 1l4 1.5v3c0 2.6-1.8 4.4-4 5.5-2.2-1.1-4-2.9-4-5.5v-3z" })],
  // A link that opens outside casefile, in the web browser.
  external: () => [svg("path", { d: "M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5L5.5 6.5" })],
};

export const ICON_NAMES = Object.keys(PATHS);

/**
 * An icon. Decorative (aria-hidden) unless `label` is given.
 * @param {string} name one of ICON_NAMES
 * @param {{label?: string, size?: number, className?: string}} [opts]
 */
export function Icon(name, opts = {}) {
  const make = PATHS[name];
  if (!make) throw new Error(`Unknown icon: ${name}`);
  const size = opts.size ?? 12;
  return svg(
    "svg",
    {
      class: `icon icon-${name}${opts.className ? ` ${opts.className}` : ""}`,
      width: size,
      height: size,
      viewBox: "0 0 12 12",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.4,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      focusable: "false",
      "aria-hidden": opts.label ? null : "true",
      role: opts.label ? "img" : null,
      "aria-label": opts.label ?? null,
    },
    ...make(),
  );
}

/** The safety-sensitive glyph (decorative; always next to the words "Safety-sensitive"). */
export function ShieldIcon(opts = {}) {
  return Icon("shield", opts);
}
