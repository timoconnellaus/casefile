/**
 * The only web pages casefile links to: free legal help (DESIGN-SPEC §6, "Not legal advice"),
 * Anthropic's guide to installing Claude Code (Getting started) and TypeSafe's terms for Jev
 * (Settings → Extra checks).
 * The app never loads anything from the internet (CSP `default-src 'self'`); these open in the
 * user's own web browser. The UI's copy (`ui/components/links.js`) must match this list, and
 * `tests/ui_model_test.ts` allows exactly these addresses in the UI source.
 *
 * Opening runs exactly `open <url>` on macOS (the app has `--allow-run=open`), with a URL from
 * this list only; nothing from the request is passed on.
 */
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
} as const;

export type ExternalLinkId = keyof typeof EXTERNAL_LINKS;

export function isExternalLinkId(id: unknown): id is ExternalLinkId {
  return typeof id === "string" && Object.hasOwn(EXTERNAL_LINKS, id);
}

/** The command that opens `url` in the default browser (an https URL is never read as an option). */
export function openUrlCommand(url: string): { cmd: "open"; args: string[] } {
  if (!Object.values(EXTERNAL_LINKS).some((l) => l.url === url)) {
    throw new Error("Not an allowed link");
  }
  return { cmd: "open", args: [url] };
}

export async function defaultOpenUrl(url: string): Promise<void> {
  const { cmd, args } = openUrlCommand(url);
  const out = await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output();
  if (!out.success) throw new Error(`open exited with ${out.code}`);
}

/**
 * Open an allowed link in the user's browser. Returns whether it worked; never throws for "can't"
 * (not macOS, no permission), so the UI can fall back to a new window or show the address.
 */
export async function openExternal(
  id: ExternalLinkId,
  env: { os?: typeof Deno.build.os; openUrl?: (url: string) => Promise<void> } = {},
): Promise<boolean> {
  if ((env.os ?? Deno.build.os) !== "darwin") return false;
  try {
    await (env.openUrl ?? defaultOpenUrl)(EXTERNAL_LINKS[id].url);
    return true;
  } catch {
    return false;
  }
}
