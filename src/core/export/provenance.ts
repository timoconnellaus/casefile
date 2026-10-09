import { ADOPTION_FACTS_FILE, type FactRecord, paragraphState } from "../drafting.ts";
import type { CaseSession } from "../session.ts";
import type { ParaState } from "../states.ts";
import {
  describeLogRow,
  formatDate,
  planAndConfirmations,
  sealedLog,
  type SealedRow,
} from "../summary.ts";
import { type ExportFile, localDate } from "./draft.ts";
import { protectedAddressesIn, SafetyConfirmError, unescapeMarkdown } from "./safety.ts";

/**
 * A provenance report for one draft (Markdown; ADR 0021, ADR 0018): whose words each paragraph
 * is, when the user adopted Claude's, what they answered about each fact, and the log rows about
 * the draft. Like the Court summary, it is built only from records Claude cannot forge: paragraph
 * states and adoption times from the attestation ledger, the draft's kind from the ledger, the
 * fact answers from the vault, the plan from the vault's settings and log rows whose seal
 * verifies. Claude-writable columns (`author`, `adopted_at` unless signed, `created_by`) are
 * never read as facts; the sources a paragraph cites are not signed, so they are not listed.
 */

const KIND_WORD: Record<string, string> = {
  affidavit: "Affidavit",
  outline: "Outline",
  submission: "Submission",
  letter: "Letter",
  other: "Draft",
};

const STATE_WORDS: Record<ParaState, string> = {
  user: "Your words",
  claude_adopted: "Drafted by Claude — adopted by you",
  claude_rewritten: "Drafted by Claude — rewritten by you, not adopted yet",
  claude_needs_you: "Drafted by Claude — needs you",
};

