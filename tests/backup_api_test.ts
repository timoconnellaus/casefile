/**
 * The encrypted single-file backup through the app (ADR 29): making one from Settings, the folder
 * remembered as the next default, and restoring one from the unlock screen into a new case.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { verifyBackup } from "../src/core/backupfile.ts";
import { DatabaseSync } from "node:sqlite";
import { Client, importAndPublish, PASS, setup, withCase } from "./helpers/app.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE } from "./fixtures/synthetic.ts";

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("Back up now: one file in the folder typed, remembered for next time, logged as counts", async () => {
  const t = await withCase();
  await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  assertEquals((await t.user.get("/api/backup")).json, { lastAt: null, folder: null });

  // The folder is typed as the user would, under their home folder.
  const usb = join(t.root, "usb");
  await Deno.mkdir(usb);
  const r = await t.user.post("/api/backup", { folder: "~/usb" });
  assertEquals(r.status, 200, r.text);
  assertMatch(r.json.file, /^casefile-backup-\d{4}-\d\d-\d\d-\d{6}\.casefile-backup$/);
  assertEquals(r.json.folder, await Deno.realPath(usb));
  assertEquals(await files(usb), [r.json.file]);
  assertEquals((await verifyBackup(join(usb, r.json.file), { passphrase: PASS })).files > 3, true);

  // The last backup is recorded in the case's vault; the folder in the app's config, as typed.
  const st = (await t.user.get("/api/backup")).json;
  assertEquals(st, { lastAt: r.json.lastAt, folder: "~/usb" });
  const config = JSON.parse(await Deno.readTextFile(join(t.root, "config", "config.json")));
  assertEquals(config.lastBackupDir, "~/usb");
  assert((await t.state.session!.vault.list()).includes("backups"));

  // The log has the counts only: no folder, no file name.
  const row = t.state.session!.store.listLog(50).find((l) => l.action === "case_backed_up")!;
  assertEquals(Object.keys(JSON.parse(row.detail)).sort(), ["bytes", "files"]);
  assert(!row.detail.includes("usb") && !row.detail.includes("casefile-backup"));

  // The temporary copy of public.db, made in the app's folder, is gone.
  assertEquals(await files(join(t.root, "config", "tmp")), []);
  t.state.lock();
});

Deno.test("Back up now refuses a folder that isn't there, or is inside the case folder", async () => {
  const t = await withCase();
  const bad = async (folder: unknown, text: string) => {
    const r = await t.user.post("/api/backup", { folder });
    assertEquals(r.status, 400, r.text);
    assert(r.json.error.includes(text), r.json.error);
  };
  await bad("", "Missing folder");
  await bad("   ", "Type the folder");
  await bad(join(t.root, "nowhere"), "can't find that folder");
  await bad(t.caseDir, "outside the case folder");
  await bad(join(t.caseDir, "vault"), "outside the case folder");
  // A link from elsewhere into the case folder is still the case folder.
  await Deno.symlink(t.caseDir, join(t.root, "link"));
  await bad(join(t.root, "link"), "outside the case folder");
  // A file is not a folder.
  await Deno.writeTextFile(join(t.root, "file"), "x");
  await bad(join(t.root, "file"), "can't find that folder");
  assertEquals((await t.user.get("/api/backup")).json.lastAt, null);
  t.state.lock();
});

Deno.test("Back up now needs the signed-in user", async () => {
  const t = await withCase();
  await Deno.mkdir(join(t.root, "usb"));
  assertEquals((await t.other.post("/api/backup", { folder: join(t.root, "usb") })).status, 401);
  await t.state.lock();
  assertEquals((await t.user.post("/api/backup", { folder: join(t.root, "usb") })).status, 423);
  assertEquals(await files(join(t.root, "usb")), []);
});

// ── restoring (the risky part) ──────────────────────────────────────────────

/** A case with a document shared and a recovery key, backed up, then locked. */
async function backedUpApp() {
  const t = await withCase();
  await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const rk = await t.user.post("/api/case/recovery-key", { passphrase: PASS });
  assertEquals(rk.status, 200, rk.text);
  await Deno.mkdir(join(t.root, "usb"));
  const b = await t.user.post("/api/backup", { folder: join(t.root, "usb") });
  assertEquals(b.status, 200, b.text);
  const docs = (await t.user.get("/api/docs")).json;
  await t.user.post("/api/lock");
  return {
    t,
    file: join(t.root, "usb", b.json.file),
    lastAt: b.json.lastAt as string,
    recoveryKey: rk.json.recoveryKey as string,
    docs,
  };
}

