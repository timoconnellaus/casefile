/**
 * Regression tests for the security review of milestone 1:
 *  - original file names must not reach the public store
 *  - suggested or chosen role names must not contain real values
 *  - a name that appears only in a document's title must block publishing
 *  - the CLI must not change anything the user wrote (edit parity with delete)
 *  - withdrawn (withheld) text must not linger in public.db, its WAL or its search index
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { normaliseArgv, run, STRING_FLAGS } from "../src/cli/commands.ts";
import { CaseSession, LeakError } from "../src/core/session.ts";
import { FakeNameDetector, tempDir } from "./fixtures/synthetic.ts";

async function newCase(names: ConstructorParameters<typeof FakeNameDetector>[0] = []) {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, "a long test passphrase", "Security", {
    kdfIterations: 1_000,
  });
  s.detectors = [new FakeNameDetector(names)];
  return { dir, s };
}

async function bytesOfPublicFiles(dir: string): Promise<string> {
  let all = "";
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.startsWith("public.db")) {
      all += new TextDecoder("latin1").decode(await Deno.readFile(join(dir, e.name)));
    }
  }
  return all;
}

Deno.test("the original file name is kept in the vault, not published", async () => {
  const { s } = await newCase([{ text: "Anna Thornbury", kind: "person", roleHint: "mother" }]);
  const doc = await s.importText({
    origin: "mine",
    title: "Statement",
    text: "Anna Thornbury wrote this.",
    source: "Anna Thornbury statement.txt",
  });
  await s.publishWithDefaults(doc.id);
  assertEquals(s.store.getDocument(doc.id).source, null);
  assertEquals((await s.getDoc(doc.id)).source, "Anna Thornbury statement.txt");
  s.close();
});

Deno.test("a role hint that contains a real name is replaced with a neutral role", async () => {
  const { s } = await newCase([
    { text: "Anna Thornbury", kind: "person", roleHint: "anna" },
    { text: "Daniel Okafor", kind: "person", roleHint: "okafor_father" },
    { text: "Kiama Downs Public School", kind: "school", roleHint: "school" },
  ]);
  const doc = await s.importText({
    origin: "mine",
    title: "Note",
    text: "Anna Thornbury and Daniel Okafor met at Kiama Downs Public School.",
  });
  await s.publishWithDefaults(doc.id);
  const roles = s.store.listEntities().map((e) => e.role).sort();
  assertEquals(roles, ["person_1", "person_2", "school"]);
  s.close();
});

Deno.test("the user cannot rename a role to something containing a real value", async () => {
  const { s } = await newCase([{ text: "Anna Thornbury", kind: "person", roleHint: "mother" }]);
  const doc = await s.importText({
    origin: "mine",
    title: "Note",
    text: "Anna Thornbury wrote this.",
  });
  await s.publishWithDefaults(doc.id);
  await assertRejects(() => s.renameEntity("mother", "mum_thornbury"), Error, "visible to Claude");
  await s.renameEntity("mother", "maternal_parent");
  assertEquals(s.store.knownRoles().has("maternal_parent"), true);
  s.close();
});

Deno.test("a name that appears only in the title blocks publishing", async () => {
  const { s } = await newCase([{ text: "Sarah Jones", kind: "person" }]);
  const doc = await s.importText({
    origin: "mine",
    title: "Letter from Sarah Jones",
    text: "Please call me about the children.",
  });
  const err = await assertRejects(() => s.publishWithDefaults(doc.id), LeakError);
  assertEquals(err.leaks.map((l) => [l.field, l.text]), [["title", "Sarah Jones"]]);
  await s.publishWithDefaults(doc.id, { title: "Letter from the maternal aunt" });
  s.close();
});

Deno.test("withheld text does not linger in public.db, its WAL or the search index", async () => {
  const { dir, s } = await newCase();
  const doc = await s.importText({
    origin: "mine",
    title: "Records",
    text: "Zanzibarquokka attendance notes\nline two",
  });
  await s.publishWithDefaults(doc.id);
  assert(
    (await bytesOfPublicFiles(dir)).includes("Zanzibarquokka") ||
      s.store.search("Zanzibarquokka").length === 1,
  );
  await s.setOrigin(doc.id, "court_or_subpoena");
  assertEquals(s.store.search("Zanzibarquokka"), []);
  assert(
    !(await bytesOfPublicFiles(dir)).includes("Zanzibarquokka"),
    "withheld text still on disk",
  );
  // The same after deleting a document outright.
  const d2 = await s.importText({ origin: "mine", title: "Other", text: "Quokkazanzibar note" });
  await s.publishWithDefaults(d2.id);
  await s.deleteDoc(d2.id);
  assert(!(await bytesOfPublicFiles(dir)).includes("Quokkazanzibar"), "deleted text still on disk");
  s.close();
});

async function cli(dir: string, argv: string[]) {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: ["json"],
    collect: ["source"],
    string: STRING_FLAGS,
  });
  return await run(args, { cwd: dir, env: {}, readStdin: () => Promise.resolve("") });
}

Deno.test("Claude cannot edit what the user wrote (parity with delete)", async () => {
  const { dir, s } = await newCase();
  const doc = await s.importText({ origin: "mine", title: "Note", text: "Line one\nLine two" });
  await s.publishWithDefaults(doc.id);
  const chrono = s.store.addChronology({
    event_date: "2025-01-01",
    description: "User entry",
    sources: [],
  }, "user");
  const issue = s.store.addIssue({ title: "User issue" }, "user");
  s.store.addTag(doc.id, "important", "user");
  s.store.setDocumentMeta(doc.id, { doc_type: "letter" }, "user");
  s.close();

  const chronoEdit = await cli(dir, ["chrono", "edit", String(chrono), "--text", "changed"]);
  assertEquals(chronoEdit.code, 1, chronoEdit.err);
  assertEquals((await cli(dir, ["issue", "edit", String(issue), "--title", "changed"])).code, 1);
  assertEquals((await cli(dir, ["tag", "rm", doc.id, "important"])).code, 1);
  assertEquals((await cli(dir, ["docs", "meta", doc.id, "--type", "email"])).code, 1);

  // Claude's own items remain editable.
  assertEquals((await cli(dir, ["tag", "add", doc.id, "claude-tag"])).code, 0);
  assertEquals((await cli(dir, ["tag", "rm", doc.id, "claude-tag"])).code, 0);
  assertEquals((await cli(dir, ["issue", "add", "--title", "Claude issue"])).code, 0);
  assertEquals((await cli(dir, ["issue", "edit", String(issue + 1), "--title", "Edited"])).code, 0);
});
