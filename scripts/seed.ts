#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-sys --allow-ffi
/**
 * Seed the CANON example case (the invented "Parenting matter 2025" family, docs/rebuild/CANON.md)
 * for UI work. SYNTHETIC data only (ADR 11).
 *
 * ## Run the app against the seeded case
 *
 *   deno task seed --force
 *   CASEFILE_CONFIG_DIR="$TMPDIR/casefile-canon.config" deno task app
 *
 * then open http://127.0.0.1:8217/ and open the case:
 *   - Case folder: `$TMPDIR/casefile-canon` (the default `--dir`; the seed prints the full path).
 *   - Passphrase: `DEFAULT_PASS` below ("canon seed passphrase"), a test value for this synthetic
 *     case; `--passphrase` overrides it.
 * CASEFILE_CONFIG_DIR points the app at the config dir the seed used (`<dir>.config`), so seeding
 * never touches your own app config; plain `deno task app` works too.
 *
 * Options: `--dir DIR` · `--passphrase P` · `--small` (40 documents instead of 312, same To-check
 * queue) · `--force` (replace an existing case folder).
 *
 * ## How it is built
 *
 * Through the real wave 1 flows, in-process: the user's side through the app's API (an AppState
 * with its handler and a session cookie, exactly what the UI calls), bulk import and sharing
 * through CaseSession (what the import and review screens call), and Claude's side through the
 * casefile CLI (`run()`, writing as Claude exactly as Claude Code would). Afterwards every
 * scripts/seed/*.ts (not starting with "_") runs in name order with a SeedContext, so wave-2
 * packages can add their own area data.
 */
import { parseArgs } from "@std/cli/parse-args";
import { basename, fromFileUrl, join } from "@std/path";
import { AppState } from "../src/app/state.ts";
import { CaseLock } from "../src/core/caselock.ts";
import { createHandler } from "../src/app/server.ts";
import { cookieName } from "../src/app/security.ts";
import type { CaseSession, PublishRequest } from "../src/core/session.ts";
import type { ProposedSpan } from "../src/core/detect/pipeline.ts";
import { NerDetector, type TokenClassifier } from "../src/core/detect/ner.ts";
import { installSeedClock, type SeedClock } from "./seed/_clock.ts";
import { cli as canonCli, CONFIRMED_AT } from "../tests/helpers/canon_work.ts";
import {
  CHRONOLOGY,
  CLAUDE_NOTE,
  DESCRIPTIONS,
  DOCS,
  DRAFT,
  ENTITIES,
  EVIDENCE,
  EXTRA_ENTITIES,
  fillerDoc,
  HINTED_ROLES,
  ISSUES,
  LABEL,
  LATE_ALIAS,
  PASTE_VIEWS,
  type SeedDoc,
  STYLE,
} from "./seed/_canon.ts";

/** What each scripts/seed/<area>.ts default export receives. */
export interface SeedContext {
  session: CaseSession;
  dir: string;
  /** Run a casefile CLI command as Claude; throws on a non-zero exit. Returns stdout. */
  cli: (...args: string[]) => Promise<string>;
  /** Call the app's API as the signed-in user; throws on a non-2xx status. Returns the JSON. */
  api: Api;
  log: (msg: string) => void;
}

// deno-lint-ignore no-explicit-any
export type Api = (method: string, path: string, body?: unknown) => Promise<any>;

/**
 * CANON's dates (docs/rebuild/CANON.md), in UTC around midday in Australia. The seed's clock
 * (seed/_clock.ts) runs from each one in turn, so the log, the ledger and the log's seal are made
 * on these dates by the normal code; nothing is re-dated afterwards.
 */