/** A Markdown table cell: one line, pipes and backslashes escaped. */
function cell(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Markdown-inert text for a line outside tables (no headings, lists or HTML from content). */
function inline(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

function time(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(ts)}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whether a sealed log row is about this draft (or one of its paragraphs). */
function aboutDraft(r: SealedRow, draftId: number, paraIds: Set<number>): boolean {
  const d = r.detail;
  if (d.draft === draftId) return true;
  if ((r.action === "cli:draft_show" || r.action === "cli:draft_new") && d.id === draftId) {
    return true;
  }
  return r.action.startsWith("cli:para_") && typeof d.id === "number" && paraIds.has(d.id);
}

export async function provenanceReport(
  session: CaseSession,
  draftId: number,
  opts: { now?: Date; confirmSafety?: boolean } = {},
): Promise<ExportFile> {
  const draft = session.store.getDraft(draftId);
  const kind = (await session.draftKind(draft)).kind;
  const title = session.reidentify(draft.title).text;
  const paras = session.store.listParagraphs(draftId);
  const facts = await session.readVaultJson<Record<string, FactRecord>>(ADOPTION_FACTS_FILE, {});
  const now = opts.now ?? new Date();

  const rows: string[] = [];
  const counts: Record<ParaState, number> = {
    user: 0,
    claude_adopted: 0,
    claude_rewritten: 0,
    claude_needs_you: 0,
  };
  const answers = { saw: 0, read: 0, unsure: 0 };
  let n = 0;
  const fullTexts: string[] = [];
  for (const p of paras) {
    n++;
    const state = await paragraphState(session, p);
    counts[state]++;
    // An adoption time is trusted only when the adoption itself is (it is part of what is signed).
    const adopted = state === "claude_adopted" && p.adopted_at ? formatDate(p.adopted_at) : "—";
    const f = Object.hasOwn(facts, String(p.id)) ? facts[String(p.id)] : undefined;
    let factText = "—";
    if (state === "claude_adopted" && f && f.at === p.adopted_at && f.draft === draftId) {
      const c = { saw: 0, read: 0, unsure: 0 };
      for (const x of f.facts) if (x.answer in c) c[x.answer]++;
      answers.saw += c.saw;
      answers.read += c.read;
      answers.unsure += c.unsure;
      factText = [
        c.saw ? `${c.saw} saw or did myself` : "",
        c.read ? `${c.read} read` : "",
        c.unsure ? `${c.unsure} not sure` : "",
      ].filter(Boolean).join(", ") || "—";
    }
    const words = session.reidentify(p.body).text.replace(/\s+/g, " ").trim();
    fullTexts.push(words);
    const begins = words.length > 60 ? `${words.slice(0, 57)}…` : words;
    rows.push(
      `| ${n} | ${cell(begins)} | ${STATE_WORDS[state]} | ${adopted} | ${cell(factText)} |`,
    );
  }

  const paraIds = new Set(paras.map((p) => p.id));
  const log = await sealedLog(session);
  const mine = log.filter((r) => aboutDraft(r, draftId, paraIds));
  const usable = mine.filter((r) =>
    r.record === "signed" ||
    (r.actor === "claude" && (r.record === "countersigned" || r.record === "pending"))
  );
  const unverified = mine.length - usable.length;
  const check = await session.verifyLog();
  const plan = planAndConfirmations(session);
  const claude = n - counts.user;

  const out: string[] = [
    `# Provenance report: ${inline(title)}`,
    "",
    `${KIND_WORD[kind] ?? "Draft"} (draft ${draftId}). Prepared by casefile on ${
      formatDate(localDate(now))
    }.`,
    "",
    "This report is built only from what casefile recorded: the adoptions and rewrites you " +
    "signed in casefile, your answers kept on this computer, and log entries casefile sealed. " +
    "It says whose words each paragraph is. It does not say that any paragraph is right.",
    "",
    "## The draft",
    "",
    `- ${plural(n, "paragraph")}: ${counts.user} in your own words; ${
      claude === 0 ? "Claude drafted none" : `Claude drafted ${claude} (${
        [
          `${counts.claude_adopted} adopted by you`,
          counts.claude_rewritten
            ? `${counts.claude_rewritten} rewritten by you, not adopted yet`
            : "",
          `${counts.claude_needs_you} still need${counts.claude_needs_you === 1 ? "s" : ""} you`,
        ].filter(Boolean).join(", ")
      })`
    }.`,
    answers.saw + answers.read + answers.unsure
      ? `- When you adopted Claude's paragraphs you said, fact by fact: ${answers.saw} you saw ` +
        `or did yourself, ${answers.read} you read, ${answers.unsure} you were not sure about.`
      : "- No fact-by-fact answers were recorded for this draft.",
    `- Claude was used through casefile's command-line tool in Claude Code. ${
      plan.setup === "commercial"
        ? "Plan: a commercial plan with no-training terms"
        : "Plan: a consumer plan (Claude Pro or Max)"
    }, as recorded by you${plan.at ? ` on ${formatDate(plan.at)}` : ""}.`,
    "",
    "## Paragraph by paragraph",
    "",
    "| ¶ | Begins | Whose words | Adopted | Facts, as you answered |",
    "|---|---|---|---|---|",
    ...(rows.length ? rows : ["| — | No paragraphs yet | — | — | — |"]),
    "",
    "## The record",
    "",
    ...(usable.length
      ? usable.map((r) => {
        const e = describeLogRow(r);
        return `- ${time(r.ts)} — ${inline(e.label)}`;
      })
      : ["- casefile has no log entries about this draft."]),
    ...(unverified
      ? [
        `- ${
          plural(unverified, "log entry", "log entries")
        } about this draft could not be verified and ${unverified === 1 ? "is" : "are"} left out.`,
      ]
      : []),
    check.intact
      ? "- Log checked: no changes found."
      : "- Log checked: a change was found, so entries above may be affected.",
    "",
    "## What this report cannot show",
    "",
    "- What Claude did outside casefile. casefile only sees what goes through it.",
    "- Whether what a paragraph says is true. Adopting a paragraph records that you said it is " +
    "from your own knowledge and in your own words.",
    "- The sources each paragraph cites. They are kept where Claude can change them, so they " +
    "are not part of this report; the draft in casefile shows them.",
    "- Whether the plan you recorded is the one you used. casefile cannot check it with Anthropic.",
    "",
  ];
  const content = out.join("\n");
  // As the reader sees it (escapes removed) and the whole paragraphs the excerpts came from.
  const hits = protectedAddressesIn(session, [
    content,
    unescapeMarkdown(content),
    title,
    ...fullTexts,
  ]);
  if (hits.length && !opts.confirmSafety) {
    session.log("user", "export_safety_warned", {
      draft: draftId,
      format: "provenance",
      addresses: hits.length,
    });
    throw new SafetyConfirmError(hits);
  }
  session.log("user", "provenance_exported", {
    draft: draftId,
    paragraphs: n,
    ...(hits.length ? { safety_confirmed: hits.length } : {}),
  });
  return {
    filename: `provenance-${kind}-${draftId}-${localDate(now)}.md`,
    content,
    contentType: "text/markdown; charset=utf-8",
  };
}
