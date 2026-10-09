import { findKnownSpans } from "../detect/pipeline.ts";
import type { EntityRegistry } from "../entities.ts";
import type { CaseSession } from "../session.ts";

/**
 * The safety warning on export (ADR 0021, ADR 0015). An export is a file the user may hand to
 * the other side or the Court, so before one includes a protected detail the user confirms it.
 *
 * A detail is any who's-who entry that is not a person: an address, a phone number, an email, a
 * Medicare or file number, a place. It is protected when:
 * - the registry says its values are safety-sensitive (`EntityRegistry.isSafetySensitive`): its
 *   own flag, or the flag of the person it belongs to (`relatedTo`, ADR 15 amendment 3); or
 * - it has no `relatedTo` link and its label reads as a safety-sensitive person's
 *   (`mother` → `mothers_home`, `mother_phone`): the old label rule, kept as a fallback so a
 *   case made before links existed doesn't silently lose the warning (fail closed). The app
 *   suggests the link in People (`labelLinkSuggestions`); the user confirms it there.
 * The address typed in an affidavit's heading is free text, not a who's-who entry, so it is
 * protected when the deponent is safety-sensitive.
 *
 * Matching uses the leak check's own matcher (`findKnownSpans` with `leak: true`, ADR 6): folded
 * case, Unicode forms and spacing, every alias, and every identifying part of the address (the
 * street without its number, the suburb). Callers pass the export as the reader will see it
 * (RTF decoded back to text, Markdown with its escapes removed) together with the source
 * strings it was built from (whole, before any shortening), so neither escaping, formatting nor
 * truncation can hide a value from the check.
 */

export interface SafetyHit {
  /** The detail's label (a role), or "heading" for the address typed in the heading. */
  label: string;
  /** The safety-sensitive person it belongs to, if known. */
  person: string | null;
  /** The detail's kind ("address", "phone", …); "address" for the heading. */
  kind: string;
  /**
   * Why it is protected: its own flag, its `relatedTo` link, its label only (no link yet), or the
   * affidavit heading.
   */
  via: "flag" | "link" | "label" | "heading";
}

/** An export would include a protected detail and the user has not confirmed it. */
export class SafetyConfirmError extends Error {
  constructor(readonly hits: SafetyHit[]) {
    super(
      hits.every((h) => h.kind === "address")
        ? "This export includes an address of someone marked safety-sensitive. Check before you " +
          "share it with anyone."
        : "This export includes contact details or an address of someone marked " +
          "safety-sensitive. Check before you share it with anyone.",
    );
    this.name = "SafetyConfirmError";
  }
}

/**
 * The safety-sensitive person a label reads as belonging to: `mothers_home` and `mother_phone`
 * → `mother`. Only for a non-person entry with no `relatedTo` link; null otherwise.
 */
export function labelOwner(reg: EntityRegistry, role: string): string | null {
  const e = reg.get(role);
  if (!e || e.kind === "person" || e.relatedTo) return null;
  // The longest matching label wins (`child_10_phone` is child_10's, not child_1's).
  const people = reg.list().filter((p) => p.kind === "person" && p.role !== role)
    .sort((a, b) => b.role.length - a.role.length);
  for (const p of people) {
    if (role.startsWith(`${p.role}_`) || role.startsWith(`${p.role}s_`)) return p.role;
  }
  return null;
}

/**
 * Links the app suggests in People: each non-person entry with no `relatedTo` whose label reads as
 * a person's (`mothers_home` → `mother`). Suggestions only: the user confirms each one. Those for a
 * safety-sensitive person come first, since export protects them by label until linked.
 */
export function labelLinkSuggestions(
  reg: EntityRegistry,
): { role: string; person: string; safety: boolean }[] {
  const out: { role: string; person: string; safety: boolean }[] = [];
  for (const e of reg.list()) {
    const person = labelOwner(reg, e.role);
    if (person) out.push({ role: e.role, person, safety: reg.isSafetySensitive(person) });
  }
  return out.sort((a, b) => Number(b.safety) - Number(a.safety) || a.role.localeCompare(b.role));
}

/**
 * Every protected detail in who's who, with why and whose it is. Exported for tests and the
 * People screen; `protectedAddressesIn` uses it.
 */
export function protectedDetails(
  reg: EntityRegistry,
): Map<string, { person: string | null; kind: string; via: SafetyHit["via"] }> {
  const out = new Map<string, { person: string | null; kind: string; via: SafetyHit["via"] }>();
  for (const e of reg.list()) {
    if (e.kind === "person") continue;
    const { safety, via } = reg.safetyOf(e.role);
    if (safety) {
      out.set(
        e.role,
        via ? { person: via, kind: e.kind, via: "link" } : {
          person: e.relatedTo && reg.isSafetySensitive(e.relatedTo) ? e.relatedTo : null,
          kind: e.kind,
          via: "flag",
        },
      );
      continue;
    }
    const owner = labelOwner(reg, e.role);
    if (owner && reg.isSafetySensitive(owner)) {
      out.set(e.role, { person: owner, kind: e.kind, via: "label" });
    }
  }
  return out;
}

/** Markdown with its backslash escapes removed (what a reader of the rendered file sees). */
export function unescapeMarkdown(s: string): string {
  return s.replace(/\\([\\`*_[\]<>#|{}()+\-.!~])/g, "$1");
}

/**
 * The protected details in any of `texts` (real names, as exported). Each text is also checked
 * with every run of whitespace, line breaks included, as one space, so a value wrapped across
 * lines or table cells is still found.
 */
export function protectedAddressesIn(
  session: CaseSession,
  texts: string[],
  heading?: { deponent: string | null; address: string | null } | null,
): SafetyHit[] {
  const reg = session.registry;
  const protectedRoles = protectedDetails(reg);
  const found = new Set<string>();
  if (protectedRoles.size) {
    for (const t of texts) {
      if (!t) continue;
      for (const v of new Set([t, t.replace(/\s+/g, " ")])) {
        for (const span of findKnownSpans(v, session.registry, { leak: true })) {
          const role = (span.label ?? "").split(".")[0];
          if (protectedRoles.has(role)) found.add(role);
        }
      }
    }
  }
  const hits: SafetyHit[] = [...found].sort().map((label) => ({
    label,
    ...protectedRoles.get(label)!,
  }));
  if (
    heading?.address?.trim() && heading.deponent &&
    reg.get(heading.deponent)?.kind === "person" && reg.isSafetySensitive(heading.deponent) &&
    !hits.some((h) => h.person === heading.deponent && h.kind === "address")
  ) {
    hits.push({ label: "heading", person: heading.deponent, kind: "address", via: "heading" });
  }
  return hits;
}