export const CANON_DATES = {
  /** The case is made and who's who set up. */
  created: "2025-09-03T01:30:00.000Z",
  /** The plan and the PD-AI 5.4 checklist (CONFIRMED_AT). */
  confirmed: CONFIRMED_AT,
  /** Documents imported and shared, D006 among them. */
  shared: "2025-09-28T02:00:00.000Z",
  /** Claude reads D006 lines 1–12, and cites it in a chronology entry and an evidence link. */
  claudeRead: "2025-10-02T03:00:00.000Z",
  /** The user checks Claude's work from D006, while it is still shared. */
  d006Checked: "2025-10-03T03:00:00.000Z",
  /** The user adds "Annie"; casefile withdraws D006. */
  withdrawn: "2025-10-05T03:00:00.000Z",
  /** Claude's chronology, issues and evidence. */
  claudeWork: "2025-10-06T02:00:00.000Z",
  /** "Today": the user checks, drafts and pastes. */
  today: "2025-10-07T00:30:00.000Z",
} as const;

/**
 * The seed's stand-in for the name finder's model: it runs offline and finds nothing new (every
 * name in CANON is already in who's who, and known names are matched anyway). With it the case
 * records the name finder as on and used, as CANON's tools line has it, without downloading a
 * model. Opening the case in the app uses the real model.
 */
const SEED_NER_MODEL: TokenClassifier = {
  tokenize: (text) => text.split(/\s+/).filter(Boolean),
  classify: () => Promise.resolve([]),
};

/** Test value for this synthetic case (ADR 11). Never a real passphrase. */
export const DEFAULT_PASS = "canon seed passphrase";

export interface SeedOptions {
  dir: string;
  passphrase?: string;
  /** 40 documents instead of 312. */
  small?: boolean;
  /** Replace an existing folder at `dir`. */
  force?: boolean;
  /** App config dir that remembers the case (default: `<dir>.config`). */
  configDir?: string;
  /** Fewer KDF iterations (tests only). */
  kdfIterations?: number;
  quiet?: boolean;
}