/** The original case's log, read straight from its public.db. */
function originalLog(caseDir: string) {
  const db = new DatabaseSync(join(caseDir, "public.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, action, chain FROM ai_log ORDER BY id").all();
  } finally {
    db.close();
  }
}

Deno.test("Restore with the passphrase: opens as a separate case; the original's log is unchanged", async () => {
  const { t, file, lastAt, docs } = await backedUpApp();
  const before = originalLog(t.caseDir);
  const target = join(t.root, "restored");
  const fresh = new Client(t.handler);
  const r = await fresh.post("/api/case/restore", { file, dir: target, passphrase: PASS });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.caseDir, target);
  assertEquals(r.json.backupMade, lastAt);
  assert(fresh.cookie, "restoring signs the caller in to the restored case");

  const status = (await fresh.get("/api/status")).json;
  assertEquals(status.caseDir, target);
  assertEquals(
    (await fresh.get("/api/docs")).json.map((d: { id: string; state: string }) => [d.id, d.state]),
    docs.map((d: { id: string; state: string }) => [d.id, d.state]),
  );
  // Its last backup is the backup it came from.
  assertEquals((await fresh.get("/api/backup")).json.lastAt, lastAt);
  const log = t.state.session!.store.listLog(20).map((l) => l.action);
  assert(log.includes("case_restored"));
  const row = t.state.session!.store.listLog(20).find((l) => l.action === "case_restored")!;
  assertEquals(JSON.parse(row.detail), {
    backup_made: lastAt,
    backup_schema: 4,
    recovery_key: false,
  });
  await fresh.post("/api/lock");

  // The original is untouched, and opens as before.
  assertEquals(originalLog(t.caseDir), before);
  const o = await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
  assertEquals(o.status, 200, o.text);
  assert(!t.state.session!.store.listLog(50).some((l) => l.action === "case_restored"));
  await t.user.post("/api/lock");
});

Deno.test("Restore with the recovery key needs a new passphrase, which opens the restored case", async () => {
  const { t, file, recoveryKey } = await backedUpApp();
  const target = join(t.root, "restored");
  const c = new Client(t.handler);
  const short = await c.post("/api/case/restore", {
    file,
    dir: target,
    recoveryKey,
    newPassphrase: "too short",
  });
  assertEquals(short.status, 400);
  const r = await c.post("/api/case/restore", {
    file,
    dir: target,
    recoveryKey,
    newPassphrase: "a brand new passphrase",
  });
  assertEquals(r.status, 200, r.text);
  await c.post("/api/lock");
  assertEquals(
    (await c.post("/api/case/open", { dir: target, passphrase: PASS })).status,
    401,
    "the old passphrase no longer opens the restored case",
  );
  assertEquals(
    (await c.post("/api/case/open", { dir: target, passphrase: "a brand new passphrase" })).status,
    200,
  );
  await c.post("/api/lock");
  // The original keeps its passphrase.
  assertEquals((await c.post("/api/case/open", { dir: t.caseDir, passphrase: PASS })).status, 200);
  await c.post("/api/lock");
});

