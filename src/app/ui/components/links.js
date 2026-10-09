// The only web pages casefile links to (free legal help, the Claude Code install guide, TypeSafe's
// terms for Jev). Must match src/app/links.ts, which is
// the authority: the server opens them in the user's own browser (POST /api/open-link), so the app
// itself never loads anything from the internet. tests/ui_model_test.ts allows exactly these.
import { h } from "../dom.js";
import { api } from "../lib.js";
import { Icon } from "./icons.js";
import { announce } from "./feedback.js";

export const EXTERNAL_LINKS = {
  legal_aid_nsw: {
    url: "https://www.legalaid.nsw.gov.au/",
    label: "Legal Aid NSW",
  },
  family_advice_line: {
    url: "https://www.familyrelationships.gov.au/talk-someone/advice-line",
    label: "Family Relationship Advice Line",
  },
  // Getting started, step 2: how to install Claude Code (Anthropic's own guide).
  claude_code_setup: {
    url: "https://docs.claude.com/en/docs/claude-code/setup",
    label: "Claude Code install guide",
  },
  // Settings → Extra checks: TypeSafe's terms for Jev, read before turning it on (ADR 14,
  // PD-AI 4.18). `JEV_TERMS` in core/judge/jev.ts names the same pages.
  typesafe_privacy: {
    url: "https://typesafe.ai/legal/privacy-policy",
    label: "TypeSafe privacy policy",
  },
  typesafe_legal: {
    url: "https://docs.typesafe.ai/legal",
    label: "TypeSafe legal terms",
  },
};

/**
 * A link to one allowed help page, opened in the web browser. Clicking asks casefile to open it
 * (macOS); where it can't, a new window with no opener is tried. Says so on the link, for screen
 * readers too.
 * @param {keyof typeof EXTERNAL_LINKS} id
 * @param {{label?: string}} [opts]
 */
export function ExternalLink(id, opts = {}) {
  const link = EXTERNAL_LINKS[id];
  if (!link) throw new Error(`Not an allowed link: ${id}`);
  return h(
    "a",
    {
      href: link.url,
      class: "extlink",
      target: "_blank",
      rel: "noopener noreferrer",
      onclick: async (e) => {
        e.preventDefault();
        let opened = false;
        try {
          opened = (await api("POST", "/api/open-link", { id })).opened === true;
        } catch {
          opened = false;
        }
        if (opened) announce(`Opened ${link.label} in your web browser.`);
        else window.open(link.url, "_blank", "noopener,noreferrer");
      },
    },
    opts.label ?? link.label,
    h("span", { class: "sr" }, " (opens in your web browser)"),
    Icon("external", { className: "extlink-icon" }),
  );
}
