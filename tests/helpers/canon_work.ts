/**
 * CANON's documents, Claude's work, checks, the affidavit draft, paste uses, plan, confirmations
 * and the D006 exposure (docs/rebuild/CANON.md), seeded through core APIs on top of `seedCanon`.
 * Used by the To-check and Court summary tests (W1-H). SYNTHETIC data only (ADR 11).
 *
 * D006's exposure goes through the real flow (ADR 7): D006 is shared, Claude reads lines 1-12
 * through the CLI, then the user adds the nickname "Annie" and casefile withdraws it. Its dates are
 * therefore today's, not CANON's (28 Sep - 5 Oct 2025). Checks carry the two ticks (ADR 8).
 */
import type { CaseSession } from "../../src/core/session.ts";
import { PublicStore } from "../../src/core/publicdb.ts";
import type { Origin } from "../../src/core/publicdb.ts";
import {
  adoptParagraph,
  userAddParagraph,
  userCreateDraft,
  userEditParagraph,
} from "../../src/core/drafting.ts";
import { parseArgs } from "@std/cli/parse-args";
import { normaliseArgv, run, STRING_FLAGS } from "../../src/cli/commands.ts";
import { seedCanon } from "../fixtures/canon.ts";

/** The date the user confirmed the plan and the PD-AI 5.4 checklist (CANON: 3 September 2025). */
export const CONFIRMED_AT = "2025-09-03T02:00:00.000Z";

/** D003–D016 (D001 and D002 come from `seedCanon`). null origin: pending review. */
const MORE_DOCS: { title: string; origin: Origin; share: boolean }[] = [
  { title: "Swimming timetable", origin: "mine", share: true }, // D003
  { title: "School records, 2024", origin: "court_or_subpoena", share: true }, // D004
  { title: "Subpoena material, part 1", origin: "court_or_subpoena", share: true }, // D005
  { title: "Letter from the other side's lawyer", origin: "mine", share: true }, // D006 (Annie)
  { title: "Subpoena material, part 2", origin: "court_or_subpoena", share: true }, // D007
  { title: "Daniel's affidavit, May 2025", origin: "other_side", share: true }, // D008
  { title: "Family report", origin: "under_order", share: true }, // D009
  { title: "Handover notebook, 2024", origin: "not_sure", share: true }, // D010
  { title: "Calendar notes", origin: "mine", share: true }, // D011
  { title: "Doctor's letter", origin: "mine", share: true }, // D012
  { title: "Bank statement", origin: "mine", share: true }, // D013
  { title: "Swimming club email", origin: "mine", share: true }, // D014
  { title: "Email from childcare centre", origin: "mine", share: false }, // D015
  { title: "School reports term 2", origin: "mine", share: false }, // D016
];