Deno.test("Restore refuses wrong secrets with the unlock limit, and writes nothing", async () => {
  const { t, file, recoveryKey } = await backedUpApp();
  const target = join(t.root, "restored");
  const c = new Client(t.handler);
  const wrongKey = recoveryKey.replace(/^./, (x) => (x === "A" ? "B" : "A"));
  const statuses = [];
  for (
    const body of [
      { passphrase: "wrong guess one" },
      { recoveryKey: wrongKey, newPassphrase: "a brand new passphrase" },
      { passphrase: "wrong guess three" },
      { passphrase: "wrong guess four" },
    ]
  ) {
    statuses.push((await c.post("/api/case/restore", { file, dir: target, ...body })).status);
  }
  assertEquals(statuses.slice(0, 3), [401, 401, 401]);
  assertEquals(statuses[3], 429, "after three wrong tries, a wait");
  assertEquals(await Deno.lstat(target).catch(() => null), null, "nothing written");
  assert(!(await files(t.root)).some((n) => n.includes("restoring")));
  assertEquals(c.cookie, undefined);
});

Deno.test("Restore refuses a damaged file, a non-backup, a missing file and a non-empty folder", async () => {
  const { t, file } = await backedUpApp();
  const c = new Client(t.handler);
  const bytes = await Deno.readFile(file);
  const cut = join(t.root, "cut.casefile-backup");
  await Deno.writeFile(cut, bytes.slice(0, bytes.length - 100));
  const notOne = join(t.root, "notes.txt");
  await Deno.writeTextFile(notOne, "just some notes");
  const full = join(t.root, "full");
  await Deno.mkdir(full);
  await Deno.writeTextFile(join(full, "keep.txt"), "mine");

  const tryIt = (f: string, dir: string) =>
    c.post("/api/case/restore", { file: f, dir, passphrase: PASS });
  const damaged = await tryIt(cut, join(t.root, "r1"));
  assertEquals(damaged.status, 422, damaged.text);
  assert(damaged.json.error.includes("damaged or incomplete"));
  assertEquals((await tryIt(notOne, join(t.root, "r2"))).status, 400);
  assertEquals((await tryIt(join(t.root, "missing"), join(t.root, "r3"))).status, 400);
  const nonEmpty = await tryIt(file, full);
  assertEquals(nonEmpty.status, 409);
  assertEquals(await files(full), ["keep.txt"]);
  // Over the original case, or inside it.
  assertEquals((await tryIt(file, t.caseDir)).status, 409);
  assertEquals((await tryIt(file, join(t.caseDir, "inside"))).status, 409);
  for (const d of ["r1", "r2", "r3"]) {
    assertEquals(await Deno.lstat(join(t.root, d)).catch(() => null), null);
  }
  assert(!(await files(t.root)).some((n) => n.includes("restoring")));
  assertEquals(c.cookie, undefined);
});

Deno.test("Restore can't replace a case someone else has open", async () => {
  const { t, file } = await backedUpApp();
  const o = await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
  assertEquals(o.status, 200);
  const r = await t.other.post("/api/case/restore", {
    file,
    dir: join(t.root, "restored"),
    passphrase: PASS,
  });
  assertEquals(r.status, 409);
  assertEquals(await Deno.lstat(join(t.root, "restored")).catch(() => null), null);
  assertEquals(t.state.session!.paths.root, t.caseDir);
  // The signed-in user may restore: the restored case replaces theirs.
  const mine = await t.user.post("/api/case/restore", {
    file,
    dir: join(t.root, "restored"),
    passphrase: PASS,
  });
  assertEquals(mine.status, 200, mine.text);
  assertEquals(t.state.session!.paths.root, join(t.root, "restored"));
  await t.user.post("/api/lock");
});

Deno.test("A development copy restores only inside its own folder", async () => {
  const { t, file } = await backedUpApp();
  const dev = await setup({ caseRoot: join(t.root, "dev") });
  const r = await dev.user.post("/api/case/restore", {
    file,
    dir: join(t.root, "outside"),
    passphrase: PASS,
  });
  assertEquals(r.status, 403);
  const ok = await dev.user.post("/api/case/restore", {
    file,
    dir: join(t.root, "dev", "restored"),
    passphrase: PASS,
  });
  assertEquals(ok.status, 200, ok.text);
  await dev.user.post("/api/lock");
});
