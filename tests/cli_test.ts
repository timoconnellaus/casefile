import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl, join } from "@std/path";
import { normaliseArgv, run, STRING_FLAGS } from "../src/cli/commands.ts";
import { CaseSession } from "../src/core/session.ts";
import {
  AFFIDAVIT,
  FAKE_NER_NAMES,
  FakeNameDetector,
  MESSAGES,
  SECRETS,
  tempDir,
} from "./fixtures/synthetic.ts";

const CLI = fromFileUrl(new URL("../src/cli/main.ts", import.meta.url));

/** A case with the affidavit (D001, resolved by hand) and messages (D002) published. */
async function caseWithDocs() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, "a long test passphrase", "CLI test", {
    kdfIterations: 1_000,
  });
  s.detectors = [new FakeNameDetector(FAKE_NER_NAMES)];
  const d1 = await s.importText({
    origin: "mine",
    title: "Affidavit of Anna Thornbury",
    text: AFFIDAVIT,
  });
  const { request, unresolved } = s.defaultPublishRequest(d1);
  const fatherKey = d1.newEntities.find((n) => n.full === "Daniel Okafor")!.key;
  for (const u of unresolved) {
    if (u.proposal.type !== "ambiguous") continue;
    const o = u.proposal.options.find((x) => x.ref === fatherKey)!;
    request.replacements.push({ start: u.start, end: u.end, ref: o.ref, form: o.form });
  }
  await s.publish(d1.id, request);
  const d2 = await s.importText({ origin: "mine", title: "Messages", text: MESSAGES });
  await s.publishWithDefaults(d2.id);
  s.close();
  return dir;
}

const BOOLS = ["json", "help"];
const COLLECT = ["source"];

async function cli(dir: string, argv: string[], stdin = "") {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: BOOLS,
    collect: COLLECT,
    string: STRING_FLAGS,
  });
  return await run(args, { cwd: dir, env: {}, readStdin: () => Promise.resolve(stdin) });
}

Deno.test("help needs no case", async () => {
  const r = await run({ _: [] }, { cwd: "/", env: {}, readStdin: () => Promise.resolve("") });
  assertEquals(r.code, 0);
  assertStringIncludes(r.out, "casefile");
});

Deno.test("commands fail clearly outside a case folder", async () => {
  const r = await cli(await tempDir(), ["info"]);
  assertEquals(r.code, 2);
  assertStringIncludes(r.err, "No case folder found");
});

Deno.test("reading: info, entities, docs, search", async () => {
  const dir = await caseWithDocs();
  assertStringIncludes((await cli(dir, ["info"])).out, "Documents: 2 (0 withheld)");
  const ents = await cli(dir, ["entities"]);
  assertStringIncludes(ents.out, "{{mother}}");
  assertStringIncludes(ents.out, "{{mother.first}}");
  const list = JSON.parse((await cli(dir, ["docs", "list", "--json"])).out);
  assertEquals(list.map((d: { id: string }) => d.id), ["D001", "D002"]);
  const show = await cli(dir, ["docs", "show", "D002", "--lines", "2-2"]);
  assertStringIncludes(show.out, "2  14/03/2025 4:31pm {{father.first}}: Traffic. Got them now.");
  const hits = JSON.parse((await cli(dir, ["search", "traffic", "--json"])).out);
  assertEquals(hits.map((h: { doc_id: string; line: number }) => `${h.doc_id}:${h.line}`), [
    "D002:2",
  ]);
});

Deno.test("nothing the CLI prints contains an original value", async () => {
  const dir = await caseWithDocs();
  let all = "";
  for (
    const argv of [
      ["info"],
      ["entities"],
      ["docs", "list"],
      ["docs", "show", "D001"],
      ["docs", "show", "D002"],
      ["search", "school"],
      ["log"],
    ]
  ) {
    const r = await cli(dir, argv);
    all += r.out + r.err;
  }
  for (const secret of SECRETS) assert(!all.includes(secret), `CLI printed "${secret}"`);
});

