import { join } from "@std/path";
import { casePaths, findCaseDir, isCaseDir } from "../core/case.ts";
import {
  type ChronologyRow,
  DRAFT_KINDS,
  type DraftKind,
  formatLines,
  formatSourceRef,
  InvalidInputError,
  type LoggedHit,
  type LoggedLines,
  MAX_LOGGED_HITS,
  NotFoundError,
  type ParagraphLink,
  type ParagraphLinkType,
  type ParagraphRow,
  parseSourceRef,
  PublicStore,
  type SourceRef,
  type Stance,
  STANCES,
  withheldBecause,
} from "../core/publicdb.ts";
import { validateTokens } from "../core/tokens.ts";

export interface CliArgs {
  _: (string | number)[];
  json?: boolean;
  help?: boolean;
  [flag: string]: unknown;
}

export interface CliContext {
  cwd: string;
  env: Record<string, string>;
  readStdin: () => Promise<string>;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

class UsageError extends Error {}

/** Text flags given as "-" read stdin. parseArgs treats a bare "-" as positional, so join it. */
export function normaliseArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && !argv[i].includes("=") && argv[i + 1] === "-") {
      out.push(`${argv[i]}=-`);
      i++;
    } else out.push(argv[i]);
  }
  return out;
}

export const STRING_FLAGS = [
  "case",
  "lines",
  "title",
  "type",
  "date",
  "author-role",
  "source",
  "text",
  "desc",
  "note",
  "stance",
  "kind",
  "after",
  "on",
  "tag",
  "from",
  "to",
  "limit",
  "relies",
];

/** Flags that may be given more than once. */
export const COLLECT_FLAGS = ["source", "relies"] as const;

export const HELP = `casefile — work with a de-identified case (for Claude Code)

Usage: casefile <command> [options]      (add --json to any command for JSON output)

Case
  info                                    overview, counts and the Claude setup in use
  entities                                valid tokens ({{role}}, {{role.first}}, ...) and what
                                          the user says about each
  log [--limit N]                         recent AI-use log entries

Documents
  docs list [--tag T] [--type T]          index of documents
  docs show ID [--lines A-B]              text with line numbers (withheld documents: why)
  docs meta ID [--title T] [--type T] [--date YYYY-MM-DD] [--author-role R] [--source S]
  search WORDS... [--limit N]             full-text search; results cite ID:line (at most 200)
  tags                                    all tags with counts
  tag add ID TAG | tag rm ID TAG

Chronology
  chrono list [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  chrono add --date D --text T --source ID:A-B [--source ...]
  chrono edit N [--date D] [--text T] [--source ID:A-B ...]
  chrono rm N                             (only unverified entries Claude wrote that no draft
                                          paragraph relies on; the same goes for chrono edit)

Issues and evidence
  issue list | issue show N
  issue add --title T [--desc D]
  issue edit N [--title T] [--desc D]
  issue rm N                              (only unverified issues Claude wrote, with only
                                          Claude's unverified, unremoved evidence)
  evidence add ISSUE --source ID:A-B [--note N] [--stance supports|undermines|context]
  evidence rm N                           (only unverified evidence Claude added)

Notes
  note add --on TARGET --text T           TARGET is case, doc:ID, chrono:N, issue:N, draft:N or para:N
  note list [--on TARGET]

Drafts
  draft list | draft show N
  draft new --kind affidavit|outline|submission|letter|other --title T
  para list DRAFT | para show PARA        paragraphs with their sources and what they rely on
  para add DRAFT --text T [--source ID:A-B ...] [--relies chrono:N|evidence:N ...] [--after PARA]
                                          (cite the lines each paragraph is based on)
  para edit PARA [--text T] [--source ID:A-B ...] [--relies ...]
                                          (only unadopted paragraphs Claude wrote; --source and
                                          --relies replace the paragraph's lists; "none" clears)
  para rm PARA                            (only unadopted paragraphs Claude wrote that the user
                                          has not edited; the same goes for para edit)

Anything the user has verified, adopted or removed cannot be changed or removed; leave a note
instead. Lists leave out items the user removed.
What you read through casefile (docs show, search results, cited lines in lists) is recorded in
the AI-use log.

Text options accept "-" to read from stdin, e.g.  --text -  < paragraph.txt
The case folder is found from --case DIR, $CASEFILE_CASE, or by searching up from the current directory.
`;

function str(args: CliArgs, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === false) return undefined;
  return String(v);
}

function req(args: CliArgs, name: string): string {
  const v = str(args, name);
  if (v === undefined || v === "") throw new UsageError(`Missing --${name}`);
  return v;
}