/** An in-process client of the app's API that keeps the session cookie, like the browser. */
function apiClient(handler: (req: Request) => Promise<Response>): Api {
  const origin = "http://127.0.0.1:8217";
  const COOKIE = cookieName(origin);
  let cookie: string | undefined;
  return async (method, path, body) => {
    const headers: Record<string, string> = { host: "127.0.0.1:8217", origin };
    if (cookie) headers.cookie = `${COOKIE}=${cookie}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handler(
      new Request(origin + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const m = new RegExp(`${COOKIE}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "");
    if (m) cookie = m[1] || undefined;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Accept every proposal; ambiguous spans go to the entity whose form matches exactly. */
async function share(s: CaseSession, id: string) {
  const doc = await s.getDoc(id);
  const { request, unresolved } = s.defaultPublishRequest(doc);
  const resolved = unresolved.map((sp: ProposedSpan) => {
    if (sp.proposal.type !== "ambiguous") throw new Error(`${id}: unexpected proposal`);
    const text = doc.original.slice(sp.start, sp.end);
    const opts = sp.proposal.options;
    const exact = opts.find((o) => s.registry.resolve(o.ref, o.form) === text);
    const father = opts.find((o) => o.ref === "father");
    const pick = exact ?? father ?? opts[0];
    return { start: sp.start, end: sp.end, ref: pick.ref, form: pick.form };
  });
  const req: PublishRequest = { ...request, replacements: [...request.replacements, ...resolved] };
  await s.publish(id, req);
}

async function importDoc(s: CaseSession, d: SeedDoc) {
  // origin null: "not asked yet" (the import screen's default).
  const doc = await s.importText({ title: d.title, text: d.text, origin: d.origin });
  if (doc.id !== d.id) throw new Error(`Expected ${d.id}, got ${doc.id}`);
  if (d.share) await share(s, doc.id);
}

/** The id from a CLI command run with --json. */
const idOf = (out: string): number => {
  const id = JSON.parse(out).id;
  if (typeof id !== "number") throw new Error(`No id in CLI output: ${out}`);
  return id;
};

/** Build the CANON case at `opts.dir`, on CANON's dates. */
export async function seedCase(opts: SeedOptions): Promise<void> {
  const clock = installSeedClock(CANON_DATES.created);
  try {
    await build(opts, clock);
  } finally {
    clock.restore();
  }
}

async function build(opts: SeedOptions, clock: SeedClock): Promise<void> {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`seed: ${msg}`);
  const dir = opts.dir;
  const pass = opts.passphrase ?? DEFAULT_PASS;
  const configDir = opts.configDir ?? `${dir}.config`;
  try {
    await Deno.stat(dir);
    if (!opts.force) {
      throw new Error(`${dir} already exists. Pass --force to replace it, or --dir.`);
    }
    // Never pull a case out from under a casefile that has it open (ADR 4, amended): hold its
    // lock while the folder is deleted. Throws CaseInUseError ("This case is open in casefile
    // (pid N). Lock it or quit casefile first.") if a running casefile has it.
    const lock = await CaseLock.acquire(dir, "seed");
    try {
      await Deno.remove(dir, { recursive: true });
    } finally {
      lock.release();
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  await Deno.remove(configDir, { recursive: true }).catch(() => {});

  // ── the app, in-process; the user creates the case ─────────────────────────
  log(`creating ${dir}`);
  const state = new AppState({
    configDir,
    kdfIterations: opts.kdfIterations,
    // The name finder runs with a stand-in model (SEED_NER_MODEL), so seeding is fast and
    // offline; no language model.
    detectorFactory: (settings) => settings.nerEnabled ? [new NerDetector(SEED_NER_MODEL)] : [],
    idleLockMs: 0,
  });
  await state.load();
  const api = apiClient(createHandler(state));
  await api("POST", "/api/case/create", { dir, passphrase: pass, label: LABEL });
  const s = state.session!;
  const c = async (...argv: string[]) => (await canonCli(s, argv)).out;
  // The name finder is on, as CANON's tools line has it (recorded in the Log).
  await api("PUT", "/api/settings", { nerEnabled: true });

  // ── who's who ──────────────────────────────────────────────────────────────
  for (const e of [...ENTITIES, ...EXTRA_ENTITIES]) s.registry.add(e);
  await s.saveRegistry();

  // ── 3 September: the plan and the PD-AI 5.4 confirmations ──────────────────
  clock.set(CANON_DATES.confirmed);
  await api("POST", "/api/plan", { setup: "consumer" });
  await api("POST", "/api/settings/confirmations", { helpImproveOff: true, chatHistory: true });

  // ── 28 September: documents: origins, sharing, and two left to review ──────
  clock.set(CANON_DATES.shared);
  // D002 brings the identifiers in HINTED_ROLES, named from the detector's role hints.
  for (const d of DOCS) await importDoc(s, d);
  const total = opts.small ? 40 : 312;
  for (let n = DOCS.length + 1; n <= total; n++) await importDoc(s, fillerDoc(n));
  for (const role of HINTED_ROLES) {
    if (!s.registry.get(role)) throw new Error(`D002 did not propose ${role}`);
  }
  log(`${total} documents, ${s.registry.list().length} people, places and numbers`);

  // ── who's who as the user finishes it: colours, safety, relationships ──────
  for (const st of STYLE) {
    await api("PATCH", `/api/entities/${st.role}`, {
      ...(st.colour !== undefined ? { colour: st.colour } : {}),
      ...(st.safety ? { safety: true } : {}),
    });
  }
  // Her home is hers: marking her safety-sensitive protects it (export, copy, review).
  await api("PATCH", "/api/entities/mothers_home", { relatedTo: "mother" });
  // The details People suggests from their labels, linked as the user would confirm them, so the
  // seeded case has no open suggestions (ADR 21 amendment 1).
  for (
    const [role, to] of [
      ["mothers_employer", "mother"],
      ["mothers_legal_firm", "mother"],
      ["fathers_business", "father"],
      ["fathers_legal_firm", "father"],
    ]
  ) {
    if (s.registry.get(role)) await api("PATCH", `/api/entities/${role}`, { relatedTo: to });
  }
  for (const [role, description] of Object.entries(DESCRIPTIONS)) {
    await api("PATCH", `/api/entities/${role}`, { description });
  }

  // ── D006's exposure: shared, read and cited by Claude (2 Oct), checked by the user (3 Oct),
  // then the user adds "Annie" (5 Oct). Sharing D006 again sends that work back to To check. ──
  clock.set(CANON_DATES.claudeRead);
  await c("docs", "show", "D006", "--lines", "1-12");
  const issueIds: number[] = [];
  for (const i of ISSUES) {
    issueIds.push(idOf(await c("issue", "add", "--title", i.title, "--desc", i.desc, "--json")));
  }
  const chronoIds: number[] = [];
  const evidenceIds: number[] = [];
  const addChrono = async (i: number) => {
    const e = CHRONOLOGY[i];
    const src = e.sources.flatMap((x) => ["--source", x]);
    chronoIds[i] = idOf(
      await c("chrono", "add", "--date", e.date, "--text", e.text, ...src, "--json"),
    );
  };
  const addEvidence = async (i: number) => {
    const ev = EVIDENCE[i];
    evidenceIds[i] = idOf(
      await c(
        "evidence",
        "add",
        String(issueIds[ev.issue]),
        "--source",
        ev.source,
        "--stance",
        ev.stance,
        "--note",
        ev.note,
        "--json",
      ),
    );
  };
  for (const [i, e] of CHRONOLOGY.entries()) if (e.whileShared) await addChrono(i);
  for (const [i, ev] of EVIDENCE.entries()) if (ev.whileShared) await addEvidence(i);
  // Both ticks (ADR 8), as on 7 October below.
  const ticks = { quoteAccurate: true, fairReading: true };
  const checkChrono = async (i: number) => {
    const version = await s.itemVersion("chronology", s.store.getChronology(chronoIds[i]));
    await api("POST", `/api/chronology/${chronoIds[i]}/verify`, { version, ...ticks });
  };
  const checkEvidence = async (i: number) => {
    const version = await s.itemVersion("evidence", s.store.getEvidence(evidenceIds[i]));
    await api("POST", `/api/evidence/${evidenceIds[i]}/verify`, { version, ...ticks });
  };
  clock.set(CANON_DATES.d006Checked);
  for (const [i, e] of CHRONOLOGY.entries()) {
    if (e.whileShared && e.check === "checked") await checkChrono(i);
  }
  for (const [i, ev] of EVIDENCE.entries()) {
    if (ev.whileShared && ev.checked) await checkEvidence(i);
  }
  clock.set(CANON_DATES.withdrawn);
  const mother = s.registry.get(LATE_ALIAS.role)!;
  await api("PATCH", `/api/entities/${LATE_ALIAS.role}`, {
    aliases: [LATE_ALIAS.alias, ...mother.aliases],
  });
  const exposed: { doc: string; newMatchesIn: string[] }[] = await api("GET", "/api/exposures");
  log(
    `nickname added; exposed: ${
      exposed.map((e) => `${e.doc} (new matches in ${e.newMatchesIn.join(", ")})`).join("; ")
    }`,
  );

  // ── 6 October: Claude's work, through the CLI ──────────────────────────────
  clock.set(CANON_DATES.claudeWork);
  for (const [i, e] of CHRONOLOGY.entries()) if (!e.whileShared) await addChrono(i);
  for (const [i, ev] of EVIDENCE.entries()) if (!ev.whileShared) await addEvidence(i);
  await c("note", "add", "--on", CLAUDE_NOTE.on, "--text", CLAUDE_NOTE.text);
  log(
    `${CHRONOLOGY.length} chronology entries, ${ISSUES.length} issues, ${EVIDENCE.length} evidence links`,
  );

  // ── 7 October ("today"): the user checks some of it: both ticks (ADR 8) ────
  clock.set(CANON_DATES.today);
  // The 29 March entry is left alone: casefile finds Claude's swap (Mia for Lachlan) and shows
  // it as Can't check, and the app would refuse to mark it checked.
  for (const [i, e] of CHRONOLOGY.entries()) {
    if (e.check === "checked" && !e.whileShared) await checkChrono(i);
  }
  for (const [i, iss] of ISSUES.entries()) {
    if (!iss.checked) continue;
    const version = await s.itemVersion("issue", s.store.getIssue(issueIds[i]));
    await api("POST", `/api/issues/${issueIds[i]}/verify`, { version, neutral: true });
  }
  for (const [i, ev] of EVIDENCE.entries()) {
    if (ev.checked && !ev.whileShared) await checkEvidence(i);
  }

  // ── the affidavit draft, and Paste (3 uses; the third adds ¶5 and ¶6) ──────
  const draftId: number = (await api("POST", "/api/drafts", {
    kind: "affidavit",
    title: DRAFT.title,
  })).id;
  for (const t of PASTE_VIEWS) await api("POST", "/api/paste/view", { text: t });
  const pasted = DRAFT.paragraphs.filter((p) => p.by === "paste").map((p) => p.text).join("\n\n");
  let pasteDone = false;
  for (const p of DRAFT.paragraphs) {
    if (p.by === "paste") {
      if (pasteDone) continue;
      await api("POST", "/api/paste/view", { text: pasted });
      await api("POST", "/api/paste/add-to-draft", { draftId, text: pasted });
      pasteDone = true;
    } else if (p.by === "user") {
      await api("POST", `/api/drafts/${draftId}/paragraphs`, { text: p.text });
    } else {
      const pid = idOf(await c("para", "add", String(draftId), "--text", p.text, "--json"));
      if (p.then === "adopt") {
        const version = await s.itemVersion("paragraph", s.store.getParagraph(pid));
        await api("POST", `/api/paragraphs/${pid}/adopt`, {
          version,
          ownKnowledge: true,
          ownWords: true,
        });
      } else if (p.then === "rewrite" && p.rewrite) {
        await api("PUT", `/api/paragraphs/${pid}`, { text: p.rewrite });
      }
    }
  }
  log(`draft ${draftId}: ${DRAFT.paragraphs.length} paragraphs`);

  // ── area seeds from wave-2 packages ────────────────────────────────────────
  const seedDir = fromFileUrl(new URL("./seed/", import.meta.url));
  const areas: string[] = [];
  for await (const f of Deno.readDir(seedDir)) {
    if (f.isFile && f.name.endsWith(".ts") && !f.name.startsWith("_")) areas.push(f.name);
  }
  const ctx: SeedContext = { session: s, dir, cli: c, api, log };
  for (const name of areas.sort()) {
    const mod = await import(new URL(`./seed/${name}`, import.meta.url).href);
    if (typeof mod.default !== "function") throw new Error(`${name} has no default export`);
    log(`area: ${basename(name, ".ts")}`);
    await mod.default(ctx);
  }

  const queue = await api("GET", "/api/to-check");
  log(
    `To check ${queue.total}: ${
      queue.groups.map((g: { what: string; count: number }) => `${g.what} ${g.count}`).join(" · ")
    }`,
  );
  await s.settled();
  await api("POST", "/api/lock");
  log("done");
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["dir", "passphrase"],
    boolean: ["small", "force", "help"],
  });
  if (args.help) {
    console.log("deno task seed [--dir DIR] [--passphrase P] [--small] [--force]");
    return;
  }
  const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
  const dir = args.dir ?? join(tmp, "casefile-canon");
  const configDir = `${dir}.config`;
  try {
    await seedCase({
      dir,
      configDir,
      passphrase: args.passphrase,
      small: args.small,
      force: args.force,
    });
  } catch (e) {
    console.error(`seed: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
  console.log(
    `\nRun the app against it:\n  CASEFILE_CONFIG_DIR="${configDir}" deno task app\n` +
      `  Case folder: ${dir}\n  Passphrase:  ${
        args.passphrase
          ? "the one you passed"
          : `"${DEFAULT_PASS}" (DEFAULT_PASS in scripts/seed.ts)`
      }`,
  );
}

if (import.meta.main) await main();