Deno.test("writing: chronology needs valid citations and known tokens", async () => {
  const dir = await caseWithDocs();
  let r = await cli(dir, ["chrono", "add", "--date", "2025-03-14", "--text", "{{father}} late"]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "must cite");
  r = await cli(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "{{grandfather}} late",
    "--source",
    "D002:2",
  ]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "unknown token {{grandfather}}");
  r = await cli(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "{{father}} late",
    "--source",
    "D002:99",
  ]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "out of range");
  r = await cli(dir, [
    "chrono",
    "add",
    "--date",
    "2025-03-14",
    "--text",
    "{{father}} collected {{child_1}} late",
    "--source",
    "D002:1-2",
    "--source",
    "D001:9",
  ]);
  assertEquals(r.code, 0, r.err);
  const list = await cli(dir, ["chrono", "list"]);
  assertStringIncludes(list.out, "[claude, UNVERIFIED]");
  assertStringIncludes(list.out, "D001:9, D002:1-2");
});

Deno.test("writing: issues, evidence, tags, notes and metadata", async () => {
  const dir = await caseWithDocs();
  assertEquals((await cli(dir, ["issue", "add", "--title", "Changeovers"])).code, 0);
  const ev = await cli(dir, [
    "evidence",
    "add",
    "1",
    "--source",
    "D002:1-2",
    "--note",
    "Collection 90 minutes late",
    "--stance",
    "supports",
  ]);
  assertEquals(ev.code, 0, ev.err);
  assertStringIncludes(
    (await cli(dir, ["issue", "show", "1"])).out,
    "D002:1-2 supports [claude, UNVERIFIED]",
  );
  assertEquals((await cli(dir, ["tag", "add", "D002", "messages"])).code, 0);
  assertEquals(
    JSON.parse((await cli(dir, ["docs", "list", "--tag", "messages", "--json"])).out).length,
    1,
  );
  assertEquals(
    (await cli(dir, ["note", "add", "--on", "doc:D002", "--text", "Check phone records"])).code,
    0,
  );
  assertEquals((await cli(dir, ["note", "add", "--on", "doc:D999", "--text", "x"])).code, 1);
  const meta = await cli(dir, [
    "docs",
    "meta",
    "D002",
    "--type",
    "messages",
    "--date",
    "2025-03-14",
    "--author-role",
    "{{mother}}",
  ]);
  assertEquals(meta.code, 0, meta.err);
  assertStringIncludes(
    (await cli(dir, ["docs", "show", "D002", "--lines", "1"])).out,
    "type: messages  date: 2025-03-14  author: {{mother}}",
  );
  assertEquals((await cli(dir, ["docs", "meta", "D002", "--date", "14 March"])).code, 1);
});

Deno.test("drafting: Claude's paragraphs are tracked and the user's are protected", async () => {
  const dir = await caseWithDocs();
  assertEquals(
    (await cli(dir, ["draft", "new", "--kind", "affidavit", "--title", "Affidavit of {{mother}}"]))
      .code,
    0,
  );
  const p = await cli(dir, ["para", "add", "1", "--text", "-"], "I am the mother of {{child_1}}.");
  assertEquals(p.code, 0, p.err);
  assertStringIncludes(
    (await cli(dir, ["draft", "show", "1"])).out,
    "[para 1, claude] I am the mother of {{child_1}}.",
  );
  assertEquals(
    (await cli(dir, ["para", "edit", "1", "--text", "I am {{child_1}}'s mother."])).code,
    0,
  );
  // A paragraph written by the user cannot be edited or removed by Claude.
  const { PublicStore } = await import("../src/core/publicdb.ts");
  const store = PublicStore.open(join(dir, "public.db"));
  const userPara = store.addParagraph(1, "In my own words.", "user");
  store.close();
  const edit = await cli(dir, ["para", "edit", String(userPara), "--text", "Rewritten"]);
  assertEquals(edit.code, 1);
  assertStringIncludes(edit.err, "user's own words");
  assertEquals((await cli(dir, ["para", "rm", String(userPara)])).code, 1);
  assertEquals((await cli(dir, ["draft", "new", "--kind", "poem", "--title", "x"])).code, 2);
});

