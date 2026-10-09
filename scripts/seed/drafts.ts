/**
 * Drafts area seed (W2-6). SYNTHETIC data only (ADR 11).
 *
 * Gives the CANON affidavit's paragraphs their sources and what they rely on, so the Draft screen
 * shows sources, relied-on chronology entries and casefile's fact checks. Sources are not part
 * of what an adoption signs, so the CANON paragraph states and counts are unchanged.
 */
import type { SeedContext } from "../seed.ts";
import { setParagraphSources } from "../../src/core/drafting.ts";
import { type ParagraphLink, parseSourceRef } from "../../src/core/publicdb.ts";

export default async function seedDrafts({ session: s, log }: SeedContext) {
  const draft = s.store.listDrafts().find((d) => d.kind === "affidavit");
  if (!draft) return log("drafts: no affidavit to add sources to");
  const paras = s.store.listParagraphs(draft.id);
  const chrono = s.store.listChronology();
  const entry = (date: string, re: RegExp) =>
    chrono.find((c) => c.event_date === date && re.test(c.description));
  const late = entry("2025-03-14", /90 minutes late/);
  const swim = entry("2025-03-22", /Swimming moved/);
  const link = (e: { id: number } | undefined): ParagraphLink[] =>
    e ? [{ target_type: "chronology", target_id: e.id }] : [];

  // Paragraph index (0-based) → sources and relied-on chronology entries.
  const plan: [number, string[], ParagraphLink[]][] = [
    [1, ["D002:6"], []],
    [2, ["D002:9", "D001:1-2"], link(late)],
    [3, ["D001:3"], []],
    [4, ["D001:5-6"], link(swim)],
    [5, ["D001:1-2", "D001:5", "D001:7"], []],
  ];
  for (const [i, refs, links] of plan) {
    const p = paras[i];
    if (!p) continue;
    await setParagraphSources(s, p.id, refs.map(parseSourceRef), links);
  }
  log(`drafts: sources on ${plan.length} affidavit paragraphs`);
}