function posInt(v: string | number | undefined, what: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n) || n < 1) {
    throw new UsageError(`Expected ${what} to be a positive number`);
  }
  return n;
}

function many(args: CliArgs, name: string): string[] {
  const v = args[name];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
}

function sources(args: CliArgs): string[] {
  return many(args, "source");
}

const RELIES_TYPES: Record<string, ParagraphLinkType> = {
  chrono: "chronology",
  evidence: "evidence",
};
const RELIES_PREFIX: Record<ParagraphLinkType, string> = {
  chronology: "chrono",
  evidence: "evidence",
};

function parseRelies(v: string): ParagraphLink {
  const m = /^(chrono|evidence):(\d+)$/.exec(v.trim());
  if (!m || Number(m[2]) < 1) {
    throw new UsageError(
      `--relies must look like chrono:N or evidence:N, not ${JSON.stringify(v)}`,
    );
  }
  return { target_type: RELIES_TYPES[m[1]], target_id: Number(m[2]) };
}

function formatLink(l: ParagraphLink): string {
  return `${RELIES_PREFIX[l.target_type]}:${l.target_id}`;
}

/** The cited ranges to log for what a command showed (ADR 16), each range once. */
function cited(refs: SourceRef[]): LoggedLines[] {
  const seen = new Set<string>();
  const out: LoggedLines[] = [];
  for (const r of refs) {
    const lines = formatLines(r.line_start, r.line_end);
    const key = `${r.doc_id}:${lines}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ doc: r.doc_id, lines });
  }
  return out;
}

function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd()
  ).join(
    "\n",
  );
}

function who(by: string) {
  return by === "claude" ? "claude" : "user";
}

/**
 * Claude may not change or remove anything the user has verified or adopted (design review): it
 * leaves a note instead. The CLI goes by public.db's `verified_at`/`adopted_at`; changing those
 * with SQL to get round this is caught by the app, which reports attested items that disappear.
 */
function refuseIfAttested(
  row: { verified_at?: string | null; adopted_at?: string | null },
  what: string,
  noteTarget: string,
) {
  const adopted = Boolean(row.adopted_at);
  if (row.verified_at || adopted) {
    throw new InvalidInputError(
      `${what} has been ${
        adopted ? "adopted" : "verified"
      } by the user; Claude cannot change or remove it. Leave a note instead: casefile note add --on ${noteTarget} --text ...`,
    );
  }
}

/**
 * Claude may not change or remove what the user removed (it is restorable from Removed items).
 * `removed_at` is Claude-writable, so it is only ever a reason to refuse, never to allow.
 */
function refuseIfRemoved(
  row: { removed_at?: string | null; removed_by?: string | null },
  what: string,
) {
  if (row.removed_at) {
    throw new InvalidInputError(
      `${what} was ${
        row.removed_by === "claude" ? "removed" : "removed by the user"
      }; Claude cannot change or remove it. The user can restore it from Removed items.`,
    );
  }
}

function verifiedMark(row: { verified_at: string | null }) {
  // The CLI cannot check signatures (it has no key); it reports what the store says.
  return row.verified_at ? "verified" : "UNVERIFIED";
}

export async function run(args: CliArgs, ctx: CliContext): Promise<CliResult> {
  const json = Boolean(args.json);
  const pos = args._.map(String);
  if (args.help || pos.length === 0 || pos[0] === "help") return { code: 0, out: HELP, err: "" };

  const caseDir = str(args, "case") ?? ctx.env["CASEFILE_CASE"] ?? findCaseDir(ctx.cwd);
  if (!caseDir || !isCaseDir(caseDir)) {
    return {
      code: 2,
      out: "",
      err:
        "No case folder found. Run inside a case folder, or pass --case DIR or set CASEFILE_CASE.",
    };
  }
  const paths = casePaths(caseDir);
  let store: PublicStore;
  try {
    store = PublicStore.open(paths.publicDb);
  } catch (e) {
    return { code: 2, out: "", err: (e as Error).message };
  }
  const text = async (name: string, required = true) => {
    const v = required ? req(args, name) : str(args, name);
    if (v === "-") return (await ctx.readStdin()).replace(/\s+$/, "");
    return v;
  };
  /** Every piece of text Claude writes must use valid tokens only. */
  const checkTokens = (t: string | undefined) => {
    if (t === undefined) return;
    const v = validateTokens(t, store.knownRoles());
    if (!v.ok) {
      const parts = [
        ...v.unknown.map((u) => `unknown token ${u.raw}`),
        ...v.malformed.map((m) => `malformed token ${JSON.stringify(m.raw)}`),
      ];
      throw new InvalidInputError(`${parts.join("; ")}. Run "casefile entities" for valid tokens.`);
    }
  };
  const out = (human: string, data: unknown) => json ? JSON.stringify(data, null, 2) : human;

  try {
    const [cmd, sub, ...rest] = pos;
    let result: string;
    switch (cmd) {
      case "info": {
        const s = store.stats({ excludeRemoved: true });
        const setup = store.getInfo("claude_setup") ?? "consumer";
        result = out(
          [
            `Case folder: ${paths.root}`,
            `Claude setup: ${setup}${
              setup === "consumer" ? " (only the user's own documents are shared)" : ""
            }`,
            `Documents: ${s.documents} (${s.withheld} withheld)`,
            `Entities: ${s.entities}`,
            `Chronology entries: ${s.chronology} (${s.chronology_unverified} unverified)`,
            `Issues: ${s.issues}, evidence links: ${s.evidence}`,
            `Drafts: ${s.drafts}, notes: ${s.notes}`,
            "",
            `Read ${join(paths.root, "CLAUDE.md")} for how to work in this case.`,
          ].join("\n"),
          { case: paths.root, claude_setup: setup, ...s },
        );
        store.log("claude", "cli:info");
        break;
      }
      case "entities": {
        const ents = store.listEntities();
        result = out(
          ents.length
            ? table([
              ["TOKEN", "KIND", "OTHER FORMS", "ABOUT"],
              ...ents.map((e) => [
                `{{${e.role}}}`,
                e.kind,
                e.kind === "person"
                  ? `{{${e.role}.first}} {{${e.role}.surname}} {{${e.role}.title}}`
                  : "",
                e.description ?? "",
              ]),
            ])
            : "No entities yet.",
          ents,
        );
        store.log("claude", "cli:entities");
        break;
      }
      case "log": {
        const limit = str(args, "limit") ? posInt(str(args, "limit"), "--limit") : 50;
        const rows = store.listLog(limit);
        result = out(
          table([
            ["TIME", "ACTOR", "ACTION", "DETAIL"],
            ...rows.map((r) => [r.ts, r.actor, r.action, r.detail]),
          ]),
          rows,
        );
        store.log("claude", "cli:log", { limit });
        break;
      }
      case "docs": {
        if (sub === "list" || sub === undefined) {
          const docs = store.listDocuments({ tag: str(args, "tag"), type: str(args, "type") });
          result = out(
            docs.length
              ? table([
                ["ID", "DATE", "TYPE", "LINES", "TITLE"],
                ...docs.map((d) => [
                  d.id,
                  d.doc_date ?? "",
                  d.doc_type ?? "",
                  d.withheld ? "withheld" : String(d.line_count),
                  d.title,
                ]),
              ])
              : "No documents published yet.",
            docs.map((d) => ({
              ...d,
              tags: store.tagsFor(d.id),
              withheld_because: d.withheld ? withheldBecause(d) : null,
            })),
          );
          store.log("claude", "cli:docs_list", { tag: str(args, "tag"), type: str(args, "type") });
        } else if (sub === "show") {
          const id = rest[0];
          if (!id) throw new UsageError("Usage: casefile docs show ID [--lines A-B]");
          const doc = store.getDocument(id);
          let from = 1, to = doc.line_count;
          const range = str(args, "lines");
          if (range) {
            const m = /^(\d+)(?:-(\d+))?$/.exec(range);
            if (!m) throw new UsageError("--lines must look like 10-20");
            from = Number(m[1]);
            to = m[2] ? Number(m[2]) : from;
          }
          const lines = store.getLines(id, from, to);
          const tags = store.tagsFor(id);
          const header = [
            `${doc.id}  ${doc.title}`,
            `type: ${doc.doc_type ?? "-"}  date: ${doc.doc_date ?? "-"}  author: ${
              doc.author_role ?? "-"
            }  lines: ${doc.line_count}${tags.length ? `  tags: ${tags.join(", ")}` : ""}`,
          ];
          const because = doc.withheld ? withheldBecause(doc) : null;
          if (because) {
            header.push(
              `This document is withheld from Claude because ${because}. Its text is not available; do not ask for it.`,
            );
          }
          const w = String(doc.line_count).length;
          result = out(
            [...header, "", ...lines.map((l) => `${String(l.line_no).padStart(w)}  ${l.text}`)]
              .join("\n"),
            { ...doc, body: undefined, tags, lines, withheld_because: because },
          );
          // The lines actually returned (ADR 16): what Claude read, not what it asked for.
          store.log("claude", "cli:docs_show", {
            doc: id,
            lines: lines.length ? formatLines(lines[0].line_no, lines.at(-1)!.line_no) : "",
          });
        } else if (sub === "meta") {
          const id = rest[0];
          if (!id) throw new UsageError("Usage: casefile docs meta ID [--title T] ...");
          const meta = {
            title: str(args, "title"),
            doc_type: str(args, "type"),
            doc_date: str(args, "date"),
            author_role: str(args, "author-role"),
            source: str(args, "source") === undefined ? undefined : sources(args)[0],
          };
          for (const v of Object.values(meta)) checkTokens(v);
          if (store.getDocument(id).meta_by === "user") {
            throw new InvalidInputError(
              `The user has set ${id}'s details; Claude cannot change them. Suggest a change with: casefile note add --on doc:${id} --text ...`,
            );
          }
          store.setDocumentMeta(id, meta, "claude");
          store.log("claude", "cli:docs_meta", { doc: id, ...meta });
          result = out(`Updated ${id}.`, { ok: true, id });
        } else throw new UsageError(`Unknown docs command: ${sub}`);
        break;
      }
      case "search": {
        const q = [sub, ...rest].filter(Boolean).join(" ");
        if (!q) throw new UsageError("Usage: casefile search WORDS...");
        // Every hit shown is logged (ADR 16), so no more are shown than can be logged.
        const asked = str(args, "limit") ? posInt(str(args, "limit"), "--limit") : 50;
        const limit = Math.min(asked, MAX_LOGGED_HITS);
        const hits = store.search(q, limit);
        const capped = asked > limit && hits.length === limit;
        result = out(
          hits.length
            ? hits.map((h) => `${h.doc_id}:${h.line}  ${h.snippet}`).join("\n") +
              (capped ? `\n(showing the first ${limit} matches; narrow the search)` : "")
            : "No matches.",
          hits,
        );
        const logged: LoggedHit[] = hits.map((h) => ({ doc: h.doc_id, line: h.line }));
        store.log("claude", "cli:search", { query: q, total: hits.length, hits: logged });
        break;
      }
      case "tags": {
        const tags = store.allTags();
        result = out(
          tags.length ? table(tags.map((t) => [t.tag, String(t.count)])) : "No tags yet.",
          tags,
        );
        store.log("claude", "cli:tags");
        break;
      }
      case "tag": {
        const [id, tag] = rest;
        if (!id || !tag) throw new UsageError("Usage: casefile tag add|rm ID TAG");
        if (sub === "add") store.addTag(id, tag, "claude");
        else if (sub === "rm") {
          const by = store.tagCreatedBy(id, tag);
          if (by === undefined) throw new InvalidInputError(`${id} is not tagged ${tag}`);
          if (by !== "claude") {
            throw new InvalidInputError(
              `The user added tag "${tag}" to ${id}; Claude cannot remove it`,
            );
          }
          store.removeTag(id, tag);
        } else throw new UsageError(`Unknown tag command: ${sub}`);
        store.log("claude", `cli:tag_${sub}`, { doc: id, tag });
        result = out(`${sub === "add" ? "Tagged" : "Untagged"} ${id} ${tag}.`, { ok: true });
        break;
      }
      case "chrono": {
        result = await chrono(sub, rest);
        break;
      }
      case "issue": {
        result = await issue(sub, rest);
        break;
      }
      case "evidence": {
        if (sub === "add") {
          const issueId = posInt(rest[0], "ISSUE");
          refuseIfRemoved(store.getIssue(issueId), `Issue ${issueId}`);
          const srcs = sources(args);
          if (srcs.length !== 1) {
            throw new UsageError("evidence add needs exactly one --source ID:A-B");
          }
          const note = await text("note", false);
          checkTokens(note);
          const stance = (str(args, "stance") ?? "supports") as Stance;
          if (!STANCES.includes(stance)) {
            throw new UsageError(`--stance must be one of ${STANCES.join(", ")}`);
          }
          const id = store.addEvidence(
            issueId,
            { ...parseSourceRef(srcs[0]), note, stance },
            "claude",
          );
          store.log("claude", "cli:evidence_add", { id, issue: issueId, source: srcs[0] });
          result = out(`Added evidence ${id} to issue ${issueId} (unverified).`, { id });
        } else if (sub === "rm") {
          const id = posInt(rest[0], "N");
          const ev = store.getEvidence(id);
          if (ev.created_by !== "claude") {
            throw new InvalidInputError(
              `Evidence ${id} was added by the user; Claude cannot remove it`,
            );
          }
          refuseIfAttested(ev, `Evidence ${id}`, `issue:${ev.issue_id}`);
          refuseIfRemoved(ev, `Evidence ${id}`);
          // Like evidence add: a removed issue's links go with it if the user restores it.
          refuseIfRemoved(store.getIssue(ev.issue_id), `Evidence ${id}'s issue ${ev.issue_id}`);
          refuseIfReliedOn("evidence", id, `Evidence ${id}`);
          store.deleteEvidence(id);
          store.log("claude", "cli:evidence_rm", { id });
          result = out(`Removed evidence ${id}.`, { ok: true });
        } else throw new UsageError(`Unknown evidence command: ${sub}`);
        break;
      }
      case "note": {
        if (sub === "add") {
          const on = str(args, "on") ?? "case";
          const [type, target] = parseTarget(on, store);
          const body = (await text("text"))!;
          checkTokens(body);
          const id = store.addNote(type, target, body, "claude");
          store.log("claude", "cli:note_add", { id, on });
          result = out(`Added note ${id} on ${on}.`, { id });
        } else if (sub === "list" || sub === undefined) {
          const on = str(args, "on");
          const notes = on ? store.listNotes(...parseTarget(on, store)) : store.listNotes();
          result = out(
            notes.length
              ? notes.map((n) =>
                `#${n.id} [${n.target_type}:${n.target_id}] (${who(n.created_by)}) ${n.body}`
              ).join("\n")
              : "No notes.",
            notes,
          );
          store.log("claude", "cli:note_list", { on: on ?? "all" });
        } else throw new UsageError(`Unknown note command: ${sub}`);
        break;
      }
      case "draft": {
        result = await draft(sub, rest);
        break;
      }
      case "para": {
        result = await para(sub, rest);
        break;
      }
      default:
        throw new UsageError(`Unknown command: ${cmd}. Run "casefile help".`);
    }
    return { code: 0, out: result, err: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof UsageError
      ? 2
      : e instanceof NotFoundError || e instanceof InvalidInputError
      ? 1
      : 3;
    return { code, out: "", err: json ? JSON.stringify({ error: msg }) : `Error: ${msg}` };
  } finally {
    store.close();
  }

  // ── sub-command groups ────────────────────────────────────────────────

  async function chrono(sub: string | undefined, rest: string[]): Promise<string> {
    const fmt = (e: ChronologyRow) =>
      `#${e.id}  ${e.event_date}  [${who(e.created_by)}, ${verifiedMark(e)}]  ${e.description}  (${
        e.sources.map(formatSourceRef).join(", ") || "no source"
      })`;
    if (sub === "list" || sub === undefined) {
      const rows = store.listChronology({ from: str(args, "from"), to: str(args, "to") });
      store.log("claude", "cli:chrono_list", {
        from: str(args, "from"),
        to: str(args, "to"),
        cited: cited(rows.flatMap((r) => r.sources)),
      });
      return out(rows.length ? rows.map(fmt).join("\n") : "No chronology entries yet.", rows);
    }
    if (sub === "add") {
      const description = (await text("text"))!;
      checkTokens(description);
      const id = store.addChronology(
        { event_date: req(args, "date"), description, sources: sources(args).map(parseSourceRef) },
        "claude",
      );
      store.log("claude", "cli:chrono_add", { id, sources: sources(args) });
      return out(`Added chronology entry ${id} (unverified).`, { id });
    }
    if (sub === "edit") {
      const id = posInt(rest[0], "N");
      const entry = store.getChronology(id);
      if (entry.created_by !== "claude") {
        throw new InvalidInputError(
          `Entry ${id} was written by the user; Claude cannot change it. Suggest a change with: casefile note add --on chrono:${id} --text ...`,
        );
      }
      refuseIfAttested(entry, `Entry ${id}`, `chrono:${id}`);
      refuseIfRemoved(entry, `Entry ${id}`);
      // Like rm: changing an entry changes what the paragraphs relying on it are based on.
      refuseIfReliedOn("chronology", id, `Entry ${id}`);
      const description = await text("text", false);
      checkTokens(description);
      const src = sources(args);
      store.updateChronology(id, {
        event_date: str(args, "date"),
        description,
        sources: src.length ? src.map(parseSourceRef) : undefined,
      });
      store.log("claude", "cli:chrono_edit", {
        id,
        ...(str(args, "date") ? { date: str(args, "date") } : {}),
        ...(src.length ? { sources: src } : {}),
      });
      return out(`Updated chronology entry ${id} (now unverified).`, { ok: true, id });
    }
    if (sub === "rm") {
      const id = posInt(rest[0], "N");
      const entry = store.getChronology(id);
      if (entry.created_by !== "claude") {
        throw new InvalidInputError(`Entry ${id} was written by the user; Claude cannot remove it`);
      }
      refuseIfAttested(entry, `Entry ${id}`, `chrono:${id}`);
      refuseIfRemoved(entry, `Entry ${id}`);
      refuseIfReliedOn("chronology", id, `Entry ${id}`);
      store.deleteChronology(id);
      store.log("claude", "cli:chrono_rm", { id });
      return out(`Removed chronology entry ${id}.`, { ok: true });
    }
    throw new UsageError(`Unknown chrono command: ${sub}`);
  }

  async function issue(sub: string | undefined, rest: string[]): Promise<string> {
    if (sub === "list" || sub === undefined) {
      const rows = store.listIssues().map((i) => ({
        ...i,
        evidence: store.listEvidence(i.id).length,
      }));
      store.log("claude", "cli:issue_list");
      return out(
        rows.length
          ? rows.map((i) =>
            `#${i.id}  ${i.title}  [${who(i.created_by)}, ${
              verifiedMark(i)
            }]  evidence: ${i.evidence}`
          ).join("\n")
          : "No issues yet.",
        rows,
      );
    }
    if (sub === "show") {
      const id = posInt(rest[0], "N");
      const i = store.getIssue(id);
      if (i.removed_at) {
        throw new InvalidInputError(
          `Issue ${id} was ${i.removed_by === "claude" ? "removed" : "removed by the user"}.`,
        );
      }
      const ev = store.listEvidence(id);
      store.log("claude", "cli:issue_show", { id, cited: cited(ev) });
      return out(
        [
          `#${i.id}  ${i.title}  [${who(i.created_by)}, ${verifiedMark(i)}]`,
          i.description,
          "",
          "Evidence:",
          ...(ev.length
            ? ev.map((e) =>
              `  #${e.id} ${formatSourceRef(e)} ${e.stance} [${who(e.created_by)}, ${
                verifiedMark(e)
              }] ${e.note}`
            )
            : ["  (none)"]),
        ].join("\n"),
        { ...i, evidence: ev },
      );
    }
    if (sub === "add") {
      const title = (await text("title"))!;
      const description = (await text("desc", false)) ?? "";
      checkTokens(title);
      checkTokens(description);
      const id = store.addIssue({ title, description }, "claude");
      store.log("claude", "cli:issue_add", { id });
      return out(`Added issue ${id} (unverified).`, { id });
    }
    if (sub === "edit") {
      const id = posInt(rest[0], "N");
      const row = store.getIssue(id);
      if (row.created_by !== "claude") {
        throw new InvalidInputError(
          `Issue ${id} was written by the user; Claude cannot change it. Suggest a change with: casefile note add --on issue:${id} --text ...`,
        );
      }
      refuseIfAttested(row, `Issue ${id}`, `issue:${id}`);
      refuseIfRemoved(row, `Issue ${id}`);
      const title = await text("title", false);
      const description = await text("desc", false);
      checkTokens(title);
      checkTokens(description);
      store.updateIssue(id, { title, description });
      store.log("claude", "cli:issue_edit", { id });
      return out(`Updated issue ${id} (now unverified).`, { ok: true, id });
    }
    if (sub === "rm") {
      const id = posInt(rest[0], "N");
      const row = store.getIssue(id);
      if (row.created_by !== "claude") {
        throw new InvalidInputError(`Issue ${id} was written by the user; Claude cannot remove it`);
      }
      refuseIfAttested(row, `Issue ${id}`, `issue:${id}`);
      refuseIfRemoved(row, `Issue ${id}`);
      // Removing an issue removes its evidence links, so every one must be Claude's, unverified,
      // not removed (the user may restore it) and not relied on by a draft paragraph. Removed
      // links are checked too: `removed_at` is Claude-writable, so it must not hide a link here.
      const all = store.listEvidence(id, { includeRemoved: true });
      const kept = all.filter((e) => e.created_by !== "claude" || e.verified_at || e.removed_at);
      if (kept.length) {
        throw new InvalidInputError(
          `Issue ${id} has evidence the user added, verified or removed (${
            kept.map((e) => `#${e.id}`).join(", ")
          }); Claude cannot remove it. Leave a note instead: casefile note add --on issue:${id} --text ...`,
        );
      }
      for (const e of all) refuseIfReliedOn("evidence", e.id, `Issue ${id}'s evidence #${e.id}`);
      store.deleteIssue(id);
      store.log("claude", "cli:issue_rm", { id });
      return out(`Removed issue ${id}.`, { ok: true });
    }
    throw new UsageError(`Unknown issue command: ${sub}`);
  }

  async function draft(sub: string | undefined, rest: string[]): Promise<string> {
    if (sub === "list" || sub === undefined) {
      const rows = store.listDrafts();
      store.log("claude", "cli:draft_list");
      return out(
        rows.length ? table(rows.map((d) => [`#${d.id}`, d.kind, d.title])) : "No drafts yet.",
        rows,
      );
    }
    if (sub === "new") {
      const kind = req(args, "kind") as DraftKind;
      if (!DRAFT_KINDS.includes(kind)) {
        throw new UsageError(`--kind must be one of ${DRAFT_KINDS.join(", ")}`);
      }
      const title = (await text("title"))!;
      checkTokens(title);
      const id = store.createDraft({ kind, title }, "claude");
      store.log("claude", "cli:draft_new", { id, kind });
      return out(`Created draft ${id}.`, { id });
    }
    if (sub === "show") {
      const id = posInt(rest[0], "N");
      const d = store.getDraft(id);
      const paras = store.listParagraphs(id).map(withRefs);
      store.log("claude", "cli:draft_show", {
        id,
        cited: cited(paras.flatMap((p) => p.sources)),
      });
      return out(
        [
          `#${d.id}  ${d.kind}: ${d.title}`,
          d.kind === "affidavit"
            ? "Affidavit: paragraphs must end up in the witness's own words. Claude-written paragraphs are tracked."
            : "",
          "",
          ...paras.map((p, i) => fmtPara(p, i + 1)),
        ].filter((l, i) => i !== 1 || l).join("\n"),
        { ...d, paragraphs: paras },
      );
    }
    throw new UsageError(`Unknown draft command: ${sub}`);
  }

  /** A paragraph with its sources and what it relies on. */
  function withRefs(p: ParagraphRow) {
    return {
      ...p,
      sources: store.listParagraphSources(p.id),
      relies: store.listParagraphLinks(p.id),
    };
  }

  function fmtLink(l: ParagraphLink): string {
    try {
      const row = l.target_type === "chronology"
        ? store.getChronology(l.target_id)
        : store.getEvidence(l.target_id);
      return row.removed_at ? `${formatLink(l)} (removed)` : formatLink(l);
    } catch (e) {
      if (e instanceof NotFoundError) return `${formatLink(l)} (deleted)`;
      throw e;
    }
  }

  function fmtPara(p: ReturnType<typeof withRefs>, n: number): string {
    const head = `${n}. [para ${p.id}, ${
      p.author === "claude" ? (p.adopted_at ? "claude, adopted" : "claude") : "user"
    }] ${p.body}`;
    const refs = [
      `sources: ${p.sources.map(formatSourceRef).join(", ") || "none"}`,
      ...(p.relies.length ? [`relies on: ${p.relies.map(fmtLink).join(", ")}`] : []),
    ];
    return `${head}\n   ${refs.join("; ")}`;
  }

  /** `--source none` or `--relies none`: clear the list (para edit). */
  function isNone(name: string): boolean {
    const v = many(args, name);
    return v.length === 1 && v[0] === "none";
  }

  /** --source values, checked: each must cite visible lines (withheld documents are refused). */
  function paraSources(): SourceRef[] {
    const refs = sources(args).map(parseSourceRef);
    for (const r of refs) store.checkSourceRef(r);
    return refs;
  }

  /** --relies values, checked: each must exist and not have been removed by the user. */
  function paraRelies(): ParagraphLink[] {
    const links = many(args, "relies").map(parseRelies);
    for (const l of links) {
      const row = l.target_type === "chronology"
        ? store.getChronology(l.target_id)
        : store.getEvidence(l.target_id);
      const issue = l.target_type === "evidence"
        ? store.getIssue((row as { issue_id: number }).issue_id)
        : undefined;
      for (const [r, what] of [[row, formatLink(l)], [issue, "its issue"]] as const) {
        if (r?.removed_at) {
          throw new InvalidInputError(
            `${formatLink(l)}: ${what} was ${
              r.removed_by === "claude" ? "removed" : "removed by the user"
            }; a paragraph cannot rely on it`,
          );
        }
      }
    }
    return links;
  }

  async function para(sub: string | undefined, rest: string[]): Promise<string> {
    if (sub === "list") {
      const draftId = posInt(rest[0], "DRAFT");
      store.getDraft(draftId);
      const paras = store.listParagraphs(draftId).map(withRefs);
      store.log("claude", "cli:para_list", {
        draft: draftId,
        cited: cited(paras.flatMap((p) => p.sources)),
      });
      return out(
        paras.length ? paras.map((p, i) => fmtPara(p, i + 1)).join("\n") : "No paragraphs yet.",
        paras,
      );
    }
    if (sub === "show") {
      const id = posInt(rest[0], "PARA");
      const p = withRefs(store.getParagraph(id));
      const n = store.listParagraphs(p.draft_id).findIndex((x) => x.id === id) + 1;
      store.log("claude", "cli:para_show", { id, cited: cited(p.sources) });
      return out(fmtPara(p, n), p);
    }
    if (sub === "add") {
      const draftId = posInt(rest[0], "DRAFT");
      const body = (await text("text"))!;
      checkTokens(body);
      const after = str(args, "after") ? posInt(str(args, "after"), "--after") : undefined;
      const srcs = paraSources();
      const links = paraRelies();
      const id = store.tx(() => {
        const id = store.addParagraph(draftId, body, "claude", after);
        if (srcs.length) store.setParagraphSources(id, srcs);
        if (links.length) store.setParagraphLinks(id, links);
        return id;
      });
      store.log("claude", "cli:para_add", {
        id,
        draft: draftId,
        sources: srcs.map(formatSourceRef),
        relies: links.map(formatLink),
      });
      return out(
        `Added paragraph ${id} to draft ${draftId} (written by Claude${
          srcs.length ? "" : "; no sources: cite the lines it is based on with --source"
        }).`,
        { id },
      );
    }
    if (sub === "edit") {
      const id = posInt(rest[0], "PARA");
      const p = store.getParagraph(id);
      if (p.author !== "claude") {
        throw new InvalidInputError(
          `Paragraph ${id} is the user's own words; Claude cannot edit it. Suggest changes with: casefile note add --on para:${id} --text ...`,
        );
      }
      refuseIfAttested(p, `Paragraph ${id}`, `para:${id}`);
      refuseIfUserEdited(p);
      const body = await text("text", false);
      // Collected flags default to []; "none" clears a list.
      const hasSources = sources(args).length > 0;
      const hasRelies = many(args, "relies").length > 0;
      if (body === undefined && !hasSources && !hasRelies) {
        throw new UsageError("para edit needs --text, --source or --relies");
      }
      checkTokens(body);
      const srcs = !hasSources ? undefined : isNone("source") ? [] : paraSources();
      const links = !hasRelies ? undefined : isNone("relies") ? [] : paraRelies();
      store.tx(() => {
        if (body !== undefined) store.updateParagraph(id, body, "claude");
        if (srcs) store.setParagraphSources(id, srcs);
        if (links) store.setParagraphLinks(id, links);
      });
      store.log("claude", "cli:para_edit", {
        id,
        ...(srcs ? { sources: srcs.map(formatSourceRef) } : {}),
        ...(links ? { relies: links.map(formatLink) } : {}),
      });
      return out(`Updated paragraph ${id}.`, { ok: true });
    }
    if (sub === "rm") {
      const id = posInt(rest[0], "PARA");
      const p = store.getParagraph(id);
      if (p.author !== "claude") {
        throw new InvalidInputError(`Paragraph ${id} is the user's; Claude cannot remove it`);
      }
      refuseIfAttested(p, `Paragraph ${id}`, `para:${id}`);
      refuseIfUserEdited(p);
      store.deleteParagraph(id);
      store.log("claude", "cli:para_rm", { id });
      return out(`Removed paragraph ${id}.`, { ok: true });
    }
    throw new UsageError(`Unknown para command: ${sub}`);
  }

  /**
   * A Claude paragraph the user has edited (its text is no longer what Claude wrote) holds the
   * user's words, which Claude may not overwrite or delete, as for the user's own paragraphs.
   */
  function refuseIfUserEdited(p: ParagraphRow) {
    if (p.claude_body !== null && p.body !== p.claude_body) {
      throw new InvalidInputError(
        `Paragraph ${p.id} has been edited by the user; Claude cannot change or remove it. Suggest changes with: casefile note add --on para:${p.id} --text ...`,
      );
    }
  }

  /** Claude may not delete or change what a draft paragraph relies on; it leaves a note instead. */
  function refuseIfReliedOn(type: ParagraphLinkType, id: number, what: string) {
    const paras = store.paragraphsRelyingOn(type, id);
    if (paras.length) {
      throw new InvalidInputError(
        `${what} is relied on by draft paragraph ${
          paras.join(", ")
        }; Claude cannot change or remove it. Change the paragraph's --relies first (if it is Claude's and not adopted), or leave a note: casefile note add --on para:${
          paras[0]
        } --text ...`,
      );
    }
  }
}

function parseTarget(on: string, store: PublicStore): [string, string] {
  if (on === "case") return ["case", "case"];
  const m = /^(doc|chrono|issue|draft|para):(\S+)$/.exec(on);
  if (!m) throw new UsageError("--on must be case, doc:ID, chrono:N, issue:N, draft:N or para:N");
  const [, type, id] = m;
  if (type === "doc") store.getDocument(id);
  else if (type === "chrono") store.getChronology(Number(id));
  else if (type === "issue") store.getIssue(Number(id));
  else if (type === "draft") store.getDraft(Number(id));
  else store.getParagraph(Number(id));
  return [type, id];
}