Deno.test("Claude cannot delete what the user wrote", async () => {
  const dir = await caseWithDocs();
  const { PublicStore } = await import("../src/core/publicdb.ts");
  const store = PublicStore.open(join(dir, "public.db"));
  const c = store.addChronology({
    event_date: "2025-01-01",
    description: "User entry",
    sources: [],
  }, "user");
  const i = store.addIssue({ title: "User issue" }, "user");
  store.close();
  assertEquals((await cli(dir, ["chrono", "rm", String(c)])).code, 1);
  assertEquals((await cli(dir, ["issue", "rm", String(i)])).code, 1);
});

Deno.test("every Claude action is written to the AI-use log", async () => {
  const dir = await caseWithDocs();
  await cli(dir, ["search", "traffic"]);
  await cli(dir, ["docs", "show", "D001", "--lines", "1-3"]);
  const log = JSON.parse((await cli(dir, ["log", "--json"])).out) as {
    actor: string;
    action: string;
  }[];
  const actions = log.filter((l) => l.actor === "claude").map((l) => l.action);
  assert(actions.includes("cli:search"));
  assert(actions.includes("cli:docs_show"));
});

Deno.test("withheld documents are listed but their text is not available", async () => {
  const dir = await caseWithDocs();
  const s = await CaseSession.open(dir, "a long test passphrase");
  await s.setOrigin("D002", "court_or_subpoena");
  s.close();
  const show = await cli(dir, ["docs", "show", "D002"]);
  assertStringIncludes(show.out, "withheld");
  assert(!show.out.includes("Traffic"));
  assertEquals((await cli(dir, ["search", "traffic"])).out, "No matches.");
});

Deno.test("the real CLI runs as a subprocess with no network access", async () => {
  const dir = await caseWithDocs();
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--deny-net",
      CLI,
      "chrono",
      "add",
      "--date",
      "2025-03-15",
      "--text",
      "-",
      "--source",
      "D002:3",
      "--json",
    ],
    cwd: dir,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode("{{mother}} messaged {{father.title}}"));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  assertEquals(typeof JSON.parse(out).id, "number");
  const list = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--deny-net",
      CLI,
      "chrono",
      "list",
    ],
    cwd: join(dir, ".claude"), // found by searching upwards
  });
  const res = await list.output();
  assertStringIncludes(
    new TextDecoder().decode(res.stdout),
    "{{mother}} messaged {{father.title}}",
  );
});

Deno.test("read commands are logged too (PD-AI 4.11)", async () => {
  const dir = await caseWithDocs();
  const reads: [string[], string][] = [
    [["entities"], "cli:entities"],
    [["docs", "list"], "cli:docs_list"],
    [["chrono", "list"], "cli:chrono_list"],
    [["issue", "add", "--title", "Delays"], "cli:issue_add"],
    [["issue", "list"], "cli:issue_list"],
    [["issue", "show", "1"], "cli:issue_show"],
    [["draft", "new", "--kind", "outline", "--title", "Outline"], "cli:draft_new"],
    [["draft", "list"], "cli:draft_list"],
    [["draft", "show", "1"], "cli:draft_show"],
    [["note", "list"], "cli:note_list"],
    [["tags"], "cli:tags"],
    [["log"], "cli:log"],
  ];
  for (const [argv] of reads) assertEquals((await cli(dir, argv)).code, 0, argv.join(" "));
  const log = JSON.parse((await cli(dir, ["log", "--json", "--limit", "100"])).out) as {
    action: string;
  }[];
  for (const [, action] of reads) {
    assert(log.some((l) => l.action === action), `${action} is logged`);
  }
});
