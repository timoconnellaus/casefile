/**
 * Using casefile while it is being worked on (ADR 22): the upgrade backup `deno task release`
 * makes, a development run that opens only cases in its own folder, and which copy is running.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { backupCase } from "../src/app/upgrade_backup.ts";
import { CASE_LOCK_FILE, CaseInUseError } from "../src/core/caselock.ts";
import { SCHEMA_VERSION } from "../src/core/publicdb.ts";
import { CaseSession } from "../src/core/session.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE, tempDir } from "./fixtures/synthetic.ts";
import { PASS, setup } from "./helpers/app.ts";

const INFO = { release: "use-2026-10-09-2", previous: "use-2026-10-09-1" };

async function closedCase() {
  const root = await tempDir();
  const dir = join(root, "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  await s.importText({ origin: "mine", title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  await s.closeSettled();
  return { root, dir };
}

Deno.test("the upgrade backup copies the case without the lock or links, and opens as the case did", async () => {
  const { root, dir } = await closedCase();
  // Claude can make links in the case folder; one to a file elsewhere is not followed.
  const outside = join(root, "outside.txt");
  await Deno.writeTextFile(outside, "not part of the case");
  await Deno.symlink(outside, join(dir, "notes-link.txt"));
  await Deno.mkdir(join(root, "outside-dir"));
  await Deno.writeTextFile(join(root, "outside-dir", "secret.txt"), "not part of the case");
  await Deno.symlink(join(root, "outside-dir"), join(dir, "folder-link"));

  const r = await backupCase(dir, join(root, "backups"), {
    ...INFO,
    now: new Date("2026-10-09T01:02:03.456Z"),
  });
  assertEquals(r.dir, join(root, "backups", "case", "2026-10-09T010203Z-before-use-2026-10-09-2"));
  assertEquals(r.skippedLinks.sort(), ["folder-link", "notes-link.txt"]);
  assertEquals(r.schema, SCHEMA_VERSION);
  const manifest = JSON.parse(await Deno.readTextFile(join(r.dir, "backup.json")));
  assertEquals(manifest.madeBefore, INFO.release);
  assertEquals(manifest.previousRelease, INFO.previous);
  assertEquals(manifest.publicDbSchema, SCHEMA_VERSION);
  await assertRejects(() => Deno.lstat(join(r.dir, "notes-link.txt")), Deno.errors.NotFound);
  await assertRejects(() => Deno.lstat(join(r.dir, "folder-link")), Deno.errors.NotFound);
  await assertRejects(() => Deno.lstat(join(r.dir, CASE_LOCK_FILE)), Deno.errors.NotFound);
  assert((await Deno.lstat(join(r.dir, "vault"))).isDirectory);

  // Restoring is copying it back: the copy opens with the passphrase and has the document.
  await Deno.remove(join(r.dir, "backup.json"));
  const restored = await CaseSession.open(r.dir, PASS);
  try {
    assertEquals((await restored.listDocs()).length, 1);
  } finally {
    await restored.closeSettled();
  }
});

Deno.test("the upgrade backup is refused while another process has the case open", async () => {
  const { root, dir } = await closedCase();
  // A live process other than this one (the test runner's parent) holds the lock.
  await Deno.writeTextFile(
    join(dir, CASE_LOCK_FILE),
    JSON.stringify({
      format: "casefile-lock",
      pid: Deno.ppid,
      startedAt: new Date().toISOString(),
      host: Deno.hostname(),
      by: "app",
      token: "other",
    }),
  );
  await assertRejects(() => backupCase(dir, join(root, "backups"), INFO), CaseInUseError);
  await assertRejects(() => Deno.lstat(join(root, "backups")), Deno.errors.NotFound);
});

Deno.test("the upgrade backup's public.db is a consistent copy while the CLI has it open", async () => {
  const { root, dir } = await closedCase();
  // Claude's CLI writes public.db without taking the case lock; an uncheckpointed WAL is copied.
  const live = new DatabaseSync(join(dir, "public.db"));
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  live.exec("INSERT INTO case_info (key, value) VALUES ('release-test', 'written by the CLI')");
  try {
    const r = await backupCase(dir, join(root, "backups"), INFO);
    const copy = new DatabaseSync(join(r.dir, "public.db"), { readOnly: true });
    try {
      const row = copy.prepare("SELECT value FROM case_info WHERE key = 'release-test'").get() as
        | { value: string }
        | undefined;
      assertEquals(row?.value, "written by the CLI");
    } finally {
      copy.close();
    }
  } finally {
    live.close();
  }
});

Deno.test("a development run opens and creates cases only inside its own folder", async () => {
  const t = await setup();
  const devRoot = join(t.root, "dev");
  const t2 = await setup({ caseRoot: devRoot, home: t.root });
  const outside = await t2.user.post("/api/case/create", {
    dir: join(t.root, "real-case"),
    passphrase: PASS,
    label: "Test matter",
  });
  assertEquals(outside.status, 403, outside.text);
  assert(outside.json.error.includes("development copy"));
  // Not by a ../ path, and not the folder itself.
  for (const dir of [join(devRoot, "..", "real-case"), devRoot]) {
    const r = await t2.user.post("/api/case/open", { dir, passphrase: PASS });
    assertEquals(r.status, 403, r.text);
  }
  const inside = await t2.user.post("/api/case/create", {
    dir: join(devRoot, "canon"),
    passphrase: PASS,
    label: "Test matter",
  });
  assertEquals(inside.status, 200, inside.text);
  await t2.state.shutdown();
});

Deno.test("/api/status says which copy of casefile is running", async () => {
  const plain = await setup();
  assertEquals((await plain.user.get("/api/status")).json.build, { version: null, dev: false });
  const released = await setup({ build: { version: "0.2.0", dev: false } });
  assertEquals((await released.user.get("/api/status")).json.build.version, "0.2.0");
  const dev = await setup({ build: { version: null, dev: true } });
  assertFalse((await dev.user.get("/api/status")).json.build.version);
});
