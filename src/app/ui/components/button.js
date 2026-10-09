// Buttons (spec §1): primary is solid neutral light, secondary is outlined, link is underlined.
import { h } from "../dom.js";
import { Icon } from "./icons.js";

const VARIANTS = {
  primary: "btn btn-primary",
  secondary: "btn",
  quiet: "btn btn-quiet",
  link: "btn-link",
  danger: "btn btn-danger",
};

/**
 * @param {string|Node} label
 * @param {{variant?: keyof typeof VARIANTS, size?: "md"|"lg", icon?: string, type?: string,
 *   onclick?: Function, disabled?: boolean, [attr: string]: unknown}} [opts]
 */
export function Button(label, opts = {}) {
  const { variant = "secondary", size, icon, type = "button", class: extra, ...attrs } = opts;
  const base = VARIANTS[variant];
  if (!base) throw new Error(`Unknown button variant: ${variant}`);
  // Primary actions are 44px tall (spec §7); others 32px unless size "lg".
  const big = size === "lg" || (variant === "primary" && size !== "md");
  return h(
    "button",
    { type, class: [base, big && variant !== "link" && "btn-lg", extra], ...attrs },
    icon ? Icon(icon) : null,
    label,
  );
}