function bodyFor(n: number): string {
  const lines = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of document number ${n}.`);
  // D006, D015 and D016 show the nickname "Annie", which casefile does not know yet.
  if (n === 6) lines[3] = "Our client says Annie refused the changeover on 21 March 2025.";
  if (n === 15) lines[0] = "Annie picked up the children at 3pm.";
  if (n === 16) lines[0] = "Annie attended the interview.";
  return lines.join("\n");
}

/** Two ticks for a chronology entry or evidence link, one for an issue (ADR 8 amendment). */
const TICKS = { quoteAccurate: true, fairReading: true };
const NEUTRAL = { neutral: true };

/** Run the Claude-facing CLI in-process against the case folder (its rows are Claude's). */
export async function cli(session: CaseSession, argv: string[]) {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: ["json", "help"],
    collect: ["source"],
    string: STRING_FLAGS,
  });
  const r = await run(args, {
    cwd: session.paths.root,
    env: {},
    readStdin: () => Promise.resolve(""),
  });
  if (r.code !== 0) throw new Error(`casefile ${argv.join(" ")}: ${r.err}`);
  return r;
}

export interface CanonWork {
  chronology: { checked: number[]; toCheck: number[]; cantCheck: number };
  issues: { id: number; title: string; checked: boolean }[];
  evidence: { checked: number[]; toCheck: number[] };
  draft: number;
  paragraphs: number[];
}

/** Write a log row the way the CLI does: through its own store, unchained (actor claude). */
export function cliLog(session: CaseSession, action: string, detail: Record<string, unknown>) {
  const store = PublicStore.open(session.paths.publicDb);
  try {
    store.log("claude", action, detail);
  } finally {
    store.close();
  }
}

/** Seed the whole CANON case (except the 303 ordinary shared documents) into an empty case. */
export async function seedCanonWork(session: CaseSession): Promise<CanonWork> {
  await seedCanon(session, { omitAliases: ["Annie"] });
  for (const [i, d] of MORE_DOCS.entries()) {
    const doc = await session.importText({
      title: d.title,
      text: bodyFor(i + 3),
      origin: d.origin,
    });
    if (d.share) await session.publishWithDefaults(doc.id);
  }
  // D006 is shared; Claude reads lines 1-12 through casefile; the user then adds "Annie".
  await cli(session, ["docs", "show", "D006", "--lines", "1-12"]);
  const mother = session.registry.get("mother")!;
  await session.updateEntity("mother", { aliases: [...mother.aliases, "Annie"] });

  const store = session.store;
  // ── chronology: 17 of Claude's entries, 12 checked, 4 to check, 1 can't check ──
  const chron = (event_date: string, description: string, sources: string[]) =>
    store.addChronology(
      {
        event_date,
        description,
        sources: sources.map((s) => {
          const m = /^(D\d+):(\d+)(?:-(\d+))?$/.exec(s)!;
          return { doc_id: m[1], line_start: Number(m[2]), line_end: Number(m[3] ?? m[2]) };
        }),
      },
      "claude",
    );
  const checked: number[] = [];
  const toCheck: number[] = [];
  // The main checking example (CANON): to check.
  toCheck.push(
    chron(
      "2025-03-14",
      "{{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.",
      ["D002:9", "D001:1-2"],
    ),
  );
  for (let i = 0; i < 3; i++) {
    toCheck.push(chron(`2025-03-1${5 + i}`, "A message about the arrangements.", ["D001:3"]));
  }
  for (let i = 0; i < 12; i++) {
    checked.push(
      chron(`2024-0${1 + (i % 9)}-1${i % 10}`, "An event in the case history.", [
        `D003:${i + 1}`,
      ]),
    );
  }
  // Can't check (after C): Claude wrote Mia, but D001:7 names Lachlan.
  const cantCheck = chron("2025-03-29", "{{child_1.first}} has a temperature.", ["D001:7"]);
  for (const id of checked) await session.ledger.verifyChronology(id, undefined, TICKS);

  // ── issues (4, Claude's; "Medical care" unchecked) and evidence (11; 9 checked) ──
  const titles = [
    "Reliability of changeovers",
    "Children's schooling and attendance",
    "Communication between parents",
    "Medical care",
  ];
  const issues = titles.map((title) => ({
    id: store.addIssue({ title, description: `Claude's description of ${title}.` }, "claude"),
    title,
    checked: title !== "Medical care",
  }));
  for (const i of issues) if (i.checked) await session.ledger.verifyIssue(i.id, undefined, NEUTRAL);
  const ev = (issue: number, doc: string, line: number) =>
    store.addEvidence(issue, { doc_id: doc, line_start: line, line_end: line }, "claude");
  const evToCheck = [ev(issues[0].id, "D001", 3), ev(issues[0].id, "D001", 6)];
  const evChecked: number[] = [];
  for (let i = 0; i < 9; i++) evChecked.push(ev(issues[(i % 3) + 1].id, "D003", i + 1));
  for (const id of evChecked) await session.ledger.verifyEvidence(id, undefined, TICKS);

  // ── the affidavit: ¶1 ¶2 ¶7 yours, ¶3 adopted, ¶4 rewritten, ¶5 ¶6 need you ──
  const draft = await userCreateDraft(session, "affidavit", "Affidavit of Anna Thornbury");
  const p1 = await userAddParagraph(session, draft, "I am the mother of Mia and Lachlan.");
  const p2 = await userAddParagraph(session, draft, "Daniel Okafor is the children's father.");
  const p3 = store.addParagraph(draft, "{{child_1.first}} attends {{school}}.", "claude");
  const p4 = store.addParagraph(draft, "{{father.first}} was late on 14 March 2025.", "claude");
  // ¶5 and ¶6 came from Paste (D logs paste_added with the paragraph count).
  const p5 = store.addParagraph(draft, "{{child_2.first}} attends {{childcare}}.", "claude");
  const p6 = store.addParagraph(draft, "Swimming moved to {{place_1}}.", "claude");
  const p7 = await userAddParagraph(session, draft, "I ask the Court to make the orders sought.");
  await adoptParagraph(session, p3, { ownKnowledge: true, ownWords: true });
  // The user's rewrite of Claude's paragraph: "rewritten by you, adopt to confirm" (ADR 9).
  await userEditParagraph(session, p4, "Daniel was late on 14 March 2025, again.");

  // ── paste: 3 uses logged (one added 2 passages to the draft as Claude's) ──
  for (let i = 0; i < 3; i++) {
    session.log("user", "reidentified_text", { chars: 120, unknown: 0 });
  }
  session.log("user", "paste_added", { draft, paragraphs: 2 });

  // ── plan and PD-AI 5.4 confirmations, as recorded by the user ──
  await session.updateSettings({
    plan: { setup: "consumer", at: CONFIRMED_AT },
    confirmations: { helpImproveOff: CONFIRMED_AT, chatHistory: CONFIRMED_AT },
  });
  cliLog(session, "cli:chrono_list", {});
  session.log("app", "case_opened", {}); // countersigns Claude's rows

  return {
    chronology: { checked, toCheck, cantCheck },
    issues,
    evidence: { checked: evChecked, toCheck: evToCheck },
    draft,
    paragraphs: [p1, p2, p3, p4, p5, p6, p7],
  };
}
