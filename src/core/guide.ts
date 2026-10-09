/** The CLAUDE.md written into every case folder. It tells Claude Code how to work with the case. */
export const CLAUDE_GUIDE = `# Working in this case folder

This folder holds a family law case prepared with **casefile**. Everything you can see has been
de-identified: people, places, schools and identifying numbers are replaced with tokens.

## Rules

1. **Use the \`casefile\` CLI for everything.** Run \`casefile help\` to see commands. Do not open
   \`public.db\` directly, and never try to read \`vault/\` (it is encrypted and off-limits).
   This folder's \`.claude/settings.json\` runs your commands in Claude Code's sandbox, which is
   what keeps them inside this folder; its deny rules are only a backstop. Do not try to get
   around either, and do not run commands outside the sandbox.
2. **Tokens stand for real people and things.** \`{{mother}}\` is a person; \`{{mother.first}}\`,
   \`{{mother.surname}}\` and \`{{mother.title}}\` are forms of the same person's name. Write tokens
   exactly like that when you refer to them. \`casefile entities\` lists every valid token.
   Never invent a token or guess who a token is; the CLI rejects unknown tokens.
3. **Cite everything.** Every chronology entry and piece of evidence must cite document lines,
   e.g. \`D003:12-15\`. Use \`casefile docs show D003 --lines 10-20\` to check the lines first.
4. **Your work is unverified until the user checks it.** Anything you write is marked as written by
   Claude. The user verifies it in the casefile app. Do not describe your output as verified.
5. **Affidavits must be in the witness's own words** (FCFCOA PD-AI para 4.9). You may suggest
   structure and paragraphs, but every paragraph you write is tracked as yours and cannot be filed
   until the user rewrites or deliberately adopts it. Prefer \`casefile note add\` to suggest
   changes to the user's own paragraphs; you cannot edit them. When you draft:
   - **Never write the witness's feelings, opinions, beliefs or state of mind** ("I was
     terrified", "I believe he did it on purpose"). Only the witness can say those. Leave a
     placeholder instead: \`[In your own words: how you felt when this happened]\`. A paragraph
     with a placeholder cannot be adopted until the user replaces it.
   - **Always cite the paragraph's sources**: \`casefile para add 1 --text ... --source D001:3
     --source D001:5-6\`, and say which chronology entries or evidence it relies on with
     \`--relies chrono:N\` or \`--relies evidence:N\`. The user checks each paragraph against
     its sources before adopting it.
6. **Australian law only, and current.** If you refer to legislation or cases, say so plainly so
   the user can check them on AustLII or the Federal Register of Legislation (PD-AI para 4.7).
   **No outcome predictions and no legal advice**: do not say how the Court is likely to decide,
   what orders the user will get, or what they should do legally. Suggest they ask a lawyer or
   Legal Aid instead.
7. **Withheld documents** are listed but have no text, and cannot be cited. \`casefile docs show\`
   says why: the document came from the other side, from a subpoena or the court, is under a
   court order, the user is not sure (or has not said) where it came from, or it was found to show
   a real name and is being re-checked. Do not ask for their contents or guess what they say.
8. **No web access for this case** (FCFCOA PD-AI para 5.4). Do not search the web or fetch URLs
   about the case, the people in it or anything in its documents, by any means (web tools are
   turned off here; do not use \`curl\`, \`wget\` or similar instead). Do not publish case
   content anywhere (for example as an artifact).
9. **Keep case content inside the CLI.** Do not save case text, chronology, drafts or notes to
   files (in this folder or elsewhere); write them with \`casefile\` commands so they stay in the
   case and are logged.
10. **Do not change or remove what the user has verified, adopted or removed.** The CLI refuses;
   use \`casefile note add --on chrono:N\` (or \`issue:N\`, \`para:N\`) to suggest a change
   instead. Items the user removed are left out of lists. Never change \`public.db\` directly:
   the app detects verified or adopted items that disappear and reports them to the user.
11. **Respond to "Can't check" notes.** casefile checks your chronology entries, evidence and
   paragraphs against the lines they cite. When the user tells you, or a note says, that something
   can't be checked (a person who is not in the cited lines, a date or number that is not there,
   an unknown token), fix the citation or the wording, or explain in a note. Do not mark it as
   checked or describe it as correct.
12. **What you read through casefile is recorded** in the AI-use log (\`docs show\`, search
   results, and lines cited in the lists you view), so the user can say what Claude saw if a
   document later turns out to need withdrawing.

## Common commands

\`\`\`
casefile info                          # overview and counts
casefile entities                      # valid tokens
casefile docs list                     # index of documents
casefile docs show D001 --lines 1-40   # read with line numbers
casefile search "school pickup"        # full-text search with line numbers
casefile chrono add --date 2025-03-14 --text "{{father}} collected {{child_1}} late" --source D002:14-16
casefile issue add --title "Changeover arrangements"
casefile evidence add 1 --source D002:14-16 --note "Late collection" --stance supports
casefile draft new --kind outline --title "Case outline"
casefile para add 1 --text "..." --source D002:14-16 --relies chrono:1
casefile para list 1                   # paragraphs with their sources
\`\`\`

Every command accepts \`--json\` for machine-readable output.
`;
